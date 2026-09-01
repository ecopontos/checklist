const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Harness espelhado do route-order.test, mas com o fetch simulando a acao
// clientChanges (subprojeto B): valida o fluxo de app outbox -> sync de cliente.
function createContext() {
  const storage = new Map();
  const requests = [];
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const context = vm.createContext({
    console, localStorage, globalThis: null,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    }),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      assert.strictEqual(body.action, 'clientChanges');
      assert.ok(body.changes.length > 0 && body.changes.length <= 100);
      // O GAS recebe campos como objeto.
      assert.strictEqual(typeof body.changes[0].campos, 'object');
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

const moduleCache = new Map();
async function loadModule(context, filename) {
  if (moduleCache.has(filename)) return moduleCache.get(filename).namespace;
  const source = fs.readFileSync(filename, 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: filename });
  moduleCache.set(filename, module);
  await module.link(async specifier => {
    const resolved = specifier.replace(/^\.\//, '');
    if (moduleCache.has(resolved)) return moduleCache.get(resolved);
    throw new Error(`Import inesperado em ${filename}: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

(async () => {
  const { context, requests } = createContext();
  const databaseModule = await loadModule(context, 'database.js');
  const syncModule = await loadModule(context, 'google-sync.js');
  const db = databaseModule.default;
  await db.init();
  db.addRoteiro('ROTA_A');
  db.addRoteiro('ROTA_B');
  const [rotaA, rotaB] = db.getRoteiros().map(r => r.id).sort((a, b) => a - b) && db.getRoteiros();
  const idA = db.getRoteiros().find(r => r.nome === 'ROTA_A').id;
  const idB = db.getRoteiros().find(r => r.nome === 'ROTA_B').id;

  // Mesmo cliente (uuid-x) aparece em dois roteiros distintos.
  const numeroKey = 'N' + String.fromCharCode(0xFA) + 'mero';
  const base = { idCliente: 'uuid-x', Cliente: 'CLIENTE X', logradouro: '', Complemento: '', CEP: '88000000', Telefone1: '', Telefone2: '', ativo: true };
  db.upsertCliente({ ...base, idRota: '1', roteiro_id: idA, Ordem: 1, [numeroKey]: '10' });
  db.upsertCliente({ ...base, idRota: '2', roteiro_id: idB, Ordem: 1, [numeroKey]: '10' });

  // Edicao de campos do cliente (Telefone1 e Numero).
  const campos = { Telefone1: '48999990000' };
  campos[numeroKey] = '250';

  db.updateClienteLocal('uuid-x', campos);
  // Refletiu nas duas linhas (todos os roteiros do cliente).
  assert.strictEqual(db.getClienteByIdRota('1').telefone1, '48999990000');
  assert.strictEqual(db.getClienteByIdRota('2').telefone1, '48999990000');
  assert.strictEqual(String(db.getClienteByIdRota('1').numero), '250');
  assert.strictEqual(String(db.getClienteByIdRota('2').numero), '250');

  const queued = db.queueClienteChange('uuid-x', campos);
  assert.strictEqual(queued.queued, true);
  assert.strictEqual(db.getPendingClienteChangesCount(), 1);

  // Pendentes trazem campos ja desserializados (objeto).
  const pending = db.getPendingClienteChanges(100);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(typeof pending[0].campos, 'object');
  assert.strictEqual(pending[0].campos.Telefone1, '48999990000');

  syncModule.setGasUrl('https://example.test/exec');
  syncModule.setGasRouteToken('token-test-cliente');
  const result = await syncModule.syncPendingClienteChanges(db);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.pending, 0);
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(db.getPendingClienteChangesCount(), 0);

  // Alteracao marcada invalida pelo GAS e descartada (nao trava a fila).
  db.queueClienteChange('uuid-x', { Telefone1: '11111111111' });
  assert.strictEqual(db.getPendingClienteChangesCount(), 1);
  const pendingInvalid = db.getPendingClienteChanges(1);
  const invalidChangeId = pendingInvalid[0].change_id;

  context.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        ok: true,
        acceptedIds: [],
        duplicateIds: [],
        invalidIds: [invalidChangeId]
      })
    };
  };

  const resultInvalid = await syncModule.syncPendingClienteChanges(db);
  assert.strictEqual(resultInvalid.ok, true);
  assert.strictEqual(resultInvalid.invalidCount, 1);
  assert.strictEqual(db.getPendingClienteChangesCount(), 0); // descartada, nao fica presa

  console.log('Fluxo de edicao de cliente (cadeia local + outbox + sync clientChanges): OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
