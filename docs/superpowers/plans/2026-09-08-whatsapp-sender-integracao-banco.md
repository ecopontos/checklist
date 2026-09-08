# Disparo WhatsApp — seleção de contatos via banco Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o upload manual de planilha em `whatsapp-sender.html` por uma seleção de destinatários direto do banco SQLite do app (`database.js`), por roteiro.

**Architecture:** Uma nova função pura em `database.js` (`getContatosWhatsapp(roteiroId)`) encapsula a regra de negócio (filtrar ativos, expandir telefone1/telefone2 em contatos separados, normalizar dígitos/código de país, descartar lixo) e é testável isoladamente com o mesmo harness de VM já usado pelos outros testes de `database.js`. `whatsapp-sender.html` vira um consumidor dessa função: passo 1 troca upload+mapeamento por seleção de roteiro(s) via chips, o resto do fluxo (mensagem, envio um a um, resumo) é preservado.

**Tech Stack:** HTML/CSS/JS vanilla (ES modules), sql.js (SQLite WASM), Node `vm` module para testes de `database.js`.

## Global Constraints

- Testes de `database.js` seguem o padrão existente em `tests/*.test.cjs`: contexto `vm` isolado, carrega `database.js` como `vm.SourceTextModule`, sem DOM.
- `whatsapp-sender.html` não tem cobertura automatizada de UI (nenhum framework de teste de DOM no repo) — a verificação da UI é manual, no navegador/app, conforme instruções do projeto para mudanças de frontend.
- Novo teste deve ser adicionado à cadeia do script `test` em `package.json`, na mesma convenção `node --experimental-vm-modules tests/<nome>.test.cjs`.
- Não alterar `prepare-dist.js` — o padrão de cópia genérico (`*.html`, `*.js`, `vendor/`) já cobre os arquivos tocados aqui.

---

## Task 1: `getContatosWhatsapp` em `database.js`

**Files:**
- Modify: `database.js` (adicionar métodos após `getClienteByIdRota`, por volta da linha 209)
- Modify: `package.json` (adicionar novo teste à cadeia do script `test`)
- Test: `tests/whatsapp-contatos.test.cjs`

**Interfaces:**
- Produces: `db.getContatosWhatsapp(roteiroId: number) => Array<{ idRota: string, slot: 1|2, nome: string, telefoneExibicao: string, telefoneDigits: string, roteiroNome: string }>`
  - Só inclui clientes com `ativo = 1`.
  - Para cada cliente, gera 0, 1 ou 2 entradas (uma por `telefone1`/`telefone2`), pulando qualquer telefone cujo normalizado tenha menos de 8 dígitos.
  - `telefoneExibicao` = valor bruto da coluna (como está no banco). `telefoneDigits` = dígitos normalizados, com `55` prefixado quando aplicável.
  - Consumido por `whatsapp-sender.html` na Task 2.

- [ ] **Step 1: Escrever o teste (falhando)**

Criar `tests/whatsapp-contatos.test.cjs`:

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
  const context = vm.createContext({
    console, localStorage, globalThis: null,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    })
  });
  context.globalThis = context;
  return context;
}

async function loadModule(context, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: filename });
  await module.link(() => { throw new Error(`Import inesperado em ${filename}`); });
  await module.evaluate();
  return module.namespace;
}

(async () => {
  const context = createContext();
  const databaseModule = await loadModule(context, 'database.js');
  const db = databaseModule.default;
  await db.init();

  db.addRoteiro('CENTRO LESTE');
  const roteiroId = db.getRoteiros().find(r => r.nome === 'CENTRO LESTE').id;

  // Cliente com os dois telefones validos -> vira 2 contatos
  db.upsertCliente({
    idRota: '1', idCliente: 'c1', Cliente: 'PADARIA X', logradouro: 'Rua A',
    'Número': '10', Complemento: '', CEP: '88000000',
    Telefone1: '48991234567', Telefone2: '(48) 3333-4444',
    roteiro_id: roteiroId, Ordem: 1, ativo: true
  });

  // Cliente so com telefone1, ja com codigo de pais (13 digitos) -> nao mexe
  db.upsertCliente({
    idRota: '2', idCliente: 'c2', Cliente: 'MERCADO Y', logradouro: 'Rua B',
    'Número': '20', Complemento: '', CEP: '88000000',
    Telefone1: '5548991230000', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 2, ativo: true
  });

  // Telefone curto demais (lixo) -> descartado
  db.upsertCliente({
    idRota: '3', idCliente: 'c3', Cliente: 'SEM TELEFONE VALIDO', logradouro: 'Rua C',
    'Número': '30', Complemento: '', CEP: '88000000',
    Telefone1: '1234', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 3, ativo: true
  });

  // Cliente inativo -> nunca aparece, mesmo com telefone valido
  db.upsertCliente({
    idRota: '4', idCliente: 'c4', Cliente: 'INATIVO', logradouro: 'Rua D',
    'Número': '40', Complemento: '', CEP: '88000000',
    Telefone1: '48999998888', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 4, ativo: false
  });

  const contatos = db.getContatosWhatsapp(roteiroId);

  assert.strictEqual(contatos.length, 3, 'esperado 2 contatos da PADARIA X + 1 do MERCADO Y');

  const padaria = contatos.filter(c => c.idRota === '1');
  assert.strictEqual(padaria.length, 2);
  assert.strictEqual(padaria[0].slot, 1);
  assert.strictEqual(padaria[0].telefoneDigits, '5548991234567');
  assert.strictEqual(padaria[0].telefoneExibicao, '48991234567');
  assert.strictEqual(padaria[0].nome, 'PADARIA X');
  assert.strictEqual(padaria[0].roteiroNome, 'CENTRO LESTE');
  assert.strictEqual(padaria[1].slot, 2);
  assert.strictEqual(padaria[1].telefoneDigits, '554833334444');
  assert.strictEqual(padaria[1].telefoneExibicao, '(48) 3333-4444');

  const mercado = contatos.find(c => c.idRota === '2');
  assert.strictEqual(mercado.telefoneDigits, '5548991230000', 'nao deve mexer em telefone que ja tem 12+ digitos');

  assert.ok(!contatos.some(c => c.idRota === '3'), 'telefone com menos de 8 digitos deve ser descartado');
  assert.ok(!contatos.some(c => c.idRota === '4'), 'cliente inativo nunca deve aparecer');

  console.log('getContatosWhatsapp: filtra inativos/telefones curtos, expande telefone1+telefone2, normaliza codigo de pais: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --experimental-vm-modules tests/whatsapp-contatos.test.cjs`
Expected: FAIL — `TypeError: db.getContatosWhatsapp is not a function`

- [ ] **Step 3: Implementar `getContatosWhatsapp` e `_normalizeTelefoneDigits` em `database.js`**

Inserir logo após o método `getClienteByIdRota` (depois do `}` que fecha esse método, antes de `applyRoteiroOrder`):

```js
    getContatosWhatsapp(roteiroId) {
        const roteiro = this.getRoteiros().find(r => r.id === roteiroId);
        const roteiroNome = roteiro ? roteiro.nome : '';
        const clientes = this.getClientesByRoteiro(roteiroId).filter(c => c.ativo);

        const contatos = [];
        clientes.forEach(cliente => {
            [[1, cliente.telefone1], [2, cliente.telefone2]].forEach(([slot, raw]) => {
                const digits = this._normalizeTelefoneDigits(raw);
                if (!digits) return;
                contatos.push({
                    idRota: cliente.id_rota,
                    slot,
                    nome: cliente.cliente,
                    telefoneExibicao: raw,
                    telefoneDigits: digits,
                    roteiroNome
                });
            });
        });
        return contatos;
    }

    // Telefones abaixo de 8 digitos sao lixo (campo vazio, "0", etc.) e nunca
    // devem virar destinatario de disparo. Numeros com ate 11 digitos que
    // ainda nao tem DDI recebem o 55 (BR); numeros mais longos presume-se
    // que ja vieram com codigo de pais.
    _normalizeTelefoneDigits(value) {
        const digits = String(value ?? '').replace(/\D/g, '');
        if (digits.length < 8) return '';
        if (digits.length <= 11 && !digits.startsWith('55')) return '55' + digits;
        return digits;
    }
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --experimental-vm-modules tests/whatsapp-contatos.test.cjs`
Expected: PASS — imprime `getContatosWhatsapp: filtra inativos/telefones curtos, expande telefone1+telefone2, normaliza codigo de pais: OK`

- [ ] **Step 5: Adicionar o teste à cadeia do script `test`**

Em `package.json`, no campo `scripts.test`, adicionar ` && node --experimental-vm-modules tests/whatsapp-contatos.test.cjs` ao final da string existente (mesmo padrão dos outros testes `--experimental-vm-modules`).

- [ ] **Step 6: Rodar a suíte completa**

Run: `npm test`
Expected: todos os testes passam, incluindo o novo.

- [ ] **Step 7: Commit**

```bash
git add database.js tests/whatsapp-contatos.test.cjs package.json
git commit -m "feat(whatsapp): adiciona getContatosWhatsapp para selecionar contatos por roteiro"
```

---

## Task 2: Reescrever `whatsapp-sender.html` para consumir o banco

**Files:**
- Modify: `whatsapp-sender.html` (reescrita completa do arquivo)

**Interfaces:**
- Consumes: `db.init()`, `db.getRoteiros() => Array<{id, nome}>`, `db.getContatosWhatsapp(roteiroId) => Array<{idRota, slot, nome, telefoneExibicao, telefoneDigits, roteiroNome}>` (Task 1).

- [ ] **Step 1: Substituir todo o conteúdo de `whatsapp-sender.html`**

Não há teste automatizado de UI neste repo (nenhum framework de DOM/Playwright configurado) — a verificação deste passo é manual, feita no Step 2. Escrever o arquivo completo:

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Disparo WhatsApp</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0f1410;
    --surface: #181f19;
    --surface2: #1e2820;
    --border: #2a3a2c;
    --green: #4ade80;
    --green-dim: #1a3a22;
    --green-mid: #22c55e;
    --text: #e8f0e9;
    --text-dim: #7a9a7e;
    --sent: #166534;
    --skip: #3a2a1a;
    --skip-text: #f59e0b;
    --radius: 12px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 32px 16px 64px;
  }

  header {
    width: 100%;
    max-width: 680px;
    margin-bottom: 40px;
    display: flex;
    align-items: flex-end;
    gap: 16px;
  }

  .logo {
    font-family: 'DM Mono', monospace;
    font-size: 11px;
    color: var(--green);
    letter-spacing: 0.15em;
    text-transform: uppercase;
    opacity: 0.7;
    white-space: nowrap;
  }

  h1 {
    font-size: 22px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.02em;
  }

  .subtitle {
    font-size: 13px;
    color: var(--text-dim);
    margin-top: 4px;
  }

  /* ── STEPS ── */
  .step {
    width: 100%;
    max-width: 680px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 28px;
    margin-bottom: 20px;
    display: none;
  }
  .step.active { display: block; }

  .step-label {
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: var(--green);
    margin-bottom: 14px;
  }

  .step h2 {
    font-size: 17px;
    font-weight: 500;
    margin-bottom: 18px;
    color: var(--text);
  }

  .hint {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: 14px;
    line-height: 1.6;
    font-family: 'DM Mono', monospace;
  }

  /* ── PREVIEW TABLE ── */
  .preview-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    margin-top: 16px;
  }
  .preview-table th {
    text-align: left;
    padding: 8px 12px;
    font-family: 'DM Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
    border-bottom: 1px solid var(--border);
  }
  .preview-table td {
    padding: 8px 12px;
    border-bottom: 1px solid #1a2a1c;
    color: var(--text);
  }
  .preview-table tr:last-child td { border-bottom: none; }

  /* ── TEXTAREA ── */
  textarea {
    width: 100%;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    font-size: 14px;
    line-height: 1.6;
    padding: 14px;
    resize: vertical;
    min-height: 240px;
    outline: none;
    transition: border-color 0.2s;
  }
  textarea:focus { border-color: var(--green); }

  .tag-hint {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: 8px;
    font-family: 'DM Mono', monospace;
  }
  .tag-hint code {
    background: var(--green-dim);
    color: var(--green);
    padding: 1px 6px;
    border-radius: 4px;
  }

  /* ── BUTTONS ── */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 22px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    transition: all 0.15s;
    font-family: 'DM Sans', sans-serif;
  }
  .btn-primary {
    background: var(--green);
    color: #0a1a0c;
  }
  .btn-primary:hover { background: var(--green-mid); }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-outline {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--border);
  }
  .btn-outline:hover { border-color: var(--text-dim); color: var(--text); }

  .btn-whatsapp {
    background: #25d366;
    color: #000;
    font-size: 16px;
    padding: 14px 32px;
    border-radius: 10px;
    width: 100%;
    justify-content: center;
    font-weight: 600;
  }
  .btn-whatsapp:hover { background: #1ebe5a; }

  .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }

  /* ── PROGRESS ── */
  .progress-wrap {
    width: 100%;
    max-width: 680px;
    margin-bottom: 20px;
    display: none;
  }
  .progress-wrap.active { display: block; }
  .progress-info {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 8px;
    font-family: 'DM Mono', monospace;
  }
  .progress-bar {
    height: 4px;
    background: var(--border);
    border-radius: 99px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--green);
    border-radius: 99px;
    transition: width 0.4s ease;
  }

  /* ── CONTACT CARD ── */
  .contact-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px;
    margin-bottom: 16px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .contact-name { font-weight: 500; font-size: 16px; }
  .contact-phone { font-family: 'DM Mono', monospace; font-size: 13px; color: var(--text-dim); margin-top: 2px; }
  .contact-status {
    font-size: 11px;
    font-family: 'DM Mono', monospace;
    padding: 4px 10px;
    border-radius: 99px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .status-pending { background: var(--surface); color: var(--text-dim); border: 1px solid var(--border); }
  .status-sent { background: var(--sent); color: #4ade80; }
  .status-skip { background: var(--skip); color: var(--skip-text); }

  /* ── MSG PREVIEW ── */
  .msg-preview {
    background: var(--green-dim);
    border-left: 3px solid var(--green);
    border-radius: 0 8px 8px 0;
    padding: 14px 16px;
    font-size: 13px;
    line-height: 1.7;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 16px;
    max-height: 180px;
    overflow-y: auto;
  }

  /* ── SUMMARY ── */
  .summary-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-top: 16px;
  }
  .summary-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 18px;
    text-align: center;
  }
  .summary-number { font-size: 32px; font-weight: 600; font-family: 'DM Mono', monospace; }
  .summary-label { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
  .n-sent { color: var(--green); }
  .n-skip { color: var(--skip-text); }
  .n-total { color: var(--text-dim); }

  .col-list {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .col-chip {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
    font-size: 12px;
    font-family: 'DM Mono', monospace;
    cursor: pointer;
    transition: all 0.15s;
    color: var(--text-dim);
  }
  .col-chip:hover { border-color: var(--green); color: var(--green); }
  .col-chip.selected { background: var(--green-dim); border-color: var(--green); color: var(--green); }

  label.field-label {
    font-size: 12px;
    color: var(--text-dim);
    font-family: 'DM Mono', monospace;
    display: block;
    margin-bottom: 6px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .field { margin-bottom: 18px; }

  .nav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .nav-counter {
    font-family: 'DM Mono', monospace;
    font-size: 13px;
    color: var(--text-dim);
  }
</style>
<link rel="stylesheet" href="theme.css">
<script src="theme.js"></script>
</head>
<body>

<header>
  <div>
    <div class="logo">♻️ Floripa · Lixo Zero</div>
    <h1>Disparo WhatsApp</h1>
    <p class="subtitle">Envio manual assistido — um contato por vez</p>
  </div>
</header>

<!-- PROGRESS BAR -->
<div class="progress-wrap" id="progressWrap">
  <div class="progress-info">
    <span id="progressLabel">0 / 0 enviados</span>
    <span id="progressPct">0%</span>
  </div>
  <div class="progress-bar"><div class="progress-fill" id="progressFill" style="width:0%"></div></div>
</div>

<!-- STEP 1: SELECT ROUTES -->
<div class="step active" id="step1">
  <div class="step-label">Passo 01</div>
  <h2>Selecionar roteiro(s)</h2>

  <div class="hint" id="roteirosLoading">Carregando roteiros...</div>
  <div class="col-list" id="roteiroChips" style="display:none;"></div>

  <div id="previewWrap"></div>

  <div class="actions">
    <button class="btn btn-primary" id="btnToMsg" disabled>Próximo →</button>
  </div>
</div>

<!-- STEP 2: MESSAGE -->
<div class="step" id="step2">
  <div class="step-label">Passo 02</div>
  <h2>Mensagem</h2>

  <div class="field">
    <label class="field-label">Texto da mensagem</label>
    <textarea id="msgText" placeholder="Digite ou cole a mensagem aqui..."></textarea>
    <div class="tag-hint">Use <code>{nome}</code> para personalizar com o nome do estabelecimento.</div>
  </div>

  <div class="actions">
    <button class="btn btn-primary" id="btnStart">Iniciar disparos →</button>
    <button class="btn btn-outline" onclick="goTo(1)">← Voltar</button>
  </div>
</div>

<!-- STEP 3: SEND -->
<div class="step" id="step3">
  <div class="step-label">Passo 03</div>

  <div class="nav-row">
    <span class="nav-counter" id="navCounter"></span>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-outline" id="btnPrev" onclick="navigate(-1)">←</button>
      <button class="btn btn-outline" id="btnNext" onclick="navigate(1)">→</button>
    </div>
  </div>

  <div class="contact-card" id="contactCard">
    <div>
      <div class="contact-name" id="curName">—</div>
      <div class="contact-phone" id="curPhone">—</div>
    </div>
    <span class="contact-status status-pending" id="curStatus">Pendente</span>
  </div>

  <div class="msg-preview" id="msgPreview"></div>

  <button class="btn btn-whatsapp" id="btnWA" onclick="openWA()">
    📲 Abrir no WhatsApp
  </button>

  <div class="actions" style="margin-top:14px; justify-content:space-between;">
    <div style="display:flex;gap:8px;">
      <button class="btn btn-outline" onclick="markSkip()">Pular ↷</button>
      <button class="btn btn-outline" onclick="markSent()" style="color:var(--green);border-color:var(--green);">✓ Marcar enviado</button>
    </div>
    <button class="btn btn-outline" onclick="goTo(2)" style="font-size:12px;">Editar mensagem</button>
  </div>

  <div id="historySection" style="margin-top:28px;">
    <div class="step-label" style="margin-bottom:12px;">Todos os contatos</div>
    <div id="historyList"></div>
  </div>
</div>

<!-- STEP 4: DONE -->
<div class="step" id="step4">
  <div class="step-label">Concluído ✓</div>
  <h2>Disparo finalizado!</h2>
  <div class="summary-grid">
    <div class="summary-card"><div class="summary-number n-sent" id="sumSent">0</div><div class="summary-label">Enviados</div></div>
    <div class="summary-card"><div class="summary-number n-skip" id="sumSkip">0</div><div class="summary-label">Pulados</div></div>
    <div class="summary-card"><div class="summary-number n-total" id="sumTotal">0</div><div class="summary-label">Total</div></div>
  </div>
  <div class="actions" style="margin-top:24px;">
    <button class="btn btn-primary" onclick="restart()">Novo disparo</button>
    <button class="btn btn-outline" onclick="exportCSV()">Exportar resultado CSV</button>
  </div>
</div>

<script src="vendor/xlsx.full.min.js"></script>
<script src="vendor/sql-wasm.js"></script>
<script type="module">
import db from './database.js';

// ── STATE ──
let allRoteiros = [];             // [{id, nome}]
let selectedRoteiroIds = new Set();
let excludedKeys = new Set();     // chaves "idRota:slot" desmarcadas manualmente no passo 1
let contacts = [];                // [{idRota, slot, nome, labelSufixo, telefoneExibicao, telefoneDigits, roteiroNome}]
let statuses = [];                // 'pending' | 'sent' | 'skip', paralelo a contacts
let current  = 0;
let message  = '';

// ── NAVIGATION ──
function goTo(n) {
  document.querySelectorAll('.step').forEach((s,i) => s.classList.toggle('active', i === n-1));
}
window.goTo = goTo;

// ── STEP 1: SELECT ROUTES ──
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

function renderRoteiroChips() {
  const wrap = document.getElementById('roteiroChips');
  wrap.innerHTML = allRoteiros.map(r => {
    const count = db.getContatosWhatsapp(r.id).length;
    const selected = selectedRoteiroIds.has(r.id) ? 'selected' : '';
    return `<div class="col-chip ${selected}" data-id="${r.id}" onclick="toggleRoteiro(${r.id})">${r.nome} · ${count}</div>`;
  }).join('');
}

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

function toggleRoteiro(id) {
  if (selectedRoteiroIds.has(id)) selectedRoteiroIds.delete(id);
  else selectedRoteiroIds.add(id);
  renderRoteiroChips();
  renderContactPreview();
}
window.toggleRoteiro = toggleRoteiro;

function toggleContact(key) {
  if (excludedKeys.has(key)) excludedKeys.delete(key);
  else excludedKeys.add(key);
  renderContactPreview();
}
window.toggleContact = toggleContact;

document.getElementById('btnToMsg').onclick = () => {
  const list = buildPendingContacts().filter(c => !excludedKeys.has(c.key));
  if (!list.length) { alert('Selecione ao menos um contato.'); return; }
  contacts = list;
  statuses = new Array(contacts.length).fill('pending');
  goTo(2);
};

// ── STEP 2: MESSAGE ──
const DEFAULT_MSG = `Boa tarde! 📢
A partir do dia 07 de abril, iniciaremos a coleta seletiva de orgânicos no Centro Leste, nos períodos vespertino e noturno. Essa iniciativa faz parte do programa Florianópolis Capital Lixo Zero.

Como participar:
O estabelecimento deve adquirir bombonas plásticas de 50L para o descarte dos restos alimentares.
É necessário comprar o dobro da sua necessidade diária (um jogo titular e um reserva), pois nossa equipe levará as cheias e deixará bombonas vazias e higienizadas no local.

Nesta e na próxima semana, a equipe de Educação Ambiental visitará a região para realizar a capacitação. Contamos com a sua colaboração para tornarmos nossa cidade mais sustentável!

Em breve, enviaremos mais detalhes. ♻️`;

document.getElementById('msgText').value = DEFAULT_MSG;

document.getElementById('btnStart').onclick = () => {
  message = document.getElementById('msgText').value.trim();
  if (!message) { alert('Digite a mensagem.'); return; }
  current = 0;
  renderSendStep();
  document.getElementById('progressWrap').classList.add('active');
  goTo(3);
  updateProgress();
};

// ── STEP 3: SEND ──
function renderSendStep() {
  renderCurrentContact();
  renderHistory();
}

function buildMsg(contact) {
  const nome = contact.nome || 'estabelecimento';
  return message.replace(/\{nome\}/gi, nome);
}

function renderCurrentContact() {
  if (current >= contacts.length) { finishAll(); return; }
  const contact = contacts[current];
  document.getElementById('curName').textContent  = contact.nome || '—';
  document.getElementById('curPhone').textContent = contact.telefoneExibicao || '—';
  document.getElementById('navCounter').textContent = `${current + 1} / ${contacts.length}`;

  const s = statuses[current];
  const statusEl = document.getElementById('curStatus');
  statusEl.textContent = s === 'sent' ? 'Enviado ✓' : s === 'skip' ? 'Pulado' : 'Pendente';
  statusEl.className = `contact-status status-${s === 'pending' ? 'pending' : s === 'sent' ? 'sent' : 'skip'}`;

  document.getElementById('msgPreview').textContent = buildMsg(contact);
  document.getElementById('btnPrev').disabled = current === 0;
  document.getElementById('btnNext').disabled = current === contacts.length - 1;
}

function navigate(dir) {
  current = Math.max(0, Math.min(contacts.length - 1, current + dir));
  renderCurrentContact();
}
window.navigate = navigate;

async function openWA() {
  const contact = contacts[current];
  const text = encodeURIComponent(buildMsg(contact));
  const url = `https://wa.me/${contact.telefoneDigits}?text=${text}`;
  if (window.__TAURI_INTERNALS__) {
    await window.__TAURI_INTERNALS__.invoke('plugin:shell|open', { url });
  } else {
    window.open(url, '_blank');
  }
  // auto-mark sent after opening
  setTimeout(() => { if (statuses[current] === 'pending') markSent(); }, 1200);
}
window.openWA = openWA;

function markSent() {
  statuses[current] = 'sent';
  renderCurrentContact();
  renderHistory();
  updateProgress();
  if (current < contacts.length - 1) setTimeout(() => { current++; renderCurrentContact(); }, 400);
  else finishAll();
}
window.markSent = markSent;

function markSkip() {
  statuses[current] = 'skip';
  renderCurrentContact();
  renderHistory();
  updateProgress();
  if (current < contacts.length - 1) { current++; renderCurrentContact(); }
  else finishAll();
}
window.markSkip = markSkip;

function updateProgress() {
  const sent  = statuses.filter(s => s === 'sent').length;
  const done  = statuses.filter(s => s !== 'pending').length;
  const total = contacts.length;
  const pct   = total ? Math.round(done / total * 100) : 0;
  document.getElementById('progressLabel').textContent = `${sent} enviados · ${done} / ${total} processados`;
  document.getElementById('progressPct').textContent   = pct + '%';
  document.getElementById('progressFill').style.width  = pct + '%';
}

function renderHistory() {
  const list = document.getElementById('historyList');
  list.innerHTML = contacts.map((contact, i) => {
    const s = statuses[i];
    const active = i === current ? 'border-color:var(--green);' : '';
    return `<div class="contact-card" style="cursor:pointer;${active}" onclick="jumpTo(${i})">
      <div>
        <div class="contact-name" style="font-size:14px">${contact.nome || '—'}${contact.labelSufixo}</div>
        <div class="contact-phone">${contact.telefoneExibicao || '—'}</div>
      </div>
      <span class="contact-status status-${s === 'pending' ? 'pending' : s === 'sent' ? 'sent' : 'skip'}">
        ${s === 'sent' ? '✓ Enviado' : s === 'skip' ? 'Pulado' : 'Pendente'}
      </span>
    </div>`;
  }).join('');
}

function jumpTo(i) { current = i; renderCurrentContact(); }
window.jumpTo = jumpTo;

function finishAll() {
  const allDone = statuses.every(s => s !== 'pending');
  if (allDone) {
    document.getElementById('sumSent').textContent  = statuses.filter(s => s === 'sent').length;
    document.getElementById('sumSkip').textContent  = statuses.filter(s => s === 'skip').length;
    document.getElementById('sumTotal').textContent = contacts.length;
    setTimeout(() => goTo(4), 600);
  }
}

// ── EXPORT ──
function exportCSV() {
  const out = contacts.map((contact, i) => ({
    nome: contact.nome,
    telefone: contact.telefoneExibicao,
    roteiro: contact.roteiroNome,
    status: statuses[i]
  }));
  const ws = XLSX.utils.json_to_sheet(out);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Resultado');
  XLSX.writeFile(wb, 'disparo_resultado.xlsx');
}
window.exportCSV = exportCSV;

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

// ── INIT ──
(async () => {
  await db.init();
  allRoteiros = db.getRoteiros();
  document.getElementById('roteirosLoading').style.display = 'none';
  document.getElementById('roteiroChips').style.display = 'flex';
  renderRoteiroChips();
  renderContactPreview();
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Verificação manual no navegador**

Run: `npx http-server . -p 8080` (ou abrir `whatsapp-sender.html` diretamente pelo Tauri dev com `npm run dev`)

Checklist a validar manualmente:
1. A página carrega, "Carregando roteiros..." desaparece e os chips de roteiro aparecem com contagem de contatos.
2. Selecionar um roteiro com clientes que tenham `telefone1` e `telefone2` mostra duas linhas para o mesmo cliente, com sufixo "(tel 1)"/"(tel 2)".
3. Desmarcar um checkbox da tabela de preview reduz a contagem considerada e, se todos forem desmarcados, o botão "Próximo →" fica desabilitado.
4. Selecionar dois roteiros soma os contatos de ambos na tabela.
5. Avançar para "Mensagem", editar o texto, iniciar disparos, e confirmar que nome/telefone exibidos no passo de envio batem com os dados do roteiro escolhido.
6. Clicar "📲 Abrir no WhatsApp" abre `wa.me/<numero>` com o número no formato `55DDDNUMERO` (conferir na barra de endereço/URL aberta).
7. "Pular"/"✓ Marcar enviado" avançam para o próximo contato e atualizam a barra de progresso e a lista "Todos os contatos".
8. Ao processar todos os contatos, a tela de resumo aparece com as contagens corretas; "Exportar resultado CSV" baixa um `.xlsx` com colunas nome/telefone/roteiro/status.
9. "Novo disparo" volta ao passo 1 com os chips de roteiro desmarcados.

- [ ] **Step 3: Commit**

```bash
git add whatsapp-sender.html
git commit -m "feat(whatsapp): seleciona destinatarios por roteiro direto do banco, remove upload manual"
```
