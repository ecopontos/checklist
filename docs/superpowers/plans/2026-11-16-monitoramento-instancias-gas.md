# Monitoramento de instâncias conectadas via API GAS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a cada instalação do app um id estável que viaja de carona nas chamadas ao GAS, para o servidor registrar numa aba `Instancias` do Google Sheets quem está conectado, com que versão e quando.

**Architecture:** Um módulo cliente novo (`instance-identity.js`) gera/guarda o UUID + apelido e monta os metadados da instância. O `google-sync.js` anexa esses metadados a toda chamada que já faz (query params no GET, campo `inst` no body do POST). O `Code.gs` ganha `recordHeartbeat_`, chamado no topo de `doGet`/`doPost`, que faz *upsert* best-effort numa aba `Instancias`. A versão do app é injetada em build pelo `prepare-dist.js`. Um campo de apelido no `admin.html` alimenta a coluna legível.

**Tech Stack:** JavaScript ES modules (cliente), Google Apps Script (servidor), `node --test` com arquivos `.cjs` + `vm`/`SourceTextModule` (testes).

## Global Constraints

- Heartbeat é **best-effort**: nenhuma falha de registro pode derrubar a ação principal (envolver em `try/catch`).
- Se a instância não enviar `iid`, o servidor ignora o registro e processa a ação normalmente (compatível com chamadas legadas).
- Nenhuma ação nova no contrato GAS e nenhum timer no cliente — só carona nas chamadas existentes.
- Sem UI de monitoramento no app: a visualização é a aba `Instancias` no Sheets. (A única UI nova é o input de apelido no admin.)
- Parâmetros curtos nas chamadas: `iid`, `nick`, `av`, `gu`, `ua`.
- Chave do UUID no localStorage: `satelite.instanceId`. Chave do apelido: `satelite.apelido`. Chave já existente da URL do GAS: `app3_gas_url`.
- Colunas da aba, nesta ordem exata: `instanceId`, `apelido`, `appVersion`, `gasUrlConfig`, `gasApiVersion`, `primeiroAcesso`, `ultimoAcesso`, `ultimaAcao`, `totalChamadas`, `userAgent`.
- Constante da versão da API no servidor: `GAS_API_VERSION` (hoje `16`). Versão do app: `1.7.1` (de `package.json`).

---

## File Structure

- **Create** `instance-identity.js` — identidade da instância e montagem de metadados. Sem dependências do projeto (não importa `google-sync.js`, para evitar import circular).
- **Modify** `google-sync.js` — anexa metadados aos GETs (via `gasGetJsonWithRetry_` e ao GET direto de `roteirosCsv`) e aos POSTs (envolvendo cada body com `withInstanceMeta`).
- **Modify** `gas/Code.gs` — `recordHeartbeat_` + chamada no topo de `doGet`/`doPost` + constante `INSTANCIAS_SHEET`.
- **Modify** `prepare-dist.js` — injeta `window.APP_CONFIG.appVersion` no `dist/config.js` lendo a versão de `package.json`.
- **Modify** `admin.html` — input de apelido do dispositivo, ligado a `setApelido`/`getApelido`.
- **Modify** `package.json` — registra os novos arquivos de teste no script `test`.
- **Create** `tests/instance-identity.test.cjs`, `tests/google-sync-instancia.test.cjs`, `tests/gas-instancias-heartbeat.test.cjs`, `tests/admin-apelido.test.cjs`.

---

### Task 1: Módulo `instance-identity.js`

**Files:**
- Create: `instance-identity.js`
- Test: `tests/instance-identity.test.cjs`

**Interfaces:**
- Consumes: globais do runtime — `localStorage`, `crypto` (opcional), `navigator` (opcional), `window.APP_CONFIG` (opcional).
- Produces:
  - `getInstanceId(): string` — UUID estável, persistido em `localStorage['satelite.instanceId']`.
  - `getApelido(): string`
  - `setApelido(valor: string): void`
  - `getInstanceMeta(gasUrl?: string): { iid, nick, av, gu, ua }`
  - `appendInstanceParams(fullUrl: string, gasUrl?: string): string` — devolve a URL com `&iid=&nick=&av=&gu=&ua=` (valores encodados).
  - `withInstanceMeta(body: object, gasUrl?: string): object` — devolve cópia de `body` com `inst: { iid, nick, av, gu, ua }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/instance-identity.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function load(extra = {}) {
  const storage = new Map();
  const context = vm.createContext({
    console,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    crypto: require('node:crypto').webcrypto,
    navigator: { userAgent: 'TestUA/1.0' },
    window: { APP_CONFIG: { appVersion: '9.9.9' } },
    ...extra
  });
  const mod = new vm.SourceTextModule(fs.readFileSync('instance-identity.js', 'utf8'), { context });
  await mod.link(() => { throw new Error('sem imports esperados'); });
  await mod.evaluate();
  return { mod, storage };
}

test('getInstanceId gera e persiste um UUID estavel', async () => {
  const { mod, storage } = await load();
  const id1 = mod.namespace.getInstanceId();
  const id2 = mod.namespace.getInstanceId();
  assert.equal(id1, id2);
  assert.ok(id1 && id1.length >= 16);
  assert.equal(storage.get('satelite.instanceId'), id1);
});

test('setApelido/getApelido persistem no localStorage', async () => {
  const { mod, storage } = await load();
  mod.namespace.setApelido('Tablet Caminhao 07');
  assert.equal(mod.namespace.getApelido(), 'Tablet Caminhao 07');
  assert.equal(storage.get('satelite.apelido'), 'Tablet Caminhao 07');
});

test('getInstanceMeta devolve iid, nick, av, gu, ua', async () => {
  const { mod } = await load();
  mod.namespace.setApelido('PC Base Norte');
  const meta = mod.namespace.getInstanceMeta('https://ex.test/exec');
  assert.equal(meta.nick, 'PC Base Norte');
  assert.equal(meta.av, '9.9.9');
  assert.equal(meta.gu, 'https://ex.test/exec');
  assert.equal(meta.ua, 'TestUA/1.0');
  assert.ok(meta.iid);
});

test('appendInstanceParams anexa os params encodados', async () => {
  const { mod } = await load();
  mod.namespace.setApelido('Caminhao 7');
  const url = mod.namespace.appendInstanceParams('https://ex.test/exec?action=status', 'https://ex.test/exec');
  assert.ok(url.includes('iid='));
  assert.ok(url.includes('nick=Caminhao%207'));
  assert.ok(url.includes('gu=https%3A%2F%2Fex.test%2Fexec'));
});

test('withInstanceMeta aninha inst sem perder o body original', async () => {
  const { mod } = await load();
  const body = mod.namespace.withInstanceMeta({ action: 'x', ops: [1] }, 'https://ex.test/exec');
  assert.equal(body.action, 'x');
  assert.deepEqual(body.ops, [1]);
  assert.ok(body.inst.iid);
  assert.equal(body.inst.gu, 'https://ex.test/exec');
});

test('fallback de id quando crypto.randomUUID nao existe', async () => {
  const { mod } = await load({ crypto: {} });
  const id = mod.namespace.getInstanceId();
  assert.ok(id && id.length >= 16);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules --test tests/instance-identity.test.cjs`
Expected: FAIL (arquivo `instance-identity.js` não existe / módulo não resolve).

- [ ] **Step 3: Write minimal implementation**

```js
// instance-identity.js
// Identidade estavel por instalacao + metadados enviados de carona ao GAS.
const INSTANCE_ID_KEY = 'satelite.instanceId';
const APELIDO_KEY = 'satelite.apelido';

function newId_() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch (_) { /* contexto sem crypto seguro */ }
    return 'iid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

export function getInstanceId() {
    let id = '';
    try { id = localStorage.getItem(INSTANCE_ID_KEY) || ''; } catch (_) { /* sem storage */ }
    if (!id) {
        id = newId_();
        try { localStorage.setItem(INSTANCE_ID_KEY, id); } catch (_) { /* best-effort */ }
    }
    return id;
}

export function getApelido() {
    try { return localStorage.getItem(APELIDO_KEY) || ''; } catch (_) { return ''; }
}

export function setApelido(valor) {
    try { localStorage.setItem(APELIDO_KEY, String(valor || '').trim()); } catch (_) { /* best-effort */ }
}

function appVersion_() {
    try {
        if (typeof window !== 'undefined' && window.APP_CONFIG && window.APP_CONFIG.appVersion) {
            return String(window.APP_CONFIG.appVersion);
        }
    } catch (_) { /* sem window */ }
    return 'dev';
}

function userAgent_() {
    try { return (typeof navigator !== 'undefined' && navigator.userAgent) || ''; } catch (_) { return ''; }
}

export function getInstanceMeta(gasUrl = '') {
    return {
        iid: getInstanceId(),
        nick: getApelido(),
        av: appVersion_(),
        gu: gasUrl || '',
        ua: userAgent_()
    };
}

export function appendInstanceParams(fullUrl, gasUrl = '') {
    const meta = getInstanceMeta(gasUrl);
    const sep = fullUrl.indexOf('?') === -1 ? '?' : '&';
    const qs = Object.keys(meta)
        .map(k => `${k}=${encodeURIComponent(meta[k])}`)
        .join('&');
    return `${fullUrl}${sep}${qs}`;
}

export function withInstanceMeta(body, gasUrl = '') {
    return { ...body, inst: getInstanceMeta(gasUrl) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules --test tests/instance-identity.test.cjs`
Expected: PASS (6 testes).

- [ ] **Step 5: Commit**

```bash
git add instance-identity.js tests/instance-identity.test.cjs
git commit -m "feat(instancia): modulo instance-identity com UUID e metadados"
```

---

### Task 2: Anexar metadados aos GETs em `google-sync.js`

**Files:**
- Modify: `google-sync.js` (import no topo; `gasGetJsonWithRetry_` ~linha 201; GET direto de `roteirosCsv` ~linha 121)
- Test: `tests/google-sync-instancia.test.cjs`

**Interfaces:**
- Consumes: `appendInstanceParams(fullUrl, gasUrl)` da Task 1; `getGasUrl()` já existente.
- Produces: todo GET ao GAS passa a conter `iid=…` na query.

- [ ] **Step 1: Write the failing test** (cria o arquivo; o teste do POST vem na Task 3)

```js
// tests/google-sync-instancia.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function makeContext(capture) {
  const storage = new Map([['app3_gas_url', 'https://ex.test/exec']]);
  return vm.createContext({
    console, setTimeout, clearTimeout, AbortController,
    crypto: require('node:crypto').webcrypto,
    navigator: { userAgent: 'TestUA/1.0' },
    window: { APP_CONFIG: { appVersion: '9.9.9' } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    fetch: async (url, options) => {
      capture.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, apiVersion: 16, service: 'satelite-gas' }) };
    }
  });
}

async function loadSync(context) {
  function linker(spec) {
    const src = fs.readFileSync(spec.replace('./', ''), 'utf8');
    return new vm.SourceTextModule(src, { context, identifier: spec });
  }
  const sync = new vm.SourceTextModule(fs.readFileSync('google-sync.js', 'utf8'), { context, identifier: 'google-sync.js' });
  await sync.link(async (spec) => {
    const m = linker(spec);
    await m.link(() => { throw new Error('nested import inesperado: ' + spec); });
    return m;
  });
  await sync.evaluate();
  return sync;
}

test('GET de status carrega iid na query', async () => {
  const capture = [];
  const context = makeContext(capture);
  const sync = await loadSync(context);
  await sync.namespace.getGasStatus();
  assert.equal(capture.length >= 1, true);
  assert.ok(capture[0].url.includes('action=status'));
  assert.ok(capture[0].url.includes('iid='));
  assert.ok(capture[0].url.includes('av=9.9.9'));
});
```

> Nota de linking: `google-sync.js` importa `./database.js` e `./instance-identity.js`. O linker acima carrega qualquer dependência de 1º nível pelo caminho do arquivo. `database.js` importa apenas globais, então `link(() => throw)` nela não dispara. Se `database.js` passar a importar algo, ajuste o linker aninhado.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules --test tests/google-sync-instancia.test.cjs`
Expected: FAIL — a URL não contém `iid=` (metadados ainda não anexados).

- [ ] **Step 3: Write minimal implementation**

No topo de `google-sync.js`, logo após os imports existentes, adicione:

```js
import { appendInstanceParams, withInstanceMeta } from './instance-identity.js';
```

Em `gasGetJsonWithRetry_` (atual, ~linha 201), anexe os params antes do fetch. Troque:

```js
async function gasGetJsonWithRetry_(url, { attempts = 3, timeoutMs = 45000 } = {}) {
```

por uma versão que injeta os params uma vez no início do corpo (mantendo o resto igual):

```js
async function gasGetJsonWithRetry_(url, { attempts = 3, timeoutMs = 45000 } = {}) {
    url = appendInstanceParams(url, getGasUrl());
```

No GET direto de `roteirosCsv` (~linha 121), troque:

```js
            res = await fetch(`${url}?action=roteirosCsv`, {
```

por:

```js
            res = await fetch(appendInstanceParams(`${url}?action=roteirosCsv`, url), {
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules --test tests/google-sync-instancia.test.cjs`
Expected: PASS.

- [ ] **Step 5: Run full suite to ensure no GET regressions**

Run: `node --experimental-vm-modules --test tests/google-sync-coletas.test.cjs tests/google-sync-intercorrencias.test.cjs`
Expected: PASS (os GETs agora têm params extras, mas os mocks de fetch não os validam).

- [ ] **Step 6: Commit**

```bash
git add google-sync.js tests/google-sync-instancia.test.cjs
git commit -m "feat(instancia): anexa metadados da instancia nos GETs ao GAS"
```

---

### Task 3: Anexar metadados aos POSTs em `google-sync.js`

**Files:**
- Modify: `google-sync.js` (os 7 bodies de POST)
- Test: `tests/google-sync-instancia.test.cjs` (adiciona um teste de POST)

**Interfaces:**
- Consumes: `withInstanceMeta(body, gasUrl)` da Task 1 (já importado na Task 2).
- Produces: todo POST ao GAS passa a conter `inst: { iid, … }` no body.

- [ ] **Step 1: Write the failing test** (append no mesmo arquivo da Task 2)

```js
test('POST de syncAgendamentos carrega inst no body', async () => {
  const capture = [];
  const context = makeContext(capture);
  const sync = await loadSync(context);
  await sync.namespace.syncAgendamentos([{ id: 'a1' }]);
  const post = capture.find(c => c.options && c.options.method === 'POST');
  assert.ok(post, 'esperado um POST');
  const body = JSON.parse(post.options.body);
  assert.equal(body.action, 'syncAgendamentos');
  assert.ok(body.inst && body.inst.iid, 'esperado inst.iid no body');
  assert.equal(body.inst.av, '9.9.9');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules --test tests/google-sync-instancia.test.cjs`
Expected: FAIL — `body.inst` indefinido.

- [ ] **Step 3: Write minimal implementation** — envolva cada body de POST com `withInstanceMeta(…, url)`. São 7 call sites. Faça cada troca exata:

1. `pushColetas` (~linha 60): `body: JSON.stringify({ coletas })` → `body: JSON.stringify(withInstanceMeta({ coletas }, url))`
2. `syncAgendamentos` (~linha 298): `body: JSON.stringify({ action: 'syncAgendamentos', ops })` → `body: JSON.stringify(withInstanceMeta({ action: 'syncAgendamentos', ops }, url))`
3. `uploadAgendamentoFotos` (~linha 317): o body é um objeto multi-linha `JSON.stringify({ … })`; envolva a chamada: `body: JSON.stringify({` → `body: JSON.stringify(withInstanceMeta({` e feche o parêntese extra: o `})` que fecha o `JSON.stringify` vira `}, url))`.
4. `sendChecklistToDrive` (~linha 349): `body: JSON.stringify({ checklist: { filename, pdfBase64 } })` → `body: JSON.stringify(withInstanceMeta({ checklist: { filename, pdfBase64 } }, url))`
5. `pushRoteiroChanges` (~linha 374): body multi-linha; mesma técnica do item 3 (`JSON.stringify({` → `JSON.stringify(withInstanceMeta({` e `})` final → `}, url))`).
6. `pushClienteChanges` (~linha 456): `body: JSON.stringify({ action: 'clientChanges', token, changes })` → `body: JSON.stringify(withInstanceMeta({ action: 'clientChanges', token, changes }, url))`
7. `postCadastro_` (~linha 541): `body: JSON.stringify(body)` → `body: JSON.stringify(withInstanceMeta(body, url))`

> Em todos, `url` já está no escopo da função (é a URL do GAS obtida logo antes do `fetch`). Para os bodies multi-linha (itens 3 e 5), confira que o fechamento passou de `})` para `}, url))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules --test tests/google-sync-instancia.test.cjs`
Expected: PASS.

- [ ] **Step 5: Run POST-related suites to ensure no regressions**

Run: `node --experimental-vm-modules --test tests/google-sync-coletas.test.cjs tests/cadastro-sync.test.cjs tests/client-edit-flow.test.cjs tests/rotas-drive-sync.test.cjs`
Expected: PASS. (Os mocks leem `coletas`/`ops`/`changes` do body; o campo extra `inst` não quebra.)

- [ ] **Step 6: Commit**

```bash
git add google-sync.js tests/google-sync-instancia.test.cjs
git commit -m "feat(instancia): anexa metadados da instancia nos POSTs ao GAS"
```

---

### Task 4: `recordHeartbeat_` no GAS + wiring em `doGet`/`doPost`

**Files:**
- Modify: `gas/Code.gs` (constante `INSTANCIAS_SHEET`; função `recordHeartbeat_`; topo de `doGet` ~linha 71 e `doPost` ~linha 908)
- Test: `tests/gas-instancias-heartbeat.test.cjs`

**Interfaces:**
- Consumes: `getConfig_().spreadsheetId`, `GAS_API_VERSION`, APIs mockadas `SpreadsheetApp`, `LockService`, `Logger`.
- Produces: `recordHeartbeat_(source, meta)` que faz upsert na aba `Instancias`; registro disparado no início de cada requisição.

- [ ] **Step 1: Write the failing test**

```js
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
  assert.deepEqual(rows[0], ['instanceId','apelido','appVersion','gasUrlConfig','gasApiVersion','primeiroAcesso','ultimoAcesso','ultimaAcao','totalChamadas','userAgent']);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/gas-instancias-heartbeat.test.cjs`
Expected: FAIL — `g.recordHeartbeat_` não é função.

- [ ] **Step 3: Write minimal implementation** — em `gas/Code.gs`.

Adicione a constante perto das outras do topo (ex.: logo após `var GAS_API_VERSION = 16;`):

```js
var INSTANCIAS_SHEET = 'Instancias';
```

Adicione a função (pode ir logo antes de `function doGet(e) {`):

```js
function recordHeartbeat_(source, meta) {
    try {
        if (!meta || !meta.iid) { return; }
        var config = getConfig_();
        if (!config.spreadsheetId) { return; }
        var lock = LockService.getScriptLock();
        try { lock.waitLock(2000); } catch (e) { return; }
        try {
            var ss = SpreadsheetApp.openById(config.spreadsheetId);
            var sh = ss.getSheetByName(INSTANCIAS_SHEET);
            if (!sh) {
                sh = ss.insertSheet(INSTANCIAS_SHEET);
                sh.appendRow(['instanceId', 'apelido', 'appVersion', 'gasUrlConfig',
                    'gasApiVersion', 'primeiroAcesso', 'ultimoAcesso', 'ultimaAcao',
                    'totalChamadas', 'userAgent']);
            }
            var now = new Date();
            var data = sh.getDataRange().getValues();
            var rowIndex = -1;
            for (var i = 1; i < data.length; i++) {
                if (String(data[i][0]) === String(meta.iid)) { rowIndex = i + 1; break; }
            }
            if (rowIndex === -1) {
                sh.appendRow([meta.iid, meta.nick || '', meta.av || '', meta.gu || '',
                    GAS_API_VERSION, now, now, source || '', 1, meta.ua || '']);
            } else {
                var prev = data[rowIndex - 1];
                var total = (Number(prev[8]) || 0) + 1;
                var primeiro = prev[5] || now;
                sh.getRange(rowIndex, 1, 1, 10).setValues([[
                    meta.iid,
                    meta.nick || prev[1] || '',
                    meta.av || '',
                    meta.gu || '',
                    GAS_API_VERSION,
                    primeiro,
                    now,
                    source || '',
                    total,
                    meta.ua || prev[9] || ''
                ]]);
            }
        } finally {
            lock.releaseLock();
        }
    } catch (err) {
        try { Logger.log('recordHeartbeat falhou: ' + err); } catch (_) { /* ignora */ }
    }
}
```

No topo de `doGet(e)`, logo após `var params = (e && e.parameter) || {};`, adicione:

```js
    recordHeartbeat_(params.action || 'get', {
        iid: params.iid, nick: params.nick, av: params.av, gu: params.gu, ua: params.ua
    });
```

No topo de `doPost(e)`, dentro do `try`, logo após `var body = JSON.parse(e.postData.contents);`, adicione:

```js
        recordHeartbeat_(body.action || 'post', body.inst || {});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/gas-instancias-heartbeat.test.cjs`
Expected: PASS (5 testes).

- [ ] **Step 5: Run GAS suites to ensure doGet/doPost still work**

Run: `node --test tests/gas-dashboard.test.cjs tests/gas-cadastro.test.cjs && node tests/gas-checklist-integrity.test.cjs`
Expected: PASS. (Os mocks desses testes não definem `insertSheet`, mas o heartbeat só dispara quando vem `iid`, que esses testes não enviam — então nunca abre a aba.)

- [ ] **Step 6: Commit**

```bash
git add gas/Code.gs tests/gas-instancias-heartbeat.test.cjs
git commit -m "feat(instancia): recordHeartbeat_ e registro no doGet/doPost do GAS"
```

---

### Task 5: Injetar `appVersion` no build (`prepare-dist.js`)

**Files:**
- Modify: `prepare-dist.js` (após a cópia dos assets para `dist/`)

**Interfaces:**
- Consumes: `package.json` (campo `version`).
- Produces: `dist/config.js` termina com `window.APP_CONFIG.appVersion = '<versao>';`, consumido por `instance-identity.js` via `window.APP_CONFIG.appVersion`.

- [ ] **Step 1: Write the implementation** — no fim de `prepare-dist.js` (após o loop que copia os arquivos de raiz, antes de qualquer `console.log` final), adicione:

```js
// Injeta a versao do app no config.js do dist, para a instancia reportar `av`.
const pkgVersion = require('./package.json').version;
const distConfig = path.join(DIST, 'config.js');
if (fs.existsSync(distConfig)) {
  const extra = `\nwindow.APP_CONFIG = window.APP_CONFIG || {};\nwindow.APP_CONFIG.appVersion = ${JSON.stringify(pkgVersion)};\n`;
  fs.appendFileSync(distConfig, extra);
}
```

- [ ] **Step 2: Run the build step and verify the injection**

Run: `node prepare-dist.js && grep -n "appVersion" dist/config.js`
Expected: imprime uma linha `window.APP_CONFIG.appVersion = "1.7.1";` (a versão atual de `package.json`).

- [ ] **Step 3: Confirm the generated config is valid JS**

Run: `node -e "global.window={};require('./dist/config.js');console.log(window.APP_CONFIG.appVersion)"`
Expected: imprime `1.7.1`.

- [ ] **Step 4: Commit**

```bash
git add prepare-dist.js
git commit -m "build(instancia): injeta appVersion no config.js do dist"
```

---

### Task 6: Campo de apelido no `admin.html`

**Files:**
- Modify: `admin.html` (input novo na seção de config do GAS ~linha 273; import e wiring no módulo inline ~linha 339)
- Test: `tests/admin-apelido.test.cjs`

**Interfaces:**
- Consumes: `getApelido`, `setApelido` de `instance-identity.js` (Task 1).
- Produces: input `#deviceApelido` que persiste o apelido via `setApelido`.

- [ ] **Step 1: Write the failing test** (verificação estática do HTML — garante input + import + wiring presentes)

```js
// tests/admin-apelido.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('admin.html', 'utf8');

test('admin.html tem input de apelido do dispositivo', () => {
  assert.match(html, /id="deviceApelido"/);
});

test('admin.html importa e usa setApelido/getApelido', () => {
  assert.match(html, /instance-identity\.js/);
  assert.match(html, /setApelido/);
  assert.match(html, /getApelido/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/admin-apelido.test.cjs`
Expected: FAIL — nenhum `deviceApelido`/`setApelido` em `admin.html`.

- [ ] **Step 3: Write minimal implementation**

No HTML, logo após o input do token de roteiros (`<input ... id="gasRouteToken" ...>`, ~linha 274), adicione:

```html
                    <input type="text" id="deviceApelido" placeholder="Apelido deste dispositivo (ex.: Tablet Caminhão 07)">
```

No módulo inline, no bloco de imports de `./google-sync.js` (~linha 339), adicione um import novo logo após ele:

```js
        import { getApelido, setApelido } from './instance-identity.js';
```

Na mesma função onde `#gasUrl` é inicializado (junto das linhas que fazem `document.getElementById('gasUrl').value = getGasUrl();`), adicione:

```js
            document.getElementById('deviceApelido').value = getApelido();
            document.getElementById('deviceApelido').onchange = (e) => {
                setApelido(e.target.value.trim());
            };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/admin-apelido.test.cjs`
Expected: PASS (2 testes).

- [ ] **Step 5: Ensure navigation/admin smoke tests still pass**

Run: `node --test tests/navegacao.test.cjs tests/admin-sync-status.test.cjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add admin.html tests/admin-apelido.test.cjs
git commit -m "feat(instancia): input de apelido do dispositivo no admin"
```

---

### Task 7: Registrar os novos testes no `package.json`

**Files:**
- Modify: `package.json` (script `test`)

**Interfaces:**
- Consumes: os 4 arquivos de teste criados nas tasks anteriores.
- Produces: `npm test` cobre o monitoramento de instâncias.

- [ ] **Step 1: Add the new test files to the `test` script**

Ao final do valor da chave `"test"` em `package.json`, antes do fechamento das aspas, acrescente (encadeado com `&&`):

```
 && node --experimental-vm-modules --test tests/instance-identity.test.cjs && node --experimental-vm-modules --test tests/google-sync-instancia.test.cjs && node --test tests/gas-instancias-heartbeat.test.cjs && node --test tests/admin-apelido.test.cjs
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: PASS em toda a suíte, incluindo os 4 novos arquivos.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test(instancia): registra os testes de monitoramento no npm test"
```

---

## Notas de implantação (pós-merge, manuais — fora do escopo de código)

- Após mergear, **republicar o deployment do GAS** (novo code → nova versão do web app) para `recordHeartbeat_` entrar em produção. Instâncias apontando para o deployment antigo não aparecerão na aba — essa ausência é o próprio sinal de órfão (ver spec).
- A aba `Instancias` é criada automaticamente na primeira chamada com `iid`. Para "alerta de offline", aplicar uma formatação condicional na coluna `ultimoAcesso` (ex.: destacar quando a diferença para agora passar de 24h).
- Builds de campo que devem reportar a versão correta precisam passar por `npm run build` (que roda `prepare-dist.js`). Em `tauri dev`, `av` aparece como `dev`.

---

## Self-Review

- **Cobertura do spec:** identidade (Task 1), heartbeat por carona GET+POST (Tasks 2–3), aba/upsert/best-effort/lock no GAS (Task 4), `appVersion` em build (Task 5), apelido legível (Task 6), testes no CI local (Task 7). Diagnóstico de órfão coberto por `gasUrlConfig`/ausência (Task 4 + notas). Alerta offline = inspeção na planilha (notas). ✔
- **Placeholders:** nenhum — todo passo tem código/comando real. ✔
- **Consistência de tipos:** `getInstanceMeta`/`appendInstanceParams`/`withInstanceMeta` definidos na Task 1 e consumidos com a mesma assinatura nas Tasks 2–3; `recordHeartbeat_(source, meta)` com `meta = {iid,nick,av,gu,ua}` idêntico entre cliente (params/`inst`) e servidor (Task 4); ordem das colunas igual em Global Constraints, Task 4 e teste. ✔
