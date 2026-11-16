// tests/google-sync-instancia.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function makeContext(capture) {
  const storage = new Map([['app3_gas_url', 'https://ex.test/exec']]);
  return vm.createContext({
    console, setTimeout, clearTimeout, AbortController,
    crypto: require('node:crypto').webcrypto,
    navigator: { userAgent: 'TestUA/1.0' },
    window: { APP_CONFIG: { appVersion: '9.9.9' } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    fetch: async (url, options) => {
      capture.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, apiVersion: 16, service: 'satelite-gas' }) };
    }
  });
}

async function loadSync(context) {
  function linker(spec) {
    const src = fs.readFileSync(spec.replace('./', ''), 'utf8');
    return new vm.SourceTextModule(src, { context, identifier: spec });
  }
  const sync = new vm.SourceTextModule(fs.readFileSync('google-sync.js', 'utf8'), { context, identifier: 'google-sync.js' });
  await sync.link(async (spec) => {
    const m = linker(spec);
    await m.link(() => { throw new Error('nested import inesperado: ' + spec); });
    return m;
  });
  await sync.evaluate();
  return sync;
}

test('GET de status carrega iid na query', async () => {
  const capture = [];
  const context = makeContext(capture);
  const sync = await loadSync(context);
  await sync.namespace.getGasStatus();
  assert.equal(capture.length >= 1, true);
  assert.ok(capture[0].url.includes('action=status'));
  assert.ok(capture[0].url.includes('iid='));
  assert.ok(capture[0].url.includes('av=9.9.9'));
});
