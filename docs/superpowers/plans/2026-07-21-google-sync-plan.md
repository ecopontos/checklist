# Sincronização Google (Sheets push / Drive pull) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock "Sincronização Supabase" card and the manual "Exportar para CSV" flow with a real integration: coletas are pushed to a Google Sheet via a Google Apps Script (GAS) Web App, and rotas/pontos are pulled automatically from a fixed CSV file (`cstExportaCheckList.csv`) in a Google Drive folder, through the same Web App.

**Architecture:** A single GAS Web App (`gas/Code.gs`, delivered as source for the user to paste into the Apps Script editor — not part of the static site deploy) exposes `doPost` (append coletas to a "Coletas" sheet) and `doGet` (return the latest `cstExportaCheckList.csv` content + modified time from a Drive folder). A new shared client module, `google-sync.js`, wraps both calls and is imported by the pages that need them. `database.js` gets the local-DB primitives (sync bookkeeping columns already exist in the schema but are unused today).

**Tech Stack:** Vanilla JS ES modules, `sql.js` (SQLite/WASM), PapaParse (already vendored), Google Apps Script (`ContentService`, `DriveApp`, `SpreadsheetApp`, `PropertiesService`).

## Global Constraints

- No build process, no bundler, no package manager — this stays a static site (`PUBLICACAO.md`). All new client code is loaded as classic `<script>` / ES module `<script type="module">` tags directly.
- No automated test framework exists in this repo. Verification steps in this plan are manual: run a local static server (`python -m http.server 8080` from the repo root) and check the browser console / UI / `localStorage`, or `curl` for the GAS side. This replaces pytest-style automated tests — there is nothing to install.
- GAS Web App has **no authentication token** (explicit user decision) — `SPREADSHEET_ID` and `DRIVE_FOLDER_ID` are read from Apps Script's `PropertiesService` (Script Properties), not hardcoded, and are filled in by the user after they create the Sheet and folder.
- The Drive file to pull is always named exactly `cstExportaCheckList.csv`, columns `Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP` (semicolon-delimited). The `Fonte` column is not used (matches current behavior — no existing code reads it either).
- Coleta sync assumes the device is online at collection time — no offline retry queue. A failed push just leaves the local row unsynced (`last_sync IS NULL`) for a later manual retry.
- POST bodies to the GAS Web App must use `Content-Type: text/plain;charset=utf-8` (not `application/json`) so the browser does not send a CORS preflight `OPTIONS` request, which Apps Script Web Apps cannot handle. `Code.gs` parses `e.postData.contents` manually with `JSON.parse`.
- The legacy Access/Excel migration UI in `admin.html` (`Rotas.xlsx` / `Pontos.xlsx` upload) is untouched — it is a separate one-time migration path, not the ongoing CSV sync.

---

## Task 1: `database.js` — sync bookkeeping + CSV import

**Files:**
- Modify: `database.js:123-129` (`addColeta`), `database.js:111-121` (insert after `getClientesByRoteiro`), `database.js:130-146` (insert after `getColetasByDate`)
- Test: manual, disposable harness `_verify_task1.html` in repo root (deleted before commit)

**Interfaces:**
- Produces: `db.addColeta(coleta) -> number` (now returns the inserted row id, was `void`)
- Produces: `db.markColetaSynced(id: number, syncId: string) -> void`
- Produces: `db.getUnsyncedColetas() -> Array<{id, id_rota, data, quantidade, intercorrencia, cliente, roteiro}>`
- Produces: `db.importRoteirosCsv(csvText: string) -> {roteiros: number, clientes: number}`
- Consumes: global `Papa` (from `vendor/papaparse.min.js`, must be loaded as a classic `<script>` before any page that calls `importRoteirosCsv`)

- [ ] **Step 1: Make `addColeta` return the inserted row id**

In `database.js`, replace:

```js
    // --- Coletas ---
    addColeta(coleta) {
        this.db.run(`
            INSERT INTO coletas (id_rota, data, quantidade, intercorrencia)
            VALUES (?, ?, ?, ?)
        `, [coleta.id_rota, coleta.data, coleta.quantidade, coleta.intercorrencia]);
        this.save();
    }
```

with:

```js
    // --- Coletas ---
    addColeta(coleta) {
        this.db.run(`
            INSERT INTO coletas (id_rota, data, quantidade, intercorrencia)
            VALUES (?, ?, ?, ?)
        `, [coleta.id_rota, coleta.data, coleta.quantidade, coleta.intercorrencia]);
        const id = this.db.exec("SELECT last_insert_rowid() AS id")[0].values[0][0];
        this.save();
        return id;
    }
```

- [ ] **Step 2: Add `markColetaSynced` and `getUnsyncedColetas` after `getColetasByDate`**

In `database.js`, after the existing `getColetasByDate` method (ends right before the `// --- Export/Backup ---` comment), insert:

```js

    markColetaSynced(id, syncId) {
        this.db.run("UPDATE coletas SET last_sync = ?, sync_id = ? WHERE id = ?", [new Date().toISOString(), syncId, id]);
        this.save();
    }

    getUnsyncedColetas() {
        const res = this.db.exec(`
            SELECT c.id, c.id_rota, c.data, c.quantidade, c.intercorrencia, cl.cliente, r.nome as roteiro
            FROM coletas c
            JOIN clientes cl ON c.id_rota = cl.id_rota
            JOIN roteiros r ON cl.roteiro_id = r.id
            WHERE c.last_sync IS NULL
            ORDER BY c.data DESC
        `);
        if (!res.length) return [];
        const cols = res[0].columns;
        return res[0].values.map(v => {
            const obj = {};
            cols.forEach((c, i) => obj[c] = v[i]);
            return obj;
        });
    }
```

- [ ] **Step 3: Add `importRoteirosCsv` after `getClientesByRoteiro`**

In `database.js`, after the existing `getClientesByRoteiro` method (ends right before the `// --- Coletas ---` comment), insert:

```js

    importRoteirosCsv(csvText) {
        const results = Papa.parse(csvText, {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: true
        });
        const data = results.data;

        const uniqueRoteiros = [...new Set(data.map(r => this._getCsvVal(r, 'Roteiro')).filter(Boolean))];
        uniqueRoteiros.forEach(name => this.addRoteiro(name));

        const roteiros = this.getRoteiros();
        const routeMap = {};
        roteiros.forEach(r => routeMap[r.nome] = r.id);

        let clientesCount = 0;
        data.forEach(row => {
            const idRota = this._getCsvVal(row, 'idRota') || this._getCsvVal(row, 'id Rota');
            const clienteNome = this._getCsvVal(row, 'Cliente');
            const roteiroName = this._getCsvVal(row, 'Roteiro');

            if (idRota && clienteNome) {
                this.upsertCliente({
                    idRota: idRota.toString(),
                    Cliente: clienteNome,
                    logradouro: this._getCsvVal(row, 'Logradouro') || this._getCsvVal(row, 'Rua') || '',
                    Número: this._getCsvVal(row, 'Número') || this._getCsvVal(row, 'Num') || this._getCsvVal(row, 'Nº') || '',
                    CEP: this._getCsvVal(row, 'CEP') || '',
                    roteiro_id: routeMap[roteiroName],
                    Ordem: this._getCsvVal(row, 'Ordem') || 0,
                    ativo: this._getCsvVal(row, 'Inativo') != 1
                });
                clientesCount++;
            }
        });

        return { roteiros: uniqueRoteiros.length, clientes: clientesCount };
    }

    _getCsvVal(row, name) {
        const key = Object.keys(row).find(k => k.toLowerCase().trim() === name.toLowerCase());
        return key ? row[key] : null;
    }
```

- [ ] **Step 4: Write the disposable verification harness**

Create `_verify_task1.html` in the repo root (same folder as `database.js`):

```html
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body>
<script src="vendor/papaparse.min.js"></script>
<script src="vendor/sql-wasm.js"></script>
<script type="module">
import db from './database.js';

async function run() {
    await db.init();

    const csv = `Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP
SAT01-1;3;0;1,00;SAT01;CEPON;Rodovia Admar Gonzaga;655,00;88034001
SAT01-5;6;0;5,00;SAT01;BIARRITZ, COND.;Rua Pastor William Richard Schisler Filho;504,00;88034100`;

    console.log('importRoteirosCsv:', db.importRoteirosCsv(csv));

    const id = db.addColeta({ id_rota: '3', data: '2026-07-21', quantidade: 3, intercorrencia: '' });
    console.log('addColeta id:', id, typeof id);

    console.log('getUnsyncedColetas (before sync):', db.getUnsyncedColetas());

    db.markColetaSynced(id, 'test-sync-id');
    console.log('getUnsyncedColetas (after sync):', db.getUnsyncedColetas());
}

run();
</script>
</body>
</html>
```

- [ ] **Step 5: Run the harness and verify output**

Run: `python -m http.server 8080` from the repo root, then open
`http://localhost:8080/_verify_task1.html` in a **private/incognito window**
(so `localStorage` starts empty — this harness reuses the `app3_db` key like
the real app) and check the DevTools console.

Expected console output:
```
importRoteirosCsv: {roteiros: 1, clientes: 2}
addColeta id: 1 number
getUnsyncedColetas (before sync): [{id: 1, id_rota: '3', data: '2026-07-21', quantidade: 3, intercorrencia: '', cliente: 'CEPON', roteiro: 'SAT01'}]
getUnsyncedColetas (after sync): []
```

- [ ] **Step 6: Delete the harness and commit**

```bash
rm _verify_task1.html
git add database.js
git commit -m "feat(database): add coleta sync tracking and CSV import helper"
```

---

## Task 2: `google-sync.js` — shared GAS client module

**Files:**
- Create: `google-sync.js`
- Test: manual, disposable harness `_verify_task2.html` in repo root (deleted before commit)

**Interfaces:**
- Consumes: `db.importRoteirosCsv(csvText) -> {roteiros, clientes}` from Task 1 (passed in as a parameter, not imported, to keep this module decoupled from `database.js`)
- Produces: `getGasUrl() -> string`
- Produces: `setGasUrl(url: string) -> void`
- Produces: `pushColetas(coletas: Array) -> Promise<{ok: boolean, count?: number, error?: string}>`
- Produces: `checkAndImportRoteiros(db) -> Promise<{checked: boolean, updated?: boolean, reason?: string, error?: string, roteiros?: number, clientes?: number}>`
- Matches the `doPost`/`doGet` JSON contract implemented in Task 3's `gas/Code.gs`

- [ ] **Step 1: Create `google-sync.js`**

```js
/**
 * Client for the Google Apps Script (GAS) Web App bridge to
 * Google Sheets (push coletas) and Google Drive (pull rotas/pontos CSV).
 */

const GAS_URL_KEY = 'app3_gas_url';
const LAST_DRIVE_SYNC_KEY = 'app3_last_drive_sync';

export function getGasUrl() {
    return localStorage.getItem(GAS_URL_KEY) || '';
}

export function setGasUrl(url) {
    localStorage.setItem(GAS_URL_KEY, url);
}

export async function pushColetas(coletas) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    if (!coletas.length) return { ok: true, count: 0 };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ coletas })
        });
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function checkAndImportRoteiros(db) {
    const url = getGasUrl();
    if (!url) return { checked: false, reason: 'no-url' };

    try {
        const res = await fetch(url, { method: 'GET' });
        const data = await res.json();

        if (!data.ok) {
            return { checked: true, updated: false, error: data.error };
        }

        const lastSync = localStorage.getItem(LAST_DRIVE_SYNC_KEY);
        if (lastSync && new Date(data.modifiedTime) <= new Date(lastSync)) {
            return { checked: true, updated: false };
        }

        const result = db.importRoteirosCsv(data.content);
        localStorage.setItem(LAST_DRIVE_SYNC_KEY, data.modifiedTime);
        return { checked: true, updated: true, ...result };
    } catch (e) {
        return { checked: true, updated: false, error: e.message };
    }
}
```

- [ ] **Step 2: Write the disposable verification harness (no-URL / negative paths)**

Create `_verify_task2.html` in the repo root:

```html
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body>
<script type="module">
import { getGasUrl, setGasUrl, pushColetas, checkAndImportRoteiros } from './google-sync.js';

async function run() {
    localStorage.removeItem('app3_gas_url');
    console.log('getGasUrl (empty):', JSON.stringify(getGasUrl()));

    setGasUrl('https://example.com/exec');
    console.log('getGasUrl (after set):', getGasUrl());

    localStorage.removeItem('app3_gas_url');
    console.log('pushColetas (no url):', await pushColetas([{ id_rota: 'x' }]));
    console.log('checkAndImportRoteiros (no url):', await checkAndImportRoteiros({}));
}

run();
</script>
</body>
</html>
```

- [ ] **Step 3: Run the harness and verify output**

With the local server still running (`python -m http.server 8080`), open
`http://localhost:8080/_verify_task2.html` and check the DevTools console.

Expected console output:
```
getGasUrl (empty): ""
getGasUrl (after set): https://example.com/exec
pushColetas (no url): {ok: false, error: 'URL do GAS não configurada'}
checkAndImportRoteiros (no url): {checked: false, reason: 'no-url'}
```

- [ ] **Step 4: Delete the harness and commit**

```bash
rm _verify_task2.html
git add google-sync.js
git commit -m "feat: add google-sync.js client for the GAS push/pull bridge"
```

---

## Task 3: `gas/Code.gs` — Apps Script Web App + deployment instructions

**Files:**
- Create: `gas/Code.gs`
- Create: `gas/README.md`

**Interfaces:**
- Produces the HTTP contract `google-sync.js` (Task 2) already targets:
  - `GET <url>` → `{ok: true, content: string, modifiedTime: string}` or `{ok: false, error: string}`
  - `POST <url>` body `text/plain` JSON `{coletas: [{id_rota, data, cliente, roteiro, quantidade, intercorrencia, sync_id}, ...]}` → `{ok: true, count: number}` or `{ok: false, error: string}`

- [ ] **Step 1: Create `gas/Code.gs`**

```js
/**
 * Google Apps Script Web App bridge for the SATELITE v3 checklist app.
 * Deploy as Web App (Execute as: Me, Who has access: Anyone).
 *
 * Script Properties required (Project Settings > Script Properties):
 *   SPREADSHEET_ID  - id of the Google Sheet that receives coleta rows
 *   DRIVE_FOLDER_ID - id of the Drive folder containing cstExportaCheckList.csv
 */

var CSV_FILE_NAME = 'cstExportaCheckList.csv';
var COLETAS_SHEET_NAME = 'Coletas';

function getConfig_() {
    var props = PropertiesService.getScriptProperties();
    return {
        spreadsheetId: props.getProperty('SPREADSHEET_ID'),
        folderId: props.getProperty('DRIVE_FOLDER_ID')
    };
}

function jsonResponse_(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
        .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
    var config = getConfig_();
    if (!config.folderId) {
        return jsonResponse_({ ok: false, error: 'DRIVE_FOLDER_ID não configurado' });
    }

    try {
        var folder = DriveApp.getFolderById(config.folderId);
        var files = folder.getFilesByName(CSV_FILE_NAME);

        if (!files.hasNext()) {
            return jsonResponse_({ ok: false, error: 'Arquivo ' + CSV_FILE_NAME + ' não encontrado na pasta' });
        }

        var file = files.next();
        return jsonResponse_({
            ok: true,
            content: file.getBlob().getDataAsString('UTF-8'),
            modifiedTime: file.getLastUpdated().toISOString()
        });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function doPost(e) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }

    try {
        var body = JSON.parse(e.postData.contents);
        var coletas = body.coletas || [];

        var ss = SpreadsheetApp.openById(config.spreadsheetId);
        var sheet = ss.getSheetByName(COLETAS_SHEET_NAME);
        if (!sheet) {
            sheet = ss.insertSheet(COLETAS_SHEET_NAME);
            sheet.appendRow(['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID']);
        }

        var now = new Date().toISOString();
        coletas.forEach(function (c) {
            sheet.appendRow([
                c.id_rota || '',
                c.data || '',
                c.cliente || '',
                c.roteiro || '',
                c.quantidade || 0,
                c.intercorrencia || '',
                now,
                c.sync_id || ''
            ]);
        });

        return jsonResponse_({ ok: true, count: coletas.length });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}
```

- [ ] **Step 2: Create `gas/README.md` with deployment instructions**

```markdown
# Deploy do Web App (Code.gs)

1. Crie uma planilha Google Sheets (vazia, qualquer nome) — copie o ID dela
   da URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
2. Crie uma pasta no Google Drive onde o arquivo `cstExportaCheckList.csv`
   será colocado (e substituído a cada atualização) — copie o ID dela da URL:
   `https://drive.google.com/drive/folders/<DRIVE_FOLDER_ID>`.
3. Acesse https://script.google.com/, crie um novo projeto.
4. Apague o conteúdo padrão de `Code.gs` e cole o conteúdo de
   `gas/Code.gs` deste repositório.
5. Em "Configurações do projeto" (ícone de engrenagem) > "Propriedades do
   script", adicione:
   - `SPREADSHEET_ID` = o ID copiado no passo 1
   - `DRIVE_FOLDER_ID` = o ID copiado no passo 2
6. Clique em "Implantar" > "Nova implantação" > tipo "App da Web".
   - Executar como: **Eu** (sua conta)
   - Quem tem acesso: **Qualquer pessoa**
7. Autorize as permissões solicitadas (acesso a Sheets e Drive).
8. Copie a URL do Web App gerada (termina em `/exec`) — essa é a URL que
   vai no campo "URL do Web App do Google Apps Script" em `admin.html`.

## Teste manual pós-deploy

Depois de colocar um `cstExportaCheckList.csv` na pasta configurada, teste
com `curl` (substitua `<URL>` pela URL do passo 8):

```bash
curl "<URL>"
```

Esperado: JSON com `"ok":true`, `"content":"Fonte;idRota;..."` e
`"modifiedTime"`.

```bash
curl -X POST "<URL>" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"coletas":[{"id_rota":"SAT01-1","data":"2026-07-21","cliente":"CEPON","roteiro":"SAT01","quantidade":3,"intercorrencia":"","sync_id":"teste-curl"}]}'
```

Esperado: `{"ok":true,"count":1}`, e uma nova linha na aba "Coletas" da
planilha configurada.

Toda vez que o `Code.gs` for editado no editor do Apps Script, é preciso
criar uma **nova implantação** (ou gerenciar implantações > editar a
implantação existente) para que as mudanças valham para a URL já em uso.
```

- [ ] **Step 3: Commit**

```bash
git add gas/Code.gs gas/README.md
git commit -m "docs: add GAS Web App source and deployment instructions"
```

---

## Task 4: `roteiros.html` — use `db.importRoteirosCsv` for manual CSV upload

**Files:**
- Modify: `roteiros.html:489-547`

**Interfaces:**
- Consumes: `db.importRoteirosCsv(csvText) -> {roteiros, clientes}` from Task 1

- [ ] **Step 1: Replace `handleFile` and remove the now-unused `getVal` helper**

In `roteiros.html`, replace (lines 489-547):

```js
        function handleFile(file) {
            if (!file) return;
            document.getElementById('loader').style.display = 'flex';
            
            const reader = new FileReader();
            reader.onload = function(e) {
                Papa.parse(e.target.result, {
                    header: true,
                    skipEmptyLines: true,
                    dynamicTyping: true,
                    complete: async function(results) {
                        const data = results.data;
                        
                        if (data.length === 0) {
                            alert('Arquivo vazio ou formato inválido.');
                            document.getElementById('loader').style.display = 'none';
                            return;
                        }

                        const uniqueRoteiros = [...new Set(data.map(r => getVal(r, 'Roteiro')).filter(Boolean))];
                        uniqueRoteiros.forEach(name => db.addRoteiro(name));
                        renderRoteiros();

                        const roteiros = db.getRoteiros();
                        const routeMap = {};
                        roteiros.forEach(r => routeMap[r.nome] = r.id);

                        data.forEach(row => {
                            const idRota = getVal(row, 'idRota') || getVal(row, 'id Rota');
                            const clienteNome = getVal(row, 'Cliente');
                            const roteiroName = getVal(row, 'Roteiro');

                            if (idRota && clienteNome) {
                                db.upsertCliente({
                                    idRota: idRota.toString(),
                                    Cliente: clienteNome,
                                    logradouro: getVal(row, 'Logradouro') || getVal(row, 'Rua') || '',
                                    Número: getVal(row, 'Número') || getVal(row, 'Num') || getVal(row, 'Nº') || '',
                                    CEP: getVal(row, 'CEP') || '',
                                    roteiro_id: routeMap[roteiroName],
                                    Ordem: getVal(row, 'Ordem') || 0,
                                    ativo: getVal(row, 'Inativo') != 1
                                });
                            }
                        });

                        document.getElementById('loader').style.display = 'none';
                        closeModal('importModal');
                        renderClients();
                    }
                });
            };
            reader.readAsText(file);
        }

        const getVal = (row, name) => {
            const key = Object.keys(row).find(k => k.toLowerCase().trim() === name.toLowerCase());
            return key ? row[key] : null;
        };
```

with:

```js
        function handleFile(file) {
            if (!file) return;
            document.getElementById('loader').style.display = 'flex';

            const reader = new FileReader();
            reader.onload = function(e) {
                const result = db.importRoteirosCsv(e.target.result);

                if (result.clientes === 0) {
                    alert('Arquivo vazio ou formato inválido.');
                }

                renderRoteiros();
                renderClients();
                document.getElementById('loader').style.display = 'none';
                closeModal('importModal');
            };
            reader.readAsText(file);
        }
```

- [ ] **Step 2: Manually verify in the browser**

With the local server running, open `http://localhost:8080/roteiros.html`
in a private/incognito window, click the CSV import control, and upload a
file containing:

```
Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP
SAT01-1;3;0;1,00;SAT01;CEPON;Rodovia Admar Gonzaga;655,00;88034001
SAT01-5;6;0;5,00;SAT01;BIARRITZ, COND.;Rua Pastor William Richard Schisler Filho;504,00;88034100
```

Expected: modal closes, the table shows 2 rows under a roteiro "SAT01",
clients "CEPON" and "BIARRITZ, COND." — same result as before this change.

- [ ] **Step 3: Commit**

```bash
git add roteiros.html
git commit -m "refactor(roteiros): reuse db.importRoteirosCsv instead of inline parsing"
```

---

## Task 5: `coleta-checklist.html` — push new coletas to Sheets automatically

**Files:**
- Modify: `coleta-checklist.html:253-254` (imports), `coleta-checklist.html:456-480` (`saveOperation` / `showToast`)

**Interfaces:**
- Consumes: `db.addColeta(coleta) -> number`, `db.markColetaSynced(id, syncId)` from Task 1
- Consumes: `pushColetas(coletas) -> Promise<{ok, count?, error?}>` from Task 2

- [ ] **Step 1: Import `pushColetas`**

In `coleta-checklist.html`, replace:

```js
    <script type="module">
        import db from './database.js';
```

with:

```js
    <script type="module">
        import db from './database.js';
        import { pushColetas } from './google-sync.js';
```

- [ ] **Step 2: Rewrite `saveOperation`, add `syncColetasToSheet`, make `showToast` accept a message**

In `coleta-checklist.html`, replace:

```js
        async function saveOperation() {
            const date = document.getElementById('opDate').value;
            if (!date) { alert('Selecione a data!'); return; }

            const entries = Object.entries(sessionData).filter(([id, d]) => d.qty > 0 || d.issue);
            
            if (entries.length === 0) { alert('Nenhum registro para salvar!'); return; }

            entries.forEach(([id, d]) => {
                db.addColeta({
                    id_rota: id,
                    data: date,
                    quantidade: d.qty,
                    intercorrencia: d.issue || ''
                });
            });

            showToast();
        }

        function showToast() {
            const t = document.getElementById('toast');
            t.style.opacity = '1';
            setTimeout(() => t.style.opacity = '0', 3000);
        }
```

with:

```js
        async function saveOperation() {
            const date = document.getElementById('opDate').value;
            if (!date) { alert('Selecione a data!'); return; }

            const entries = Object.entries(sessionData).filter(([id, d]) => d.qty > 0 || d.issue);

            if (entries.length === 0) { alert('Nenhum registro para salvar!'); return; }

            const routeSelect = document.getElementById('routeSelect');
            const roteiroNome = routeSelect.options[routeSelect.selectedIndex]
                ? routeSelect.options[routeSelect.selectedIndex].textContent
                : '';

            const savedColetas = entries.map(([id, d]) => {
                const client = currentClients.find(c => c.id_rota == id);
                const localId = db.addColeta({
                    id_rota: id,
                    data: date,
                    quantidade: d.qty,
                    intercorrencia: d.issue || ''
                });
                return {
                    id: localId,
                    id_rota: id,
                    data: date,
                    quantidade: d.qty,
                    intercorrencia: d.issue || '',
                    cliente: client ? client.cliente : '',
                    roteiro: roteiroNome,
                    sync_id: crypto.randomUUID()
                };
            });

            showToast();
            syncColetasToSheet(savedColetas);
        }

        async function syncColetasToSheet(coletas) {
            const result = await pushColetas(coletas);
            if (result.ok) {
                coletas.forEach(c => db.markColetaSynced(c.id, c.sync_id));
            } else {
                showToast('Salvo localmente. Sincronização pendente.');
            }
        }

        function showToast(msg) {
            const t = document.getElementById('toast');
            const defaultMsg = 'Operação salva com sucesso!';
            t.textContent = msg || defaultMsg;
            t.style.opacity = '1';
            setTimeout(() => {
                t.style.opacity = '0';
                t.textContent = defaultMsg;
            }, 3000);
        }
```

- [ ] **Step 3: Manually verify without a GAS URL configured (offline/unconfigured path)**

With the local server running, open `http://localhost:8080/coleta-checklist.html`
in a private/incognito window (no `app3_gas_url` set yet), select a route,
enter a quantity for one point, click "SALVAR OPERAÇÃO".

Expected: toast briefly shows "Operação salva com sucesso!" then, ~0ms
later (the failed push resolves fast since it never hits the network),
changes to "Salvo localmente. Sincronização pendente." DevTools console
should show no uncaught errors. Open DevTools > Application > Local
Storage, confirm `app3_db` was updated (the coleta is saved locally
regardless of sync outcome).

- [ ] **Step 4: Commit**

```bash
git add coleta-checklist.html
git commit -m "feat(coleta): push new coletas to Google Sheets after saving locally"
```

---

## Task 6: `analise.html` — replace CSV export with "Forçar sincronização"

**Files:**
- Modify: `analise.html:134-140` (button HTML), `analise.html:187-224` (imports, wiring, function)

**Interfaces:**
- Consumes: `db.getUnsyncedColetas()`, `db.markColetaSynced(id, syncId)` from Task 1
- Consumes: `pushColetas(coletas) -> Promise<{ok, count?, error?}>` from Task 2

- [ ] **Step 1: Replace the "Exportar" card section**

In `analise.html`, replace:

```html
                <div style="margin-top: 40px;">
                    <h3>Exportar</h3>
                    <p style="color: var(--text-dim); font-size: 0.8rem; margin-bottom: 10px;">Gere um arquivo CSV consolidado para uso externo.</p>
                    <button id="btnExportCSV" class="tab-btn" style="width: 100%; border-color: var(--success); color: var(--success);">
                        📊 Exportar para CSV
                    </button>
                </div>
```

with:

```html
                <div style="margin-top: 40px;">
                    <h3>Sincronização</h3>
                    <p style="color: var(--text-dim); font-size: 0.8rem; margin-bottom: 10px;">Reenvia coletas que ainda não foram sincronizadas com o Google Sheets.</p>
                    <button id="btnForceSync" class="tab-btn" style="width: 100%; border-color: var(--success); color: var(--success);">
                        🔄 Forçar sincronização
                    </button>
                </div>
```

- [ ] **Step 2: Import `pushColetas`, wire the new button, replace `exportToCSV`**

In `analise.html`, replace:

```js
    <script type="module">
        import db from './database.js';

        async function init() {
            await db.init();
            renderStats();

            document.getElementById('csvHist').onchange = (e) => importHistory(e.target.files[0]);
            document.getElementById('xlsxHist').onchange = (e) => importLegacyHistory(e.target.files[0]);
            document.getElementById('btnExportCSV').onclick = exportToCSV;
        }

        function exportToCSV() {
            const res = db.db.exec(`
                SELECT r.nome as Roteiro, c.data as Data, c.id_rota as "ID Rota", cl.cliente as Cliente, c.quantidade as "Contentores Coletados", c.intercorrencia as Intercorrências
                FROM coletas c
                JOIN clientes cl ON c.id_rota = cl.id_rota
                JOIN roteiros r ON cl.roteiro_id = r.id
                ORDER BY c.data DESC, r.nome
            `);

            if (!res.length) { alert('Nenhum dado para exportar!'); return; }

            const cols = res[0].columns;
            const rows = res[0].values;
            
            const csvData = [cols, ...rows];
            const csvContent = Papa.unparse(csvData);
            
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `coleta_consolidada_${new Date().toISOString().slice(0,10)}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        }
```

with:

```js
    <script type="module">
        import db from './database.js';
        import { pushColetas } from './google-sync.js';

        async function init() {
            await db.init();
            renderStats();

            document.getElementById('csvHist').onchange = (e) => importHistory(e.target.files[0]);
            document.getElementById('xlsxHist').onchange = (e) => importLegacyHistory(e.target.files[0]);
            document.getElementById('btnForceSync').onclick = forceSyncColetas;
        }

        async function forceSyncColetas() {
            const pending = db.getUnsyncedColetas();
            if (!pending.length) { alert('Nenhuma coleta pendente de sincronização!'); return; }

            const payload = pending.map(c => ({
                id: c.id,
                id_rota: c.id_rota,
                data: c.data,
                quantidade: c.quantidade,
                intercorrencia: c.intercorrencia,
                cliente: c.cliente,
                roteiro: c.roteiro,
                sync_id: crypto.randomUUID()
            }));

            const result = await pushColetas(payload);
            if (result.ok) {
                payload.forEach(c => db.markColetaSynced(c.id, c.sync_id));
                alert(`${payload.length} coleta(s) sincronizada(s) com sucesso!`);
            } else {
                alert(`Falha ao sincronizar: ${result.error || 'erro desconhecido'}`);
            }
        }
```

- [ ] **Step 3: Manually verify the pending-count and no-URL error path**

With the local server running, open `http://localhost:8080/analise.html`
in the **same** browser profile used in Task 5 Step 3 (so the unsynced
coleta from that test is still in `localStorage`), click "🔄 Forçar
sincronização".

Expected: an `alert()` reading `Falha ao sincronizar: URL do GAS não
configurada` (no GAS URL is set yet). Then open DevTools console and run
`localStorage.setItem('app3_gas_url', '')` to confirm idempotency, and
separately confirm `db` had zero pending items after temporarily calling
`db.getUnsyncedColetas()` is not needed here — the alert path already
proves the pending list was non-empty before the call.

- [ ] **Step 4: Commit**

```bash
git add analise.html
git commit -m "feat(analise): replace CSV export with force-sync to Google Sheets"
```

---

## Task 7: `admin.html` — replace mock Supabase card with real Google sync

**Files:**
- Modify: `admin.html:238-257` (card HTML), `admin.html:259-278` (add pending-sync stat row), `admin.html:304-306` (vendor scripts), `admin.html:306-324` (imports/init), `admin.html:428-451` (`updateStats`, replace `testSync`)

**Interfaces:**
- Consumes: `db.getUnsyncedColetas()` from Task 1
- Consumes: `getGasUrl()`, `setGasUrl(url)`, `checkAndImportRoteiros(db)` from Task 2

- [ ] **Step 1: Add the PapaParse vendor script (needed by `db.importRoteirosCsv`)**

In `admin.html`, replace:

```html
    <script src="vendor/xlsx.full.min.js"></script>
    <script src="vendor/sql-wasm.js"></script>
    <script type="module">
```

with:

```html
    <script src="vendor/papaparse.min.js"></script>
    <script src="vendor/xlsx.full.min.js"></script>
    <script src="vendor/sql-wasm.js"></script>
    <script type="module">
```

- [ ] **Step 2: Replace the "Sincronização Supabase" card**

In `admin.html`, replace:

```html
            <!-- SINCRONIZACAO SUPABASE -->
            <div class="card">
                <h2>☁️ Sincronização Supabase</h2>
                <p>Transfira os dados locais para a nuvem para que outros dispositivos na rede possam acessar os roteiros atualizados.</p>
                
                <div class="sync-status">
                    <div class="status-dot status-offline" id="syncStatusDot"></div>
                    <span id="syncStatusText">Supabase não configurado</span>
                </div>

                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <input type="text" id="supabaseUrl" placeholder="Supabase URL">
                    <input type="password" id="supabaseKey" placeholder="Supabase Anon Key">
                </div>

                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-primary" style="flex: 1;" onclick="testSync()">Conectar & Sincronizar</button>
                    <button class="btn btn-outline" onclick="backupSQLite()">Backup Local</button>
                </div>
            </div>
```

with:

```html
            <!-- SINCRONIZACAO GOOGLE -->
            <div class="card">
                <h2>☁️ Sincronização Google</h2>
                <p>Transfira os dados locais para a nuvem (Google Sheets) para que outros dispositivos na rede possam acessar os roteiros atualizados. Rotas e pontos são atualizados automaticamente a partir do arquivo na pasta do Google Drive.</p>

                <div class="sync-status">
                    <div class="status-dot status-offline" id="syncStatusDot"></div>
                    <span id="syncStatusText">Verificando...</span>
                </div>

                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <input type="text" id="gasUrl" placeholder="URL do Web App do Google Apps Script">
                </div>

                <div style="display: flex; gap: 10px;">
                    <button class="btn btn-primary" style="flex: 1;" onclick="checkDriveUpdate()">Verificar agora</button>
                    <button class="btn btn-outline" onclick="backupSQLite()">Backup Local</button>
                </div>
            </div>
```

- [ ] **Step 3: Add the pending-sync stat row to "Manutenção do Banco"**

In `admin.html`, replace:

```html
                    <div style="display: flex; justify-content: space-between; font-size: 0.9rem;">
                        <span>Registros de Coleta:</span>
                        <span id="statCollectsCount" style="font-family: 'JetBrains Mono'; color: var(--primary);">0</span>
                    </div>
                </div>
```

with:

```html
                    <div style="display: flex; justify-content: space-between; font-size: 0.9rem;">
                        <span>Registros de Coleta:</span>
                        <span id="statCollectsCount" style="font-family: 'JetBrains Mono'; color: var(--primary);">0</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 0.9rem; margin-top: 8px;">
                        <span>Coletas Pendentes de Sincronização:</span>
                        <span id="statPendingSyncCount" style="font-family: 'JetBrains Mono'; color: var(--accent);">0</span>
                    </div>
                </div>
```

- [ ] **Step 4: Import the google-sync module and wire the GAS URL field + auto-check on load**

In `admin.html`, replace:

```js
    <script type="module">
        import db from './database.js';

        let legacyData = { rotas: [], roteiros: [], coletas: [] };

        async function init() {
            await db.init();
            updateStats();
            
            // File listeners
            document.getElementById('legacyRota').onchange = (e) => handleFile(e, 'rotas');
            document.getElementById('legacyRoteiro').onchange = (e) => handleFile(e, 'roteiros');
            document.getElementById('legacyColeta').onchange = (e) => handleFile(e, 'coletas');
            
            document.getElementById('btnOpenLegacyPreview').onclick = () => {
                renderLegacyPreview();
                document.getElementById('legacyPreviewModal').style.display = 'flex';
            };
        }
```

with:

```js
    <script type="module">
        import db from './database.js';
        import { getGasUrl, setGasUrl, checkAndImportRoteiros } from './google-sync.js';

        let legacyData = { rotas: [], roteiros: [], coletas: [] };

        async function init() {
            await db.init();
            updateStats();

            document.getElementById('gasUrl').value = getGasUrl();
            document.getElementById('gasUrl').onchange = (e) => setGasUrl(e.target.value.trim());

            // File listeners
            document.getElementById('legacyRota').onchange = (e) => handleFile(e, 'rotas');
            document.getElementById('legacyRoteiro').onchange = (e) => handleFile(e, 'roteiros');
            document.getElementById('legacyColeta').onchange = (e) => handleFile(e, 'coletas');
            
            document.getElementById('btnOpenLegacyPreview').onclick = () => {
                renderLegacyPreview();
                document.getElementById('legacyPreviewModal').style.display = 'flex';
            };

            checkDriveUpdate();
        }
```

- [ ] **Step 5: Add the pending-sync count to `updateStats`, replace `testSync` with `checkDriveUpdate`**

In `admin.html`, replace:

```js
        function updateStats() {
            const pCount = db.db.exec("SELECT COUNT(*) FROM clientes")[0]?.values[0][0] || 0;
            const cCount = db.db.exec("SELECT COUNT(*) FROM coletas")[0]?.values[0][0] || 0;
            document.getElementById('statPointsCount').textContent = pCount;
            document.getElementById('statCollectsCount').textContent = cCount;
        }

        window.testSync = () => {
            const url = document.getElementById('supabaseUrl').value;
            const key = document.getElementById('supabaseKey').value;
            if (!url || !key) {
                alert("Por favor, preencha as credenciais do Supabase.");
                return;
            }
            showLoader("Sincronizando com Supabase...");
            
            // Placeholder for real sync logic
            setTimeout(() => {
                hideLoader();
                document.getElementById('syncStatusDot').className = 'status-dot status-online';
                document.getElementById('syncStatusText').textContent = 'Conectado ao Supabase';
                alert("Sincronização concluída! Dados agora disponíveis na rede.");
            }, 2000);
        };
```

with:

```js
        function updateStats() {
            const pCount = db.db.exec("SELECT COUNT(*) FROM clientes")[0]?.values[0][0] || 0;
            const cCount = db.db.exec("SELECT COUNT(*) FROM coletas")[0]?.values[0][0] || 0;
            document.getElementById('statPointsCount').textContent = pCount;
            document.getElementById('statCollectsCount').textContent = cCount;
            document.getElementById('statPendingSyncCount').textContent = db.getUnsyncedColetas().length;
        }

        window.checkDriveUpdate = async () => {
            const dot = document.getElementById('syncStatusDot');
            const text = document.getElementById('syncStatusText');

            if (!getGasUrl()) {
                dot.className = 'status-dot status-offline';
                text.textContent = 'URL do Google Apps Script não configurada';
                return;
            }

            text.textContent = 'Verificando atualização...';
            const result = await checkAndImportRoteiros(db);

            if (result.error) {
                dot.className = 'status-dot status-offline';
                text.textContent = `Erro: ${result.error}`;
                return;
            }

            dot.className = 'status-dot status-online';
            text.textContent = result.updated
                ? `Atualizado agora: ${result.roteiros} roteiros, ${result.clientes} pontos`
                : 'Rotas e pontos já estão atualizados';

            updateStats();
        };
```

- [ ] **Step 6: Manually verify the no-URL and set-URL paths**

With the local server running, open `http://localhost:8080/admin.html` in
a private/incognito window.

Expected on load: status dot is red/offline, text reads "URL do Google
Apps Script não configurada". Type any text (e.g. `https://example.com/exec`)
into the "URL do Web App..." field and click away (blur) to trigger
`onchange`, then click "Verificar agora".

Expected: text briefly shows "Verificando atualização...", then shows an
"Erro: ..." message (the fetch to `https://example.com/exec` will fail or
return non-JSON) — confirming the error path renders without throwing.
Reload the page: the URL field should still show the value you typed
(persisted in `localStorage` under `app3_gas_url`).

- [ ] **Step 7: Commit**

```bash
git add admin.html
git commit -m "feat(admin): replace mock Supabase card with real Google sync"
```

---

## Task 8: `index.html` — silent background check on dashboard load

**Files:**
- Modify: `index.html:289-319`

**Interfaces:**
- Consumes: `checkAndImportRoteiros(db) -> Promise<{checked, updated?, ...}>` from Task 2

- [ ] **Step 1: Add PapaParse script, import `checkAndImportRoteiros`, refresh stats after a silent update**

In `index.html`, replace:

```html
    <script type="module">
        import db from './database.js';

        async function init() {
            try {
                await db.init();
                // Update stats
                const roteiros = db.getRoteiros();
                document.getElementById('stat-routes').textContent = roteiros.length;
                
                const allPointsRes = db.db.exec("SELECT COUNT(*) FROM clientes WHERE ativo = 1");
                document.getElementById('stat-points').textContent = allPointsRes.length ? allPointsRes[0].values[0][0] : 0;

                const collectsRes = db.db.exec("SELECT COUNT(*) FROM coletas");
                document.getElementById('stat-collects').textContent = collectsRes.length ? collectsRes[0].values[0][0] : 0;

                const issuesRes = db.db.exec("SELECT COUNT(*) FROM coletas WHERE intercorrencia != '' AND intercorrencia != 'Nenhuma'");
                document.getElementById('stat-issues').textContent = issuesRes.length ? issuesRes[0].values[0][0] : 0;

                document.getElementById('btnBackup').onclick = () => db.downloadDatabase();
            } catch (e) {
                console.error("Database error", e);
            }
        }

        // We need to load sql.js before importing database.js if it uses it immediately
        // But since we are using modules, we can handle it inside init()
        init();
    </script>
    <script src="vendor/sql-wasm.js"></script>
```

with:

```html
    <script type="module">
        import db from './database.js';
        import { checkAndImportRoteiros } from './google-sync.js';

        function refreshStats() {
            const roteiros = db.getRoteiros();
            document.getElementById('stat-routes').textContent = roteiros.length;

            const allPointsRes = db.db.exec("SELECT COUNT(*) FROM clientes WHERE ativo = 1");
            document.getElementById('stat-points').textContent = allPointsRes.length ? allPointsRes[0].values[0][0] : 0;

            const collectsRes = db.db.exec("SELECT COUNT(*) FROM coletas");
            document.getElementById('stat-collects').textContent = collectsRes.length ? collectsRes[0].values[0][0] : 0;

            const issuesRes = db.db.exec("SELECT COUNT(*) FROM coletas WHERE intercorrencia != '' AND intercorrencia != 'Nenhuma'");
            document.getElementById('stat-issues').textContent = issuesRes.length ? issuesRes[0].values[0][0] : 0;
        }

        async function init() {
            try {
                await db.init();
                refreshStats();
                document.getElementById('btnBackup').onclick = () => db.downloadDatabase();

                checkAndImportRoteiros(db).then(result => {
                    if (result.updated) refreshStats();
                });
            } catch (e) {
                console.error("Database error", e);
            }
        }

        // We need to load sql.js before importing database.js if it uses it immediately
        // But since we are using modules, we can handle it inside init()
        init();
    </script>
    <script src="vendor/sql-wasm.js"></script>
    <script src="vendor/papaparse.min.js"></script>
```

- [ ] **Step 2: Manually verify the silent no-URL path doesn't break the dashboard**

With the local server running, open `http://localhost:8080/index.html` in
a private/incognito window (no `app3_gas_url` set).

Expected: dashboard renders normally with stats (0s on a fresh DB), no
alerts, no visible errors. Open DevTools console — no uncaught errors
(the `checkAndImportRoteiros` call resolves quietly to
`{checked: false, reason: 'no-url'}`).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(index): silently refresh rotas/pontos from Drive on dashboard load"
```

---

## Task 9: Update `README.md` and `PUBLICACAO.md`

**Files:**
- Modify: `README.md:12`, `README.md:27`
- Modify: `PUBLICACAO.md:18`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Update `README.md`**

In `README.md`, replace:

```markdown
- `admin.html`: importacao legada, backup local e placeholder de sincronizacao
```

with:

```markdown
- `admin.html`: importacao legada, backup local e sincronizacao com Google Sheets/Drive via Apps Script
```

Then replace:

```markdown
- `admin.html` exibe campos de Supabase, mas a sincronizacao ainda e mock e nao envia dados.
```

with:

```markdown
- `admin.html` sincroniza de verdade: coletas sao enviadas a uma planilha Google Sheets e rotas/pontos sao importados automaticamente de um CSV numa pasta do Google Drive, atraves de um Web App Google Apps Script. Codigo-fonte e instrucoes de deploy do script em `gas/`.
```

- [ ] **Step 2: Update `PUBLICACAO.md`**

In `PUBLICACAO.md`, replace:

```markdown
- A area "Sincronizacao Supabase" em `admin.html` e apenas placeholder visual.
```

with:

```markdown
- A area "Sincronizacao Google" em `admin.html` envia dados reais para um Web App Google Apps Script (sem autenticacao, URL configuravel na propria pagina). O codigo do Apps Script vive em `gas/` e nao faz parte do deploy do site estatico — e colado manualmente no editor do Apps Script (ver `gas/README.md`).
```

- [ ] **Step 3: Commit**

```bash
git add README.md PUBLICACAO.md
git commit -m "docs: describe the real Google sync in place of the Supabase mock"
```
