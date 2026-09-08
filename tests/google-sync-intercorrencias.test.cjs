const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createContext() {
  const storage = new Map();
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const requests = [];
  let fetchImpl = async () => { throw new Error('fetch nao deveria ser chamado neste cenario'); };
  const context = vm.createContext({
    console, localStorage, window: undefined, globalThis: null,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    AbortController,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    }),
    fetch: async (url, options) => {
      requests.push(url);
      return fetchImpl(url, options);
    }
  });
  context.globalThis = context;
  return { context, localStorage, requests, setFetchImpl: fn => { fetchImpl = fn; } };
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
  const { context, localStorage, requests, setFetchImpl } = createContext();
  await loadModule(context, 'database.js');
  const syncModule = await loadModule(context, 'google-sync.js');

  // Sem URL do GAS configurada: nao tenta chamar a rede.
  const semUrl = await syncModule.getIntercorrenciasRoteiro('ROTA X');
  assert.strictEqual(semUrl.ok, false);
  assert.strictEqual(semUrl.error, 'URL do GAS não configurada');
  assert.strictEqual(requests.length, 0, 'nao deveria ter chamado fetch sem URL configurada');

  // Com URL configurada: monta a query corretamente (roteiro com espaco
  // precisa vir url-encoded) e repassa a resposta do GAS como veio.
  localStorage.setItem('app3_gas_url', 'https://gas.example/exec');
  setFetchImpl(async () => ({
    ok: true,
    json: async () => ({ ok: true, data: [{ id_rota: '42', intercorrencia: 'Bombona suja', data: '2026-09-01' }] })
  }));

  const resultado = await syncModule.getIntercorrenciasRoteiro('ROTA CENTRO LESTE');
  assert.strictEqual(resultado.ok, true);
  assert.strictEqual(resultado.data.length, 1);
  assert.strictEqual(resultado.data[0].id_rota, '42');
  assert.strictEqual(resultado.data[0].intercorrencia, 'Bombona suja');
  assert.strictEqual(resultado.data[0].data, '2026-09-01');
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0], 'https://gas.example/exec?action=intercorrenciasRoteiro&roteiro=ROTA%20CENTRO%20LESTE');

  console.log('getIntercorrenciasRoteiro: sem URL retorna erro sem chamar fetch; com URL monta query e repassa resposta: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
