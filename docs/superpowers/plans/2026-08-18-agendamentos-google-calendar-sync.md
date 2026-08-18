# Sincronização bidirecional de Agendamentos com Google Calendar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Espelhar bidirecionalmente os agendamentos da planilha `verdesagendados` em um calendário Google compartilhado dedicado, resolvendo conflitos por última-edição-vence, sem que o app Tauri fale com o Google diretamente.

**Architecture:** Todo o acesso ao Google continua no GAS Web App (`gas/Code.gs`). A ida (planilha→Calendar) é síncrona dentro de `syncAgendamentos_`; a volta (Calendar→planilha) roda num trigger de tempo (`reverseSyncAgendamentos_`) que lê mudanças incrementais via `syncToken`. Um hash de conteúdo por linha corta o ping-pong; um timestamp por linha (`Sincronizado Em`) decide o vencedor. Exclusões viram tombstones (`Cancelado=TRUE`).

**Tech Stack:** Google Apps Script (V8, `var`, funções `nome_()`), Advanced Calendar Service (Calendar API v3), Google Sheets, HTML/JS vanilla (front Tauri), jsPDF. Testes: Node + `vm` com mocks (padrão `tests/*.test.cjs`).

## Global Constraints

Valores fixos (copiar verbatim onde citados):

- Nome do calendário dedicado: **`Coletas Agendadas`**.
- Timezone dos eventos cronometrados: **`America/Sao_Paulo`** (já no manifest).
- Intervalo do trigger de volta: **5 minutos**.
- Retenção de tombstone antes da limpeza física: **90 dias**.
- Escopo OAuth novo: **`https://www.googleapis.com/auth/calendar`**.
- Chave evento↔linha: **`extendedProperties.private.agId`**.
- Regex de `ID` de agendamento (já existe): **`/^[A-Za-z0-9-]{8,64}$/`**.
- Regex de hora: **`/^([01]\d|2[0-3]):[0-5]\d$/`** (`HH:MM`).
- LWW: `evento.updated > linha["Sincronizado Em"]` ⇒ **Calendar vence**; caso contrário (inclui empate) **planilha vence**. Exclusão conta como edição.
- Hash: **MD5** de string canônica com campos separados por ``.
- Novas Script Properties: **`AGENDAMENTOS_CALENDAR_ID`**, **`AGENDAMENTOS_CAL_SYNC_TOKEN`**, **`AGE_CACHE_VER`**.
- Cabeçalho final da planilha `verdesagendados` (11 colunas, ordem exata):
  `ID | Cliente | Endereço | Materiais | Data Prevista | Sincronizado Em | Hora Início | Hora Fim | Event ID | Hash Cal | Cancelado`.

Referência de design: `docs/superpowers/specs/2026-08-17-agendamentos-google-calendar-sync-design.md`.

---

### Task 1: Habilitar Advanced Calendar Service e escopo no manifest

**Files:**
- Modify: `gas/appsscript.json`
- Test: `tests/gas-manifest.test.cjs` (create)

**Interfaces:**
- Consumes: nada.
- Produces: manifest com `dependencies.enabledAdvancedServices` incluindo `Calendar v3` e `oauthScopes` incluindo o escopo de calendar. Habilita o símbolo global `Calendar` usado por todas as tasks seguintes.

- [ ] **Step 1: Write the failing test**

Create `tests/gas-manifest.test.cjs`:

```javascript
const assert = require('assert');
const fs = require('fs');

const manifest = JSON.parse(fs.readFileSync('gas/appsscript.json', 'utf8'));

const services = (manifest.dependencies && manifest.dependencies.enabledAdvancedServices) || [];
const calendar = services.find(s => s.userSymbol === 'Calendar');
assert.ok(calendar, 'Advanced Calendar Service deve estar habilitado');
assert.strictEqual(calendar.serviceId, 'calendar');
assert.strictEqual(calendar.version, 'v3');

const scopes = manifest.oauthScopes || [];
assert.ok(
  scopes.includes('https://www.googleapis.com/auth/calendar'),
  'escopo de calendar deve estar declarado'
);

console.log('Manifest com Advanced Calendar Service + escopo: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-manifest.test.cjs`
Expected: FAIL — `AssertionError: Advanced Calendar Service deve estar habilitado`.

- [ ] **Step 3: Edit the manifest**

Replace the contents of `gas/appsscript.json` with:

```json
{
  "timeZone": "America/Sao_Paulo",
  "dependencies": {
    "enabledAdvancedServices": [
      { "userSymbol": "Calendar", "version": "v3", "serviceId": "calendar" }
    ]
  },
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "webapp": {
    "access": "ANYONE_ANONYMOUS",
    "executeAs": "USER_DEPLOYING"
  }
}
```

> Nota de deploy (não é código): declarar `oauthScopes` explicitamente exige que a lista esteja completa. Os quatro escopos acima cobrem Sheets, Drive, Calendar e `UrlFetch`. Após aplicar, é obrigatório **redeploy do Web App** e novo consentimento. Confirme no editor do Apps Script que nenhum outro escopo usado hoje ficou de fora (menu *Project Settings → Scopes* após um "Run").

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-manifest.test.cjs`
Expected: `Manifest com Advanced Calendar Service + escopo: OK`.

- [ ] **Step 5: Commit**

```bash
git add gas/appsscript.json tests/gas-manifest.test.cjs
git commit -m "feat(gas): habilita Advanced Calendar Service e escopo de calendar"
```

---

### Task 2: Estender cabeçalho da planilha + mapeadores linha↔agendamento

**Files:**
- Modify: `gas/Code.gs` (constante `AGENDAMENTOS_HEADERS` na linha ~16; adicionar `AGE_COL`, `agFromRow_`, `rowFromAg_` perto de `normalizeAgendamento_`, ~linha 1092)
- Test: `tests/helpers/gas-harness.cjs` (create), `tests/gas-agendamentos-model.test.cjs` (create)

**Interfaces:**
- Consumes: `normalizeDateValue_` (já existe em Code.gs).
- Produces:
  - `AGENDAMENTOS_HEADERS` com 11 nomes (ordem do Global Constraints).
  - `AGE_COL = { ID:0, CLIENTE:1, ENDERECO:2, MATERIAIS:3, DATA:4, SINC:5, HINI:6, HFIM:7, EVENTID:8, HASH:9, CANC:10 }`.
  - `agFromRow_(row)` → `{ id, cliente, endereco, materiais, dataPrevista, horaInicio, horaFim, eventId, hashCal, cancelado }` (`cancelado` é boolean; datas via `normalizeDateValue_`).
  - `rowFromAg_(ag, nowIso)` → array de 11 valores na ordem do cabeçalho (`cancelado` boolean → `'TRUE'`/`''`).
  - Harness de teste `buildContext(options)` (ver Step 1) reutilizado por todas as tasks seguintes.

- [ ] **Step 1: Create the shared test harness**

Create `tests/helpers/gas-harness.cjs`:

```javascript
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

class RangeMock {
  constructor(sheet, row, column, rows, columns) {
    Object.assign(this, { sheet, row, column, rows, columns });
  }
  getValues() {
    return Array.from({ length: this.rows }, (_, r) =>
      Array.from({ length: this.columns }, (_, c) =>
        this.sheet.rows[this.row - 1 + r]?.[this.column - 1 + c] ?? ''
      )
    );
  }
  setValues(values) {
    values.forEach((rowValues, r) => {
      const idx = this.row - 1 + r;
      this.sheet.rows[idx] ||= [];
      rowValues.forEach((v, c) => { this.sheet.rows[idx][this.column - 1 + c] = v; });
    });
    return this;
  }
  setValue(v) {
    this.sheet.rows[this.row - 1] ||= [];
    this.sheet.rows[this.row - 1][this.column - 1] = v;
    return this;
  }
  clearContent() {
    for (let r = 0; r < this.rows; r++) {
      const idx = this.row - 1 + r;
      if (!this.sheet.rows[idx]) continue;
      for (let c = 0; c < this.columns; c++) this.sheet.rows[idx][this.column - 1 + c] = '';
    }
    return this;
  }
}

class SheetMock {
  constructor(rows = []) { this.rows = rows; }
  getRange(row, column, rows = 1, columns = 1) { return new RangeMock(this, row, column, rows, columns); }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  setFrozenRows() {}
}

// Mock do Advanced Calendar Service (Calendar.Events.*).
function makeCalendar(clock) {
  const store = new Map(); // eventId -> resource
  let seq = 0;
  const stamp = () => new Date(clock.now()).toISOString();
  return {
    _store: store,
    Events: {
      insert(resource, calendarId) {
        const id = 'ev-' + (++seq);
        const ev = Object.assign({}, resource, { id, status: 'confirmed', updated: stamp() });
        store.set(id, ev);
        return ev;
      },
      patch(resource, calendarId, eventId) {
        const ev = Object.assign({}, store.get(eventId), resource, { updated: stamp() });
        store.set(eventId, ev);
        return ev;
      },
      remove(calendarId, eventId) {
        const ev = store.get(eventId);
        if (ev) { ev.status = 'cancelled'; ev.updated = stamp(); }
      },
      list(calendarId, opts) {
        // Ignora incrementalidade real: devolve todos e um token novo.
        // Testes que exercitam syncToken injetam eventos e conferem o retorno.
        if (opts && opts.syncToken === '__EXPIRED__') { const e = new Error('gone'); e.details = { code: 410 }; throw e; }
        return { items: [...store.values()], nextSyncToken: 'tok-' + store.size };
      }
    }
  };
}

// clock mutável para controlar Date.now() e timestamps do Calendar.
function makeClock(startMs) { let t = startMs; return { now: () => t, set: ms => { t = ms; }, advance: ms => { t += ms; } }; }

function buildContext(options = {}) {
  const props = Object.assign({ SPREADSHEET_ID: 'ss-test' }, options.props || {});
  const propStore = { ...props };
  const cacheStore = new Map();
  const sheets = new Map();
  for (const [name, rows] of Object.entries(options.sheets || {})) sheets.set(name, new SheetMock(rows));

  const clock = options.clock || makeClock(Date.UTC(2026, 7, 18, 12, 0, 0));
  const calendar = makeCalendar(clock);

  const spreadsheet = {
    getSheetByName: name => sheets.get(name) || null,
    insertSheet: name => { const s = new SheetMock(); sheets.set(name, s); return s; }
  };

  // Date que respeita o clock para new Date()/Date.now(), mantendo o resto real.
  const RealDate = Date;
  function MockDate(...args) {
    if (args.length === 0) return new RealDate(clock.now());
    return new RealDate(...args);
  }
  MockDate.now = () => clock.now();
  MockDate.UTC = RealDate.UTC;
  MockDate.parse = RealDate.parse;
  MockDate.prototype = RealDate.prototype;

  const context = vm.createContext({
    console, JSON, Number, String, Boolean, Array, Object, Math, isNaN, RegExp,
    Date: MockDate,
    Calendar: calendar,
    Utilities: {
      DigestAlgorithm: { MD5: 'MD5' },
      computeDigest(_algo, str) {
        const buf = crypto.createHash('md5').update(String(str), 'utf8').digest();
        return Array.from(buf).map(b => (b > 127 ? b - 256 : b)); // bytes assinados, como no GAS
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in propStore ? propStore[k] : null),
        setProperty: (k, v) => { propStore[k] = String(v); },
        deleteProperty: k => { delete propStore[k]; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: k => (cacheStore.has(k) ? cacheStore.get(k) : null),
        put: (k, v) => cacheStore.set(k, v)
      })
    },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json', TEXT: 'text' },
      createTextOutput: value => ({ value, mimeType: '', setMimeType(m) { this.mimeType = m; return this; } })
    }
  });

  vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

  const post = body => JSON.parse(context.doPost({ postData: { contents: JSON.stringify(body) } }).value);
  return { context, calendar, clock, sheets, propStore, cacheStore, post };
}

module.exports = { buildContext, makeClock, SheetMock };
```

- [ ] **Step 2: Write the failing test**

Create `tests/gas-agendamentos-model.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext } = require('./helpers/gas-harness.cjs');

const { context } = buildContext();

// Cabeçalho tem 11 colunas na ordem esperada.
assert.deepStrictEqual(context.AGENDAMENTOS_HEADERS, [
  'ID', 'Cliente', 'Endereço', 'Materiais', 'Data Prevista', 'Sincronizado Em',
  'Hora Início', 'Hora Fim', 'Event ID', 'Hash Cal', 'Cancelado'
]);
assert.strictEqual(context.AGE_COL.CANC, 10);

// agFromRow_ mapeia índices e converte cancelado para boolean.
const row = ['uuid-aaaaaaaa', 'CLI', 'RUA 1', 'Plástico', '2026-08-20', '2026-08-18T12:00:00.000Z',
  '08:00', '09:00', 'ev-1', 'abc123', 'TRUE'];
const ag = context.agFromRow_(row);
assert.strictEqual(ag.id, 'uuid-aaaaaaaa');
assert.strictEqual(ag.dataPrevista, '2026-08-20');
assert.strictEqual(ag.horaInicio, '08:00');
assert.strictEqual(ag.eventId, 'ev-1');
assert.strictEqual(ag.cancelado, true);

// rowFromAg_ faz o caminho inverso.
const back = context.rowFromAg_(ag, '2026-08-18T12:00:00.000Z');
assert.strictEqual(back.length, 11);
assert.strictEqual(back[context.AGE_COL.CANC], 'TRUE');
assert.strictEqual(back[context.AGE_COL.HINI], '08:00');

// cancelado falso vira string vazia.
ag.cancelado = false;
assert.strictEqual(context.rowFromAg_(ag, 'x')[context.AGE_COL.CANC], '');

console.log('Modelo de dados de agendamento (headers + agFromRow_/rowFromAg_): OK');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node tests/gas-agendamentos-model.test.cjs`
Expected: FAIL — `AGENDAMENTOS_HEADERS` ainda tem 6 colunas.

- [ ] **Step 4: Implement**

In `gas/Code.gs`, replace the `AGENDAMENTOS_HEADERS` definition (linha ~16) with:

```javascript
var AGENDAMENTOS_HEADERS = [
    'ID', 'Cliente', 'Endereço', 'Materiais', 'Data Prevista', 'Sincronizado Em',
    'Hora Início', 'Hora Fim', 'Event ID', 'Hash Cal', 'Cancelado'
];
var AGE_COL = {
    ID: 0, CLIENTE: 1, ENDERECO: 2, MATERIAIS: 3, DATA: 4, SINC: 5,
    HINI: 6, HFIM: 7, EVENTID: 8, HASH: 9, CANC: 10
};
```

Add these helpers immediately above `function normalizeAgendamento_(op) {`:

```javascript
// Converte uma linha da planilha (array) em objeto de agendamento.
function agFromRow_(row) {
    return {
        id: String(row[AGE_COL.ID] || '').trim(),
        cliente: String(row[AGE_COL.CLIENTE] || ''),
        endereco: String(row[AGE_COL.ENDERECO] || ''),
        materiais: String(row[AGE_COL.MATERIAIS] || ''),
        dataPrevista: normalizeDateValue_(row[AGE_COL.DATA]) || '',
        horaInicio: String(row[AGE_COL.HINI] || '').trim(),
        horaFim: String(row[AGE_COL.HFIM] || '').trim(),
        eventId: String(row[AGE_COL.EVENTID] || '').trim(),
        hashCal: String(row[AGE_COL.HASH] || '').trim(),
        cancelado: String(row[AGE_COL.CANC] || '').trim().toUpperCase() === 'TRUE'
    };
}

// Converte um objeto de agendamento em linha (array de 11 colunas).
function rowFromAg_(ag, nowIso) {
    var row = [];
    row[AGE_COL.ID] = ag.id;
    row[AGE_COL.CLIENTE] = ag.cliente;
    row[AGE_COL.ENDERECO] = ag.endereco;
    row[AGE_COL.MATERIAIS] = ag.materiais;
    row[AGE_COL.DATA] = ag.dataPrevista;
    row[AGE_COL.SINC] = nowIso;
    row[AGE_COL.HINI] = ag.horaInicio || '';
    row[AGE_COL.HFIM] = ag.horaFim || '';
    row[AGE_COL.EVENTID] = ag.eventId || '';
    row[AGE_COL.HASH] = ag.hashCal || '';
    row[AGE_COL.CANC] = ag.cancelado ? 'TRUE' : '';
    return row;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node tests/gas-agendamentos-model.test.cjs`
Expected: `Modelo de dados de agendamento (headers + agFromRow_/rowFromAg_): OK`.

- [ ] **Step 6: Commit**

```bash
git add gas/Code.gs tests/helpers/gas-harness.cjs tests/gas-agendamentos-model.test.cjs
git commit -m "feat(gas): estende headers de verdesagendados e adiciona mapeadores linha<->agendamento"
```

---

### Task 3: Hash canônico do conteúdo

**Files:**
- Modify: `gas/Code.gs` (adicionar perto de `agFromRow_`)
- Test: `tests/gas-agendamentos-hash.test.cjs` (create)

**Interfaces:**
- Consumes: `Utilities.computeDigest`.
- Produces:
  - `canonicalAgendamento_(ag)` → string com `cliente,endereco,materiais,dataPrevista,horaInicio,horaFim,cancelado` juntos por `` (`cancelado` como `'TRUE'`/`''`).
  - `hashAgendamento_(ag)` → string hex MD5 (32 chars).

- [ ] **Step 1: Write the failing test**

Create `tests/gas-agendamentos-hash.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext } = require('./helpers/gas-harness.cjs');
const { context } = buildContext();

const base = {
  cliente: 'CLI', endereco: 'RUA 1', materiais: 'Plástico',
  dataPrevista: '2026-08-20', horaInicio: '08:00', horaFim: '09:00', cancelado: false
};

const h1 = context.hashAgendamento_(base);
assert.strictEqual(typeof h1, 'string');
assert.strictEqual(h1.length, 32, 'MD5 hex tem 32 chars');

// Determinístico: mesmos campos -> mesmo hash.
assert.strictEqual(context.hashAgendamento_({ ...base }), h1);

// Sensível a cada campo relevante.
assert.notStrictEqual(context.hashAgendamento_({ ...base, cliente: 'OUTRO' }), h1);
assert.notStrictEqual(context.hashAgendamento_({ ...base, horaInicio: '10:00' }), h1);
assert.notStrictEqual(context.hashAgendamento_({ ...base, cancelado: true }), h1);

// Não confunde separação de campos (evita colisão por concatenação ingênua).
const a = context.hashAgendamento_({ ...base, cliente: 'AB', endereco: 'C' });
const b = context.hashAgendamento_({ ...base, cliente: 'A', endereco: 'BC' });
assert.notStrictEqual(a, b);

console.log('Hash canônico de agendamento: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-agendamentos-hash.test.cjs`
Expected: FAIL — `context.hashAgendamento_ is not a function`.

- [ ] **Step 3: Implement**

In `gas/Code.gs`, add above `function normalizeAgendamento_(op) {`:

```javascript
// String canônica usada para o hash de conteúdo (campos separados por ).
function canonicalAgendamento_(ag) {
    return [
        String(ag.cliente || ''),
        String(ag.endereco || ''),
        String(ag.materiais || ''),
        String(ag.dataPrevista || ''),
        String(ag.horaInicio || ''),
        String(ag.horaFim || ''),
        ag.cancelado ? 'TRUE' : ''
    ].join('');
}

// MD5 hex do conteúdo canônico. Usado como guarda anti-ping-pong.
function hashAgendamento_(ag) {
    var bytes = Utilities.computeDigest(
        Utilities.DigestAlgorithm.MD5, canonicalAgendamento_(ag));
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
        var b = (bytes[i] + 256) % 256;
        hex += (b < 16 ? '0' : '') + b.toString(16);
    }
    return hex;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-agendamentos-hash.test.cjs`
Expected: `Hash canônico de agendamento: OK`.

- [ ] **Step 5: Commit**

```bash
git add gas/Code.gs tests/gas-agendamentos-hash.test.cjs
git commit -m "feat(gas): hash canônico de agendamento para guarda anti-ping-pong"
```

---

### Task 4: Mapeamento agendamento ↔ evento do Calendar

**Files:**
- Modify: `gas/Code.gs`
- Test: `tests/gas-agendamentos-event-map.test.cjs` (create)

**Interfaces:**
- Consumes: nada.
- Produces:
  - `agToEvent_(ag)` → recurso de evento Calendar API: `{ summary, location, description, start, end, extendedProperties:{private:{agId}} }`. All-day quando `horaInicio` vazio (`start.date`/`end.date`, end = dia+1). Cronometrado quando há `horaInicio` (`start.dateTime`/`end.dateTime` + `timeZone:'America/Sao_Paulo'`; `horaFim` default = início +1h, clampado a `23:59`).
  - `eventToAg_(event)` → `{ agId, cliente, endereco, materiais, dataPrevista, horaInicio, horaFim, updated, cancelled }`.
  - Helpers puros `addDaysToIso_(iso, n)` e `defaultEndTime_(horaInicio, horaFim)`.

- [ ] **Step 1: Write the failing test**

Create `tests/gas-agendamentos-event-map.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext } = require('./helpers/gas-harness.cjs');
const { context } = buildContext();

// All-day: sem hora -> start.date/end.date (end = dia seguinte).
const allDay = context.agToEvent_({
  id: 'uuid-aaaaaaaa', cliente: 'CLI', endereco: 'RUA 1', materiais: 'Plástico',
  dataPrevista: '2026-08-20', horaInicio: '', horaFim: ''
});
assert.strictEqual(allDay.summary, 'CLI');
assert.strictEqual(allDay.location, 'RUA 1');
assert.strictEqual(allDay.description, 'Plástico');
assert.strictEqual(allDay.start.date, '2026-08-20');
assert.strictEqual(allDay.end.date, '2026-08-21');
assert.strictEqual(allDay.extendedProperties.private.agId, 'uuid-aaaaaaaa');

// Cronometrado com horaFim.
const timed = context.agToEvent_({
  id: 'uuid-bbbbbbbb', cliente: 'C', endereco: '', materiais: '',
  dataPrevista: '2026-08-20', horaInicio: '08:00', horaFim: '09:30'
});
assert.strictEqual(timed.start.dateTime, '2026-08-20T08:00:00');
assert.strictEqual(timed.end.dateTime, '2026-08-20T09:30:00');
assert.strictEqual(timed.start.timeZone, 'America/Sao_Paulo');

// Cronometrado sem horaFim -> default +1h.
const timedDefault = context.agToEvent_({
  id: 'uuid-cccccccc', cliente: 'C', dataPrevista: '2026-08-20', horaInicio: '08:00', horaFim: ''
});
assert.strictEqual(timedDefault.end.dateTime, '2026-08-20T09:00:00');

// Default +1h clampado a 23:59 quando estoura o dia.
const late = context.agToEvent_({
  id: 'uuid-dddddddd', cliente: 'C', dataPrevista: '2026-08-20', horaInicio: '23:30', horaFim: ''
});
assert.strictEqual(late.end.dateTime, '2026-08-20T23:59:00');

// eventToAg_ — all-day.
const evAllDay = {
  status: 'confirmed', updated: '2026-08-18T10:00:00Z',
  summary: 'CLI', location: 'RUA 1', description: 'Plástico',
  start: { date: '2026-08-20' }, end: { date: '2026-08-21' },
  extendedProperties: { private: { agId: 'uuid-aaaaaaaa' } }
};
const back = context.eventToAg_(evAllDay);
assert.strictEqual(back.agId, 'uuid-aaaaaaaa');
assert.strictEqual(back.dataPrevista, '2026-08-20');
assert.strictEqual(back.horaInicio, '');
assert.strictEqual(back.cancelled, false);

// eventToAg_ — cronometrado (extrai data e HH:MM do dateTime, ignora offset/segundos).
const evTimed = {
  status: 'confirmed', updated: '2026-08-18T10:00:00Z',
  summary: 'C', start: { dateTime: '2026-08-20T08:00:00-03:00' }, end: { dateTime: '2026-08-20T09:30:00-03:00' },
  extendedProperties: { private: { agId: 'uuid-bbbbbbbb' } }
};
const backTimed = context.eventToAg_(evTimed);
assert.strictEqual(backTimed.dataPrevista, '2026-08-20');
assert.strictEqual(backTimed.horaInicio, '08:00');
assert.strictEqual(backTimed.horaFim, '09:30');

// eventToAg_ — cancelado.
assert.strictEqual(context.eventToAg_({ status: 'cancelled', updated: 'x', extendedProperties: { private: { agId: 'z' } } }).cancelled, true);

console.log('Mapeamento agendamento <-> evento: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-agendamentos-event-map.test.cjs`
Expected: FAIL — `context.agToEvent_ is not a function`.

- [ ] **Step 3: Implement**

In `gas/Code.gs`, add above `function normalizeAgendamento_(op) {`:

```javascript
var AGENDAMENTOS_TIMEZONE = 'America/Sao_Paulo';

// Soma n dias a uma data "YYYY-MM-DD" (via UTC, imune a fuso).
function addDaysToIso_(iso, n) {
    var p = String(iso).split('-');
    var d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
    var mm = String(d.getUTCMonth() + 1);
    var dd = String(d.getUTCDate());
    return d.getUTCFullYear() + '-' + (mm.length < 2 ? '0' : '') + mm + '-' + (dd.length < 2 ? '0' : '') + dd;
}

// Hora de fim: usa horaFim se houver; senão início +1h, clampado a 23:59.
function defaultEndTime_(horaInicio, horaFim) {
    if (horaFim) return horaFim;
    var parts = String(horaInicio).split(':');
    var mins = Number(parts[0]) * 60 + Number(parts[1]) + 60;
    if (mins >= 24 * 60) mins = 23 * 60 + 59;
    var hh = String(Math.floor(mins / 60));
    var mm = String(mins % 60);
    return (hh.length < 2 ? '0' : '') + hh + ':' + (mm.length < 2 ? '0' : '') + mm;
}

// Objeto de agendamento -> recurso de evento (Calendar API v3).
function agToEvent_(ag) {
    var ev = {
        summary: String(ag.cliente || ''),
        location: String(ag.endereco || ''),
        description: String(ag.materiais || ''),
        extendedProperties: { private: { agId: String(ag.id || '') } }
    };
    if (ag.horaInicio) {
        var fim = defaultEndTime_(ag.horaInicio, ag.horaFim);
        ev.start = { dateTime: ag.dataPrevista + 'T' + ag.horaInicio + ':00', timeZone: AGENDAMENTOS_TIMEZONE };
        ev.end = { dateTime: ag.dataPrevista + 'T' + fim + ':00', timeZone: AGENDAMENTOS_TIMEZONE };
    } else {
        ev.start = { date: ag.dataPrevista };
        ev.end = { date: addDaysToIso_(ag.dataPrevista, 1) };
    }
    return ev;
}

// Recurso de evento -> objeto de agendamento.
function eventToAg_(event) {
    var priv = (event.extendedProperties && event.extendedProperties.private) || {};
    var out = {
        agId: String(priv.agId || ''),
        cliente: String(event.summary || ''),
        endereco: String(event.location || ''),
        materiais: String(event.description || ''),
        dataPrevista: '', horaInicio: '', horaFim: '',
        updated: String(event.updated || ''),
        cancelled: event.status === 'cancelled'
    };
    var start = event.start || {};
    var end = event.end || {};
    if (start.date) {
        out.dataPrevista = String(start.date).slice(0, 10);
    } else if (start.dateTime) {
        out.dataPrevista = String(start.dateTime).slice(0, 10);
        out.horaInicio = String(start.dateTime).slice(11, 16);
        if (end.dateTime) out.horaFim = String(end.dateTime).slice(11, 16);
    }
    return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-agendamentos-event-map.test.cjs`
Expected: `Mapeamento agendamento <-> evento: OK`.

- [ ] **Step 5: Commit**

```bash
git add gas/Code.gs tests/gas-agendamentos-event-map.test.cjs
git commit -m "feat(gas): mapeamento agendamento<->evento (all-day e cronometrado)"
```

---

### Task 5: Decisão de conflito (última-edição-vence)

**Files:**
- Modify: `gas/Code.gs`
- Test: `tests/gas-agendamentos-lww.test.cjs` (create)

**Interfaces:**
- Consumes: nada.
- Produces: `decideWinner_(rowUpdatedIso, eventUpdatedIso)` → `'event'` se `Date.parse(eventUpdated) > Date.parse(rowUpdated)`, senão `'row'` (empate e datas inválidas ⇒ `'row'`).

- [ ] **Step 1: Write the failing test**

Create `tests/gas-agendamentos-lww.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext } = require('./helpers/gas-harness.cjs');
const { context } = buildContext();

assert.strictEqual(context.decideWinner_('2026-08-18T10:00:00Z', '2026-08-18T10:05:00Z'), 'event');
assert.strictEqual(context.decideWinner_('2026-08-18T10:05:00Z', '2026-08-18T10:00:00Z'), 'row');
// Empate -> planilha vence.
assert.strictEqual(context.decideWinner_('2026-08-18T10:00:00Z', '2026-08-18T10:00:00Z'), 'row');
// Linha sem timestamp (nunca sincronizada) -> evento vence.
assert.strictEqual(context.decideWinner_('', '2026-08-18T10:00:00Z'), 'event');
// Evento sem timestamp -> planilha vence.
assert.strictEqual(context.decideWinner_('2026-08-18T10:00:00Z', ''), 'row');

console.log('Decisão LWW: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-agendamentos-lww.test.cjs`
Expected: FAIL — `context.decideWinner_ is not a function`.

- [ ] **Step 3: Implement**

In `gas/Code.gs`, add above `function normalizeAgendamento_(op) {`:

```javascript
// Última-edição-vence. Empate ou datas inválidas => planilha ('row').
function decideWinner_(rowUpdatedIso, eventUpdatedIso) {
    var r = Date.parse(rowUpdatedIso);
    var e = Date.parse(eventUpdatedIso);
    if (isNaN(e)) return 'row';
    if (isNaN(r)) return 'event';
    return e > r ? 'event' : 'row';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-agendamentos-lww.test.cjs`
Expected: `Decisão LWW: OK`.

- [ ] **Step 5: Commit**

```bash
git add gas/Code.gs tests/gas-agendamentos-lww.test.cjs
git commit -m "feat(gas): decisão de conflito última-edição-vence"
```

---

### Task 6: Aceitar hora opcional em `normalizeAgendamento_`

**Files:**
- Modify: `gas/Code.gs` (`normalizeAgendamento_`, ~linha 1092)
- Test: `tests/gas-agendamentos-normalize.test.cjs` (create)

**Interfaces:**
- Consumes: nada.
- Produces: `normalizeAgendamento_(op)` passa a devolver, no caso `upsert`, também `horaInicio` e `horaFim` (validados por `/^([01]\d|2[0-3]):[0-5]\d$/`). Regras: hora vazia é permitida; `horaFim` sem `horaInicio` é erro; `horaFim <= horaInicio` é erro.

- [ ] **Step 1: Write the failing test**

Create `tests/gas-agendamentos-normalize.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext } = require('./helpers/gas-harness.cjs');
const { context } = buildContext();

const baseOp = { op: 'upsert', id: 'uuid-aaaaaaaa', cliente: 'CLI', dataPrevista: '2026-08-20' };

// Sem hora: campos vêm vazios.
let n = context.normalizeAgendamento_({ ...baseOp });
assert.strictEqual(n.horaInicio, '');
assert.strictEqual(n.horaFim, '');

// Hora válida.
n = context.normalizeAgendamento_({ ...baseOp, horaInicio: '08:00', horaFim: '09:00' });
assert.strictEqual(n.horaInicio, '08:00');
assert.strictEqual(n.horaFim, '09:00');

// Hora inválida.
assert.throws(() => context.normalizeAgendamento_({ ...baseOp, horaInicio: '25:00' }), /Hora/);
// horaFim sem horaInicio.
assert.throws(() => context.normalizeAgendamento_({ ...baseOp, horaFim: '09:00' }), /Hora/);
// horaFim <= horaInicio.
assert.throws(() => context.normalizeAgendamento_({ ...baseOp, horaInicio: '09:00', horaFim: '08:00' }), /Hora/);

console.log('normalizeAgendamento_ com hora opcional: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-agendamentos-normalize.test.cjs`
Expected: FAIL — `n.horaInicio` é `undefined`.

- [ ] **Step 3: Implement**

In `gas/Code.gs`, inside `normalizeAgendamento_`, replace the final `return { ... }` of the `upsert` branch with the version that parses/validates hours:

```javascript
    var horaRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    var horaInicio = String(op.horaInicio || '').trim();
    var horaFim = String(op.horaFim || '').trim();
    if (horaInicio && !horaRe.test(horaInicio)) {
        throw new Error('Hora de início inválida para ' + id);
    }
    if (horaFim && !horaRe.test(horaFim)) {
        throw new Error('Hora de fim inválida para ' + id);
    }
    if (horaFim && !horaInicio) {
        throw new Error('Hora de fim sem hora de início para ' + id);
    }
    if (horaInicio && horaFim && horaFim <= horaInicio) {
        throw new Error('Hora de fim deve ser maior que a de início para ' + id);
    }

    return {
        op: 'upsert',
        id: id,
        cliente: cliente,
        endereco: endereco,
        materiais: materiais,
        dataPrevista: dataPrevista,
        horaInicio: horaInicio,
        horaFim: horaFim
    };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-agendamentos-normalize.test.cjs`
Expected: `normalizeAgendamento_ com hora opcional: OK`.

- [ ] **Step 5: Commit**

```bash
git add gas/Code.gs tests/gas-agendamentos-normalize.test.cjs
git commit -m "feat(gas): normalizeAgendamento_ aceita hora de início/fim opcionais"
```

---

### Task 7: Read-path — esconder tombstones, devolver hora e versionar cache

**Files:**
- Modify: `gas/Code.gs` (`getAgendamentos_`, ~linha 1037; adicionar `bumpAgeCacheVer_`, `getAgeCacheVer_`)
- Test: `tests/gas-agendamentos-read.test.cjs` (create)

**Interfaces:**
- Consumes: `agFromRow_`, `AGE_COL`, `PropertiesService`.
- Produces:
  - `getAgeCacheVer_()` → inteiro (0 se ausente).
  - `bumpAgeCacheVer_()` → incrementa `AGE_CACHE_VER` nas Script Properties.
  - `getAgendamentos_(data)` agora: ignora linhas com `Cancelado=TRUE`; inclui `horaInicio`/`horaFim` em cada item; usa chave de cache `age:<ver>:<lastRow>:<data>`.

- [ ] **Step 1: Write the failing test**

Create `tests/gas-agendamentos-read.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext } = require('./helpers/gas-harness.cjs');

const header = ['ID', 'Cliente', 'Endereço', 'Materiais', 'Data Prevista', 'Sincronizado Em',
  'Hora Início', 'Hora Fim', 'Event ID', 'Hash Cal', 'Cancelado'];
const rows = [
  header,
  ['uuid-00000001', 'ATIVO', 'RUA 1', 'Plástico', '2026-08-20', '2026-08-18T12:00:00Z', '08:00', '09:00', 'ev-1', 'h1', ''],
  ['uuid-00000002', 'CANCELADO', 'RUA 2', 'Papel', '2026-08-20', '2026-08-18T12:00:00Z', '', '', 'ev-2', 'h2', 'TRUE']
];

const { post } = buildContext({ sheets: { verdesagendados: rows } });

const res = post({ action: undefined }); // usa GET path? -> chamamos doGet via harness abaixo
```

Replace the last two lines above with a direct call through `doGet` (the harness exposes `context`):

```javascript
const { context } = buildContext({ sheets: { verdesagendados: rows } });
const out = JSON.parse(context.doGet({ parameter: { action: 'agendamentos', data: '2026-08-20' } }).value);

assert.strictEqual(out.ok, true);
assert.strictEqual(out.data.length, 1, 'linha cancelada não aparece');
assert.strictEqual(out.data[0].cliente, 'ATIVO');
assert.strictEqual(out.data[0].horaInicio, '08:00');
assert.strictEqual(out.data[0].horaFim, '09:00');

// Cache versionado: bump muda a chave e não serve dado velho.
const before = context.getAgeCacheVer_();
context.bumpAgeCacheVer_();
assert.strictEqual(context.getAgeCacheVer_(), before + 1);

console.log('Read-path de agendamentos (tombstone + hora + cache ver): OK');
```

> Nota: confirme no `doGet` de `Code.gs` que a action de leitura de agendamentos é `agendamentos` e o parâmetro de data é `data` (ver `getAgendamentos_(params.data)` na linha ~81). Ajuste os nomes no teste se o roteamento existente usar outra string.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-agendamentos-read.test.cjs`
Expected: FAIL — retorna 2 itens (não filtra cancelado) e/ou `getAgeCacheVer_` não existe.

- [ ] **Step 3: Implement**

In `gas/Code.gs`, add near the other helpers:

```javascript
function getAgeCacheVer_() {
    var v = PropertiesService.getScriptProperties().getProperty('AGE_CACHE_VER');
    var n = Number(v);
    return isNaN(n) ? 0 : n;
}

function bumpAgeCacheVer_() {
    PropertiesService.getScriptProperties()
        .setProperty('AGE_CACHE_VER', String(getAgeCacheVer_() + 1));
}
```

Then rewrite the body of `getAgendamentos_` (from the cache key down to the return) so it uses the version, hides tombstones, and returns hours:

```javascript
        var cache = CacheService.getScriptCache();
        var cacheKey = 'age:' + getAgeCacheVer_() + ':' + lastRow + ':' + (dataAlvo || '*');
        var cached = cache.get(cacheKey);
        if (cached !== null) {
            return jsonResponse_({ ok: true, data: JSON.parse(cached) });
        }

        var values = sheet.getRange(2, 1, lastRow - 1, AGENDAMENTOS_HEADERS.length).getValues();
        var rows = [];
        for (var i = 0; i < values.length; i++) {
            var ag = agFromRow_(values[i]);
            if (ag.cancelado) continue; // tombstone: não aparece na UI/PDF
            if (dataAlvo && ag.dataPrevista !== dataAlvo) continue;
            rows.push({
                id: ag.id,
                cliente: ag.cliente,
                endereco: ag.endereco,
                materiais: ag.materiais,
                dataPrevista: ag.dataPrevista,
                horaInicio: ag.horaInicio,
                horaFim: ag.horaFim,
                sincronizadoEm: String(values[i][AGE_COL.SINC] || '')
            });
        }

        cache.put(cacheKey, JSON.stringify(rows), 600);
        return jsonResponse_({ ok: true, data: rows });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-agendamentos-read.test.cjs`
Expected: `Read-path de agendamentos (tombstone + hora + cache ver): OK`.

- [ ] **Step 5: Commit**

```bash
git add gas/Code.gs tests/gas-agendamentos-read.test.cjs
git commit -m "feat(gas): read-path esconde tombstones, devolve hora e versiona cache"
```

---

### Task 8: Wrappers do Calendar (insert/patch/delete/list)

**Files:**
- Modify: `gas/Code.gs`
- Test: `tests/gas-agendamentos-calendar-client.test.cjs` (create)

**Interfaces:**
- Consumes: `Calendar.Events.*`, `agToEvent_`, `PropertiesService`.
- Produces:
  - `getAgendamentosCalendarId_()` → string; lança erro se `AGENDAMENTOS_CALENDAR_ID` ausente.
  - `calendarInsertEvent_(ag)` → `eventId` (string).
  - `calendarPatchEvent_(eventId, ag)` → void.
  - `calendarDeleteEvent_(eventId)` → void (silencioso se já removido).
  - `calendarListChanges_(syncToken)` → `{ events: Array, nextSyncToken: string, expired: boolean }` (pagina via `pageToken`; `expired:true` no 410).

- [ ] **Step 1: Write the failing test**

Create `tests/gas-agendamentos-calendar-client.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext } = require('./helpers/gas-harness.cjs');

const { context, calendar } = buildContext({ props: { AGENDAMENTOS_CALENDAR_ID: 'cal-1' } });

const ag = { id: 'uuid-aaaaaaaa', cliente: 'CLI', endereco: 'RUA 1', materiais: 'Plástico',
  dataPrevista: '2026-08-20', horaInicio: '', horaFim: '' };

// insert devolve eventId e grava no store com agId.
const eventId = context.calendarInsertEvent_(ag);
assert.ok(eventId);
const stored = calendar._store.get(eventId);
assert.strictEqual(stored.extendedProperties.private.agId, 'uuid-aaaaaaaa');
assert.strictEqual(stored.summary, 'CLI');

// patch atualiza.
context.calendarPatchEvent_(eventId, { ...ag, cliente: 'NOVO' });
assert.strictEqual(calendar._store.get(eventId).summary, 'NOVO');

// list devolve o evento e um token.
const changes = context.calendarListChanges_('');
assert.ok(changes.events.length >= 1);
assert.ok(changes.nextSyncToken);
assert.strictEqual(changes.expired, false);

// syncToken expirado -> expired true.
const expired = context.calendarListChanges_('__EXPIRED__');
assert.strictEqual(expired.expired, true);

// delete marca cancelled.
context.calendarDeleteEvent_(eventId);
assert.strictEqual(calendar._store.get(eventId).status, 'cancelled');

// getAgendamentosCalendarId_ exige a property.
const { context: ctx2 } = buildContext();
assert.throws(() => ctx2.getAgendamentosCalendarId_(), /AGENDAMENTOS_CALENDAR_ID/);

console.log('Wrappers do Calendar: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-agendamentos-calendar-client.test.cjs`
Expected: FAIL — `context.calendarInsertEvent_ is not a function`.

- [ ] **Step 3: Implement**

In `gas/Code.gs`, add:

```javascript
function getAgendamentosCalendarId_() {
    var id = PropertiesService.getScriptProperties().getProperty('AGENDAMENTOS_CALENDAR_ID');
    if (!id) throw new Error('AGENDAMENTOS_CALENDAR_ID não configurado');
    return id;
}

function calendarInsertEvent_(ag) {
    var resource = agToEvent_(ag);
    var created = Calendar.Events.insert(resource, getAgendamentosCalendarId_());
    return created.id;
}

function calendarPatchEvent_(eventId, ag) {
    Calendar.Events.patch(agToEvent_(ag), getAgendamentosCalendarId_(), eventId);
}

function calendarDeleteEvent_(eventId) {
    if (!eventId) return;
    try {
        Calendar.Events.remove(getAgendamentosCalendarId_(), eventId);
    } catch (e) {
        // Evento já removido: ignora (idempotente).
    }
}

// Lê mudanças incrementais. Pagina via pageToken. No 410 (token expirado),
// devolve expired:true para o chamador refazer resync completo.
function calendarListChanges_(syncToken) {
    var calId = getAgendamentosCalendarId_();
    var events = [];
    var pageToken = null;
    var nextSyncToken = '';
    try {
        do {
            var opts = { showDeleted: true, maxResults: 250 };
            if (pageToken) opts.pageToken = pageToken;
            else if (syncToken) opts.syncToken = syncToken;
            var resp = Calendar.Events.list(calId, opts);
            (resp.items || []).forEach(function (ev) { events.push(ev); });
            pageToken = resp.nextPageToken || null;
            if (resp.nextSyncToken) nextSyncToken = resp.nextSyncToken;
        } while (pageToken);
        return { events: events, nextSyncToken: nextSyncToken, expired: false };
    } catch (err) {
        var code = err && err.details && err.details.code;
        if (code === 410 || /gone|sync token/i.test(String(err))) {
            return { events: [], nextSyncToken: '', expired: true };
        }
        throw err;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-agendamentos-calendar-client.test.cjs`
Expected: `Wrappers do Calendar: OK`.

- [ ] **Step 5: Commit**

```bash
git add gas/Code.gs tests/gas-agendamentos-calendar-client.test.cjs
git commit -m "feat(gas): wrappers do Advanced Calendar Service (insert/patch/delete/list)"
```

---

### Task 9: Ida — espelhar upsert/delete no Calendar dentro de `syncAgendamentos_`

**Files:**
- Modify: `gas/Code.gs` (`syncAgendamentos_`, ~linha 1139)
- Test: `tests/gas-agendamentos-forward.test.cjs` (create)

**Interfaces:**
- Consumes: `agFromRow_`, `rowFromAg_`, `hashAgendamento_`, `calendarInsertEvent_`, `calendarPatchEvent_`, `calendarDeleteEvent_`, `bumpAgeCacheVer_`, `AGE_COL`.
- Produces: `syncAgendamentos_(ops)` que, além de gravar a planilha (11 colunas): no upsert cria/atualiza o evento e grava `Event ID`/`Hash Cal`; no delete marca `Cancelado=TRUE` (tombstone) e remove o evento; falha de Calendar não aborta (grava `Hash Cal=''` e marca `calendarPendente:true` no retorno); chama `bumpAgeCacheVer_()`. Retorno: `{ ok, upserts, deletes, calendarPendente }`.

- [ ] **Step 1: Write the failing test**

Create `tests/gas-agendamentos-forward.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext } = require('./helpers/gas-harness.cjs');

const header = ['ID', 'Cliente', 'Endereço', 'Materiais', 'Data Prevista', 'Sincronizado Em',
  'Hora Início', 'Hora Fim', 'Event ID', 'Hash Cal', 'Cancelado'];

const { context, calendar, sheets, post } = buildContext({
  props: { SPREADSHEET_ID: 'ss-test', AGENDAMENTOS_CALENDAR_ID: 'cal-1', ROUTE_CHANGES_TOKEN: 't' },
  sheets: { verdesagendados: [header] }
});

// Cria um agendamento novo -> vira linha + evento com Event ID/Hash Cal.
let res = post({ action: 'syncAgendamentos', ops: [
  { op: 'upsert', id: 'uuid-00000001', cliente: 'CLI', endereco: 'RUA 1', materiais: 'Plástico', dataPrevista: '2026-08-20' }
] });
assert.strictEqual(res.ok, true);
assert.strictEqual(res.upserts, 1);

const rows = sheets.get('verdesagendados').rows;
const row = rows.find(r => r[0] === 'uuid-00000001');
assert.ok(row[context.AGE_COL.EVENTID], 'Event ID gravado');
assert.ok(row[context.AGE_COL.HASH], 'Hash Cal gravado');
assert.strictEqual(calendar._store.get(row[context.AGE_COL.EVENTID]).summary, 'CLI');

// Delete -> tombstone (linha permanece com Cancelado=TRUE) + evento cancelado.
const eventId = row[context.AGE_COL.EVENTID];
res = post({ action: 'syncAgendamentos', ops: [{ op: 'delete', id: 'uuid-00000001' }] });
assert.strictEqual(res.ok, true);
assert.strictEqual(res.deletes, 1);
const tomb = sheets.get('verdesagendados').rows.find(r => r[0] === 'uuid-00000001');
assert.strictEqual(String(tomb[context.AGE_COL.CANC]).toUpperCase(), 'TRUE');
assert.strictEqual(calendar._store.get(eventId).status, 'cancelled');

console.log('Ida (sync -> Calendar): OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-agendamentos-forward.test.cjs`
Expected: FAIL — Event ID não é gravado / delete apaga a linha em vez de marcar tombstone.

- [ ] **Step 3: Implement**

In `gas/Code.gs`, replace the inner processing of `syncAgendamentos_` (the block that builds `byId`, applies ops, and writes rows) with the version below. Keep the surrounding lock/try/catch and the `normalized = ops.map(normalizeAgendamento_)` line as they are.

```javascript
            var sheet = getAgendamentosSheet_();
            var lastRow = sheet.getLastRow();
            var values = lastRow > 1
                ? sheet.getRange(2, 1, lastRow - 1, AGENDAMENTOS_HEADERS.length).getValues()
                : [];

            var byId = {};
            values.forEach(function (row) {
                var id = String(row[AGE_COL.ID] || '').trim();
                if (id) byId[id] = row;
            });

            var now = new Date().toISOString();
            var upserts = 0;
            var deletes = 0;
            var calendarPendente = false;
            var novasLinhas = [];

            normalized.forEach(function (op) {
                var existing = byId[op.id];

                if (op.op === 'delete') {
                    if (!existing) return;
                    var agDel = agFromRow_(existing);
                    try {
                        calendarDeleteEvent_(agDel.eventId);
                    } catch (e) {
                        calendarPendente = true;
                    }
                    existing[AGE_COL.CANC] = 'TRUE';
                    existing[AGE_COL.SINC] = now;
                    deletes++;
                    return;
                }

                // upsert: monta o agendamento com os campos validados.
                var ag = {
                    id: op.id, cliente: op.cliente, endereco: op.endereco,
                    materiais: op.materiais, dataPrevista: op.dataPrevista,
                    horaInicio: op.horaInicio, horaFim: op.horaFim,
                    eventId: existing ? agFromRow_(existing).eventId : '',
                    cancelado: false
                };

                try {
                    if (ag.eventId) calendarPatchEvent_(ag.eventId, ag);
                    else ag.eventId = calendarInsertEvent_(ag);
                    ag.hashCal = hashAgendamento_(ag);
                } catch (e) {
                    calendarPendente = true;
                    ag.hashCal = ''; // divergente -> reconcile posterior reprocessa
                }

                var linha = rowFromAg_(ag, now);
                if (existing) {
                    for (var c = 0; c < linha.length; c++) existing[c] = linha[c];
                } else {
                    novasLinhas.push(linha);
                }
                upserts++;
            });

            var todas = values.concat(novasLinhas);
            if (todas.length) {
                sheet.getRange(2, 1, todas.length, AGENDAMENTOS_HEADERS.length).setValues(todas);
            }

            bumpAgeCacheVer_();

            return jsonResponse_({
                ok: true, upserts: upserts, deletes: deletes, calendarPendente: calendarPendente
            });
```

> Diferença de comportamento intencional: deletes agora **não** removem a linha (viram tombstone). A limpeza física fica na Task 11.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-agendamentos-forward.test.cjs`
Expected: `Ida (sync -> Calendar): OK`.

- [ ] **Step 5: Run the older agendamentos tests to check for regressions**

Run: `node tests/gas-agendamentos-read.test.cjs`
Expected: still `OK` (tombstones hidden).

- [ ] **Step 6: Commit**

```bash
git add gas/Code.gs tests/gas-agendamentos-forward.test.cjs
git commit -m "feat(gas): ida espelha upsert/delete no Calendar com tombstone e isolamento de falha"
```

---

### Task 10: Volta — `reverseSyncAgendamentos_` (trigger)

**Files:**
- Modify: `gas/Code.gs`
- Test: `tests/gas-agendamentos-reverse.test.cjs` (create)

**Interfaces:**
- Consumes: `calendarListChanges_`, `eventToAg_`, `hashAgendamento_`, `decideWinner_`, `calendarInsertEvent_`, `calendarPatchEvent_`, `agFromRow_`, `rowFromAg_`, `bumpAgeCacheVer_`, `AGE_COL`.
- Produces: `reverseSyncAgendamentos_()` — lê mudanças via `syncToken`, reconcilia contra a planilha por LWW, trata `cancelled` como exclusão, ignora ecos (hash igual) e eventos sem `agId`, recria evento quando a planilha é mais nova que um cancelamento, grava `AGENDAMENTOS_CAL_SYNC_TOKEN`, e no 410 faz resync completo. Retorna `{ ok, aplicados }`.

- [ ] **Step 1: Write the failing test**

Create `tests/gas-agendamentos-reverse.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext, makeClock } = require('./helpers/gas-harness.cjs');

const header = ['ID', 'Cliente', 'Endereço', 'Materiais', 'Data Prevista', 'Sincronizado Em',
  'Hora Início', 'Hora Fim', 'Event ID', 'Hash Cal', 'Cancelado'];

// Clock começa em T0; o Calendar carimba updated com o clock.
const clock = makeClock(Date.UTC(2026, 7, 18, 12, 0, 0));
const { context, calendar, sheets } = buildContext({
  props: { SPREADSHEET_ID: 'ss-test', AGENDAMENTOS_CALENDAR_ID: 'cal-1' },
  sheets: { verdesagendados: [header] },
  clock
});

// Semeia uma linha já espelhada (T0) e o evento correspondente.
const ag0 = { id: 'uuid-00000001', cliente: 'CLI', endereco: 'RUA 1', materiais: 'Plástico',
  dataPrevista: '2026-08-20', horaInicio: '', horaFim: '', cancelado: false };
const eventId = context.calendarInsertEvent_(ag0);
ag0.eventId = eventId;
ag0.hashCal = context.hashAgendamento_(ag0);
sheets.get('verdesagendados').rows.push(context.rowFromAg_(ag0, '2026-08-18T12:00:00.000Z'));

// Alguém edita o evento no Calendar em T0+10min (mais novo que a linha).
clock.advance(10 * 60 * 1000);
context.calendarPatchEvent_(eventId, { ...ag0, cliente: 'EDITADO NO CALENDAR' });

// Reverse sync: Calendar mais novo -> planilha atualizada.
let res = context.reverseSyncAgendamentos_();
assert.strictEqual(res.ok, true);
let row = sheets.get('verdesagendados').rows.find(r => r[0] === 'uuid-00000001');
assert.strictEqual(row[context.AGE_COL.CLIENTE], 'EDITADO NO CALENDAR');

// Eco: rodar de novo sem mudança real não altera nada (hash bate).
const snapshot = JSON.stringify(sheets.get('verdesagendados').rows);
context.reverseSyncAgendamentos_();
assert.strictEqual(JSON.stringify(sheets.get('verdesagendados').rows), snapshot, 'sem ping-pong');

// Exclusão no Calendar mais nova -> tombstone na planilha.
clock.advance(10 * 60 * 1000);
context.calendarDeleteEvent_(eventId);
context.reverseSyncAgendamentos_();
row = sheets.get('verdesagendados').rows.find(r => r[0] === 'uuid-00000001');
assert.strictEqual(String(row[context.AGE_COL.CANC]).toUpperCase(), 'TRUE');

// Token de sync foi salvo.
assert.ok(context.getAgendamentosCalendarId_()); // sanity
console.log('Volta (Calendar -> planilha) com LWW, eco e exclusão: OK');
```

> Nota sobre o mock: `Calendar.Events.list` do harness devolve **todos** os eventos (não filtra por `syncToken` real). Isso é suficiente porque a reconciliação é idempotente — o teste de "eco" prova que reprocessar o mesmo estado não altera a planilha.

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-agendamentos-reverse.test.cjs`
Expected: FAIL — `context.reverseSyncAgendamentos_ is not a function`.

- [ ] **Step 3: Implement**

In `gas/Code.gs`, add:

```javascript
// Reconciliação de um evento contra o índice de linhas (byId). Marca entry.dirty
// quando a linha muda. Devolve true se aplicou alguma alteração.
function reconcileEvent_(ev, byId) {
    var agEv = eventToAg_(ev);
    if (!agEv.agId) return false; // evento sem agId: fora de escopo

    var entry = byId[agEv.agId];

    if (agEv.cancelled) {
        if (!entry) return false; // já não existe linha
        var rowC = entry.row;
        var agRowC = agFromRow_(rowC);
        if (agRowC.cancelado) return false; // já é tombstone
        if (decideWinner_(rowC[AGE_COL.SINC], agEv.updated) === 'event') {
            rowC[AGE_COL.CANC] = 'TRUE';
            rowC[AGE_COL.SINC] = agEv.updated;
        } else {
            // Planilha mais nova que o cancelamento: recria o evento.
            agRowC.eventId = calendarInsertEvent_(agRowC);
            rowC[AGE_COL.EVENTID] = agRowC.eventId;
            rowC[AGE_COL.HASH] = hashAgendamento_(agRowC);
        }
        entry.dirty = true;
        return true;
    }

    if (!entry) return false; // evento com agId mas sem linha: fora de escopo

    var row = entry.row;
    var evHash = hashAgendamento_({
        cliente: agEv.cliente, endereco: agEv.endereco, materiais: agEv.materiais,
        dataPrevista: agEv.dataPrevista, horaInicio: agEv.horaInicio,
        horaFim: agEv.horaFim, cancelado: false
    });
    if (evHash === String(row[AGE_COL.HASH] || '')) return false; // eco: sem mudança real

    if (decideWinner_(row[AGE_COL.SINC], agEv.updated) === 'event') {
        row[AGE_COL.CLIENTE] = agEv.cliente;
        row[AGE_COL.ENDERECO] = agEv.endereco;
        row[AGE_COL.MATERIAIS] = agEv.materiais;
        row[AGE_COL.DATA] = agEv.dataPrevista;
        row[AGE_COL.HINI] = agEv.horaInicio;
        row[AGE_COL.HFIM] = agEv.horaFim;
        row[AGE_COL.CANC] = '';
        row[AGE_COL.SINC] = agEv.updated;
        row[AGE_COL.HASH] = evHash;
    } else {
        // Planilha vence: reescreve o evento a partir da linha.
        var agRow = agFromRow_(row);
        calendarPatchEvent_(agRow.eventId, agRow);
        row[AGE_COL.HASH] = hashAgendamento_(agRow);
    }
    entry.dirty = true;
    return true;
}

// Trigger de volta: Calendar -> planilha. Rodar a cada 5 min.
function reverseSyncAgendamentos_() {
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('AGENDAMENTOS_CAL_SYNC_TOKEN') || '';

    var changes = calendarListChanges_(token);
    if (changes.expired) {
        props.deleteProperty('AGENDAMENTOS_CAL_SYNC_TOKEN');
        changes = calendarListChanges_(''); // resync completo
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    var aplicados = 0;
    try {
        var sheet = getAgendamentosSheet_();
        var lastRow = sheet.getLastRow();
        var values = lastRow > 1
            ? sheet.getRange(2, 1, lastRow - 1, AGENDAMENTOS_HEADERS.length).getValues()
            : [];

        var byId = {};
        values.forEach(function (row) {
            var id = String(row[AGE_COL.ID] || '').trim();
            if (id) byId[id] = { row: row, dirty: false };
        });

        changes.events.forEach(function (ev) {
            try {
                if (reconcileEvent_(ev, byId)) aplicados++;
            } catch (e) {
                // Um evento problemático não aborta o lote.
                console.error('reverseSync evento falhou: ' + (e && e.message));
            }
        });

        if (aplicados && values.length) {
            sheet.getRange(2, 1, values.length, AGENDAMENTOS_HEADERS.length).setValues(values);
            bumpAgeCacheVer_();
        }
    } finally {
        lock.releaseLock();
    }

    if (changes.nextSyncToken) {
        props.setProperty('AGENDAMENTOS_CAL_SYNC_TOKEN', changes.nextSyncToken);
    }
    return { ok: true, aplicados: aplicados };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-agendamentos-reverse.test.cjs`
Expected: `Volta (Calendar -> planilha) com LWW, eco e exclusão: OK`.

- [ ] **Step 5: Commit**

```bash
git add gas/Code.gs tests/gas-agendamentos-reverse.test.cjs
git commit -m "feat(gas): reverseSyncAgendamentos_ reconcilia Calendar->planilha por LWW"
```

---

### Task 11: Setup, trigger e limpeza de tombstones (funções admin)

**Files:**
- Modify: `gas/Code.gs`
- Test: `tests/gas-agendamentos-purge.test.cjs` (create)

**Interfaces:**
- Consumes: `AGE_COL`, `getAgendamentosSheet_`, `bumpAgeCacheVer_`.
- Produces:
  - `setupAgendamentosCalendar()` — cria o calendário `Coletas Agendadas` se não existir e grava `AGENDAMENTOS_CALENDAR_ID`. (Sem teste automatizado; executada manualmente.)
  - `installAgendamentosTrigger()` — instala trigger de tempo de 5 min para `reverseSyncAgendamentos_`. (Sem teste automatizado.)
  - `purgeAgendamentoTombstones_(nowMs)` → número de linhas removidas; remove fisicamente linhas com `Cancelado=TRUE` e `Sincronizado Em` mais velho que 90 dias.

- [ ] **Step 1: Write the failing test (purge)**

Create `tests/gas-agendamentos-purge.test.cjs`:

```javascript
const assert = require('assert');
const { buildContext } = require('./helpers/gas-harness.cjs');

const header = ['ID', 'Cliente', 'Endereço', 'Materiais', 'Data Prevista', 'Sincronizado Em',
  'Hora Início', 'Hora Fim', 'Event ID', 'Hora Fim2', 'Cancelado'];
// Corrige o header para o formato real (evita engano de coluna):
header[9] = 'Hash Cal';

const nowMs = Date.UTC(2026, 7, 18, 12, 0, 0);
const old = new Date(nowMs - 91 * 24 * 3600 * 1000).toISOString();
const recent = new Date(nowMs - 10 * 24 * 3600 * 1000).toISOString();

const rows = [
  header,
  ['uuid-00000001', 'ATIVO', '', '', '2026-08-20', recent, '', '', 'ev-1', 'h', ''],
  ['uuid-00000002', 'TOMB VELHO', '', '', '2026-05-01', old, '', '', 'ev-2', 'h', 'TRUE'],
  ['uuid-00000003', 'TOMB NOVO', '', '', '2026-08-08', recent, '', '', 'ev-3', 'h', 'TRUE']
];

const { context, sheets } = buildContext({ sheets: { verdesagendados: rows } });

const removed = context.purgeAgendamentoTombstones_(nowMs);
assert.strictEqual(removed, 1, 'só o tombstone velho é removido');

const remaining = sheets.get('verdesagendados').rows.slice(1).filter(r => r[0]);
const ids = remaining.map(r => r[0]).sort();
assert.deepStrictEqual(ids, ['uuid-00000001', 'uuid-00000003']);

console.log('Limpeza de tombstones (90 dias): OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/gas-agendamentos-purge.test.cjs`
Expected: FAIL — `context.purgeAgendamentoTombstones_ is not a function`.

- [ ] **Step 3: Implement**

In `gas/Code.gs`, add:

```javascript
var AGENDAMENTO_TOMBSTONE_MAX_MS = 90 * 24 * 60 * 60 * 1000;

// Remove fisicamente tombstones (Cancelado=TRUE) com Sincronizado Em > 90 dias.
function purgeAgendamentoTombstones_(nowMs) {
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
        var sheet = getAgendamentosSheet_();
        var lastRow = sheet.getLastRow();
        if (lastRow < 2) return 0;

        var values = sheet.getRange(2, 1, lastRow - 1, AGENDAMENTOS_HEADERS.length).getValues();
        var mantidas = [];
        var removidas = 0;
        values.forEach(function (row) {
            if (!String(row[AGE_COL.ID] || '').trim()) return;
            var cancelado = String(row[AGE_COL.CANC] || '').trim().toUpperCase() === 'TRUE';
            var sincMs = Date.parse(row[AGE_COL.SINC]);
            if (cancelado && !isNaN(sincMs) && (nowMs - sincMs) > AGENDAMENTO_TOMBSTONE_MAX_MS) {
                removidas++;
                return;
            }
            mantidas.push(row);
        });

        if (mantidas.length) {
            sheet.getRange(2, 1, mantidas.length, AGENDAMENTOS_HEADERS.length).setValues(mantidas);
        }
        if (values.length > mantidas.length) {
            sheet.getRange(2 + mantidas.length, 1,
                values.length - mantidas.length, AGENDAMENTOS_HEADERS.length).clearContent();
        }
        if (removidas) bumpAgeCacheVer_();
        return removidas;
    } finally {
        lock.releaseLock();
    }
}

// ---- Funções administrativas (executadas manualmente uma vez) ----

// Cria o calendário dedicado se necessário e grava o ID nas Script Properties.
function setupAgendamentosCalendar() {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('AGENDAMENTOS_CALENDAR_ID')) {
        Logger.log('AGENDAMENTOS_CALENDAR_ID já configurado: ' + props.getProperty('AGENDAMENTOS_CALENDAR_ID'));
        return;
    }
    var cal = CalendarApp.createCalendar('Coletas Agendadas', {
        summary: 'Agendamentos de coleta sincronizados pelo app SATELITE',
        timeZone: 'America/Sao_Paulo'
    });
    props.setProperty('AGENDAMENTOS_CALENDAR_ID', cal.getId());
    Logger.log('Calendário criado. AGENDAMENTOS_CALENDAR_ID = ' + cal.getId());
    Logger.log('Compartilhe este calendário com a equipe manualmente no Google Calendar.');
}

// Instala o trigger de tempo de 5 min para o sync de volta (idempotente).
function installAgendamentosTrigger() {
    var jaExiste = ScriptApp.getProjectTriggers().some(function (t) {
        return t.getHandlerFunction() === 'reverseSyncAgendamentos_';
    });
    if (jaExiste) { Logger.log('Trigger já instalado.'); return; }
    ScriptApp.newTrigger('reverseSyncAgendamentos_').timeBased().everyMinutes(5).create();
    Logger.log('Trigger de 5 min instalado para reverseSyncAgendamentos_.');
}
```

> `CalendarApp`, `Logger` e `ScriptApp` são globais do GAS não exercitados nos testes de node (as três funções admin rodam só no ambiente Apps Script). `purgeAgendamentoTombstones_` é a única com teste automatizado.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/gas-agendamentos-purge.test.cjs`
Expected: `Limpeza de tombstones (90 dias): OK`.

- [ ] **Step 5: Wire the purge into the reverse trigger**

In `gas/Code.gs`, at the end of `reverseSyncAgendamentos_` (just before `return`), add an opportunistic purge so tombstones são limpos sem trigger extra:

```javascript
    try {
        purgeAgendamentoTombstones_(Date.now());
    } catch (e) {
        console.error('purge de tombstones falhou: ' + (e && e.message));
    }
    return { ok: true, aplicados: aplicados };
```

(Replace the existing final `return { ok: true, aplicados: aplicados };` line with the block above.)

- [ ] **Step 6: Run the reverse test again to confirm no regression**

Run: `node tests/gas-agendamentos-reverse.test.cjs`
Expected: still `OK` (o mock de `Date.now` vem do clock; purge não remove nada nos dados do teste).

- [ ] **Step 7: Commit**

```bash
git add gas/Code.gs tests/gas-agendamentos-purge.test.cjs
git commit -m "feat(gas): setup do calendário, trigger de 5 min e limpeza de tombstones"
```

---

### Task 12: Front-end — hora opcional no formulário, sync e PDF

**Files:**
- Modify: `agendamentos.html` (form ~linha 371-379; `setFormFields` ~643; `clearForm` ~650; `readForm` ~671; `renderList` ~706; `gerarPdfDaData` ~967)
- Modify: `google-sync.js` (`getAgendamentos` ~167; `syncAgendamentos` ~176)
- Test: `tests/agendamentos-hora.test.cjs` (create)

**Interfaces:**
- Consumes: `getAgendamentos`/`syncAgendamentos` do `google-sync.js`; campos `horaInicio`/`horaFim` do GAS.
- Produces: formulário com inputs de hora opcionais; payload de upsert com `horaInicio`/`horaFim`; coluna de hora na tabela e no PDF.

- [ ] **Step 1: Write the failing test (payload do front)**

Create `tests/agendamentos-hora.test.cjs`. Testa a função pura de leitura do formulário extraída do HTML — para isso, extraímos `readForm`/`validateForm` para um módulo testável:

```javascript
const assert = require('assert');
const { readForm, validateForm } = require('../agendamentos-form.js');

// Mock mínimo de document.
function mockDoc(values) {
  return { getElementById: id => ({ value: values[id] ?? '' }) };
}

global.document = mockDoc({
  agCliente: 'CLI', agEndereco: 'RUA 1', agMateriais: 'Plástico',
  agData: '2026-08-20', agHoraInicio: '08:00', agHoraFim: '09:00'
});

const form = readForm();
assert.strictEqual(form.horaInicio, '08:00');
assert.strictEqual(form.horaFim, '09:00');
assert.strictEqual(validateForm(form), '');

// horaFim sem horaInicio -> erro.
global.document = mockDoc({ agCliente: 'CLI', agData: '2026-08-20', agHoraFim: '09:00' });
assert.notStrictEqual(validateForm(readForm()), '');

// horaFim <= horaInicio -> erro.
global.document = mockDoc({ agCliente: 'CLI', agData: '2026-08-20', agHoraInicio: '09:00', agHoraFim: '08:00' });
assert.notStrictEqual(validateForm(readForm()), '');

console.log('Formulário de agendamento com hora: OK');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/agendamentos-hora.test.cjs`
Expected: FAIL — `Cannot find module '../agendamentos-form.js'`.

- [ ] **Step 3: Extract the form module**

Create `agendamentos-form.js` (novo módulo compartilhável entre o HTML e o teste):

```javascript
// Leitura e validação do formulário de agendamento.
// Usado por agendamentos.html (via <script type="module">) e pelos testes.
export function readForm() {
    const $ = id => document.getElementById(id);
    return {
        cliente: ($('agCliente').value || '').trim(),
        endereco: ($('agEndereco') ? $('agEndereco').value : '').trim(),
        materiais: ($('agMateriais') ? $('agMateriais').value : '').trim(),
        dataPrevista: $('agData').value,
        horaInicio: ($('agHoraInicio') ? $('agHoraInicio').value : '').trim(),
        horaFim: ($('agHoraFim') ? $('agHoraFim').value : '').trim()
    };
}

export function validateForm(form) {
    if (!form.cliente) return 'Informe o cliente.';
    if (!form.dataPrevista) return 'Informe a data prevista.';
    const horaRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (form.horaInicio && !horaRe.test(form.horaInicio)) return 'Hora de início inválida.';
    if (form.horaFim && !horaRe.test(form.horaFim)) return 'Hora de fim inválida.';
    if (form.horaFim && !form.horaInicio) return 'Informe a hora de início antes da de fim.';
    if (form.horaInicio && form.horaFim && form.horaFim <= form.horaInicio) {
        return 'A hora de fim deve ser maior que a de início.';
    }
    return '';
}
```

> O teste usa `import` de um módulo ES. Rode com uma versão de Node que suporte ESM via extensão. Como o repo usa `.cjs` para testes CommonJS, ajuste o teste para `require` de um build CJS **ou** rode este teste específico com `node --experimental-vm-modules`. Caminho mais simples e alinhado ao repo: exporte também em CommonJS adicionando ao final de `agendamentos-form.js`:
>
> ```javascript
> if (typeof module !== 'undefined') { module.exports = { readForm, validateForm }; }
> ```
>
> e no teste troque o `import` por `const { readForm, validateForm } = require('../agendamentos-form.js');` (já está assim no Step 1). O `export` no topo é ignorado pelo `require` do Node apenas se o arquivo não for tratado como módulo ES; para evitar ambiguidade, **remova as palavras `export`** e mantenha só as `function` + o `module.exports`, e no HTML importe via `import { readForm, validateForm } from './agendamentos-form.js'` trocando por um `<script src>` global. Decisão: manter CommonJS puro (sem `export`) e, no HTML, carregar o módulo com um `<script src="agendamentos-form.js"></script>` antes do `<script type="module">`, expondo `window.readForm`/`window.validateForm`.

Final form of `agendamentos-form.js` (CommonJS + global, sem `export`):

```javascript
(function (root) {
    function readForm() {
        var $ = function (id) { return document.getElementById(id); };
        return {
            cliente: ($('agCliente').value || '').trim(),
            endereco: ($('agEndereco') ? $('agEndereco').value : '').trim(),
            materiais: ($('agMateriais') ? $('agMateriais').value : '').trim(),
            dataPrevista: $('agData').value,
            horaInicio: ($('agHoraInicio') ? $('agHoraInicio').value : '').trim(),
            horaFim: ($('agHoraFim') ? $('agHoraFim').value : '').trim()
        };
    }
    function validateForm(form) {
        if (!form.cliente) return 'Informe o cliente.';
        if (!form.dataPrevista) return 'Informe a data prevista.';
        var horaRe = /^([01]\d|2[0-3]):[0-5]\d$/;
        if (form.horaInicio && !horaRe.test(form.horaInicio)) return 'Hora de início inválida.';
        if (form.horaFim && !horaRe.test(form.horaFim)) return 'Hora de fim inválida.';
        if (form.horaFim && !form.horaInicio) return 'Informe a hora de início antes da de fim.';
        if (form.horaInicio && form.horaFim && form.horaFim <= form.horaInicio) {
            return 'A hora de fim deve ser maior que a de início.';
        }
        return '';
    }
    root.readForm = readForm;
    root.validateForm = validateForm;
    if (typeof module !== 'undefined') { module.exports = { readForm, validateForm }; }
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/agendamentos-hora.test.cjs`
Expected: `Formulário de agendamento com hora: OK`.

- [ ] **Step 5: Wire the module and hour inputs into `agendamentos.html`**

Add the script before the module script (near line 455):

```html
    <script src="agendamentos-form.js"></script>
```

Add the hour inputs to the form, right after the `agData` field (after line 374):

```html
                    <div class="field">
                        <label for="agHoraInicio">Hora Início (opcional)</label>
                        <input type="time" id="agHoraInicio">
                    </div>
                    <div class="field">
                        <label for="agHoraFim">Hora Fim (opcional)</label>
                        <input type="time" id="agHoraFim">
                    </div>
```

In the module script, delete the local `function readForm()` and `function validateForm(form)` definitions (lines ~671-684) and rely on the globals from `agendamentos-form.js`. Update `setFormFields` and `clearForm` to handle the new fields:

```javascript
        function setFormFields(ag) {
            $('agCliente').value = ag.cliente || '';
            $('agEndereco').value = ag.endereco || '';
            $('agMateriais').value = ag.materiais || '';
            $('agData').value = ag.dataPrevista || '';
            $('agHoraInicio').value = ag.horaInicio || '';
            $('agHoraFim').value = ag.horaFim || '';
        }
```

`clearForm` calls `setFormFields({})`, which now also clears the hour inputs — no further change needed there.

Update the list render to show the hour (replace the Data Prevista cell in `renderList`, line ~747):

```javascript
                    <td>${escapeHTML(formatDateBR(ag.dataPrevista))}${ag.horaInicio ? ' ' + escapeHTML(ag.horaInicio) + (ag.horaFim ? '–' + escapeHTML(ag.horaFim) : '') : ''}</td>
```

- [ ] **Step 6: Include the hour in the PDF**

In `gerarPdfDaData` (line ~1000-1003), change the table head and body to include an "Horário" column:

```javascript
                    head: [['Cliente', 'Endereço', 'Materiais', 'Horário', 'Fotos']],
                    body: items.map(item => [
                        item.cliente,
                        item.endereco || '',
                        item.materiais || '',
                        item.horaInicio ? (item.horaInicio + (item.horaFim ? '–' + item.horaFim : '')) : '',
                        ''
                    ]),
```

Update the photo column index references from `3` to `4` in the same `autoTable` call (the `columnStyles`, `didParseCell`, and `didDrawCell` all reference column index `3` — change each to `4`):

```javascript
                    columnStyles: { 4: { cellWidth: 66 } },
```

and in `didParseCell` / `didDrawCell` replace `cellData.column.index !== 3` with `cellData.column.index !== 4`.

- [ ] **Step 7: Update `google-sync.js` to pass/return hours**

`getAgendamentos` already returns whatever the GAS sends (which now includes `horaInicio`/`horaFim`) — no change needed if it forwards `result.data` verbatim. Confirm `syncAgendamentos` forwards the full op object. Inspect `google-sync.js:176-195`; the ops are passed through as-is from the caller, so the `horaInicio`/`horaFim` added by `readForm` flow through. Add a defensive comment only:

```javascript
// ops incluem { op, id, cliente, endereco, materiais, dataPrevista, horaInicio, horaFim }
```

- [ ] **Step 8: Verify the app path manually (smoke)**

Run the app per `/run` or the project's launch skill, open Agendamentos, create one with a start time, confirm it appears in the list with the hour and the PDF shows an "Horário" column. (Calendar round-trip is verified in Task 13.)

- [ ] **Step 9: Commit**

```bash
git add agendamentos.html agendamentos-form.js google-sync.js tests/agendamentos-hora.test.cjs
git commit -m "feat(app): hora opcional no formulário, lista e PDF de agendamentos"
```

---

### Task 13: Documentação de setup e checklist de round-trip manual

**Files:**
- Modify: `gas/README.md`
- Create: `docs/superpowers/plans/2026-08-18-agendamentos-calendar-manual-checklist.md`

**Interfaces:**
- Consumes: funções `setupAgendamentosCalendar`, `installAgendamentosTrigger` da Task 11.
- Produces: passos operacionais de deploy e um checklist manual de verificação ponta-a-ponta.

- [ ] **Step 1: Document the GAS setup steps**

Append to `gas/README.md` a section:

```markdown
## Sincronização de Agendamentos com Google Calendar

Passos de setup (uma vez), após fazer deploy do `Code.gs` com o manifest atualizado:

1. No editor do Apps Script, rode `setupAgendamentosCalendar()` uma vez. Isso cria o
   calendário "Coletas Agendadas" e grava `AGENDAMENTOS_CALENDAR_ID` nas Script Properties.
   Copie o ID do log.
2. No Google Calendar (web), compartilhe "Coletas Agendadas" com a equipe (permissão
   "Fazer alterações nos eventos" para quem edita).
3. Rode `installAgendamentosTrigger()` uma vez para instalar o trigger de 5 min que roda
   `reverseSyncAgendamentos_`.
4. Faça o **redeploy** do Web App (o manifest ganhou o escopo de Calendar; exige novo
   consentimento).

Script Properties usadas: `AGENDAMENTOS_CALENDAR_ID`, `AGENDAMENTOS_CAL_SYNC_TOKEN`
(gerida automaticamente), `AGE_CACHE_VER` (gerida automaticamente).
```

- [ ] **Step 2: Write the manual round-trip checklist**

Create `docs/superpowers/plans/2026-08-18-agendamentos-calendar-manual-checklist.md`:

```markdown
# Checklist manual — round-trip Agendamentos ↔ Google Calendar

Pré-requisitos: setup da Task 13 concluído; app buildado com as mudanças da Task 12.

- [ ] Criar agendamento no app (sem hora) → em ≤5 min aparece como evento de dia inteiro
      no calendário "Coletas Agendadas".
- [ ] Criar agendamento no app (com hora início/fim) → evento cronometrado no horário certo
      (timezone America/Sao_Paulo).
- [ ] Editar o título do evento no Calendar → em ≤5 min o cliente muda no app.
- [ ] Editar o cliente no app logo após editar no Calendar (dentro de <5 min) → a edição
      mais recente vence (conferir qual timestamp é maior).
- [ ] Excluir o evento no Calendar → em ≤5 min o agendamento some da lista do app.
- [ ] Excluir um agendamento no app → o evento correspondente some do Calendar.
- [ ] Confirmar via API/menu que o evento tem `extendedProperties.private.agId` igual ao ID
      da linha na planilha `verdesagendados`.
- [ ] Rodar `reverseSyncAgendamentos_` manualmente duas vezes seguidas sem mudanças →
      nenhuma alteração na planilha (sem ping-pong).
```

- [ ] **Step 3: Commit**

```bash
git add gas/README.md docs/superpowers/plans/2026-08-18-agendamentos-calendar-manual-checklist.md
git commit -m "docs: setup do sync de Calendar e checklist de round-trip manual"
```

---

## Self-Review (feita ao escrever o plano)

- **Cobertura da spec:** manifest/Advanced Service (T1) ✓; colunas novas + migração (T2) ✓; hash anti-ping-pong (T3) ✓; mapeamento all-day/cronometrado + default +1h (T4) ✓; LWW (T5) ✓; hora opcional na validação (T6) ✓; esconder tombstone + cache ver (T7) ✓; wrappers Calendar + syncToken/410 (T8) ✓; ida síncrona + isolamento de falha + tombstone no delete (T9) ✓; volta por trigger + reconciliação + recriação de evento quando linha mais nova (T10) ✓; setup/trigger/purge 90 dias (T11) ✓; front hora no form/lista/PDF (T12) ✓; docs + checklist manual (T13) ✓.
- **Fora de escopo (spec §13) respeitado:** eventos sem `agId` ignorados (T10); fotos não vão pro Calendar; sem recorrência; sem UI de conflito.
- **Consistência de tipos:** `AGE_COL` e nomes (`agFromRow_`, `rowFromAg_`, `hashAgendamento_`, `agToEvent_`, `eventToAg_`, `decideWinner_`, `calendar*`, `reverseSyncAgendamentos_`, `bumpAgeCacheVer_`) usados de forma idêntica entre tasks.
- **Ponto de atenção conhecido:** o mock de `Calendar.Events.list` não filtra por `syncToken` real; os testes de volta se apoiam na idempotência da reconciliação (comprovada pelo caso "eco"). A incrementalidade real do `syncToken` só é exercida no checklist manual (T13).
- **Ponto de atenção conhecido:** confirmar no `doGet`/`doPost` existentes as strings de action (`agendamentos`, `syncAgendamentos`) e o parâmetro `data` antes de rodar os testes de T7/T9 (nota inline nas tasks).
