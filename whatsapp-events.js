// O CSP do Tauri bloqueia atributos onclick/onchange. Os controles desta
// pagina declaram apenas data-action e chegam as funcoes pelo window quando
// o evento realmente acontece (depois que o modulo principal carregou).
async function openWhatsappUrl(url) {
    if (window.__TAURI_INTERNALS__) {
        await window.__TAURI_INTERNALS__.invoke('plugin:shell|open', { path: url });
    } else {
        const opened = window.open(url, '_blank');
        if (!opened) throw new Error('A abertura do WhatsApp foi bloqueada pelo navegador.');
        opened.opener = null;
    }
}
window.openWhatsappUrl = openWhatsappUrl;

document.addEventListener('click', event => {
    const control = event.target.closest('[data-action]');
    if (!control || control.disabled) return;

    switch (control.dataset.action) {
        case 'mostrar-aba': window.showWhatsappTab(control.dataset.tab); break;
        case 'atualizar-fila': window.refreshWhatsappQueue(); break;
        case 'iniciar-campanha': window.startWhatsappCampaign(); break;
        case 'selecionar-telefone': window.selectWhatsappPhone(Number(control.dataset.slot)); break;
        case 'abrir-whatsapp': window.openCurrentWhatsapp(); break;
        case 'confirmar-envio': window.confirmCurrentWhatsapp(); break;
        case 'adiar-envio': window.deferCurrentWhatsapp(); break;
        case 'concluir-campanha': window.completeWhatsappCampaign(); break;
        case 'exportar-campanha': window.exportWhatsappCampaign(control.dataset.campaignId); break;
    }
});

document.addEventListener('change', event => {
    const control = event.target.closest('[data-change-action]');
    if (!control || control.disabled) return;

    switch (control.dataset.changeAction) {
        case 'filtrar-fila': window.applyWhatsappFilters(); break;
        case 'alternar-ocorrencia':
            window.toggleWhatsappOccurrence(control.dataset.occurrenceId, control.checked);
            break;
    }
});

document.addEventListener('input', event => {
    if (event.target.id === 'queueSearch') window.applyWhatsappFilters();
});
