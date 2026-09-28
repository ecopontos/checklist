const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

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
    values.forEach((valuesRow, rowOffset) => valuesRow.forEach((value, columnOffset) => {
      this.sheet.rows[this.row - 1 + rowOffset] ||= [];
      this.sheet.rows[this.row - 1 + rowOffset][this.column - 1 + columnOffset] = value;
    }));
  }
}

class SheetMock {
  constructor(rows = []) { this.rows = rows; }
  getRange(row, column, rows = 1, columns = 1) {
    return new RangeMock(this, row, column, rows, columns);
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((max, row) => Math.max(max, row.length), 0); }
  appendRow(row) { this.rows.push(row); }
}

const sheets = new Map();
const cache = new Map();
const cachePuts = [];
const removedCacheKeys = [];
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
  isFinite,
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: key => key === 'SPREADSHEET_ID' ? 'test' : '' })
  },
  SpreadsheetApp: { openById: () => ({ getSheetByName: name => sheets.get(name) || null }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  CacheService: {
    getScriptCache: () => ({
      get: key => cache.has(key) ? cache.get(key) : null,
      put: (key, value, ttl) => { cachePuts.push({ key, ttl }); cache.set(key, value); },
      remove: key => { removedCacheKeys.push(key); cache.delete(key); }
    })
  },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: value => ({ value, setMimeType() { return this; } })
  },
  Utilities: {
    formatDate: date => date.toISOString().slice(0, 10),
    computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(value, 'utf8').digest()),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' }
  }
});

vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

const header = ['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorr\u00eancia', 'Sincronizado Em', 'Sync ID'];
const values = [
  header,
  ['1', '2026-09-01', 'A', 'R1', 1, 'Antiga', '2026-09-01T12:00:00Z', 'sync-1-old'],
  ['1', '2026-09-02', 'A', 'R1', 2, '', '2026-09-02T12:00:00Z', 'sync-1-new'],
  ['2', '2026-09-03', 'B', 'R2', 0, 'Recusou', '2026-09-03T12:00:00Z', 'sync-2'],
  ['3', '2026-09-04', 'C', 'R3', 1, 'Primeira', '2026-09-04T10:00:00Z', ''],
  ['3', '2026-09-04', 'C', 'R3', 1, '\u00daltima do dia', '2026-09-04T11:00:00Z', ''],
  ['', 'data-inv\u00e1lida', 'D', 'R4', 1, 'Inv\u00e1lida', '', '']
];

const result = context.buildIntercorrenciasAtuais_(values);
assert.deepStrictEqual(Array.from(result.data, item => item.idRota), ['2', '3']);
assert.strictEqual(result.data[0].occurrenceId, 'sync-2');
assert.strictEqual(result.data[0].intercorrencia, 'Recusou');
assert.strictEqual(result.data[1].intercorrencia, '\u00daltima do dia');
assert.match(result.data[1].occurrenceId, /^legacy:[0-9a-f]{64}$/);
assert.strictEqual(result.quality.invalidDates, 1);
assert.strictEqual(result.quality.missingRouteIds, 1);
assert.strictEqual(result.quality.legacyIds, 2);
assert.strictEqual(result.quality.excludedRecords, 1);

const duplicateLegacyRows = [
  header,
  ['4', '2026-09-05', 'D', 'R4', 1, 'Legada duplicada', '2026-09-05T11:00:00Z', ''],
  ['5', '2026-09-05', 'E', 'R5', 1, 'Outro registro', '2026-09-05T11:00:00Z', 'sync-5'],
  ['4', '2026-09-05', 'D', 'R4', 1, 'Legada duplicada', '2026-09-05T11:00:00Z', '']
];
const legacyFirst = context.buildIntercorrenciasAtuais_([
  header, duplicateLegacyRows[1], duplicateLegacyRows[2]
]).data.find(item => item.idRota === '4');
const legacyMoved = context.buildIntercorrenciasAtuais_([
  header, duplicateLegacyRows[2], duplicateLegacyRows[3]
]).data.find(item => item.idRota === '4');
assert.strictEqual(
  legacyFirst.occurrenceId,
  legacyMoved.occurrenceId
);

sheets.set('Coletas', new SheetMock(values));
const response = JSON.parse(context.doGet({ parameter: { action: 'intercorrenciasAtuais' } }).value);
assert.strictEqual(response.ok, true);
assert.strictEqual(response.apiVersion, 13);
assert.strictEqual(response.source, 'intercorrenciasAtuais');
assert.ok(Array.isArray(response.data));
assert.strictEqual(cachePuts.at(-1).ttl, 300);

cache.clear();
sheets.delete('Coletas');
const missingSheetResponse = JSON.parse(context.getIntercorrenciasAtuais_().value);
assert.strictEqual(missingSheetResponse.ok, false);
assert.match(missingSheetResponse.error, /Coletas/);
sheets.set('Coletas', new SheetMock(values));

const cacheService = context.CacheService;
context.CacheService = { getScriptCache() { throw new Error('cache unavailable'); } };
assert.strictEqual(JSON.parse(context.getIntercorrenciasAtuais_().value).ok, true);

context.CacheService = { getScriptCache: () => ({
  get() { throw new Error('cache indisponível'); },
  put() { throw new Error('cache indisponível'); },
  remove() {}
}) };
assert.strictEqual(JSON.parse(context.getIntercorrenciasAtuais_().value).ok, true);
context.CacheService = cacheService;

cache.set('intercorrenciasAtuais:v1', '{invalid-json');
assert.strictEqual(JSON.parse(context.getIntercorrenciasAtuais_().value).ok, true);
cache.clear();

const removedBeforeInvalidBatch = removedCacheKeys.length;
const invalidBatchResponse = JSON.parse(context.saveColetas_([{
  id_rota: '5', data: 'data-invalida', cliente: 'E', roteiro: 'R5',
  quantidade: 1, intercorrencia: 'Teste', sync_id: 'sync-invalido'
}]).value);
assert.strictEqual(invalidBatchResponse.ok, false);
assert.strictEqual(removedCacheKeys.length, removedBeforeInvalidBatch);

context.saveColetas_([{
  id_rota: '5', data: '2026-09-18', cliente: 'E', roteiro: 'R5',
  quantidade: 1, intercorrencia: 'Teste', sync_id: 'sync-5'
}]);
assert.ok(removedCacheKeys.includes('intercorrenciasAtuais:v1'));

console.log('intercorrenciasAtuais: consolida ocorrencias e invalida cache: OK');
