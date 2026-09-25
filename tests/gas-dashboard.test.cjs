const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function backend() {
  const cache = new Map();
  const props = new Map([['SPREADSHEET_ID', 'test']]);
  const tables = new Map();
  function sheet(rows) {
    return {
      rows,
      getLastRow() { let n = rows.length; while (n && rows[n - 1].every(v => !v)) n--; return n; },
      getRange(r, c, n, m) {
        return {
          getValues: () => Array.from({ length: n }, (_, i) => Array.from({ length: m }, (_, j) => rows[r - 1 + i]?.[c - 1 + j] ?? '')),
          setValues: values => values.forEach((row, i) => { rows[r - 1 + i] ||= []; row.forEach((v, j) => { rows[r - 1 + i][c - 1 + j] = v; }); }),
          clearContent: () => { for (let i = 0; i < n; i++) rows[r - 1 + i] = Array(m).fill(''); }
        };
      }
    };
  }
  const cacheApi = { get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) };
  const context = vm.createContext({
    console, Date,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props.get(k) || '', setProperty: (k, v) => props.set(k, v) }) },
    CacheService: { getScriptCache: () => cacheApi },
    SpreadsheetApp: { openById: () => ({ getSheetByName: name => tables.get(name) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'America/Sao_Paulo' },
    Utilities: { formatDate: (date, zone) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    } }
  });
  vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);
  context.jsonResponse_ = value => value;
  return { context, cacheApi, tables, sheet };
}

test('historico normaliza Date no fuso do GAS e filtra o mes', () => {
  const { context: g, tables, sheet } = backend();
  tables.set('Coletas', sheet([[],
    ['1', new Date('2026-09-01T01:00:00Z'), 'A', 'R1', 2, '', '', 'a'],
    ['2', new Date('2026-09-17T03:00:00Z'), 'B', 'R2', 3, 'Falha', '', 'b'],
    ['3', '2026-09-18', 'C', 'R1', 4, '', '', 'c']
  ]));
  const all = g.doGet({ parameter: { action: 'historicoColetas' } });
  assert.equal(all.ok, true);
  assert.equal(all.data[0].data, '2026-08-31');
  const month = g.getHistoricoColetas_('2026-09');
  assert.deepEqual(Array.from(month.data, c => c.data), ['2026-09-17', '2026-09-18']);
});

test('falha de cache nao impede leitura do historico', () => {
  const { context: g, tables, sheet, cacheApi } = backend();
  tables.set('Coletas', sheet([[], ['1', '2026-09-17', 'A', 'R1', 2, '', '', 'a']]));
  cacheApi.put = () => { throw new Error('Cache indisponivel ou valor grande'); };
  const result = g.getHistoricoColetas_('');
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 1);
});

test('editar e mudar data invalida agenda geral, data antiga e data nova', () => {
  const { context: g, sheet } = backend();
  const agenda = sheet([[], ['agenda-001', 'Antes', 'Rua', 'Verdes', '2026-09-17', '']]);
  g.getAgendamentosSheet_ = () => agenda;
  for (const day of ['', '2026-09-17', '2026-09-18']) g.getAgendamentos_(day);
  const result = g.syncAgendamentos_([{ op: 'upsert', id: 'agenda-001', cliente: 'Depois', dataPrevista: '2026-09-18' }]);
  assert.equal(result.ok, true);
  assert.equal(g.getAgendamentos_('2026-09-17').data.length, 0);
  assert.equal(g.getAgendamentos_('2026-09-18').data[0].cliente, 'Depois');
  assert.equal(g.getAgendamentos_('').data[0].cliente, 'Depois');
});

test('excluir e inserir no mesmo lote invalida cache mesmo sem mudar numero de linhas', () => {
  const { context: g, sheet } = backend();
  g.getAgendamentosSheet_ = () => agenda;
  const agenda = sheet([[], ['agenda-001', 'Antes', 'Rua', '', '2026-09-17', '']]);
  g.getAgendamentos_('2026-09-17');
  const result = g.syncAgendamentos_([
    { op: 'delete', id: 'agenda-001' },
    { op: 'upsert', id: 'agenda-002', cliente: 'Novo', dataPrevista: '2026-09-17' }
  ]);
  assert.equal(result.ok, true);
  assert.equal(g.getAgendamentos_('2026-09-17').data[0].cliente, 'Novo');
});

test('historico informa linhas invalidas e preserva zero legitimo e metadados no cache', () => {
  const { context: g, tables, sheet } = backend();
  tables.set('Coletas', sheet([[],
    ['1', '2026-02-30', 'A', 'R1', 2, '', '', 'a'],
    ['2', '2026-09-10', 'B', 'R1', 'invalido', '', '', 'b'],
    ['3', '2026-09-10', 'C', 'R1', 0, '1', '', 'c'],
    ['4', '2026-09-11', 'D', 'R1', -2, '', '', 'd'],
    ['5', '2026-09-12', 'E', 'R1', '', '', '', 'e'],
    ['6', '2026-09-13', 'F', 'R1', 1.5, '', '', 'f']
  ]));
  const result = g.getHistoricoColetas_('');
  assert.equal(result.ok, true);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].quantidade, 0);
  assert.equal(result.quality.invalidDates, 1);
  assert.equal(result.quality.invalidQuantities, 4);
  assert.equal(result.quality.excludedRecords, 5);
  assert.equal(JSON.stringify(g.getHistoricoColetas_('')), JSON.stringify(result));
});

test('historico vazio ainda informa qualidade da base consultada', () => {
  const { context: g } = backend();
  const result = g.getHistoricoColetas_('');
  assert.equal(result.ok, true);
  assert.equal(result.quality.excludedRecords, 0);
});

test('historico usa fuso operacional explicito mesmo se o projeto GAS estiver em outro fuso', () => {
  const { context: g, tables, sheet } = backend();
  g.Session.getScriptTimeZone = () => 'UTC';
  tables.set('Coletas', sheet([[], ['1', new Date('2026-09-01T01:30:00Z'), 'A', 'R1', 1, '', '', 'a']]));
  assert.equal(g.getHistoricoColetas_('').data[0].data, '2026-08-31');
});
