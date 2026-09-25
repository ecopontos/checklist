const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function harness({ setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  const storage = new Map();
  const requests = [];
  let response = null;
  let httpResponse = null;
  const context = vm.createContext({
    console, Date, Math, JSON, Object, Array, Number, String, Boolean, Error,
    Map, Set, Uint8Array, TextEncoder, TextDecoder, AbortController,
    setTimeout: setTimeoutFn, clearTimeout: clearTimeoutFn,
    atob, crypto: require('node:crypto').webcrypto,
    window: { APP_CONFIG: { gasUrl: 'https://gas.example/exec' } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    fetch: async (url, options) => {
      requests.push(url);
      if (typeof httpResponse === 'function') return httpResponse(url, options);
      if (httpResponse) return httpResponse;
      if (response instanceof Error) throw response;
      return { ok: true, json: async () => response };
    },
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    })
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync('vendor/papaparse.min.js', 'utf8'), context);
  const cache = new Map();
  async function load(filename) {
    const mod = new vm.SourceTextModule(fs.readFileSync(filename, 'utf8'), { context, identifier: filename });
    cache.set(filename, mod);
    await mod.link(specifier => cache.get(specifier.replace(/^\.\//, '')));
    await mod.evaluate();
    return mod.namespace;
  }
  const database = await load('database.js');
  const sync = await load('google-sync.js');
  await database.default.init();
  return {
    db: database.default, sync, storage, requests,
    respond: value => { response = value; },
    respondHttp: value => { httpResponse = value; }
  };
}

const csv = [
  'Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP;Complemento;Telefone1;Telefone2;Tipo de Resíduo',
  'SAT01-1;3;0;1,00;SAT01;CEPON;Rodovia Admar Gonzaga;655,00;88034001;;;;Recicláveis Orgânico (Restos de Alimentos)',
  'SAT01-16;13;1;16,00;SAT01;MIRABELLO, COND.;Rua Coronel Luiz Caldeira;149,00;88034110;;48991011666,00;;Recicláveis Orgânico (Restos de Alimentos)'
].join('\r\n');

test('importa o CSV do Drive mesmo com marcador anterior do Sheets', async () => {
  const h = await harness();
  h.storage.set('app3_last_drive_sync', '2099-01-01T00:00:00Z');
  h.respond({ ok: true, apiVersion: 12, source: 'drive-csv', content: csv,
    modifiedTime: '2026-09-25T10:00:00.000Z' });

  const result = await h.sync.checkAndImportRoteiros(h.db);
  assert.equal(h.requests[0], 'https://gas.example/exec?action=roteirosCsv');
  assert.equal(result.updated, true);
  assert.equal(result.clientes, 2);
  assert.equal(h.db.getClienteByIdRota('3').logradouro, 'Rodovia Admar Gonzaga');
  assert.equal(h.db.getClienteByIdRota('3').numero, '655');
  assert.equal(h.db.getClienteByIdRota('13').ativo, 0);
  assert.equal(h.db.getRoteiros().find(route => route.nome === 'SAT01').tipo_residuo,
    'Recicláveis Orgânico (Restos de Alimentos)');
  assert.equal(h.storage.get('app3_last_roteiros_csv_drive_sync'), '2026-09-25T10:00:00.000Z');
  assert.match(h.sync.getLastRoteirosDriveSyncLabel(), /Dados atualizados em/);

  h.db.db.run("UPDATE clientes SET cliente = 'Edição local' WHERE id_rota = '3'");
  assert.equal((await h.sync.checkAndImportRoteiros(h.db)).updated, false);
  assert.equal(h.db.getClienteByIdRota('3').cliente, 'Edição local');
});

test('recusa resposta de roteiros do Sheets ou GAS antigo e preserva o cadastro', async () => {
  const h = await harness();
  h.db.addRoteiro('LOCAL');
  h.respond({ ok: true, apiVersion: 11, rows: [{ Roteiro: 'REMOTO', Cliente: 'Outro', idRota: '9', Ordem: 1 }],
    modifiedTime: '2026-09-25T10:00:00.000Z' });

  const result = await h.sync.checkAndImportRoteiros(h.db);
  assert.equal(result.updated, false);
  assert.match(result.error, /CSV|GAS|versão/i);
  assert.deepEqual(h.db.getRoteiros().map(route => route.nome), ['LOCAL']);
  assert.equal(h.storage.has('app3_last_roteiros_csv_drive_sync'), false);
});

test('explica o 404 no redirecionamento do Google sem expor a URL temporaria', async () => {
  const h = await harness();
  h.db.addRoteiro('LOCAL');
  h.respondHttp({
    ok: false,
    status: 404,
    redirected: true,
    url: 'https://script.googleusercontent.com/macros/echo?user_content_key=segredo'
  });

  const result = await h.sync.checkAndImportRoteiros(h.db);

  assert.equal(result.updated, false);
  assert.equal(h.requests.length, 3);
  assert.match(result.error, /HTTP 404/);
  assert.match(result.error, /script\.googleusercontent\.com/);
  assert.match(result.error, /3 tentativas/);
  assert.doesNotMatch(result.error, /segredo|user_content_key/);
  assert.deepEqual(h.db.getRoteiros().map(route => route.nome), ['LOCAL']);
});

test('encerra a leitura do CSV quando as tres tentativas ficam penduradas', async () => {
  const h = await harness({
    setTimeoutFn: fn => { setImmediate(fn); return 1; },
    clearTimeoutFn: () => {}
  });
  h.respondHttp((url, options) => new Promise((resolve, reject) => {
    options?.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }));

  const result = await Promise.race([
    h.sync.checkAndImportRoteiros(h.db),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('consulta sem timeout')), 100))
  ]);

  assert.equal(result.updated, false);
  assert.equal(h.requests.length, 3);
  assert.match(result.error, /tempo esgotado/i);
  assert.match(result.error, /3 tentativas/);
});

test('encerra a leitura quando o corpo JSON fica pendurado apos os cabecalhos', async () => {
  const h = await harness({
    setTimeoutFn: fn => { setImmediate(fn); return 1; },
    clearTimeoutFn: () => {}
  });
  h.respondHttp((url, options) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })
  }));

  const result = await Promise.race([
    h.sync.checkAndImportRoteiros(h.db),
    new Promise((resolve, reject) => setTimeout(() => reject(new Error('corpo sem timeout')), 100))
  ]);

  assert.equal(result.updated, false);
  assert.equal(h.requests.length, 3);
  assert.match(result.error, /tempo esgotado/i);
});
