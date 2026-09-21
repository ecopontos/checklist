const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function loadSyncModule(replies, gasUrl = 'https://gas.example/exec') {
  const storage = new Map(gasUrl ? [['app3_gas_url', gasUrl]] : []);
  const requests = [];
  const context = vm.createContext({
    console,
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    window: undefined,
    setTimeout,
    clearTimeout,
    AbortController,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    crypto: require('node:crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    }),
    fetch: async url => {
      requests.push(url);
      return { ok: true, json: async () => replies.shift() };
    }
  });
  const database = new vm.SourceTextModule(fs.readFileSync('database.js', 'utf8'), {
    context,
    identifier: 'database.js'
  });
  await database.link(() => { throw new Error('Import inesperado em database.js'); });
  await database.evaluate();
  const sync = new vm.SourceTextModule(fs.readFileSync('google-sync.js', 'utf8'), {
    context,
    identifier: 'google-sync.js'
  });
  await sync.link(specifier => {
    if (specifier === './database.js') return database;
    throw new Error(`Import inesperado em google-sync.js: ${specifier}`);
  });
  await sync.evaluate();
  return { sync: sync.namespace, requests };
}

const occurrence = {
  occurrenceId: 'occ-1',
  idRota: '1',
  data: '2026-09-18',
  cliente: 'Cliente A',
  roteiro: 'R1',
  intercorrencia: 'Acesso bloqueado'
};

test('consulta o endpoint API 11 e preserva o contrato valido', async () => {
  const quality = { invalidDates: 0, missingRouteIds: 0, legacyIds: 0, excludedRecords: 0 };
  const { sync, requests } = await loadSyncModule([{
    ok: true,
    apiVersion: 11,
    source: 'intercorrenciasAtuais',
    generatedAt: '2026-09-18T15:00:00.000Z',
    data: [occurrence],
    quality
  }]);

  const result = await sync.getIntercorrenciasAtuais();

  assert.equal(result.ok, true);
  assert.equal(result.data[0].occurrenceId, 'occ-1');
  assert.equal(result.generatedAt, '2026-09-18T15:00:00.000Z');
  assert.equal(requests[0], 'https://gas.example/exec?action=intercorrenciasAtuais');
});

test('rejeita explicitamente API antiga, fonte errada, data ausente e ocorrencia incompleta', async () => {
  const { sync } = await loadSyncModule([
    { ok: true, apiVersion: 10, source: 'intercorrenciasAtuais', data: [occurrence] },
    { ok: true, apiVersion: 11, source: 'outraFonte', data: [occurrence] },
    { ok: true, apiVersion: 11, source: 'intercorrenciasAtuais' },
    {
      ok: true,
      apiVersion: 11,
      source: 'intercorrenciasAtuais',
      data: [{ ...occurrence, occurrenceId: '' }]
    }
  ]);

  const old = await sync.getIntercorrenciasAtuais();
  assert.equal(old.ok, false);
  assert.match(old.error, /API 11/);

  const wrongSource = await sync.getIntercorrenciasAtuais();
  assert.equal(wrongSource.ok, false);
  assert.match(wrongSource.error, /API 11/);

  const missingData = await sync.getIntercorrenciasAtuais();
  assert.equal(missingData.ok, false);
  assert.match(missingData.error, /data ausente/);

  const incomplete = await sync.getIntercorrenciasAtuais();
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /ocorr.*incompleta/i);
});

test('sem URL retorna erro explicito sem consultar a rede', async () => {
  const { sync, requests } = await loadSyncModule([], '');

  const result = await sync.getIntercorrenciasAtuais();

  assert.deepEqual({ ok: result.ok, error: result.error }, {
    ok: false,
    error: 'URL do GAS não configurada'
  });
  assert.equal(requests.length, 0);
});

for (const invalid of [null, false, 0, '']) {
  test(`rejeita ocorrência falsy ${JSON.stringify(invalid)} mesmo após item válido`, async () => {
    const { sync } = await loadSyncModule([{ ok: true, apiVersion: 11,
      source: 'intercorrenciasAtuais', data: [occurrence, invalid] }]);
    const result = await sync.getIntercorrenciasAtuais();
    assert.equal(result.ok, false);
    assert.match(result.error, /ocorr.*incompleta/i);
  });
}
