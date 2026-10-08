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

// --- Correções da revisão da v15 ---
{
  const cab = ['idPJ', 'idUnico2', 'Cliente', 'logradouro', 'Número', 'CEP', 'Complemento', 'Telefone1', 'Telefone2'];
  const rotasCab = ['idRota', 'idPJ', 'idRoteiro', 'Ordem', 'Inativo'];
  const rots = [['idRoteiro', 'Roteiro'], ['10', 'SAT01']];

  // Ponto com idRoteiro inexistente: descartado e contado, sem grupo de nome vazio.
  const semRoteiro = context.buildRoteirosNormalizados_(
    [rotasCab, ['1', '100', '10', 1, 0], ['2', '101', '99', 2, 0]],
    [cab, ['100', 'U-1', 'A', 'Rua A', '1', '', '', '', ''], ['101', 'U-2', 'B', 'Rua B', '2', '', '', '', '']],
    rots);
  assert.strictEqual(semRoteiro.roteiros.length, 1);
  assert.ok(!semRoteiro.roteiros.some(r => r.roteiro === ''), 'nenhum grupo de roteiro sem nome');
  assert.strictEqual(semRoteiro.skipped, 1);
  assert.strictEqual(semRoteiro.skippedDetalhe.semRoteiro, 1);
  assert.ok(!semRoteiro.clientes.some(c => c.idUnico === 'U-2'), 'cliente só usado pelo ponto descartado não entra');

  // idUnico2 repetido com dados diferentes: pontos dos dois descartados e reportados.
  const conflito = context.buildRoteirosNormalizados_(
    [rotasCab, ['1', '100', '10', 1, 0], ['2', '101', '10', 2, 0], ['3', '102', '10', 3, 0]],
    [cab, ['100', 'U-1', 'A', 'Rua A', '1', '', '', '', ''], ['101', 'U-1', 'C (outro cliente)', 'Rua C', '3', '', '', '', ''],
      ['102', 'U-3', 'D', 'Rua D', '4', '', '', '', '']],
    rots);
  assert.deepStrictEqual([...conflito.conflitosIdUnico], ['U-1']);
  assert.strictEqual(conflito.skippedDetalhe.idUnicoConflitante, 2);
  assert.deepStrictEqual([...conflito.roteiros[0].pontos.map(p => p.idRota)], ['3'], 'só o ponto sem conflito fica');
  assert.ok(!conflito.clientes.some(c => c.idUnico === 'U-1'), 'cliente em conflito não é emitido com dados de um dos dois');

  // Cópia idêntica do mesmo cliente (idPJ diferentes, mesmos dados): não é conflito.
  const copia = context.buildRoteirosNormalizados_(
    [rotasCab, ['1', '100', '10', 1, 0], ['2', '101', '10', 2, 0]],
    [cab, ['100', 'U-1', 'A', 'Rua A', '1', '', '', '', ''], ['101', 'U-1', 'A', 'Rua A', '1', '', '', '', '']],
    rots);
  assert.strictEqual(copia.conflitosIdUnico.length, 0);
  assert.strictEqual(copia.roteiros[0].pontos.length, 2);
  assert.strictEqual(copia.clientes.length, 1);

  // Linha de cliente não usada por nenhum ponto não gera conflito.
  const orfa = context.buildRoteirosNormalizados_(
    [rotasCab, ['1', '100', '10', 1, 0]],
    [cab, ['100', 'U-1', 'A', 'Rua A', '1', '', '', '', ''], ['101', 'U-1', 'Outro', 'Rua X', '9', '', '', '', '']],
    rots);
  assert.strictEqual(orfa.conflitosIdUnico.length, 0);
  assert.strictEqual(orfa.roteiros[0].pontos.length, 1);

  console.log('buildRoteirosNormalizados_: roteiro inexistente e idUnico2 conflitante: OK');
}

{
  const envelope = JSON.parse(context.doGet({ parameter: { action: 'roteiros' } }).value);
  assert.deepStrictEqual({ ...envelope.skippedDetalhe }, { semCliente: 1, semRoteiro: 0, idUnicoConflitante: 0 });
  assert.ok(Array.isArray(envelope.conflitosIdUnico) && envelope.conflitosIdUnico.length === 0);
  console.log('doGet(action=roteiros): skippedDetalhe e conflitosIdUnico no envelope: OK');
}
