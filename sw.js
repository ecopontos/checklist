// Service worker do PWA: guarda o app inteiro no cache para funcionar offline.
// VERSION acompanha a versão do package.json (tests/pwa.test.cjs confere):
// cada release gera um cache novo e apaga o anterior. Requisições para o GAS
// (outra origem) nunca passam por aqui.
const VERSION = '1.6.6';
const CACHE = `satelite-app-${VERSION}`;
const FONT_CACHE = 'satelite-fonts';

const PRECACHE = [
    './',
    'index.html',
    'admin.html',
    'agendamentos.html',
    'ajuda-coleta.html',
    'ajuda-integracao-access.html',
    'analise.html',
    'coleta-checklist.html',
    'dashboard.html',
    'imprimir.html',
    'roteiros.html',
    'whatsapp-sender.html',
    'coleta-desktop.css',
    'theme.css',
    'coleta-operation.js',
    'coleta-sync.js',
    'config.js',
    'dashboard-metrics.js',
    'dashboard.js',
    'database.js',
    'google-sync.js',
    'nav-menu.js',
    'pwa.js',
    'theme.js',
    'whatsapp-campaign.js',
    'whatsapp-events.js',
    'whatsapp-sender.js',
    'vendor/jspdf.plugin.autotable.min.js',
    'vendor/jspdf.umd.min.js',
    'vendor/papaparse.min.js',
    'vendor/sql-wasm.js',
    'vendor/sql-wasm.wasm',
    'vendor/xlsx.full.min.js',
    'manifest.webmanifest',
    'icons/apple-touch-icon.png',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-maskable-192.png',
    'icons/icon-maskable-512.png'
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE)
            .then(cache => cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys
                .filter(key => key.startsWith('satelite-app-') && key !== CACHE)
                .map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);

    if (url.origin === self.location.origin) {
        event.respondWith(fromCacheFirst(request));
    } else if (FONT_HOSTS.includes(url.hostname)) {
        event.respondWith(staleWhileRevalidate(request));
    }
});

// O app é estático e versionado: o cache responde primeiro (inclusive
// páginas com ?id=...), a rede só é usada para o que não foi pré-cacheado
// (ex.: config.local.js, que só existe no instalador desktop).
async function fromCacheFirst(request) {
    const cached = await caches.match(request, { cacheName: CACHE, ignoreSearch: true });
    if (cached) return cached;
    try {
        return await fetch(request);
    } catch (error) {
        if (request.mode === 'navigate') {
            const fallback = await caches.match('index.html', { cacheName: CACHE });
            if (fallback) return fallback;
        }
        return new Response('', { status: 504, statusText: 'Offline' });
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(FONT_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
        .then(response => {
            if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
            return response;
        })
        .catch(() => cached);
    return cached || network;
}
