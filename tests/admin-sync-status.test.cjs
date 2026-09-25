const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadAdmin(overrides = {}) {
  const html = fs.readFileSync('admin.html', 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const elements = new Map();
  const timers = [];
  const db = {
    db: { exec: () => [] },
    getUnsyncedColetas: () => [],
    getPendingRoteiroChangesCount: () => 0,
    downloadDatabase() {},
    ...overrides.db
  };
  const context = vm.createContext({
    console,
    window: {},
    document: {
      getElementById(id) {
        assert.ok(ids.has(id), `Elemento ausente no HTML: ${id}`);
        if (!elements.has(id)) {
          elements.set(id, { textContent: '', className: '', value: '', style: {} });
        }
        return elements.get(id);
      }
    },
    localStorage: { removeItem() {} },
    confirm: () => false,
    alert() {},
    location: { reload() {} },
    setTimeout(fn, delay) {
      const timer = { fn, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    db,
    decodeLegacyCsvBytes: () => '',
    getGasUrl: () => 'https://example.test/gas',
    setGasUrl() {},
    getGasRouteToken: () => 'token',
    setGasRouteToken() {},
    getGasStatus: async () => ({ ok: true, apiVersion: 12, routeChangesConfigured: true }),
    checkAndImportRoteiros: async () => ({ checked: true, updated: false }),
    syncPendingRoteiroChanges: async () => ({ ok: true, count: 0 }),
    REQUIRED_GAS_API_VERSION: 12,
    ...overrides
  });
  const inline = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  const source = inline[1]
    .replace(/^\s*import[\s\S]*?from '.\/google-sync\.js';\s*$/m, '')
    .replace(/\n\s*init\(\);\s*$/, '');
  vm.runInContext(source, context);
  return { context, elements, timers };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('GAS avanca e leitura demorada continua ate aplicar o resultado', async () => {
  let finishNetworkRead;
  const admin = loadAdmin({
    checkAndImportRoteiros: () => new Promise(resolve => { finishNetworkRead = resolve; })
  });

  const update = admin.context.window.checkDriveUpdate();
  await nextTurn();

  assert.match(admin.elements.get('gasVersionStatus').textContent, /compatível/i);
  assert.match(admin.elements.get('routeChangesStatus').textContent, /fila local sincronizada/i);

  const delayNotice = admin.timers.find(timer => !timer.cleared);
  assert.ok(delayNotice, 'a leitura do CSV no Drive deve ter um aviso de demora');
  assert.equal(delayNotice.delay, 10000);
  delayNotice.fn();
  assert.match(admin.elements.get('syncStatusText').textContent, /continua em segundo plano/i);

  finishNetworkRead({ checked: true, updated: true, roteiros: 3, clientes: 5, pulados: 0 });
  await update;
  assert.match(admin.elements.get('syncStatusText').textContent, /Atualizado agora: 3 roteiros, 5 pontos/i);
});

test('falhas inesperadas viram erro visivel em vez de manter verificando', async () => {
  const admin = loadAdmin({
    getGasStatus: async () => { throw new Error('status indisponível'); },
    checkAndImportRoteiros: async () => { throw new Error('Drive indisponível'); },
    syncPendingRoteiroChanges: async () => { throw new Error('fila indisponível'); }
  });

  await admin.context.window.checkDriveUpdate();

  assert.match(admin.elements.get('gasVersionStatus').textContent, /status indisponível/i);
  assert.match(admin.elements.get('routeChangesStatus').textContent, /fila indisponível/i);
  assert.match(admin.elements.get('syncStatusText').textContent, /Drive indisponível/i);
});

test('fila informa seu resultado mesmo enquanto status GAS continua pendente', async () => {
  let finishGasStatus;
  const admin = loadAdmin({
    getGasStatus: () => new Promise(resolve => { finishGasStatus = resolve; })
  });

  const update = admin.context.window.checkDriveUpdate();
  await nextTurn();

  assert.match(admin.elements.get('routeChangesStatus').textContent, /fila local sincronizada/i);
  assert.match(admin.elements.get('gasVersionStatus').textContent, /verificando/i);

  finishGasStatus({ ok: true, apiVersion: 12, routeChangesConfigured: true });
  await update;
});

test('verificacao antiga conclui sem sobrescrever os indicadores da mais nova', async () => {
  let finishOldGas, finishOldRoute, finishOldNetwork;
  let gasCalls = 0, routeCalls = 0, networkCalls = 0;
  const admin = loadAdmin({
    getGasStatus: () => ++gasCalls === 1
      ? new Promise(resolve => { finishOldGas = resolve; })
      : Promise.resolve({ ok: true, apiVersion: 12, routeChangesConfigured: true }),
    syncPendingRoteiroChanges: () => ++routeCalls === 1
      ? new Promise(resolve => { finishOldRoute = resolve; })
      : Promise.resolve({ ok: true, count: 0 }),
    checkAndImportRoteiros: () => ++networkCalls === 1
      ? new Promise(resolve => { finishOldNetwork = resolve; })
      : Promise.resolve({ checked: true, updated: true, roteiros: 2, clientes: 4, pulados: 0 })
  });

  const oldUpdate = admin.context.window.checkDriveUpdate();
  await nextTurn();
  const currentUpdate = admin.context.window.checkDriveUpdate();
  await currentUpdate;

  assert.match(admin.elements.get('gasVersionStatus').textContent, /v12: compatível/i);
  assert.match(admin.elements.get('routeChangesStatus').textContent, /fila local sincronizada/i);
  assert.match(admin.elements.get('syncStatusText').textContent, /Atualizado agora: 2 roteiros, 4 pontos/i);

  const oldDelayNotice = admin.timers.find(timer => !timer.cleared);
  oldDelayNotice.fn();
  finishOldGas({ ok: true, apiVersion: 9, routeChangesConfigured: false });
  finishOldRoute({ ok: false, error: 'fila antiga' });
  finishOldNetwork({ checked: true, updated: false, error: 'rede antiga' });
  await oldUpdate;

  assert.match(admin.elements.get('gasVersionStatus').textContent, /v12: compatível/i);
  assert.match(admin.elements.get('routeChangesStatus').textContent, /fila local sincronizada/i);
  assert.match(admin.elements.get('syncStatusText').textContent, /Atualizado agora: 2 roteiros, 4 pontos/i);
});
