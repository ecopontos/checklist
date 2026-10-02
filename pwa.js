// Registro do PWA. No app desktop (Tauri) não há service worker: os arquivos
// já vêm do instalador.
(function () {
    function syncThemeColor() {
        var meta = document.querySelector('meta[name="theme-color"]');
        if (!meta || !document.body) return;
        var color = getComputedStyle(document.body).backgroundColor;
        if (color && color !== 'rgba(0, 0, 0, 0)' && color !== 'transparent') meta.setAttribute('content', color);
    }

    document.addEventListener('DOMContentLoaded', function () {
        syncThemeColor();
        new MutationObserver(syncThemeColor)
            .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    });

    if (window.__TAURI_INTERNALS__ || !('serviceWorker' in navigator) || !window.isSecureContext) return;

    window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js', { scope: './' }).catch(function (error) {
            console.warn('Service worker não registrado.', error);
        });
    });
})();
