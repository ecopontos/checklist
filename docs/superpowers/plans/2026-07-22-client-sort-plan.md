# Ordenação de Clientes no Checklist de Coleta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sort selector to `coleta-checklist.html` letting the operator choose how the selected route's client list is displayed: by route order (current/default), alphabetically by client name, or by quantity already entered this session (descending).

**Architecture:** Sorting happens only at render time, on a shallow copy of the existing `currentClients` array — `currentClients` itself is never mutated or reordered, so everything else that depends on its original route order (PDF checklist generation, stats) is unaffected. A new `currentSort` module-level variable tracks the active mode; a new `sortClients(list)` function branches on it.

**Tech Stack:** Vanilla JS, no build process, no automated test framework in this repo — verification is manual in a real browser (or documented code-reading fallback if no browser automation is available).

## Global Constraints

- Scope: `coleta-checklist.html` only. Does not touch `roteiros.html`, `imprimir.html`, or any other file.
- Three sort modes: `ordem` (default, by `c.ordem` ascending), `alfabetica` (by `c.cliente` via `localeCompare(..., 'pt-BR')`), `quantidade` (by `sessionData[c.id_rota].qty` descending, ties broken by `c.ordem` ascending, missing/zero quantities sort last).
- `currentClients` is never reordered in place — only a copy is sorted for rendering.
- The number shown on each card stays `c.ordem` (the route's real order number), not the row's on-screen position — this already works today via the existing `c.ordem || i + 1` expression and needs no change.
- Switching route (`loadRoute`) always resets the sort mode back to `'ordem'`, both in state (`currentSort`) and in the `<select>`'s displayed value.
- The ID search box (`#idSearch` → `focusItem`) is unaffected: it filters to a single card and never goes through `sortClients`.
- No persistence (localStorage or otherwise) of the chosen sort mode across route changes or sessions.
- The PDF checklist (`buildChecklistDoc`) keeps using `currentClients` in its original route order, regardless of what's selected on screen.

---

## Task 1: Add the sort selector and wire it into rendering

**Files:**
- Modify: `coleta-checklist.html`

**Interfaces:**
- Produces: `sortClients(list: Array) -> Array` (new, module-scoped in `coleta-checklist.html`'s `<script type="module">`) — returns a new sorted array, never mutates `list`.
- Produces: `currentSort` (new module-level variable, one of `'ordem' | 'alfabetica' | 'quantidade'`).
- No other file depends on these — this task is self-contained.

- [ ] **Step 1: Add the `currentSort` state variable**

In `coleta-checklist.html`, replace:

```js
        let currentClients = [];
        let sessionData = {}; // id_rota -> { qty, issue }
```

with:

```js
        let currentClients = [];
        let sessionData = {}; // id_rota -> { qty, issue }
        let currentSort = 'ordem'; // 'ordem' | 'alfabetica' | 'quantidade'
```

- [ ] **Step 2: Add the `<select id="sortSelect">` to the header controls**

In `coleta-checklist.html`, replace:

```html
            <div class="controls">
                <select id="routeSelect">
                    <option value="">Selecione o Roteiro</option>
                </select>
                <input type="date" id="opDate">
                <button class="btn-checklist" id="btnChecklist" type="button">📋 Checklist Próxima Coleta</button>
            </div>
```

with:

```html
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
            </div>
```

No new CSS is needed — `select` already has global styling in this file's `<style>` block.

- [ ] **Step 3: Add `sortClients` and `handleSortChange`, and use `sortClients` in `renderList`**

In `coleta-checklist.html`, replace:

```js
        function renderList(filterId = null) {
            const container = document.getElementById('listContainer');
            if (currentClients.length === 0) {
                container.innerHTML = '<div class="empty-state"><h3>Roteiro sem pontos cadastrados</h3><p>Vá em Gestão de Roteiros para adicionar pontos.</p></div>';
                return;
            }

            const clientsToShow = filterId 
                ? currentClients.filter(c => c.id_rota == filterId)
                : currentClients;

            container.innerHTML = clientsToShow.map((c, i) => {
```

with:

```js
        function sortClients(list) {
            const sorted = [...list];
            if (currentSort === 'alfabetica') {
                sorted.sort((a, b) => a.cliente.localeCompare(b.cliente, 'pt-BR'));
            } else if (currentSort === 'quantidade') {
                sorted.sort((a, b) => {
                    const qtyA = (sessionData[a.id_rota] && sessionData[a.id_rota].qty) || 0;
                    const qtyB = (sessionData[b.id_rota] && sessionData[b.id_rota].qty) || 0;
                    if (qtyB !== qtyA) return qtyB - qtyA;
                    return (a.ordem || 0) - (b.ordem || 0);
                });
            } else {
                sorted.sort((a, b) => (a.ordem || 0) - (b.ordem || 0));
            }
            return sorted;
        }

        function handleSortChange() {
            currentSort = document.getElementById('sortSelect').value;
            renderList();
        }

        function renderList(filterId = null) {
            const container = document.getElementById('listContainer');
            if (currentClients.length === 0) {
                container.innerHTML = '<div class="empty-state"><h3>Roteiro sem pontos cadastrados</h3><p>Vá em Gestão de Roteiros para adicionar pontos.</p></div>';
                return;
            }

            const clientsToShow = filterId 
                ? currentClients.filter(c => c.id_rota == filterId)
                : sortClients(currentClients);

            container.innerHTML = clientsToShow.map((c, i) => {
```

Note: the row-num display later in this same function (`${c.ordem || i + 1}`) is unchanged — it already prioritizes `c.ordem` over the loop index `i`, which is exactly the "keep the original route number" behavior this feature requires.

- [ ] **Step 4: Wire `sortSelect`'s change handler in `init()`**

In `coleta-checklist.html`, replace:

```js
            select.onchange = loadRoute;
            document.getElementById('btnSave').onclick = saveOperation;

            document.getElementById('btnChecklist').onclick = openChecklistModal;
```

with:

```js
            select.onchange = loadRoute;
            document.getElementById('btnSave').onclick = saveOperation;
            document.getElementById('sortSelect').onchange = handleSortChange;

            document.getElementById('btnChecklist').onclick = openChecklistModal;
```

- [ ] **Step 5: Reset sort mode when a new route is loaded**

In `coleta-checklist.html`, replace:

```js
            currentClients = db.getClientesByRoteiro(routeId);
            sessionData = {};
            renderList();
```

with:

```js
            currentClients = db.getClientesByRoteiro(routeId);
            sessionData = {};
            currentSort = 'ordem';
            document.getElementById('sortSelect').value = 'ordem';
            renderList();
```

- [ ] **Step 6: Verify in a real browser**

With a local server running (`python -m http.server 8080` from the repo root), open `http://localhost:8080/coleta-checklist.html`, select a route with at least 3 points that have different `ordem` values and distinguishable names.

Checks:
1. Default view: list order matches route order (`ordem`), same as before this change. The "Número de Ordem" option is selected in the dropdown.
2. Switch to "Ordem Alfabética": list re-renders sorted by client name (check accented names sort correctly relative to unaccented ones, e.g. "Álvares" near "Alves", not pushed to the end). Card numbers still show each client's original `ordem`, not 1/2/3 in the new order.
3. Type a quantity into 2-3 of the visible qty inputs (directly in the list, using the inputs' `onchange`, i.e. type and then click elsewhere or Tab out). Switch to "Qtd. Digitada": after switching, the clients with quantities entered move to the top, highest quantity first; clients with no quantity are at the bottom. (Direct inline edits don't reorder the list live — only switching the sort mode or loading a route does; confirm this matches expectation, not a bug.)
4. Use the ID search box (`#idSearch`) to search for one client's ID and press Enter: confirm it still isolates that single card exactly as before, regardless of the active sort mode.
5. After using the search box to enter a quantity for one client (search → type qty → Enter), confirm the list returns to the full view and, if "Qtd. Digitada" is the active mode, that client's new position reflects its updated quantity (this flow already calls `renderList()` on every entry).
6. Switch back to "Número de Ordem": list returns to route order.
7. Change the route selector to a different route: confirm the sort dropdown resets to "Número de Ordem" and the list displays in route order for the new route.
8. Open the "📋 Checklist Próxima Coleta" modal and download a PDF while a non-default sort mode (e.g. "Ordem Alfabética") is active: confirm the PDF's table is still in route order, not alphabetical — the PDF is unaffected by the on-screen sort.

If no browser automation is available in your environment, use a documented code-reading fallback instead: re-read the full diff for this task against each of the 8 checks above, tracing the code path by hand (e.g., confirm `buildChecklistDoc` in this same file iterates `currentClients` directly, not through `sortClients`, to support check 8). State clearly in your report that this is a code-reading fallback, not an executed browser check.

- [ ] **Step 7: Commit**

```bash
git add coleta-checklist.html
git commit -m "feat(coleta): add client sort selector (ordem/alfabetica/quantidade)"
```
