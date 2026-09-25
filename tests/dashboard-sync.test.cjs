const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
process.env.TZ = 'America/Sao_Paulo';

async function dashboard(overrides = {}, now = '2026-09-17T15:00:00Z') {
  const els = new Map(), storage = new Map(), listeners = {}, intervals = [];
  const html = fs.readFileSync('dashboard.html', 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
  const context = vm.createContext({
    console, Date: Clock, crypto: require('node:crypto').webcrypto,
    setTimeout: () => 1, clearTimeout() {}, setInterval: fn => intervals.push(fn),
    window: { addEventListener: (event, fn) => { listeners[event] = fn; } },
    document: {
      visibilityState: 'visible', addEventListener: (event, fn) => { listeners[event] = fn; },
      getElementById(id) { assert.ok(ids.has(id), `Elemento ausente no HTML: ${id}`); if (!els.has(id)) els.set(id, { textContent: '', innerHTML: '', value: '', style: {}, handlers: {}, classList: { add() {}, remove() {} }, addEventListener(event, fn) { this.handlers[event] = fn; } }); return els.get(id); }
    },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    initSqlJs: () => require('../vendor/sql-wasm.js')({ locateFile: file => path.resolve('vendor', file) }),
    getLastRoteirosDriveSyncLabel: () => 'Hoje',
    checkAndImportRoteiros: async () => ({ checked: true, updated: false }),
    syncPendingRoteiroChanges: async () => ({ ok: true, pending: 0 }),
    syncPendingClienteChanges: async () => ({ ok: true, pending: 0 }),
    syncPendingColetas: async () => ({ ok: true, pending: 0 }),
    getGasStatus: async () => ({ ok: true, apiVersion: 9 }),
    getAgendamentos: async () => ({ ok: true, data: [] }),
    getHistoricoColetas: async () => ({ ok: true, data: [], quality: { invalidDates: 0, invalidQuantities: 0, excludedRecords: 0 } }),
    ...overrides
  });
  const mod = new vm.SourceTextModule(fs.readFileSync('database.js', 'utf8'), { context });
  await mod.link(() => {}); await mod.evaluate();
  context.db = mod.namespace.default;
  await context.db.init();
  const metrics = new vm.SourceTextModule(fs.readFileSync('dashboard-metrics.js', 'utf8'), { context });
  await metrics.link(() => {}); await metrics.evaluate();
  for (const name of Object.keys(metrics.namespace)) context[name] = metrics.namespace[name];
  const inline = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  const source = (inline ? inline[1] : fs.readFileSync(html.match(/<script type="module" src="([^"]+)"/)[1], 'utf8'))
    .replace(/^\s*import .*;$/gm, '').replace(/\n\s*init\(\);\s*$/, '');
  vm.runInContext(source, context);
  return { context, els, intervals, listeners, run: code => vm.runInContext(code, context) };
}

test('dashboard disponibiliza Papa Parse antes do modulo que importa cadastros', () => {
  const html = fs.readFileSync('dashboard.html', 'utf8');
  const context = vm.createContext({ console });
  let dashboardModuleFound = false;
  for (const [, attributes] of html.matchAll(/<script\b([^>]*)><\/script>/g)) {
    const source = attributes.match(/\bsrc="([^"]+)"/)?.[1];
    if (source === 'dashboard.js' && /\btype="module"/.test(attributes)) {
      dashboardModuleFound = true;
      break;
    }
    if (source?.startsWith('vendor/')) {
      vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
    }
  }
  assert.equal(dashboardModuleFound, true);
  assert.equal(typeof context.Papa?.parse, 'function');
});

test('todos os indicadores usam remoto mais pendencias deduplicadas por sync_id', async () => {
  const remote = [{ syncId: 'remoto', data: '2026-09-17', roteiro: 'ROTA REMOTA', quantidade: 3, intercorrencia: 'Falha remota' }];
  const d = await dashboard({ getHistoricoColetas: async () => ({ ok: true, data: remote }) });
  d.context.db.addColeta({ id_rota: 'sem-cadastro', data: '2026-09-17', quantidade: 3, intercorrencia: 'Falha remota', sync_id: 'remoto' });
  d.context.db.addColeta({ id_rota: 'sem-cadastro', data: '2026-09-17', quantidade: 2, intercorrencia: 'Falha local', sync_id: 'local' });
  await d.run('init()');
  assert.equal(String(d.els.get('kpiCollects').textContent), '2');
  assert.match(d.els.get('topRoutes').innerHTML, /ROTA REMOTA/);
  assert.match(d.els.get('issueList').innerHTML, /Falha remota/);
  assert.match(d.els.get('issueList').innerHTML, /Falha local/);
  assert.match(d.els.get('monthlySummary').innerHTML, />5<\/td>/);
});

test('falhas nao viram sucesso e fallback local fica identificado', async () => {
  const fail = async () => ({ ok: false, error: 'Sem conexao' });
  const d = await dashboard({ getHistoricoColetas: fail, getGasStatus: fail, getAgendamentos: fail, syncPendingClienteChanges: fail });
  await d.run('init()');
  assert.doesNotMatch(d.els.get('syncDetail').textContent, /Todos os dados carregados/);
  assert.match(d.els.get('syncSpinner').className, /error/);
  assert.match(d.els.get('dataSource').textContent, /loca/i);
  assert.doesNotMatch(d.els.get('gasCollectsCount').textContent, /Sincronizado/);
});

test('proximos sete dias inclui hoje e exclui ontem e o oitavo dia apos 21h local', async () => {
  const data = ['2026-09-16', '2026-09-17', '2026-09-23', '2026-09-24'].map(dataPrevista => ({ cliente: dataPrevista, dataPrevista }));
  const d = await dashboard({ getAgendamentos: async day => ({ ok: true, data: day ? data.filter(a => a.dataPrevista === day) : data }) }, '2026-09-18T01:30:00Z');
  await d.run('fetchAgendamentos()');
  assert.equal(String(d.els.get('kpiSchedules').textContent), '1');
  assert.equal(String(d.els.get('kpiSchedulesWeek').textContent), '2');
  assert.match(d.els.get('schedulesTable').innerHTML, /2026-09-23/);
  assert.match(d.els.get('schedulesTable').innerHTML, /2026-09-17/);
  assert.doesNotMatch(d.els.get('schedulesTable').innerHTML, /2026-09-16|2026-09-24/);
});

test('agenda futura aparece mesmo sem registros hoje', async () => {
  const d = await dashboard({ getAgendamentos: async day => ({ ok: true, data: day ? [] : [{ cliente: 'Amanha', dataPrevista: '2026-09-18' }] }) });
  await d.run('fetchAgendamentos()');
  assert.equal(String(d.els.get('kpiSchedulesWeek').textContent), '1');
  assert.match(d.els.get('schedulesTable').innerHTML, /Amanha/);
});

test('envia coletas antes do historico e atualiza KPIs depois do CSV', async () => {
  const calls = [];
  const d = await dashboard({
    syncPendingColetas: async () => { calls.push('push'); return { ok: true, pending: 0 }; },
    getHistoricoColetas: async () => { calls.push('pull'); return { ok: true, data: [] }; },
    checkAndImportRoteiros: async db => {
      await new Promise(resolve => setImmediate(resolve));
      db.addRoteiro('NOVO');
      db.db.run("INSERT INTO clientes (id_rota, cliente, roteiro_id, ativo) VALUES ('novo', 'Novo cliente', ?, 1)", [db.getRoteiros()[0].id]);
      db.addRoteiro('VAZIO');
      return { checked: true, updated: true };
    }
  });
  await d.run('init()');
  assert.deepEqual(calls, ['push', 'pull']);
  assert.equal(String(d.els.get('kpiRoutes').textContent), '1');
  assert.equal(typeof d.listeners.online, 'function');
  assert.ok(d.intervals.length > 0);
});

test('falha de fila ou CSV impede sucesso mesmo com consultas remotas boas', async () => {
  const d = await dashboard({ syncPendingRoteiroChanges: async () => ({ ok: false, error: 'Fila bloqueada' }) });
  await d.run('init()');
  assert.match(d.els.get('syncSpinner').className, /error/);
  assert.match(d.els.get('syncDetail').textContent, /Fila bloqueada/);
});

test('atualizacao bem sucedida identifica dados consolidados', async () => {
  const d = await dashboard();
  await d.run('init()');
  assert.equal(d.els.get('syncSpinner').className, 'spinner done');
  assert.match(d.els.get('dataSource').textContent, /consolidado/i);
});

test('atualizacoes simultaneas compartilham um ciclo e permitem nova tentativa depois', async () => {
  let release, pushes = 0;
  const d = await dashboard({ syncPendingColetas: () => { pushes++; return new Promise(resolve => { release = resolve; }); } });
  const first = d.run('refreshDashboard()');
  const second = d.run('refreshDashboard()');
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pushes, 1);
  release({ ok: true });
  await first;
  const third = d.run('refreshDashboard()');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pushes, 2);
  release({ ok: true });
  await third;
});

test('falha posterior do historico remove consolidado antigo e informa fonte local', async () => {
  let online = true;
  const d = await dashboard({ getHistoricoColetas: async () => online
    ? { ok: true, data: [{ syncId: 'remoto', data: '2026-09-17', quantidade: 3, roteiro: 'R1' }] }
    : { ok: false, error: 'Falha posterior' } });
  await d.run('init()');
  assert.equal(String(d.els.get('kpiCollects').textContent), '1');
  online = false;
  await d.run('refreshDashboard()');
  assert.equal(String(d.els.get('kpiCollects').textContent), '0');
  assert.match(d.els.get('dataSource').textContent, /Dados locais/);
  assert.match(d.els.get('refreshStatus').textContent, /Falha posterior/);
});

test('resposta do GAS antigo nao e confundida com historico vazio', async () => {
  const d = await dashboard({ getHistoricoColetas: async () => ({ ok: true, rows: [] }) });
  await d.run('init()');
  assert.match(d.els.get('refreshStatus').textContent, /incompatível/);
  assert.match(d.els.get('dataSource').textContent, /Dados locais/);
});

test('ADR-0001 separa retirada e atendimento e apresenta cortes equivalentes sem cores de desempenho', async () => {
  const data = [
    { data: '2026-09-17', quantidade: 5, intercorrencia: '1' },
    { data: '2026-09-16', quantidade: 0, intercorrencia: '2' },
    { data: '2026-08-16', quantidade: 3, intercorrencia: '' }
  ];
  const d = await dashboard({ getHistoricoColetas: async () => ({ ok: true, data, quality: { invalidDates: 0, invalidQuantities: 0, excludedRecords: 0 } }) });
  await d.run('init()');
  assert.equal(String(d.els.get('kpiCollects').textContent), '1');
  assert.equal(String(d.els.get('kpiAttendances').textContent), '2');
  assert.equal(String(d.els.get('kpiContainers').textContent), '5');
  assert.match(d.els.get('kpiCollectsDelta').textContent, /-100,0%/);
  assert.doesNotMatch(d.els.get('kpiCollectsDelta').className, /up|down/);
  assert.match(d.els.get('comparisonRange').textContent, /16\/09\/2026/);
  assert.match(d.els.get('comparisonRange').textContent, /16\/08\/2026/);
  assert.match(d.els.get('kpiIssuesDelta').textContent, /2 de 2/);
  assert.match(d.els.get('monthlySummary').innerHTML, /Sem registros na base consultada/);
});

test('selecao de mes filtra ranking e intercorrencias sem mudar agenda nem cadastro atual', async () => {
  const data = [
    { data: '2026-09-10', quantidade: 2, roteiro: 'SETEMBRO', intercorrencia: 'Falha setembro' },
    { data: '2026-08-10', quantidade: 1, roteiro: 'AGOSTO', intercorrencia: 'Falha agosto' }
  ];
  const d = await dashboard({ getHistoricoColetas: async () => ({ ok: true, data, quality: { invalidDates: 0, invalidQuantities: 0, excludedRecords: 0 } }) });
  await d.run('init()');
  const input = d.context.document.getElementById('dashboardMonth');
  input.value = '2026-08';
  input.handlers.change();
  assert.match(d.els.get('topRoutes').innerHTML, /AGOSTO/);
  assert.doesNotMatch(d.els.get('topRoutes').innerHTML, /SETEMBRO/);
  assert.match(d.els.get('issueList').innerHTML, /Falha agosto/);
  assert.match(d.els.get('periodSummary').textContent, /31\/08\/2026/);
  assert.equal(String(d.els.get('kpiSchedules').textContent), '0');
});

test('registro invalido recebido ou descartado pelo servidor avisa e suspende comparacao', async () => {
  const d = await dashboard({ getHistoricoColetas: async () => ({ ok: true, data: [
    { data: '2026-09-10', quantidade: 2 }, { data: '2026-08-10', quantidade: 2 }, { data: '2026-09-18', quantidade: 2 }
  ], quality: { invalidDates: 1, invalidQuantities: 0, excludedRecords: 1 } }) });
  await d.run('init()');
  assert.equal(String(d.els.get('kpiCollects').textContent), '1');
  assert.match(d.els.get('qualitySummary').textContent, /2 registro/);
  assert.match(d.els.get('kpiCollectsDelta').textContent, /inconsistências/);
});
