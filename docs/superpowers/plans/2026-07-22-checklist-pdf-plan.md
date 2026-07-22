# Checklist da Próxima Coleta (PDF) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-side PDF generator to `coleta-checklist.html` that produces a "checklist da próxima coleta" (same shape as the legacy `legado/coleta-checklist.html` print flow), with buttons to download it locally and/or send it to a Google Drive folder via the existing GAS Web App, so the person who prints it doesn't depend on whoever generated it.

**Architecture:** Two new vendored libraries (jsPDF + jsPDF-AutoTable) build a real PDF in the browser from the currently-loaded route's clients and this session's entered quantities/issues. A new modal collects próxima-coleta metadata (date, tipo de resíduo, motorista, veículo) — transient, not persisted. `google-sync.js` gains one export (`sendChecklistToDrive`) that POSTs the PDF as base64 to the same GAS Web App used for coleta/CSV sync, discriminated by payload shape. `gas/Code.gs`'s `doPost` is refactored into two named handlers (coletas vs. checklist) behind one dispatcher, writing to a new, separate Drive folder (`CHECKLISTS_FOLDER_ID`), overwriting any file with the same name.

**Tech Stack:** Vanilla JS ES modules, jsPDF 2.5.2 + jsPDF-AutoTable 3.8.2 (vendored UMD builds), Google Apps Script (`DriveApp`, `Utilities`, `PropertiesService`).

## Global Constraints

- No build process, no bundler, no package manager — vendored libraries are plain UMD `<script>` files dropped into `vendor/`, same pattern as the existing `vendor/papaparse.min.js`/`vendor/xlsx.full.min.js`.
- No automated test framework in this repo. Verification is manual: a real browser via a local static server (`python -m http.server 8080` from the repo root) is preferred; a documented code-reading fallback is acceptable when no browser automation is available, same practice used throughout the prior sync-feature plan. State explicitly which was used.
- This is a **new, separate** flow in `coleta-checklist.html` — it does not touch or replace `imprimir.html` (which stays as the generic, historical-average, any-time print flow triggered from `roteiros.html`).
- The modal's fields (Data da Próxima Coleta, Tipo de Resíduo, Motorista, Veículo) are **transient** — no database schema changes, nothing written to `database.js`/SQLite.
- The checklist PDF's "Bomb. Qtd." column uses **this session's** `sessionData[id_rota].qty` (the quantity just entered for today's collection), not a historical average — it is the prediction for the next visit, exactly like `legado/coleta-checklist.html`'s `generateChecklist()`.
- File name in Drive: `Checklist_{roteiroNome}_{proxDataISO}.pdf` (e.g. `Checklist_SAT01_2026-07-23.pdf`). Resending the same route + próxima-coleta date **overwrites** the existing file in Drive (delete-then-create) — no version accumulation.
- "Baixar PDF" works even with an empty "Data da Próxima Coleta" (shows blank date in the PDF header, matches `legado`'s `formatDateBR` fallback of `____/____/________`). "Enviar para Drive" requires that date non-empty (used in the filename) — if empty, show an alert and do not call the network.
- POST bodies to the GAS Web App use `Content-Type: text/plain;charset=utf-8` (not `application/json`), same CORS-preflight-avoidance pattern already used by `pushColetas` in `google-sync.js`.
- GAS Web App has no auth token (established decision, unchanged).

---

## Task 1: Vendor jsPDF + jsPDF-AutoTable

**Files:**
- Create: `vendor/jspdf.umd.min.js`
- Create: `vendor/jspdf.plugin.autotable.min.js`

**Interfaces:**
- Produces: browser globals `window.jspdf.jsPDF` (the `jsPDF` class constructor) and, once `jspdf.plugin.autotable.min.js` loads after it, `jsPDF.prototype.autoTable` (adds an `autoTable(options)` method to any `jsPDF` instance, plus sets `doc.lastAutoTable.finalY` after each call) — both consumed by Task 4.
- Load order requirement: `jspdf.umd.min.js` MUST be loaded (as a classic `<script>`) before `jspdf.plugin.autotable.min.js` — the autotable plugin extends `jsPDF`'s prototype at load time and does nothing useful if `jsPDF` isn't defined yet.

- [ ] **Step 1: Download both vendor files**

```bash
curl -sL https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js -o vendor/jspdf.umd.min.js
curl -sL https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js -o vendor/jspdf.plugin.autotable.min.js
```

If `curl` is unavailable or network access is blocked in your environment, report BLOCKED with that specific error — do not fabricate or hand-write a substitute file.

- [ ] **Step 2: Verify file integrity**

```bash
wc -c vendor/jspdf.umd.min.js vendor/jspdf.plugin.autotable.min.js
head -c 200 vendor/jspdf.umd.min.js
head -c 200 vendor/jspdf.plugin.autotable.min.js
```

Expected: `vendor/jspdf.umd.min.js` is approximately 365730 bytes (±a few KB is fine if the CDN serves a slightly different byte-identical-content encoding; a wildly different size, e.g. under 10000 bytes, means the download failed — check for an HTML error page instead of JS). `vendor/jspdf.plugin.autotable.min.js` is approximately 38976 bytes. Both `head -c 200` outputs should show a JS/license comment header mentioning "jsPDF" — not HTML (`<html>`, `<!DOCTYPE`) and not a JSON error body.

- [ ] **Step 3: Run a Node sanity check that jsPDF itself loads and constructs**

```bash
node -e "
global.window = global;
global.self = global;
const jspdfExports = require('./vendor/jspdf.umd.min.js');
const { jsPDF } = jspdfExports;
const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
doc.text('Teste Checklist', 10, 10);
console.log('jsPDF constructed OK, output is function:', typeof doc.output === 'function');
"
```

Expected output: `jsPDF constructed OK, output is function: true`

Note: this check only exercises `jspdf.umd.min.js` alone (under Node's CommonJS branch, which is a different code path than the browser). It does NOT prove `jspdf.plugin.autotable.min.js` interoperates with it — that plugin detects `require("jspdf")` as a real npm package when run under Node and gets confused in a way that does not reflect real browser behavior (browsers have no `require`/`module`, so the UMD wrapper takes the plain-`window`-global branch instead, which is what actually runs in production). Do not attempt to force autotable to work under Node — it is not worth fighting the environment for a false signal. The autotable + jsPDF combination is verified for real in Task 4, in an actual browser.

- [ ] **Step 4: Commit**

```bash
git add vendor/jspdf.umd.min.js vendor/jspdf.plugin.autotable.min.js
git commit -m "chore: vendor jsPDF + jsPDF-AutoTable for client-side checklist PDFs"
```

---

## Task 2: `gas/Code.gs` — checklist PDF upload route

**Files:**
- Modify: `gas/Code.gs` (full file — `getConfig_`, and `doPost` split into a dispatcher plus two named handlers)
- Modify: `gas/README.md` (add `CHECKLISTS_FOLDER_ID` setup step + a `curl` test for the new payload shape)

**Interfaces:**
- Produces: `doPost` now accepts EITHER `{ coletas: [...] }` (existing, unchanged behavior) OR `{ checklist: { filename: string, pdfBase64: string } }` (new). Response for the new shape: `{ ok: true }` on success, `{ ok: false, error: string }` on failure — same envelope style as every other GAS response.
- Consumed by Task 3's `sendChecklistToDrive(filename, pdfBase64)`, which sends exactly `{ checklist: { filename, pdfBase64 } }` as the POST body.

- [ ] **Step 1: Replace `gas/Code.gs` in full**

Replace the entire contents of `gas/Code.gs` with:

```js
/**
 * Google Apps Script Web App bridge for the SATELITE v3 checklist app.
 * Deploy as Web App (Execute as: Me, Who has access: Anyone).
 *
 * Script Properties required (Project Settings > Script Properties):
 *   SPREADSHEET_ID        - id of the Google Sheet that receives coleta rows
 *   DRIVE_FOLDER_ID        - id of the Drive folder containing cstExportaCheckList.csv
 *   CHECKLISTS_FOLDER_ID   - id of the Drive folder that receives checklist PDFs
 */

var CSV_FILE_NAME = 'cstExportaCheckList.csv';
var COLETAS_SHEET_NAME = 'Coletas';

function getConfig_() {
    var props = PropertiesService.getScriptProperties();
    return {
        spreadsheetId: props.getProperty('SPREADSHEET_ID'),
        folderId: props.getProperty('DRIVE_FOLDER_ID'),
        checklistsFolderId: props.getProperty('CHECKLISTS_FOLDER_ID')
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
    try {
        var body = JSON.parse(e.postData.contents);

        if (body.checklist) {
            return saveChecklist_(body.checklist);
        }

        return saveColetas_(body.coletas || []);
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function saveColetas_(coletas) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }

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
}

function saveChecklist_(checklist) {
    var config = getConfig_();
    if (!config.checklistsFolderId) {
        return jsonResponse_({ ok: false, error: 'CHECKLISTS_FOLDER_ID não configurado' });
    }
    if (!checklist.filename || !checklist.pdfBase64) {
        return jsonResponse_({ ok: false, error: 'filename ou pdfBase64 ausente' });
    }

    var folder = DriveApp.getFolderById(config.checklistsFolderId);

    var existing = folder.getFilesByName(checklist.filename);
    while (existing.hasNext()) {
        existing.next().setTrashed(true);
    }

    var bytes = Utilities.base64Decode(checklist.pdfBase64);
    var blob = Utilities.newBlob(bytes, 'application/pdf', checklist.filename);
    folder.createFile(blob);

    return jsonResponse_({ ok: true });
}
```

- [ ] **Step 2: Update `gas/README.md`**

In `gas/README.md`, replace step 5 (the Script Properties list):

```markdown
5. Em "Configurações do projeto" (ícone de engrenagem) > "Propriedades do
   script", adicione:
   - `SPREADSHEET_ID` = o ID copiado no passo 1
   - `DRIVE_FOLDER_ID` = o ID copiado no passo 2
```

with:

```markdown
5. Crie também uma pasta separada no Google Drive para os PDFs de checklist
   (não a mesma do CSV) e copie o ID dela da URL, do mesmo jeito que no
   passo 2.
6. Em "Configurações do projeto" (ícone de engrenagem) > "Propriedades do
   script", adicione:
   - `SPREADSHEET_ID` = o ID copiado no passo 1
   - `DRIVE_FOLDER_ID` = o ID copiado no passo 2
   - `CHECKLISTS_FOLDER_ID` = o ID da pasta de checklists criada agora
```

Then renumber the remaining steps (old 6→7, 7→8, 8→9) by replacing:

```markdown
6. Clique em "Implantar" > "Nova implantação" > tipo "App da Web".
   - Executar como: **Eu** (sua conta)
   - Quem tem acesso: **Qualquer pessoa**
7. Autorize as permissões solicitadas (acesso a Sheets e Drive).
8. Copie a URL do Web App gerada (termina em `/exec`) — essa é a URL que
   vai no campo "URL do Web App do Google Apps Script" em `admin.html`.
```

with:

```markdown
7. Clique em "Implantar" > "Nova implantação" > tipo "App da Web".
   - Executar como: **Eu** (sua conta)
   - Quem tem acesso: **Qualquer pessoa**
8. Autorize as permissões solicitadas (acesso a Sheets e Drive).
9. Copie a URL do Web App gerada (termina em `/exec`) — essa é a URL que
   vai no campo "URL do Web App do Google Apps Script" em `admin.html`.
```

Finally, add a new `curl` example at the end of the "Teste manual pós-deploy" section, after the existing `coletas` POST example and before the "Toda vez que o `Code.gs` for editado..." paragraph:

```markdown
Para testar o envio de checklist (substitua `<URL>`; o base64 abaixo é o
texto "teste" codificado, só para confirmar que a rota funciona — não é um
PDF válido, mas é suficiente para verificar que o arquivo aparece na pasta):

\`\`\`bash
curl -X POST "<URL>" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"checklist":{"filename":"Checklist_TESTE_2026-01-01.pdf","pdfBase64":"dGVzdGU="}}'
\`\`\`

Esperado: `{"ok":true}`, e um arquivo `Checklist_TESTE_2026-01-01.pdf` na
pasta configurada em `CHECKLISTS_FOLDER_ID`. Rodar o mesmo comando de novo
deve substituir esse arquivo (mesmo nome), não duplicar.
```

- [ ] **Step 3: Verify by reading both files back**

No automated execution is possible for `Code.gs` (it only runs inside a live Apps Script deployment). Re-read both files after editing and confirm:
- `gas/Code.gs`: `doPost` no longer directly builds the sheet — it only parses the body and dispatches to `saveChecklist_` or `saveColetas_`. `saveColetas_`'s body is byte-identical in behavior to the old `doPost` (same header row, same column order, same `now`/`sync_id` handling) — this is a refactor, not a behavior change for the coletas path.
- `gas/README.md`: step numbering is sequential with no gaps or duplicates (1 through 9), and the new `CHECKLISTS_FOLDER_ID` step appears before the deploy step.

- [ ] **Step 4: Commit**

```bash
git add gas/Code.gs gas/README.md
git commit -m "feat(gas): add checklist PDF upload route to doPost"
```

---

## Task 3: `google-sync.js` — `sendChecklistToDrive`

**Files:**
- Modify: `google-sync.js` (add one new export)

**Interfaces:**
- Produces: `sendChecklistToDrive(filename: string, pdfBase64: string) -> Promise<{ok: boolean, error?: string}>` — never throws (catches internally, same pattern as `pushColetas`).
- Consumed by Task 4's `coleta-checklist.html`.

- [ ] **Step 1: Add `sendChecklistToDrive` to `google-sync.js`**

At the end of `google-sync.js`, after the existing `checkAndImportRoteiros` function, add:

```js

export async function sendChecklistToDrive(filename, pdfBase64) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ checklist: { filename, pdfBase64 } })
        });
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}
```

- [ ] **Step 2: Write the disposable verification harness (no-URL negative path)**

Create `_verify_task3.html` in the repo root:

```html
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body>
<script type="module">
import { sendChecklistToDrive } from './google-sync.js';

async function run() {
    localStorage.removeItem('app3_gas_url');
    console.log('sendChecklistToDrive (no url):', await sendChecklistToDrive('teste.pdf', 'dGVzdGU='));
}

run();
</script>
</body>
</html>
```

If no browser automation is available in your environment, use the same Node approach as the prior sync-feature plan instead: shim `globalThis.localStorage` with an in-memory Map-backed object, dynamically `import()` `./google-sync.js` (absolute path via `pathToFileURL`, run from the repo root), and call `sendChecklistToDrive('teste.pdf', 'dGVzdGU=')` directly — no DOM/HTML wrapper needed for this specific function.

- [ ] **Step 3: Run the harness and verify output**

Browser: `python -m http.server 8080` from the repo root, open `http://localhost:8080/_verify_task3.html`, check DevTools console. Node: run your script with `node`.

Expected output (either way):
```
sendChecklistToDrive (no url): {ok: false, error: 'URL do GAS não configurada'}
```

- [ ] **Step 4: Delete the harness (or scratch Node script) and commit**

```bash
rm -f _verify_task3.html
git add google-sync.js
git commit -m "feat: add sendChecklistToDrive to google-sync.js"
```

---

## Task 4: `coleta-checklist.html` — checklist modal + PDF generation

**Files:**
- Modify: `coleta-checklist.html` (styles, header button, new modal HTML, script imports, new JS functions)

**Interfaces:**
- Consumes: `window.jspdf.jsPDF` and `jsPDF.prototype.autoTable` from Task 1's vendored files.
- Consumes: `sendChecklistToDrive(filename, pdfBase64)` from Task 3.
- Consumes existing module-level state already in this file: `currentClients` (array of `{id_rota, cliente, logradouro, numero, cep, ordem, ...}`), `sessionData` (`{[id_rota]: {qty, issue}}`), and the existing `#routeSelect`/`#opDate` inputs.

- [ ] **Step 1: Add the two vendor script tags**

In `coleta-checklist.html`, replace:

```html
    <script src="https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js"></script>
</body>
</html>
```

with:

```html
    <script src="https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/sql-wasm.js"></script>
    <script src="vendor/jspdf.umd.min.js"></script>
    <script src="vendor/jspdf.plugin.autotable.min.js"></script>
</body>
</html>
```

(These load as classic scripts after the module script tag in document order — same working pattern already used for `sql-wasm.js` in this exact file: classic scripts execute synchronously as the parser reaches them, while the `<script type="module">` above is deferred until after the document finishes parsing, so both globals exist by the time `init()` actually runs.)

- [ ] **Step 2: Add CSS for the header button and modal**

In `coleta-checklist.html`, in the `<style>` block, immediately before the closing `</style>` tag (after the existing `#toast { ... }` rule), add:

```css
        .btn-checklist {
            background: transparent;
            border: 1px solid var(--card-border);
            color: var(--text);
            padding: 8px 14px;
            border-radius: 8px;
            cursor: pointer;
            font-family: inherit;
            font-size: 0.85rem;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: border-color 0.2s;
        }
        .btn-checklist:hover { border-color: var(--primary); }

        .modal-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 1000;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .modal-overlay.open { display: flex; }
        .modal-card {
            background: var(--surface);
            border: 1px solid var(--card-border);
            border-radius: 16px;
            padding: 30px;
            width: 100%;
            max-width: 420px;
            display: flex;
            flex-direction: column;
            gap: 15px;
        }
        .modal-card h2 { font-size: 1.3rem; }
        .modal-field { display: flex; flex-direction: column; gap: 6px; }
        .modal-field label { font-size: 0.8rem; color: var(--text-dim); }
        .modal-field input, .modal-field select { width: 100%; }
        .modal-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
        .modal-actions button {
            flex: 1;
            min-width: 100px;
            padding: 10px 16px;
            border-radius: 8px;
            border: none;
            cursor: pointer;
            font-weight: 600;
            font-family: inherit;
        }
        .btn-modal-primary { background: var(--primary); color: #000; }
        .btn-modal-success { background: var(--success); color: #fff; }
        .btn-modal-cancel { background: transparent; border: 1px solid var(--card-border) !important; color: var(--text-dim); }
```

- [ ] **Step 3: Add the header button**

In `coleta-checklist.html`, replace:

```html
            <div class="controls">
                <select id="routeSelect">
                    <option value="">Selecione o Roteiro</option>
                </select>
                <input type="date" id="opDate">
            </div>
```

with:

```html
            <div class="controls">
                <select id="routeSelect">
                    <option value="">Selecione o Roteiro</option>
                </select>
                <input type="date" id="opDate">
                <button class="btn-checklist" id="btnChecklist" type="button">📋 Checklist Próxima Coleta</button>
            </div>
```

- [ ] **Step 4: Add the modal HTML**

In `coleta-checklist.html`, replace:

```html
    <div id="toast">Operação salva com sucesso!</div>

    <script type="module">
```

with:

```html
    <div id="toast">Operação salva com sucesso!</div>

    <div class="modal-overlay" id="checklistModal">
        <div class="modal-card">
            <h2>Checklist Próxima Coleta</h2>
            <div class="modal-field">
                <label>Data da Próxima Coleta</label>
                <input type="date" id="proxData">
            </div>
            <div class="modal-field">
                <label>Tipo de Resíduo</label>
                <select id="tipoResiduo">
                    <option value="Vidros">Vidros</option>
                    <option value="Organicos">Orgânicos</option>
                    <option value="Plasticos">Plásticos</option>
                    <option value="Papel e Papelao">Papel e Papelão</option>
                    <option value="Oleo de Cozinha">Óleo de Cozinha</option>
                    <option value="Bombonas">Bombonas</option>
                    <option value="Residuos Solidos">Resíduos Sólidos</option>
                </select>
            </div>
            <div class="modal-field">
                <label>Motorista (opcional)</label>
                <input type="text" id="checklistMotorista" placeholder="Nome do motorista">
            </div>
            <div class="modal-field">
                <label>Veículo (opcional)</label>
                <input type="text" id="checklistVeiculo" placeholder="Placa ou identificação">
            </div>
            <div class="modal-actions">
                <button class="btn-modal-cancel" id="btnChecklistCancel">Cancelar</button>
                <button class="btn-modal-primary" id="btnChecklistDownload">Baixar PDF</button>
                <button class="btn-modal-success" id="btnChecklistSend">Enviar para Drive</button>
            </div>
        </div>
    </div>

    <script type="module">
```

- [ ] **Step 5: Import `sendChecklistToDrive` and wire the new buttons in `init()`**

In `coleta-checklist.html`, replace:

```js
        import db from './database.js';
        import { pushColetas } from './google-sync.js';
```

with:

```js
        import db from './database.js';
        import { pushColetas, sendChecklistToDrive } from './google-sync.js';
```

Then replace:

```js
            select.onchange = loadRoute;
            document.getElementById('btnSave').onclick = saveOperation;
```

with:

```js
            select.onchange = loadRoute;
            document.getElementById('btnSave').onclick = saveOperation;

            document.getElementById('btnChecklist').onclick = openChecklistModal;
            document.getElementById('btnChecklistCancel').onclick = closeChecklistModal;
            document.getElementById('btnChecklistDownload').onclick = downloadChecklist;
            document.getElementById('btnChecklistSend').onclick = sendChecklistToDriveHandler;
```

- [ ] **Step 6: Add the checklist modal/PDF functions**

In `coleta-checklist.html`, replace:

```js
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

        init();
```

with:

```js
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

        function openChecklistModal() {
            if (!document.getElementById('routeSelect').value) {
                alert('Selecione um roteiro primeiro');
                return;
            }
            document.getElementById('proxData').value = '';
            document.getElementById('checklistModal').classList.add('open');
        }

        function closeChecklistModal() {
            document.getElementById('checklistModal').classList.remove('open');
        }

        function formatDateBR(dateStr) {
            if (!dateStr) return '____/____/________';
            const parts = dateStr.split('-');
            if (parts.length !== 3) return dateStr;
            return `${parts[2]}/${parts[1]}/${parts[0]}`;
        }

        function buildChecklistDoc() {
            const { jsPDF } = window.jspdf;
            const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

            const routeSelect = document.getElementById('routeSelect');
            const roteiroNome = routeSelect.options[routeSelect.selectedIndex]
                ? routeSelect.options[routeSelect.selectedIndex].textContent
                : '';
            const dataColeta = document.getElementById('opDate').value;
            const proxData = document.getElementById('proxData').value;
            const tipoResiduo = document.getElementById('tipoResiduo').value;
            const motorista = document.getElementById('checklistMotorista').value.trim();
            const veiculo = document.getElementById('checklistVeiculo').value.trim();

            let totalPrevisto = 0;
            const rows = currentClients.map((c, i) => {
                const session = sessionData[c.id_rota] || {};
                const qty = session.qty > 0 ? session.qty : '';
                if (session.qty > 0) totalPrevisto += session.qty;
                return [
                    c.ordem || (i + 1),
                    c.cliente,
                    c.logradouro || '',
                    c.numero || '',
                    c.cep || '',
                    c.id_rota,
                    qty,
                    '',
                    session.issue || ''
                ];
            });

            doc.setFontSize(16);
            doc.text(`Checklist Coleta ${roteiroNome}`, 14, 15);
            doc.setFontSize(9);
            doc.text(`Data da Coleta: ${formatDateBR(dataColeta)}   Proxima Coleta: ${formatDateBR(proxData)}`, 14, 22);
            doc.text(`Tipo de Residuo: ${tipoResiduo}   Total de Pontos: ${currentClients.length}   Bombonas Previstas: ${totalPrevisto}`, 14, 27);
            if (motorista) doc.text(`Motorista: ${motorista}`, 14, 32);
            if (veiculo) doc.text(`Veiculo: ${veiculo}`, 100, 32);

            doc.autoTable({
                startY: 36,
                head: [['Ord.', 'Cliente', 'Logradouro', 'No', 'CEP', 'ID', 'Bomb. Qtd.', 'Qtd. Coletada', 'Problema']],
                body: rows,
                styles: { fontSize: 8 },
                headStyles: { fillColor: [26, 58, 92] }
            });

            const finalY = doc.lastAutoTable.finalY + 20;
            doc.text('_______________________', 30, finalY);
            doc.text('Motorista', 55, finalY + 5);
            doc.text('_______________________', 180, finalY);
            doc.text('Supervisor', 205, finalY + 5);

            const filename = `Checklist_${roteiroNome}_${proxData || 'sem-data'}.pdf`;

            return { doc, filename, proxData };
        }

        function downloadChecklist() {
            const { doc, filename } = buildChecklistDoc();
            doc.save(filename);
        }

        async function sendChecklistToDriveHandler() {
            const proxData = document.getElementById('proxData').value;
            if (!proxData) {
                alert('Preencha a Data da Proxima Coleta para enviar ao Drive.');
                return;
            }

            const { doc, filename } = buildChecklistDoc();
            const dataUri = doc.output('datauristring');
            const pdfBase64 = dataUri.split(',')[1];

            const result = await sendChecklistToDrive(filename, pdfBase64);
            if (result.ok) {
                alert('Checklist enviado para o Drive com sucesso!');
                closeChecklistModal();
            } else {
                alert(`Falha ao enviar: ${result.error || 'erro desconhecido'}`);
            }
        }

        init();
```

- [ ] **Step 7: Manually verify in the browser**

With the local server running (`python -m http.server 8080` from the repo root), open `http://localhost:8080/coleta-checklist.html` in a private/incognito window, select a route (one with at least one point), enter a quantity for one point, then click "📋 Checklist Próxima Coleta".

Expected: modal opens. Fill "Data da Próxima Coleta" with any date, leave the rest default, click "Baixar PDF". Expected: a PDF file downloads named `Checklist_<ROTEIRO>_<data>.pdf`; open it and confirm it shows the route name, both dates, a table row per point with the quantity you entered in the "Bomb. Qtd." column, an empty "Qtd. Coletada" column, and two signature lines at the bottom.

Then click "📋 Checklist Próxima Coleta" again, clear the "Data da Próxima Coleta" field, click "Enviar para Drive". Expected: an alert "Preencha a Data da Proxima Coleta para enviar ao Drive." and no network request (confirm in DevTools Network tab — no request to the GAS URL). Fill the date back in and click "Enviar para Drive" again without a GAS URL configured (fresh profile, `app3_gas_url` unset). Expected: alert "Falha ao enviar: URL do GAS não configurada".

If no browser automation is available in your environment, use the documented fallback: read `buildChecklistDoc`/`downloadChecklist`/`sendChecklistToDriveHandler` carefully against this exact same set of expectations, explicitly compare old-vs-new for anything you touched (Step 1/3/5 all insert `+` next to unrelated context lines only — confirm nothing existing, like `saveOperation`'s wiring, was disturbed), and state clearly in your report that this is a code-reading fallback, not an executed check.

- [ ] **Step 8: Commit**

```bash
git add coleta-checklist.html
git commit -m "feat(coleta): generate and send next-collection checklist PDF"
```
