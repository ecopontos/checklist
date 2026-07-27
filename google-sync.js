/**
 * Client for the Google Apps Script (GAS) Web App bridge to
 * Google Sheets (push coletas) and Google Drive (pull rotas/pontos CSV).
 */

const GAS_URL_KEY = 'app3_gas_url';
const LAST_DRIVE_SYNC_KEY = 'app3_last_drive_sync';
const GAS_ROUTE_TOKEN_KEY = 'app3_gas_route_token';
export const REQUIRED_GAS_API_VERSION = 3;

export function getGasUrl() {
    return localStorage.getItem(GAS_URL_KEY) || '';
}

export function setGasUrl(url) {
    localStorage.setItem(GAS_URL_KEY, url);
}

export function getGasRouteToken() {
    return localStorage.getItem(GAS_ROUTE_TOKEN_KEY) || '';
}

export function setGasRouteToken(token) {
    localStorage.setItem(GAS_ROUTE_TOKEN_KEY, token);
}

export async function getGasStatus() {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };

    try {
        const res = await fetch(`${url}?action=status`);
        if (!res.ok) {
            return { ok: false, error: `Falha HTTP ${res.status}` };
        }

        const data = await res.json();
        if (!data.ok) return data;
        if (!Object.prototype.hasOwnProperty.call(data, 'apiVersion')) {
            return { ok: true, service: 'satelite-gas-legado', apiVersion: 1, legacy: true };
        }

        const apiVersion = Number(data.apiVersion);
        if (data.service !== 'satelite-gas' || !Number.isInteger(apiVersion) || apiVersion < 1) {
            return { ok: false, error: 'Resposta de status do GAS inválida' };
        }

        return { ...data, apiVersion };
    } catch (e) {
        return { ok: false, error: e.message };
    }
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

export async function getUltimaColeta(roteiroNome) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };

    try {
        const res = await fetch(`${url}?action=ultimaColeta&roteiro=${encodeURIComponent(roteiroNome)}`);
        if (!res.ok) {
            return { ok: false, error: `Falha HTTP ${res.status}` };
        }
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
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

export async function pushRoteiroChanges(changes) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    if (!changes.length) return { ok: true, count: 0, acceptedIds: [] };

    const token = getGasRouteToken();
    if (!token) {
        return { ok: false, error: 'Token de alterações de roteiros não configurado' };
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
                action: 'routeChanges',
                token,
                changes
            })
        });
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function syncPendingRoteiroChanges(db) {
    let sentCount = 0;
    let acceptedCount = 0;
    let duplicateCount = 0;

    for (let batchNumber = 0; batchNumber < 50; batchNumber++) {
        const changes = db.getPendingRoteiroChanges(100);
        if (!changes.length) {
            return {
                ok: true,
                count: sentCount,
                acceptedCount,
                duplicateCount,
                pending: 0
            };
        }

        const result = await pushRoteiroChanges(changes);
        if (!result.ok) {
            return {
                ...result,
                count: sentCount,
                pending: db.getPendingRoteiroChangesCount()
            };
        }

        const batchIds = new Set(changes.map(change => change.change_id));
        const acceptedIds = (result.acceptedIds || []).filter(id => batchIds.has(id));
        const duplicateIds = (result.duplicateIds || []).filter(id => batchIds.has(id));
        const confirmedIds = [...new Set([...acceptedIds, ...duplicateIds])];
        if (!confirmedIds.length) {
            return {
                ok: false,
                error: 'O GAS não confirmou nenhuma alteração do lote enviado',
                count: sentCount,
                pending: db.getPendingRoteiroChangesCount()
            };
        }

        db.markRoteiroChangesSent(confirmedIds);
        sentCount += confirmedIds.length;
        acceptedCount += acceptedIds.length;
        duplicateCount += duplicateIds.length;
    }

    return {
        ok: false,
        error: 'A fila excedeu o limite de segurança de 5.000 alterações por sincronização',
        count: sentCount,
        pending: db.getPendingRoteiroChangesCount()
    };
}
