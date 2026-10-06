import db, { newUuid } from './database.js';
import { getIntercorrenciasAtuais, checkAndImportRoteiros } from './google-sync.js';
import { buildWhatsappMessage, buildWhatsappQueue, summarizeWhatsappItems } from './whatsapp-campaign.js';

let activeCampaign = null;
let contactDirectory = [];
let occurrences = null;
let queue = [];
let refreshPromise = null;
let busy = false;
let ready = false;
let selectedPhoneSlot = null;
let displayedItemId = null;
const selectedOccurrences = new Set();
const statusLabels = { pending: 'Pendente', opened: 'Aguardando confirmação', confirmed: 'Confirmado', deferred: 'Adiado', blocked: 'Bloqueado' };
const element = id => document.getElementById(id);

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

function setError(id, message = '') {
    element(id).textContent = message;
    element(id).hidden = !message;
}

function civilDate(value) {
    return String(value || '').replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$3/$2/$1');
}

function currentItem() {
    return activeCampaign?.items.find(item => item.status === 'pending' || item.status === 'opened');
}

function reconcileQueue() {
    queue = buildWhatsappQueue({ occurrences: occurrences || [], contacts: contactDirectory,
        confirmedOccurrenceIds: db.getConfirmedWhatsappOccurrenceIds(), activeItems: activeCampaign?.items || [] });
    const selectable = new Set(queue.filter(item => !item.itemId && !item.blockedReason).map(item => item.occurrenceId));
    for (const id of selectedOccurrences) if (!selectable.has(id)) selectedOccurrences.delete(id);
    const route = element('queueRouteFilter').value;
    const routes = [...new Set(queue.map(item => item.roteiro).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    element('queueRouteFilter').innerHTML = '<option value="">Todos os roteiros</option>' + routes.map(name =>
        `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
    element('queueRouteFilter').value = routes.includes(route) ? route : '';
    renderQueue();
}

function renderQueue() {
    const counts = summarizeWhatsappItems(queue);
    const pending = counts.pending + counts.opened + counts.deferred + counts.blocked;
    for (const [id, count] of [['queuePendingCount', pending], ['queueOpenedCount', counts.opened], ['queueConfirmedCount', counts.confirmed]]) {
        element(id).textContent = occurrences === null && !activeCampaign ? '—' : String(count);
    }
    const search = element('queueSearch').value.trim().toLocaleLowerCase('pt-BR');
    const route = element('queueRouteFilter').value;
    const filtered = queue.filter(item => (!route || item.roteiro === route) &&
        `${item.cliente} ${item.intercorrencia} ${item.roteiro}`.toLocaleLowerCase('pt-BR').includes(search));
    element('queueList').innerHTML = filtered.map(item => {
        const status = item.blockedReason ? 'blocked' : item.status;
        const disabled = busy || !!activeCampaign || !!item.blockedReason || !!item.itemId;
        return `<article class="queue-row status-${escapeHtml(status)}"><label>
            <input type="checkbox" data-change-action="alternar-ocorrencia" data-occurrence-id="${escapeHtml(item.occurrenceId)}"
                ${selectedOccurrences.has(item.occurrenceId) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
            <span><strong>${escapeHtml(item.cliente)}</strong><br>
                <span class="queue-meta">${escapeHtml(item.roteiro)} · ${escapeHtml(civilDate(item.data))}</span></span>
            </label><p>${escapeHtml(item.intercorrencia)}</p>
            <p class="queue-meta">${escapeHtml(statusLabels[status] || status)}${item.blockedReason ? `: ${escapeHtml(item.blockedReason)}` : ''}</p></article>`;
    }).join('') || `<p class="hint">${occurrences === null ? 'Aguardando consulta à fonte. A campanha local continua disponível.' :
        queue.length ? 'Nenhum item corresponde aos filtros.' : 'Nenhuma pendência na fonte consultada.'}</p>`;
    element('queueSelection').textContent = activeCampaign ? 'Retome a campanha abaixo antes de iniciar outra.' :
        `${selectedOccurrences.size} ocorrência(s) selecionada(s) · ${counts.blocked} bloqueada(s)`;
    element('startCampaignButton').disabled = !ready || busy || !!refreshPromise || !!activeCampaign || !selectedOccurrences.size;
    element('campaignComposer').hidden = !!activeCampaign;
}

function renderActiveCampaign() {
    element('campaignPanel').hidden = !activeCampaign;
    if (!activeCampaign) return;
    const item = currentItem();
    const summary = summarizeWhatsappItems(activeCampaign.items);
    element('campaignProgress').textContent = `${summary.confirmed} confirmado(s), ${summary.deferred} adiado(s) de ${summary.total} ocorrência(s). Retomada salva neste dispositivo.`;
    element('campaignCurrent').hidden = !item;
    element('completeCampaignButton').hidden = !!item;
    element('completeCampaignButton').disabled = busy;
    if (!item) return;
    if (displayedItemId !== item.itemId) {
        displayedItemId = item.itemId;
        selectedPhoneSlot = item.phoneSlot || null;
    }
    element('campaignClient').textContent = item.cliente;
    element('campaignOccurrence').textContent = `${item.roteiro} · ${civilDate(item.coletaData)} · ${item.intercorrencia}`;
    element('campaignStatus').textContent = statusLabels[item.status];
    element('campaignStatus').className = `status-${item.status}`;
    element('campaignPreview').textContent = item.message;
    element('campaignPhones').innerHTML = item.phones.map(phone =>
        `<button class="btn btn-outline" data-action="selecionar-telefone" data-slot="${escapeHtml(phone.slot)}"
            aria-pressed="${phone.slot === selectedPhoneSlot}" ${busy || item.status === 'opened' ? 'disabled' : ''}>
            Telefone ${escapeHtml(phone.slot)}: ${escapeHtml(phone.exibicao || phone.digits)}</button>`).join('');
    element('openWhatsappButton').disabled = busy || item.status !== 'pending' || !selectedPhoneSlot;
    element('confirmWhatsappButton').disabled = busy || item.status !== 'opened';
    element('deferWhatsappButton').disabled = busy;
}

function renderHistory() {
    const history = db.getWhatsappCampaignHistory();
    element('campaignHistory').innerHTML = history.map(campaign => {
        const counts = summarizeWhatsappItems(campaign.items);
        return `<details><summary>${escapeHtml(campaign.createdAt)} · ${counts.total} ocorrência(s) · ${counts.confirmed} confirmado(s)</summary>
            <button class="btn btn-outline" data-action="exportar-campanha" data-campaign-id="${escapeHtml(campaign.campaignId)}">Exportar XLSX</button>
            ${campaign.items.map(item => `<article class="history-item status-${escapeHtml(item.status)}">
                <strong>${escapeHtml(item.cliente)}</strong>
                <p>${escapeHtml(item.roteiro)} · ${escapeHtml(civilDate(item.coletaData))} · ${escapeHtml(item.intercorrencia)}</p>
                <p>${escapeHtml(statusLabels[item.status])} · Telefone: ${escapeHtml(item.phone || 'Não aberto')}</p>
                <p class="queue-meta">Abertura: ${escapeHtml(item.openedAt || '—')} · Confirmação: ${escapeHtml(item.confirmedAt || '—')}</p>
                <pre>${escapeHtml(item.message)}</pre></article>`).join('')}</details>`;
    }).join('') || '<p class="hint">Nenhuma campanha concluída neste dispositivo.</p>';
}

export async function initWhatsappSender() {
    try {
        await db.init();
        activeCampaign = db.getActiveWhatsappCampaign();
        contactDirectory = db.getWhatsappContactDirectory();
        ready = true;
        renderActiveCampaign();
        renderHistory();
        reconcileQueue();
        await refreshWhatsappQueue();
    } catch (error) {
        setError('campaignError', `Não foi possível carregar os dados locais: ${error.message}`);
    }
}

export function refreshWhatsappQueue() {
    if (refreshPromise) return refreshPromise;
    if (!ready) return Promise.resolve();
    element('refreshQueueButton').disabled = true;
    refreshPromise = (async () => {
        try {
            const imported = await checkAndImportRoteiros(db);
            if (imported.error || imported.warning || !imported.checked) {
                throw new Error(imported.error || imported.warning || 'CSV do Drive não configurado');
            }
            const result = await getIntercorrenciasAtuais();
            if (!result?.ok || !Array.isArray(result.data)) throw new Error(result?.error || 'Resposta inválida da fonte');
            contactDirectory = db.getWhatsappContactDirectory();
            occurrences = result.data;
            reconcileQueue();
            setError('queueError');
            element('queueSource').textContent = `Fonte: intercorrências atuais · Atualizada em ${new Date().toLocaleString('pt-BR')}`;
        } catch (error) {
            setError('queueError', `Não foi possível atualizar a fila: ${error.message}`);
            element('queueSource').textContent = occurrences === null ?
                'Fonte indisponível. Exibindo apenas a campanha salva, quando houver.' :
                'Atualização indisponível. A última fila consultada e a campanha salva foram preservadas.';
        } finally {
            element('refreshQueueButton').disabled = false;
        }
    })().finally(() => { refreshPromise = null; renderQueue(); });
    renderQueue();
    return refreshPromise;
}

export function applyWhatsappFilters() { renderQueue(); }

export function toggleWhatsappOccurrence(id, checked) {
    if (busy || activeCampaign) return;
    const item = queue.find(entry => entry.occurrenceId === id);
    if (!item || item.blockedReason || item.itemId) return;
    if (checked) selectedOccurrences.add(id);
    else selectedOccurrences.delete(id);
    renderQueue();
}

export function selectWhatsappPhone(slot) {
    const item = currentItem();
    if (busy || !item || item.status !== 'pending' || !item.phones.some(phone => phone.slot === slot)) return;
    selectedPhoneSlot = slot;
    renderActiveCampaign();
}

function setBusy(value) {
    busy = value;
    renderActiveCampaign();
    renderQueue();
}

export async function startWhatsappCampaign() {
    if (!ready || busy || refreshPromise) return;
    setError('campaignError');
    try {
        activeCampaign = db.getActiveWhatsappCampaign();
        if (activeCampaign) {
            renderActiveCampaign();
            reconcileQueue();
            showWhatsappTab('queue');
            return;
        }
        const selected = queue.filter(item => selectedOccurrences.has(item.occurrenceId) && !item.blockedReason && !item.itemId);
        const messageTemplate = element('campaignMessage').value.trim();
        if (!selected.length || !messageTemplate) throw new Error('Selecione ocorrências e preencha a mensagem.');
        const campaign = {
            campaignId: newUuid(), messageTemplate, createdAt: new Date().toISOString(),
            items: selected.map(item => ({ ...item, itemId: newUuid(), coletaData: item.data,
                phones: item.phones.map(phone => ({ ...phone })),
                message: buildWhatsappMessage(messageTemplate, item) }))
        };
        setBusy(true);
        activeCampaign = await db.createWhatsappCampaign(campaign);
        selectedOccurrences.clear();
        reconcileQueue();
    } catch (error) {
        setError('campaignError', `Não foi possível iniciar a campanha: ${error.message}`);
    } finally {
        setBusy(false);
    }
}

function replaceSavedItem(saved) {
    activeCampaign.items = activeCampaign.items.map(item => item.itemId === saved.itemId ? saved : item);
    reconcileQueue();
}

export async function openCurrentWhatsapp() {
    const item = currentItem();
    if (busy || !item || item.status !== 'pending') return;
    const phone = item.phones.find(entry => entry.slot === selectedPhoneSlot);
    if (!phone) { setError('campaignError', 'Selecione um telefone antes de abrir o WhatsApp.'); return; }
    setError('campaignError');
    setBusy(true);
    let externalOpened = false;
    try {
        await window.openWhatsappUrl(`https://wa.me/${phone.digits}?text=${encodeURIComponent(item.message)}`);
        externalOpened = true;
        const saved = await db.transitionWhatsappCampaignItem(item.itemId, 'opened', {
            phoneSlot: phone.slot, phone: phone.digits, at: new Date().toISOString()
        });
        replaceSavedItem(saved);
    } catch (error) {
        setError('campaignError', externalOpened ?
            `Não foi possível registrar a abertura: ${error.message}. O item continua pendente; verifique o WhatsApp antes de tentar novamente.` :
            `Não foi possível abrir o WhatsApp: ${error.message}`);
    } finally {
        setBusy(false);
    }
}

async function transitionCurrent(status) {
    const item = currentItem();
    if (busy || !item || (status === 'confirmed' && item.status !== 'opened')) return;
    setError('campaignError');
    setBusy(true);
    try {
        const saved = await db.transitionWhatsappCampaignItem(item.itemId, status, { at: new Date().toISOString() });
        replaceSavedItem(saved);
    } catch (error) {
        setError('campaignError', `Não foi possível salvar a alteração: ${error.message}. O item foi mantido.`);
    } finally {
        setBusy(false);
    }
}

export function confirmCurrentWhatsapp() { return transitionCurrent('confirmed'); }
export function deferCurrentWhatsapp() { return transitionCurrent('deferred'); }

export async function completeWhatsappCampaign() {
    if (busy || !activeCampaign || activeCampaign.items.some(item => !['confirmed', 'deferred'].includes(item.status))) return;
    setError('campaignError');
    setBusy(true);
    try {
        await db.completeWhatsappCampaign(activeCampaign.campaignId, new Date().toISOString());
        activeCampaign = null;
        displayedItemId = null;
        selectedPhoneSlot = null;
        renderHistory();
        reconcileQueue();
    } catch (error) {
        setError('campaignError', `Não foi possível concluir a campanha: ${error.message}`);
    } finally {
        setBusy(false);
    }
}

export function showWhatsappTab(tab) {
    const history = tab === 'history';
    element('queueTab').hidden = history;
    element('historyTab').hidden = !history;
    element('queueTabButton').setAttribute('aria-selected', String(!history));
    element('historyTabButton').setAttribute('aria-selected', String(history));
}

export function exportWhatsappCampaign(campaignId) {
    try {
        const campaign = db.getWhatsappCampaignHistory().find(entry => entry.campaignId === campaignId);
        if (!campaign) throw new Error('Campanha não encontrada');
        const rows = campaign.items.map(item => ({
            Campanha: campaign.campaignId, 'Criada em': campaign.createdAt, 'Concluída em': campaign.completedAt,
            Ocorrência: item.occurrenceId, Cliente: item.cliente, Roteiro: item.roteiro,
            Data: item.coletaData, Intercorrência: item.intercorrencia, Status: statusLabels[item.status],
            Telefone: item.phone || '', Abertura: item.openedAt || '', Confirmação: item.confirmedAt || '', Mensagem: item.message
        }));
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Campanha');
        XLSX.writeFile(workbook, `campanha-whatsapp-${campaign.campaignId}.xlsx`);
    } catch (error) {
        showWhatsappTab('queue');
        setError('campaignError', `Não foi possível exportar: ${error.message}`);
    }
}

Object.assign(window, { initWhatsappSender, refreshWhatsappQueue, startWhatsappCampaign,
    openCurrentWhatsapp, confirmCurrentWhatsapp, deferCurrentWhatsapp, completeWhatsappCampaign,
    showWhatsappTab, exportWhatsappCampaign, applyWhatsappFilters, toggleWhatsappOccurrence, selectWhatsappPhone });

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWhatsappSender, { once: true });
else initWhatsappSender();
