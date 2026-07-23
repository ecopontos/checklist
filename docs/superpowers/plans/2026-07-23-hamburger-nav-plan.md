# Menu Hambúguer + Link de Ajuda Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the horizontal 5-link page-navigation bar on the 4 work pages with a hamburger icon (top-right) that opens a dropdown panel containing the same 5 links plus a new "❓ Ajuda" item. Remove the standalone help icon previously added to `coleta-checklist.html`.

**Architecture:** Pure CSS "checkbox hack" — a hidden `<input type="checkbox">` plus a `<label>` (the ☰ icon) toggles the checkbox; a `:checked ~` sibling selector reveals the dropdown `<nav class="page-nav">`. A second `<label for="navToggle">`, styled as a fullscreen fixed overlay behind the dropdown, closes the menu when clicked anywhere outside it. No JavaScript, consistent with the existing page-nav's architecture.

**Tech Stack:** Static HTML/CSS only. No build process, no automated test framework in this repo — verification is manual in a real browser via Playwright MCP.

## Global Constraints

- Scope: `roteiros.html`, `coleta-checklist.html`, `analise.html`, `admin.html`. `index.html` is not touched (never had the nav bar). `ajuda-coleta.html`'s content is not touched.
- No new JavaScript anywhere in this plan.
- "❓ Ajuda" links to `ajuda-coleta.html` with `target="_blank"`, on all 4 pages, always pointing at the same Coleta-specific content (accepted for now, per design).
- The dropdown closes both by clicking the hamburger icon again AND by clicking anywhere outside the dropdown (the overlay label).
- The class names `.page-nav`, `.active`, and each page's existing `<a>`/`<span>` link markup are reused — only the CSS behavior and the wrapping structure change.
- `coleta-checklist.html`'s standalone `.btn-help` icon and its CSS rules are removed entirely — the same destination now lives inside the dropdown as the "❓ Ajuda" item.

---

## Task 1: Hamburger menu in `roteiros.html`

**Files:**
- Modify: `roteiros.html`

**Interfaces:** None — self-contained markup/CSS change, no JS.

- [ ] **Step 1: Replace the `.page-nav` CSS block with the dropdown version**

In `roteiros.html`, replace:

```css
        .header-nav {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
        }

        .page-nav { display: flex; gap: 16px; flex-wrap: wrap; }
        .page-nav a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
        .page-nav a:hover { color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }
```

with:

```css
        .header-nav {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            margin-bottom: 40px;
        }

        .nav-wrapper { position: relative; }
        .nav-toggle { display: none; }

        .hamburger-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 34px;
            height: 34px;
            border: 1px solid var(--card-border);
            border-radius: 8px;
            color: var(--text-dim);
            cursor: pointer;
            font-size: 1.1rem;
            transition: all 0.3s;
            position: relative;
            z-index: 210;
        }
        .hamburger-icon:hover { border-color: var(--primary); color: var(--primary); }

        .nav-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 190;
            cursor: default;
        }
        .nav-toggle:checked ~ .nav-overlay { display: block; }

        .page-nav {
            display: none;
            flex-direction: column;
            gap: 4px;
            position: absolute;
            top: 44px;
            right: 0;
            background: var(--surface);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 10px;
            min-width: 180px;
            z-index: 200;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
        }
        .nav-toggle:checked ~ .page-nav { display: flex; }

        .page-nav a, .page-nav .active {
            padding: 8px 10px;
            border-radius: 8px;
            color: var(--text-dim);
            text-decoration: none;
            transition: background 0.2s, color 0.2s;
        }
        .page-nav a:hover { background: rgba(255, 255, 255, 0.05); color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }
```

- [ ] **Step 2: Replace the nav markup with the hamburger wrapper**

In `roteiros.html`, replace:

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

with:

```html
        <div class="header-nav">
            <div class="nav-wrapper">
                <input type="checkbox" id="navToggle" class="nav-toggle">
                <label for="navToggle" class="hamburger-icon">☰</label>
                <label for="navToggle" class="nav-overlay"></label>
                <nav class="page-nav">
                    <a href="index.html">🏠 Início</a>
                    <span class="active">📍 Roteiros</span>
                    <a href="coleta-checklist.html">✅ Coleta</a>
                    <a href="analise.html">📊 Análise</a>
                    <a href="admin.html">⚙️ Admin</a>
                    <a href="ajuda-coleta.html" target="_blank">❓ Ajuda</a>
                </nav>
            </div>
        </div>
```

- [ ] **Step 3: Verify in a real browser**

With a local server running (`python -m http.server 8080` from the repo root), open `http://localhost:8080/roteiros.html`. Check:
1. Only a "☰" icon appears in the top-right of the header — no horizontal link row.
2. Clicking "☰" opens a dropdown panel below-right of the icon, with 6 items: 🏠 Início, 📍 Roteiros (highlighted, not a link), ✅ Coleta, 📊 Análise, ⚙️ Admin, ❓ Ajuda.
3. Clicking anywhere outside the panel (e.g. the page body) closes it.
4. Clicking "☰" again (while open) also closes it.
5. Clicking "🏠 Início" navigates to `index.html`; clicking "❓ Ajuda" opens `ajuda-coleta.html` in a new tab.
6. The rest of the page (toolbar, table) renders unchanged.

- [ ] **Step 4: Commit**

```bash
git add roteiros.html
git commit -m "feat(nav): replace page-nav bar with hamburger dropdown in roteiros.html"
```

---

## Task 2: Hamburger menu in `analise.html`

**Files:**
- Modify: `analise.html`

**Interfaces:** None — self-contained markup/CSS change, no JS.

- [ ] **Step 1: Replace the `.page-nav` CSS block with the dropdown version**

In `analise.html`, replace:

```css
        .header-nav { display: flex; justify-content: space-between; margin-bottom: 40px; }

        .page-nav { display: flex; gap: 16px; flex-wrap: wrap; }
        .page-nav a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
        .page-nav a:hover { color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }
```

with:

```css
        .header-nav { display: flex; justify-content: flex-end; margin-bottom: 40px; }

        .nav-wrapper { position: relative; }
        .nav-toggle { display: none; }

        .hamburger-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 34px;
            height: 34px;
            border: 1px solid var(--card-border);
            border-radius: 8px;
            color: var(--text-dim);
            cursor: pointer;
            font-size: 1.1rem;
            transition: all 0.3s;
            position: relative;
            z-index: 210;
        }
        .hamburger-icon:hover { border-color: var(--primary); color: var(--primary); }

        .nav-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 190;
            cursor: default;
        }
        .nav-toggle:checked ~ .nav-overlay { display: block; }

        .page-nav {
            display: none;
            flex-direction: column;
            gap: 4px;
            position: absolute;
            top: 44px;
            right: 0;
            background: var(--surface);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 10px;
            min-width: 180px;
            z-index: 200;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
        }
        .nav-toggle:checked ~ .page-nav { display: flex; }

        .page-nav a, .page-nav .active {
            padding: 8px 10px;
            border-radius: 8px;
            color: var(--text-dim);
            text-decoration: none;
            transition: background 0.2s, color 0.2s;
        }
        .page-nav a:hover { background: rgba(255, 255, 255, 0.05); color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }
```

- [ ] **Step 2: Replace the nav markup with the hamburger wrapper**

In `analise.html`, replace:

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

with:

```html
        <div class="header-nav">
            <div class="nav-wrapper">
                <input type="checkbox" id="navToggle" class="nav-toggle">
                <label for="navToggle" class="hamburger-icon">☰</label>
                <label for="navToggle" class="nav-overlay"></label>
                <nav class="page-nav">
                    <a href="index.html">🏠 Início</a>
                    <a href="roteiros.html">📍 Roteiros</a>
                    <a href="coleta-checklist.html">✅ Coleta</a>
                    <span class="active">📊 Análise</span>
                    <a href="admin.html">⚙️ Admin</a>
                    <a href="ajuda-coleta.html" target="_blank">❓ Ajuda</a>
                </nav>
            </div>
        </div>
```

- [ ] **Step 3: Verify in a real browser**

With the local server running, open `http://localhost:8080/analise.html`. Same checks as Task 1 Step 3, adjusted for "📊 Análise" being the highlighted item.

- [ ] **Step 4: Commit**

```bash
git add analise.html
git commit -m "feat(nav): replace page-nav bar with hamburger dropdown in analise.html"
```

---

## Task 3: Hamburger menu in `admin.html`

**Files:**
- Modify: `admin.html`

**Interfaces:** None — self-contained markup/CSS change, no JS.

- [ ] **Step 1: Replace the `.page-nav` CSS block with the dropdown version**

In `admin.html`, replace:

```css
        .header-nav {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 40px;
        }

        .page-nav { display: flex; gap: 16px; flex-wrap: wrap; }
        .page-nav a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
        .page-nav a:hover { color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }
```

with:

```css
        .header-nav {
            display: flex;
            justify-content: flex-end;
            align-items: center;
            margin-bottom: 40px;
        }

        .nav-wrapper { position: relative; }
        .nav-toggle { display: none; }

        .hamburger-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 34px;
            height: 34px;
            border: 1px solid var(--card-border);
            border-radius: 8px;
            color: var(--text-dim);
            cursor: pointer;
            font-size: 1.1rem;
            transition: all 0.3s;
            position: relative;
            z-index: 210;
        }
        .hamburger-icon:hover { border-color: var(--primary); color: var(--primary); }

        .nav-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 190;
            cursor: default;
        }
        .nav-toggle:checked ~ .nav-overlay { display: block; }

        .page-nav {
            display: none;
            flex-direction: column;
            gap: 4px;
            position: absolute;
            top: 44px;
            right: 0;
            background: var(--surface);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 10px;
            min-width: 180px;
            z-index: 200;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
        }
        .nav-toggle:checked ~ .page-nav { display: flex; }

        .page-nav a, .page-nav .active {
            padding: 8px 10px;
            border-radius: 8px;
            color: var(--text-dim);
            text-decoration: none;
            transition: background 0.2s, color 0.2s;
        }
        .page-nav a:hover { background: rgba(255, 255, 255, 0.05); color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }
```

- [ ] **Step 2: Replace the nav markup with the hamburger wrapper**

In `admin.html`, replace:

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

with:

```html
        <div class="header-nav">
            <div class="nav-wrapper">
                <input type="checkbox" id="navToggle" class="nav-toggle">
                <label for="navToggle" class="hamburger-icon">☰</label>
                <label for="navToggle" class="nav-overlay"></label>
                <nav class="page-nav">
                    <a href="index.html">🏠 Início</a>
                    <a href="roteiros.html">📍 Roteiros</a>
                    <a href="coleta-checklist.html">✅ Coleta</a>
                    <a href="analise.html">📊 Análise</a>
                    <span class="active">⚙️ Admin</span>
                    <a href="ajuda-coleta.html" target="_blank">❓ Ajuda</a>
                </nav>
            </div>
        </div>
```

- [ ] **Step 3: Verify in a real browser**

With the local server running, open `http://localhost:8080/admin.html`. Same checks as Task 1 Step 3, adjusted for "⚙️ Admin" being the highlighted item. Also confirm the admin grid cards (Migração Legada, Sincronização Google, Manutenção do Banco, Ferramentas) render unchanged.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "feat(nav): replace page-nav bar with hamburger dropdown in admin.html"
```

---

## Task 4: Hamburger menu in `coleta-checklist.html`, remove standalone help icon

**Files:**
- Modify: `coleta-checklist.html`

**Interfaces:** None — self-contained markup/CSS change, no JS.

- [ ] **Step 1: Replace the `.page-nav` CSS block with the dropdown version**

In `coleta-checklist.html`, replace:

```css
        .logo-area { display: flex; align-items: center; gap: 15px; }

        .page-nav { display: flex; gap: 12px; flex-wrap: wrap; font-size: 0.85rem; }
        .page-nav a { color: var(--text-dim); text-decoration: none; transition: color 0.3s; }
        .page-nav a:hover { color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }
```

with:

```css
        .logo-area { display: flex; align-items: center; gap: 15px; }

        .nav-wrapper { position: relative; }
        .nav-toggle { display: none; }

        .hamburger-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 34px;
            height: 34px;
            border: 1px solid var(--card-border);
            border-radius: 8px;
            color: var(--text-dim);
            cursor: pointer;
            font-size: 1.1rem;
            transition: all 0.3s;
            position: relative;
            z-index: 210;
        }
        .hamburger-icon:hover { border-color: var(--primary); color: var(--primary); }

        .nav-overlay {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            z-index: 190;
            cursor: default;
        }
        .nav-toggle:checked ~ .nav-overlay { display: block; }

        .page-nav {
            display: none;
            flex-direction: column;
            gap: 4px;
            position: absolute;
            top: 44px;
            right: 0;
            background: var(--surface);
            border: 1px solid var(--card-border);
            border-radius: 12px;
            padding: 10px;
            min-width: 180px;
            font-size: 0.85rem;
            z-index: 200;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
        }
        .nav-toggle:checked ~ .page-nav { display: flex; }

        .page-nav a, .page-nav .active {
            padding: 8px 10px;
            border-radius: 8px;
            color: var(--text-dim);
            text-decoration: none;
            transition: background 0.2s, color 0.2s;
        }
        .page-nav a:hover { background: rgba(255, 255, 255, 0.05); color: var(--primary); }
        .page-nav .active { color: var(--primary); font-weight: 600; }
```

- [ ] **Step 2: Remove the standalone `.btn-help` CSS rules**

In `coleta-checklist.html`, replace:

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
```

with:

```css
        .btn-checklist:hover { border-color: var(--primary); }
```

- [ ] **Step 3: Move the nav out of `.logo-area` into a hamburger wrapper inside `.controls`, remove the standalone help link**

In `coleta-checklist.html`, replace:

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
            <div class="controls">
                <select id="routeSelect">
                    <option value="">Selecione o Roteiro</option>
                </select>
                <input type="date" id="opDate">
                <select id="sortSelect">
                    <option value="ordem">Número de Ordem</option>
                    <option value="alfabetica">Ordem Alfabética</option>
                    <option value="quantidade">Qtd. Digitada</option>
                </select>
                <button class="btn-checklist" id="btnChecklist" type="button">📋 Checklist Próxima Coleta</button>
                <a href="ajuda-coleta.html" target="_blank" class="btn-help" title="Ajuda">❓</a>
            </div>
```

with:

```html
            <div class="logo-area">
                <h2 style="font-weight: 800; letter-spacing: -1px;">OPERAÇÃO</h2>
            </div>
            <div class="controls">
                <select id="routeSelect">
                    <option value="">Selecione o Roteiro</option>
                </select>
                <input type="date" id="opDate">
                <select id="sortSelect">
                    <option value="ordem">Número de Ordem</option>
                    <option value="alfabetica">Ordem Alfabética</option>
                    <option value="quantidade">Qtd. Digitada</option>
                </select>
                <button class="btn-checklist" id="btnChecklist" type="button">📋 Checklist Próxima Coleta</button>
                <div class="nav-wrapper">
                    <input type="checkbox" id="navToggle" class="nav-toggle">
                    <label for="navToggle" class="hamburger-icon">☰</label>
                    <label for="navToggle" class="nav-overlay"></label>
                    <nav class="page-nav">
                        <a href="index.html">🏠 Início</a>
                        <a href="roteiros.html">📍 Roteiros</a>
                        <span class="active">✅ Coleta</span>
                        <a href="analise.html">📊 Análise</a>
                        <a href="admin.html">⚙️ Admin</a>
                        <a href="ajuda-coleta.html" target="_blank">❓ Ajuda</a>
                    </nav>
                </div>
            </div>
```

- [ ] **Step 4: Verify in a real browser**

With the local server running, open `http://localhost:8080/coleta-checklist.html`. Check:
1. The "OPERAÇÃO" title sits alone on the left, no nav row inline with it.
2. A "☰" icon appears at the right end of the header, after "📋 Checklist Próxima Coleta" — no standalone "❓" circle icon anymore.
3. Clicking "☰" opens the dropdown with 6 items, "✅ Coleta" highlighted; clicking outside or the icon again closes it.
4. Clicking "❓ Ajuda" opens `ajuda-coleta.html` in a new tab.
5. The existing header controls (route select, date, sort select, checklist button) still work — select a route and confirm the client list still renders.

- [ ] **Step 5: Commit**

```bash
git add coleta-checklist.html
git commit -m "feat(nav): replace page-nav bar with hamburger dropdown in coleta-checklist.html, remove standalone help icon"
```

---

## Task 5: Full cross-page verification

**Files:** None modified — verification only. If this step surfaces a bug, fix it in the relevant file from Tasks 1-4 and note the fix in your report, then re-run this task's checks.

**Interfaces:** None.

- [ ] **Step 1: Verify every page's hamburger menu and link set**

With the local server running, use Playwright MCP to visit each of the 4 pages and, on each: open the hamburger menu, confirm all 6 items are present with the correct one marked active (no href), confirm clicking outside the panel closes it, confirm clicking the icon again also closes it, and click through each of the 5 non-active/non-Ajuda links to confirm they land on the right page. Confirm "❓ Ajuda" opens `ajuda-coleta.html` in a new tab from all 4 pages.

- [ ] **Step 2: Confirm no visual regression**

Take a screenshot of each of the 4 pages' header area (menu closed) and confirm nothing overlaps or is cut off — especially `coleta-checklist.html`, whose header is the busiest (route select, date, sort select, checklist button, hamburger icon all in one row).

- [ ] **Step 3: Report results**

Summarize pass/fail for each of the 4 pages. No commit for this task unless a check failed and required a fix, in which case commit that fix with a message describing what was wrong.
