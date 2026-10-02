const fs = require('node:fs');
const vm = require('node:vm');

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() {
    return Array.from({ length: this.rows }, (_, r) => Array.from({ length: this.cols }, (_, c) =>
      this.sheet.rows[this.row - 1 + r]?.[this.col - 1 + c] ?? ''));
  }
  setValues(values) {
    values.forEach((v, r) => v.forEach((x, c) => {
      this.sheet.rows[this.row - 1 + r] ||= [];
      // Como o Sheets: número só vira texto se o formato '@' já estiver aplicado.
      this.sheet.rows[this.row - 1 + r][this.col - 1 + c] = this.sheet.textRows?.has(this.row + r) ? String(x) : x;
    }));
    this.sheet.writes.push({ row: this.row, rows: this.rows });
    return this;
  }
  setNumberFormat(format) {
    this.sheet.formatCalls.push({ format, writesBefore: this.sheet.writes.length });
    this.sheet.textRows ||= new Set();
    for (let r = 0; r < this.rows; r++) this.sheet.textRows.add(this.row + r);
    return this;
  }
}
class Sheet {
  constructor() { this.rows = []; this.writes = []; this.formatCalls = []; }
  getRange(r, c, rs = 1, cs = 1) { return new Range(this, r, c, rs, cs); }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  setFrozenRows() {}
}

function harness({ token = 'token-cadastro-teste-1234567890' } = {}) {
  const sheets = new Map();
  const spreadsheet = {
    getSheetByName: n => sheets.get(n) || null,
    insertSheet: n => { const s = new Sheet(); sheets.set(n, s); return s; }
  };
  const context = vm.createContext({ console, JSON, Date, Number, String, Boolean, Array, Object, Math, isFinite, isNaN,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => ({ SPREADSHEET_ID: 'ss', ROUTE_CHANGES_TOKEN: token })[k] || '' }) },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ value, setMimeType() { return this; } }) } });
  vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);
  const sync = body => JSON.parse(context.cadastroSync_({ token, ...body }).value);
  return { context, sheets, sync, token };
}

module.exports = { harness, Sheet };
