const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createContext() {
  const storage = new Map();
  const requests = [];
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value))
  };
  const context = vm.createContext({
    console,
    localStorage,
    globalThis: null,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Error,
    Map,
    Set,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    }),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      assert.strictEqual(body.action, 'routeChanges');
      assert.ok(body.changes.length > 0 && body.changes.length <= 100);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          acceptedIds: body.changes.map(change => change.change_id),
          duplicateIds: []
        })
      };
    }
  });
  context.globalThis = context;
  return { context, requests };
}

async function loadModule(context, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: filename });
  await module.link(() => { throw new Error(`Import inesperado em ${filename}`); });
  await module.evaluate();
  return module.namespace;
}

(async () => {
  const { context, requests } = createContext();
  const databaseModule = await loadModule(context, 'database.js');
  const syncModule = await loadModule(context, 'google-sync.js');
  const db = databaseModule.default;
  await db.init();
  db.addRoteiro('TESTE_ORDEM');
  const routeId = db.getRoteiros()[0].id;

  for (let index = 1; index <= 120; index += 1) {
    const point = {
      idRota: String(index),
      Cliente: `Cliente ${index}`,
      logradouro: '',
      CEP: '',
      roteiro_id: routeId,
      Ordem: index,
      ativo: true
    };
    point['N' + String.fromCharCode(0xFA) + 'mero'] = '';
    db.upsertCliente(point);
  }

  const orderedIds = Array.from({ length: 120 }, (_, index) => String(index + 1));
  orderedIds.splice(119, 1);
  orderedIds.splice(10, 0, '120');
  const applied = db.applyRoteiroOrder(routeId, orderedIds);
  assert.strictEqual(applied.count, 110);
  assert.strictEqual(db.getPendingRoteiroChangesCount(), 110);

  const reordered = db.getClientesByRoteiro(routeId);
  assert.strictEqual(String(reordered[10].id_rota), '120');
  reordered.forEach((point, index) => assert.strictEqual(Number(point.ordem), index + 1));

  const noChanges = db.applyRoteiroOrder(routeId, orderedIds);
  assert.strictEqual(noChanges.count, 0);
  assert.strictEqual(db.getPendingRoteiroChangesCount(), 110);
  assert.throws(
    () => db.applyRoteiroOrder(routeId, [...orderedIds.slice(0, 119), '118']),
    /ausentes ou duplicados/
  );

  syncModule.setGasUrl('https://example.test/exec');
  syncModule.setGasRouteToken('token-test-route-order');
  const syncResult = await syncModule.syncPendingRoteiroChanges(db);
  assert.strictEqual(syncResult.ok, true);
  assert.strictEqual(syncResult.count, 110);
  assert.strictEqual(syncResult.pending, 0);
  assert.strictEqual(requests.length, 2);
  assert.strictEqual(requests[0].changes.length, 100);
  assert.strictEqual(requests[1].changes.length, 10);

  const html = fs.readFileSync('roteiros.html', 'utf8');
  const moduleMatch = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(moduleMatch, 'Módulo JavaScript de roteiros.html não encontrado');
  new vm.SourceTextModule(moduleMatch[1], { context: vm.createContext({}) });
  new vm.Script(fs.readFileSync('gas/Code.gs', 'utf8'));
  assert.match(html, /id="btnOrganizeRoute"/);
  assert.match(html, /id="organizeModal"/);

  console.log('Reordenação em lote, fila multibatch e sintaxe: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
