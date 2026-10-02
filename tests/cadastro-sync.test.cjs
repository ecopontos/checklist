const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { harness } = require('./helpers/gas-mock.cjs');

const HEADER = 'Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP;Complemento;Telefone1;Telefone2;TipoResiduo';
const csv = (...rows) => [HEADER, ...rows].join('\r\n');
const linha = (id, roteiro, cliente, ordem = 1) => `${roteiro}-${ordem};${id};0;${ordem};${roteiro};${cliente};Rua A;10;88000000;;;;Vidro`;

// Um "aparelho": banco, localStorage e fetch próprios, falando com o mesmo GAS simulado.
async function device(gas, { token = gas.token, gasVersion } = {}) {
  const storage = new Map([['app3_gas_url', 'https://gas.test/exec'], ...(token ? [['app3_gas_route_token', token]] : [])]);
  const context = vm.createContext({ console, crypto: require('node:crypto').webcrypto, Papa: require('../vendor/papaparse.min.js'),
    AbortController, setTimeout, clearTimeout, localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    initSqlJs: () => require('../vendor/sql-wasm.js')({ locateFile: f => path.resolve('vendor', f) }),
    fetch: async (_url, options) => {
      if (gasVersion === 'antigo') return { ok: true, json: async () => ({ ok: true, count: 0 }) };
      return { ok: true, json: async () => JSON.parse(gas.context.doPost({ postData: { contents: options.body } }).value) };
    } });
  const load = async name => {
    const mod = new vm.SourceTextModule(fs.readFileSync(name, 'utf8'), { context, identifier: name });
    await mod.link(() => {}); await mod.evaluate(); return mod.namespace;
  };
  const db = (await load('database.js')).default; await db.init();
  const sync = await load('google-sync.js');
  return { db, storage, sync: () => sync.syncCadastro(db) };
}

const ponto = (d, id) => d.db.getClienteByIdRota(id);
const nomes = d => d.db.getRoteiros().map(r => r.nome).sort();

test('roteiro e ponto criados num aparelho aparecem no outro', async () => {
  const gas = harness();
  const a = await device(gas), b = await device(gas);
  a.db.importRoteirosCsv(csv(linha(1, 'SAT01', 'Do Access')));
  const novo = a.db.criarRoteiro('ESCOLAS', 'Organicos');
  const id = a.db.criarPonto({ cliente: 'Padaria', roteiroId: novo.id, logradouro: 'Rua Nova', cep: '01001000' });
  assert.equal(a.db.getCadastroPendenteCount() > 0, true);

  const ra = await a.sync();
  assert.equal(ra.ok, true, ra.error);
  assert.equal(a.db.getCadastroPendenteCount(), 0);

  const rb = await b.sync();
  assert.equal(rb.ok, true, rb.error);
  assert.deepEqual(nomes(b), ['ESCOLAS']);
  assert.equal(ponto(b, id).cliente, 'Padaria');
  assert.equal(ponto(b, id).cep, '01001000');
  assert.equal(ponto(b, id).roteiro_nome, 'ESCOLAS');
  assert.equal(b.db.getRoteiros()[0].tipo_residuo, 'Organicos');
  assert.equal(b.db.getCadastroPendenteCount(), 0, 'o que veio do GAS nao volta como pendente');
  assert.equal((await b.sync()).recebidos, 0);
});

test('edicao de um aparelho chega ao outro e a importacao do Access nao a desfaz', async () => {
  const gas = harness();
  const a = await device(gas), b = await device(gas);
  const base = csv(linha(1, 'SAT01', 'Original 1', 1), linha(2, 'SAT01', 'Original 2', 2));
  a.db.importRoteirosCsv(base); b.db.importRoteirosCsv(base);

  ponto(a, '1');
  a.db.upsertCliente({ idRota: '1', Cliente: 'Editado em A', logradouro: 'Rua A', Número: '10', CEP: '88000000', Telefone1: '', Telefone2: '',
    roteiro_id: ponto(a, '1').roteiro_id, Ordem: 1, ativo: true }, { origemApp: true });
  await a.sync(); await b.sync();
  assert.equal(ponto(b, '1').cliente, 'Editado em A');
  assert.equal(ponto(b, '2').cliente, 'Original 2');

  b.db.importRoteirosCsv(base);
  assert.equal(ponto(b, '1').cliente, 'Editado em A', 'CSV antigo nao sobrescreve o que veio de outro aparelho');
});

test('conflito: a edicao mais recente vence nos dois aparelhos', async () => {
  const gas = harness();
  const a = await device(gas), b = await device(gas);
  const base = csv(linha(1, 'SAT01', 'Original'));
  a.db.importRoteirosCsv(base); b.db.importRoteirosCsv(base);
  const edita = (d, nome, quando) => {
    d.db.upsertCliente({ idRota: '1', Cliente: nome, logradouro: 'Rua A', Número: '10', CEP: '1', Telefone1: '', Telefone2: '',
      roteiro_id: ponto(d, '1').roteiro_id, Ordem: 1, ativo: true }, { origemApp: true });
    d.db.db.run('UPDATE clientes SET editado_em = ? WHERE id_rota = ?', [quando, '1']);
  };
  edita(a, 'Mais nova (A)', new Date(Date.now() - 1000).toISOString());
  edita(b, 'Mais velha (B)', new Date(Date.now() - 60000).toISOString());
  await a.sync();
  const rb = await b.sync();
  assert.equal(rb.ok, true, rb.error);
  assert.equal(ponto(b, '1').cliente, 'Mais nova (A)');
  assert.equal(b.db.getCadastroPendenteCount(), 0);
  await a.sync();
  assert.equal(ponto(a, '1').cliente, 'Mais nova (A)');
});

test('renomear roteiro propaga; o Access continua vendo o nome original', async () => {
  const gas = harness();
  const a = await device(gas), b = await device(gas);
  const base = csv(linha(1, 'SAT01', 'A', 1));
  a.db.importRoteirosCsv(base); b.db.importRoteirosCsv(base);

  const sat = a.db.getRoteiros()[0];
  a.db.atualizarRoteiro(sat.id, { nome: 'SAT-01', tipoResiduo: 'Organicos' });
  await a.sync(); await b.sync();
  assert.deepEqual(nomes(b), ['SAT-01']);
  b.db.importRoteirosCsv(base);
  assert.deepEqual(nomes(b), ['SAT-01'], 'reimportar nao recria SAT01');

  const queued = a.db.queueRoteiroChange('1');
  assert.equal(queued.change.roteiro, 'SAT01', 'fila do Access usa o nome original');
  const ordem = a.db.applyRoteiroOrder(ponto(a, '1').roteiro_id, ['1']);
  assert.equal(ordem.count, 0);
});

test('reordenar no organizador propaga a nova ordem', async () => {
  const gas = harness();
  const a = await device(gas), b = await device(gas);
  const base = csv(linha(1, 'SAT01', 'A', 1), linha(2, 'SAT01', 'B', 2));
  a.db.importRoteirosCsv(base); b.db.importRoteirosCsv(base);
  a.db.applyRoteiroOrder(ponto(a, '1').roteiro_id, ['2', '1']);
  await a.sync(); await b.sync();
  assert.equal(Number(ponto(b, '2').ordem), 1);
  assert.equal(Number(ponto(b, '1').ordem), 2);
});

test('exclusao propaga; aparelho com coletas do ponto apenas o inativa', async () => {
  const gas = harness();
  const a = await device(gas), b = await device(gas), c = await device(gas);
  const sat = a.db.criarRoteiro('NOVO');
  const id = a.db.criarPonto({ cliente: 'Temporario', roteiroId: sat.id });
  await a.sync(); await b.sync(); await c.sync();
  c.db.saveColetaOperation({ operationId: 'op', data: '2026-10-01', roteiro: 'NOVO',
    entries: [{ id_rota: id, quantidade: 1, intercorrencia: '', cliente: 'Temporario', sync_id: 's1' }] });

  a.db.excluirPonto(id);
  await a.sync();
  assert.equal((await b.sync()).ok, true);
  assert.equal(ponto(b, id), null);
  assert.equal((await c.sync()).ok, true);
  assert.equal(ponto(c, id).ativo, 0, 'tem coletas: fica inativo');
  b.db.importRoteirosCsv(csv(linha(id, 'NOVO', 'Voltou')));
  assert.equal(ponto(b, id), null, 'lapide impede que o CSV recrie o ponto');
});

test('GAS antigo (sem cadastroSync) e detectado e nada e dado como enviado', async () => {
  const gas = harness();
  const a = await device(gas, { gasVersion: 'antigo' });
  a.db.criarRoteiro('NOVO');
  const r = await a.sync();
  assert.equal(r.ok, false);
  assert.match(r.error, /API v14/);
  assert.equal(a.db.getCadastroPendenteCount(), 1, 'continua pendente');
});

test('sem token a sincronizacao e pulada sem erro e sem perder pendencias', async () => {
  const gas = harness();
  const a = await device(gas, { token: '' });
  a.db.criarRoteiro('NOVO');
  const r = await a.sync();
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(a.db.getCadastroPendenteCount(), 1);
});

test('token errado e falha do GAS nao marcam nada como enviado', async () => {
  const gas = harness();
  const a = await device(gas, { token: 'token-errado-com-mais-de-trinta-caracteres' });
  a.db.criarRoteiro('NOVO');
  const r = await a.sync();
  assert.equal(r.ok, false);
  assert.equal(a.db.getCadastroPendenteCount(), 1);
});

test('mais de um lote: 450 pontos sao enviados e recebidos por inteiro', async () => {
  const gas = harness();
  const a = await device(gas), b = await device(gas);
  const rot = a.db.criarRoteiro('GRANDE');
  for (let i = 0; i < 450; i++) a.db.criarPonto({ cliente: `Cliente ${i}`, roteiroId: rot.id });
  const ra = await a.sync();
  assert.equal(ra.ok, true, ra.error);
  assert.equal(ra.enviados, 451);
  const rb = await b.sync();
  assert.equal(rb.ok, true, rb.error);
  assert.equal(b.db.getClientesByRoteiro(b.db.getRoteiros()[0].id).length, 450);
});
