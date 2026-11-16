// tests/instance-identity.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function load(extra = {}) {
  const storage = new Map();
  const context = vm.createContext({
    console,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    crypto: require('node:crypto').webcrypto,
    navigator: { userAgent: 'TestUA/1.0' },
    window: { APP_CONFIG: { appVersion: '9.9.9' } },
    ...extra
  });
  const mod = new vm.SourceTextModule(fs.readFileSync('instance-identity.js', 'utf8'), { context });
  await mod.link(() => { throw new Error('sem imports esperados'); });
  await mod.evaluate();
  return { mod, storage };
}

test('getInstanceId gera e persiste um UUID estavel', async () => {
  const { mod, storage } = await load();
  const id1 = mod.namespace.getInstanceId();
  const id2 = mod.namespace.getInstanceId();
  assert.equal(id1, id2);
  assert.ok(id1 && id1.length >= 16);
  assert.equal(storage.get('satelite.instanceId'), id1);
});

test('setApelido/getApelido persistem no localStorage', async () => {
  const { mod, storage } = await load();
  mod.namespace.setApelido('Tablet Caminhao 07');
  assert.equal(mod.namespace.getApelido(), 'Tablet Caminhao 07');
  assert.equal(storage.get('satelite.apelido'), 'Tablet Caminhao 07');
});

test('getInstanceMeta devolve iid, nick, av, gu, ua', async () => {
  const { mod } = await load();
  mod.namespace.setApelido('PC Base Norte');
  const meta = mod.namespace.getInstanceMeta('https://ex.test/exec');
  assert.equal(meta.nick, 'PC Base Norte');
  assert.equal(meta.av, '9.9.9');
  assert.equal(meta.gu, 'https://ex.test/exec');
  assert.equal(meta.ua, 'TestUA/1.0');
  assert.ok(meta.iid);
});

test('appendInstanceParams anexa os params encodados', async () => {
  const { mod } = await load();
  mod.namespace.setApelido('Caminhao 7');
  const url = mod.namespace.appendInstanceParams('https://ex.test/exec?action=status', 'https://ex.test/exec');
  assert.ok(url.includes('iid='));
  assert.ok(url.includes('nick=Caminhao%207'));
  assert.ok(url.includes('gu=https%3A%2F%2Fex.test%2Fexec'));
});

test('withInstanceMeta aninha inst sem perder o body original', async () => {
  const { mod } = await load();
  const body = mod.namespace.withInstanceMeta({ action: 'x', ops: [1] }, 'https://ex.test/exec');
  assert.equal(body.action, 'x');
  assert.deepEqual(body.ops, [1]);
  assert.ok(body.inst.iid);
  assert.equal(body.inst.gu, 'https://ex.test/exec');
});

test('fallback de id quando crypto.randomUUID nao existe', async () => {
  const { mod } = await load({ crypto: {} });
  const id = mod.namespace.getInstanceId();
  assert.ok(id && id.length >= 16);
});
