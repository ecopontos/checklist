const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const moduleReady = (async () => {
  const file = 'dashboard-metrics.js';
  const mod = new vm.SourceTextModule(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  await mod.link(() => {}); await mod.evaluate();
  return mod.namespace;
})();
const clean = { invalidDates: 0, invalidQuantities: 0, excludedRecords: 0 };
const now = new Date('2026-09-17T15:00:00Z');
const row = (data, quantidade = 1, extra = {}) => ({ data, quantidade, roteiro: 'ROTA A', intercorrencia: '', ...extra });
async function metrics(remote, options = {}) {
  const api = await moduleReady;
  assert.equal(typeof api.buildDashboardMetrics, 'function', 'calculo compartilhado deve existir');
  return api.buildDashboardMetrics({ remote, local: [], remoteQuality: clean, now, ...options });
}

test('separa atendimento, retirada, recipientes e intercorrencia e corta a comparacao ontem', async () => {
  const m = await metrics([row('2026-09-17', 5, { intercorrencia: '1' }), row('2026-09-16', 0, { intercorrencia: '2' }), row('2026-08-16', 2)]);
  assert.equal(m.totals.attendances, 2);
  assert.equal(m.totals.collections, 1);
  assert.equal(m.totals.containers, 5);
  assert.equal(m.totals.issues, 2);
  assert.equal(m.totals.issueRate, 100);
  assert.equal(m.period.end, '2026-09-17');
  assert.equal(m.period.comparison.current.end, '2026-09-16');
  assert.equal(m.period.comparison.previous.end, '2026-08-16');
  assert.equal(m.comparison.collectionChange, -100);
});

test('mes curto, ano bissexto, primeiro dia e virada de ano tem cortes explicitos', async () => {
  for (const [date, expected] of [['2026-03-31T15:00Z', '2026-02-28'], ['2024-03-31T15:00Z', '2024-02-29'], ['2026-01-17T15:00Z', '2025-12-16']]) {
    const m = await metrics([], { now: new Date(date) });
    assert.equal(m.period.comparison.previous.end, expected);
    assert.equal(m.period.comparison.current.end.slice(-2), expected.slice(-2));
  }
  const first = await metrics([], { now: new Date('2026-10-01T15:00Z') });
  assert.equal(first.period.comparison, null);
  assert.match(first.comparison.reason, /Sem dias encerrados/);
});

test('fuso operacional independe do fuso da maquina e preserva datas civis', async () => {
  const api = await moduleReady;
  assert.equal(typeof api.operationalToday, 'function');
  assert.equal(api.operationalToday(new Date('2026-09-18T01:30:00Z')), '2026-09-17');
  const m = await metrics([row('2026-09-17')], { now: new Date('2026-09-18T01:30:00Z') });
  assert.equal(m.period.end, '2026-09-17');
  assert.equal(m.totals.collections, 1);
});

test('selecionar mes encerrado compara meses completos e filtra ranking e tipos', async () => {
  const m = await metrics([row('2026-08-31', 2, { roteiro: 'AGOSTO', intercorrencia: 'Falha A' }), row('2026-09-16', 50, { roteiro: 'SETEMBRO', intercorrencia: 'Falha B' })], { month: '2026-08' });
  assert.equal(m.period.end, '2026-08-31');
  assert.equal(m.period.partial, false);
  assert.equal(m.period.comparison.previous.end, '2026-07-31');
  assert.equal(m.routes.length, 1);
  assert.equal(m.routes[0].name, 'AGOSTO');
  assert.equal(m.issueTypes[0].name, 'Falha A');
});

test('deduplica por ID remoto sem fundir atendimentos diferentes e inclui apenas pendentes locais', async () => {
  const m = await metrics([row('2026-09-10', 5, { syncId: 'x' }), row('2026-09-10', 5, { syncId: 'x' }), row('2026-09-10')], {
    local: [row('2026-09-10', 99, { syncId: 'x' }), row('2026-09-10'), row('2026-09-10', 20, { syncId: 'ja-enviado', lastSync: '2026-09-10' })]
  });
  assert.equal(m.totals.attendances, 3);
  assert.equal(m.totals.containers, 7);
  assert.equal(m.quality.duplicates, 2);
});

test('base zero, sem registros e fonte local suspendem a variacao', async () => {
  const zero = await metrics([row('2026-09-10'), row('2026-08-10', 0, { intercorrencia: '1' })]);
  assert.equal(zero.comparison.collectionChange, null);
  assert.match(zero.comparison.reason, /Sem base/);
  const absent = await metrics([row('2026-08-10')]);
  assert.equal(absent.comparison.collectionChange, null);
  assert.match(absent.comparison.reason, /Sem registros/);
  const local = await metrics(null, { local: [row('2026-09-10'), row('2026-08-10')] });
  assert.equal(local.totals.collections, 1);
  assert.equal(local.comparison.collectionChange, null);
  assert.match(local.comparison.reason, /local parcial/);
});

test('diferenca de taxas e expressa em pontos percentuais', async () => {
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push(row('2026-09-10', 1, { intercorrencia: i < 8 ? '1' : '' }));
    rows.push(row('2026-08-10', 1, { intercorrencia: i < 10 ? '1' : '' }));
  }
  const m = await metrics(rows);
  assert.equal(m.totals.issueRate, 8);
  assert.equal(m.comparison.issueRateChange, -2);
  assert.equal(m.comparison.collectionChange, 0);
});

test('serie tem doze meses consecutivos e lacunas nao sao zero operacional confirmado', async () => {
  const m = await metrics([row('2026-09-10'), row('2026-07-10')]);
  assert.equal(m.months.length, 12);
  assert.equal(m.months[0].month, '2026-09');
  assert.equal(m.months[0].partial, true);
  assert.equal(m.months[1].month, '2026-08');
  assert.equal(m.months[1].hasRecords, false);
  assert.equal(m.months[1].issueRate, null);
  assert.equal(m.months[11].month, '2025-10');
});

test('dados invalidos e futuros sao contados, excluidos e suspendem comparacoes', async () => {
  const m = await metrics([row('2026-09-10'), row('2026-08-10'), row('2026-02-30'), row('2026-09-18'), row('2026-09-10', -1), row('2026-09-10', 1.5), row('2026-09-10', null)], {
    remoteQuality: { invalidDates: 1, invalidQuantities: 1, excludedRecords: 1 }
  });
  assert.equal(m.totals.attendances, 1);
  assert.equal(m.quality.invalidDates, 2);
  assert.equal(m.quality.invalidQuantities, 4);
  assert.equal(m.quality.futureDates, 1);
  assert.equal(m.quality.excludedRecords, 6);
  assert.equal(m.comparison.collectionChange, null);
  assert.match(m.comparison.reason, /inconsistências/);
});

test('backend sem metadados nao permite afirmar integridade do historico', async () => {
  const m = await metrics([row('2026-09-10'), row('2026-08-10')], { remoteQuality: null });
  assert.equal(m.quality.unreported, true);
  assert.equal(m.comparison.collectionChange, null);
});

test('categorias conhecidas tem mapeamento explicito e multiplas ocorrencias contam um atendimento', async () => {
  const m = await metrics([
    row('2026-09-10', 1, { intercorrencia: '1, 2, 1' }),
    row('2026-09-11', 1, { intercorrencia: 'Recipiente ausente' }),
    row('2026-09-12', 1, { intercorrencia: ' NENHUMA ' }),
    row('2026-09-13', 1, { intercorrencia: 'Texto livre, com vírgula' })
  ]);
  assert.equal(m.totals.issues, 3);
  assert.equal(m.issueMentions, 4);
  assert.equal(m.issueTypes.find(i => i.name === 'Recipiente ausente').count, 2);
  assert.equal(m.issueTypes.find(i => i.name === 'Recipiente ausente').share, 50);
  assert.ok(m.issueTypes.some(i => i.name === 'Texto livre, com vírgula'));
});

test('agenda usa sete datas civis, incluindo hoje, independentemente do mes selecionado', async () => {
  const api = await moduleReady;
  assert.equal(typeof api.scheduleWindow, 'function');
  const result = api.scheduleWindow(['2026-09-16', '2026-09-17', '2026-09-23', '2026-09-24', '2026-02-30'].map(dataPrevista => ({ dataPrevista })), new Date('2026-09-18T01:30Z'));
  assert.equal(result.todayCount, 1);
  assert.equal(result.upcoming.length, 2);
  assert.equal(result.invalidDates, 1);
});
