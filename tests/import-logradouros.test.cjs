const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Backfill pontual de logradouro a partir do CSV legado do Access, casado
// por id_rota. Precisa NAO tocar em campos que ja vem do Sheets
// (complemento, telefones, ordem, ativo, id_cliente).
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

  db.addRoteiro('ROTA_X');
  const roteiroId = db.getRoteiros().find(r => r.nome === 'ROTA_X').id;

  // Cliente ja sincronizado via Sheets (complemento/telefone preenchidos) —
  // o backfill de logradouro nao pode apagar isso.
  db.upsertCliente({
    idRota: '999',
    idCliente: 'uuid-abc',
    Cliente: 'CLIENTE JA SINCRONIZADO',
    logradouro: '',
    'Número': '50',
    Complemento: 'Bloco B',
    CEP: '88000000',
    Telefone1: '48999998888',
    Telefone2: '',
    roteiro_id: roteiroId,
    Ordem: 3,
    ativo: true
  });

  const csv = [
    'Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP',
    'X-1;999;0;99,00;ROTA_ANTIGA;CLIENTE JA SINCRONIZADO;Rua Legado;50,00;88000000',
    'X-2;12345;0;1,00;ROTA_ANTIGA;CLIENTE INEXISTENTE NO APP;Rua Fantasma;1,00;88000000',
    'X-3;999999;0;1,00;ROTA_ANTIGA;SEM LOGRADOURO;;1,00;88000000'
  ].join('\r\n');

  const result = db.importLogradourosCsv(csv);

  const cliente = db.getClienteByIdRota('999');
  assert.strictEqual(cliente.logradouro, 'Rua Legado');
  assert.strictEqual(cliente.complemento, 'Bloco B');
  assert.strictEqual(cliente.telefone1, '48999998888');
  assert.strictEqual(String(cliente.ordem), '3');
  assert.strictEqual(cliente.id_cliente, 'uuid-abc');
  assert.strictEqual(cliente.ativo, 1);

  assert.strictEqual(result.updated, 1);
  assert.strictEqual(result.semCorrespondencia, 1);
  assert.strictEqual(result.semLogradouro, 1);
  assert.strictEqual(result.total, 3);

  console.log('Backfill de logradouro via CSV legado (so atualiza logradouro, preserva demais campos): OK');

  // Um resync de roteiros via Sheets (sem coluna Logradouro) nao pode apagar
  // o logradouro recem-preenchido pelo backfill do CSV legado.
  db.importRoteirosRows([{
    Roteiro: 'ROTA_ANTIGA',
    idRota: '999',
    idCliente: 'uuid-abc',
    Cliente: 'CLIENTE JA SINCRONIZADO',
    Número: '50',
    Complemento: 'Bloco B',
    CEP: '88000000',
    Telefone1: '48999998888',
    Telefone2: '',
    Ordem: 3,
    Inativo: 0
  }]);

  const clienteAposResync = db.getClienteByIdRota('999');
  assert.strictEqual(clienteAposResync.logradouro, 'Rua Legado');

  console.log('Resync de roteiros via Sheets preserva logradouro do backfill: OK');

  // Rota nova (id_rota 12345, "sem correspondencia" no import acima porque o
  // cliente ainda nao existia localmente): quando o Sheets sincroniza essa
  // rota pela primeira vez, depois do import do CSV, o logradouro legado
  // precisa ser aplicado mesmo assim — a ordem entre os dois nao pode importar.
  db.importRoteirosRows([{
    Roteiro: 'ROTA_ANTIGA',
    idRota: '12345',
    idCliente: 'uuid-nova-rota',
    Cliente: 'CLIENTE INEXISTENTE NO APP',
    Número: '1',
    Complemento: '',
    CEP: '88000000',
    Telefone1: '',
    Telefone2: '',
    Ordem: 1,
    Inativo: 0
  }]);

  const clienteRotaNova = db.getClienteByIdRota('12345');
  assert.strictEqual(clienteRotaNova.logradouro, 'Rua Fantasma');

  console.log('Backfill legado se aplica a cliente criado depois do import do CSV (ordem nao importa): OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
