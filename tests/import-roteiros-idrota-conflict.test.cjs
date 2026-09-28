const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Regressao: o export do Access as vezes traz o mesmo idRota em duas linhas
// divergindo SO no telefone (mesma ordem/roteiro/cliente/logradouro). Antes,
// o import abortava o CSV inteiro (throw "Conflito no idRota duplicado"),
// derrubando todos os pontos por causa de um telefone. Agora deve aplicar
// last-wins (a estrutura da rota e identica) e apenas REPORTAR os idRotas
// conflitantes para revisao na origem.
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
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'vendor', 'papaparse.min.js'), 'utf8'), context);
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

  const header = 'Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP;Telefone1;Telefone2';
  const csv = [
    header,
    // idRota 421 duplicado: identico exceto Telefone1/Telefone2 (o caso real)
    'SV04-224;421;0;224,00;SV04;UNCLE JOES;Avenida Madre Benvenuta;1167,00;88000000;48111112222;',
    'SV04-224;421;0;224,00;SV04;UNCLE JOES;Avenida Madre Benvenuta;1167,00;88000000;48333334444;0',
    // ponto normal, sem duplicata
    'SV04-225;500;0;225,00;SV04;OUTRO CLIENTE;Rua B;10,00;88000001;48999990000;'
  ].join('\r\n');

  // 1) NAO deve lançar.
  let result;
  assert.doesNotThrow(() => { result = db.importRoteirosCsv(csv); },
    'import com idRota duplicado divergente nao deve abortar');

  // 2) Deve reportar o idRota conflitante (para revisao na origem).
  assert.ok(Array.isArray(result.conflitosIdRota), 'result deve ter conflitosIdRota (array)');
  // spread para o realm principal: result vem do realm do vm e deepStrictEqual
  // reprova por prototipo, nao por conteudo.
  assert.deepStrictEqual([...result.conflitosIdRota], ['421'],
    'apenas o idRota 421 conflita');

  // 3) last-wins: a ultima linha (Telefone1 ...4444) vence.
  const cliente = db.getClienteByIdRota('421');
  assert.ok(cliente, 'cliente do idRota 421 deve ter sido importado');
  assert.strictEqual(String(cliente.telefone1), '48333334444',
    'last-wins: telefone da ultima linha do idRota 421');

  // 4) O ponto sem conflito importa normalmente.
  const outro = db.getClienteByIdRota('500');
  assert.ok(outro, 'ponto 500 (sem conflito) deve ser importado');
  assert.strictEqual(result.clientes, 2, 'dois pontos distintos importados (421 e 500)');

  console.log('import roteiros: idRota duplicado divergente -> last-wins + conflitosIdRota, sem abortar: OK');
})().catch(err => { console.error(err); process.exit(1); });
