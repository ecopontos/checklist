// instance-identity.js
// Identidade estavel por instalacao + metadados enviados de carona ao GAS.
const INSTANCE_ID_KEY = 'satelite.instanceId';
const APELIDO_KEY = 'satelite.apelido';

function newId_() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch (_) { /* contexto sem crypto seguro */ }
    return 'iid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

export function getInstanceId() {
    let id = '';
    try { id = localStorage.getItem(INSTANCE_ID_KEY) || ''; } catch (_) { /* sem storage */ }
    if (!id) {
        id = newId_();
        try { localStorage.setItem(INSTANCE_ID_KEY, id); } catch (_) { /* best-effort */ }
    }
    return id;
}

export function getApelido() {
    try { return localStorage.getItem(APELIDO_KEY) || ''; } catch (_) { return ''; }
}

export function setApelido(valor) {
    try { localStorage.setItem(APELIDO_KEY, String(valor || '').trim()); } catch (_) { /* best-effort */ }
}

function appVersion_() {
    try {
        if (typeof window !== 'undefined' && window.APP_CONFIG && window.APP_CONFIG.appVersion) {
            return String(window.APP_CONFIG.appVersion);
        }
    } catch (_) { /* sem window */ }
    return 'dev';
}

function userAgent_() {
    try { return (typeof navigator !== 'undefined' && navigator.userAgent) || ''; } catch (_) { return ''; }
}

export function getInstanceMeta(gasUrl = '') {
    return {
        iid: getInstanceId(),
        nick: getApelido(),
        av: appVersion_(),
        gu: gasUrl || '',
        ua: userAgent_()
    };
}

export function appendInstanceParams(fullUrl, gasUrl = '') {
    const meta = getInstanceMeta(gasUrl);
    const sep = fullUrl.indexOf('?') === -1 ? '?' : '&';
    const qs = Object.keys(meta)
        .map(k => `${k}=${encodeURIComponent(meta[k])}`)
        .join('&');
    return `${fullUrl}${sep}${qs}`;
}

export function withInstanceMeta(body, gasUrl = '') {
    return { ...body, inst: getInstanceMeta(gasUrl) };
}
