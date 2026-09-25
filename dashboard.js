import db from './database.js';
import { buildDashboardMetrics, operationalToday, scheduleWindow } from './dashboard-metrics.js';
import { getLastRoteirosDriveSyncLabel, getGasStatus, getAgendamentos, getHistoricoColetas, syncPendingColetas, syncPendingRoteiroChanges, syncPendingClienteChanges, checkAndImportRoteiros } from './google-sync.js';

const MESES = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const LAST_HISTORY_PULL = 'app3_last_history_pull';
let consolidatedColetas = null;
let remoteQuality = null;
let selectedMonth = null;
let dashboardModel = null;
let refreshInFlight = null;
let toastTimer;
const el = id => document.getElementById(id);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sql(query, params = []) {
    const result = db.db.exec(query, params);
    return result.length ? result[0].values : [];
}

function localColetas() {
    return sql(`SELECT c.id, c.data, c.quantidade, c.intercorrencia, c.sync_id, c.last_sync,
        CASE WHEN c.context_source = 'event' THEN c.roteiro_snapshot
             ELSE COALESCE(NULLIF(c.roteiro_snapshot, ''), r.nome) END
        FROM coletas c LEFT JOIN clientes cl ON c.id_rota = cl.id_rota
        LEFT JOIN roteiros r ON cl.roteiro_id = r.id`).map(([id, data, quantidade, intercorrencia, syncId, lastSync, roteiro]) =>
        ({ id, data, quantidade, intercorrencia, syncId, lastSync, roteiro }));
}

function getMonthLabel(ym) {
    const [year, month] = ym.split('-');
    return `${MESES[Number(month) - 1]}/${year.slice(2)}`;
}
const dateLabel = iso => iso.split('-').reverse().join('/');
const rangeLabel = range => `${dateLabel(range.start)} a ${dateLabel(range.end)}`;
const decimal = value => value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const signed = value => `${value > 0 ? '+' : ''}${decimal(value)}`;

async function fetchConsolidatedColetas() {
    try {
        const result = await getHistoricoColetas();
        if (!result.ok || !Array.isArray(result.data)) throw new Error(result.error || 'Resposta de histórico incompatível; atualize o GAS');
        consolidatedColetas = result.data;
        remoteQuality = result.quality || null;
        localStorage.setItem(LAST_HISTORY_PULL, new Date().toISOString());
        return { ok: true };
    } catch (error) {
        consolidatedColetas = null;
        remoteQuality = null;
        return { ok: false, error: error.message };
    }
}

function renderKPIs(model) {
    const { totals, comparison, period } = model;
    el('kpiPoints').textContent = (sql('SELECT COUNT(*) FROM clientes WHERE ativo = 1')[0]?.[0] || 0).toLocaleString('pt-BR');
    el('kpiRoutes').textContent = sql(`SELECT COUNT(*) FROM roteiros r WHERE EXISTS
        (SELECT 1 FROM clientes cl WHERE cl.roteiro_id = r.id AND cl.ativo = 1)`)[0]?.[0] || 0;
    el('kpiPointsDelta').textContent = getLastRoteirosDriveSyncLabel();
    el('kpiAttendances').textContent = totals.attendances.toLocaleString('pt-BR');
    el('kpiCollects').textContent = totals.collections.toLocaleString('pt-BR');
    el('kpiContainers').textContent = totals.containers.toLocaleString('pt-BR');
    el('kpiIssues').textContent = totals.issues;
    el('kpiCollectsDelta').className = 'kpi-delta';
    el('kpiCollectsDelta').textContent = comparison.collectionChange === null
        ? comparison.reason : `${signed(comparison.collectionChange)}% nos períodos comparados`;
    el('kpiIssuesDelta').className = 'kpi-delta';
    el('kpiIssuesDelta').textContent = totals.attendances
        ? `${totals.issues} de ${totals.attendances} atendimentos — ${decimal(totals.issueRate)}%`
        : 'Sem atendimentos no período';
    el('kpiIssuesComparison').textContent = comparison.issueRateChange === null
        ? comparison.reason : `${signed(comparison.issueRateChange)} p.p. nos períodos comparados`;
    el('periodSummary').textContent = `Resultados: ${rangeLabel(period)} — ${period.partial ? 'mês em andamento; total parcial inclui hoje' : 'mês encerrado no calendário'}. Horário de São Paulo.`;
    el('comparisonRange').textContent = period.comparison
        ? `Comparação dos registros disponíveis: ${rangeLabel(period.comparison.current)} × ${rangeLabel(period.comparison.previous)}. ${period.partial ? 'Considera apenas dias encerrados e pode ter corte anterior ao total acima.' : 'Totais de meses completos, sem ajuste por dias úteis.'}`
        : 'Sem dias encerrados para comparação. O total acima inclui os registros de hoje.';
}

function renderBarChart(model) {
    const rows = model.months.slice(0, 6).reverse();
    const max = Math.max(...rows.map(v => v.containers), 1);
    el('barChart').innerHTML = rows.map(v => `
        <div class="bar-group" title="${v.hasRecords ? `${v.containers} recipientes` : 'Sem registros na base consultada'}">
        <div class="bar${v.partial ? ' partial' : ''}" style="height: ${(v.containers / max * 100).toFixed(1)}%">
        <div class="bar-value">${v.hasRecords ? v.containers.toLocaleString('pt-BR') : '—'}</div></div>
        <div class="bar-label">${getMonthLabel(v.month)}${v.partial ? '<br>Parcial' : ''}${!v.hasRecords ? '<br>Sem registros' : ''}</div></div>`).join('');
}

function renderTopRoutes(model) {
    el('topRoutes').innerHTML = model.routes.length ? model.routes.map((v, i) => `
        <tr><td>${i + 1}º</td><td>${escapeHtml(v.name)}</td>
        <td>${v.containers.toLocaleString('pt-BR')}</td><td>${v.collections}</td>
        <td>${v.average === null ? '—' : decimal(v.average)}</td></tr>`).join('')
        : '<tr><td colspan="5" class="empty-state">Sem registros no período selecionado.</td></tr>';
}

function renderIssues(model) {
    el('issueBreakdownNote').textContent = `Participação em ${model.issueMentions} ocorrência(s) identificada(s). Um atendimento pode ter mais de um tipo.`;
    el('issueList').innerHTML = model.issueTypes.length ? model.issueTypes.map(v => `
        <li class="issue-item"><span class="issue-name">${escapeHtml(v.name)}</span>
        <span class="issue-count">${v.count} — ${decimal(v.share)}%</span></li>`).join('')
        : '<li class="empty-state">Nenhuma intercorrência registrada no período.</li>';
}

function renderMonthlySummary(model) {
    el('monthlySummary').innerHTML = model.months.map(v => {
        const month = `${getMonthLabel(v.month)}${v.partial ? ' · Parcial' : ''}`;
        if (!v.hasRecords) return `<tr><td>${month}</td><td colspan="5" class="empty-state">Sem registros na base consultada</td></tr>`;
        return `<tr><td>${month}</td><td>${v.attendances}</td><td>${v.collections}</td>
            <td>${v.containers.toLocaleString('pt-BR')}</td><td>${v.issues}</td>
            <td>${decimal(v.issueRate)}%</td></tr>`;
    }).join('');
}

function renderQuality(model) {
    const { quality } = model;
    const messages = [];
    if (quality.excludedRecords) messages.push(`${quality.excludedRecords} registro(s) excluído(s) dos cálculos: ${quality.invalidDates} com data inválida, ${quality.invalidQuantities} com quantidade inválida e ${quality.futureDates} com data futura. Um registro pode ter mais de um problema.`);
    if (quality.unreported) messages.push('O servidor ainda não informa registros descartados. Atualize o GAS para habilitar comparações verificadas.');
    if (quality.missingIds) messages.push(`${quality.missingIds} registro(s) sem identificador estável; não foram unidos por semelhança.`);
    if (quality.duplicates) messages.push(`${quality.duplicates} repetição(ões) de identificador desconsiderada(s).`);
    el('qualitySummary').textContent = messages.join(' ');
    el('qualitySummary').style.color = quality.excludedRecords || quality.unreported ? 'var(--warning)' : 'var(--text-dim)';
}
function renderSyncStatus() {
    el('syncRede').textContent = getLastRoteirosDriveSyncLabel();
    const pending = db.getUnsyncedColetas().length;
    const changes = db.getPendingRoteiroChangesCount() + db.getPendingClienteChangesCount();
    for (const [id, count] of [['syncPendingColetas', pending], ['syncPendingChanges', changes]]) {
        el(id).textContent = count;
        el(id).style.color = count ? 'var(--warning)' : 'var(--success)';
    }
    const remote = consolidatedColetas !== null;
    el('dataSource').textContent = remote
        ? `Histórico consolidado consultado + pendências locais (${pending}). A base disponível não garante o envio de todos os dispositivos. Cadastros: situação atual do banco local.`
        : 'Dados locais: histórico consolidado indisponível ou ainda não consultado.';
    el('gasCollectsCount').textContent = remote ? `${consolidatedColetas.length} registro(s)` : 'Não consultado';
    el('gasCollectsCount').style.color = remote ? 'var(--success)' : 'var(--warning)';
    const last = localStorage.getItem(LAST_HISTORY_PULL);
    el('lastGasPull').textContent = last ? new Date(last).toLocaleString('pt-BR') : 'Nunca';
}

function renderAll() {
    const now = new Date();
    const currentMonth = operationalToday(now).slice(0, 7);
    el('dashboardMonth').max = currentMonth;
    dashboardModel = buildDashboardMetrics({ remote: consolidatedColetas, local: localColetas(), remoteQuality, now, month: selectedMonth });
    el('dashboardMonth').value = dashboardModel.period.month;
    renderKPIs(dashboardModel);
    renderBarChart(dashboardModel);
    renderTopRoutes(dashboardModel);
    renderIssues(dashboardModel);
    renderMonthlySummary(dashboardModel);
    renderQuality(dashboardModel);
    renderSyncStatus();
}

function showToast(message, detail = '', state = '') {
    clearTimeout(toastTimer);
    el('syncMsg').textContent = message;
    el('syncDetail').textContent = detail;
    el('syncSpinner').className = `spinner${state ? ' ' + state : ''}`;
    el('syncToast').classList.add('visible');
    if (state === 'done') toastTimer = setTimeout(() => el('syncToast').classList.remove('visible'), 2500);
}

async function fetchGasStatus() {
    try {
        const result = await getGasStatus();
        el('gasKpis').style.display = '';
        el('kpiGasStatus').textContent = result.ok ? 'Online' : 'Offline';
        el('kpiGasStatus').style.color = result.ok ? 'var(--success)' : 'var(--danger)';
        el('kpiGasVersion').textContent = result.ok ? `v${result.apiVersion}` : '--';
        el('gasConnection').textContent = result.ok ? 'Conectado' : result.error || 'Desconectado';
        el('gasConnection').style.color = result.ok ? 'var(--success)' : 'var(--danger)';
        return result;
    } catch (error) {
        el('kpiGasStatus').textContent = 'Erro';
        el('gasConnection').textContent = 'Desconectado';
        return { ok: false, error: error.message };
    }
}

async function fetchAgendamentos() {
    el('schedulesSection').style.display = '';
    try {
        // Uma única consulta mantém os contadores e a tabela no mesmo retrato.
        const result = await getAgendamentos();
        if (!result.ok || !Array.isArray(result.data)) throw new Error(result.error || 'Resposta de agendamentos inválida');
        const { todayCount, upcoming, invalidDates } = scheduleWindow(result.data, new Date());
        el('kpiSchedules').textContent = todayCount;
        el('kpiSchedulesWeek').textContent = upcoming.length;
        el('kpiSchedules').style.color = '';
        el('kpiSchedulesWeek').style.color = '';
        el('kpiSchedulesDelta').textContent = todayCount ? `${todayCount} encontrado(s) hoje` : 'Nenhum hoje';
        el('schedulesTable').innerHTML = upcoming.length ? upcoming.map(a => `
            <tr><td>${escapeHtml(a.dataPrevista)}</td><td>${escapeHtml(a.cliente)}</td>
            <td>${escapeHtml(a.endereco || '--')}</td><td>${escapeHtml(a.materiais || '--')}</td></tr>`).join('')
            : '<tr><td colspan="4" class="empty-state">Nenhum agendamento nos próximos 7 dias.</td></tr>';
        el('scheduleQuality').textContent = invalidDates ? `${invalidDates} agendamento(s) com data inválida não exibido(s).` : '';
        return invalidDates ? { ok: true, warning: el('scheduleQuality').textContent } : { ok: true };
    } catch (error) {
        for (const id of ['kpiSchedules', 'kpiSchedulesWeek']) {
            el(id).textContent = 'Erro';
            el(id).style.color = 'var(--danger)';
        }
        el('kpiSchedulesDelta').textContent = error.message;
        el('scheduleQuality').textContent = '';
        el('schedulesTable').innerHTML = `<tr><td colspan="4" class="empty-state">Erro ao buscar agendamentos: ${escapeHtml(error.message)}</td></tr>`;
        return { ok: false, error: error.message };
    }
}

async function updateDashboard() {
    el('loadingBar').classList.add('active');
    showToast('Atualizando dashboard...', 'Sincronizando dados');
    const errors = [];
    async function step(label, action) {
        try {
            const result = await action();
            if (result?.ok === false || result?.error || result?.warning || result?.invalidCount || result?.pending > 0) {
                errors.push(`${label}: ${result.error || result.warning || 'há alterações pendentes ou rejeitadas'}`);
            }
            return result;
        } catch (error) {
            errors.push(`${label}: ${error.message}`);
            return { ok: false, error: error.message };
        }
    }
    try {
        // Importar antes de enviar preserva a proteção das alterações pendentes
        // contra um CSV que ainda não recebeu a confirmação do Access.
        await step('Cadastros do Drive', () => checkAndImportRoteiros(db));
        await step('Roteiros', () => syncPendingRoteiroChanges(db));
        await step('Clientes', () => syncPendingClienteChanges(db));
        await step('Coletas', () => syncPendingColetas(db));
        await step('Histórico', fetchConsolidatedColetas);
        renderAll();
        if (dashboardModel.quality.excludedRecords || dashboardModel.quality.unreported) errors.push(el('qualitySummary').textContent);
        await step('Conexão GAS', fetchGasStatus);
        await step('Agendamentos', fetchAgendamentos);
    } catch (error) {
        errors.push(error.message);
    } finally {
        el('loadingBar').classList.remove('active');
    }
    const message = errors.length ? 'Atualização incompleta' : 'Dashboard atualizado';
    const detail = errors.length ? errors.join(' | ') : 'Dados consultados e filas processadas';
    el('refreshStatus').textContent = `${message}: ${detail}`;
    el('refreshStatus').style.color = errors.length ? 'var(--warning)' : 'var(--text-dim)';
    showToast(message, detail, errors.length ? 'error' : 'done');
}

function refreshDashboard() {
    if (!refreshInFlight) refreshInFlight = updateDashboard().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
}

async function init() {
    try {
        await db.init();
        renderAll();
        el('dashboardMonth').addEventListener('change', () => {
            const month = el('dashboardMonth').value;
            const current = operationalToday(new Date()).slice(0, 7);
            const previous = selectedMonth;
            selectedMonth = month && month !== current ? month : null;
            try { renderAll(); } catch (error) {
                selectedMonth = previous;
                renderAll();
                showToast('Período inválido', error.message, 'error');
            }
        });
        el('btnRefreshDashboard').addEventListener('click', refreshDashboard);
        window.addEventListener('online', refreshDashboard);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') refreshDashboard();
        });
        setInterval(() => {
            if (document.visibilityState === 'visible') refreshDashboard();
        }, 5 * 60 * 1000);
        await refreshDashboard();
    } catch (error) {
        el('loadingBar').classList.remove('active');
        el('refreshStatus').textContent = `Erro ao carregar dashboard: ${error.message}`;
        showToast('Erro ao carregar dashboard', error.message, 'error');
    }
}

init();
