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

  db.addRoteiro('CENTRO LESTE');
  const roteiroId = db.getRoteiros().find(r => r.nome === 'CENTRO LESTE').id;

  // Cliente com os dois telefones validos -> vira 2 contatos
  db.upsertCliente({
    idRota: '1', idCliente: 'c1', Cliente: 'PADARIA X', logradouro: 'Rua A',
    'Número': '10', Complemento: '', CEP: '88000000',
    Telefone1: '48991234567', Telefone2: '(48) 3333-4444',
    roteiro_id: roteiroId, Ordem: 1, ativo: true
  });

  // Cliente so com telefone1, ja com codigo de pais (13 digitos) -> nao mexe
  db.upsertCliente({
    idRota: '2', idCliente: 'c2', Cliente: 'MERCADO Y', logradouro: 'Rua B',
    'Número': '20', Complemento: '', CEP: '88000000',
    Telefone1: '5548991230000', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 2, ativo: true
  });

  // Telefone curto demais (lixo) -> descartado
  db.upsertCliente({
    idRota: '3', idCliente: 'c3', Cliente: 'SEM TELEFONE VALIDO', logradouro: 'Rua C',
    'Número': '30', Complemento: '', CEP: '88000000',
    Telefone1: '1234', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 3, ativo: true
  });

  // Cliente inativo -> nunca aparece, mesmo com telefone valido
  db.upsertCliente({
    idRota: '4', idCliente: 'c4', Cliente: 'INATIVO', logradouro: 'Rua D',
    'Número': '40', Complemento: '', CEP: '88000000',
    Telefone1: '48999998888', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 4, ativo: false
  });

  const contatos = db.getContatosWhatsapp(roteiroId);

  assert.strictEqual(contatos.length, 3, 'esperado 2 contatos da PADARIA X + 1 do MERCADO Y');

  const padaria = contatos.filter(c => c.idRota === '1');
  assert.strictEqual(padaria.length, 2);
  assert.strictEqual(padaria[0].slot, 1);
  assert.strictEqual(padaria[0].telefoneDigits, '5548991234567');
  assert.strictEqual(padaria[0].telefoneExibicao, '48991234567');
  assert.strictEqual(padaria[0].nome, 'PADARIA X');
  assert.strictEqual(padaria[0].roteiroNome, 'CENTRO LESTE');
  assert.strictEqual(padaria[1].slot, 2);
  assert.strictEqual(padaria[1].telefoneDigits, '554833334444');
  assert.strictEqual(padaria[1].telefoneExibicao, '(48) 3333-4444');

  const mercado = contatos.find(c => c.idRota === '2');
  assert.strictEqual(mercado.telefoneDigits, '5548991230000', 'nao deve mexer em telefone que ja tem 12+ digitos');

  assert.ok(!contatos.some(c => c.idRota === '3'), 'telefone com menos de 8 digitos deve ser descartado');
  assert.ok(!contatos.some(c => c.idRota === '4'), 'cliente inativo nunca deve aparecer');

  console.log('getContatosWhatsapp: filtra inativos/telefones curtos, expande telefone1+telefone2, normaliza codigo de pais: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
