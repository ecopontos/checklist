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
      value,
      mimeType: '',
      setMimeType(mimeType) { this.mimeType = mimeType; return this; }
    })
  }
});

vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

function post(body) {
  return context.doPost({ postData: { contents: JSON.stringify(body) } });
}

const changes = Array.from({ length: 150 }, (_, index) => ({
  change_id: `change_${String(index + 1).padStart(4, '0')}`,
  id_rota: String(index + 1),
  inativo: 0,
  ordem: index + 1,
  roteiro: 'ROTA_TESTE',
  alterado_em: new Date(2026, 6, 27, 12, 0, index % 60).toISOString(),
  origem: 'device_test'
}));

// Aba tblRotas simulada: o subprojeto A aplica Ordem/Inativo direto aqui.
// rows[0] e o cabecalho; rows[i] corresponde a idRota i.
const rotasSheet = new SheetMock();
rotasSheet.rows = [['idRota', 'Inativo', 'Ordem']];
for (let i = 1; i <= 150; i += 1) rotasSheet.rows.push([i, false, 0]);
sheets.set('tblRotas', rotasSheet);

for (const batch of [changes.slice(0, 100), changes.slice(100)]) {
  const saved = JSON.parse(post({
    action: 'routeChanges',
    token: 'token-route-changes-test',
    changes: batch
  }).value);
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.acceptedIds.length, batch.length);
  assert.strictEqual(saved.skippedApply, 0);
}

// As alteracoes foram aplicadas na tblRotas (Ordem por idRota; Inativo booleano).
assert.strictEqual(rotasSheet.rows[1][2], 1);      // idRota 1 -> Ordem 1
assert.strictEqual(rotasSheet.rows[1][1], false);  // idRota 1 -> Inativo false
assert.strictEqual(rotasSheet.rows[150][2], 150);  // idRota 150 -> Ordem 150

const pending = post({ action: 'getRouteChanges', token: 'token-route-changes-test' });
assert.strictEqual(pending.mimeType, 'text');
assert.strictEqual(pending.value.split(/\r?\n/).length, 151);

const confirmed = JSON.parse(post({
  action: 'confirmRouteChanges',
  token: 'token-route-changes-test',
  changeIds: changes.map(change => change.change_id),
  message: 'Importado pelo Access'
}).value);
assert.strictEqual(confirmed.ok, true);
assert.strictEqual(confirmed.count, 150);

const afterConfirmation = post({
  action: 'getRouteChanges',
  token: 'token-route-changes-test'
});
assert.strictEqual(afterConfirmation.value.split(/\r?\n/).length, 1);

// idRota inexistente na tblRotas: aceita a alteracao (nao trava o outbox) e
// conta em skippedApply, sem aplicar em lugar nenhum.
const skipTest = JSON.parse(post({
  action: 'routeChanges',
  token: 'token-route-changes-test',
  changes: [{
    change_id: 'change_skip_0001',
    id_rota: '99999',
    inativo: 1,
    ordem: 5,
    roteiro: 'ROTA_TESTE',
    alterado_em: new Date(2026, 6, 27, 13, 0, 0).toISOString(),
    origem: 'device_test'
  }]
}).value);
assert.strictEqual(skipTest.ok, true);
assert.strictEqual(skipTest.acceptedIds.length, 1);
assert.strictEqual(skipTest.skippedApply, 1);

console.log('Fila GAS com 150 alterações + aplicação em tblRotas: OK');
