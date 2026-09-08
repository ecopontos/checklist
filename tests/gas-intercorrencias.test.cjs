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
}

class SheetMock {
  constructor() { this.rows = []; }
  getRange(row, column, rows = 1, columns = 1) {
    return new RangeMock(this, row, column, rows, columns);
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((max, row) => Math.max(max, row.length), 0); }
}

const sheets = new Map();
const spreadsheet = {
  getSheetByName: name => sheets.get(name) || null
};

const cacheStore = new Map();

const context = vm.createContext({
  console,
  JSON,
  Date,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Math,
  isNaN,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: key => ({ SPREADSHEET_ID: 'spreadsheet-test' })[key] || ''
    })
  },
  SpreadsheetApp: { openById: () => spreadsheet },
  CacheService: {
    getScriptCache: () => ({
      get: key => cacheStore.has(key) ? cacheStore.get(key) : null,
      put: (key, value) => { cacheStore.set(key, value); }
    })
  },
  ContentService: {
    MimeType: { JSON: 'json', TEXT: 'text' },
    createTextOutput: value => ({
      value,
      mimeType: '',
      setMimeType(mimeType) { this.mimeType = mimeType; return this; }
    })
  }
});

vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

const HEADER = ['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID'];
const coletasSheet = new SheetMock();
coletasSheet.rows = [HEADER];
coletasSheet.rows.push(['1', '2026-08-01', 'CLIENTE 1', 'ROTA X', 5, '', '', '']);
coletasSheet.rows.push(['1', '2026-09-01', 'CLIENTE 1', 'ROTA X', 3, 'Bombona suja', '', '']);
coletasSheet.rows.push(['2', '2026-09-02', 'CLIENTE 2', 'ROTA X', 0, 'Recusou coleta', '', '']);
coletasSheet.rows.push(['3', '2026-08-15', 'CLIENTE 3', 'ROTA X', 2, 'Vazamento', '', '']);
coletasSheet.rows.push(['3', '2026-09-03', 'CLIENTE 3', 'ROTA X', 4, '', '', '']);
coletasSheet.rows.push(['4', '2026-09-01', 'CLIENTE 4', 'ROTA Y', 1, 'Problema em outro roteiro', '', '']);
sheets.set('Coletas', coletasSheet);

const result = JSON.parse(context.doGet({ parameter: { action: 'intercorrenciasRoteiro', roteiro: 'ROTA X' } }).value);

assert.strictEqual(result.ok, true);
assert.strictEqual(result.data.length, 2, 'so cliente 1 (ultima coleta com intercorrencia) e cliente 2 (quantidade 0 nao filtra) devem aparecer');

const cliente1 = result.data.find(item => item.id_rota === '1');
assert.ok(cliente1, 'cliente 1 deve aparecer (ultima coleta, 2026-09-01, tem intercorrencia)');
assert.strictEqual(cliente1.intercorrencia, 'Bombona suja');
assert.strictEqual(cliente1.data, '2026-09-01');

const cliente2 = result.data.find(item => item.id_rota === '2');
assert.ok(cliente2, 'cliente 2 deve aparecer mesmo com quantidade 0 na ultima coleta');
assert.strictEqual(cliente2.intercorrencia, 'Recusou coleta');

assert.ok(!result.data.some(item => item.id_rota === '3'), 'cliente 3: ultima coleta (2026-09-03) esta sem intercorrencia, mesmo tendo tido uma antes -> nao deve aparecer');
assert.ok(!result.data.some(item => item.id_rota === '4'), 'cliente 4 e de outro roteiro (ROTA Y) -> nao deve aparecer na consulta de ROTA X');

console.log('intercorrenciasRoteiro: pega so a ultima coleta de cada cliente, ignora quantidade, filtra por roteiro: OK');
