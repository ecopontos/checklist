export const OPERATIONAL_TIME_ZONE = 'America/Sao_Paulo';

export function operationalToday(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: OPERATIONAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function validCivilDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function shiftMonth(month, offset) {
    const date = new Date(`${month}-01T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + offset);
    return date.toISOString().slice(0, 7);
}

function monthEnd(month) {
    const date = new Date(`${shiftMonth(month, 1)}-01T12:00:00Z`);
    date.setUTCDate(0);
    return date.toISOString().slice(0, 10);
}

function periodFor(month, today) {
    if (!validCivilDate(`${month}-01`) || month > today.slice(0, 7)) throw new Error('Selecione um mês válido até o mês atual');
    const partial = month === today.slice(0, 7);
    const previousMonth = shiftMonth(month, -1);
    const days = partial ? Math.min(Number(today.slice(-2)) - 1, Number(monthEnd(previousMonth).slice(-2))) : null;
    const day = String(days).padStart(2, '0');
    return {
        month, start: `${month}-01`, end: partial ? today : monthEnd(month), partial,
        comparison: days === 0 ? null : {
            current: { start: `${month}-01`, end: partial ? `${month}-${day}` : monthEnd(month) },
            previous: { start: `${previousMonth}-01`, end: partial ? `${previousMonth}-${day}` : monthEnd(previousMonth) }
        }
    };
}

const ISSUE_NAMES = [
    'Recipiente ausente', 'Recipiente em quantidade insuficiente', 'Recipiente quebrado',
    'Recipiente preso em corrente', 'Recipiente trancado no depósito',
    'Resíduo contaminado/misturado', 'Sacolas/Sacos presentes no recipiente', 'Outro'
];
const normalizedText = text => text.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
const issueCodes = new Map();
ISSUE_NAMES.forEach((name, index) => {
    for (const key of [String(index + 1), name, `${index + 1}. ${name}`]) issueCodes.set(normalizedText(key), name);
});

function issueTypes(value) {
    const raw = String(value ?? '').trim();
    if (!raw || normalizedText(raw) === 'nenhuma') return [];
    const known = issueCodes.get(normalizedText(raw));
    if (known) return [known];
    // Só interpretar listas se cada item for uma categoria conhecida.
    // Vírgulas em texto livre não são evidência de múltiplas ocorrências.
    const parts = raw.split(/[,;]/).map(p => issueCodes.get(normalizedText(p)));
    return parts.length > 1 && parts.every(Boolean) ? [...new Set(parts)] : [raw];
}

function summarize(rows) {
    const totals = { attendances: rows.length, collections: 0, containers: 0, issues: 0, issueRate: null };
    for (const row of rows) {
        if (row.quantidade > 0) totals.collections++;
        totals.containers += row.quantidade;
        if (row.issueTypes.length) totals.issues++;
    }
    if (totals.attendances) totals.issueRate = totals.issues / totals.attendances * 100;
    return totals;
}

const inRange = (rows, range) => rows.filter(c => c.data >= range.start && c.data <= range.end);

function reconcile(remote, local, remoteQuality, today) {
    const consolidated = Array.isArray(remote);
    const reported = remoteQuality && ['invalidDates', 'invalidQuantities', 'excludedRecords'].every(k =>
        Number.isInteger(remoteQuality[k]) && remoteQuality[k] >= 0);
    const quality = {
        invalidDates: reported ? remoteQuality.invalidDates : 0,
        invalidQuantities: reported ? remoteQuality.invalidQuantities : 0,
        excludedRecords: reported ? remoteQuality.excludedRecords : 0,
        futureDates: 0, duplicates: 0, missingIds: 0, unreported: consolidated && !reported
    };
    const seen = new Set(), rows = [];
    const candidates = consolidated ? [...remote, ...local.filter(c => !c.lastSync)] : local;
    for (const candidate of candidates) {
        const c = candidate || {};
        const id = String(c.syncId ?? '').trim();
        if (id && seen.has(id)) { quality.duplicates++; continue; }
        if (id) seen.add(id); else quality.missingIds++;
        const validDate = validCivilDate(c.data);
        const validQuantity = Number.isSafeInteger(c.quantidade) && c.quantidade >= 0;
        const future = validDate && c.data > today;
        if (!validDate) quality.invalidDates++;
        if (!validQuantity) quality.invalidQuantities++;
        if (future) quality.futureDates++;
        if (!validDate || !validQuantity || future) { quality.excludedRecords++; continue; }
        rows.push({ ...c, syncId: id, issueTypes: issueTypes(c.intercorrencia) });
    }
    return { rows, quality, source: consolidated ? 'consolidated' : 'local' };
}

export function buildDashboardMetrics({ remote = null, local = [], remoteQuality = null, now = new Date(), month } = {}) {
    const today = operationalToday(now);
    const period = periodFor(month || today.slice(0, 7), today);
    const { rows, quality, source } = reconcile(remote, local, remoteQuality, today);
    const selected = inRange(rows, period);
    const totals = summarize(selected);
    const comparison = { current: null, previous: null, collectionChange: null, issueRateChange: null, reason: null };
    if (period.comparison) {
        comparison.current = summarize(inRange(rows, period.comparison.current));
        comparison.previous = summarize(inRange(rows, period.comparison.previous));
    }
    if (source === 'local') comparison.reason = 'Comparação indisponível: visão local parcial';
    else if (quality.excludedRecords) comparison.reason = 'Comparação indisponível: dados com inconsistências';
    else if (quality.unreported) comparison.reason = 'Comparação indisponível: servidor sem informação de qualidade';
    else if (!period.comparison) comparison.reason = 'Sem dias encerrados para comparação';
    else if (!comparison.current.attendances || !comparison.previous.attendances) comparison.reason = 'Sem registros em um dos períodos de comparação';
    else {
        const { current, previous } = comparison;
        comparison.issueRateChange = current.issueRate - previous.issueRate;
        if (previous.collections) comparison.collectionChange = (current.collections - previous.collections) / previous.collections * 100;
        else comparison.reason = 'Sem base de comparação para coletas com retirada';
    }

    const months = Array.from({ length: 12 }, (_, i) => {
        const item = periodFor(shiftMonth(period.month, -i), today);
        const totals = summarize(inRange(rows, item));
        return { month: item.month, partial: item.partial, ...totals, hasRecords: totals.attendances > 0 };
    });
    const routeRows = new Map(), types = new Map();
    for (const row of selected) {
        const name = row.roteiro || 'Roteiro não identificado';
        if (!routeRows.has(name)) routeRows.set(name, []);
        routeRows.get(name).push(row);
        row.issueTypes.forEach(type => types.set(type, (types.get(type) || 0) + 1));
    }
    const routes = [...routeRows].map(([name, entries]) => {
        const totals = summarize(entries);
        return { name, ...totals, average: totals.collections ? totals.containers / totals.collections : null };
    }).sort((a, b) => b.containers - a.containers || a.name.localeCompare(b.name, 'pt-BR')).slice(0, 5);
    const issueMentions = [...types.values()].reduce((sum, value) => sum + value, 0);
    const issueTypeRows = [...types].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'));
    if (issueTypeRows.length > 8) {
        const rest = issueTypeRows.splice(7);
        issueTypeRows.push(['Outros tipos', rest.reduce((sum, [, count]) => sum + count, 0)]);
    }
    return {
        today, period, source, quality, totals, comparison, months, routes, issueMentions,
        issueTypes: issueTypeRows.map(([name, count]) => ({ name, count, share: count / issueMentions * 100 }))
    };
}

export function scheduleWindow(rows, now = new Date()) {
    const today = operationalToday(now);
    const end = new Date(`${today}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 7);
    const endDay = end.toISOString().slice(0, 10);
    const valid = rows.filter(a => validCivilDate(a?.dataPrevista));
    const upcoming = valid.filter(a => a.dataPrevista >= today && a.dataPrevista < endDay)
        .sort((a, b) => a.dataPrevista.localeCompare(b.dataPrevista));
    return { today, endDay, todayCount: upcoming.filter(a => a.dataPrevista === today).length, upcoming, invalidDates: rows.length - valid.length };
}
