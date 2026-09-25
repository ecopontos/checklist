const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

assert.match(fs.readFileSync('google-sync.js', 'utf8'), /REQUIRED_GAS_API_VERSION = 12/);

function output(context, fn, arg) { return JSON.parse(context[fn](arg).value); }

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  getValues() { return Array.from({ length: this.rows }, (_, r) => Array.from({ length: this.cols }, (_, c) => this.sheet.rows[this.row - 1 + r]?.[this.col - 1 + c] ?? '')); }
  setValues(values) { values.forEach((v, r) => v.forEach((x, c) => { this.sheet.rows[this.row - 1 + r] ||= []; this.sheet.rows[this.row - 1 + r][this.col - 1 + c] = x; })); }
}
class Sheet { constructor(rows = []) { this.rows = rows; } getLastRow() { return this.rows.length; } getRange(r, c, rs = 1, cs = 1) { return new Range(this, r, c, rs, cs); } appendRow(row) { this.rows.push(row); } }

const props = new Map([['SPREADSHEET_ID', 'ss'], ['CHECKLISTS_FOLDER_ID', 'folder']]);
const sheets = new Map();
const files = [];
let createFails = false;
let cleanupFails = false;
const folder = {
  getFilesByName(name) { const matching = files.filter(f => f.name === name && !f.trashed); let i = 0; return { hasNext: () => i < matching.length, next: () => matching[i++] }; },
  createFile(blob) { if (createFails) throw new Error('create failed'); const file = { name: blob.name, trashed: false, setTrashed(v) { if (cleanupFails) throw new Error('cleanup failed'); this.trashed = v; } }; files.push(file); return file; }
};
const spreadsheet = { getSheetByName: n => sheets.get(n) || null, insertSheet: n => { const s = new Sheet(); sheets.set(n, s); return s; } };
let lockDepth = 0;
const context = vm.createContext({ console, JSON, Date, Number, String, Boolean, Array, Object, Math, isFinite, isNaN,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || '', setProperty: (k, v) => props.set(k, String(v)) }) },
  SpreadsheetApp: { openById: () => spreadsheet },
  LockService: { getScriptLock: () => ({ waitLock: () => { lockDepth++; }, releaseLock: () => { lockDepth--; } }) },
  Utilities: { base64Decode: s => { if (s === 'bad') throw new Error('bad base64'); return [1, 2]; }, newBlob: (bytes, mime, name) => ({ bytes, mime, name }), formatDate: (date) => '2026-09-18' },
  DriveApp: { getFolderById: () => folder },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ value, setMimeType() { return this; } }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) }
});
vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

files.push({ name: 'check.pdf', trashed: false, setTrashed(v) { if (cleanupFails) throw new Error('cleanup failed'); this.trashed = v; } });
let result = output(context, 'saveChecklist_', { filename: 'check.pdf', pdfBase64: 'bad' });
assert.strictEqual(result.ok, false); assert.strictEqual(files.filter(f => !f.trashed).length, 1); assert.strictEqual(lockDepth, 0);
result = output(context, 'saveChecklist_', { filename: 'check.pdf', pdfBase64: 'good' });
assert.strictEqual(result.ok, true); assert.strictEqual(files.filter(f => !f.trashed).length, 1);
cleanupFails = true; result = output(context, 'saveChecklist_', { filename: 'check.pdf', pdfBase64: 'good' });
assert.strictEqual(result.ok, true); assert.ok(result.warning); assert.strictEqual(files.filter(f => !f.trashed).length, 2);
cleanupFails = false; createFails = true; result = output(context, 'saveChecklist_', { filename: 'check.pdf', pdfBase64: 'good' });
assert.strictEqual(result.ok, false); assert.strictEqual(files.filter(f => !f.trashed).length, 2);

const header = ['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID'];
sheets.set('Coletas', new Sheet([header]));
function save(batch) { return output(context, 'saveColetas_', batch); }
result = save([{ id_rota: 'r', data: '2026-09-18', cliente: '', roteiro: '', quantidade: 1, sync_id: 'constructor' }, { id_rota: 'r2', data: '2026-09-18', quantidade: '', sync_id: 'ok' }]);
assert.strictEqual(result.ok, false); assert.strictEqual(sheets.get('Coletas').rows.length, 1);
result = save([{ id_rota: 'r', data: '2026-09-19', quantidade: 1, sync_id: 'future' }]); assert.strictEqual(result.ok, false);
result = save([{ id_rota: 'r', data: '2026-09-18', quantidade: 1, sync_id: 'constructor' }]); assert.strictEqual(result.ok, true);
result = save([{ id_rota: 'r', data: '2026-09-18', quantidade: 1, sync_id: 'constructor' }]); assert.strictEqual(result.count, 0); assert.strictEqual(sheets.get('Coletas').rows.length, 2);
console.log('gas checklist integrity: OK');
