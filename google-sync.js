/**
 * Client for the Google Apps Script (GAS) Web App bridge to
 * Google Sheets (push coletas) and Google Drive (pull rotas/pontos CSV via GAS).
 */
const GAS_URL_KEY = 'app3_gas_url';
const LAST_CSV_DRIVE_SYNC_KEY = 'app3_last_roteiros_csv_drive_sync';
const GAS_ROUTE_TOKEN_KEY = 'app3_gas_route_token';
export const REQUIRED_GAS_API_VERSION = 12;

function getAppConfig_() {
    return (typeof window !== 'undefined' && window.APP_CONFIG) || {};
}

export function getGasUrl() {
    return localStorage.getItem(GAS_URL_KEY) || getAppConfig_().gasUrl || '';
}

export function setGasUrl(url) {
    localStorage.setItem(GAS_URL_KEY, url);
}

export function getGasRouteToken() {
    return localStorage.getItem(GAS_ROUTE_TOKEN_KEY) || getAppConfig_().gasRouteToken || '';
}

export function setGasRouteToken(token) {
    localStorage.setItem(GAS_ROUTE_TOKEN_KEY, token);
}

export async function getGasStatus() {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };

    const data = await gasGetJsonWithRetry_(`${url}?action=status`);
    if (!data.ok) return data;
    if (!Object.prototype.hasOwnProperty.call(data, 'apiVersion')) {
        return { ok: true, service: 'satelite-gas-legado', apiVersion: 1, legacy: true };
    }

    const apiVersion = Number(data.apiVersion);
    if (data.service !== 'satelite-gas' || !Number.isInteger(apiVersion) || apiVersion < 1) {
        return { ok: false, error: 'Resposta de status do GAS inválida' };
    }

    return { ...data, apiVersion };
}

export async function pushColetas(coletas) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    if (!coletas.length) return { ok: true, count: 0 };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
        const res = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ coletas })
        });
        if (!res.ok) {
            return { ok: false, error: `Falha HTTP ${res.status}` };
        }
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.name === 'AbortError' ? 'Tempo esgotado ao enviar coletas' : e.message };
    } finally {
        clearTimeout(timeout);
    }
}

const coletaSyncs = new WeakMap();

export function syncPendingColetas(db) {
    const current = coletaSyncs.get(db);
    if (current) return current;
    const task = runPendingColetas_(db).finally(() => coletaSyncs.delete(db));
    coletaSyncs.set(db, task);
    return task;
}

async function runPendingColetas_(db) {
    const pending = db.getUnsyncedColetas();
    let count = 0;
    for (let offset = 0; offset < pending.length; offset += 100) {
        // Persistir o ID antes da primeira tentativa também para registros legados.
        const batch = pending.slice(offset, offset + 100).map(c => ({
            ...c, sync_id: c.sync_id || db.ensureColetaSyncId(c.id)
        }));
        const result = await pushColetas(batch);
        if (!result.ok) return { ...result, count, pending: db.getUnsyncedColetas().length };
        const inserted = result.count;
        const duplicates = result.duplicates ?? 0;
        if (!Number.isInteger(inserted) || !Number.isInteger(duplicates) ||
            inserted < 0 || duplicates < 0 || inserted + duplicates !== batch.length) {
            return { ok: false, error: 'O GAS não confirmou todas as coletas do lote', count, pending: db.getUnsyncedColetas().length };
        }
        if (typeof db.markColetasSynced === 'function') db.markColetasSynced(batch);
        else batch.forEach(c => db.markColetaSynced(c.id, c.sync_id));
        count += batch.length;
    }
    return { ok: true, count, pending: db.getUnsyncedColetas().length };
}

export async function checkAndImportRoteiros(db) {
    const url = getGasUrl();
    if (!url) return { checked: false, reason: 'no-url' };

    // A resposta pode passar por um redirecionamento transitório do Google.
    // A ação específica impede confundir a resposta de roteiros do Sheets com
    // o CSV do Drive, que contém o logradouro necessário nos formulários.
    const maxAttempts = 3;
    let res = null;
    let data = null;
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45000);
        try {
            res = await fetch(`${url}?action=roteirosCsv`, {
                method: 'GET',
                signal: controller.signal
            });
            if (res.ok) {
                data = await res.json();
                break;
            }
            const failedGoogleRedirect = res.redirected &&
                /^https:\/\/script\.googleusercontent\.com(?:\/|$)/i.test(res.url || '');
            lastError = failedGoogleRedirect
                ? `Falha HTTP ${res.status} em script.googleusercontent.com`
                : `Falha HTTP ${res.status}`;
            res = null;
        } catch (e) {
            lastError = e.name === 'AbortError'
                ? 'Tempo esgotado ao consultar o CSV do Drive'
                : e.message;
            res = null;
        } finally {
            clearTimeout(timeout);
        }
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, attempt * 1200));
    }
    if (!res) {
        return {
            checked: true,
            updated: false,
            error: `${lastError} após ${maxAttempts} tentativas. Use "Verificar agora" para repetir.`
        };
    }

    try {
        if (!data.ok) {
            return { checked: true, updated: false, error: data.error };
        }

        if (Number(data.apiVersion) < 12 || data.source !== 'drive-csv' ||
            typeof data.content !== 'string' || !data.content.trim()) {
            return { checked: true, updated: false, error: 'O GAS precisa da API 12 com o CSV de roteiros do Drive' };
        }

        const modifiedTime = Date.parse(data.modifiedTime);
        if (!Number.isFinite(modifiedTime)) {
            return { checked: true, updated: false, error: 'Data de modificação do CSV inválida' };
        }

        const lastSync = localStorage.getItem(LAST_CSV_DRIVE_SYNC_KEY);
        if (lastSync && modifiedTime <= Date.parse(lastSync)) {
            return { checked: true, updated: false };
        }

        const result = db.importRoteirosCsv(data.content);

        if (result.roteiros === 0 && result.clientes === 0) {
            return { checked: true, updated: false, warning: 'Nenhum roteiro/cliente retornado' };
        }

        localStorage.setItem(LAST_CSV_DRIVE_SYNC_KEY, data.modifiedTime);
        return { checked: true, updated: true, ...result };
    } catch (e) {
        return { checked: true, updated: false, error: e.message };
    }
}

export function getLastRoteirosDriveSyncLabel() {
    const lastSync = localStorage.getItem(LAST_CSV_DRIVE_SYNC_KEY);
    if (!lastSync) return 'Dados: nunca sincronizados do Drive';
    const date = new Date(lastSync);
    if (Number.isNaN(date.getTime())) return 'Dados: nunca sincronizados do Drive';
    const data = date.toLocaleDateString('pt-BR');
    const hora = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `Dados atualizados em ${data} às ${hora}`;
}

// GET com timeout e retry para os endpoints JSON do GAS. O redirecionamento
// de conteúdo do Google às vezes devolve 404 transitório (ou a conexão
// oscila); tentar de novo evita erros esporádicos como "Falha HTTP 404". Só
// repete em falha de HTTP/rede — uma resposta {ok:false} legítima é devolvida
// na hora. Timeout por tentativa cobre o fallback de varredura completa do GAS.
async function gasGetJsonWithRetry_(url, { attempts = 3, timeoutMs = 45000 } = {}) {
    let lastError = 'erro desconhecido';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (res.ok) return await res.json();
            lastError = `Falha HTTP ${res.status}`;
        } catch (e) {
            lastError = e.name === 'AbortError' ? 'tempo esgotado' : e.message;
        } finally {
            clearTimeout(timeout);
        }
        if (attempt < attempts) await new Promise(r => setTimeout(r, attempt * 1200));
    }
    return { ok: false, error: lastError };
}

export async function getUltimaColeta(roteiroNome) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    return gasGetJsonWithRetry_(
        `${url}?action=ultimaColeta&roteiro=${encodeURIComponent(roteiroNome)}`
    );
}

export async function getUltimasQuantidades(roteiroNome) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    return gasGetJsonWithRetry_(
        `${url}?action=ultimaColetaDetalhada&roteiro=${encodeURIComponent(roteiroNome)}`
    );
}

export async function getIntercorrenciasRoteiro(roteiroNome) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    return gasGetJsonWithRetry_(
        `${url}?action=intercorrenciasRoteiro&roteiro=${encodeURIComponent(roteiroNome)}`
    );
}

export async function getIntercorrenciasAtuais() {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    const result = await gasGetJsonWithRetry_(`${url}?action=intercorrenciasAtuais`);
    if (!result || typeof result !== 'object') {
        return { ok: false, error: 'Resposta vazia do GAS' };
    }
    if (result.ok !== true) {
        return { ...result, ok: false, error: result.error || 'Falha ao consultar as intercorrências atuais' };
    }
    const apiVersion = Number(result.apiVersion);
    if (!Number.isFinite(apiVersion) || apiVersion < 11 || result.source !== 'intercorrenciasAtuais') {
        return { ok: false, error: 'O GAS precisa da API 11 para consultar as intercorrências atuais' };
    }
    if (!Array.isArray(result.data)) {
        return { ok: false, error: 'Resposta inválida: data ausente' };
    }
    const invalid = result.data.some(item =>
        !item || !item.occurrenceId || !item.idRota || !item.data || !item.intercorrencia
    );
    if (invalid) {
        return { ok: false, error: 'Resposta inválida: ocorrência incompleta' };
    }
    return result;
}

export async function getAgendamentos(data = '') {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    const query = data
        ? `?action=agendamentos&data=${encodeURIComponent(data)}`
        : `?action=agendamentos`;
    return gasGetJsonWithRetry_(`${url}${query}`);
}

export async function getHistoricoColetas(mes = '') {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    const query = mes
        ? `?action=historicoColetas&mes=${encodeURIComponent(mes)}`
        : `?action=historicoColetas`;
    return gasGetJsonWithRetry_(`${url}${query}`);
}

export async function syncAgendamentos(ops) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    if (!Array.isArray(ops) || !ops.length) return { ok: true, upserts: 0, deletes: 0 };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'syncAgendamentos', ops })
        });
        if (!res.ok) {
            return { ok: false, error: `Falha HTTP ${res.status}` };
        }
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function uploadAgendamentoFotos(id, fotos, remover = []) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
                action: 'uploadAgendamentoFotos',
                id,
                fotos: fotos || [],
                remover: remover || []
            })
        });
        if (!res.ok) {
            return { ok: false, error: `Falha HTTP ${res.status}` };
        }
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function getAgendamentoFotos(id, incluirBase64 = false) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    const query = `?action=agendamentoFotos&id=${encodeURIComponent(id)}`
        + `&incluirBase64=${incluirBase64 ? 'true' : 'false'}`;
    return gasGetJsonWithRetry_(`${url}${query}`);
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
        if (!res.ok) {
            return { ok: false, error: `Falha HTTP ${res.status}` };
        }
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
        if (!res.ok) {
            return { ok: false, error: `Falha HTTP ${res.status}` };
        }
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

export async function pushClienteChanges(changes) {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    if (!changes.length) return { ok: true, count: 0, acceptedIds: [] };

    const token = getGasRouteToken();
    if (!token) {
        return { ok: false, error: 'Token de alterações não configurado' };
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'clientChanges', token, changes })
        });
        if (!res.ok) {
            return { ok: false, error: `Falha HTTP ${res.status}` };
        }
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function syncPendingClienteChanges(db) {
    let sentCount = 0;
    let acceptedCount = 0;
    let duplicateCount = 0;
    let invalidCount = 0;

    for (let batchNumber = 0; batchNumber < 50; batchNumber++) {
        const changes = db.getPendingClienteChanges(100);
        if (!changes.length) {
            return { ok: true, count: sentCount, acceptedCount, duplicateCount, invalidCount, pending: 0 };
        }

        const result = await pushClienteChanges(changes);
        if (!result.ok) {
            return { ...result, count: sentCount, pending: db.getPendingClienteChangesCount() };
        }

        const batchIds = new Set(changes.map(change => change.change_id));
        const acceptedIds = (result.acceptedIds || []).filter(id => batchIds.has(id));
        const duplicateIds = (result.duplicateIds || []).filter(id => batchIds.has(id));
        const invalidIds = (result.invalidIds || []).filter(id => batchIds.has(id));
        const confirmedIds = [...new Set([...acceptedIds, ...duplicateIds])];
        if (!confirmedIds.length && !invalidIds.length) {
            return {
                ok: false,
                error: 'O GAS não confirmou nenhuma alteração do lote enviado',
                count: sentCount,
                pending: db.getPendingClienteChangesCount()
            };
        }

        // Alteracoes invalidas (rejeitadas pela validacao do GAS) nunca vao
        // ter sucesso reenviando - marcadas como enviadas pra nao travar a
        // fila pra sempre, mas contadas a parte de aceitas/duplicadas.
        db.markClienteChangesSent([...new Set([...confirmedIds, ...invalidIds])]);
        sentCount += confirmedIds.length;
        acceptedCount += acceptedIds.length;
        duplicateCount += duplicateIds.length;
        invalidCount += invalidIds.length;
    }

    return {
        ok: false,
        error: 'A fila excedeu o limite de segurança por sincronização',
        count: sentCount,
        pending: db.getPendingClienteChangesCount()
    };
}
