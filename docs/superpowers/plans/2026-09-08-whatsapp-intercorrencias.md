# Disparo WhatsApp — filtro por intercorrência Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No módulo de disparo WhatsApp, permitir filtrar os contatos de um roteiro para só quem teve uma intercorrência (problema) registrada na última coleta, lendo esse dado direto da planilha do Google (fonte compartilhada entre todos os dispositivos), e usar o texto da intercorrência na mensagem via `{intercorrencia}`.

**Architecture:** Novo endpoint de leitura no Apps Script (`gas/Code.gs`) expõe, por roteiro, a última coleta de cada cliente com intercorrência não vazia. Um wrapper fino em `google-sync.js` chama esse endpoint. `whatsapp-sender.html` ganha um toggle que, ligado, busca essas intercorrências para os roteiros selecionados e filtra a lista de contatos.

**Tech Stack:** Google Apps Script (`gas/Code.gs`), ES modules (`google-sync.js`, `whatsapp-sender.html`), Node `vm` module para testes de `Code.gs` e `google-sync.js`.

## Global Constraints

- `gas/Code.gs` é testável via `vm.runInContext` com mocks de `SpreadsheetApp`/`PropertiesService`/`ContentService`/`CacheService` — ver `tests/gas-route-queue.test.cjs` para o padrão (`SheetMock`/`RangeMock`, contexto único por arquivo de teste).
- Testes de `google-sync.js` seguem o padrão de `tests/rotas-rede-sync.test.cjs`: contexto `vm` isolado, `database.js` e `google-sync.js` carregados como `vm.SourceTextModule` com `module.link` resolvendo o import relativo entre eles.
- Mudanças em `gas/Code.gs` exigem **redeploy manual do Apps Script pelo usuário** — isso não pode ser testado nem automatizado por este repositório. O plano trata isso como uma etapa explícita, não como parte dos testes automatizados.
- Novos testes entram na cadeia do script `test` em `package.json`, mesma convenção `node --experimental-vm-modules tests/<nome>.test.cjs` (ou `node tests/<nome>.test.cjs` sem VM modules, para o teste de `Code.gs`, que não usa ES modules).
- `whatsapp-sender.html` não tem framework de teste de UI automatizado — verificação é manual, no navegador, com a chamada de rede simulada via `browser_evaluate` (não há como testar contra um GAS real).
- Não alterar `REQUIRED_GAS_API_VERSION` em `google-sync.js` — essa constante governa o gate do recurso *não relacionado* de auto-import de roteiros pela rede; bumpar o `GAS_API_VERSION` do servidor (em `gas/Code.gs`) é o suficiente para sinalizar a nova capacidade, sem forçar todo mundo a redeployar antes de continuar usando o auto-import.

---

## Task 1: Endpoint `intercorrenciasRoteiro` em `gas/Code.gs`

**Files:**
- Modify: `gas/Code.gs`
  - `var GAS_API_VERSION = 6;` (linha 35) → `7`
  - `doGet` (por volta da linha 76-79): adicionar roteamento da nova action
  - Após o fim de `getUltimaColetaDetalhada_` (por volta da linha 407-408): adicionar a nova função
- Test: `tests/gas-intercorrencias.test.cjs`

**Interfaces:**
- Produces: GAS action `intercorrenciasRoteiro` (GET, parâmetro `roteiro`) → `{ ok: true, data: [{ id_rota: string, intercorrencia: string, data: string }, ...] }`. Cada item representa um cliente do roteiro cuja coleta de data mais recente tem a coluna "Intercorrência" não vazia (diferente de `ultimaColetaDetalhada`, aqui **não se filtra por quantidade** — uma intercorrência típica é registrada com quantidade 0). Consumido por `getIntercorrenciasRoteiro` em `google-sync.js` (Task 2).

- [ ] **Step 1: Escrever o teste (falhando)**

Criar `tests/gas-intercorrencias.test.cjs`:

```js
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
}

class SheetMock {
  constructor() { this.rows = []; }
  getRange(row, column, rows = 1, columns = 1) {
    return new RangeMock(this, row, column, rows, columns);
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((max, row) => Math.max(max, row.length), 0); }
}

const sheets = new Map();
const spreadsheet = {
  getSheetByName: name => sheets.get(name) || null
};

const cacheStore = new Map();

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
      getProperty: key => ({ SPREADSHEET_ID: 'spreadsheet-test' })[key] || ''
    })
  },
  SpreadsheetApp: { openById: () => spreadsheet },
  CacheService: {
    getScriptCache: () => ({
      get: key => cacheStore.has(key) ? cacheStore.get(key) : null,
      put: (key, value) => { cacheStore.set(key, value); }
    })
  },
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

const HEADER = ['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID'];
const coletasSheet = new SheetMock();
coletasSheet.rows = [HEADER];
coletasSheet.rows.push(['1', '2026-08-01', 'CLIENTE 1', 'ROTA X', 5, '', '', '']);
coletasSheet.rows.push(['1', '2026-09-01', 'CLIENTE 1', 'ROTA X', 3, 'Bombona suja', '', '']);
coletasSheet.rows.push(['2', '2026-09-02', 'CLIENTE 2', 'ROTA X', 0, 'Recusou coleta', '', '']);
coletasSheet.rows.push(['3', '2026-08-15', 'CLIENTE 3', 'ROTA X', 2, 'Vazamento', '', '']);
coletasSheet.rows.push(['3', '2026-09-03', 'CLIENTE 3', 'ROTA X', 4, '', '', '']);
coletasSheet.rows.push(['4', '2026-09-01', 'CLIENTE 4', 'ROTA Y', 1, 'Problema em outro roteiro', '', '']);
sheets.set('Coletas', coletasSheet);

const result = JSON.parse(context.doGet({ parameter: { action: 'intercorrenciasRoteiro', roteiro: 'ROTA X' } }).value);

assert.strictEqual(result.ok, true);
assert.strictEqual(result.data.length, 2, 'so cliente 1 (ultima coleta com intercorrencia) e cliente 2 (quantidade 0 nao filtra) devem aparecer');

const cliente1 = result.data.find(item => item.id_rota === '1');
assert.ok(cliente1, 'cliente 1 deve aparecer (ultima coleta, 2026-09-01, tem intercorrencia)');
assert.strictEqual(cliente1.intercorrencia, 'Bombona suja');
assert.strictEqual(cliente1.data, '2026-09-01');

const cliente2 = result.data.find(item => item.id_rota === '2');
assert.ok(cliente2, 'cliente 2 deve aparecer mesmo com quantidade 0 na ultima coleta');
assert.strictEqual(cliente2.intercorrencia, 'Recusou coleta');

assert.ok(!result.data.some(item => item.id_rota === '3'), 'cliente 3: ultima coleta (2026-09-03) esta sem intercorrencia, mesmo tendo tido uma antes -> nao deve aparecer');
assert.ok(!result.data.some(item => item.id_rota === '4'), 'cliente 4 e de outro roteiro (ROTA Y) -> nao deve aparecer na consulta de ROTA X');

console.log('intercorrenciasRoteiro: pega so a ultima coleta de cada cliente, ignora quantidade, filtra por roteiro: OK');
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node tests/gas-intercorrencias.test.cjs`
Expected: FAIL — `result.ok` é `undefined` (ou erro de parse), porque `doGet` cai no `getRoteirosFlat_()` default (que por sua vez falha por falta das abas `tblRotas`/`shtClientes`/`tblRoteiros` no mock), já que a action `intercorrenciasRoteiro` ainda não existe.

- [ ] **Step 3: Bumpar `GAS_API_VERSION`**

Em `gas/Code.gs`, linha 35:
```js
var GAS_API_VERSION = 6;
```
vira:
```js
var GAS_API_VERSION = 7;
```

- [ ] **Step 4: Adicionar o roteamento em `doGet`**

Em `gas/Code.gs`, logo após o bloco de `ultimaColetaDetalhada` e antes do bloco de `agendamentos`:

```js
    if (params.action === 'ultimaColetaDetalhada') {
        return getUltimaColetaDetalhada_(params.roteiro || '');
    }

    if (params.action === 'intercorrenciasRoteiro') {
        return getIntercorrenciasRoteiro_(params.roteiro || '');
    }

    if (params.action === 'agendamentos') {
```

- [ ] **Step 5: Implementar `getIntercorrenciasRoteiro_`**

Em `gas/Code.gs`, logo após o fechamento de `getUltimaColetaDetalhada_` (a função termina com `}` seguido de linha em branco, antes do próximo bloco de função):

```js
// Le a aba Coletas e devolve, por cliente do roteiro pedido, a intercorrencia
// da coleta MAIS RECENTE desse cliente (nao a data mais recente do roteiro
// inteiro, como em getUltimaColetaDetalhada_ — um cliente pode ter sido
// coletado num dia diferente do resto do roteiro). Nao filtra por
// quantidade: uma intercorrencia tipica ("recusou coleta", "sem bombona") e
// registrada com quantidade 0, e getUltimaColetaDetalhada_ descartaria
// exatamente esses registros.
function getIntercorrenciasRoteiro_(roteiroNome) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }
    if (!roteiroNome) {
        return jsonResponse_({ ok: false, error: 'Parâmetro roteiro ausente' });
    }

    try {
        var ss = SpreadsheetApp.openById(config.spreadsheetId);
        var sheet = ss.getSheetByName(COLETAS_SHEET_NAME);
        if (!sheet || sheet.getLastRow() < 2) {
            return jsonResponse_({ ok: true, data: [] });
        }

        var roteiroAlvo = roteiroNome.trim();
        var lastRow = sheet.getLastRow();

        var cache = CacheService.getScriptCache();
        var cacheKey = 'ic:' + lastRow + ':' + roteiroAlvo;
        var cached = cache.get(cacheKey);
        if (cached !== null) {
            return jsonResponse_({ ok: true, data: JSON.parse(cached) });
        }

        var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        var colIdRota = header.indexOf('ID Rota');
        var colData = header.indexOf('Data');
        var colRoteiro = header.indexOf('Roteiro');
        var colIntercorrencia = header.indexOf('Intercorrência');
        if (colIdRota === -1 || colData === -1 || colRoteiro === -1 || colIntercorrencia === -1) {
            return jsonResponse_({ ok: false, error: 'Colunas ID Rota/Data/Roteiro/Intercorrência não encontradas na aba ' + COLETAS_SHEET_NAME });
        }

        var wanted = [colIdRota, colData, colRoteiro, colIntercorrencia];
        var minCol = Math.min.apply(null, wanted);
        var width = Math.max.apply(null, wanted) - minCol + 1;
        var iOff = colIdRota - minCol;
        var dOff = colData - minCol;
        var rOff = colRoteiro - minCol;
        var xOff = colIntercorrencia - minCol;

        function computeFromRange(startRow) {
            var num = lastRow - startRow + 1;
            if (num < 1) return null;
            var values = sheet.getRange(startRow, minCol + 1, num, width).getValues();
            var ultimaPorPonto = {};
            var achouRoteiro = false;
            for (var i = 0; i < values.length; i++) {
                if (String(values[i][rOff]).trim() !== roteiroAlvo) continue;
                achouRoteiro = true;
                var idRota = String(values[i][iOff]).trim();
                if (!idRota) continue;
                var normalized = normalizeDateValue_(values[i][dOff]);
                if (!normalized) continue;
                var atual = ultimaPorPonto[idRota];
                if (!atual || normalized > atual.data) {
                    ultimaPorPonto[idRota] = {
                        data: normalized,
                        intercorrencia: String(values[i][xOff] || '').trim()
                    };
                }
            }
            // achouRoteiro=false sinaliza "roteiro nao aparece nesta janela",
            // dispara o fallback de varredura completa. achouRoteiro=true com
            // ultimaPorPonto vazio (ou so intercorrencias vazias) e um
            // resultado valido: retorna [] em vez de forcar a varredura toda.
            if (!achouRoteiro) return null;
            return Object.keys(ultimaPorPonto)
                .map(function (idRota) {
                    return {
                        id_rota: idRota,
                        data: ultimaPorPonto[idRota].data,
                        intercorrencia: ultimaPorPonto[idRota].intercorrencia
                    };
                })
                .filter(function (ponto) { return ponto.intercorrencia !== ''; });
        }

        var recentStart = Math.max(2, lastRow - COLETAS_RECENT_ROWS + 1);
        var data = computeFromRange(recentStart);
        if (data === null && recentStart > 2) {
            data = computeFromRange(2);
        }
        if (data === null) data = [];

        cache.put(cacheKey, JSON.stringify(data), 21600);
        return jsonResponse_({ ok: true, data: data });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

Run: `node tests/gas-intercorrencias.test.cjs`
Expected: PASS — imprime `intercorrenciasRoteiro: pega so a ultima coleta de cada cliente, ignora quantidade, filtra por roteiro: OK`

- [ ] **Step 7: Adicionar o teste à cadeia do script `test`**

Em `package.json`, `scripts.test`, adicionar ` && node tests/gas-intercorrencias.test.cjs` ao final (sem `--experimental-vm-modules`, já que este teste roda `gas/Code.gs` direto via `vm.runInContext`, sem ES modules — mesmo padrão de `tests/gas-route-queue.test.cjs` e `tests/gas-client-queue.test.cjs`, que também não usam a flag).

- [ ] **Step 8: Rodar a suíte completa**

Run: `npm test`
Expected: todos os testes passam, incluindo o novo.

- [ ] **Step 9: Commit**

```bash
git add gas/Code.gs tests/gas-intercorrencias.test.cjs package.json
git commit -m "feat(gas): adiciona endpoint intercorrenciasRoteiro para leitura da aba Coletas"
```

**Nota para quem for aplicar em produção (não é um passo automatizável):** este endpoint só funciona depois que o Apps Script for reimplantado (Deploy > Manage deployments > editar a implantação existente) com o conteúdo atualizado de `gas/Code.gs`. Sem o redeploy, chamadas para `action=intercorrenciasRoteiro` caem no fallback padrão do `doGet` (retorna o payload de `getRoteirosFlat_()`, sem o campo `data`) — é exatamente esse cenário que a Task 3 precisa tratar como "recurso indisponível".

---

## Task 2: Wrapper `getIntercorrenciasRoteiro` em `google-sync.js`

**Files:**
- Modify: `google-sync.js` (adicionar logo após `getUltimasQuantidades`, por volta da linha 229)
- Modify: `package.json` (adicionar o novo teste à cadeia do script `test`)
- Test: `tests/google-sync-intercorrencias.test.cjs`

**Interfaces:**
- Consumes: GAS action `intercorrenciasRoteiro` (Task 1).
- Produces: `getIntercorrenciasRoteiro(roteiroNome: string) => Promise<{ ok: boolean, data?: Array<{id_rota, intercorrencia, data}>, error?: string }>`. Consumido por `whatsapp-sender.html` (Task 3).

- [ ] **Step 1: Escrever o teste (falhando)**

Criar `tests/google-sync-intercorrencias.test.cjs`:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createContext() {
  const storage = new Map();
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const requests = [];
  let fetchImpl = async () => { throw new Error('fetch nao deveria ser chamado neste cenario'); };
  const context = vm.createContext({
    console, localStorage, window: undefined, globalThis: null,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    AbortController,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    }),
    fetch: async (url, options) => {
      requests.push(url);
      return fetchImpl(url, options);
    }
  });
  context.globalThis = context;
  return { context, localStorage, requests, setFetchImpl: fn => { fetchImpl = fn; } };
}

const moduleCache = new Map();
async function loadModule(context, filename) {
  if (moduleCache.has(filename)) return moduleCache.get(filename).namespace;
  const source = fs.readFileSync(filename, 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: filename });
  moduleCache.set(filename, module);
  await module.link(async specifier => {
    const resolved = specifier.replace(/^\.\//, '');
    if (moduleCache.has(resolved)) return moduleCache.get(resolved);
    throw new Error(`Import inesperado em ${filename}: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

(async () => {
  const { context, localStorage, requests, setFetchImpl } = createContext();
  await loadModule(context, 'database.js');
  const syncModule = await loadModule(context, 'google-sync.js');

  // Sem URL do GAS configurada: nao tenta chamar a rede.
  const semUrl = await syncModule.getIntercorrenciasRoteiro('ROTA X');
  assert.deepStrictEqual(semUrl, { ok: false, error: 'URL do GAS não configurada' });
  assert.strictEqual(requests.length, 0, 'nao deveria ter chamado fetch sem URL configurada');

  // Com URL configurada: monta a query corretamente (roteiro com espaco
  // precisa vir url-encoded) e repassa a resposta do GAS como veio.
  localStorage.setItem('app3_gas_url', 'https://gas.example/exec');
  setFetchImpl(async () => ({
    ok: true,
    json: async () => ({ ok: true, data: [{ id_rota: '42', intercorrencia: 'Bombona suja', data: '2026-09-01' }] })
  }));

  const resultado = await syncModule.getIntercorrenciasRoteiro('ROTA CENTRO LESTE');
  assert.deepStrictEqual(resultado, { ok: true, data: [{ id_rota: '42', intercorrencia: 'Bombona suja', data: '2026-09-01' }] });
  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0], 'https://gas.example/exec?action=intercorrenciasRoteiro&roteiro=ROTA%20CENTRO%20LESTE');

  console.log('getIntercorrenciasRoteiro: sem URL retorna erro sem chamar fetch; com URL monta query e repassa resposta: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --experimental-vm-modules tests/google-sync-intercorrencias.test.cjs`
Expected: FAIL — `syncModule.getIntercorrenciasRoteiro is not a function`

- [ ] **Step 3: Implementar `getIntercorrenciasRoteiro`**

Em `google-sync.js`, logo após `getUltimasQuantidades` (por volta da linha 229):

```js
export async function getIntercorrenciasRoteiro(roteiroNome) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    return gasGetJsonWithRetry_(
        `${url}?action=intercorrenciasRoteiro&roteiro=${encodeURIComponent(roteiroNome)}`
    );
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --experimental-vm-modules tests/google-sync-intercorrencias.test.cjs`
Expected: PASS

- [ ] **Step 5: Adicionar o teste à cadeia do script `test`**

Em `package.json`, `scripts.test`, adicionar ` && node --experimental-vm-modules tests/google-sync-intercorrencias.test.cjs` ao final.

- [ ] **Step 6: Rodar a suíte completa**

Run: `npm test`
Expected: todos os testes passam (os da Task 1 + este).

- [ ] **Step 7: Commit**

```bash
git add google-sync.js tests/google-sync-intercorrencias.test.cjs package.json
git commit -m "feat(sync): adiciona getIntercorrenciasRoteiro para consultar intercorrencias no GAS"
```

---

## Task 3: Toggle "Só com intercorrência" em `whatsapp-sender.html`

**Files:**
- Modify: `whatsapp-sender.html`

**Interfaces:**
- Consumes: `getIntercorrenciasRoteiro(roteiroNome)` de `google-sync.js` (Task 2); `contacts`/`selectedRoteiroIds`/`allRoteiros`/`buildPendingContacts`/`renderContactPreview`/`renderRoteiroChips`/`toggleRoteiro`/`buildMsg`/`restart` já existentes em `whatsapp-sender.html` (ver `docs/superpowers/plans/2026-09-08-whatsapp-sender-integracao-banco.md`).

O arquivo atual (na íntegra) está em `whatsapp-sender.html` no worktree — os passos abaixo são edições pontuais sobre ele, não uma reescrita completa.

- [ ] **Step 1: Adicionar a tag `{intercorrencia}` na dica da mensagem**

Em `whatsapp-sender.html`, dentro do passo 2 (Mensagem), substituir:

```html
    <div class="tag-hint">Use <code>{nome}</code> para personalizar com o nome do estabelecimento.</div>
```

por:

```html
    <div class="tag-hint">Use <code>{nome}</code> para personalizar com o nome do estabelecimento e <code>{intercorrencia}</code> para citar o problema da última coleta.</div>
```

- [ ] **Step 2: Adicionar o toggle no passo 1, entre a tabela de preview e os botões**

Substituir:

```html
  <div id="previewWrap"></div>

  <div class="actions">
    <button class="btn btn-primary" id="btnToMsg" disabled>Próximo →</button>
  </div>
</div>
```

por:

```html
  <div id="previewWrap"></div>

  <div class="field" id="intercorrenciaWrap" style="display:none; margin-bottom:0;">
    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:var(--text-dim);">
      <input type="checkbox" id="chkIntercorrencia" onchange="toggleSomenteIntercorrencia()">
      Só com intercorrência (última coleta)
    </label>
    <div class="hint" id="intercorrenciaStatus" style="display:none; margin-top:8px;"></div>
  </div>

  <div class="actions">
    <button class="btn btn-primary" id="btnToMsg" disabled>Próximo →</button>
  </div>
</div>
```

- [ ] **Step 3: Importar o novo wrapper**

Substituir:

```js
import db from './database.js';
```

por:

```js
import db from './database.js';
import { getIntercorrenciasRoteiro } from './google-sync.js';
```

- [ ] **Step 4: Adicionar o novo estado**

Substituir:

```js
let contacts = [];                // [{idRota, slot, nome, labelSufixo, telefoneExibicao, telefoneDigits, roteiroNome}]
let statuses = [];                // 'pending' | 'sent' | 'skip', paralelo a contacts
let current  = 0;
let message  = '';
```

por:

```js
let contacts = [];                // [{idRota, slot, nome, labelSufixo, telefoneExibicao, telefoneDigits, roteiroNome}]
let statuses = [];                // 'pending' | 'sent' | 'skip', paralelo a contacts
let current  = 0;
let message  = '';
let somenteIntercorrencia = false;
let intercorrenciasPorIdRota = new Map(); // idRota (string) -> { intercorrencia, data }
let intercorrenciasCarregadas = new Set(); // nomes de roteiro ja buscados nesta sessao
```

- [ ] **Step 5: Extrair `getVisibleContacts` e adicionar `ensureIntercorrenciasCarregadas`**

Substituir a função `buildPendingContacts` inteira (mantendo-a como está) acrescentando as duas novas funções logo depois dela:

```js
function buildPendingContacts() {
  const list = [];
  selectedRoteiroIds.forEach(id => {
    db.getContatosWhatsapp(id).forEach(c => list.push(c));
  });
  const countByIdRota = {};
  list.forEach(c => { countByIdRota[c.idRota] = (countByIdRota[c.idRota] || 0) + 1; });
  list.forEach(c => {
    c.labelSufixo = countByIdRota[c.idRota] > 1 ? ` (tel ${c.slot})` : '';
    c.key = `${c.idRota}:${c.slot}`;
  });
  return list;
}

function getVisibleContacts() {
  return buildPendingContacts().filter(c => !somenteIntercorrencia || intercorrenciasPorIdRota.has(c.idRota));
}

// Busca no GAS as intercorrencias dos roteiros selecionados que ainda nao
// foram carregados nesta sessao. Retorna false (e mostra erro) se alguma
// busca falhar ou vier em formato inesperado — isso acontece quando o GAS
// ainda nao foi redeployado com a action intercorrenciasRoteiro: o doGet cai
// no fallback padrao (getRoteirosFlat_, que devolve `rows`, nao `data`), e a
// checagem Array.isArray(res.data) pega exatamente esse caso.
async function ensureIntercorrenciasCarregadas() {
  const statusEl = document.getElementById('intercorrenciaStatus');
  const faltantes = [...selectedRoteiroIds]
    .map(id => allRoteiros.find(r => r.id === id))
    .filter(r => r && !intercorrenciasCarregadas.has(r.nome));

  if (!faltantes.length) return true;

  statusEl.style.display = 'block';
  statusEl.textContent = 'Buscando intercorrências...';
  document.getElementById('btnToMsg').disabled = true;

  for (const roteiro of faltantes) {
    const res = await getIntercorrenciasRoteiro(roteiro.nome);
    if (!res || res.ok !== true || !Array.isArray(res.data)) {
      statusEl.textContent = 'Não foi possível buscar intercorrências agora (verifique a conexão ou se o GAS foi atualizado). Tente novamente.';
      return false;
    }
    res.data.forEach(item => {
      if (item && item.id_rota) {
        intercorrenciasPorIdRota.set(String(item.id_rota), item);
      }
    });
    intercorrenciasCarregadas.add(roteiro.nome);
  }
  statusEl.style.display = 'none';
  return true;
}
```

- [ ] **Step 6: Adicionar coluna de intercorrência e usar a lista filtrada em `renderContactPreview`**

Substituir a função `renderContactPreview` inteira:

```js
function renderContactPreview() {
  const list = buildPendingContacts();
  const wrap = document.getElementById('previewWrap');
  const btn = document.getElementById('btnToMsg');

  if (!list.length) {
    wrap.innerHTML = '';
    btn.disabled = true;
    return;
  }

  wrap.innerHTML = `<table class="preview-table"><thead><tr>
      <th></th><th>Nome</th><th>Telefone</th><th>Roteiro</th>
    </tr></thead><tbody>` +
    list.map(c => `<tr>
      <td><input type="checkbox" ${excludedKeys.has(c.key) ? '' : 'checked'} onchange="toggleContact('${c.key}')"></td>
      <td>${c.nome}${c.labelSufixo}</td>
      <td style="font-family:'DM Mono',monospace">${c.telefoneExibicao || '—'}</td>
      <td>${c.roteiroNome}</td>
    </tr>`).join('') +
    `</tbody></table>`;

  const incluidos = list.filter(c => !excludedKeys.has(c.key));
  btn.disabled = incluidos.length === 0;
}
```

por:

```js
function renderContactPreview() {
  const full = buildPendingContacts();
  const list = full.filter(c => !somenteIntercorrencia || intercorrenciasPorIdRota.has(c.idRota));
  const wrap = document.getElementById('previewWrap');
  const btn = document.getElementById('btnToMsg');

  if (!list.length) {
    wrap.innerHTML = (somenteIntercorrencia && full.length)
      ? '<div class="hint">Nenhum cliente com intercorrência registrada neste(s) roteiro(s).</div>'
      : '';
    btn.disabled = true;
    return;
  }

  const colIntercorrenciaHeader = somenteIntercorrencia ? '<th>Intercorrência</th>' : '';
  wrap.innerHTML = `<table class="preview-table"><thead><tr>
      <th></th><th>Nome</th><th>Telefone</th><th>Roteiro</th>${colIntercorrenciaHeader}
    </tr></thead><tbody>` +
    list.map(c => {
      const intercorrenciaCel = somenteIntercorrencia
        ? `<td>${(intercorrenciasPorIdRota.get(c.idRota) || {}).intercorrencia || ''}</td>`
        : '';
      return `<tr>
      <td><input type="checkbox" ${excludedKeys.has(c.key) ? '' : 'checked'} onchange="toggleContact('${c.key}')"></td>
      <td>${c.nome}${c.labelSufixo}</td>
      <td style="font-family:'DM Mono',monospace">${c.telefoneExibicao || '—'}</td>
      <td>${c.roteiroNome}</td>${intercorrenciaCel}
    </tr>`;
    }).join('') +
    `</tbody></table>`;

  const incluidos = list.filter(c => !excludedKeys.has(c.key));
  btn.disabled = incluidos.length === 0;
}
```

- [ ] **Step 7: `toggleRoteiro` também mostra/esconde o toggle e recarrega intercorrências se necessário**

Substituir:

```js
function toggleRoteiro(id) {
  if (selectedRoteiroIds.has(id)) selectedRoteiroIds.delete(id);
  else selectedRoteiroIds.add(id);
  renderRoteiroChips();
  renderContactPreview();
}
window.toggleRoteiro = toggleRoteiro;
```

por:

```js
async function toggleRoteiro(id) {
  if (selectedRoteiroIds.has(id)) selectedRoteiroIds.delete(id);
  else selectedRoteiroIds.add(id);
  renderRoteiroChips();
  document.getElementById('intercorrenciaWrap').style.display = selectedRoteiroIds.size ? 'block' : 'none';

  if (somenteIntercorrencia) {
    const ok = await ensureIntercorrenciasCarregadas();
    if (!ok) {
      document.getElementById('chkIntercorrencia').checked = false;
      somenteIntercorrencia = false;
    }
  }
  renderContactPreview();
}
window.toggleRoteiro = toggleRoteiro;

async function toggleSomenteIntercorrencia() {
  const checkbox = document.getElementById('chkIntercorrencia');
  somenteIntercorrencia = checkbox.checked;

  if (somenteIntercorrencia) {
    const ok = await ensureIntercorrenciasCarregadas();
    if (!ok) {
      checkbox.checked = false;
      somenteIntercorrencia = false;
      renderContactPreview();
      return;
    }
  }
  renderContactPreview();
}
window.toggleSomenteIntercorrencia = toggleSomenteIntercorrencia;
```

- [ ] **Step 8: Usar `getVisibleContacts` ao avançar para a mensagem**

Substituir:

```js
document.getElementById('btnToMsg').onclick = () => {
  const list = buildPendingContacts().filter(c => !excludedKeys.has(c.key));
  if (!list.length) { alert('Selecione ao menos um contato.'); return; }
  contacts = list;
  statuses = new Array(contacts.length).fill('pending');
  goTo(2);
};
```

por:

```js
document.getElementById('btnToMsg').onclick = () => {
  const list = getVisibleContacts().filter(c => !excludedKeys.has(c.key));
  if (!list.length) { alert('Selecione ao menos um contato.'); return; }
  contacts = list;
  statuses = new Array(contacts.length).fill('pending');
  goTo(2);
};
```

- [ ] **Step 9: `buildMsg` substitui `{intercorrencia}`**

Substituir:

```js
function buildMsg(contact) {
  const nome = contact.nome || 'estabelecimento';
  return message.replace(/\{nome\}/gi, nome);
}
```

por:

```js
function buildMsg(contact) {
  const nome = contact.nome || 'estabelecimento';
  const intercorrencia = (intercorrenciasPorIdRota.get(contact.idRota) || {}).intercorrencia || '';
  return message.replace(/\{nome\}/gi, nome).replace(/\{intercorrencia\}/gi, intercorrencia);
}
```

- [ ] **Step 10: `restart` limpa o estado novo**

Substituir:

```js
function restart() {
  selectedRoteiroIds = new Set();
  excludedKeys = new Set();
  contacts = []; statuses = []; current = 0;
  document.getElementById('progressWrap').classList.remove('active');
  document.getElementById('progressFill').style.width = '0%';
  renderRoteiroChips();
  renderContactPreview();
  goTo(1);
}
window.restart = restart;
```

por:

```js
function restart() {
  selectedRoteiroIds = new Set();
  excludedKeys = new Set();
  contacts = []; statuses = []; current = 0;
  somenteIntercorrencia = false;
  intercorrenciasPorIdRota = new Map();
  intercorrenciasCarregadas = new Set();
  document.getElementById('chkIntercorrencia').checked = false;
  document.getElementById('intercorrenciaWrap').style.display = 'none';
  document.getElementById('progressWrap').classList.remove('active');
  document.getElementById('progressFill').style.width = '0%';
  renderRoteiroChips();
  renderContactPreview();
  goTo(1);
}
window.restart = restart;
```

- [ ] **Step 11: Verificação manual no navegador**

Não há teste automatizado de UI, e não há como bater num GAS real durante a verificação — a chamada de rede é simulada.

Run: `python -m http.server 8080` (a partir da raiz do worktree)

Usar as ferramentas do Playwright MCP (`mcp__playwright__browser_*`) para abrir `http://localhost:8080/whatsapp-sender.html`. Antes de qualquer coisa, semear roteiro/clientes de teste via `browser_evaluate` (mesma abordagem usada na verificação da feature anterior — dynamic `import('./database.js')`, `db.init()`, `db.addRoteiro`, `db.upsertCliente`, depois recarregar a página).

Depois, **stubar `getIntercorrenciasRoteiro` no próprio browser** (já que não existe GAS real disponível) via `browser_evaluate`, sobrescrevendo o módulo antes da página carregar não é possível (é um import estático) — em vez disso, interceptar a chamada de rede: como `getGasUrl()` provavelmente retorna `''` (sem config), o primeiro teste natural é justamente o caminho de erro. Para testar o caminho de sucesso, configurar uma URL fake e usar `browser_evaluate` para sobrescrever `window.fetch` ANTES de marcar o checkbox, retornando uma resposta simulada:

```js
() => {
  localStorage.setItem('app3_gas_url', 'https://fake.example/exec');
  const original = window.fetch;
  window.fetch = async (url) => {
    if (String(url).includes('action=intercorrenciasRoteiro')) {
      return new Response(JSON.stringify({
        ok: true,
        data: [{ id_rota: '1', intercorrencia: 'Bombona suja', data: '2026-09-01' }]
      }), { status: 200 });
    }
    return original(url);
  };
}
```

Checklist a validar:
1. Sem roteiro selecionado, o toggle "Só com intercorrência" fica escondido (`#intercorrenciaWrap` com `display:none`).
2. Selecionar um roteiro mostra o toggle.
3. Sem GAS configurado (`localStorage` limpo), marcar o toggle mostra a mensagem de erro em `#intercorrenciaStatus` e desmarca o checkbox sozinho.
4. Com o `fetch` stubado (ver acima) retornando um cliente com intercorrência, marcar o toggle filtra a tabela de preview para mostrar só esse cliente, com uma coluna "Intercorrência" extra mostrando "Bombona suja".
5. Avançar para o passo de mensagem, usar `{nome}` e `{intercorrencia}` no texto, e confirmar no preview da mensagem (passo de envio) que ambos foram substituídos corretamente.
6. Desmarcar o toggle volta a mostrar todos os contatos do roteiro (sem a coluna extra).
7. "Novo disparo" reseta o toggle (desmarcado, escondido) e o estado de intercorrências.

Ao final, encerrar o processo do `python -m http.server`.

- [ ] **Step 12: Commit**

```bash
git add whatsapp-sender.html
git commit -m "feat(whatsapp): filtra contatos por intercorrencia da ultima coleta via GAS"
```
