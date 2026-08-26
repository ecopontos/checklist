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
  const windowRef = { __TAURI__: undefined };
  const context = vm.createContext({
    console, localStorage, window: windowRef, globalThis: null,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout, atob,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    })
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'vendor', 'papaparse.min.js'), 'utf8'), context);
  return { context, windowRef };
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

function csvBase64(row) {
  const text = '﻿Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP\r\n' + row;
  return Buffer.from(text, 'utf16le').toString('base64');
}

(async () => {
  const { context, windowRef } = createContext();
  const databaseModule = await loadModule(context, 'database.js');
  const syncModule = await loadModule(context, 'google-sync.js');
  const db = databaseModule.default;
  await db.init();

  // Fora do app empacotado (sem window.__TAURI__): nao tenta nada.
  const semTauri = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(semTauri.checked, false);
  assert.strictEqual(semTauri.reason, 'not-tauri');

  db.addRoteiro('SAT01');
  const roteiroId = db.getRoteiros().find(r => r.nome === 'SAT01').id;
  db.upsertCliente({
    idRota: '777', idCliente: '', Cliente: 'TESTE REDE', logradouro: '',
    'Número': '10', Complemento: '', CEP: '88000000', Telefone1: '', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 1, ativo: true
  });

  // Primeira checagem: nunca sincronizado antes -> importa.
  windowRef.__TAURI__ = {
    core: {
      invoke: async cmd => {
        assert.strictEqual(cmd, 'read_network_logradouros_csv');
        return {
          bytes_base64: csvBase64('SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua da Rede;10,00;88000000'),
          modified_time_ms: 1000
        };
      }
    }
  };
  const primeira = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(primeira.checked, true);
  assert.strictEqual(primeira.updated, true);
  assert.strictEqual(db.getClienteByIdRota('777').logradouro, 'Rua da Rede');

  // Mesmo modified_time_ms -> nao reimporta.
  let invokedDeNovo = false;
  windowRef.__TAURI__.core.invoke = async () => {
    invokedDeNovo = true;
    return {
      bytes_base64: csvBase64('SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua Errada;10,00;88000000'),
      modified_time_ms: 1000
    };
  };
  const segunda = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(invokedDeNovo, true);
  assert.strictEqual(segunda.updated, false);
  assert.strictEqual(db.getClienteByIdRota('777').logradouro, 'Rua da Rede');

  // modified_time_ms maior -> reimporta de fato.
  windowRef.__TAURI__.core.invoke = async () => ({
    bytes_base64: csvBase64('SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua Nova Da Rede;10,00;88000000'),
    modified_time_ms: 2000
  });
  const terceira = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(terceira.updated, true);
  assert.strictEqual(db.getClienteByIdRota('777').logradouro, 'Rua Nova Da Rede');

  // Pasta de rede inacessivel -> erro tratado, sem lancar excecao.
  windowRef.__TAURI__.core.invoke = async () => { throw 'pasta inacessivel'; };
  const falha = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(falha.checked, true);
  assert.strictEqual(falha.updated, false);
  assert.strictEqual(falha.error, 'pasta inacessivel');

  console.log('checkAndImportLogradourosRede (not-tauri, primeira importacao, idempotencia por modified_time, falha tratada): OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
