const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

class RangeMock {
  constructor(sheet, row, column, rows, columns) {
    Object.assign(this, { sheet, row, column, rows, columns });
  }
  getValues() {
    return Array.from({ length: this.rows }, (_, rowOffset) =>
      Array.from({ length: this.columns }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
      )
    );
  }
  setValues(values) {
    values.forEach((rowValues, rowOffset) => {
      const rowIndex = this.row - 1 + rowOffset;
      this.sheet.rows[rowIndex] ||= [];
      rowValues.forEach((value, columnOffset) => {
        this.sheet.rows[rowIndex][this.column - 1 + columnOffset] = value;
      });
    });
    return this;
  }
  setValue(value) {
    this.sheet.rows[this.row - 1] ||= [];
    this.sheet.rows[this.row - 1][this.column - 1] = value;
    return this;
  }
}

class SheetMock {
  constructor() { this.rows = []; }
  getRange(row, column, rows = 1, columns = 1) {
    return new RangeMock(this, row, column, rows, columns);
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((max, row) => Math.max(max, row.length), 0); }
  setFrozenRows() {}
}

const sheets = new Map();
const spreadsheet = {
  getSheetByName: name => sheets.get(name) || null,
  insertSheet: name => {
    const sheet = new SheetMock();
    sheets.set(name, sheet);
    return sheet;
  }
};

const context = vm.createContext({
  console, JSON, Date, Number, String, Boolean, Array, Object, Math, isNaN,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: key => ({
        SPREADSHEET_ID: 'spreadsheet-test',
        ROUTE_CHANGES_TOKEN: 'token-route-changes-test'
      })[key] || ''
    })
  },
  SpreadsheetApp: { openById: () => spreadsheet },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: {
    MimeType: { JSON: 'json', TEXT: 'text' },
    createTextOutput: value => ({
      value, mimeType: '',
      setMimeType(mimeType) { this.mimeType = mimeType; return this; }
    })
  }
});

vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

function post(body) {
  return context.doPost({ postData: { contents: JSON.stringify(body) } });
}

// shtClientes simulada. Cabecalho com os campos editaveis + a chave idUnico2.
const shtClientes = new SheetMock();
shtClientes.rows = [
  ['idUnico2', 'Cliente', 'Número', 'Complemento', 'CEP', 'Telefone1', 'Telefone2'],
  ['uuid-0001', 'CLIENTE A', '10', '', '88000000', '', ''],
  ['uuid-0002', 'CLIENTE B', '20', '', '88010000', '', '']
];
sheets.set('shtClientes', shtClientes);

// Envia alteracoes de campos de cliente (subprojeto B).
const changes = [
  {
    change_id: 'cli_0001',
    id_cliente: 'uuid-0001',
    campos: { 'Número': '123', Telefone1: '48999990000' },
    alterado_em: new Date(2026, 7, 12, 10, 0, 0).toISOString(),
    origem: 'device_test'
  },
  {
    change_id: 'cli_0002',
    id_cliente: 'uuid-0002',
    campos: { Cliente: 'CLIENTE B RENOMEADO' },
    alterado_em: new Date(2026, 7, 12, 10, 0, 1).toISOString(),
    origem: 'device_test'
  },
  {
    change_id: 'cli_0003',
    id_cliente: 'uuid-inexistente',
    campos: { CEP: '99999999' },
    alterado_em: new Date(2026, 7, 12, 10, 0, 2).toISOString(),
    origem: 'device_test'
  }
];

const saved = JSON.parse(post({ action: 'clientChanges', token: 'token-route-changes-test', changes }).value);
assert.strictEqual(saved.ok, true);
assert.strictEqual(saved.acceptedIds.length, 3);
assert.strictEqual(saved.skippedApply, 1); // uuid-inexistente

// Aplicou so os campos enviados, por UUID.
// rows[1] = uuid-0001: Número(col2)=123, Telefone1(col5)=48999990000; Complemento/CEP intactos.
assert.strictEqual(shtClientes.rows[1][2], '123');
assert.strictEqual(shtClientes.rows[1][5], '48999990000');
assert.strictEqual(shtClientes.rows[1][4], '88000000'); // CEP nao tocado
// rows[2] = uuid-0002: Cliente(col1) renomeado; Número(col2) intacto.
assert.strictEqual(shtClientes.rows[2][1], 'CLIENTE B RENOMEADO');
assert.strictEqual(shtClientes.rows[2][2], '20');

// Idempotencia: reenviar os mesmos change_id -> duplicados, sem reaplicar.
const again = JSON.parse(post({ action: 'clientChanges', token: 'token-route-changes-test', changes }).value);
assert.strictEqual(again.ok, true);
assert.strictEqual(again.acceptedIds.length, 0);
assert.strictEqual(again.duplicateIds.length, 3);

// Token invalido e recusado.
const denied = JSON.parse(post({ action: 'clientChanges', token: 'errado', changes: [] }).value);
assert.strictEqual(denied.ok, false);

console.log('Alteracoes de cliente aplicadas em shtClientes (campos enviados + skippedApply + idempotencia): OK');
