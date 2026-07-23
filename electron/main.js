const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

const PORT = 47821;
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;
const ROOT_DIR = path.resolve(__dirname, '..');
const BLOCKED_ROOT_ENTRIES = new Set(['.git', 'dist', 'electron', 'node_modules']);

let staticServer = null;
let mainWindow = null;

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

function resolveRequestFile(rawUrl) {
  try {
    const requestUrl = new URL(rawUrl, APP_ORIGIN);
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const relativePath = decodedPath === '/'
      ? 'index.html'
      : decodedPath.replace(/^[/\\]+/, '');
    const filePath = path.resolve(ROOT_DIR, relativePath);
    const relativeToRoot = path.relative(ROOT_DIR, filePath);
    const isOutsideRoot = relativeToRoot.startsWith(`..${path.sep}`)
      || relativeToRoot === '..'
      || path.isAbsolute(relativeToRoot);

    if (isOutsideRoot) return { status: 403 };

    const rootEntry = relativeToRoot.split(path.sep)[0].toLowerCase();
    if (BLOCKED_ROOT_ENTRIES.has(rootEntry) || relativeToRoot.toLowerCase() === 'package.json') {
      return { status: 403 };
    }

    return { status: 200, filePath };
  } catch {
    return { status: 400 };
  }
}

function sendText(res, status, message, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(message);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
        return;
      }

      const resolved = resolveRequestFile(req.url);
      if (resolved.status !== 200) {
        sendText(res, resolved.status, resolved.status === 400 ? 'Bad request' : 'Forbidden');
        return;
      }

      const filePath = resolved.filePath;
      fs.readFile(filePath, (err, data) => {
        if (err) {
          sendText(res, 404, 'Not found');
          return;
        }
        res.writeHead(200, {
          'Content-Type': contentTypeFor(filePath),
          'Content-Length': data.length,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(req.method === 'HEAD' ? undefined : data);
      });
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Porta ${PORT} ja esta em uso. Feche a outra instancia do app e tente novamente.`));
      } else {
        reject(err);
      }
    });

    server.listen(PORT, '127.0.0.1', () => {
      staticServer = server;
      resolve(server);
    });
  });
}

function isInternalUrl(rawUrl) {
  try {
    return new URL(rawUrl).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function openExternalSafely(rawUrl) {
  try {
    const target = new URL(rawUrl);
    if (target.protocol === 'https:' || target.protocol === 'http:') {
      shell.openExternal(target.href);
    }
  } catch {
    // Invalid and unsupported URLs remain blocked inside the app.
  }
}

function createWindow(urlPath, { primary = false } = {}) {
  const targetUrl = new URL(urlPath, APP_ORIGIN);
  if (targetUrl.origin !== APP_ORIGIN) return null;

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 650,
    show: false,
    backgroundColor: '#101214',
    title: 'SATELITE Checklist',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  if (primary) mainWindow = win;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternalUrl(url)) {
      const internalUrl = new URL(url);
      createWindow(`${internalUrl.pathname}${internalUrl.search}${internalUrl.hash}`);
    } else {
      openExternalSafely(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isInternalUrl(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });

  win.loadURL(targetUrl.href).catch((err) => {
    dialog.showErrorBox('Não foi possível abrir o aplicativo', err.message);
  });
  return win;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      await startServer();
    } catch (err) {
      dialog.showErrorBox('Não foi possível iniciar', err.message);
      app.quit();
      return;
    }

    createWindow('/index.html', { primary: true });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow('/index.html', { primary: true });
      }
    });
  });
}

app.on('will-quit', () => {
  if (staticServer) staticServer.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
