const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync('whatsapp-sender.html', 'utf8');
const phones = [
  { slot: 1, exibicao: '(48) 99999-0000', digits: '5548999990000' },
  { slot: 2, exibicao: '(48) 98888-0000', digits: '5548988880000' }
];
const occurrence = { occurrenceId: 'occ-1', idRota: '42', cliente: 'Cliente original',
  roteiro: 'SAT01', data: '2026-09-18', intercorrencia: 'Bombona suja' };
function campaign() {
  return { campaignId: 'campaign-1', messageTemplate: 'Olá {nome}', createdAt: '2026-09-18T12:00:00Z',
    items: [1, 2].map(n => ({ ...occurrence, occurrenceId: `occ-${n}`, itemId: `item-${n}`,
      coletaData: occurrence.data, message: `Mensagem congelada ${n}`, phones })) };
}
async function setup({ active = false, remote = { ok: true, data: [occurrence] },
  storage = new Map(), contactDirectory = null, networkReader = null } = {}) {
  assert.ok(fs.existsSync('whatsapp-sender.js'), 'o módulo externo da fila deve existir');
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    id, textContent: '', innerHTML: '', value: '', hidden: false, disabled: false,
    classList: { toggle() {} }, setAttribute() {}, focus() {}
  }]));
  const document = { readyState: 'loading', getElementById: id => elements.get(id),
    addEventListener() {}, querySelectorAll: () => [] };
  let failPersistence = false;
  let remoteCalls = 0;
  let importCalls = 0;
  const exported = [];
  const opened = [];
  const window = {
    openWhatsappUrl: async url => { opened.push(url); } };
  if (networkReader) window.__TAURI__ = { core: { invoke: async command => {
    assert.equal(command, 'read_network_logradouros_csv');
    importCalls++;
    return networkReader();
  } } };
  const context = vm.createContext({ console, window, document,
    Uint8Array, TextEncoder, TextDecoder, atob, AbortController, setTimeout, clearTimeout,
    crypto: require('node:crypto').webcrypto,
    localStorage: { getItem: key => storage.get(key) ?? null, removeItem: key => storage.delete(key),
      setItem(key, value) { if (failPersistence) throw new Error('QuotaExceeded'); storage.set(key, value); } },
    initSqlJs: () => require('../vendor/sql-wasm.js')({ locateFile: file => path.resolve('vendor', file) }),
    XLSX: { utils: { json_to_sheet: rows => rows, book_new: () => ({}),
      book_append_sheet: (_, rows) => exported.push(...rows) }, writeFile() {} },
    fetch: async url => {
      assert.match(url, /\?action=intercorrenciasAtuais$/);
      remoteCalls++;
      const reply = await (typeof remote === 'function' ? remote() : remote);
      return { ok: true, json: async () => ({ apiVersion: 11, source: 'intercorrenciasAtuais', ...reply }) };
    }
  });
  vm.runInContext(fs.readFileSync('config.js', 'utf8'), context);
  if (html.includes('src="vendor/papaparse.min.js"')) {
    vm.runInContext(fs.readFileSync('vendor/papaparse.min.js', 'utf8'), context);
  }
  vm.runInContext(fs.readFileSync('database.js', 'utf8')
    .replace(/export default db;?/, 'globalThis.db = db;').replace(/^export /gm, ''), context);
  const db = context.db;
  await db.init();
  db.addRoteiro('SAT01', 'Orgânicos');
  db.upsertCliente({ idRota: '42', idCliente: 'c1', Cliente: 'Cliente original', ativo: true,
    logradouro: 'Rua A', 'Número': '1', Complemento: '', CEP: '88000000', roteiro_id: 1, Ordem: 1,
    Telefone1: phones[0].digits, Telefone2: phones[1].digits });
  if (contactDirectory) db.getWhatsappContactDirectory = () => contactDirectory;
  if (active) db.createWhatsappCampaign(campaign());
  vm.runInContext(fs.readFileSync('google-sync.js', 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, ''), context);
  vm.runInContext(fs.readFileSync('whatsapp-campaign.js', 'utf8').replace(/export /g, ''), context);
  vm.runInContext(fs.readFileSync('whatsapp-sender.js', 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/export /g, ''), context);
  elements.get('campaignMessage').value = 'Olá {nome}: {intercorrencia} em {data} ({residuo})';
  return { window, db, elements, opened, exported, storage, remoteCalls: () => remoteCalls,
    importCalls: () => importCalls, setNetworkReader: value => { networkReader = value; },
    setRemote: value => { remote = value; }, fail: value => { failPersistence = value; } };
}
test('estrutura da fila, histórico e delegação externa', () => {
  for (const id of ['queuePendingCount', 'queueOpenedCount', 'queueConfirmedCount', 'queueError',
    'queueList', 'campaignPanel', 'campaignHistory']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /src="whatsapp-sender\.js"/);
  assert.doesNotMatch(html, /id="roteiroChips"|\son(?:click|change|input)=|<script type="module">/);
});
test('retoma snapshots antes da rede; falha remota preserva campanha e não inventa zero', async () => {
  let finish;
  const h = await setup({ active: true, remote: () => new Promise(resolve => { finish = resolve; }) });
  const init = h.window.initWhatsappSender();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(h.elements.get('campaignClient').textContent, /Cliente original/);
  assert.equal(h.elements.get('campaignPreview').textContent, 'Mensagem congelada 1');
  finish({ ok: false, error: 'rede indisponível' });
  await init;
  assert.match(h.elements.get('queueError').textContent, /rede indisponível/);
  assert.equal(h.db.getActiveWhatsappCampaign().campaignId, 'campaign-1');
  assert.notEqual(h.elements.get('queuePendingCount').textContent, '0');
});
test('refresh concorrente faz uma consulta; falha mantém a última fila conhecida', async () => {
  const h = await setup();
  await h.window.initWhatsappSender();
  let finish;
  h.setRemote(() => new Promise(resolve => { finish = resolve; }));
  const a = h.window.refreshWhatsappQueue();
  const b = h.window.refreshWhatsappQueue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.remoteCalls(), 2);
  finish({ ok: false, error: 'offline' });
  await Promise.all([a, b]);
  assert.equal(h.elements.get('queuePendingCount').textContent, '1');
  assert.match(h.elements.get('queueList').innerHTML, /Cliente original/);
});
test('seleção congela ocorrência, mensagem e telefones; bloqueados ficam visíveis', async () => {
  const malicious = '<img src=x onerror="alert(1)">';
  const h = await setup({ remote: { ok: true, data: [occurrence,
    { ...occurrence, occurrenceId: 'blocked', idRota: '999', cliente: malicious }] } });
  await h.window.initWhatsappSender();
  assert.match(h.elements.get('queueList').innerHTML, /status-blocked/);
  assert.ok(!h.elements.get('queueList').innerHTML.includes(malicious));
  h.window.toggleWhatsappOccurrence('occ-1', true);
  h.window.toggleWhatsappOccurrence('blocked', true);
  await Promise.all([h.window.startWhatsappCampaign(), h.window.startWhatsappCampaign()]);
  const saved = h.db.getActiveWhatsappCampaign();
  assert.equal(saved.items.length, 1);
  assert.equal(saved.items[0].phones.length, 2);
  assert.equal(saved.items[0].message, 'Olá Cliente original: Bombona suja em 18/09/2026 (Orgânicos)');
  assert.match(saved.campaignId, /^[a-f0-9-]{36}$/);
});
test('abrir exige telefone, nunca confirma e só habilita confirmação após persistir opened', async () => {
  const h = await setup({ active: true });
  await h.window.initWhatsappSender();
  await h.window.confirmCurrentWhatsapp();
  await h.window.openCurrentWhatsapp();
  assert.equal(h.opened.length, 0);
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].status, 'pending');
  h.window.selectWhatsappPhone(2);
  await h.window.openCurrentWhatsapp();
  assert.match(h.opened[0], /^https:\/\/wa\.me\/5548988880000\?text=Mensagem%20congelada%201$/);
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].status, 'opened');
  assert.equal(h.elements.get('campaignStatus').textContent, 'Aguardando confirmação');
  assert.equal(h.elements.get('confirmWhatsappButton').disabled, false);
  assert.equal(h.elements.get('campaignPreview').textContent, 'Mensagem congelada 1');
  await h.window.confirmCurrentWhatsapp();
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].status, 'confirmed');
  assert.equal(h.elements.get('campaignPreview').textContent, 'Mensagem congelada 2');
});
test('falha na abertura e na persistência não avança nem afirma abertura', async () => {
  const h = await setup({ active: true });
  await h.window.initWhatsappSender();
  h.window.selectWhatsappPhone(1);
  h.window.openWhatsappUrl = async () => { throw new Error('popup bloqueado'); };
  await h.window.openCurrentWhatsapp();
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].status, 'pending');
  h.window.openWhatsappUrl = async () => {};
  h.fail(true);
  await h.window.openCurrentWhatsapp();
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].status, 'pending');
  assert.equal(h.elements.get('campaignPreview').textContent, 'Mensagem congelada 1');
  assert.equal(h.elements.get('confirmWhatsappButton').disabled, true);
  assert.match(h.elements.get('campaignError').textContent, /salvar|registrar/i);
  await h.window.deferCurrentWhatsapp();
  assert.equal(h.elements.get('campaignPreview').textContent, 'Mensagem congelada 1');
});
test('bloqueia ações concorrentes durante abertura externa', async () => {
  const h = await setup({ active: true });
  await h.window.initWhatsappSender();
  h.window.selectWhatsappPhone(1);
  let finish;
  h.window.openWhatsappUrl = () => new Promise(resolve => { finish = resolve; });
  const opening = h.window.openCurrentWhatsapp();
  await h.window.deferCurrentWhatsapp();
  await h.window.confirmCurrentWhatsapp();
  h.window.selectWhatsappPhone(2);
  finish();
  await opening;
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].phoneSlot, 1);
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].status, 'opened');
});
test('concluir exige todos resolvidos; reconcilia confirmados e adiados; exporta snapshots', async () => {
  const h = await setup({ active: true, remote: { ok: true, data: [occurrence,
    { ...occurrence, occurrenceId: 'occ-2' }] } });
  await h.window.initWhatsappSender();
  await h.window.completeWhatsappCampaign();
  assert.ok(h.db.getActiveWhatsappCampaign());
  h.window.selectWhatsappPhone(1);
  await h.window.openCurrentWhatsapp();
  await h.window.completeWhatsappCampaign();
  assert.ok(h.db.getActiveWhatsappCampaign());
  await h.window.confirmCurrentWhatsapp();
  await h.window.deferCurrentWhatsapp();
  await h.window.completeWhatsappCampaign();
  assert.equal(h.db.getActiveWhatsappCampaign(), null);
  assert.equal(h.elements.get('queuePendingCount').textContent, '1');
  assert.ok(!h.elements.get('queueList').innerHTML.includes('data-occurrence-id="occ-1"'));
  assert.match(h.elements.get('campaignHistory').innerHTML, /Mensagem congelada 1/);
  h.window.exportWhatsappCampaign('campaign-1');
  assert.equal(h.exported.length, 2);
  assert.equal(h.exported[0].Mensagem, 'Mensagem congelada 1');
  assert.equal(h.exported[0].Telefone, phones[0].digits);
  assert.equal(h.exported[1].Status, 'Adiado');
});

test('retoma opened com telefone original, mesmo após mudança na fonte e no cadastro', async () => {
  const h = await setup({ active: true, remote: { ok: true, data: [
    { ...occurrence, cliente: 'Cliente alterado', intercorrencia: 'Ocorrência alterada' }
  ] } });
  h.db.transitionWhatsappCampaignItem('item-1', 'opened', {
    phoneSlot: 2, phone: phones[1].digits, at: '2026-09-18T12:01:00Z'
  });
  h.db.db.run("UPDATE clientes SET cliente = 'Novo nome', telefone2 = '5548999999999'");
  await h.window.initWhatsappSender();
  assert.equal(h.elements.get('campaignClient').textContent, 'Cliente original');
  assert.equal(h.elements.get('campaignPreview').textContent, 'Mensagem congelada 1');
  assert.match(h.elements.get('campaignPhones').innerHTML, /98888-0000/);
  assert.equal(h.elements.get('confirmWhatsappButton').disabled, false);
  h.fail(true);
  await h.window.confirmCurrentWhatsapp();
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].status, 'opened');
  assert.equal(h.elements.get('campaignPreview').textContent, 'Mensagem congelada 1');
});

test('controller abre, recarrega, confirma, adia, conclui e preserva campanha diante de API antiga', async () => {
  const storage = new Map();
  const secondOccurrence = { ...occurrence, occurrenceId: 'occ-2', idRota: '43', cliente: 'Cliente B' };
  const blockedOccurrence = { ...occurrence, occurrenceId: 'occ-blocked', idRota: '44', cliente: 'Sem telefone' };
  const directory = [
    { idRota: '42', cliente: occurrence.cliente, roteiroNome: occurrence.roteiro, phones },
    { idRota: '43', cliente: secondOccurrence.cliente, roteiroNome: secondOccurrence.roteiro, phones: [phones[0]] },
    { idRota: '44', cliente: blockedOccurrence.cliente, roteiroNome: blockedOccurrence.roteiro, phones: [] }
  ];
  const initial = await setup({
    active: true,
    storage,
    contactDirectory: directory,
    remote: { ok: true, data: [occurrence, secondOccurrence, blockedOccurrence] }
  });
  await initial.window.initWhatsappSender();
  assert.match(initial.elements.get('queueList').innerHTML, /Sem telefone válido/);
  initial.window.selectWhatsappPhone(2);
  await initial.window.openCurrentWhatsapp();
  assert.equal(initial.opened.length, 1);
  assert.equal(initial.db.getActiveWhatsappCampaign().items[0].status, 'opened');
  assert.equal(initial.db.getConfirmedWhatsappOccurrenceIds().length, 0);

  const reloaded = await setup({
    storage,
    contactDirectory: directory,
    remote: { ok: false, error: 'GAS incompatível: API 11 obrigatória' }
  });
  await reloaded.window.initWhatsappSender();
  assert.equal(reloaded.elements.get('campaignPanel').hidden, false);
  assert.equal(reloaded.elements.get('campaignStatus').textContent, 'Aguardando confirmação');
  assert.equal(reloaded.elements.get('campaignPreview').textContent, 'Mensagem congelada 1');
  assert.equal(reloaded.elements.get('confirmWhatsappButton').disabled, false);
  assert.match(reloaded.elements.get('queueError').textContent, /API 11/);
  assert.notEqual(reloaded.elements.get('queuePendingCount').textContent, '0');

  reloaded.setRemote({ ok: true, data: [occurrence, secondOccurrence, blockedOccurrence] });
  await reloaded.window.refreshWhatsappQueue();
  await reloaded.window.confirmCurrentWhatsapp();
  assert.deepEqual(Array.from(reloaded.db.getConfirmedWhatsappOccurrenceIds()), ['occ-1']);
  await reloaded.window.deferCurrentWhatsapp();
  await reloaded.window.completeWhatsappCampaign();
  assert.equal(reloaded.db.getActiveWhatsappCampaign(), null);
  assert.equal(reloaded.elements.get('queuePendingCount').textContent, '2');
  assert.ok(!reloaded.elements.get('queueList').innerHTML.includes('data-occurrence-id="occ-1"'));
  assert.match(reloaded.elements.get('queueList').innerHTML, /data-occurrence-id="occ-2"/);
  assert.match(reloaded.elements.get('queueList').innerHTML, /Sem telefone válido/);
  assert.match(reloaded.elements.get('campaignHistory').innerHTML, /Mensagem congelada 1/);
  reloaded.window.exportWhatsappCampaign('campaign-1');
  assert.equal(reloaded.exported.length, 2);
  assert.equal(reloaded.exported[0].Status, 'Confirmado');
  assert.equal(reloaded.exported[1].Status, 'Adiado');

  const newOccurrence = { ...occurrence, occurrenceId: 'occ-1-new', data: '2026-09-21' };
  reloaded.setRemote({ ok: true, data: [newOccurrence, secondOccurrence, blockedOccurrence] });
  await reloaded.window.refreshWhatsappQueue();
  assert.match(reloaded.elements.get('queueList').innerHTML, /data-occurrence-id="occ-1-new"/);
});

test('falha sem campanha mantém contadores desconhecidos e permite recuperar a fonte', async () => {
  const h = await setup({ remote: { ok: false, error: 'offline' } });
  await h.window.initWhatsappSender();
  assert.equal(h.elements.get('queuePendingCount').textContent, '—');
  assert.ok(!h.elements.get('queueList').innerHTML.includes('Nenhuma pendência'));
  h.setRemote({ ok: true, data: [occurrence] });
  await h.window.refreshWhatsappQueue();
  assert.equal(h.elements.get('queueError').hidden, true);
  assert.equal(h.elements.get('queuePendingCount').textContent, '1');
  h.elements.get('queueSearch').value = 'ausente';
  h.window.applyWhatsappFilters();
  assert.ok(!h.elements.get('queueList').innerHTML.includes('Cliente original'));
  h.elements.get('queueSearch').value = '';
  h.elements.get('queueRouteFilter').value = 'SAT01';
  h.window.applyWhatsappFilters();
  assert.match(h.elements.get('queueList').innerHTML, /Cliente original/);
  h.window.showWhatsappTab('history');
  assert.equal(h.elements.get('queueTab').hidden, true);
  assert.equal(h.elements.get('historyTab').hidden, false);
});

test('falha ao criar ou concluir conserva seleção e campanha para nova tentativa', async () => {
  const h = await setup();
  await h.window.initWhatsappSender();
  h.window.toggleWhatsappOccurrence('occ-1', true);
  h.fail(true);
  await h.window.startWhatsappCampaign();
  assert.equal(h.db.getActiveWhatsappCampaign(), null);
  assert.equal(h.elements.get('startCampaignButton').disabled, false);
  h.fail(false);
  await h.window.startWhatsappCampaign();
  await h.window.deferCurrentWhatsapp();
  h.fail(true);
  await h.window.completeWhatsappCampaign();
  assert.ok(h.db.getActiveWhatsappCampaign());
  assert.equal(h.elements.get('campaignPanel').hidden, false);
  assert.equal(h.db.getWhatsappCampaignHistory().length, 0);
});

function networkCsv(phone = '48977770000', modified = 1000) {
  const csv = 'Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP;Complemento;Telefone1;Telefone2;TipoResiduo\r\n' +
    `SAT01-1;42;0;1;SAT01;Cliente atualizado;Rua A;1;88000000;;${phone};;Vidro`;
  return { bytes_base64: Buffer.from('\ufeff' + csv, 'utf16le').toString('base64'), modified_time_ms: modified };
}

test('Pendentes inclui abertos, adiados e bloqueados; confirmação é a única redução', async () => {
  const remote = { ok: true, data: [occurrence,
    { ...occurrence, occurrenceId: 'occ-2' },
    { ...occurrence, occurrenceId: 'blocked', idRota: '99' }] };
  const h = await setup({ active: true, remote });
  await h.window.initWhatsappSender();
  assert.equal(h.elements.get('queuePendingCount').textContent, '3');
  h.window.selectWhatsappPhone(1);
  await h.window.openCurrentWhatsapp();
  assert.equal(h.elements.get('queuePendingCount').textContent, '3');
  assert.equal(h.elements.get('queueOpenedCount').textContent, '1');
  const resumed = await setup({ storage: h.storage, remote });
  await resumed.window.initWhatsappSender();
  assert.equal(resumed.elements.get('queuePendingCount').textContent, '3');
  assert.equal(resumed.elements.get('queueOpenedCount').textContent, '1');
  await resumed.window.confirmCurrentWhatsapp();
  assert.equal(resumed.elements.get('queuePendingCount').textContent, '2');
  assert.equal(resumed.elements.get('queueOpenedCount').textContent, '0');
  assert.equal(resumed.elements.get('queueConfirmedCount').textContent, '1');
  await resumed.window.deferCurrentWhatsapp();
  assert.equal(resumed.elements.get('queuePendingCount').textContent, '2');
  assert.match(resumed.elements.get('campaignProgress').textContent, /1 confirmado\(s\), 1 adiado\(s\) de 2/);
  await resumed.window.completeWhatsappCampaign();
  assert.equal(resumed.elements.get('queuePendingCount').textContent, '2');
});

test('cadastro real sem telefone informa bloqueio por telefone, não cadastro ausente', async () => {
  const h = await setup();
  h.db.db.run("UPDATE clientes SET telefone1 = '', telefone2 = ''");
  await h.window.initWhatsappSender();
  assert.match(h.elements.get('queueList').innerHTML, /Sem telefone válido/);
  assert.doesNotMatch(h.elements.get('queueList').innerHTML, /Cadastro não localizado/);
  assert.equal(h.elements.get('queuePendingCount').textContent, '1');
});

test('importa cadastro na abertura e no refresh antes de criar mensagem e telefones da campanha', async () => {
  const h = await setup({ networkReader: () => networkCsv() });
  await h.window.initWhatsappSender();
  assert.equal(h.importCalls(), 1);
  assert.equal(h.db.getWhatsappContactDirectory()[0].phones[0].digits, '5548977770000');
  h.setNetworkReader(() => networkCsv('48966660000', 2000));
  await h.window.refreshWhatsappQueue();
  assert.equal(h.importCalls(), 2);
  h.window.toggleWhatsappOccurrence('occ-1', true);
  await h.window.startWhatsappCampaign();
  const saved = h.db.getActiveWhatsappCampaign();
  assert.equal(saved.items[0].phones[0].digits, '5548966660000');
  assert.equal(saved.items[0].message, 'Olá Cliente original: Bombona suja em 18/09/2026 (Vidro)');
});

test('campanha salva aparece antes do import e mantém snapshots após cadastro atualizado', async () => {
  let finishImport;
  const h = await setup({ active: true, networkReader: () => new Promise(resolve => { finishImport = resolve; }) });
  const init = h.window.initWhatsappSender();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.elements.get('campaignPreview').textContent, 'Mensagem congelada 1');
  assert.equal(h.remoteCalls(), 0);
  assert.equal(h.importCalls(), 1);
  assert.equal(h.elements.get('startCampaignButton').disabled, true);
  finishImport(networkCsv());
  await init;
  assert.equal(h.db.getWhatsappContactDirectory()[0].phones[0].digits, '5548977770000');
  assert.equal(h.elements.get('campaignPreview').textContent, 'Mensagem congelada 1');
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].phones[0].digits, phones[0].digits);
});

test('refresh único impede campanha com cadastro antigo enquanto import está pendente', async () => {
  const h = await setup({ networkReader: () => networkCsv() });
  await h.window.initWhatsappSender();
  h.window.toggleWhatsappOccurrence('occ-1', true);
  let finishImport;
  h.setNetworkReader(() => new Promise(resolve => { finishImport = resolve; }));
  const a = h.window.refreshWhatsappQueue();
  const b = h.window.refreshWhatsappQueue();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.importCalls(), 2);
  assert.equal(h.elements.get('startCampaignButton').disabled, true);
  await h.window.startWhatsappCampaign();
  assert.equal(h.db.getActiveWhatsappCampaign(), null);
  finishImport(networkCsv('48966660000', 2000));
  await Promise.all([a, b]);
  assert.equal(h.remoteCalls(), 2);
  await h.window.startWhatsappCampaign();
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].phones[0].digits, '5548966660000');
});

test('falha no import preserva última fila e campanha salva', async () => {
  const h = await setup({ active: true, networkReader: () => networkCsv() });
  await h.window.initWhatsappSender();
  const before = h.elements.get('queueList').innerHTML;
  const snapshot = JSON.stringify(h.db.getActiveWhatsappCampaign());
  h.setNetworkReader(() => { throw new Error('cadastro offline'); });
  h.setRemote({ ok: true, data: [] });
  await h.window.refreshWhatsappQueue();
  assert.match(h.elements.get('queueError').textContent, /cadastro offline/);
  h.window.applyWhatsappFilters();
  assert.equal(h.elements.get('queueList').innerHTML, before);
  assert.equal(JSON.stringify(h.db.getActiveWhatsappCampaign()), snapshot);
  assert.equal(h.remoteCalls(), 1);
});

for (const invalid of [null, false, 0, '']) {
  test(`resposta com ${JSON.stringify(invalid)} preserva fila e campanha mesmo após refiltrar`, async () => {
    const h = await setup({ active: true });
    await h.window.initWhatsappSender();
    const before = h.elements.get('queueList').innerHTML;
    const snapshot = JSON.stringify(h.db.getActiveWhatsappCampaign());
    h.setRemote({ ok: true, data: [{ ...occurrence, occurrenceId: 'nao-publicar' }, invalid] });
    await h.window.refreshWhatsappQueue();
    assert.match(h.elements.get('queueError').textContent, /ocorr.*incompleta/i);
    h.window.applyWhatsappFilters();
    assert.equal(h.elements.get('queueList').innerHTML, before);
    assert.equal(JSON.stringify(h.db.getActiveWhatsappCampaign()), snapshot);
    h.window.selectWhatsappPhone(1);
    await h.window.openCurrentWhatsapp();
    assert.equal(h.db.getActiveWhatsappCampaign().items[0].status, 'opened');
    assert.doesNotMatch(h.elements.get('queueList').innerHTML, /nao-publicar/);
  });
}
