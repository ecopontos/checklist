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

  // Teste de regressao: DDD 55 (Rio Grande do Sul) nao deve ser confundido com DDI 55 (Brasil)
  // Cliente com Telefone1 = '55991234567' (DDD 55 + 9 digitos = 11 digitos total, sem DDI)
  // deve receber '55' prefixado: '5555991234567' (DDI 55 + DDD 55 + 9 digitos)
  db.upsertCliente({
    idRota: '5', idCliente: 'c5', Cliente: 'RS CLIENTE', logradouro: 'Rua E',
    'Número': '50', Complemento: '', CEP: '95000000',
    Telefone1: '55991234567', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 5, ativo: true
  });

  const contatosComDDD55 = db.getContatosWhatsapp(roteiroId);
  const clienteRS = contatosComDDD55.find(c => c.idRota === '5');
  assert.ok(clienteRS, 'cliente com DDD 55 deve estar nos contatos');
  assert.strictEqual(
    clienteRS.telefoneDigits,
    '5555991234567',
    'DDD 55 (RS) sem DDI (11 digitos) deve receber prefixo 55: resultado esperado 5555991234567'
  );
  console.log('Regressao DDD 55: OK');

  // Teste menor: roteiroId desconhecido deve retornar contatos com roteiroNome vazio
  const contatosRoteiroDesconhecido = db.getContatosWhatsapp(99999);
  assert.strictEqual(contatosRoteiroDesconhecido.length, 0, 'roteiro desconhecido nao deve ter contatos (nenhum cliente associado)');

  // Alem disso, vamos criar um cliente com roteiro_id desconhecido para testar que
  // roteiroNome fica vazio e a funcao nao lanca erro
  db.upsertCliente({
    idRota: '6', idCliente: 'c6', Cliente: 'ORFAO', logradouro: 'Rua F',
    'Número': '60', Complemento: '', CEP: '99000000',
    Telefone1: '48988776655', Telefone2: '',
    roteiro_id: 99999, Ordem: 6, ativo: true
  });

  const contatosComRoteiroOrfao = db.getContatosWhatsapp(99999);
  assert.strictEqual(contatosComRoteiroOrfao.length, 1, 'deve retornar 1 contato mesmo com roteiro desconhecido');
  assert.strictEqual(
    contatosComRoteiroOrfao[0].roteiroNome,
    '',
    'roteiroNome deve ser string vazia quando roteiro_id nao existe'
  );
  assert.strictEqual(contatosComRoteiroOrfao[0].nome, 'ORFAO', 'nome do cliente deve estar presente mesmo com roteiro desconhecido');
  console.log('Roteiro desconhecido com fallback roteiroNome vazio: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
