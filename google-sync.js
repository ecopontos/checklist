/**
 * Client for the Google Apps Script (GAS) Web App bridge to
 * Google Sheets (push coletas) and Google Drive (pull rotas/pontos CSV).
 */

const GAS_URL_KEY = 'app3_gas_url';
const LAST_DRIVE_SYNC_KEY = 'app3_last_drive_sync';

export function getGasUrl() {
    return localStorage.getItem(GAS_URL_KEY) || '';
}

export function setGasUrl(url) {
    localStorage.setItem(GAS_URL_KEY, url);
}

export async function pushColetas(coletas) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    if (!coletas.length) return { ok: true, count: 0 };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ coletas })
        });
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function checkAndImportRoteiros(db) {
    const url = getGasUrl();
    if (!url) return { checked: false, reason: 'no-url' };

    try {
        const res = await fetch(url, { method: 'GET' });
        const data = await res.json();

        if (!data.ok) {
            return { checked: true, updated: false, error: data.error };
        }

        const lastSync = localStorage.getItem(LAST_DRIVE_SYNC_KEY);
        if (lastSync && new Date(data.modifiedTime) <= new Date(lastSync)) {
            return { checked: true, updated: false };
        }

        const result = db.importRoteirosCsv(data.content);
        localStorage.setItem(LAST_DRIVE_SYNC_KEY, data.modifiedTime);
        return { checked: true, updated: true, ...result };
    } catch (e) {
        return { checked: true, updated: false, error: e.message };
    }
}

export async function sendChecklistToDrive(filename, pdfBase64) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ checklist: { filename, pdfBase64 } })
        });
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}
