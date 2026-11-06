const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

class RangeMock {
  constructor(sheet, row, column, rows, columns) { Object.assign(this, { sheet, row, column, rows, columns }); }
  getValues() {
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.columns }, (_, c) =>
        this.sheet.rows[this.row - 1 + r]?.[this.column - 1 + c] ?? ''));
  }
}
class SheetMock {
  constructor(rows = []) { this.rows = rows; }
  getRange(row, column, rows = 1, columns = 1) { return new RangeMock(this, row, column, rows, columns); }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
}

const sheets = new Map();
const cache = new Map();
const cachePuts = [];
const context = vm.createContext({
  console, JSON, Date, Number, String, Boolean, Array, Object, Math, isFinite, parseInt,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => k === 'SPREADSHEET_ID' ? 'test' : '' }) },
  SpreadsheetApp: { openById: () => ({ getSheetByName: name => sheets.get(name) || null }) },
  CacheService: { getScriptCache: () => ({
    get: k => cache.has(k) ? cache.get(k) : null,
    put: (k, v, ttl) => { cachePuts.push({ key: k, ttl }); cache.set(k, v); },
    remove: k => cache.delete(k)
  }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ value, setMimeType() { return this; } }) },
  Utilities: {
    formatDate: date => date.toISOString().slice(0, 10),
    computeDigest: (_a, value) => Array.from(crypto.createHash('sha256').update(value, 'utf8').digest()),
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' }
  }
});
vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

// normalizeRecencyDays_
for (const [input, expected] of [[30, 30], [60, 60], [90, 90], ['30', 30], [undefined, 90], ['', 90], ['abc', 90], [0, 90], [120, 90]]) {
  assert.strictEqual(context.normalizeRecencyDays_(input), expected, `dias ${JSON.stringify(input)}`);
}

// recencyCutoffCivil_ é determinístico quando recebe "hoje"
assert.strictEqual(context.recencyCutoffCivil_(90, new Date('2026-11-05T12:00:00Z')), '2026-08-07');
assert.strictEqual(context.recencyCutoffCivil_(30, new Date('2026-11-05T12:00:00Z')), '2026-10-06');

// filterByRecencyWindow_ é puro
const amostra = [{ data: '2026-09-01' }, { data: '2026-11-01' }, { data: '2026-10-06' }];
assert.deepStrictEqual(context.filterByRecencyWindow_(amostra, '2026-10-06').map(i => i.data), ['2026-11-01', '2026-10-06']);
assert.deepStrictEqual(context.filterByRecencyWindow_(amostra, '').map(i => i.data), ['2026-09-01', '2026-11-01', '2026-10-06']);

// Endpoint: recência corta por ponto agregado; cache por período
const header = ['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID'];
sheets.set('Coletas', new SheetMock([
  header,
  ['1', '2026-09-01', 'Antigo', 'R1', 1, 'Velha', '2026-09-01T12:00:00Z', 'sync-1'],
  ['2', '2026-11-01', 'Recente', 'R2', 1, 'Nova', '2026-11-01T12:00:00Z', 'sync-2']
]));
context.intercorrenciasHoje_ = () => new Date('2026-11-05T12:00:00Z');

const r30 = JSON.parse(context.doGet({ parameter: { action: 'intercorrenciasAtuais', dias: '30' } }).value);
assert.strictEqual(r30.ok, true);
assert.strictEqual(r30.apiVersion, 16);
assert.deepStrictEqual(r30.data.map(i => i.idRota), ['2']);
assert.ok(cachePuts.some(p => p.key === 'intercorrenciasAtuais:v2:dias=30'));

const r90 = JSON.parse(context.doGet({ parameter: { action: 'intercorrenciasAtuais', dias: '90' } }).value);
assert.deepStrictEqual(r90.data.map(i => i.idRota).sort(), ['1', '2']);
assert.ok(cachePuts.some(p => p.key === 'intercorrenciasAtuais:v2:dias=90'));

// dias ausente usa 90
const rDefault = JSON.parse(context.doGet({ parameter: { action: 'intercorrenciasAtuais' } }).value);
assert.ok(cachePuts.some(p => p.key === 'intercorrenciasAtuais:v2:dias=90'));
assert.strictEqual(rDefault.ok, true);

console.log('intercorrenciasAtuais: janela de recência por parâmetro e cache por período: OK');
