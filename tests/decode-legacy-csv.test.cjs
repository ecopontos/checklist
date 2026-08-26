const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createContext() {
  const context = vm.createContext({
    console, globalThis: null,
    Uint8Array, TextEncoder, TextDecoder,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    setTimeout, clearTimeout,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    }),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
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
  const { decodeLegacyCsvBytes } = databaseModule;

  // UTF-16LE com BOM (formato real do export do Access). O TextDecoder
  // remove o BOM ao decodificar — o texto final nao deve comeca-lo.
  const utf16leBuffer = new Uint8Array(Buffer.from('﻿Fonte;idRota', 'utf16le')).buffer;
  assert.strictEqual(decodeLegacyCsvBytes(utf16leBuffer), 'Fonte;idRota');

  // UTF-8 sem BOM.
  const utf8Buffer = new Uint8Array(Buffer.from('Fonte;idRota', 'utf8')).buffer;
  assert.strictEqual(decodeLegacyCsvBytes(utf8Buffer), 'Fonte;idRota');

  // CSV sintético equivalente ao export real do Access (UTF-16LE com BOM,
  // acentos e cedilha) — não depende do arquivo legado/*.csv real (gitignored,
  // dado de cliente real, não deve ser commitado nem existir em CI).
  const syntheticCsv = [
    'Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP',
    'SAT01-1;3;0;1,00;SAT01;CEPON;Rodovia Admar Gonzaga;655,00;88034001',
    'SAT01-2;6;0;2,00;SAT01;HOSPITAL GOVERNADOR CELSO RAMOS;Avenida Professor Othon Gama D\'Eça;0,00;88015240'
  ].join('\r\n');
  const syntheticBuffer = new Uint8Array(Buffer.from('﻿' + syntheticCsv, 'utf16le')).buffer;
  const decodedSynthetic = decodeLegacyCsvBytes(syntheticBuffer);
  assert.ok(decodedSynthetic.startsWith('Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;'));
  assert.ok(decodedSynthetic.includes('Avenida Professor Othon Gama D\'Eça'));

  console.log('decodeLegacyCsvBytes (UTF-16LE com BOM, UTF-8 sem BOM, CSV real do Access): OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
