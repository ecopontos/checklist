# Navegação entre Páginas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent cross-page navigation bar (🏠 Início · 📍 Roteiros · ✅ Coleta · 📊 Análise · ⚙️ Admin) to the four work pages (`roteiros.html`, `coleta-checklist.html`, `analise.html`, `admin.html`), replacing each page's single "back to dashboard" link, plus a new "Ferramentas" card in `admin.html` linking out to `whatsapp-sender.html`.

**Architecture:** Pure static HTML/CSS, duplicated across the four pages — no shared JS component, no build step (matches the existing all-static-HTML pattern of this repo). Each page already defines `--primary` and `--text-dim` CSS variables and a `.header-nav`/`.btn-back` (or `.logo-area`/`.btn-back` in `coleta-checklist.html`) pattern; the new `.page-nav` block reuses those variables so it fits each page's existing theme without a new design system.

**Tech Stack:** Vanilla HTML/CSS, no JS, no build process, no automated test framework in this repo — verification is manual in a real browser via Playwright MCP (same approach used for the client-sort feature).

## Global Constraints

- Scope: `roteiros.html`, `coleta-checklist.html`, `analise.html`, `admin.html` only. `index.html` and `imprimir.html` are not touched.
- No new JavaScript anywhere in this plan — every step is HTML/CSS only.
- The current page's nav item has no `href` (rendered as `<span class="active">`, not `<a>`) and is styled with `var(--primary)` and `font-weight: 600`.
- Non-active nav items use `color: var(--text-dim)` with `:hover { color: var(--primary); }`.
- `whatsapp-sender.html` is NOT added to the `.page-nav` bar — it only gets a new entry point via the "Ferramentas" card in `admin.html`.
- `imprimir.html` is not touched and keeps its current contextual access from `roteiros.html` (`window.open('imprimir.html?id=...')`).

---

## Task 1: Add page-nav to `roteiros.html`

**Files:**
- Modify: `roteiros.html`

**Interfaces:** None — self-contained markup/CSS change, no JS.

- [ ] **Step 1: Add the `.page-nav` CSS rules**

In `roteiros.html`, replace:

```css
        .btn-back:hover { color: var(--primary); }

        h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 10px; }
```

with:

```css
        .btn-back:hover { color: var(--primary); }

        .page-nav { display: flex; gap: 16px; flex-wrap: wrap; }
        .page-nav a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
        .page-nav a:hover { color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }

        h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 10px; }
```

- [ ] **Step 2: Replace the back link with the nav bar**

In `roteiros.html`, replace:

```html
        <div class="header-nav">
            <a href="index.html" class="btn-back">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                Voltar ao Dashboard
            </a>
        </div>
```

with:

```html
        <div class="header-nav">
            <nav class="page-nav">
                <a href="index.html">🏠 Início</a>
                <span class="active">📍 Roteiros</span>
                <a href="coleta-checklist.html">✅ Coleta</a>
                <a href="analise.html">📊 Análise</a>
                <a href="admin.html">⚙️ Admin</a>
            </nav>
        </div>
```

- [ ] **Step 3: Verify in a real browser**

With a local server running (`python -m http.server 8080` from the repo root), open `http://localhost:8080/roteiros.html`. Check:
1. The nav bar shows 5 items; "📍 Roteiros" has no underline/hand cursor and is highlighted (cyan `--primary` color), the other 4 are dimmed and turn cyan on hover.
2. Clicking "🏠 Início" goes to `index.html`, "✅ Coleta" to `coleta-checklist.html`, "📊 Análise" to `analise.html`, "⚙️ Admin" to `admin.html`.
3. The rest of the page (toolbar, table) renders unchanged — no layout shift or overlap in the header.

- [ ] **Step 4: Commit**

```bash
git add roteiros.html
git commit -m "feat(nav): add cross-page navigation bar to roteiros.html"
```

---

## Task 2: Add page-nav to `analise.html`

**Files:**
- Modify: `analise.html`

**Interfaces:** None — self-contained markup/CSS change, no JS.

- [ ] **Step 1: Add the `.page-nav` CSS rules**

In `analise.html`, replace:

```css
        .header-nav { display: flex; justify-content: space-between; margin-bottom: 40px; }
        .btn-back { color: var(--text-dim); text-decoration: none; }

        h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 30px; }
```

with:

```css
        .header-nav { display: flex; justify-content: space-between; margin-bottom: 40px; }
        .btn-back { color: var(--text-dim); text-decoration: none; }

        .page-nav { display: flex; gap: 16px; flex-wrap: wrap; }
        .page-nav a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
        .page-nav a:hover { color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }

        h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 30px; }
```

- [ ] **Step 2: Replace the back link with the nav bar**

In `analise.html`, replace:

```html
        <div class="header-nav">
            <a href="index.html" class="btn-back">⬅️ Voltar ao Dashboard</a>
        </div>
```

with:

```html
        <div class="header-nav">
            <nav class="page-nav">
                <a href="index.html">🏠 Início</a>
                <a href="roteiros.html">📍 Roteiros</a>
                <a href="coleta-checklist.html">✅ Coleta</a>
                <span class="active">📊 Análise</span>
                <a href="admin.html">⚙️ Admin</a>
            </nav>
        </div>
```

- [ ] **Step 3: Verify in a real browser**

With the local server running, open `http://localhost:8080/analise.html`. Check:
1. The nav bar shows 5 items; "📊 Análise" is highlighted and not a link, the other 4 are dimmed/clickable.
2. Each of the 4 links navigates to the right page.
3. The rest of the page (analysis grid, tables) renders unchanged.

- [ ] **Step 4: Commit**

```bash
git add analise.html
git commit -m "feat(nav): add cross-page navigation bar to analise.html"
```

---

## Task 3: Add page-nav to `admin.html`

**Files:**
- Modify: `admin.html`

**Interfaces:** None — self-contained markup/CSS change, no JS.

- [ ] **Step 1: Add the `.page-nav` CSS rules**

In `admin.html`, replace:

```css
        .btn-back:hover { color: var(--primary); }

        h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 10px; }
        .subtitle { color: var(--text-dim); margin-bottom: 40px; }
```

with:

```css
        .btn-back:hover { color: var(--primary); }

        .page-nav { display: flex; gap: 16px; flex-wrap: wrap; }
        .page-nav a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
        .page-nav a:hover { color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }

        h1 { font-size: 2.5rem; font-weight: 800; margin-bottom: 10px; }
        .subtitle { color: var(--text-dim); margin-bottom: 40px; }
```

- [ ] **Step 2: Replace the back link with the nav bar**

In `admin.html`, replace:

```html
        <div class="header-nav">
            <a href="index.html" class="btn-back">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
                Voltar ao Dashboard
            </a>
        </div>
```

with:

```html
        <div class="header-nav">
            <nav class="page-nav">
                <a href="index.html">🏠 Início</a>
                <a href="roteiros.html">📍 Roteiros</a>
                <a href="coleta-checklist.html">✅ Coleta</a>
                <a href="analise.html">📊 Análise</a>
                <span class="active">⚙️ Admin</span>
            </nav>
        </div>
```

- [ ] **Step 3: Verify in a real browser**

With the local server running, open `http://localhost:8080/admin.html`. Check:
1. The nav bar shows 5 items; "⚙️ Admin" is highlighted and not a link, the other 4 are dimmed/clickable.
2. Each of the 4 links navigates to the right page.
3. The admin grid (Migração Legada, Sincronização Google, Manutenção do Banco cards) renders unchanged.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "feat(nav): add cross-page navigation bar to admin.html"
```

---

## Task 4: Add "Ferramentas" card to `admin.html`

**Files:**
- Modify: `admin.html`

**Interfaces:** None — self-contained markup change, no JS. Depends on Task 3 being applied first only in the sense that both touch `admin.html`; the anchor text for this step does not overlap with Task 3's edits, so this task is otherwise independent.

- [ ] **Step 1: Add the new card to the admin grid**

In `admin.html`, replace:

```html
                <button class="btn btn-outline" style="border-color: var(--danger); color: var(--danger);" onclick="resetDatabase()">
                    ⚠️ Resetar Banco de Dados
                </button>
            </div>
        </div>
    </div>
```

with:

```html
                <button class="btn btn-outline" style="border-color: var(--danger); color: var(--danger);" onclick="resetDatabase()">
                    ⚠️ Resetar Banco de Dados
                </button>
            </div>

            <!-- FERRAMENTAS -->
            <div class="card">
                <h2>🛠️ Ferramentas</h2>
                <p>Utilitários auxiliares que não fazem parte do fluxo principal de coleta.</p>
                <a href="whatsapp-sender.html" class="btn btn-outline" style="display: inline-block; text-decoration: none;">📲 Disparo WhatsApp</a>
            </div>
        </div>
    </div>
```

- [ ] **Step 2: Verify in a real browser**

With the local server running, open `http://localhost:8080/admin.html`. Check:
1. A 4th card "🛠️ Ferramentas" appears in the grid, same visual style (border, padding, rounded corners) as the other 3 cards.
2. Clicking "📲 Disparo WhatsApp" navigates to `whatsapp-sender.html` and that page loads correctly.

- [ ] **Step 3: Commit**

```bash
git add admin.html
git commit -m "feat(admin): add Ferramentas card linking to whatsapp-sender.html"
```

---

## Task 5: Add page-nav to `coleta-checklist.html`

**Files:**
- Modify: `coleta-checklist.html`

**Interfaces:** None — self-contained markup/CSS change, no JS. `coleta-checklist.html` uses a different header structure (`.logo-area` inside a sticky `<header>`, not `.header-nav`) than the other three pages, so the insertion point differs, but the resulting `.page-nav` markup and classes are identical.

- [ ] **Step 1: Add the `.page-nav` CSS rules**

In `coleta-checklist.html`, replace:

```css
        .logo-area { display: flex; align-items: center; gap: 15px; }
        .btn-back { color: var(--text-dim); text-decoration: none; }
```

with:

```css
        .logo-area { display: flex; align-items: center; gap: 15px; }
        .btn-back { color: var(--text-dim); text-decoration: none; }

        .page-nav { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.85rem; }
        .page-nav a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
        .page-nav a:hover { color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }
```

- [ ] **Step 2: Replace the back link with the nav bar**

In `coleta-checklist.html`, replace:

```html
            <div class="logo-area">
                <a href="index.html" class="btn-back">⬅️</a>
                <h2 style="font-weight: 800; letter-spacing: -1px;">OPERAÇÃO</h2>
            </div>
```

with:

```html
            <div class="logo-area">
                <h2 style="font-weight: 800; letter-spacing: -1px;">OPERAÇÃO</h2>
                <nav class="page-nav">
                    <a href="index.html">🏠 Início</a>
                    <a href="roteiros.html">📍 Roteiros</a>
                    <span class="active">✅ Coleta</span>
                    <a href="analise.html">📊 Análise</a>
                    <a href="admin.html">⚙️ Admin</a>
                </nav>
            </div>
```

- [ ] **Step 3: Verify in a real browser**

With the local server running, open `http://localhost:8080/coleta-checklist.html`. Check:
1. The header shows "OPERAÇÃO" followed by the nav bar; "✅ Coleta" is highlighted and not a link, the other 4 are dimmed/clickable.
2. The existing header controls (route select, date, sort select, "📋 Checklist Próxima Coleta" button) still render and function — no overlap or clipping caused by the wider header content. If the header feels cramped at the default window width, confirm `flex-wrap: wrap` (already on `.header-content` via existing styles) prevents any control from being cut off rather than fixing it with new CSS.
3. Each of the 4 links navigates to the right page.

- [ ] **Step 4: Commit**

```bash
git add coleta-checklist.html
git commit -m "feat(nav): add cross-page navigation bar to coleta-checklist.html"
```

---

## Task 6: Full cross-page verification

**Files:** None modified — verification only. If this step surfaces a bug, fix it in the relevant file from Tasks 1-5 and amend that task's commit description in your report, then re-run this task's checks.

**Interfaces:** None.

- [ ] **Step 1: Verify every page-to-page link across all 5 pages**

With the local server running, use Playwright MCP (`browser_navigate`, `browser_snapshot`, `browser_click`) to, starting from `index.html`, visit each of the 4 work pages and from each one click through to all other 4 destinations (including back to `index.html`), confirming:
1. The correct nav item is marked active (no href, highlighted) on every page.
2. No broken link (every click lands on the expected URL, page loads without console errors caused by the nav change).
3. No visual regression: take a screenshot of each of the 4 pages' header area and confirm the nav bar doesn't overlap or get cut off by other header content (route select, date picker, etc. on `coleta-checklist.html` in particular).

- [ ] **Step 2: Verify the Ferramentas card entry point**

From `admin.html`, click "📲 Disparo WhatsApp" and confirm `whatsapp-sender.html` loads. Use the browser's back button (or `browser_navigate` back to `admin.html`) and confirm the "🛠️ Ferramentas" card and its nav bar are still intact.

- [ ] **Step 3: Report results**

Summarize pass/fail for each of the 5 pages and the Ferramentas link in the final report. No commit for this task unless Step 1 or 2 required a fix, in which case commit that fix with a message describing what was wrong (e.g., `fix(nav): correct broken link in coleta-checklist.html page-nav`).
