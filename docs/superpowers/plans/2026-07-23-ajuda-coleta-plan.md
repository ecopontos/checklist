# Página de Ajuda do Módulo Coleta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a static help page (`ajuda-coleta.html`) covering the 4 main workflows of `coleta-checklist.html`, reachable via a "❓" icon in that page's header, opening in a new tab/window.

**Architecture:** Pure static HTML/CSS, no JavaScript, following the same standalone-page pattern as `imprimir.html`. Reuses `coleta-checklist.html`'s existing color variables so it reads as part of the same system. Works offline (no network dependency), consistent with the Electron desktop app.

**Tech Stack:** Static HTML/CSS. No build process, no automated test framework in this repo — verification is manual in a real browser via Playwright MCP.

## Global Constraints

- New file: `ajuda-coleta.html`. Modified file: `coleta-checklist.html` (header only — add one link, no other change).
- No JavaScript in `ajuda-coleta.html`.
- Content covers exactly 4 sections: route selection/sorting, ID search (including the Esc/Enter-to-reset behavior), quantity/intercorrência entry, and the checklist PDF flow (including the 8-item código legend, reproduced in full).
- The help link opens in a new tab (`target="_blank"`), not replacing the current `coleta-checklist.html` tab/window — the operator's in-progress work (selected route, entered quantities) must stay intact.
- `ajuda-coleta.html` is not added to the `.page-nav` bar on any page — it's a contextual link from `coleta-checklist.html` only, same tier as `imprimir.html`.

---

## Task 1: Create the help page

**Files:**
- Create: `ajuda-coleta.html`

**Interfaces:** None — static page, no JS, nothing other files depend on.

- [ ] **Step 1: Create `ajuda-coleta.html`**

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ajuda - Coleta - SATELITE v3</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --primary: #00f2fe;
            --secondary: #4facfe;
            --bg: #0b0e14;
            --surface: #161b22;
            --text: #e6edf3;
            --text-dim: #8b949e;
            --card-border: rgba(255, 255, 255, 0.1);
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Outfit', sans-serif;
            background: var(--bg);
            color: var(--text);
            min-height: 100vh;
            padding: 40px 20px;
        }

        .container { max-width: 800px; margin: 0 auto; }

        .header-nav { margin-bottom: 30px; }
        .btn-back { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
        .btn-back:hover { color: var(--primary); }

        h1 { font-size: 2rem; font-weight: 800; margin-bottom: 10px; }
        .subtitle { color: var(--text-dim); margin-bottom: 40px; }

        section {
            background: var(--surface);
            border: 1px solid var(--card-border);
            border-radius: 16px;
            padding: 25px 30px;
            margin-bottom: 20px;
        }

        section h2 {
            font-size: 1.2rem;
            color: var(--primary);
            margin-bottom: 10px;
        }

        section p.intro { color: var(--text-dim); margin-bottom: 15px; line-height: 1.6; }
        section ol, section ul { padding-left: 20px; line-height: 1.8; }
        section li { margin-bottom: 6px; }

        code {
            background: rgba(255,255,255,0.08);
            padding: 2px 6px;
            border-radius: 4px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.9em;
        }

        .codigo-lista {
            columns: 2;
            column-gap: 30px;
            padding-left: 20px;
            line-height: 1.8;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header-nav">
            <a href="coleta-checklist.html" class="btn-back">⬅️ Voltar</a>
        </div>

        <h1>❓ Ajuda — Coleta</h1>
        <p class="subtitle">Guia rápido da tela de Operação de Coleta.</p>

        <section>
            <h2>📍 Selecionar rota e ordenar a lista</h2>
            <p class="intro">No topo da tela, escolha a rota do dia em <code>Selecione o Roteiro</code>. A lista de clientes aparece na ordem cadastrada da rota por padrão.</p>
            <p class="intro">O seletor ao lado (<code>Número de Ordem</code> / <code>Ordem Alfabética</code> / <code>Qtd. Digitada</code>) muda só a ordem de exibição na tela — não afeta o PDF do checklist nem os dados salvos:</p>
            <ul>
                <li><strong>Número de Ordem</strong>: ordem cadastrada da rota (padrão).</li>
                <li><strong>Ordem Alfabética</strong>: por nome do cliente.</li>
                <li><strong>Qtd. Digitada</strong>: clientes com quantidade já preenchida aparecem primeiro (maior quantidade no topo); quem ainda não foi preenchido fica no fim.</li>
            </ul>
        </section>

        <section>
            <h2>🔍 Busca por ID Rota</h2>
            <p class="intro">Digite o ID do ponto no campo <code>DIGITE O ID ROTA...</code> (embaixo da lista) e aperte <code>Enter</code> — a tela isola só aquele cliente, com o campo de quantidade já em foco pra digitar direto.</p>
            <p class="intro">Se digitar o ID errado, ou só quiser voltar pra lista completa sem preencher nada:</p>
            <ul>
                <li>Aperte <code>Esc</code> a qualquer momento, ou</li>
                <li>Apague o campo de busca e aperte <code>Enter</code> vazio.</li>
            </ul>
        </section>

        <section>
            <h2>✅ Registrar quantidade e intercorrência</h2>
            <ul>
                <li>Preencha o número de recipientes coletados no campo numérico do cliente.</li>
                <li>Use o botão <code>+ Problema</code> pra marcar uma intercorrência naquele ponto.</li>
                <li>Com o campo de quantidade em foco, <code>Enter</code> avança pro campo de problema (se estiver aberto) ou finaliza o registro daquele ponto.</li>
            </ul>
        </section>

        <section>
            <h2>📋 Checklist da Próxima Coleta (PDF)</h2>
            <p class="intro">Clique em <code>📋 Checklist Próxima Coleta</code> no topo da tela. No formulário, preencha:</p>
            <ul>
                <li><strong>Data da Próxima Coleta</strong> (obrigatório)</li>
                <li><strong>Tipo de Resíduo</strong></li>
                <li><strong>Motorista</strong> e <strong>Veículo</strong> (opcionais)</li>
            </ul>
            <p class="intro">Depois, clique em <code>Baixar PDF</code> para salvar o arquivo no computador, ou <code>Enviar para Drive</code> para subir direto pra pasta configurada no Google Drive.</p>
            <p class="intro">No rodapé do PDF, o motorista encontra estes códigos pra preencher na coluna <code>Cód. Problema</code> em vez de escrever o problema por extenso:</p>
            <ol class="codigo-lista">
                <li>Recipiente ausente</li>
                <li>Recipiente em quantidade insuficiente</li>
                <li>Recipiente quebrado</li>
                <li>Recipiente preso em corrente</li>
                <li>Recipiente trancado no depósito</li>
                <li>Resíduo contaminado/misturado</li>
                <li>Sacolas/Sacos presentes no recipiente</li>
                <li>Outro</li>
            </ol>
        </section>
    </div>
</body>
</html>
```

- [ ] **Step 2: Verify in a real browser**

With a local server running (`python -m http.server 8080` from the repo root), open `http://localhost:8080/ajuda-coleta.html` directly. Check:
1. Page renders with the dark theme (matching `coleta-checklist.html`'s color scheme), no console errors.
2. All 4 sections are present with their content.
3. The código list (8 items) renders in 2 columns.
4. "⬅️ Voltar" link points to `coleta-checklist.html` and navigates there correctly.

- [ ] **Step 3: Commit**

```bash
git add ajuda-coleta.html
git commit -m "feat(coleta): add help page for the collection module"
```

---

## Task 2: Wire the help icon into coleta-checklist.html

**Files:**
- Modify: `coleta-checklist.html`

**Interfaces:**
- Consumes: `ajuda-coleta.html` from Task 1 (must exist at the repo root, same directory).

- [ ] **Step 1: Add the `.btn-help` CSS rule**

In `coleta-checklist.html`, replace:

```css
        .btn-checklist:hover { border-color: var(--primary); }

        .modal-overlay {
```

with:

```css
        .btn-checklist:hover { border-color: var(--primary); }

        .btn-help {
            background: transparent;
            border: 1px solid var(--card-border);
            color: var(--text-dim);
            width: 34px;
            height: 34px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            text-decoration: none;
            font-size: 1rem;
            transition: all 0.3s;
        }
        .btn-help:hover { border-color: var(--primary); color: var(--primary); }

        .modal-overlay {
```

- [ ] **Step 2: Add the help link next to the checklist button**

In `coleta-checklist.html`, replace:

```html
                <button class="btn-checklist" id="btnChecklist" type="button">📋 Checklist Próxima Coleta</button>
            </div>
        </div>
    </header>
```

with:

```html
                <button class="btn-checklist" id="btnChecklist" type="button">📋 Checklist Próxima Coleta</button>
                <a href="ajuda-coleta.html" target="_blank" class="btn-help" title="Ajuda">❓</a>
            </div>
        </div>
    </header>
```

- [ ] **Step 3: Verify in a real browser**

With the local server still running, open `http://localhost:8080/coleta-checklist.html`. Check:
1. The "❓" icon appears next to "📋 Checklist Próxima Coleta" in the header, styled as a small circle matching the header's other controls.
2. Select a route and type something into a client's quantity field (don't finish the entry) to establish in-progress state.
3. Click the "❓" icon: `ajuda-coleta.html` opens in a **new tab/window** — the original `coleta-checklist.html` tab is still open in the background with the selected route and the in-progress quantity value still there (state preserved, since it's a new tab, not a navigation away).
4. In the new tab, confirm the help content renders correctly (same checks as Task 1 Step 2).

- [ ] **Step 4: Commit**

```bash
git add coleta-checklist.html
git commit -m "feat(coleta): add help icon linking to ajuda-coleta.html"
```
