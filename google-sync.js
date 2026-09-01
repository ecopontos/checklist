/**
 * Client for the Google Apps Script (GAS) Web App bridge to
 * Google Sheets (push coletas) and Google Drive (pull rotas/pontos CSV).
 */
import { decodeLegacyCsvBytes } from './database.js';

const GAS_URL_KEY = 'app3_gas_url';
const LAST_DRIVE_SYNC_KEY = 'app3_last_drive_sync';
const GAS_ROUTE_TOKEN_KEY = 'app3_gas_route_token';
const LAST_ROTAS_REDE_SYNC_KEY = 'app3_last_rotas_rede_sync';
export const REQUIRED_GAS_API_VERSION = 4;

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

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ coletas })
        });
        if (!res.ok) {
            return { ok: false, error: `Falha HTTP ${res.status}` };
        }
        return await res.json();
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export async function checkAndImportRoteiros(db) {
    const url = getGasUrl();
    if (!url) return { checked: false, reason: 'no-url' };

    // A resposta de roteiros é grande e passa pela etapa de redirecionamento de
    // conteúdo do Google, que às vezes devolve um 404 transitório. Tenta algumas
    // vezes antes de desistir, para não confundir uma falha passageira com uma
    // implantação obsoleta.
    //
    // Compatibilidade durante a transição: o GAS novo devolve as linhas
    // achatadas em `data.rows` (fonte = abas do Sheets); o GAS antigo, ainda não
    // reimplantado, responde a esta mesma chamada com o CSV em `data.content`.
    // Aceitamos os dois para não quebrar apps em uso enquanto o GAS não sobe.
    let res = null;
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            res = await fetch(`${url}?action=roteiros`, { method: 'GET' });
            if (res.ok) break;
            lastError = `Falha HTTP ${res.status}`;
            res = null;
        } catch (e) {
            lastError = e.message;
            res = null;
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1200));
    }
    if (!res) {
        return { checked: true, updated: false, error: lastError };
    }

    try {
        const data = await res.json();

        if (!data.ok) {
            return { checked: true, updated: false, error: data.error };
        }

        const lastSync = localStorage.getItem(LAST_DRIVE_SYNC_KEY);
        if (lastSync && new Date(data.modifiedTime) <= new Date(lastSync)) {
            return { checked: true, updated: false };
        }

        const result = Array.isArray(data.rows)
            ? db.importRoteirosRows(data.rows)          // GAS novo: abas do Sheets
            : db.importRoteirosCsv(data.content || ''); // GAS antigo: CSV (fallback)

        if (result.roteiros === 0 && result.clientes === 0) {
            return { checked: true, updated: false, warning: 'Nenhum roteiro/cliente retornado' };
        }

        localStorage.setItem(LAST_DRIVE_SYNC_KEY, data.modifiedTime);
        return { checked: true, updated: true, ...result };
    } catch (e) {
        return { checked: true, updated: false, error: e.message };
    }
}

// Le o CSV completo de roteiros/clientes (cstExportaCheckList.csv) direto da
// pasta de rede fixa do Access, via comando Rust (so existe dentro do app
// empacotado com Tauri — no navegador comum, ou em testes sem
// window.__TAURI__, retorna checked:false). So reimporta quando o arquivo
// mudou (modified_time_ms), e ignora silenciosamente qualquer falha de
// acesso a rede: a proxima abertura do app tenta de novo. Substitui o pull
// de roteiros do Sheets (checkAndImportRoteiros, mantido no código mas sem
// chamador automático) como fonte de roteiro/cliente/ordem/ativo/logradouro/
// telefone/complemento — o Sheets continua recebendo só o push de
// alterações locais pendentes (syncPendingRoteiroChanges/
// syncPendingClienteChanges). Ver
// docs/superpowers/specs/2026-08-26-logradouros-rede-design.md.
export async function checkAndImportRoteirosRede(db) {
    const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
        return { checked: false, reason: 'not-tauri' };
    }

    let result;
    try {
        result = await tauri.core.invoke('read_network_logradouros_csv');
    } catch (e) {
        return { checked: true, updated: false, error: typeof e === 'string' ? e : e.message };
    }

    const lastSync = Number(localStorage.getItem(LAST_ROTAS_REDE_SYNC_KEY) || 0);
    if (lastSync >= result.modified_time_ms) {
        return { checked: true, updated: false };
    }

    const bytes = Uint8Array.from(atob(result.bytes_base64), c => c.charCodeAt(0));
    const text = decodeLegacyCsvBytes(bytes.buffer);
    const importResult = db.importRoteirosCsv(text);

    if (importResult.roteiros === 0 && importResult.clientes === 0) {
        return { checked: true, updated: false, warning: 'Nenhum roteiro/cliente retornado' };
    }

    localStorage.setItem(LAST_ROTAS_REDE_SYNC_KEY, String(result.modified_time_ms));
    return { checked: true, ...importResult, updated: true };
}

// String pronta pra exibir na UI (index.html, coleta-operation.js) com a
// data/hora de modificacao do CSV mais recente ja importado da pasta de
// rede — nao a hora em que o app checou, mas a hora em que o Access gerou
// o arquivo. So leitura de localStorage, nenhuma chamada de rede nova. Ver
// docs/superpowers/specs/2026-09-01-notificacao-sync-rede-design.md.
export function getLastRotasRedeSyncLabel() {
    const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
        return 'Sincronização automática só funciona no app instalado';
    }
    const ms = Number(localStorage.getItem(LAST_ROTAS_REDE_SYNC_KEY) || 0);
    if (!ms) {
        return 'Dados: nunca sincronizados automaticamente';
    }
    const date = new Date(ms);
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

export async function getAgendamentos(data = '') {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    const query = data
        ? `?action=agendamentos&data=${encodeURIComponent(data)}`
        : `?action=agendamentos`;
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
