const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = vm.createContext({
  console, JSON, Date, Number, String, Boolean, Array, Object, Math, isNaN
});
vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

// Matrizes como getValues() devolveria (linha 0 = cabeçalho).
const rotas = [
  ['idRota', 'idPJ', 'idRoteiro', 'Ordem', 'Inativo'],
  ['3', '100', '10', '1,00', 0],   // ok
  ['6', '101', '10', '5,00', 0],   // ok, mesmo roteiro
  ['7', '999', '10', '6,00', 0],   // idPJ sem cliente -> skipped
  ['8', '102', '20', '2,00', 1]    // outro roteiro, inativo=1
];
const clientes = [
  ['idPJ', 'idUnico2', 'Cliente', 'logradouro', 'Número', 'CEP', 'Complemento', 'Telefone1', 'Telefone2'],
  ['100', 'U-100', 'CEPON', 'Rodovia Admar Gonzaga', '655,00', 88034001, '', '', ''],
  ['101', 'U-101', 'BIARRITZ', 'Rua Pastor', '504,00', 88034100, '', 48984097003, ''],
  ['102', 'U-102', 'VILLA', 'Rua Pastor', '655,00', 88034100, 'fundos', '', ''],
  ['103', '', 'SEM IDUNICO', 'Rua X', '10', 88000000, '', '', '']  // sem idUnico2, nunca referenciado
];
const roteiros = [
  ['idRoteiro', 'Roteiro'],
  ['10', 'SAT01'],
  ['20', 'SAT02']
];

const out = context.buildRoteirosNormalizados_(rotas, clientes, roteiros);

assert.strictEqual(out.skipped, 1, 'ponto com idPJ sem cliente deve entrar em skipped');

assert.strictEqual(out.clientes.length, 3, 'só clientes referenciados por pontos válidos');
const cep = out.clientes.find(c => c.idUnico === 'U-100');
assert.ok(cep, 'cliente U-100 presente');
assert.strictEqual(cep.uuid, null, 'uuid reservado sempre null na v1');
assert.strictEqual(cep.cliente, 'CEPON');
assert.strictEqual(cep.logradouro, 'Rodovia Admar Gonzaga', 'logradouro emitido quando a coluna existe');
assert.strictEqual(cep.numero, '655', 'número limpo do ",00"');
assert.strictEqual(cep.cep, '88034001', 'cep limpo do ".0"');

const biarritz = out.clientes.find(c => c.idUnico === 'U-101');
assert.strictEqual(biarritz.telefone1, '48984097003', 'telefone limpo do artefato ,00/.0');

assert.strictEqual(out.roteiros.length, 2);
const sat01 = out.roteiros.find(r => r.roteiro === 'SAT01');
assert.strictEqual(sat01.pontos.length, 2, 'SAT01 tem 2 pontos válidos');
assert.ok(!('tipoResiduo' in sat01), 'resíduo não faz parte do contrato GAS');
const p3 = sat01.pontos.find(p => p.idRota === '3');
assert.strictEqual(p3.idUnico, 'U-100', 'FK do ponto resolve para clientes[]');
assert.strictEqual(p3.ordem, 1, 'ordem numérica convertida de "1,00"');
assert.strictEqual(p3.inativo, 0);

const sat02 = out.roteiros.find(r => r.roteiro === 'SAT02');
assert.strictEqual(sat02.pontos[0].inativo, 1, 'inativo=1 preservado');

const idsClientes = new Set(out.clientes.map(c => c.idUnico));
out.roteiros.forEach(r => r.pontos.forEach(p => {
  assert.ok(idsClientes.has(p.idUnico), 'ponto ' + p.idRota + ' referencia cliente inexistente');
}));

// logradouro ausente na aba -> "" (leitura defensiva)
const clientesSemLograd = [
  ['idPJ', 'idUnico2', 'Cliente', 'Número', 'CEP', 'Complemento', 'Telefone1', 'Telefone2'],
  ['100', 'U-100', 'CEPON', '655,00', 88034001, '', '', '']
];
const rotasMin = [
  ['idRota', 'idPJ', 'idRoteiro', 'Ordem', 'Inativo'],
  ['3', '100', '10', '1,00', 0]
];
const out2 = context.buildRoteirosNormalizados_(rotasMin, clientesSemLograd, roteiros);
assert.strictEqual(out2.clientes[0].logradouro, '', 'logradouro vira "" quando a coluna não existe');

console.log('buildRoteirosNormalizados_: dedup, FK, skipped, limpeza, logradouro defensivo: OK');

// --- Envelope via doGet(action=roteiros) ---
function sheetMock(rows) {
  return { getDataRange: () => ({ getValues: () => rows }) };
}
const sheetsMap = new Map([
  ['tblRotas', sheetMock(rotas)],
  ['shtClientes', sheetMock(clientes)],
  ['tblRoteiros', sheetMock(roteiros)]
]);
context.PropertiesService = {
  getScriptProperties: () => ({ getProperty: k => ({ SPREADSHEET_ID: 'sheet-test' })[k] || '' })
};
context.SpreadsheetApp = { openById: () => ({ getSheetByName: n => sheetsMap.get(n) || null }) };
context.DriveApp = { getFileById: () => ({ getLastUpdated: () => new Date('2026-09-15T12:00:00Z') }) };
context.ContentService = {
  MimeType: { JSON: 'json' },
  createTextOutput: value => ({ value, setMimeType() { return this; } })
};

const resp = JSON.parse(context.doGet({ parameter: { action: 'roteiros' } }).value);
assert.strictEqual(resp.ok, true);
assert.strictEqual(resp.contract, 'roteiros/v1');
assert.strictEqual(resp.apiVersion, 15, 'apiVersion deve ter subido para 15');
assert.strictEqual(resp.modifiedTime, '2026-09-15T12:00:00.000Z');
assert.strictEqual(resp.counts.clientes, 3);
assert.strictEqual(resp.counts.roteiros, 2);
assert.strictEqual(resp.counts.pontos, 3);
assert.strictEqual(resp.skipped, 1);
assert.ok(Array.isArray(resp.clientes) && Array.isArray(resp.roteiros));
assert.strictEqual(resp.clientes[0].uuid, null);

// default (sem action) também cai no snapshot normalizado
const respDefault = JSON.parse(context.doGet({ parameter: {} }).value);
assert.strictEqual(respDefault.contract, 'roteiros/v1');

console.log('doGet(action=roteiros): envelope roteiros/v1, counts, apiVersion 15: OK');
