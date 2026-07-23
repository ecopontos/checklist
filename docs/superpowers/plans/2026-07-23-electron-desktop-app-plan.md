# Empacotamento como App Windows (Electron) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing static HTML/CSS/JS app in Electron so it can be distributed
as a Windows installer (`Setup.exe`) that installs per-user (no admin rights required),
creates a desktop shortcut, and opens in its own window — no shared network server, no
`file://` path required.

**Architecture:** A new `package.json` at the repo root (not a subfolder) plus
`electron/main.js`. The Electron main process starts a minimal Node `http` static
file server bound to `127.0.0.1:47821` (fixed port — required so `localStorage`, where
`app3_db` lives, keeps the same origin and persists across app restarts), serving the
existing static files directly from the repo root with correct MIME types (notably
`.wasm` → `application/wasm`, without which `sql.js` fails to load). A `BrowserWindow`
loads `http://127.0.0.1:47821/index.html`. `setWindowOpenHandler` routes
same-origin `window.open()` calls (the existing `imprimir.html` print flow) to a new
internal `BrowserWindow`, and any other origin (the existing `wa.me` WhatsApp link) to
the system's default browser via `shell.openExternal`. `electron-builder` packages this
into an NSIS installer targeting per-user install
(`%LOCALAPPDATA%\Programs\<name>`, no elevation).

**Tech Stack:** Electron, electron-builder, Node's built-in `http`/`fs` modules (no
Express or other static-file-serving dependency — the file set is small and the logic
is a dozen lines). No automated test framework in this repo (matches the rest of the
project) — verification is a mix of Playwright hitting the embedded server directly
(for server/content behavior, which Playwright's browser tools can reach like any other
HTTP server) and a manual/visual checklist for window-chrome behavior that isn't
reachable through this session's tooling (Electron GUI automation would require
Playwright's separate `_electron` API, not available here) — documented explicitly as a
fallback where it applies, same convention already used in this project's
`2026-07-22-client-sort-plan.md`.

## Global Constraints

- Do not modify any existing static file (`index.html`, `roteiros.html`,
  `coleta-checklist.html`, `analise.html`, `admin.html`, `imprimir.html`,
  `whatsapp-sender.html`, `database.js`, `google-sync.js`, `vendor/**`). The Electron
  wrapper serves them as-is.
- `package.json` lives at the repo root with `"main": "electron/main.js"` — not in a
  subfolder — so `electron-builder` can reference the existing static files directly
  via relative paths, with zero duplication.
- The embedded server listens only on `127.0.0.1:47821` (fixed port, not
  dynamically chosen, not exposed to the network) — the port must never change between
  runs, because `localStorage` (holding `app3_db`) is scoped per-origin
  (protocol+host+port) and a changing port would make previously saved data
  disappear from the app's perspective.
- If port 47821 is already in use when the app starts, show a native error dialog
  (`dialog.showErrorBox`) and quit — never silently fall back to a different port.
- `.wasm` files must be served with `Content-Type: application/wasm` — without this,
  `sql.js` fails to load and the app shows no data even when some was previously saved.
- No custom `.ico` icon file in this plan — Electron's and electron-builder's built-in
  default icons are used (the design's "placeholder genérico, trocável depois" is
  satisfied by not overriding the default at all; adding a custom icon later needs no
  architecture change, just a file + one config line).
- NSIS installer: `perMachine: false` (per-user install under
  `%LOCALAPPDATA%\Programs\<name>`, no admin elevation required), `oneClick: true`
  (single-click install, creates the desktop shortcut automatically — no wizard screens
  for non-technical operators to navigate).
- No auto-update mechanism — distribution is manual copying of `Setup.exe`, as decided.
- `node_modules/` and the `electron-builder` output directory (`dist/`) are
  git-ignored — never committed.

---

## Task 1: Embedded server + basic window

**Files:**
- Create: `package.json`
- Create: `electron/main.js`
- Modify: `.gitignore`

**Interfaces:**
- Produces: a running Electron app, launched via `npm start`, that serves the repo's
  static files on `http://127.0.0.1:47821` and opens `index.html` in a `BrowserWindow`.
- Produces: `PORT` constant (`47821`) and `ROOT_DIR` constant (parent of `electron/`)
  in `electron/main.js`, referenced by Task 2's edits to the same file.
- No other file depends on this task yet — Task 2 modifies `electron/main.js` further,
  Task 3 adds packaging config to `package.json`.

- [ ] **Step 1: Create `package.json`**

At the repo root, create `package.json`:

```json
{
  "name": "satelite-checklist",
  "version": "1.0.0",
  "description": "SATELITE v3 - Operacao de Coleta (app desktop)",
  "private": true,
  "main": "electron/main.js",
  "scripts": {
    "start": "electron ."
  },
  "devDependencies": {
    "electron": "^31.0.0"
  }
}
```

- [ ] **Step 2: Install Electron**

```bash
npm install
```

Expected: creates `node_modules/` and `package-lock.json`, no errors.

- [ ] **Step 3: Create `electron/main.js`**

Create the directory and file `electron/main.js`:

```js
const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 47821;
const ROOT_DIR = path.join(__dirname, '..');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const relativePath = urlPath === '/' ? '/index.html' : urlPath;
      const filePath = path.join(ROOT_DIR, relativePath);

      if (!filePath.startsWith(ROOT_DIR)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
        res.end(data);
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Porta ${PORT} ja esta em uso. Feche a outra instancia do app e tente novamente.`));
      } else {
        reject(err);
      }
    });

    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function createWindow(urlPath) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${PORT}${urlPath}`);
  return win;
}

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    dialog.showErrorBox('Nao foi possivel iniciar', err.message);
    app.quit();
    return;
  }

  createWindow('/index.html');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow('/index.html');
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
```

- [ ] **Step 4: Update `.gitignore`**

In `.gitignore`, replace:

```
.DS_Store
Thumbs.db
.worktrees/
```

with:

```
.DS_Store
Thumbs.db
.worktrees/
node_modules/
dist/
package-lock.json
```

(`package-lock.json` is excluded here deliberately to match this repo's existing
convention of not committing generated lockfiles for tooling that isn't part of the
site's own runtime — if the team prefers to commit it for reproducible builds, that's a
one-line change, not an architectural one.)

- [ ] **Step 5: Verify the app launches and serves files correctly**

Run:

```bash
npm start
```

Expected: an Electron window opens showing the app's dashboard (`index.html`), no
crash, no dialog box.

While it's running, verify the embedded server serves files with correct content types
— from a second terminal:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:47821/index.html
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:47821/vendor/sql-wasm.wasm
```

Expected: first line `200 text/html; charset=utf-8`, second line
`200 application/wasm` (adjust the `.wasm` filename if `vendor/`'s actual file is
named differently — check with `ls vendor/` first). If `curl` isn't available, use
Playwright MCP's `browser_navigate` to `http://127.0.0.1:47821/index.html` directly and
confirm the page renders with no console errors about MIME types or blocked module
scripts.

Close the app, then run `npm start` again: confirm it opens the same window with no
port-conflict error dialog (proves the previous instance released the port cleanly).

- [ ] **Step 6: Commit**

```bash
git add package.json electron/main.js .gitignore
git commit -m "feat(electron): add embedded server and basic app window"
```

---

## Task 2: Route internal vs. external links

**Files:**
- Modify: `electron/main.js`

**Interfaces:**
- Consumes: `PORT` constant and `createWindow(urlPath)` function from Task 1.
- Modifies `createWindow` to add link routing — no new exported interface, this is the
  last change to `electron/main.js` in this plan.

- [ ] **Step 1: Add `shell` to the Electron import**

In `electron/main.js`, replace:

```js
const { app, BrowserWindow, dialog } = require('electron');
```

with:

```js
const { app, BrowserWindow, dialog, shell } = require('electron');
```

- [ ] **Step 2: Add the window-open handler**

In `electron/main.js`, replace:

```js
function createWindow(urlPath) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${PORT}${urlPath}`);
  return win;
}
```

with:

```js
function createWindow(urlPath) {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);

  win.webContents.setWindowOpenHandler(({ url }) => {
    const origin = `http://127.0.0.1:${PORT}`;
    if (url.startsWith(origin + '/')) {
      createWindow(url.slice(origin.length));
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.loadURL(`http://127.0.0.1:${PORT}${urlPath}`);
  return win;
}
```

This makes every `window.open()` call from the app's existing pages resolve through one
of two paths: same-origin URLs (the app's own pages, e.g. `imprimir.html`) open as a new
Electron `BrowserWindow` recursively through `createWindow`; any other origin (e.g.
`https://wa.me/...`) is handed to the OS's default browser via `shell.openExternal`,
and the `{ action: 'deny' }` return stops Electron from also opening it internally.

- [ ] **Step 3: Verify with the app's existing test data**

There's no automated test framework in this repo, and Electron's window-chrome
behavior (which window a click opens, whether it's the system browser vs. an internal
window) isn't reachable with this session's browser-automation tooling (Playwright
MCP's browser tools drive a regular browser via CDP; Electron GUI automation needs
Playwright's separate `_electron` API, which is not set up in this project). Verify
manually:

1. Run `npm start`.
2. In the app, go to "Roteiros" (if no route data exists yet, add one manually through
   the UI — a name and one point is enough).
3. Click "🖨️ Imprimir" for that route. **Expected:** a second app window opens showing
   `imprimir.html` with that route's data — not the system browser.
4. Go to "Admin" → the "🛠️ Ferramentas" card → "📲 Disparo WhatsApp".
5. Fill in a test contact and click through to the send step, then click the WhatsApp
   send button. **Expected:** the system's default browser opens to a `wa.me` URL — not
   a new Electron window.

If either check fails, the routing logic in Step 2 needs revisiting before proceeding —
report this as a concern rather than moving on.

- [ ] **Step 4: Commit**

```bash
git add electron/main.js
git commit -m "feat(electron): route internal links to app windows, external links to system browser"
```

---

## Task 3: Package as a per-user Windows installer

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: the `electron/main.js` entry point and the static files at the repo root
  (both already in place from Tasks 1-2).
- Produces: `dist/*.exe` (the NSIS installer), via `npm run build`. Nothing else in
  this plan depends on this output — it's the final distributable artifact.

- [ ] **Step 1: Add `electron-builder` and the build config to `package.json`**

In `package.json`, replace:

```json
{
  "name": "satelite-checklist",
  "version": "1.0.0",
  "description": "SATELITE v3 - Operacao de Coleta (app desktop)",
  "private": true,
  "main": "electron/main.js",
  "scripts": {
    "start": "electron ."
  },
  "devDependencies": {
    "electron": "^31.0.0"
  }
}
```

with:

```json
{
  "name": "satelite-checklist",
  "version": "1.0.0",
  "description": "SATELITE v3 - Operacao de Coleta (app desktop)",
  "private": true,
  "main": "electron/main.js",
  "scripts": {
    "start": "electron .",
    "build": "electron-builder --win"
  },
  "devDependencies": {
    "electron": "^31.0.0",
    "electron-builder": "^24.13.3"
  },
  "build": {
    "appId": "com.satelite.checklist",
    "productName": "SATELITE Checklist",
    "files": [
      "electron/**/*",
      "*.html",
      "database.js",
      "google-sync.js",
      "vendor/**/*"
    ],
    "win": {
      "target": "nsis"
    },
    "nsis": {
      "perMachine": false,
      "oneClick": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true
    }
  }
}
```

- [ ] **Step 2: Install `electron-builder`**

```bash
npm install
```

Expected: adds `electron-builder` under `node_modules/`, no errors.

- [ ] **Step 3: Build the installer**

```bash
npm run build
```

Expected: completes without error, produces a file matching `dist/*Setup*.exe` (exact
name comes from `productName` + version, e.g.
`dist/SATELITE Checklist Setup 1.0.0.exe`). Run `ls dist/` to confirm.

- [ ] **Step 4: Install it and verify per-user behavior**

Run the generated `.exe` from `dist/` directly (double-click, or from a terminal):

1. **Expected:** no Windows UAC ("Do you want to allow this app...") elevation
   prompt — confirms the per-user install path doesn't require admin rights.
2. After install completes, **expected:** a desktop shortcut for "SATELITE Checklist"
   appears, and the app itself launches (it's a one-click installer per Step 1's
   config).
3. Check the install location: it should be under
   `%LOCALAPPDATA%\Programs\SATELITE Checklist` (or similar), **not** under
   `C:\Program Files\` — confirm with:

```bash
ls "$LOCALAPPDATA/Programs"
```

4. Confirm the installed app opens and behaves the same as `npm start` did in Tasks 1-2
   (dashboard loads, a route's data is visible if any was saved during earlier manual
   testing — note that this is a **separate installed copy** from the `npm start` dev
   copy, so it starts with its own empty `app3_db` the first time; that's expected, not
   a bug).

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat(electron): package as a per-user NSIS installer"
```

---

## Task 4: Full verification pass

**Files:** None modified — verification only. If this step surfaces a bug, fix it in
the relevant file from Tasks 1-3 and note the fix in your report, then re-run the
affected checks.

**Interfaces:** None.

- [ ] **Step 1: Server-level checks via Playwright**

With the installed app (or `npm start`) running, use Playwright MCP's
`browser_navigate` and `browser_snapshot` to hit `http://127.0.0.1:47821/` directly
(same technique already used earlier in this project to verify `coleta-checklist.html`
and the page-navigation feature) and confirm:

1. `index.html`, `roteiros.html`, `coleta-checklist.html`, `analise.html`,
   `admin.html` all load with no console errors.
2. In `coleta-checklist.html`, a route with saved points shows its client list (proves
   `sql.js`/`.wasm` loaded correctly through the embedded server's MIME type mapping —
   an empty list with no error would silently indicate a MIME type regression).
3. Close the app fully, reopen it, and confirm previously saved data (a route, a
   collection entry) is still present — proves the fixed port kept the `localStorage`
   origin stable across restarts.

- [ ] **Step 2: Window-chrome checks (manual — not reachable by this session's tooling)**

As in Task 2's Step 3, but re-run once against the final packaged/installed app rather
than the dev (`npm start`) copy, since packaging can occasionally change file paths or
resource resolution in ways `npm start` doesn't exercise:

1. The app window has no browser address bar, tabs, or menu bar — just the app's own
   UI.
2. "🖨️ Imprimir" on a route opens a second **app window** (not the system browser).
3. The WhatsApp send button in `whatsapp-sender.html` opens the **system's default
   browser** (not a second app window).
4. Google Sheets/Drive sync in `admin.html` (with a Web App URL already configured from
   earlier testing in this project) completes successfully — confirms outbound
   `fetch()` to `script.google.com` isn't blocked from inside the packaged app.

- [ ] **Step 3: Report results**

Summarize pass/fail for every check above. No commit for this task unless a check
failed and required a fix in Tasks 1-3's files, in which case commit that fix with a
message describing what was wrong.
