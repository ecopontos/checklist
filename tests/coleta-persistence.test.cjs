const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function setup(saved) {
  const storage = new Map(saved ? [['app3_db', saved]] : []);
  let fail = false;
  const context = vm.createContext({ console, crypto: require('node:crypto').webcrypto,
    localStorage: { getItem: k => storage.get(k) ?? null, removeItem: k => storage.delete(k), setItem(k,v) { if (fail && k === 'app3_db') throw Error('QuotaExceeded'); storage.set(k,v); } },
    initSqlJs: () => require('../vendor/sql-wasm.js')({ locateFile: f => path.resolve('vendor', f) })
  });
  const mod = new vm.SourceTextModule(fs.readFileSync('database.js', 'utf8'), { context });
  await mod.link(() => {}); await mod.evaluate(); const db = mod.namespace.default; await db.init();
  return { db, storage, fail: value => { fail = value; } };
}
const entries = () => [
  { id_rota: '101', quantidade: 2, intercorrencia: '', cliente: 'Cliente A', sync_id: 'entry-a' },
  { id_rota: '102', quantidade: 0, intercorrencia: 'Ausente', cliente: 'Cliente B', sync_id: 'entry-b' }
];
const operation = () => ({ operationId: 'operation-a', data: '2026-09-17', roteiro: 'ORIGINAL', entries: entries() });

test('falha de persistencia da operacao restaura memoria e disco, retentativa e idempotente', async () => {
  const h = await setup(); const before = h.storage.get('app3_db'); h.fail(true);
  assert.throws(() => h.db.saveColetaOperation(operation()), /QuotaExceeded/);
  assert.equal(h.db.getUnsyncedColetas().length, 0); assert.equal(h.storage.get('app3_db'), before);
  h.fail(false); const saved = h.db.saveColetaOperation(operation());
  assert.equal(saved.length, 2); assert.equal(h.db.saveColetaOperation(operation()).length, 2);
  assert.equal(h.db.getUnsyncedColetas().length, 2);
  const reloaded = await setup(h.storage.get('app3_db'));
  reloaded.db.saveColetaOperation(operation()); assert.equal(reloaded.db.getUnsyncedColetas().length, 2);
  assert.throws(() => h.db.saveColetaOperation({ ...operation(), data: '2026-09-16' }), /diferente|conflito/i);
});

test('insercao avulsa e confirmacao falhas nao deixam estado em memoria diferente do persistido', async () => {
  const h = await setup(); h.fail(true);
  assert.throws(() => h.db.addColeta({ ...entries()[0], data: '2026-09-17' }), /QuotaExceeded/);
  assert.equal(h.db.getUnsyncedColetas().length, 0);
  h.fail(false); const id = h.db.addColeta({ ...entries()[0], data: '2026-09-17' }); h.fail(true);
  assert.throws(() => h.db.markColetasSynced([{ id, sync_id: 'entry-a' }]), /QuotaExceeded/);
  assert.equal(h.db.getUnsyncedColetas().length, 1);
});

test('contexto do evento permanece apos alteracao do cadastro e em registros orfaos', async () => {
  const h = await setup(); h.db.saveColetaOperation(operation());
  h.db.addRoteiro('NOVO');
  h.db.db.run("INSERT INTO clientes (id_rota, cliente, roteiro_id) VALUES ('101', 'Nome novo', 1)");
  const pending = h.db.getUnsyncedColetas();
  assert.equal(pending.find(c => c.id_rota === '101').roteiro, 'ORIGINAL');
  assert.equal(pending.find(c => c.id_rota === '101').cliente, 'Cliente A');
  assert.equal(pending.find(c => c.id_rota === '102').cliente, 'Cliente B');
});

test('migracao congela contexto local disponivel inclusive quando colunas clientes ja existem', async () => {
  const h = await setup(); h.db.addRoteiro('ANTIGO');
  h.db.db.run("INSERT INTO clientes(id_rota,cliente,roteiro_id) VALUES ('99','Legado',1)");
  h.db.db.run('DROP TABLE coletas');
  h.db.db.run('CREATE TABLE coletas(id INTEGER PRIMARY KEY, id_rota TEXT, data TEXT, quantidade INTEGER, intercorrencia TEXT, last_sync TEXT, sync_id TEXT)');
  h.db.db.run("INSERT INTO coletas VALUES(1,'99','2026-09-17',3,'',NULL,'legacy')"); h.db.save();
  const migrated = await setup(h.storage.get('app3_db'));
  migrated.db.db.run("UPDATE clientes SET cliente='Alterado'");
  migrated.db.db.run("UPDATE roteiros SET nome='NOVO'");
  assert.equal(migrated.db.getUnsyncedColetas()[0].cliente, 'Legado');
  assert.equal(migrated.db.getUnsyncedColetas()[0].roteiro, 'ANTIGO');
});

test('importacao preserva pontos de mesmo nome e rejeita conflito de id antes de mutar', async () => {
  const h = await setup();
  const row = { Cliente:'Mesmo nome', Roteiro:'R1', Ordem:1, Inativo:0 };
  assert.equal(h.db.importRoteirosRows([{ ...row,idRota:'101' },{ ...row,idRota:'102' }]).clientes, 2);
  assert.equal(h.db.getClientesByRoteiro(h.db.getRoteiros()[0].id).length, 2);
  assert.throws(() => h.db.importRoteirosRows([{ ...row,idRota:'101' },{ ...row,idRota:'101',Roteiro:'R2' }]), /conflito|duplicado/i);
  assert.equal(h.db.getRoteiros().length, 1);
});

test('validacao rejeita quantidade fracionaria, negativa ou data impossivel antes de salvar lote', async () => {
  const h = await setup();
  for (const quantidade of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => h.db.saveColetaOperation({ ...operation(), entries: [{ ...entries()[0], quantidade }] }), /quantidade/i);
  }
  assert.throws(() => h.db.saveColetaOperation({ ...operation(), data: '2026-02-30' }), /data/i);
  assert.throws(() => h.db.saveColetaOperation({ ...operation(), data: '2099-01-01' }), /futura/i);
  assert.equal(h.db.getUnsyncedColetas().length, 0);
});
