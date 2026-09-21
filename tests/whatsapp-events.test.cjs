const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const listeners = {};
const calls = [];
const names = ['showWhatsappTab', 'refreshWhatsappQueue', 'toggleWhatsappOccurrence',
  'startWhatsappCampaign', 'selectWhatsappPhone', 'openCurrentWhatsapp',
  'confirmCurrentWhatsapp', 'deferCurrentWhatsapp', 'completeWhatsappCampaign',
  'exportWhatsappCampaign', 'applyWhatsappFilters'];
const window = Object.fromEntries(names.map(name => [name, (...args) => calls.push([name, ...args])]));
vm.runInNewContext(fs.readFileSync('whatsapp-events.js', 'utf8'), {
  window, document: { addEventListener: (type, listener) => { listeners[type] = listener; } }
});
function dispatch(type, dataset, extra = {}) {
  const control = { dataset, checked: true, ...extra };
  listeners[type]({ target: { ...control, closest: () => control } });
}
dispatch('click', { action: 'mostrar-aba', tab: 'queue' });
dispatch('click', { action: 'mostrar-aba', tab: 'history' });
dispatch('click', { action: 'atualizar-fila' });
dispatch('change', { changeAction: 'alternar-ocorrencia', occurrenceId: 'occ-1' });
dispatch('click', { action: 'iniciar-campanha' });
dispatch('click', { action: 'selecionar-telefone', slot: '2' });
dispatch('click', { action: 'abrir-whatsapp' });
dispatch('click', { action: 'confirmar-envio' });
dispatch('click', { action: 'adiar-envio' });
dispatch('click', { action: 'concluir-campanha' });
dispatch('click', { action: 'exportar-campanha', campaignId: 'campaign-1' });
dispatch('change', { changeAction: 'filtrar-fila' });
dispatch('input', {}, { id: 'queueSearch' });
dispatch('click', { action: 'abrir-whatsapp' }, { disabled: true });
assert.deepEqual(calls, [
  ['showWhatsappTab', 'queue'], ['showWhatsappTab', 'history'],
  ['refreshWhatsappQueue'], ['toggleWhatsappOccurrence', 'occ-1', true],
  ['startWhatsappCampaign'], ['selectWhatsappPhone', 2], ['openCurrentWhatsapp'],
  ['confirmCurrentWhatsapp'], ['deferCurrentWhatsapp'], ['completeWhatsappCampaign'],
  ['exportWhatsappCampaign', 'campaign-1'], ['applyWhatsappFilters'], ['applyWhatsappFilters']
]);
console.log('whatsapp-events: delegação da fila sem handlers inline: OK');
