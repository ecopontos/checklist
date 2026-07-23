import db from './database.js';
import { pushColetas, sendChecklistToDrive } from './google-sync.js';

let currentClients = [];
let sessionData = {};
let currentSort = 'ordem';
let currentFilter = 'all';
let activeClientId = null;
let previousRouteId = '';
let operationSaved = false;
let syncState = 'idle';

async function init() {
    await db.init();

    const routeSelect = document.getElementById('routeSelect');
    const idSearch = document.getElementById('idSearch');
    const quickQty = document.getElementById('quickQty');
    const quickIssue = document.getElementById('quickIssue');
    const navToggle = document.getElementById('navToggle');
    const hamburger = document.querySelector('.hamburger-icon');

    document.getElementById('opDate').valueAsDate = new Date();
    db.getRoteiros().forEach(route => {
        const option = document.createElement('option');
        option.value = route.id;
        option.textContent = route.nome;
        routeSelect.appendChild(option);
    });

    routeSelect.addEventListener('change', () => {
        const nextRouteId = routeSelect.value;
        if (hasUnsavedEntries() && !confirm('Existem registros não salvos. Deseja trocar de roteiro e descartá-los?')) {
            routeSelect.value = previousRouteId;
            return;
        }
        loadRoute(nextRouteId);
    });
    document.getElementById('sortSelect').addEventListener('change', event => {
        currentSort = event.target.value;
        renderList();
    });
    document.getElementById('btnSave').addEventListener('click', saveOperation);
    document.getElementById('btnRegister').addEventListener('click', commitQuickEntry);
    document.getElementById('btnChecklist').addEventListener('click', openChecklistModal);
    document.getElementById('btnChecklistCancel').addEventListener('click', closeChecklistModal);
    document.getElementById('btnChecklistDownload').addEventListener('click', downloadChecklist);
    document.getElementById('btnChecklistSend').addEventListener('click', sendChecklistToDriveHandler);

    idSearch.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            selectClientById(idSearch.value);
        }
    });
    idSearch.addEventListener('input', clearEntryError);
    quickQty.addEventListener('keydown', event => handleEntryKey(event));
    quickIssue.addEventListener('keydown', event => handleEntryKey(event));

    hamburger.setAttribute('aria-expanded', 'false');
    hamburger.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            navToggle.checked = !navToggle.checked;
            hamburger.setAttribute('aria-expanded', String(navToggle.checked));
        }
    });
    navToggle.addEventListener('change', () => hamburger.setAttribute('aria-expanded', String(navToggle.checked)));

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        if (document.getElementById('checklistModal').classList.contains('open')) {
            closeChecklistModal();
        } else if (activeClientId !== null) {
            resetQuickEntry(true);
        } else {
            navToggle.checked = false;
            hamburger.setAttribute('aria-expanded', 'false');
        }
    });
    document.getElementById('checklistModal').addEventListener('click', event => {
        if (event.target.id === 'checklistModal') closeChecklistModal();
    });
    window.addEventListener('beforeunload', event => {
        if (!hasUnsavedEntries()) return;
        event.preventDefault();
        event.returnValue = '';
    });

    updateStats();
    updateSaveState();
}

function handleEntryKey(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        commitQuickEntry();
    }
}

function loadRoute(routeId) {
    previousRouteId = routeId;
    currentClients = routeId ? db.getClientesByRoteiro(routeId) : [];
    sessionData = {};
    activeClientId = null;
    currentSort = 'ordem';
    currentFilter = 'all';
    operationSaved = false;
    syncState = 'idle';

    document.getElementById('sortSelect').value = 'ordem';
    document.getElementById('entryPanel').hidden = !routeId || currentClients.length === 0;
    document.getElementById('opDate').disabled = false;
    resetQuickEntry(false);

    if (!routeId) {
        renderEmpty('Nenhum roteiro selecionado', 'Escolha um roteiro para iniciar a operação.');
    } else if (currentClients.length === 0) {
        renderEmpty('Roteiro sem pontos cadastrados', 'Cadastre pontos em Gestão de Roteiros antes de iniciar.');
    } else {
        renderList();
        requestAnimationFrame(() => document.getElementById('idSearch').focus());
    }
    updateStats();
    updateSaveState();
}

function normalizeId(value) {
    return String(value ?? '').trim().toLocaleLowerCase('pt-BR');
}

function clientKey(client) {
    return String(client.id_rota);
}

function selectClientById(rawId) {
    const normalizedId = normalizeId(rawId);
    if (!normalizedId) {
        showEntryError('Digite um ID para localizar o ponto.');
        return;
    }

    const client = currentClients.find(item => normalizeId(item.id_rota) === normalizedId);
    if (!client) {
        showEntryError(`ID ${String(rawId).trim()} não encontrado neste roteiro.`);
        document.getElementById('idSearch').select();
        return;
    }

    activeClientId = clientKey(client);
    const session = sessionData[activeClientId] || {};
    const entryClient = document.getElementById('entryClient');
    entryClient.querySelector('strong').textContent = client.cliente;
    entryClient.querySelector('span').textContent = formatAddress(client);
    entryClient.classList.add('selected');

    document.getElementById('quickQty').disabled = false;
    document.getElementById('quickIssue').disabled = false;
    document.getElementById('btnRegister').disabled = false;
    document.getElementById('quickQty').value = session.qty > 0 ? session.qty : '';
    document.getElementById('quickIssue').value = session.issue || '';
    clearEntryError();
    renderList();

    requestAnimationFrame(() => {
        const row = [...document.querySelectorAll('tr[data-id]')].find(item => item.dataset.id === activeClientId);
        if (row) row.scrollIntoView({ block: 'nearest' });
        const qtyInput = document.getElementById('quickQty');
        qtyInput.focus();
        qtyInput.select();
    });
}

function commitQuickEntry() {
    if (activeClientId === null || operationSaved) return;

    const quantityValue = document.getElementById('quickQty').value;
    const quantity = quantityValue === '' ? 0 : Number.parseInt(quantityValue, 10);
    const issue = document.getElementById('quickIssue').value.trim();
    if (!Number.isFinite(quantity) || quantity < 0) {
        showEntryError('Informe uma quantidade válida.');
        document.getElementById('quickQty').focus();
        return;
    }

    setSessionEntry(activeClientId, quantity, issue);
    resetQuickEntry(true);
}

function setSessionEntry(id, quantity, issue) {
    if (quantity > 0 || issue) {
        sessionData[id] = { qty: quantity, issue };
    } else {
        delete sessionData[id];
    }
    syncState = 'idle';
    renderList();
    updateStats();
    updateSaveState();
}

function resetQuickEntry(focusSearch) {
    activeClientId = null;
    const idSearch = document.getElementById('idSearch');
    const quickQty = document.getElementById('quickQty');
    const quickIssue = document.getElementById('quickIssue');
    const entryClient = document.getElementById('entryClient');

    idSearch.value = '';
    quickQty.value = '';
    quickIssue.value = '';
    quickQty.disabled = true;
    quickIssue.disabled = true;
    document.getElementById('btnRegister').disabled = true;
    entryClient.querySelector('strong').textContent = 'Nenhum ponto selecionado';
    entryClient.querySelector('span').textContent = 'Digite um ID para localizar o ponto';
    entryClient.classList.remove('selected');
    clearEntryError();
    if (currentClients.length > 0) renderList();

    if (focusSearch && !operationSaved && !document.getElementById('entryPanel').hidden) {
        requestAnimationFrame(() => idSearch.focus());
    }
}

function renderEmpty(title, message) {
    document.getElementById('listContainer').innerHTML = `
        <div class="empty-state">
            <h2>${escapeHTML(title)}</h2>
            <p>${escapeHTML(message)}</p>
        </div>
    `;
}

function numericOrder(value) {
    const normalized = String(value ?? '').trim().replace(',', '.');
    const order = Number(normalized);
    return Number.isFinite(order) ? order : Number.MAX_SAFE_INTEGER;
}

function compareOrder(a, b) {
    return numericOrder(a.ordem) - numericOrder(b.ordem)
        || String(a.ordem ?? '').localeCompare(String(b.ordem ?? ''), 'pt-BR', { numeric: true })
        || clientKey(a).localeCompare(clientKey(b), 'pt-BR', { numeric: true });
}

function sortClients(list) {
    const sorted = [...list];
    if (currentSort === 'alfabetica') {
        sorted.sort((a, b) => String(a.cliente).localeCompare(String(b.cliente), 'pt-BR'));
    } else if (currentSort === 'quantidade') {
        sorted.sort((a, b) => {
            const qtyA = (sessionData[clientKey(a)] || {}).qty || 0;
            const qtyB = (sessionData[clientKey(b)] || {}).qty || 0;
            return qtyB - qtyA || compareOrder(a, b);
        });
    } else {
        sorted.sort(compareOrder);
    }
    return sorted;
}

function filterClients(list) {
    return list.filter(client => {
        const session = sessionData[clientKey(client)] || {};
        const done = session.qty > 0;
        const hasIssue = Boolean(session.issue && session.issue.trim());
        if (currentFilter === 'pending') return !done;
        if (currentFilter === 'done') return done;
        if (currentFilter === 'issues') return hasIssue;
        return true;
    });
}

function renderList() {
    if (currentClients.length === 0) return;

    const clientsToShow = filterClients(sortClients(currentClients));
    const container = document.getElementById('listContainer');
    const rows = clientsToShow.map((client, index) => {
        const id = clientKey(client);
        const session = sessionData[id] || {};
        const done = session.qty > 0;
        const hasIssue = Boolean(session.issue && session.issue.trim());
        const statusClass = hasIssue ? 'issue' : done ? 'done' : '';
        const statusLabel = hasIssue ? 'Intercorrência' : done ? 'Coletado' : 'Pendente';
        const disabled = operationSaved ? 'disabled' : '';
        return `
            <tr data-id="${escapeHTML(id)}" class="${done ? 'done' : ''} ${activeClientId === id ? 'selected' : ''}">
                <td class="mono">${escapeHTML(client.ordem || index + 1)}</td>
                <td class="mono">${escapeHTML(id)}</td>
                <td><span class="client-name" title="${escapeHTML(client.cliente)}">${escapeHTML(client.cliente)}</span></td>
                <td><span class="address" title="${escapeHTML(formatAddress(client))}">${escapeHTML(formatAddress(client))}</span></td>
                <td><input type="number" min="0" class="table-input table-qty" data-role="qty" value="${session.qty > 0 ? session.qty : ''}" ${disabled}></td>
                <td><input type="text" class="table-input" data-role="issue" value="${escapeHTML(session.issue || '')}" placeholder="Sem intercorrência" ${disabled}></td>
                <td><span class="status-badge ${statusClass}"><span class="status-dot"></span>${statusLabel}</span></td>
            </tr>
        `;
    }).join('');
    const tableRows = rows || `
        <tr class="filter-empty-row">
            <td colspan="7">
                <div class="filter-empty" role="status">
                    <strong>Nenhum ponto neste filtro</strong>
                    <span>Selecione outro filtro para continuar.</span>
                </div>
            </td>
        </tr>
    `;

    container.innerHTML = `
        <div class="table-toolbar">
            <h2>Pontos do roteiro</h2>
            <div class="filter-group" aria-label="Filtrar pontos">
                <button type="button" class="filter-btn ${currentFilter === 'all' ? 'active' : ''}" data-filter="all">Todos</button>
                <button type="button" class="filter-btn ${currentFilter === 'pending' ? 'active' : ''}" data-filter="pending">Pendentes</button>
                <button type="button" class="filter-btn ${currentFilter === 'done' ? 'active' : ''}" data-filter="done">Coletados</button>
                <button type="button" class="filter-btn ${currentFilter === 'issues' ? 'active' : ''}" data-filter="issues">Intercorrências</button>
            </div>
        </div>
        <div class="table-container">
            <table>
                <thead><tr>
                    <th class="col-order">Ordem</th>
                    <th class="col-id">ID</th>
                    <th class="col-client">Cliente</th>
                    <th class="col-address">Endereço</th>
                    <th class="col-qty">Qtd.</th>
                    <th class="col-issue">Intercorrência</th>
                    <th class="col-status">Status</th>
                </tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>
    `;

    bindTableEvents();
}

function bindTableEvents() {
    document.querySelectorAll('.filter-btn').forEach(button => {
        button.addEventListener('click', () => {
            currentFilter = button.dataset.filter;
            renderList();
        });
    });

    document.querySelectorAll('tbody tr[data-id]').forEach(row => {
        const id = row.dataset.id;
        const qtyInput = row.querySelector('[data-role="qty"]');
        const issueInput = row.querySelector('[data-role="issue"]');

        row.addEventListener('click', event => {
            if (event.target.matches('input') || operationSaved) return;
            selectClientById(id);
        });

        const updateFromRow = () => {
            const quantity = Number.parseInt(qtyInput.value, 10) || 0;
            setSessionEntry(id, quantity, issueInput.value.trim());
        };
        qtyInput.addEventListener('change', updateFromRow);
        issueInput.addEventListener('change', updateFromRow);
        [qtyInput, issueInput].forEach(input => {
            input.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                updateFromRow();
                requestAnimationFrame(() => document.getElementById('idSearch').focus());
            });
        });
    });
}

function updateStats() {
    const total = currentClients.length;
    let done = 0;
    let totalQty = 0;
    let issues = 0;

    Object.values(sessionData).forEach(entry => {
        if (entry.qty > 0) done++;
        totalQty += entry.qty || 0;
        if (entry.issue && entry.issue.trim()) issues++;
    });

    document.getElementById('s-total').textContent = total;
    document.getElementById('s-done').textContent = done;
    document.getElementById('s-qty').textContent = totalQty;
    document.getElementById('s-issues').textContent = issues;
    document.getElementById('s-pending').textContent = Math.max(total - done, 0);
    document.getElementById('progressFill').style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
}

function getEntries() {
    return Object.entries(sessionData).filter(([, entry]) => entry.qty > 0 || (entry.issue && entry.issue.trim()));
}

function hasUnsavedEntries() {
    return !operationSaved && getEntries().length > 0;
}

function updateSaveState() {
    const entries = getEntries();
    const button = document.getElementById('btnSave');
    const label = document.getElementById('btnSaveLabel');
    const summary = document.getElementById('saveSummary');
    const indicator = document.getElementById('syncIndicator');
    const countLabel = entries.length === 1 ? '1 registro' : `${entries.length} registros`;

    indicator.className = `sync-indicator ${syncState}`;
    if (operationSaved) {
        button.disabled = true;
        label.textContent = 'Operação salva';
        const stateText = syncState === 'saved' ? 'sincronizado' : syncState === 'error' ? 'sincronização pendente' : 'sincronizando';
        summary.innerHTML = `<strong>${countLabel}</strong> salvos · ${stateText}`;
    } else {
        button.disabled = entries.length === 0;
        label.textContent = entries.length ? `Salvar operação · ${entries.length}` : 'Salvar operação';
        summary.innerHTML = `<strong>${countLabel}</strong> prontos para salvar`;
    }
}

async function saveOperation() {
    const date = document.getElementById('opDate').value;
    const entries = getEntries();
    if (!date) {
        alert('Selecione a data da operação.');
        return;
    }
    if (entries.length === 0 || operationSaved) return;

    const routeSelect = document.getElementById('routeSelect');
    const roteiroNome = routeSelect.options[routeSelect.selectedIndex]?.textContent || '';

    try {
        const savedColetas = entries.map(([id, entry]) => {
            const client = currentClients.find(item => clientKey(item) === id);
            const localId = db.addColeta({
                id_rota: id,
                data: date,
                quantidade: entry.qty,
                intercorrencia: entry.issue || ''
            });
            return {
                id: localId,
                id_rota: id,
                data: date,
                quantidade: entry.qty,
                intercorrencia: entry.issue || '',
                cliente: client ? client.cliente : '',
                roteiro: roteiroNome,
                sync_id: crypto.randomUUID()
            };
        });

        operationSaved = true;
        syncState = 'pending';
        document.getElementById('opDate').disabled = true;
        resetQuickEntry(false);
        renderList();
        updateSaveState();
        showToast('Operação salva localmente.');
        syncColetasToSheet(savedColetas);
    } catch (error) {
        syncState = 'error';
        updateSaveState();
        alert(`Não foi possível salvar a operação: ${error.message}`);
    }
}

async function syncColetasToSheet(coletas) {
    const result = await pushColetas(coletas);
    if (result.ok) {
        coletas.forEach(coleta => db.markColetaSynced(coleta.id, coleta.sync_id));
        syncState = 'saved';
        showToast('Operação salva e sincronizada.');
    } else {
        syncState = 'error';
        showToast('Salvo localmente. Sincronização pendente.');
    }
    updateSaveState();
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message || 'Operação salva com sucesso!';
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

function showEntryError(message) {
    const search = document.getElementById('idSearch');
    document.getElementById('entryError').textContent = message;
    search.setAttribute('aria-invalid', 'true');
}

function clearEntryError() {
    document.getElementById('entryError').textContent = '';
    document.getElementById('idSearch').removeAttribute('aria-invalid');
}

function formatAddress(client) {
    return [client.logradouro, client.numero].filter(Boolean).join(', ') || 'Endereço não informado';
}

function escapeHTML(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function openChecklistModal() {
    if (!document.getElementById('routeSelect').value) {
        alert('Selecione um roteiro primeiro.');
        return;
    }
    document.getElementById('proxData').value = '';
    document.getElementById('checklistModal').classList.add('open');
    requestAnimationFrame(() => document.getElementById('proxData').focus());
}

function closeChecklistModal() {
    document.getElementById('checklistModal').classList.remove('open');
    document.getElementById('btnChecklist').focus();
}

function formatDateBR(dateStr) {
    if (!dateStr) return '____/____/________';
    const parts = dateStr.split('-');
    return parts.length === 3 ? `${parts[2]}/${parts[1]}/${parts[0]}` : dateStr;
}

function buildChecklistDoc() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const routeSelect = document.getElementById('routeSelect');
    const roteiroNome = routeSelect.options[routeSelect.selectedIndex]?.textContent || '';
    const dataColeta = document.getElementById('opDate').value;
    const proxData = document.getElementById('proxData').value;
    const tipoResiduo = document.getElementById('tipoResiduo').value;
    const motorista = document.getElementById('checklistMotorista').value.trim();
    const veiculo = document.getElementById('checklistVeiculo').value.trim();

    let totalPrevisto = 0;
    const rows = currentClients.map((client, index) => {
        const session = sessionData[clientKey(client)] || {};
        const quantity = session.qty > 0 ? session.qty : '';
        if (session.qty > 0) totalPrevisto += session.qty;
        return [
            client.ordem || index + 1,
            client.cliente,
            client.logradouro || '',
            client.numero || '',
            client.cep || '',
            client.id_rota,
            quantity,
            '',
            session.issue || ''
        ];
    });

    doc.setFontSize(16);
    doc.text(`Checklist Coleta ${roteiroNome}`, 14, 15);
    doc.setFontSize(9);
    doc.text(`Coleta Anterior: ${formatDateBR(dataColeta)}   Data da Coleta: ${formatDateBR(proxData)}`, 14, 22);
    doc.text(`Tipo de Residuo: ${tipoResiduo}   Total de Pontos: ${currentClients.length}   Recipientes Previstos: ${totalPrevisto}`, 14, 27);
    if (motorista) doc.text(`Motorista: ${motorista}`, 14, 32);
    if (veiculo) doc.text(`Veiculo: ${veiculo}`, 100, 32);

    doc.autoTable({
        startY: 36,
        head: [['Ord.', 'Cliente', 'Logradouro', 'No', 'CEP', 'ID', 'Qtd. Ant.', 'Qtd. Coletada', 'Cód. Problema']],
        body: rows,
        styles: { fontSize: 8 },
        headStyles: { fillColor: [26, 58, 92] }
    });

    const legendStartY = doc.lastAutoTable.finalY + 12;
    doc.setFontSize(9);
    doc.text('Códigos de Intercorrência:', 14, legendStartY);
    doc.setFontSize(8);
    [
        '1. Recipiente ausente',
        '2. Recipiente em quantidade insuficiente',
        '3. Recipiente quebrado',
        '4. Recipiente preso em corrente',
        '5. Recipiente trancado no depósito',
        '6. Resíduo contaminado/misturado',
        '7. Sacolas/Sacos presentes no recipiente',
        '8. Outro'
    ].forEach((item, index) => {
        const column = index < 4 ? 0 : 1;
        const row = index % 4;
        doc.text(item, 14 + column * 140, legendStartY + 6 + row * 5);
    });

    const finalY = legendStartY + 41;
    doc.setFontSize(9);
    doc.text('_______________________', 30, finalY);
    doc.text('Motorista', 55, finalY + 5);
    doc.text('_______________________', 180, finalY);
    doc.text('Supervisor', 205, finalY + 5);

    return {
        doc,
        filename: `Checklist_${roteiroNome}_${proxData || 'sem-data'}.pdf`
    };
}

function downloadChecklist() {
    const { doc, filename } = buildChecklistDoc();
    doc.save(filename);
}

async function sendChecklistToDriveHandler() {
    if (!document.getElementById('proxData').value) {
        alert('Preencha a data da próxima coleta para enviar ao Drive.');
        return;
    }

    const { doc, filename } = buildChecklistDoc();
    const pdfBase64 = doc.output('datauristring').split(',')[1];
    const result = await sendChecklistToDrive(filename, pdfBase64);
    if (result.ok) {
        alert('Checklist enviado para o Drive com sucesso!');
        closeChecklistModal();
    } else {
        alert(`Falha ao enviar: ${result.error || 'erro desconhecido'}`);
    }
}

init();
