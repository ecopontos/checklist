const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// IndexedDB mínimo em memória: só o que database.js usa (um store chave/valor).
function fakeIndexedDB() {
  const data = new Map();
  let created = false;
  const later = fn => setTimeout(fn, 0);
  const conn = {
    createObjectStore() {},
    transaction() {
      const tx = {};
      const req = fn => {
        const request = {};
        later(() => { request.result = fn(); later(() => tx.oncomplete && tx.oncomplete()); });
        return request;
      };
      tx.objectStore = () => ({
        get: key => req(() => data.get(key)),
        put: (value, key) => req(() => { data.set(key, value.slice()); return key; }),
        delete: key => req(() => { data.delete(key); })
      });
      return tx;
    }
  };
  return {
    data,
    open() {
      const request = {};
      later(() => {
        request.result = conn;
        if (!created) { created = true; request.onupgradeneeded && request.onupgradeneeded(); }
        request.onsuccess();
      });
      return request;
    }
  };
}

async function setup({ idb = fakeIndexedDB(), storage = new Map() } = {}) {
  const context = vm.createContext({ console, crypto: require('node:crypto').webcrypto,
    indexedDB: idb,
    localStorage: { getItem: k => storage.get(k) ?? null, removeItem: k => storage.delete(k), setItem: (k, v) => storage.set(k, v) },
    initSqlJs: () => require('../vendor/sql-wasm.js')({ locateFile: f => path.resolve('vendor', f) })
  });
  const mod = new vm.SourceTextModule(fs.readFileSync('database.js', 'utf8'), { context });
  await mod.link(() => {}); await mod.evaluate();
  const db = mod.namespace.default; await db.init();
  return { db, idb, storage };
}

const nomes = db => db.getRoteiros().map(r => r.nome);

test('grava no IndexedDB e recarrega de lá, sem usar o localStorage', async () => {
  const h = await setup();
  h.db.addRoteiro('SAT01');
  assert.equal(h.db.hasPendingWrites(), true);
  await h.db.flush();
  assert.equal(h.db.hasPendingWrites(), false);
  assert.equal(h.storage.has('app3_db'), false);
  assert.ok(h.idb.data.get('app3_db').length > 0);

  const reloaded = await setup({ idb: h.idb, storage: h.storage });
  assert.deepEqual(nomes(reloaded.db), ['SAT01']);
});

test('migra o banco antigo do localStorage para o IndexedDB e libera o localStorage', async () => {
  const legacy = await setup({ idb: null });
  legacy.db.addRoteiro('LEGADO');
  assert.ok(legacy.storage.has('app3_db'));

  const h = await setup({ storage: legacy.storage });
  assert.deepEqual(nomes(h.db), ['LEGADO']);
  assert.equal(h.storage.has('app3_db'), false);
  assert.ok(h.idb.data.has('app3_db'));
});

test('banco antigo que reaparece depois da migracao vira copia de seguranca, sem sobrescrever', async () => {
  const h = await setup();
  h.db.addRoteiro('ATUAL');
  await h.db.flush();

  const legacy = await setup({ idb: null });
  legacy.db.addRoteiro('ANTIGO');
  h.storage.set('app3_db', legacy.storage.get('app3_db'));

  const reloaded = await setup({ idb: h.idb, storage: h.storage });
  assert.deepEqual(nomes(reloaded.db), ['ATUAL']);
  assert.equal(h.storage.has('app3_db'), false);
  const backups = [...h.idb.data.keys()].filter(k => k.startsWith('app3_db_localstorage_'));
  assert.equal(backups.length, 1);
});

test('saves seguidos sao coalescidos e o ultimo estado prevalece', async () => {
  const h = await setup();
  h.db.addRoteiro('A'); h.db.addRoteiro('B'); h.db.addRoteiro('C');
  await h.db.flush();
  const reloaded = await setup({ idb: h.idb, storage: h.storage });
  assert.deepEqual(nomes(reloaded.db).sort(), ['A', 'B', 'C']);
});

test('resetStorage apaga o banco e ignora saves posteriores', async () => {
  const h = await setup();
  h.db.addRoteiro('X');
  await h.db.resetStorage();
  h.db.addRoteiro('Y');
  await h.db.flush();
  assert.equal(h.idb.data.has('app3_db'), false);
  const reloaded = await setup({ idb: h.idb, storage: h.storage });
  assert.equal(nomes(reloaded.db).length, 0);
});
