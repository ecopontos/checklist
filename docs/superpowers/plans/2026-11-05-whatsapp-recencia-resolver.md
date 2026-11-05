# WhatsApp: janela de recência e ação de resolver — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer a fila do módulo WhatsApp envelhecer intercorrências antigas (janela de recência parametrizada no GAS) e permitir que o operador resolva/ignore ocorrências sem campanha, de forma reversível.

**Architecture:** O GAS ganha um filtro de recência por parâmetro `dias` sobre o resultado já agregado de `intercorrenciasAtuais`, com cache por período. O SQLite local ganha uma tabela de ocorrências resolvidas; `buildWhatsappQueue` marca itens resolvidos e a UI os esconde por padrão, com toggle para revelar e desfazer. Confirmados, recência e resolvidas são três filtros independentes keyados por `occurrenceId` estável.

**Tech Stack:** Google Apps Script (`gas/Code.gs`), JS ES modules no front (`database.js` com sql.js/WASM, `google-sync.js`, `whatsapp-campaign.js`, `whatsapp-sender.js`, `whatsapp-events.js`), HTML estático, testes `node --test` e scripts `node` com `vm`.

## Global Constraints

- `occurrenceId` é a chave de identidade estável (sync_id da coleta ou `legacy:<digest>`); todos os filtros usam-na.
- Datas civis são strings `YYYY-MM-DD` e comparam-se lexicograficamente (equivalente a cronológico).
- `GAS_API_VERSION` é compartilhada por todos os endpoints; ao subir para 16, atualizar TODAS as asserções `apiVersion` nos testes.
- `REQUIRED_GAS_API_VERSION` do cliente permanece 12 (não alterar); o módulo WhatsApp valida `apiVersion >= 11` separadamente.
- CSP do Tauri proíbe `onclick`/`onchange` inline: controles usam `data-action` / `data-change-action` e são ligados em `whatsapp-events.js`.
- Períodos de recência válidos: `{30, 60, 90}`, padrão `90` para ausente/inválido.
- Persistência local via sql.js: usar `INSERT OR IGNORE` (UPSERT nem sempre disponível). Mutações passam por `this._persistAtomic(...)`.
- Conteúdo dinâmico sempre escapado via `escapeHtml` antes de entrar no HTML.
- Mensagens de commit terminam com:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: GAS — parâmetro `dias`, filtro de recência, cache por período e bump API 16

**Files:**
- Modify: `gas/Code.gs:42-43` (constantes), `gas/Code.gs:98-100` (doGet), `gas/Code.gs:820-872` (`getIntercorrenciasAtuais_`), `gas/Code.gs:2048-2050` (invalidação em `saveColetas_`)
- Create: `tests/gas-intercorrencias-recencia.test.cjs`
- Modify (asserções desatualizadas): `tests/gas-whatsapp-current.test.cjs:120,144,160`, `tests/gas-cadastro.test.cjs:165`, `tests/gas-roteiros-csv-drive.test.cjs:54`, `tests/gas-roteiros-normalizado.test.cjs:100`
- Modify: `package.json` (script `test`)

**Interfaces:**
- Produces (globais no realm GAS, usadas por tests e doGet):
  - `normalizeRecencyDays_(value) -> number` (30|60|90; 90 para inválido/ausente)
  - `intercorrenciasCacheKey_(dias) -> string` (`'intercorrenciasAtuais:v2:dias=<N>'`)
  - `intercorrenciasHoje_() -> Date` (indireção testável para `new Date()`)
  - `recencyCutoffCivil_(dias, today) -> 'YYYY-MM-DD'`
  - `filterByRecencyWindow_(data, cutoffCivil) -> data filtrado`
  - `getIntercorrenciasAtuais_(dias)` passa a aceitar `dias`
- Consumes: estruturas existentes `finalizeIntercorrenciasAtuais_`, `foldIntercorrenciasRows_`, `INTERCORRENCIAS_CHUNK_ROWS`.

- [ ] **Step 1: Escrever o teste de recência (falha)**

Create `tests/gas-intercorrencias-recencia.test.cjs`:

```js
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
```

- [ ] **Step 2: Rodar o teste e verificar que falha**

Run: `node tests/gas-intercorrencias-recencia.test.cjs`
Expected: FAIL (ex.: `context.normalizeRecencyDays_ is not a function`).

- [ ] **Step 3: Implementar no `gas/Code.gs`**

Substituir a linha `gas/Code.gs:43`:
```js
var INTERCORRENCIAS_ATUAIS_CACHE_KEY = 'intercorrenciasAtuais:v1';
```
por:
```js
var INTERCORRENCIAS_RECENCIA_DIAS = [30, 60, 90];
var INTERCORRENCIAS_RECENCIA_PADRAO = 90;
```

Alterar `gas/Code.gs:42` de `var GAS_API_VERSION = 15;` para `var GAS_API_VERSION = 16;`.

Adicionar helpers logo antes de `function getIntercorrenciasAtuais_(` (gas/Code.gs:820):
```js
function normalizeRecencyDays_(value) {
    var n = parseInt(value, 10);
    return INTERCORRENCIAS_RECENCIA_DIAS.indexOf(n) >= 0 ? n : INTERCORRENCIAS_RECENCIA_PADRAO;
}

function intercorrenciasCacheKey_(dias) {
    return 'intercorrenciasAtuais:v2:dias=' + dias;
}

// Indireção testável do relógio; testes substituem para resultados determinísticos.
function intercorrenciasHoje_() {
    return new Date();
}

function recencyCutoffCivil_(dias, today) {
    var base = Object.prototype.toString.call(today) === '[object Date]' ? today : intercorrenciasHoje_();
    var cutoff = new Date(base.getTime());
    cutoff.setDate(cutoff.getDate() - dias);
    return Utilities.formatDate(cutoff, 'GMT', 'yyyy-MM-dd');
}

function filterByRecencyWindow_(data, cutoffCivil) {
    if (!cutoffCivil) return data;
    return data.filter(function (item) {
        return String(item.data || '') >= cutoffCivil;
    });
}
```

Modificar `getIntercorrenciasAtuais_` (gas/Code.gs:820): mudar a assinatura e usar a chave por período, aplicando o filtro ao resultado final. Trechos exatos:

Assinatura:
```js
function getIntercorrenciasAtuais_(dias) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }
    var janela = normalizeRecencyDays_(dias);
    var cacheKey = intercorrenciasCacheKey_(janela);
```

Leitura do cache (era `cache.get(INTERCORRENCIAS_ATUAIS_CACHE_KEY)`):
```js
            try { cached = cache.get(cacheKey); } catch (_) { /* cache é opcional */ }
```

Após `var built = finalizeIntercorrenciasAtuais_(state);` acrescentar o corte antes de atribuir:
```js
            var built = finalizeIntercorrenciasAtuais_(state);
            var cutoff = recencyCutoffCivil_(janela, intercorrenciasHoje_());
            result.data = filterByRecencyWindow_(built.data, cutoff);
            result.quality = built.quality;
```

Escrita do cache (era `cache.put(INTERCORRENCIAS_ATUAIS_CACHE_KEY, ...)`):
```js
            try { cache.put(cacheKey, JSON.stringify(result), 300); } catch (_) { /* cache é opcional */ }
```

Modificar o `doGet` em `gas/Code.gs:98-100`:
```js
    if (params.action === 'intercorrenciasAtuais') {
        return getIntercorrenciasAtuais_(params.dias);
    }
```

Modificar a invalidação em `saveColetas_` (gas/Code.gs:2048-2050), de:
```js
        try {
            CacheService.getScriptCache().remove(INTERCORRENCIAS_ATUAIS_CACHE_KEY);
        } catch (_) { /* cache é opcional */ }
```
para:
```js
        try {
            var cacheColetas = CacheService.getScriptCache();
            INTERCORRENCIAS_RECENCIA_DIAS.forEach(function (dias) {
                cacheColetas.remove(intercorrenciasCacheKey_(dias));
            });
        } catch (_) { /* cache é opcional */ }
```

- [ ] **Step 4: Atualizar asserções desatualizadas de `apiVersion` e cache**

Em `tests/gas-whatsapp-current.test.cjs`:
- Linha 120: `assert.strictEqual(response.apiVersion, 15);` → `16`.
- Linha 144: `cache.set('intercorrenciasAtuais:v1', '{invalid-json');` → `cache.set('intercorrenciasAtuais:v2:dias=90', '{invalid-json');`
- Linha 160: `assert.ok(removedCacheKeys.includes('intercorrenciasAtuais:v1'));` → `assert.ok(removedCacheKeys.includes('intercorrenciasAtuais:v2:dias=90'));`

Em `tests/gas-cadastro.test.cjs:165`: `assert.equal(status.apiVersion, 15);` → `16`.
Em `tests/gas-roteiros-csv-drive.test.cjs:54`: `assert.equal(response.apiVersion, 15);` → `16`.
Em `tests/gas-roteiros-normalizado.test.cjs:100`: `assert.strictEqual(resp.apiVersion, 15, 'apiVersion deve ter subido para 15');` → `assert.strictEqual(resp.apiVersion, 16, 'apiVersion deve ter subido para 16');`

- [ ] **Step 5: Registrar o novo teste no `package.json`**

No script `test`, acrescentar após `node tests/gas-intercorrencias.test.cjs`:
```
 && node tests/gas-intercorrencias-recencia.test.cjs
```

- [ ] **Step 6: Rodar os testes GAS afetados e verificar que passam**

Run:
```
node tests/gas-intercorrencias-recencia.test.cjs
node tests/gas-whatsapp-current.test.cjs
node tests/gas-intercorrencias-atuais-chunks.test.cjs
node tests/gas-cadastro.test.cjs
node tests/gas-roteiros-csv-drive.test.cjs
node tests/gas-roteiros-normalizado.test.cjs
```
Expected: todos imprimem OK / exit 0.

Nota: `gas-intercorrencias-atuais-chunks.test.cjs` chama `doGet` sem `dias` (default 90) e compara `response.data` com a build pura. Com a data real de hoje, as linhas de 2026-09 ainda caem dentro de 90 dias apenas enquanto hoje < ~2026-12. Para blindar contra fragilidade temporal, antes do `doGet` (logo após `context.INTERCORRENCIAS_CHUNK_ROWS = 3;`, linha 125) adicionar:
```js
context.intercorrenciasHoje_ = () => new Date('2026-09-10T12:00:00Z');
```
Isso fixa a janela de 90 dias em `2026-06-12`, mantendo todas as linhas do dataset e preservando `response.data === full.data`.

- [ ] **Step 7: Commit**

```bash
git add gas/Code.gs tests/gas-intercorrencias-recencia.test.cjs tests/gas-whatsapp-current.test.cjs tests/gas-intercorrencias-atuais-chunks.test.cjs tests/gas-cadastro.test.cjs tests/gas-roteiros-csv-drive.test.cjs tests/gas-roteiros-normalizado.test.cjs package.json
git commit -m "feat(gas): janela de recencia por parametro dias em intercorrenciasAtuais (API 16)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: DB — tabela de ocorrências resolvidas e métodos dismiss/restore/list

**Files:**
- Modify: `database.js:303-311` (schema), e adicionar métodos após `getConfirmedWhatsappOccurrenceIds` (`database.js:1596-1601`)
- Modify: `tests/whatsapp-campaign-persistence.test.cjs` (acrescentar testes reutilizando `setup`)

**Interfaces:**
- Produces (no objeto `db`, default export):
  - `dismissWhatsappOccurrence(occurrenceId, at) -> occurrenceId` (idempotente)
  - `restoreWhatsappOccurrence(occurrenceId) -> occurrenceId` (idempotente)
  - `getDismissedWhatsappOccurrenceIds() -> string[]` (ordenado)
- Consumes: `this._persistAtomic`, `this._queryRows`, `this._requireWhatsappId`, `this._requireWhatsappTimestamp`.

- [ ] **Step 1: Escrever o teste de persistência (falha)**

Acrescentar ao final de `tests/whatsapp-campaign-persistence.test.cjs` (o arquivo já importa `test`, `assert` e define `setup`):

```js
test('resolve, restaura e lista ocorrências de forma idempotente e durável', async () => {
  const h = await setup();
  assert.deepEqual(Array.from(h.db.getDismissedWhatsappOccurrenceIds()), []);

  h.db.dismissWhatsappOccurrence('occ-1', '2026-11-05T12:00:00.000Z');
  h.db.dismissWhatsappOccurrence('occ-1', '2026-11-05T13:00:00.000Z'); // idempotente
  h.db.dismissWhatsappOccurrence('occ-2', '2026-11-05T12:30:00.000Z');
  assert.deepEqual(Array.from(h.db.getDismissedWhatsappOccurrenceIds()), ['occ-1', 'occ-2']);

  // Persistência sobrevive ao reload do armazenamento
  const reloaded = await setup(h.storage.get('app3_db'));
  assert.deepEqual(Array.from(reloaded.db.getDismissedWhatsappOccurrenceIds()), ['occ-1', 'occ-2']);

  reloaded.db.restoreWhatsappOccurrence('occ-1');
  reloaded.db.restoreWhatsappOccurrence('inexistente'); // idempotente
  assert.deepEqual(Array.from(reloaded.db.getDismissedWhatsappOccurrenceIds()), ['occ-2']);
});

test('resolver valida identificador e timestamp', async () => {
  const { db } = await setup();
  assert.throws(() => db.dismissWhatsappOccurrence('', '2026-11-05T12:00:00.000Z'), /ocorr|id/i);
  assert.throws(() => db.dismissWhatsappOccurrence('occ-1', 'nao-e-data'), /data|inválid/i);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --experimental-vm-modules --test tests/whatsapp-campaign-persistence.test.cjs`
Expected: FAIL (`db.getDismissedWhatsappOccurrenceIds is not a function`).

- [ ] **Step 3: Adicionar a tabela ao schema**

Em `database.js`, logo após o bloco dos índices do WhatsApp (depois da linha `database.js:310`, `idx_whatsapp_one_active ... WHERE status = 'active';`) e antes de `CREATE TABLE IF NOT EXISTS roteiro_change_outbox`:
```js
            CREATE TABLE IF NOT EXISTS whatsapp_dismissed_occurrences (
                occurrence_id TEXT PRIMARY KEY,
                dismissed_at TEXT NOT NULL
            );
```

- [ ] **Step 4: Implementar os métodos**

Em `database.js`, logo após `getConfirmedWhatsappOccurrenceIds()` (fecha em `database.js:1601`):
```js
    dismissWhatsappOccurrence(occurrenceId, at) {
        const id = this._requireWhatsappId(occurrenceId, 'ID da ocorrência');
        const dismissedAt = this._requireWhatsappTimestamp(at, 'Data de resolução');
        return this._persistAtomic(() => {
            this.db.run(`
                INSERT OR IGNORE INTO whatsapp_dismissed_occurrences (occurrence_id, dismissed_at)
                VALUES (?, ?)
            `, [id, dismissedAt]);
            return id;
        });
    }

    restoreWhatsappOccurrence(occurrenceId) {
        const id = this._requireWhatsappId(occurrenceId, 'ID da ocorrência');
        return this._persistAtomic(() => {
            this.db.run('DELETE FROM whatsapp_dismissed_occurrences WHERE occurrence_id = ?', [id]);
            return id;
        });
    }

    getDismissedWhatsappOccurrenceIds() {
        return this._queryRows(`
            SELECT occurrence_id FROM whatsapp_dismissed_occurrences ORDER BY occurrence_id
        `).map(row => row.occurrence_id);
    }
```

- [ ] **Step 5: Rodar e verificar que passa**

Run: `node --experimental-vm-modules --test tests/whatsapp-campaign-persistence.test.cjs`
Expected: PASS (todos os testes).

- [ ] **Step 6: Commit**

```bash
git add database.js tests/whatsapp-campaign-persistence.test.cjs
git commit -m "feat(db): tabela e metodos de ocorrencias whatsapp resolvidas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Fila — `buildWhatsappQueue` marca itens resolvidos

**Files:**
- Modify: `whatsapp-campaign.js:24-65` (`buildWhatsappQueue`)
- Modify: `tests/whatsapp-campaign.test.cjs` (novo teste)

**Interfaces:**
- Consumes: `getDismissedWhatsappOccurrenceIds()` (Task 2) fornecerá o array no chamador (Task 5/6).
- Produces: `buildWhatsappQueue({ ..., dismissedOccurrenceIds = [] })`; itens "fresh" ganham `dismissed: boolean`. Itens de campanha ativa nunca recebem `dismissed`.

- [ ] **Step 1: Escrever o teste (falha)**

Acrescentar a `tests/whatsapp-campaign.test.cjs`:
```js
test('marca itens resolvidos sem removê-los e nunca afeta campanha ativa', async () => {
  const { buildWhatsappQueue } = await loadCampaignModule();
  const occurrences = [
    { occurrenceId: 'occ-a', idRota: '1', data: '2026-09-18', cliente: 'A', roteiro: 'R1', intercorrencia: 'X' },
    { occurrenceId: 'occ-b', idRota: '2', data: '2026-09-17', cliente: 'B', roteiro: 'R2', intercorrencia: 'Y' }
  ];
  const contacts = [{ idRota: '1', phones: frozenPhones }, { idRota: '2', phones: frozenPhones }];
  const activeItems = [{ itemId: 'item-a', occurrenceId: 'occ-a', status: 'opened', phones: frozenPhones }];

  const queue = buildWhatsappQueue({
    occurrences, contacts, confirmedOccurrenceIds: [],
    dismissedOccurrenceIds: ['occ-a', 'occ-b'], activeItems
  });

  const active = queue.find(item => item.itemId === 'item-a');
  assert.equal(active.dismissed, undefined);
  const fresh = queue.find(item => item.occurrenceId === 'occ-b');
  assert.equal(fresh.dismissed, true);
  assert.equal(fresh.status, 'pending');
});

test('itens não resolvidos recebem dismissed falso', async () => {
  const { buildWhatsappQueue } = await loadCampaignModule();
  const [item] = buildWhatsappQueue({
    occurrences: [occurrenceA], contacts: [{ idRota: '1', phones: frozenPhones }],
    confirmedOccurrenceIds: [], dismissedOccurrenceIds: [], activeItems: []
  });
  assert.equal(item.dismissed, false);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --experimental-vm-modules --test tests/whatsapp-campaign.test.cjs`
Expected: FAIL (`fresh.dismissed` é `undefined`, esperado `true`).

- [ ] **Step 3: Implementar**

Em `whatsapp-campaign.js`, alterar a assinatura de `buildWhatsappQueue` (linha 24-29) para incluir `dismissedOccurrenceIds`:
```js
export function buildWhatsappQueue({
    occurrences = [],
    contacts = [],
    confirmedOccurrenceIds = [],
    dismissedOccurrenceIds = [],
    activeItems = []
} = {}) {
```

Após `const confirmedIds = new Set(confirmedOccurrenceIds);` (linha 32), adicionar:
```js
    const dismissedIds = new Set(dismissedOccurrenceIds);
```

No `.map(occurrence => { ... })` do bloco `fresh` (linhas 47-55), incluir `dismissed` no item:
```js
            const item = { ...occurrence, status: 'pending', phones,
                residuo: occurrence.residuo || occurrence.tipoResiduo || contact?.tipoResiduo || '',
                dismissed: dismissedIds.has(occurrence.occurrenceId) };
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --experimental-vm-modules --test tests/whatsapp-campaign.test.cjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add whatsapp-campaign.js tests/whatsapp-campaign.test.cjs
git commit -m "feat(whatsapp): buildWhatsappQueue marca ocorrencias resolvidas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Cliente — `getIntercorrenciasAtuais(dias)` repassa o parâmetro

**Files:**
- Modify: `google-sync.js:244-247` (`getIntercorrenciasAtuais`)
- Modify: `tests/google-sync-whatsapp.test.cjs` (novo teste)

**Interfaces:**
- Produces: `getIntercorrenciasAtuais(dias?)` — anexa `&dias=N` apenas quando `N ∈ {30,60,90}`; sem argumento, mantém `?action=intercorrenciasAtuais` inalterado.
- Consumes: será chamada por `whatsapp-sender.js` (Task 5) com o período atual.

- [ ] **Step 1: Escrever o teste (falha)**

Acrescentar a `tests/google-sync-whatsapp.test.cjs`:
```js
test('anexa o parâmetro dias quando válido e omite quando ausente ou inválido', async () => {
  const reply = () => ({ ok: true, apiVersion: 11, source: 'intercorrenciasAtuais',
    generatedAt: '2026-11-05T12:00:00.000Z', data: [occurrence],
    quality: { invalidDates: 0, missingRouteIds: 0, legacyIds: 0, excludedRecords: 0 } });
  const { sync, requests } = await loadSyncModule([reply(), reply(), reply()]);

  await sync.getIntercorrenciasAtuais(30);
  await sync.getIntercorrenciasAtuais(999);
  await sync.getIntercorrenciasAtuais();

  assert.equal(requests[0], 'https://gas.example/exec?action=intercorrenciasAtuais&dias=30');
  assert.equal(requests[1], 'https://gas.example/exec?action=intercorrenciasAtuais');
  assert.equal(requests[2], 'https://gas.example/exec?action=intercorrenciasAtuais');
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node --experimental-vm-modules --test tests/google-sync-whatsapp.test.cjs`
Expected: FAIL (`requests[0]` não contém `&dias=30`).

- [ ] **Step 3: Implementar**

Em `google-sync.js`, alterar o início de `getIntercorrenciasAtuais` (linhas 244-247):
```js
export async function getIntercorrenciasAtuais(dias) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    const diasParam = [30, 60, 90].includes(Number(dias)) ? `&dias=${Number(dias)}` : '';
    const result = await gasGetJsonWithRetry_(`${url}?action=intercorrenciasAtuais${diasParam}`);
```

- [ ] **Step 4: Rodar e verificar que passa**

Run: `node --experimental-vm-modules --test tests/google-sync-whatsapp.test.cjs`
Expected: PASS (inclusive o teste existente `requests[0] === '...?action=intercorrenciasAtuais'`, que chama sem argumento).

- [ ] **Step 5: Commit**

```bash
git add google-sync.js tests/google-sync-whatsapp.test.cjs
git commit -m "feat(sync): getIntercorrenciasAtuais aceita parametro dias

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: UI — seletor de período na fila

**Files:**
- Modify: `whatsapp-sender.html:470-473` (controles da fila)
- Modify: `whatsapp-sender.js` (`initWhatsappSender`, `refreshWhatsappQueue`, novo helper e persistência)
- Modify: `whatsapp-events.js:32-42` (delegação `change`)
- Modify: `tests/whatsapp-ui.test.cjs:59` (regex da URL) e novo teste
- Modify: `tests/whatsapp-events.test.cjs`

**Interfaces:**
- Consumes: `getIntercorrenciasAtuais(dias)` (Task 4).
- Produces: elemento `#queuePeriodFilter` (valores `30|60|90`); `data-change-action="atualizar-periodo"` → `window.refreshWhatsappQueue()`; período persistido em `localStorage['app3_whatsapp_periodo_dias']`.

- [ ] **Step 1: Escrever/ajustar os testes (falha)**

Em `tests/whatsapp-ui.test.cjs`, alterar a linha 59:
```js
      assert.match(url, /\?action=intercorrenciasAtuais(?:&dias=\d+)?$/);
```

Acrescentar a `tests/whatsapp-ui.test.cjs`:
```js
test('seletor de período repassa dias e persiste a escolha no dispositivo', async () => {
  const storage = new Map();
  const h = await setup({ storage });
  await h.window.initWhatsappSender();
  const lastUrl = () => h.lastRemoteUrl;
  h.elements.get('queuePeriodFilter').value = '30';
  await h.window.refreshWhatsappQueue();
  assert.equal(storage.get('app3_whatsapp_periodo_dias'), '30');
});
```

Para capturar a URL, no harness `setup` de `tests/whatsapp-ui.test.cjs`, dentro do `fetch` mock, no ramo de `intercorrenciasAtuais` (após `remoteCalls++;`, linha 60), adicionar:
```js
      h_lastRemoteUrl = url;
```
e declarar `let h_lastRemoteUrl;` junto das outras vars do `setup` (perto de `let remoteCalls = 0;`), e expor no retorno do `setup` (objeto em `return { window, db, ... }`, linha 86) adicionando `get lastRemoteUrl() { return h_lastRemoteUrl; }`. (O getter permite ao teste inspecionar a última URL consultada.)

Ajustar o teste acima para também validar o `&dias=30`:
```js
  assert.match(lastUrl(), /&dias=30$/);
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node tests/whatsapp-ui.test.cjs`
Expected: FAIL (elemento `queuePeriodFilter` inexistente / `app3_whatsapp_periodo_dias` não setado).

- [ ] **Step 3: Adicionar o seletor ao HTML**

Em `whatsapp-sender.html`, dentro de `<div class="queue-filters">` (linhas 470-473), após o `<label>Roteiro...</label>`:
```html
        <label>Período<select id="queuePeriodFilter" data-change-action="atualizar-periodo">
          <option value="30">Últimos 30 dias</option>
          <option value="60">Últimos 60 dias</option>
          <option value="90" selected>Últimos 90 dias</option>
        </select></label>
```

- [ ] **Step 4: Implementar o período no `whatsapp-sender.js`**

Adicionar, perto do topo do módulo (após a linha 16, `const element = ...`):
```js
const PERIOD_STORAGE_KEY = 'app3_whatsapp_periodo_dias';
function currentPeriodDays() {
    const value = Number(element('queuePeriodFilter').value);
    return [30, 60, 90].includes(value) ? value : 90;
}
```

Em `initWhatsappSender`, logo após `await db.init();` (linha 123), restaurar a escolha salva:
```js
        const savedPeriod = localStorage.getItem(PERIOD_STORAGE_KEY);
        if (['30', '60', '90'].includes(savedPeriod)) element('queuePeriodFilter').value = savedPeriod;
```

Em `refreshWhatsappQueue`, dentro do `try` (antes de `const imported = await checkAndImportRoteiros(db);`, linha 142), ler e persistir o período; e passar à consulta:
```js
            const dias = currentPeriodDays();
            try { localStorage.setItem(PERIOD_STORAGE_KEY, String(dias)); } catch (_) { /* preferência é opcional */ }
```
e alterar a linha 146 de:
```js
            const result = await getIntercorrenciasAtuais();
```
para:
```js
            const result = await getIntercorrenciasAtuais(dias);
```

- [ ] **Step 5: Ligar o `data-change-action` em `whatsapp-events.js`**

No `switch (control.dataset.changeAction)` (whatsapp-events.js:36-41), adicionar o caso:
```js
        case 'atualizar-periodo': window.refreshWhatsappQueue(); break;
```

- [ ] **Step 6: Atualizar `tests/whatsapp-events.test.cjs`**

Adicionar o dispatch (após a linha 29, `dispatch('change', { changeAction: 'filtrar-fila' });`):
```js
dispatch('change', { changeAction: 'atualizar-periodo' });
```
e refletir na asserção `calls` (a lista esperada ganha um `['refreshWhatsappQueue']` extra ao final, antes dos dois `applyWhatsappFilters`). Reordenar conforme a ordem dos dispatches: o dispatch de `atualizar-periodo` vem logo após `filtrar-fila`; portanto inserir `['refreshWhatsappQueue'],` entre `['applyWhatsappFilters']` (de filtrar-fila) e o `['applyWhatsappFilters']` (de queueSearch). A asserção final fica:
```js
assert.deepEqual(calls, [
  ['showWhatsappTab', 'queue'], ['showWhatsappTab', 'history'],
  ['refreshWhatsappQueue'], ['toggleWhatsappOccurrence', 'occ-1', true],
  ['startWhatsappCampaign'], ['selectWhatsappPhone', 2], ['openCurrentWhatsapp'],
  ['confirmCurrentWhatsapp'], ['deferCurrentWhatsapp'], ['completeWhatsappCampaign'],
  ['exportWhatsappCampaign', 'campaign-1'], ['applyWhatsappFilters'],
  ['refreshWhatsappQueue'], ['applyWhatsappFilters']
]);
```

- [ ] **Step 7: Rodar e verificar que passa**

Run:
```
node tests/whatsapp-ui.test.cjs
node tests/whatsapp-events.test.cjs
```
Expected: PASS em ambos.

- [ ] **Step 8: Commit**

```bash
git add whatsapp-sender.html whatsapp-sender.js whatsapp-events.js tests/whatsapp-ui.test.cjs tests/whatsapp-events.test.cjs
git commit -m "feat(whatsapp): seletor de periodo de recencia na fila

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: UI — resolver, desfazer e toggle "Mostrar resolvidas"

**Files:**
- Modify: `whatsapp-sender.html:464-475` (contadores/controles) para o toggle
- Modify: `whatsapp-sender.js` (`statusLabels`, `reconcileQueue`, `renderQueue`, novas funções `resolveWhatsappOccurrence`/`restoreWhatsappOccurrence`, `Object.assign(window, ...)`)
- Modify: `whatsapp-events.js:19-30,36-41` (delegação `click`/`change`)
- Modify: `tests/whatsapp-ui.test.cjs` (novo teste), `tests/whatsapp-events.test.cjs`

**Interfaces:**
- Consumes: `db.dismissWhatsappOccurrence`, `db.restoreWhatsappOccurrence`, `db.getDismissedWhatsappOccurrenceIds` (Task 2); `item.dismissed` em `buildWhatsappQueue` (Task 3).
- Produces: `window.resolveWhatsappOccurrence(occurrenceId)`, `window.restoreWhatsappOccurrence(occurrenceId)`; elemento `#showDismissedToggle`; `data-action="resolver-ocorrencia"|"desfazer-resolucao"`, `data-change-action="alternar-resolvidas"`.

- [ ] **Step 1: Escrever os testes (falha)**

Acrescentar a `tests/whatsapp-ui.test.cjs`:
```js
test('resolver esconde a ocorrência, toggle revela e desfazer devolve à fila', async () => {
  const h = await setup({ remote: { ok: true, data: [occurrence, { ...occurrence, occurrenceId: 'occ-2', idRota: '42' }] } });
  await h.window.initWhatsappSender();
  assert.equal(h.elements.get('queuePendingCount').textContent, '2');

  await h.window.resolveWhatsappOccurrence('occ-1');
  assert.deepEqual(Array.from(h.db.getDismissedWhatsappOccurrenceIds()), ['occ-1']);
  assert.equal(h.elements.get('queuePendingCount').textContent, '1');
  assert.ok(!h.elements.get('queueList').innerHTML.includes('data-occurrence-id="occ-1"'));

  h.elements.get('showDismissedToggle').checked = true;
  h.window.applyWhatsappFilters();
  assert.match(h.elements.get('queueList').innerHTML, /data-occurrence-id="occ-1"/);
  assert.match(h.elements.get('queueList').innerHTML, /Resolvido/);
  assert.match(h.elements.get('queueList').innerHTML, /data-action="desfazer-resolucao"/);

  await h.window.restoreWhatsappOccurrence('occ-1');
  assert.deepEqual(Array.from(h.db.getDismissedWhatsappOccurrenceIds()), []);
  assert.equal(h.elements.get('queuePendingCount').textContent, '2');
});

test('nova occurrenceId do mesmo ponto reaparece mesmo após resolver', async () => {
  const h = await setup({ remote: { ok: true, data: [occurrence] } });
  await h.window.initWhatsappSender();
  await h.window.resolveWhatsappOccurrence('occ-1');
  assert.equal(h.elements.get('queuePendingCount').textContent, '0');
  h.setRemote({ ok: true, data: [{ ...occurrence, occurrenceId: 'occ-1-novo', data: '2026-11-01' }] });
  await h.window.refreshWhatsappQueue();
  assert.equal(h.elements.get('queuePendingCount').textContent, '1');
  assert.match(h.elements.get('queueList').innerHTML, /data-occurrence-id="occ-1-novo"/);
});
```

- [ ] **Step 2: Rodar e verificar que falha**

Run: `node tests/whatsapp-ui.test.cjs`
Expected: FAIL (`h.window.resolveWhatsappOccurrence is not a function`).

- [ ] **Step 3: Adicionar o toggle ao HTML**

Em `whatsapp-sender.html`, dentro de `<div class="queue-filters">` (após o `<label>Período...</label>` da Task 5):
```html
        <label class="queue-show-dismissed"><input id="showDismissedToggle" type="checkbox" data-change-action="alternar-resolvidas"> Mostrar resolvidas</label>
```

- [ ] **Step 4: Implementar no `whatsapp-sender.js`**

Adicionar `dismissed` a `statusLabels` (linha 15):
```js
const statusLabels = { pending: 'Pendente', opened: 'Aguardando confirmação', confirmed: 'Confirmado', deferred: 'Adiado', blocked: 'Bloqueado', dismissed: 'Resolvido' };
```

Em `reconcileQueue` (linha 38-39), passar os resolvidos e excluí-los do conjunto selecionável:
```js
    queue = buildWhatsappQueue({ occurrences: occurrences || [], contacts: contactDirectory,
        confirmedOccurrenceIds: db.getConfirmedWhatsappOccurrenceIds(),
        dismissedOccurrenceIds: db.getDismissedWhatsappOccurrenceIds(),
        activeItems: activeCampaign?.items || [] });
    const selectable = new Set(queue.filter(item => !item.itemId && !item.blockedReason && !item.dismissed).map(item => item.occurrenceId));
```

Em `renderQueue`, contar apenas o que é exibível (não resolvido) e filtrar a lista por toggle. Substituir a linha `const counts = summarizeWhatsappItems(queue);` (linha 51) por:
```js
    const counts = summarizeWhatsappItems(queue.filter(item => !item.dismissed));
```
Substituir o cálculo de `filtered` (linhas 56-59) por:
```js
    const search = element('queueSearch').value.trim().toLocaleLowerCase('pt-BR');
    const route = element('queueRouteFilter').value;
    const showDismissed = !!element('showDismissedToggle').checked;
    const filtered = queue.filter(item => (showDismissed || !item.dismissed) &&
        (!route || item.roteiro === route) &&
        `${item.cliente} ${item.intercorrencia} ${item.roteiro}`.toLocaleLowerCase('pt-BR').includes(search));
```
Substituir o corpo do `.map(item => {...})` que monta cada `<article>` (linhas 60-69) por uma versão que mostra o estado `dismissed` e o botão de ação por linha:
```js
    element('queueList').innerHTML = filtered.map(item => {
        const status = item.dismissed ? 'dismissed' : (item.blockedReason ? 'blocked' : item.status);
        const disabled = busy || !!activeCampaign || !!item.blockedReason || !!item.itemId || !!item.dismissed;
        const rowAction = item.dismissed
            ? `<button class="btn btn-outline" data-action="desfazer-resolucao" data-occurrence-id="${escapeHtml(item.occurrenceId)}" ${busy ? 'disabled' : ''}>Desfazer</button>`
            : (!item.itemId && !item.blockedReason
                ? `<button class="btn btn-outline" data-action="resolver-ocorrencia" data-occurrence-id="${escapeHtml(item.occurrenceId)}" ${busy || !!activeCampaign ? 'disabled' : ''}>Resolver</button>`
                : '');
        return `<article class="queue-row status-${escapeHtml(status)}"><label>
            <input type="checkbox" data-change-action="alternar-ocorrencia" data-occurrence-id="${escapeHtml(item.occurrenceId)}"
                ${selectedOccurrences.has(item.occurrenceId) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <span><strong>${escapeHtml(item.cliente)}</strong><br>
                <span class="queue-meta">${escapeHtml(item.roteiro)} · ${escapeHtml(civilDate(item.data))}</span></span>
            </label><p>${escapeHtml(item.intercorrencia)}</p>
            <p class="queue-meta">${escapeHtml(statusLabels[status] || status)}${item.blockedReason ? `: ${escapeHtml(item.blockedReason)}` : ''}</p>
            ${rowAction}</article>`;
    }).join('') || `<p class="hint">${occurrences === null ? 'Aguardando consulta à fonte. A campanha local continua disponível.' :
```
(mantém a cauda existente da expressão `||` a partir de `queue.length ? ...` inalterada.)

Adicionar as duas funções exportadas (após `toggleWhatsappOccurrence`, linha 175):
```js
export async function resolveWhatsappOccurrence(id) {
    if (busy || activeCampaign) return;
    const item = queue.find(entry => entry.occurrenceId === id);
    if (!item || item.itemId || item.blockedReason || item.dismissed) return;
    setBusy(true);
    try {
        await db.dismissWhatsappOccurrence(id, new Date().toISOString());
        selectedOccurrences.delete(id);
        reconcileQueue();
        setError('queueError');
    } catch (error) {
        setError('queueError', `Não foi possível resolver a ocorrência: ${error.message}`);
    } finally {
        setBusy(false);
    }
}

export async function restoreWhatsappOccurrence(id) {
    if (busy) return;
    setBusy(true);
    try {
        await db.restoreWhatsappOccurrence(id);
        reconcileQueue();
        setError('queueError');
    } catch (error) {
        setError('queueError', `Não foi possível desfazer: ${error.message}`);
    } finally {
        setBusy(false);
    }
}
```

Incluir as duas no `Object.assign(window, {...})` (linhas 313-315), acrescentando ao final da lista:
```js
    resolveWhatsappOccurrence, restoreWhatsappOccurrence });
```
(substituindo o fechamento atual `selectWhatsappPhone });` por `selectWhatsappPhone, resolveWhatsappOccurrence, restoreWhatsappOccurrence });`.)

- [ ] **Step 5: Ligar as ações em `whatsapp-events.js`**

No `switch (control.dataset.action)` do listener de `click` (whatsapp-events.js:19-29), adicionar antes do fechamento:
```js
        case 'resolver-ocorrencia': window.resolveWhatsappOccurrence(control.dataset.occurrenceId); break;
        case 'desfazer-resolucao': window.restoreWhatsappOccurrence(control.dataset.occurrenceId); break;
```
No `switch (control.dataset.changeAction)` do listener de `change` (whatsapp-events.js:36-41), adicionar:
```js
        case 'alternar-resolvidas': window.applyWhatsappFilters(); break;
```

- [ ] **Step 6: Atualizar `tests/whatsapp-events.test.cjs`**

Acrescentar `resolveWhatsappOccurrence` e `restoreWhatsappOccurrence` ao array `names` (linha 6-9). Adicionar os dispatches (após o dispatch de `atualizar-periodo` da Task 5, antes do `input`):
```js
dispatch('click', { action: 'resolver-ocorrencia', occurrenceId: 'occ-9' });
dispatch('click', { action: 'desfazer-resolucao', occurrenceId: 'occ-9' });
dispatch('change', { changeAction: 'alternar-resolvidas' });
```
Refletir na asserção `calls`, inserindo na ordem correta (logo após `['refreshWhatsappQueue']` de atualizar-periodo e antes do `['applyWhatsappFilters']` do queueSearch):
```js
  ['resolveWhatsappOccurrence', 'occ-9'], ['restoreWhatsappOccurrence', 'occ-9'],
  ['applyWhatsappFilters'],
```
A lista final completa fica:
```js
assert.deepEqual(calls, [
  ['showWhatsappTab', 'queue'], ['showWhatsappTab', 'history'],
  ['refreshWhatsappQueue'], ['toggleWhatsappOccurrence', 'occ-1', true],
  ['startWhatsappCampaign'], ['selectWhatsappPhone', 2], ['openCurrentWhatsapp'],
  ['confirmCurrentWhatsapp'], ['deferCurrentWhatsapp'], ['completeWhatsappCampaign'],
  ['exportWhatsappCampaign', 'campaign-1'], ['applyWhatsappFilters'],
  ['refreshWhatsappQueue'],
  ['resolveWhatsappOccurrence', 'occ-9'], ['restoreWhatsappOccurrence', 'occ-9'],
  ['applyWhatsappFilters'], ['applyWhatsappFilters']
]);
```

- [ ] **Step 7: Rodar e verificar que passa**

Run:
```
node tests/whatsapp-ui.test.cjs
node tests/whatsapp-events.test.cjs
```
Expected: PASS em ambos.

- [ ] **Step 8: Commit**

```bash
git add whatsapp-sender.html whatsapp-sender.js whatsapp-events.js tests/whatsapp-ui.test.cjs tests/whatsapp-events.test.cjs
git commit -m "feat(whatsapp): resolver/desfazer ocorrencias com toggle de resolvidas

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Verificação da suíte completa

**Files:** nenhum (apenas execução).

- [ ] **Step 1: Rodar a suíte inteira**

Run: `npm test`
Expected: exit 0 — todos os testes do script passam, incluindo os novos.

- [ ] **Step 2: Se algo falhar**

Diagnosticar com a skill `superpowers:systematic-debugging` (sem fixes às cegas). Corrigir a causa raiz, re-rodar `npm test`.

---

## Self-Review

**Cobertura do spec:**
- Recência no GAS por parâmetro + default 90 → Task 1. ✔
- Cache por período + invalidação limpa variações → Task 1 (Steps 3, e invalidação em saveColetas_). ✔
- Bump API 16 verificável → Task 1 (Step 3) + asserções atualizadas (Step 4). ✔
- `getIntercorrenciasAtuais(dias)` no cliente → Task 4. ✔
- Seletor de período + persistência localStorage → Task 5. ✔
- Tabela de resolvidas + dismiss/restore/list idempotentes → Task 2. ✔
- `buildWhatsappQueue` marca `dismissed`, não afeta campanha ativa → Task 3. ✔
- UI resolver/desfazer + toggle, resolvida não selecionável, contadores pela fila exibida → Task 6. ✔
- Nova occurrenceId reaparece após resolver → Task 6 (Step 1, segundo teste). ✔
- Conteúdo escapado → Task 6 usa `escapeHtml` em todos os campos dinâmicos. ✔

**Consistência de tipos/nomes:** `dismissWhatsappOccurrence`/`restoreWhatsappOccurrence`/`getDismissedWhatsappOccurrenceIds` (Task 2) são exatamente os nomes consumidos em Task 6; `dismissedOccurrenceIds` (Task 3) casa com o chamador em `reconcileQueue` (Task 6); `getIntercorrenciasAtuais(dias)` (Task 4) casa com a chamada em `refreshWhatsappQueue` (Task 5); chave de cache `intercorrenciasAtuais:v2:dias=<N>` idêntica entre leitura, escrita, invalidação e testes.

**Placeholders:** nenhum — todo passo traz código e comando reais.
