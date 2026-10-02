const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function setup() {
  const storage = new Map();
  const context = vm.createContext({ console, crypto: require('node:crypto').webcrypto,
    Papa: require('../vendor/papaparse.min.js'),
    localStorage: { getItem: k => storage.get(k) ?? null, removeItem: k => storage.delete(k), setItem: (k, v) => storage.set(k, v) },
    initSqlJs: () => require('../vendor/sql-wasm.js')({ locateFile: f => path.resolve('vendor', f) }) });
  const mod = new vm.SourceTextModule(fs.readFileSync('database.js', 'utf8'), { context });
  await mod.link(() => {}); await mod.evaluate();
  const db = mod.namespace.default; await db.init();
  return db;
}

const HEADER = 'Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP;Complemento;Telefone1;Telefone2;TipoResiduo';
const csv = (...linhas) => [HEADER, ...linhas].join('\r\n');
const linha = (id, roteiro, cliente, ordem = 1, tipo = 'Vidro') => `${roteiro}-${ordem};${id};0;${ordem};${roteiro};${cliente};Rua A;10;88000000;;;;${tipo}`;
const ponto = (db, id) => db.getClienteByIdRota(id);

test('importacao nao sobrescreve ponto editado no app, mas atualiza os demais e traz os novos', async () => {
  const db = await setup();
  db.importRoteirosCsv(csv(linha(1, 'SAT01', 'Original 1', 1), linha(2, 'SAT01', 'Original 2', 2)));
  db.upsertCliente({ idRota: '1', Cliente: 'Editado no app', logradouro: 'Rua B', Número: '5', CEP: '1',
    Telefone1: '', Telefone2: '', roteiro_id: ponto(db, '1').roteiro_id, Ordem: 1, ativo: true }, { origemApp: true });

  const r = db.importRoteirosCsv(csv(linha(1, 'SAT01', 'Do Access 1', 1), linha(2, 'SAT01', 'Do Access 2', 2), linha(3, 'SAT01', 'Novo', 3)));
  assert.equal(ponto(db, '1').cliente, 'Editado no app');
  assert.equal(ponto(db, '2').cliente, 'Do Access 2');
  assert.equal(ponto(db, '3').cliente, 'Novo');
  assert.equal(r.preservados, 1);

  db.importRoteirosCsv(csv(linha(1, 'SAT01', 'Do Access 1')), { sobrescreverEditados: true });
  assert.equal(ponto(db, '1').cliente, 'Do Access 1');
  assert.equal(ponto(db, '1').editado_em, null);
});

test('reordenar ou inativar protege o ponto de ser desfeito por um CSV antigo', async () => {
  const db = await setup();
  db.importRoteirosCsv(csv(linha(1, 'SAT01', 'A', 1), linha(2, 'SAT01', 'B', 2)));
  const rid = ponto(db, '1').roteiro_id;
  db.applyRoteiroOrder(rid, ['2', '1']);
  db.importRoteirosCsv(csv(linha(1, 'SAT01', 'A', 1), linha(2, 'SAT01', 'B', 2)));
  assert.equal(Number(ponto(db, '2').ordem), 1);
  assert.equal(Number(ponto(db, '1').ordem), 2);
});

test('novo ponto ganha id APP-n, vai para o fim do roteiro e pode ser reordenado', async () => {
  const db = await setup();
  db.importRoteirosCsv(csv(linha(1, 'SAT01', 'A', 1), linha(2, 'SAT01', 'B', 2)));
  const rid = ponto(db, '1').roteiro_id;
  const novo = db.criarPonto({ cliente: '  Padaria   Nova ', roteiroId: rid, telefone1: '48999990000' });
  assert.equal(novo, 'APP-1');
  assert.equal(db.criarPonto({ cliente: 'Outro', roteiroId: rid }), 'APP-2');
  assert.equal(ponto(db, 'APP-1').cliente, 'Padaria Nova');
  assert.equal(Number(ponto(db, 'APP-1').ordem), 3);
  assert.ok(ponto(db, 'APP-1').editado_em);
  assert.throws(() => db.criarPonto({ idRota: '1', cliente: 'X', roteiroId: rid }), /Já existe/);
  assert.throws(() => db.criarPonto({ cliente: '', roteiroId: rid }), /nome do cliente/);
  const r = db.applyRoteiroOrder(rid, ['APP-1', '1', '2', 'APP-2']);
  assert.equal(r.count > 0, true);
  assert.equal(db.getPendingRoteiroChangesCount(), 2, 'so os pontos do Access entram na fila de sincronizacao');
});

test('ponto excluido nao volta na importacao; com coletas so pode ser inativado', async () => {
  const db = await setup();
  db.importRoteirosCsv(csv(linha(1, 'SAT01', 'A', 1), linha(2, 'SAT01', 'B', 2)));
  db.saveColetaOperation({ operationId: 'op', data: '2026-10-01', roteiro: 'SAT01',
    entries: [{ id_rota: '2', quantidade: 1, intercorrencia: '', cliente: 'B', sync_id: 's1' }] });
  assert.throws(() => db.excluirPonto('2'), /coletas/);
  db.excluirPonto('1');
  assert.equal(ponto(db, '1'), null);
  const r = db.importRoteirosCsv(csv(linha(1, 'SAT01', 'A', 1), linha(2, 'SAT01', 'B', 2)));
  assert.equal(ponto(db, '1'), null);
  assert.equal(r.preservados >= 1, true);
  db.criarPonto({ idRota: '1', cliente: 'Recriado', roteiroId: ponto(db, '2').roteiro_id });
  assert.equal(ponto(db, '1').cliente, 'Recriado');
});

test('roteiro: criar, renomear com alias e tipo de residuo preservado na importacao', async () => {
  const db = await setup();
  db.importRoteirosCsv(csv(linha(1, 'SAT01', 'A', 1, 'Vidro')));
  const sat = db.getRoteiros().find(r => r.nome === 'SAT01');
  const criado = db.criarRoteiro('NOVO', 'Organicos');
  assert.equal(criado.tipo_residuo, 'Organicos');
  assert.throws(() => db.criarRoteiro('novo'), /Já existe/);
  assert.throws(() => db.criarRoteiro('  '), /nome do roteiro/);

  db.atualizarRoteiro(sat.id, { nome: 'SAT-01', tipoResiduo: 'Organicos' });
  assert.throws(() => db.atualizarRoteiro(sat.id, { nome: 'NOVO' }), /Já existe/);
  const r = db.importRoteirosCsv(csv(linha(1, 'SAT01', 'A', 1, 'Vidro'), linha(9, 'SAT01', 'Chegou do Access', 2, 'Vidro')));
  const nomes = db.getRoteiros().map(x => x.nome).sort();
  assert.deepEqual([...nomes], ['NOVO', 'SAT-01'], 'o nome antigo nao e recriado');
  assert.equal(db.getRoteiros().find(x => x.id === sat.id).tipo_residuo, 'Organicos');
  assert.equal(ponto(db, '9').roteiro_nome, 'SAT-01', 'ponto novo do Access cai no roteiro renomeado');
  assert.equal(r.preservados, 1);
});

test('exporta o CSV legado e reimporta sem perder dados', async () => {
  const db = await setup();
  db.importRoteirosCsv(csv(linha(1, 'SAT01', '"Cliente; com ""aspas"""', 1)));
  db.criarPonto({ cliente: 'Do app', roteiroId: ponto(db, '1').roteiro_id, logradouro: 'Rua Nova', numero: '7' });
  const exportado = db.exportRoteirosCsv();
  assert.match(exportado, /^Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP;Complemento;Telefone1;Telefone2;TipoResiduo\r\n/);
  assert.match(exportado, /"Cliente; com ""aspas"""/);
  assert.match(exportado, /;1,00;SAT01;/);

  const outro = await setup();
  const r = outro.importRoteirosCsv(exportado);
  assert.equal(r.clientes, 2);
  assert.equal(ponto(outro, 'APP-1').cliente, 'Do app');
  assert.equal(ponto(outro, 'APP-1').logradouro, 'Rua Nova');
  assert.equal(ponto(outro, '1').cliente, 'Cliente; com "aspas"');
});
