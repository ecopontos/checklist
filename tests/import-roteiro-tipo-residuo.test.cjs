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
  const context = vm.createContext({
    console, localStorage, globalThis: null,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    })
  });
  context.globalThis = context;
  return context;
}

async function loadModule(context, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: filename });
  await module.link(() => { throw new Error(`Import inesperado em ${filename}`); });
  await module.evaluate();
  return module.namespace;
}

(async () => {
  const context = createContext();
  const databaseModule = await loadModule(context, 'database.js');
  const db = databaseModule.default;
  await db.init();

  // addRoteiro grava o tipo de residuo, e um segundo addRoteiro com o mesmo
  // nome ATUALIZA o valor (upsert) em vez de ser ignorado.
  db.addRoteiro('SV07', 'Vidro');
  let roteiro = db.getRoteiros().find(r => r.nome === 'SV07');
  assert.strictEqual(roteiro.tipo_residuo, 'Vidro');

  db.addRoteiro('SV07', 'Organicos');
  roteiro = db.getRoteiros().find(r => r.nome === 'SV07');
  assert.strictEqual(roteiro.tipo_residuo, 'Organicos', 'segundo addRoteiro deve atualizar o tipo de residuo (upsert, nao INSERT OR IGNORE)');

  // addRoteiro sem segundo parametro (import de CSV legado, sem essa coluna)
  // nao deve lancar erro, e deve gravar string vazia.
  db.addRoteiro('ROTA_SEM_TIPO');
  const roteiroSemTipo = db.getRoteiros().find(r => r.nome === 'ROTA_SEM_TIPO');
  assert.strictEqual(roteiroSemTipo.tipo_residuo, '');

  console.log('addRoteiro/getRoteiros: upsert de tipo_residuo por nome: OK');

  // importRoteirosRows propaga TipoResiduo da primeira linha de cada roteiro
  // unico (linhas 2 e 3 sao do mesmo roteiro SAT01).
  db.importRoteirosRows([
    { Roteiro: 'SAT01', TipoResiduo: 'Organicos', idRota: '10', idCliente: 'c10', Cliente: 'CLIENTE A', Ordem: 1, Inativo: 0 },
    { Roteiro: 'SAT01', TipoResiduo: 'Organicos', idRota: '11', idCliente: 'c11', Cliente: 'CLIENTE B', Ordem: 2, Inativo: 0 },
    { Roteiro: 'SV01', TipoResiduo: 'Vidro', idRota: '12', idCliente: 'c12', Cliente: 'CLIENTE C', Ordem: 1, Inativo: 0 }
  ]);

  const sat01 = db.getRoteiros().find(r => r.nome === 'SAT01');
  const sv01 = db.getRoteiros().find(r => r.nome === 'SV01');
  assert.strictEqual(sat01.tipo_residuo, 'Organicos');
  assert.strictEqual(sv01.tipo_residuo, 'Vidro');

  console.log('importRoteirosRows: propaga TipoResiduo por roteiro unico: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
