# Notificação de última sincronização da pasta de rede — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar, de forma discreta e sempre visível em `index.html` e `coleta-checklist.html`, a data/hora de modificação do `cstExportaCheckList.csv` mais recente já importado pelo app, dando confiança ao operador de que os dados são atuais.

**Architecture:** Um único getter novo em `google-sync.js` (`getLastRotasRedeSyncLabel()`) lê `localStorage['app3_last_rotas_rede_sync']` (já setado por `checkAndImportRoteirosRede`) e devolve a string final pronta pra exibir — cobrindo os 3 casos (nunca sincronizado, fora do Tauri, com timestamp) num só lugar, sem chamada de rede nova. `index.html` e `coleta-operation.js` só chamam essa função e escrevem o resultado num elemento de texto no cabeçalho.

**Tech Stack:** JS vanilla (ES modules), sem framework. Testes com `node --experimental-vm-modules` + `assert` (mesmo padrão de `tests/rotas-rede-sync.test.cjs`).

## Global Constraints

- Não fazer nenhuma chamada de rede nova — só leitura de `localStorage`.
- Sem toast/popup — texto estático sempre visível, sem botão de fechar.
- Sem código de cor por "desatualizado" (fora de escopo, ver design doc).
- Reaproveitar a chave `LAST_ROTAS_REDE_SYNC_KEY` já existente em `google-sync.js:10` (`'app3_last_rotas_rede_sync'`) — não criar chave nova.
- Ver spec completa em `docs/superpowers/specs/2026-09-01-notificacao-sync-rede-design.md`.

---

### Task 1: Getter `getLastRotasRedeSyncLabel()` em `google-sync.js`

**Files:**
- Modify: `google-sync.js:169-170` (inserir logo após o fim de `checkAndImportRoteirosRede`)
- Test: `tests/rotas-rede-sync.test.cjs` (estender o arquivo existente)

**Interfaces:**
- Produces: `export function getLastRotasRedeSyncLabel(): string` — string pronta pra exibir, cobre os 3 casos internamente. Consumida pelas Tasks 2 e 3.

- [ ] **Step 1: Escrever o teste que falha**

Abra `tests/rotas-rede-sync.test.cjs`. Antes do bloco `// Pasta de rede inacessivel -> erro tratado, sem lancar excecao.` (penúltimo bloco do arquivo, logo antes do `console.log` final), adicione:

```js
  // getLastRotasRedeSyncLabel: reflete os 3 estados possiveis.
  windowRef.__TAURI__ = undefined;
  assert.strictEqual(
    syncModule.getLastRotasRedeSyncLabel(),
    'Sincronização automática só funciona no app instalado'
  );

  windowRef.__TAURI__ = { core: { invoke: async () => ({ bytes_base64: '', modified_time_ms: 0 }) } };
  localStorage.removeItem('app3_last_rotas_rede_sync');
  assert.strictEqual(
    syncModule.getLastRotasRedeSyncLabel(),
    'Dados: nunca sincronizados automaticamente'
  );

  localStorage.setItem('app3_last_rotas_rede_sync', '1735732800000');
  assert.match(
    syncModule.getLastRotasRedeSyncLabel(),
    /^Dados atualizados em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}$/
  );
```

Coloque esse trecho **antes** do bloco `// Pasta de rede inacessivel`, para não interferir no `windowRef.__TAURI__.core.invoke` que esse bloco final espera.

- [ ] **Step 2: Rodar o teste para confirmar que falha**

Run: `node --experimental-vm-modules tests/rotas-rede-sync.test.cjs`
Expected: FAIL — `TypeError: syncModule.getLastRotasRedeSyncLabel is not a function`

- [ ] **Step 3: Implementar a função**

Em `google-sync.js`, logo após a linha 169 (`}` que fecha `checkAndImportRoteirosRede`) e antes do comentário `// GET com timeout e retry...` (linha 171 atual), insira:

```js

// String pronta pra exibir na UI (index.html, coleta-operation.js) com a
// data/hora de modificacao do CSV mais recente ja importado da pasta de
// rede — nao a hora em que o app checou, mas a hora em que o Access gerou
// o arquivo. So leitura de localStorage, nenhuma chamada de rede nova. Ver
// docs/superpowers/specs/2026-09-01-notificacao-sync-rede-design.md.
export function getLastRotasRedeSyncLabel() {
    const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
        return 'Sincronização automática só funciona no app instalado';
    }
    const ms = Number(localStorage.getItem(LAST_ROTAS_REDE_SYNC_KEY) || 0);
    if (!ms) {
        return 'Dados: nunca sincronizados automaticamente';
    }
    const date = new Date(ms);
    const data = date.toLocaleDateString('pt-BR');
    const hora = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `Dados atualizados em ${data} às ${hora}`;
}
```

- [ ] **Step 4: Rodar o teste para confirmar que passa**

Run: `node --experimental-vm-modules tests/rotas-rede-sync.test.cjs`
Expected: PASS, imprime a linha de sucesso final sem erro.

- [ ] **Step 5: Rodar a suíte completa**

Run: `npm test`
Expected: todos os testes OK (nenhuma regressão).

- [ ] **Step 6: Commit**

```bash
git add google-sync.js tests/rotas-rede-sync.test.cjs
git commit -m "feat(sync): adiciona getLastRotasRedeSyncLabel para exibir data do ultimo import"
```

---

### Task 2: Exibir a label em `index.html`

**Files:**
- Modify: `index.html:64-70` (CSS, logo após a regra `.subtitle`)
- Modify: `index.html:206-211` (markup do header)
- Modify: `index.html:280-315` (script do módulo)

**Interfaces:**
- Consumes: `getLastRotasRedeSyncLabel()` de `google-sync.js` (Task 1).

- [ ] **Step 1: Adicionar CSS**

Em `index.html`, logo após o bloco `.subtitle` (linhas 64-70), adicione:

```css
        .sync-freshness {
            color: var(--text-dim);
            font-size: 0.8rem;
            margin-top: 8px;
        }
```

- [ ] **Step 2: Adicionar o elemento no header**

Em `index.html`, dentro de `<header>` (linhas 208-211), troque:

```html
        <header>
            <div class="logo">SATELITE v3</div>
            <div class="subtitle">SISTEMA INTEGRADO DE GESTÃO DE COLETA</div>
        </header>
```

por:

```html
        <header>
            <div class="logo">SATELITE v3</div>
            <div class="subtitle">SISTEMA INTEGRADO DE GESTÃO DE COLETA</div>
            <p class="sync-freshness" id="syncFreshness"></p>
        </header>
```

- [ ] **Step 3: Importar e chamar a função no script do módulo**

Em `index.html`, a linha 282 hoje é:

```js
        import { checkAndImportRoteirosRede } from './google-sync.js';
```

Troque por:

```js
        import { checkAndImportRoteirosRede, getLastRotasRedeSyncLabel } from './google-sync.js';
```

Em seguida, dentro de `async function init()` (linhas 298-310), troque:

```js
        async function init() {
            try {
                await db.init();
                refreshStats();
                document.getElementById('btnBackup').onclick = () => db.downloadDatabase();

                checkAndImportRoteirosRede(db).then(result => {
                    if (result.updated) refreshStats();
                }).catch(e => console.error("Network sync check failed", e));
            } catch (e) {
                console.error("Database error", e);
            }
        }
```

por:

```js
        async function init() {
            try {
                await db.init();
                refreshStats();
                document.getElementById('btnBackup').onclick = () => db.downloadDatabase();
                document.getElementById('syncFreshness').textContent = getLastRotasRedeSyncLabel();

                checkAndImportRoteirosRede(db).then(result => {
                    if (result.updated) refreshStats();
                    document.getElementById('syncFreshness').textContent = getLastRotasRedeSyncLabel();
                }).catch(e => console.error("Network sync check failed", e));
            } catch (e) {
                console.error("Database error", e);
            }
        }
```

(Chama a função duas vezes de propósito: uma vez com o valor já salvo, pra mostrar algo imediatamente ao abrir; outra depois que `checkAndImportRoteirosRede` resolve, pra refletir um import que acabou de acontecer.)

- [ ] **Step 4: Verificar manualmente no navegador**

Suba um servidor estático na raiz do projeto:

Run: `python -m http.server 8080`

Abra `http://localhost:8080/index.html`. Confirme que aparece, logo abaixo do subtítulo, o texto "Sincronização automática só funciona no app instalado" (navegador comum não tem `window.__TAURI__`).

Pare o servidor depois (`Ctrl+C` ou finalize o processo em background).

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(sync): exibe data da ultima sincronizacao no dashboard"
```

---

### Task 3: Exibir a label em `coleta-checklist.html` / `coleta-operation.js`

**Files:**
- Modify: `coleta-checklist.html:334-337` (markup do header, dentro de `.logo-area`)
- Modify: `coleta-operation.js:1-2` (import)
- Modify: `coleta-operation.js:17-18` (início de `init()`)

**Interfaces:**
- Consumes: `getLastRotasRedeSyncLabel()` de `google-sync.js` (Task 1).

- [ ] **Step 1: Adicionar o elemento no header**

Em `coleta-checklist.html`, troque (linhas 334-337):

```html
            <div class="logo-area">
                <h1>Operação de coleta</h1>
                <p>Registro diário de pontos</p>
            </div>
```

por:

```html
            <div class="logo-area">
                <h1>Operação de coleta</h1>
                <p>Registro diário de pontos</p>
                <p id="syncFreshness"></p>
            </div>
```

(Reaproveita a regra `.logo-area p` já existente em `coleta-desktop.css:44-48` — mesma cor/tamanho do texto acima, sem CSS novo.)

- [ ] **Step 2: Importar a função em `coleta-operation.js`**

Troque a linha 2 de:

```js
import { pushColetas, sendChecklistToDrive, getUltimaColeta, getUltimasQuantidades } from './google-sync.js';
```

por:

```js
import { pushColetas, sendChecklistToDrive, getUltimaColeta, getUltimasQuantidades, getLastRotasRedeSyncLabel } from './google-sync.js';
```

- [ ] **Step 3: Renderizar no início de `init()`**

Em `coleta-operation.js`, troque (linhas 17-18):

```js
async function init() {
    await db.init();
```

por:

```js
async function init() {
    await db.init();
    document.getElementById('syncFreshness').textContent = getLastRotasRedeSyncLabel();
```

- [ ] **Step 4: Verificar manualmente no navegador**

Run: `python -m http.server 8080`

Abra `http://localhost:8080/coleta-checklist.html`. Confirme que aparece, abaixo de "Registro diário de pontos", o texto "Sincronização automática só funciona no app instalado".

Depois, no console do navegador (DevTools), rode:

```js
localStorage.setItem('app3_last_rotas_rede_sync', String(Date.now()));
location.reload();
```

Como ainda não há `window.__TAURI__`, o texto continua sendo o de "só funciona no app instalado" (esperado — a checagem de Tauri vem antes da checagem de timestamp). Isso confirma que a precedência dos 3 estados está correta; o estado "com timestamp" só é alcançável dentro do app Tauri de verdade.

Pare o servidor depois.

- [ ] **Step 5: Commit**

```bash
git add coleta-checklist.html coleta-operation.js
git commit -m "feat(sync): exibe data da ultima sincronizacao na tela de coleta"
```

---

### Task 4: Verificação final com Playwright

**Files:**
- Nenhum arquivo novo — só verificação.

- [ ] **Step 1: Subir servidor estático**

Run: `python -m http.server 8080` (em background)

- [ ] **Step 2: Abrir `index.html` via Playwright e conferir o texto**

Navegue para `http://localhost:8080/index.html`, tire um snapshot de acessibilidade, confirme que o texto `Sincronização automática só funciona no app instalado` aparece dentro do `<header>`, logo abaixo do subtítulo.

- [ ] **Step 3: Abrir `coleta-checklist.html` via Playwright e conferir o texto**

Navegue para `http://localhost:8080/coleta-checklist.html`, confirme o mesmo texto aparecendo abaixo de "Registro diário de pontos".

- [ ] **Step 4: Encerrar o servidor**

Finalize o processo em background do `python -m http.server 8080`.

- [ ] **Step 5: Rodar a suíte completa uma última vez**

Run: `npm test`
Expected: todos os testes OK.

## Self-Review

- **Cobertura da spec:** dado exibido (mtime do arquivo) → Task 1. Casos especiais (nunca sincronizado, not-tauri) → Task 1, testados. Onde mostrar (index + coleta) → Tasks 2 e 3. Estilo discreto sem toast/cor → Tasks 2 e 3 reaproveitam `--text-dim`/`.logo-area p` existentes. Sem chamada de rede nova → getter é só leitura de `localStorage`. Tudo coberto.
- **Placeholders:** nenhum "TBD"/"similar a task N" — cada step tem código completo.
- **Consistência de tipos:** `getLastRotasRedeSyncLabel()` usado com o mesmo nome e sem argumentos nas 3 tasks; `id="syncFreshness"` usado de forma consistente em `index.html` e `coleta-checklist.html` (são documentos HTML diferentes, sem conflito de ID).
