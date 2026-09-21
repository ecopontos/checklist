function clonePhones(phones) {
    return Array.isArray(phones) ? phones.map(phone => ({ ...phone })) : [];
}

function formatCivilDate(date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

export function buildWhatsappMessage(template, occurrence) {
    const source = occurrence || {};
    const replacements = {
        nome: source.cliente || source.nome || 'estabelecimento',
        intercorrencia: source.intercorrencia || '',
        data: formatCivilDate(source.data || source.coletaData),
        residuo: source.residuo || source.tipoResiduo || ''
    };
    return String(template ?? '').replace(
        /\{(nome|intercorrencia|data|residuo)\}/gi,
        (_match, key) => replacements[key.toLowerCase()]
    );
}

export function buildWhatsappQueue({
    occurrences = [],
    contacts = [],
    confirmedOccurrenceIds = [],
    activeItems = []
} = {}) {
    const remoteById = new Map(occurrences.map(item => [item.occurrenceId, item]));
    const activeIds = new Set(activeItems.map(item => item.occurrenceId));
    const confirmedIds = new Set(confirmedOccurrenceIds);
    const contactsByRoute = new Map(contacts.map(contact => [String(contact.idRota), contact]));

    const active = activeItems.map(item => {
        const remote = remoteById.get(item.occurrenceId) || {};
        return {
            ...remote,
            ...item,
            data: item.coletaData || item.data || remote.data || '',
            phones: clonePhones(item.phones)
        };
    });

    const fresh = occurrences
        .filter(item => !activeIds.has(item.occurrenceId) && !confirmedIds.has(item.occurrenceId))
        .map(occurrence => {
            const contact = contactsByRoute.get(String(occurrence.idRota));
            const phones = clonePhones(contact && contact.phones);
            const item = { ...occurrence, status: 'pending', phones,
                residuo: occurrence.residuo || occurrence.tipoResiduo || contact?.tipoResiduo || '' };
            if (!contact) item.blockedReason = 'Cadastro não localizado';
            else if (!phones.length) item.blockedReason = 'Sem telefone válido';
            return item;
        })
        .sort((left, right) => {
            const byDate = String(right.data || '').localeCompare(String(left.data || ''));
            if (byDate) return byDate;
            const byRoute = String(left.roteiro || '').localeCompare(String(right.roteiro || ''), 'pt-BR', { sensitivity: 'base' });
            if (byRoute) return byRoute;
            return String(left.cliente || '').localeCompare(String(right.cliente || ''), 'pt-BR', { sensitivity: 'base' });
        });

    return [...active, ...fresh];
}

export function summarizeWhatsappItems(items) {
    return (Array.isArray(items) ? items : []).reduce((summary, item) => {
        summary.total += 1;
        if (item && item.blockedReason) summary.blocked += 1;
        else if (item && Object.prototype.hasOwnProperty.call(summary, item.status)) {
            summary[item.status] += 1;
        }
        return summary;
    }, { pending: 0, opened: 0, confirmed: 0, deferred: 0, blocked: 0, total: 0 });
}
