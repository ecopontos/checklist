// tests/gas-instancias-heartbeat.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function sheetMock(rows) {
  return {
    rows,
    appendRow(r) { rows.push(r.slice()); },
    getDataRange() {
      return { getValues: () => rows.map(r => r.slice()) };
    },
    getRange(r, c, n, m) {
      return {
        setValues: values => values.forEach((row, i) => {
          rows[r - 1 + i] ||= [];
          row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; });
        })
      };
    }
  };
}

function backend() {
  const props = new Map([['SPREADSHEET_ID', 'test']]);
  const tables = new Map();
  const logs = [];
  const context = vm.createContext({
    console, Date,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || '' }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {}, remove: () => {} }) },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: name => tables.get(name) || null,
        insertSheet: name => { const s = sheetMock([]); tables.set(name, s); return s; }
      })
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Logger: { log: m => logs.push(String(m)) },
    Session: { getScriptTimeZone: () => 'America/Sao_Paulo' },
    Utilities: { formatDate: () => '' }
  });
  vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);
  context.jsonResponse_ = v => v;
  return { context, tables, logs };
}

test('recordHeartbeat_ cria a aba e insere a instancia', () => {
  const { context: g, tables } = backend();
  g.recordHeartbeat_('status', { iid: 'A1', nick: 'Caminhao 7', av: '1.7.1', gu: 'https://ex/exec', ua: 'UA' });
  const rows = tables.get('Instancias').rows;
  assert.deepEqual([...rows[0]], ['instanceId','apelido','appVersion','gasUrlConfig','gasApiVersion','primeiroAcesso','ultimoAcesso','ultimaAcao','totalChamadas','userAgent']);
  assert.equal(rows[1][0], 'A1');
  assert.equal(rows[1][1], 'Caminhao 7');
  assert.equal(rows[1][2], '1.7.1');
  assert.equal(rows[1][4], 16);
  assert.equal(rows[1][7], 'status');
  assert.equal(rows[1][8], 1);
});

test('recordHeartbeat_ faz upsert incrementando totalChamadas', () => {
  const { context: g, tables } = backend();
  g.recordHeartbeat_('status', { iid: 'A1', nick: 'Caminhao 7', av: '1.7.1', gu: 'u', ua: 'UA' });
  g.recordHeartbeat_('cadastroSync', { iid: 'A1', nick: '', av: '1.7.2', gu: 'u', ua: 'UA' });
  const rows = tables.get('Instancias').rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'Caminhao 7');
  assert.equal(rows[1][2], '1.7.2');
  assert.equal(rows[1][7], 'cadastroSync');
  assert.equal(rows[1][8], 2);
});

test('recordHeartbeat_ ignora quando iid ausente', () => {
  const { context: g, tables } = backend();
  g.recordHeartbeat_('status', { iid: '' });
  assert.equal(tables.has('Instancias'), false);
});

test('recordHeartbeat_ nao lança quando a escrita falha', () => {
  const { context: g, logs } = backend();
  g.SpreadsheetApp.openById = () => { throw new Error('planilha indisponivel'); };
  assert.doesNotThrow(() => g.recordHeartbeat_('status', { iid: 'A1' }));
  assert.ok(logs.some(l => l.includes('recordHeartbeat')));
});

test('doGet registra heartbeat a partir de e.parameter', () => {
  const { context: g, tables } = backend();
  g.doGet({ parameter: { action: 'status', iid: 'Z9', nick: 'PC', av: '1.7.1', gu: 'u', ua: 'UA' } });
  assert.equal(tables.get('Instancias').rows[1][0], 'Z9');
});

test('recordHeartbeat_ escapa valores do cliente contra injecao de formula', () => {
  const { context: g, tables } = backend();
  g.recordHeartbeat_('=cmd', { iid: '=IMPORTXML(1)', nick: '+evil', av: '1.0', gu: 'u', ua: '@x' });
  const row = tables.get('Instancias').rows[1];
  assert.equal(row[0].charAt(0), "'");
  assert.equal(row[1].charAt(0), "'");
  assert.equal(row[7].charAt(0), "'");
  assert.equal(row[9].charAt(0), "'");
});
