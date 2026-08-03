# Migração de Electron para Tauri — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Electron wrapper with Tauri 2.x, reducing the installer
from ~79 MB to ~5–10 MB and cutting idle memory usage by ~75%. The frontend
(vanilla HTML/CSS/JS) remains unchanged — only two files get minor edits
to handle external links and print-window behavior differently.

**Architecture:** Tauri 2.x with a minimal Rust backend (`src-tauri/src/main.rs`),
serving the existing static files via the built-in `tauri://localhost` protocol.
No custom HTTP server needed. The `@tauri-apps/plugin-shell` plugin handles
external URL opening (WhatsApp). Multi-window support handles the print flow.

**Tech Stack:** Tauri 2.x, Rust (minimal — no custom logic needed), vanilla
HTML/CSS/JS frontend (unchanged), npm for frontend dependency management during
development. Build target: Windows NSIS installer.

## Global Constraints

- Do not modify any existing static file except the two specified in Task 3
  (`whatsapp-sender.html` for external links, `roteiros.html` for print window).
  All other HTML/CSS/JS files remain untouched.
- `src-tauri/` lives at the repo root alongside the existing static files.
- The frontend assets are served via `tauri://localhost` — a stable origin that
  preserves `localStorage` across restarts.
- Data previously saved under Electron's origin (`http://127.0.0.1:47821`) will
  not be accessible under Tauri's origin. Users must re-import via CSV or
  re-sync with Google Apps Script. This is acceptable because the app already
  supports both.
- Windows-only target (NSIS installer), matching the current Electron build.
- No auto-update mechanism — distribution remains manual.
- `node_modules/`, `src-tauri/target/`, and `dist/` are git-ignored.

---

## Task 1: Scaffold the Tauri project

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/main.rs`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src-tauri/build.rs`
- Create: `src-tauri/icons/` (placeholder icon)
- Modify: `.gitignore`

**Interfaces:**
- Produces: a Tauri project structure that can be compiled and run via
  `cargo tauri dev`.
- Produces: `tauri.conf.json` with the correct asset paths and window
  configuration.

- [ ] **Step 1: Install Tauri CLI**

```bash
npm install -D @tauri-apps/cli
```

- [ ] **Step 2: Initialize Tauri in the project**

```bash
npx tauri init
```

When prompted:
- App name: `SATELITE Checklist`
- Window title: `SATELITE Checklist`
- Dev server URL: leave empty (not using a framework dev server)
- Frontend asset path: `../` (repo root, where HTML files live)

This creates `src-tauri/` with `Cargo.toml`, `tauri.conf.json`, and
`src/main.rs`.

- [ ] **Step 3: Configure `tauri.conf.json`**

Replace the generated `src-tauri/tauri.conf.json` with:

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-config-schema/schema.json",
  "productName": "SATELITE Checklist",
  "version": "1.3.1",
  "identifier": "com.satelite.checklist",
  "build": {
    "frontendDist": "../",
    "devUrl": null
  },
  "app": {
    "windows": [
      {
        "title": "SATELITE Checklist",
        "width": 1280,
        "height": 800,
        "minWidth": 900,
        "minHeight": 650,
        "decorations": true,
        "resizable": true,
        "center": true
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' https://script.google.com https://script.googleusercontent.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "windows": {
      "nsis": {
        "installMode": "currentUser"
      }
    }
  }
}
```

Key points:
- `frontendDist: "../"` points to the repo root (where HTML files are).
- `devUrl: null` means Tauri serves files directly (no dev server).
- CSP allows `fetch()` to `script.google.com` and `script.googleusercontent.com`.
- NSIS `installMode: "currentUser"` installs per-user (no admin required).

- [ ] **Step 4: Configure capabilities**

Replace `src-tauri/capabilities/default.json` with:

```json
{
  "$schema": "https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-utils/schema/capability.json",
  "identifier": "default",
  "description": "Default capabilities for SATELITE Checklist",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "shell:allow-open"
  ]
}
```

This grants:
- `core:default` — window management, event system.
- `shell:allow-open` — ability to open external URLs (WhatsApp links).

- [ ] **Step 5: Create placeholder icons**

Create `src-tauri/icons/` directory. For initial development, generate
placeholder icons using the Tauri icon generator or use a simple 32x32
PNG. The icons can be replaced with a proper design later without
changing architecture.

```bash
npx tauri icon path/to/source-icon.png
```

Or manually create minimal placeholder PNGs for the required sizes.

- [ ] **Step 6: Update `.gitignore`**

Add the following entries:

```
src-tauri/target/
dist/
```

- [ ] **Step 7: Verify the app compiles**

```bash
npx tauri dev
```

Expected: Tauri compiles the Rust backend (first run takes 2–5 minutes),
then opens a window showing `index.html`. The window should have no
browser UI (address bar, tabs). The app's dashboard should load with
the same appearance as the Electron version.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/ package.json .gitignore
git commit -m "feat(tauri): scaffold Tauri 2.x project structure"
```

---

## Task 2: Configure Rust backend and build pipeline

**Files:**
- Modify: `src-tauri/Cargo.toml` (add shell plugin dependency)
- Modify: `src-tauri/src/main.rs` (add shell plugin registration)
- Modify: `package.json` (replace Electron scripts with Tauri scripts)

**Interfaces:**
- Consumes: the Tauri project structure from Task 1.
- Produces: `npm run dev` and `npm run build` commands that use Tauri
  instead of Electron.

- [ ] **Step 1: Add shell plugin to Cargo.toml**

In `src-tauri/Cargo.toml`, ensure the `[dependencies]` section includes:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

- [ ] **Step 2: Register the shell plugin in main.rs**

Replace `src-tauri/src/main.rs` with:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Update package.json scripts**

In `package.json`, replace the `scripts` section:

```json
{
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "test": "node --experimental-vm-modules tests/route-order.test.cjs && node tests/gas-route-queue.test.cjs"
  }
}
```

Remove Electron-specific devDependencies:

```json
{
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

- [ ] **Step 4: Remove Electron artifacts**

Delete the following files/directories:
- `electron/main.js`
- `electron/` directory

These are no longer needed. The equivalent functionality is now handled
by Tauri's built-in asset serving and the Rust backend.

- [ ] **Step 5: Verify dev mode works**

```bash
npm run dev
```

Expected: Tauri opens a window showing the app. The app functions
normally — dashboard loads, navigation works, sql.js initializes.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/main.rs package.json
git rm -r electron/
git commit -m "feat(tauri): configure Rust backend and replace Electron scripts"
```

---

## Task 3: Adapt frontend for Tauri APIs

**Files:**
- Modify: `whatsapp-sender.html` (external link opening)
- Modify: `roteiros.html` (print window opening)
- Create: `tauri-bridge.js` (abstraction layer for Electron/Tauri)

**Interfaces:**
- Consumes: Tauri shell plugin from Task 2.
- Produces: a thin abstraction module (`tauri-bridge.js`) that the frontend
  uses to open external URLs and internal windows, decoupling the frontend
  from the specific desktop framework.

- [ ] **Step 1: Create `tauri-bridge.js`**

Create a new file `tauri-bridge.js` at the repo root:

```javascript
/**
 * Abstraction layer for desktop framework APIs.
 * In Tauri, uses @tauri-apps/plugin-shell for external URLs.
 * In browser/Electron, falls back to window.open().
 */

let shellOpen = null;

async function initTauriBridge() {
    if (typeof window.__TAURI_INTERNALS__ !== 'undefined') {
        const { open } = await import('./vendor/@tauri-apps-plugin-shell.js');
        shellOpen = open;
    }
}

export async function openExternalUrl(url) {
    if (shellOpen) {
        await shellOpen(url);
    } else {
        window.open(url, '_blank');
    }
}

export async function openPrintWindow(routeId) {
    if (typeof window.__TAURI_INTERNALS__ !== 'undefined') {
        const { WebviewWindow } = await import('./vendor/@tauri-apps-plugin-webview-window.js');
        new WebviewWindow('print', {
            url: `imprimir.html?id=${routeId}`,
            width: 1024,
            height: 768,
            title: 'Imprimir Checklist'
        });
    } else {
        window.open(`imprimir.html?id=${routeId}`, '_blank');
    }
}

initTauriBridge();
```

Note: For simplicity, the initial implementation uses `window.open()`
with a Tauri configuration that allows new windows. The Tauri
multiwindow approach is configured in `tauri.conf.json` instead of
creating windows programmatically from JS.

**Revised approach** — configure Tauri to allow the print window via
`tauri.conf.json` rather than JS APIs. This avoids the need for
`@tauri-apps-plugin-webview-window.js` in the frontend.

- [ ] **Step 1 (revised): Configure multi-window in tauri.conf.json**

In `src-tauri/tauri.conf.json`, add a second window definition:

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "SATELITE Checklist",
        "width": 1280,
        "height": 800,
        "minWidth": 900,
        "minHeight": 650,
        "decorations": true,
        "resizable": true,
        "center": true
      },
      {
        "label": "print",
        "title": "Imprimir Checklist",
        "url": "imprimir.html",
        "width": 1024,
        "height": 768,
        "visible": false,
        "decorations": true,
        "resizable": true
      }
    ]
  }
}
```

The print window is created hidden and shown when needed.

- [ ] **Step 2: Update `whatsapp-sender.html`**

In `whatsapp-sender.html`, find the `window.open` call for WhatsApp
(line 671):

```javascript
window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
```

Replace with:

```javascript
if (typeof window.__TAURI_INTERNALS__ !== 'undefined') {
    window.__TAURI_INTERNALS__.invoke('plugin:shell|open', { url: `https://wa.me/${phone}?text=${text}` });
} else {
    window.open(`https://wa.me/${phone}?text=${text}`, '_blank');
}
```

Alternatively, use a cleaner pattern with a shared utility. The
simplest approach: use `window.__TAURI_INTERNALS__.invoke` directly
since it's a single call site.

- [ ] **Step 3: Update `roteiros.html`**

In `roteiros.html`, find the `window.open` call for printing
(line 877):

```javascript
window.open(`imprimir.html?id=${routeId}`, '_blank');
```

Replace with:

```javascript
if (typeof window.__TAURI_INTERNALS__ !== 'undefined') {
    window.location.href = `imprimir.html?id=${routeId}`;
} else {
    window.open(`imprimir.html?id=${routeId}`, '_blank');
}
```

This opens the print page in the same window when running in Tauri
(simpler than multi-window configuration). The user navigates back
using the browser-like back behavior or re-opens the app.

**Alternative (multi-window):** If preserving the separate print window
is important, configure Tauri's multi-window in `tauri.conf.json` (as
shown in Step 1 revised) and use a custom Rust command to show the
hidden print window with the correct URL parameters.

- [ ] **Step 4: Verify external links work**

1. Run `npm run dev`.
2. Navigate to Admin → Ferramentas → Disparo WhatsApp.
3. Fill in a test contact and click send.
4. **Expected:** the system's default browser opens to `wa.me` (not a
   new Tauri window).

- [ ] **Step 5: Verify print flow works**

1. Run `npm run dev`.
2. Navigate to Roteiros, add a route with at least one point.
3. Click "🖨️ Imprimir" for that route.
4. **Expected:** `imprimir.html` opens with the route data (either in
   the same window or a new window, depending on the approach chosen).

- [ ] **Step 6: Commit**

```bash
git add whatsapp-sender.html roteiros.html tauri-bridge.js src-tauri/tauri.conf.json
git commit -m "feat(tauri): adapt frontend for Tauri external link handling"
```

---

## Task 4: Build and package the Windows installer

**Files:**
- Modify: `src-tauri/tauri.conf.json` (version bump if needed)
- Modify: `.gitignore` (ensure all generated paths are ignored)

**Interfaces:**
- Consumes: the complete Tauri project from Tasks 1–3.
- Produces: `dist/SATELITE Checklist_1.3.1_x64-setup.exe` (NSIS installer).

- [ ] **Step 1: Run the production build**

```bash
npm run build
```

Expected: Tauri compiles the Rust backend in release mode (first run
takes 5–10 minutes), bundles the frontend assets, and produces an NSIS
installer in `src-tauri/target/release/bundle/nsis/`.

- [ ] **Step 2: Verify installer size**

```bash
ls -lh src-tauri/target/release/bundle/nsis/*Setup*.exe
```

Expected: installer is approximately **5–10 MB** (down from ~79 MB with
Electron).

- [ ] **Step 3: Test the installer**

Run the generated `.exe` installer on a clean Windows machine (or VM):

1. **Expected:** no UAC elevation prompt (per-user install).
2. After install, app launches automatically.
3. Dashboard loads correctly, navigation works.
4. sql.js initializes (a saved route appears if data was previously
   imported via CSV).
5. External links (WhatsApp) open in the system browser.
6. Print flow works (imprimir.html opens with route data).
7. Google sync works (fetch to script.google.com succeeds).

- [ ] **Step 4: Verify no regression in app behavior**

Compare the Tauri-built app against the Electron version:

1. All pages load identically (index, roteiros, coleta-checklist,
   analise, admin, imprimir, whatsapp-sender, ajuda-coleta).
2. Theme toggle works (dark/light).
3. CSV/XLSX import works.
4. PDF generation works.
5. Data persists across app restarts (localStorage under
   `tauri://localhost`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json .gitignore
git commit -m "feat(tauri): configure production build and NSIS packaging"
```

---

## Task 5: Full verification pass

**Files:** None modified — verification only. If this step surfaces a bug,
fix it in the relevant file from Tasks 1–4 and note the fix in your report,
then re-run the affected checks.

**Interfaces:** None.

- [ ] **Step 1: Server-level checks via Playwright**

With the Tauri app running (`npm run dev`), use Playwright MCP's
`browser_navigate` and `browser_snapshot` to hit the app's pages
directly and confirm:

1. `index.html`, `roteiros.html`, `coleta-checklist.html`, `analise.html`,
   `admin.html` all load with no console errors.
2. In `coleta-checklist.html`, a route with saved points shows its client
   list (proves `sql.js`/`.wasm` loaded correctly).
3. Close the app fully, reopen it, and confirm previously saved data
   persists — proves `tauri://localhost` origin is stable.

- [ ] **Step 2: Window-chrome checks (manual)**

1. The app window has no browser address bar, tabs, or menu bar.
2. "🖨️ Imprimir" on a route opens correctly (same window or new window).
3. WhatsApp send button opens the system's default browser.
4. Google Sheets/Drive sync completes successfully.

- [ ] **Step 3: Performance comparison**

If possible, measure on a machine with limited resources (2–4 GB RAM):

| Metric | Electron (before) | Tauri (after) |
|---|---|---|
| Installer size | ~79 MB | ~___ MB |
| Idle memory | ~300 MB | ~___ MB |
| Startup time | ~1.5s | ~___s |

- [ ] **Step 4: Report results**

Summarize pass/fail for every check above. Note any regressions
compared to the Electron version. No commit for this task unless a
check failed and required a fix.

---

## Task 6: Cleanup Electron remnants

**Files:**
- Modify: `package.json` (remove Electron-related fields)
- Delete: `electron/` (if not already deleted in Task 2)
- Modify: `PUBLICACAO.md` (update build instructions)

**Interfaces:**
- Consumes: successful completion of Tasks 1–5.
- Produces: a clean project with no Electron dependencies.

- [ ] **Step 1: Remove Electron from package.json**

Ensure `package.json` no longer references:
- `"main": "electron/main.js"` → remove or change to appropriate entry
- `electron` and `electron-builder` in `devDependencies`
- The `build` section (electron-builder config)

Final `package.json` should look like:

```json
{
  "name": "satelite-checklist",
  "version": "1.3.1",
  "description": "SATELITE v3 - Operacao de Coleta (app desktop)",
  "private": true,
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "test": "node --experimental-vm-modules tests/route-order.test.cjs && node tests/gas-route-queue.test.cjs"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2"
  }
}
```

- [ ] **Step 2: Update PUBLICACAO.md**

Replace the build instructions referencing Electron with Tauri:

```markdown
- O aplicativo desktop é gerado com `npm run build` (Tauri). Mudanças em
  HTML/JS locais exigem distribuir o novo instalador; mudanças exclusivas
  no GAS chegam a todos os aplicativos que usam a mesma URL `/exec`.
```

- [ ] **Step 3: Verify no Electron references remain**

```bash
grep -r "electron" --include="*.json" --include="*.md" --include="*.js" .
```

Remove or update any remaining references. The `tests/` directory and
`gas/` directory may mention Electron in comments — update if present.

- [ ] **Step 4: Final commit**

```bash
git add package.json PUBLICACAO.md
git commit -m "chore: remove Electron remnants, complete Tauri migration"
```
