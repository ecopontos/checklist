const { test } = require('node:test');
const assert = require('node:assert/strict');

const { harness, Sheet } = require('./helpers/gas-mock.cjs');

const T = (min) => new Date(Date.UTC(2026, 9, 1, 12, min)).toISOString();
const ponto = (id, over = {}) => ({ id_rota: id, cliente: `Cliente ${id}`, logradouro: 'Rua A', numero: '10', complemento: '',
  cep: '01001000', telefone1: '48999990000', telefone2: '', roteiro: 'SAT01', ordem: 1, ativo: 1, excluido: 0,
  editado_em: T(0), origem: 'dev-a', ...over });
const roteiro = (chave, over = {}) => ({ chave, nome: chave, tipo_residuo: 'Vidro', apelidos: [], editado_em: T(0), origem: 'dev-a', ...over });

test('exige o token das alteracoes', () => {
  const h = harness();
  assert.equal(JSON.parse(h.context.cadastroSync_({ token: 'errado', pontos: [] }).value).ok, false);
  const semToken = harness({ token: '' });
  assert.match(JSON.parse(semToken.context.cadastroSync_({ token: 'x' }).value).error, /não configurado/);
  assert.equal(h.sheets.has('CadastroPontos'), false, 'nada e criado sem autenticacao');
});

test('um aparelho envia e outro recebe; since evita reenviar o que ja viu', () => {
  const h = harness();
  const a = h.sync({ since: 0, origem: 'dev-a', pontos: [ponto('APP-1'), ponto('7')], roteiros: [roteiro('SAT01')] });
  assert.equal(a.ok, true);
  assert.equal(a.rev, 1);
  assert.deepEqual([...a.accepted.pontos].sort(), ['7', 'APP-1']);
  assert.equal(a.pontos.length, 0, 'o que o proprio aparelho acabou de enviar nao volta');

  const b = h.sync({ since: 0, origem: 'dev-b' });
  assert.equal(b.pontos.length, 2);
  assert.equal(b.roteiros.length, 1);
  assert.equal(b.pontos.find(p => p.id_rota === 'APP-1').cep, '01001000');
  assert.equal(b.rev, 1);

  const c = h.sync({ since: b.rev, origem: 'dev-b' });
  assert.equal(c.pontos.length + c.roteiros.length, 0);
});

test('vence a edicao mais recente; a perdedora recebe a versao do servidor', () => {
  const h = harness();
  h.sync({ pontos: [ponto('APP-1', { cliente: 'Original', editado_em: T(10) })] });

  const velha = h.sync({ origem: 'dev-b', since: 1, pontos: [ponto('APP-1', { cliente: 'Antiga', editado_em: T(5), origem: 'dev-b' })] });
  assert.deepEqual([...velha.accepted.pontos], []);
  assert.equal(velha.conflitos.pontos.length, 1);
  assert.equal(velha.conflitos.pontos[0].cliente, 'Original');

  const nova = h.sync({ origem: 'dev-b', since: 1, pontos: [ponto('APP-1', { cliente: 'Nova', editado_em: T(20), origem: 'dev-b' })] });
  assert.deepEqual([...nova.accepted.pontos], ['APP-1']);
  assert.equal(nova.rev, 2);
  assert.equal(h.sync({ since: 0 }).pontos[0].cliente, 'Nova');
});

test('empate exato de horario e resolvido igual para todos (maior origem vence) e reenvio identico nao gera revisao', () => {
  const h = harness();
  h.sync({ pontos: [ponto('APP-1', { cliente: 'De A', editado_em: T(3), origem: 'dev-a' })] });
  const b = h.sync({ pontos: [ponto('APP-1', { cliente: 'De B', editado_em: T(3), origem: 'dev-b' })] });
  assert.deepEqual([...b.accepted.pontos], ['APP-1']);
  const a = h.sync({ pontos: [ponto('APP-1', { cliente: 'De A', editado_em: T(3), origem: 'dev-a' })] });
  assert.equal(a.conflitos.pontos[0].cliente, 'De B');
  const repetido = h.sync({ pontos: [ponto('APP-1', { cliente: 'De B', editado_em: T(3), origem: 'dev-b' })] });
  assert.equal(repetido.rev, b.rev, 'reenvio identico (resposta perdida) e idempotente');
  assert.deepEqual([...repetido.accepted.pontos], ['APP-1']);
});

test('registro invalido e descartado sozinho, sem derrubar o lote', () => {
  const h = harness();
  const r = h.sync({ pontos: [ponto('APP-1'), ponto('x y z'), ponto('APP-3', { cliente: '' }), ponto('APP-4', { ordem: 'abc' }),
    ponto('APP-5', { cliente: 'x'.repeat(300) }), ponto('APP-6', { editado_em: 'ontem' })] });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.accepted.pontos], ['APP-1']);
  assert.equal(r.invalid.pontos.length, 5);
});

test('relogio adiantado nao vence conflitos para sempre', () => {
  const h = harness();
  const futuro = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  h.sync({ pontos: [ponto('APP-1', { cliente: 'Relogio errado', editado_em: futuro })] });
  const gravado = h.sheets.get('CadastroPontos').rows[1][12];
  assert.ok(Date.parse(gravado) <= Date.now() + 1000, `editado_em limitado ao agora: ${gravado}`);
  const depois = h.sync({ pontos: [ponto('APP-1', { cliente: 'Hoje', editado_em: new Date(Date.now() + 60000).toISOString(), origem: 'dev-b' })] });
  assert.deepEqual([...depois.accepted.pontos], ['APP-1']);
});

test('grava como texto antes dos valores: zero a esquerda e formulas ficam intactos', () => {
  const h = harness();
  h.sync({ pontos: [ponto('APP-1', { cep: '01001000', telefone1: '+554899990000', complemento: '=1+1', cliente: '@alguem' })] });
  const sheet = h.sheets.get('CadastroPontos');
  assert.ok(sheet.formatCalls.length >= 1);
  assert.equal(sheet.formatCalls[0].format, '@');
  assert.equal(sheet.formatCalls[0].writesBefore <= sheet.writes.length - 1, true, 'formato aplicado antes do setValues de dados');
  const row = sheet.rows[1];
  assert.equal(row[5], '01001000');
  assert.equal(row[6], '+554899990000');
  assert.equal(row[4], '=1+1');
  assert.equal(h.sync({ since: 0 }).pontos[0].complemento, '=1+1');
  assert.equal(row[9], '1', 'numeros viram texto e voltam como numero na leitura');
  assert.equal(h.sync({ since: 0 }).pontos[0].ordem, 1);
});

test('exclusao vira lapide e e entregue aos outros aparelhos', () => {
  const h = harness();
  h.sync({ pontos: [ponto('APP-1')] });
  h.sync({ pontos: [{ id_rota: 'APP-1', excluido: 1, cliente: '', roteiro: '', editado_em: T(30), origem: 'dev-a' }] });
  const b = h.sync({ since: 1 });
  assert.equal(b.pontos.length, 1);
  assert.equal(b.pontos[0].excluido, 1);
});

test('roteiros: renomear mantem a chave e propaga nome, tipo e apelidos', () => {
  const h = harness();
  h.sync({ roteiros: [roteiro('SAT01')] });
  h.sync({ roteiros: [roteiro('SAT01', { nome: 'SAT-01', tipo_residuo: 'Organicos', apelidos: ['SAT01'], editado_em: T(15) })] });
  const b = h.sync({ since: 0 });
  assert.equal(b.roteiros.length, 1);
  assert.deepEqual({ ...b.roteiros[0], apelidos: [...b.roteiros[0].apelidos] },
    { chave: 'SAT01', nome: 'SAT-01', tipo_residuo: 'Organicos', apelidos: ['SAT01'], editado_em: T(15), origem: 'dev-a' });
});

test('lotes acima do limite sao recusados', () => {
  const h = harness();
  assert.equal(h.sync({ pontos: Array.from({ length: 201 }, (_, i) => ponto(`APP-${i}`)) }).ok, false);
  assert.equal(h.sync({ pontos: 'x' }).ok, false);
  assert.equal(h.sync({ since: -1 }).ok, false);
});

test('paginacao nao parte um grupo de mesma revisao', () => {
  const h = harness();
  const recs = [];
  for (let rev = 1; rev <= 5; rev++) for (let i = 0; i < 3; i++) recs.push({ rev, id: `${rev}-${i}` });
  const p1 = h.context.paginateCadastroByRev_(recs.slice(), 7);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.records.length, 6);
  assert.equal(p1.cursor, 2);
  const p2 = h.context.paginateCadastroByRev_(recs.filter(r => r.rev > p1.cursor), 7);
  assert.equal(p2.records.length, 6, 'revisoes 3 e 4 inteiras; a 5 fica para a proxima');
  assert.equal(p2.cursor, 4);
  const p3 = h.context.paginateCadastroByRev_(recs.filter(r => r.rev > p2.cursor), 7);
  assert.equal(p3.hasMore, false);
  assert.equal(p3.records.length, 3);
  assert.equal(h.context.paginateCadastroByRev_(recs.slice(), 100).hasMore, false);
});

test('consultas de coleta por roteiro entendem o nome antigo e o novo', () => {
  const h = harness();
  const coletas = new Sheet();
  coletas.rows = [['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID'],
    ['1', '2026-09-20', 'A', 'SAT01', 1, '', '', 's1'],
    ['1', '2026-09-27', 'A', 'SAT-01', 1, '', '', 's2'],
    ['2', '2026-09-28', 'B', 'OUTRO', 1, '', '', 's3']];
  h.sheets.set('Coletas', coletas);
  const consulta = nome => JSON.parse(h.context.getUltimaColeta_(nome).value).data;
  assert.equal(consulta('SAT-01'), '2026-09-27', 'sem cadastro: so o nome pedido');
  assert.equal(consulta('SAT01'), '2026-09-20');

  h.sync({ roteiros: [roteiro('SAT01', { nome: 'SAT-01', apelidos: ['SAT01'] })] });
  assert.equal(consulta('SAT-01'), '2026-09-27');
  assert.equal(consulta('SAT01'), '2026-09-27', 'nome antigo enxerga as coletas do nome novo');
  assert.equal(consulta('OUTRO'), '2026-09-28');
  assert.deepEqual([...h.context.getRoteiroNomesEquivalentes_({ getSheetByName: n => h.sheets.get(n) }, 'SAT01')].sort(), ['SAT-01', 'SAT01']);
});

test('status informa a versao 15 e a capacidade de cadastro', () => {
  const h = harness();
  const status = JSON.parse(h.context.doGet({ parameter: { action: 'status' } }).value);
  assert.equal(status.apiVersion, 15);
  assert.equal(status.cadastro, true);
});
