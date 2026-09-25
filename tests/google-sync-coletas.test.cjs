const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('pendencias sem cadastro sao visiveis e reenvio mantem ID legado apos falha', async () => {
  const storage = new Map([['app3_gas_url', 'https://example.test/exec']]);
  const requests = [];
  let reply = { ok: false, error: 'Falha' };
  let fetchGate = null;
  const context = vm.createContext({
    console, setTimeout, clearTimeout, AbortController, crypto: require('node:crypto').webcrypto,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    initSqlJs: () => require('../vendor/sql-wasm.js')({ locateFile: f => path.resolve('vendor', f) }),
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (fetchGate) await fetchGate;
      return { ok: true, json: async () => reply };
    }
  });
  const dbMod = new vm.SourceTextModule(fs.readFileSync('database.js', 'utf8'), { context });
  await dbMod.link(() => {}); await dbMod.evaluate();
  const syncMod = new vm.SourceTextModule(fs.readFileSync('google-sync.js', 'utf8'), { context });
  await syncMod.link(() => dbMod); await syncMod.evaluate();
  const db = dbMod.namespace.default;
  await db.init();
  db.db.run("INSERT INTO coletas (id_rota, data, quantidade, intercorrencia) VALUES ('99', '2026-09-17', 2, '')");
  assert.equal(db.getUnsyncedColetas().length, 1);
  let result = await syncMod.namespace.syncPendingColetas(db);
  assert.equal(result.ok, false);
  assert.equal(db.getUnsyncedColetas().length, 1);
  const sid = db.db.exec('SELECT sync_id FROM coletas')[0].values[0][0];
  assert.ok(sid);
  reply = { ok: true, count: 1 };
  result = await syncMod.namespace.syncPendingColetas(db);
  assert.equal(result.ok, true);
  assert.equal(db.getUnsyncedColetas().length, 0);
  assert.equal(requests[0].coletas[0].sync_id, sid);
  assert.equal(requests[1].coletas[0].sync_id, sid);
  assert.ok(storage.get('app3_db'));

  db.addColeta({ id_rota: '99', data: '2026-09-18', quantidade: 3, intercorrencia: '' });
  reply = { ok: true, count: 0 };
  result = await syncMod.namespace.syncPendingColetas(db);
  assert.equal(result.ok, false, 'ok sem confirmar o lote nao pode descartar pendencias');
  assert.equal(db.getUnsyncedColetas().length, 1);
  reply = { ok: true, count: 0, duplicates: 1 };
  result = await syncMod.namespace.syncPendingColetas(db);
  assert.equal(result.ok, true, 'duplicata confirmada tambem conclui a pendencia');
  assert.equal(db.getUnsyncedColetas().length, 0);

  db.addColeta({ id_rota: '99', data: '2026-09-18', quantidade: 4, intercorrencia: '' });
  reply = { ok: true, count: 1 };
  let release;
  fetchGate = new Promise(resolve => { release = resolve; });
  const beforeConcurrent = requests.length;
  const first = syncMod.namespace.syncPendingColetas(db);
  const second = syncMod.namespace.syncPendingColetas(db);
  assert.equal(first, second, 'chamadas concorrentes devem compartilhar a mesma promessa');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, beforeConcurrent + 1, 'apenas um POST deve ser iniciado');
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(db.getUnsyncedColetas().length, 0);
});
