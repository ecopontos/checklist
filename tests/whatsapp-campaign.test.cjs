const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function loadCampaignModule() {
  const source = fs.existsSync('whatsapp-campaign.js')
    ? fs.readFileSync('whatsapp-campaign.js', 'utf8')
    : '';
  const module = new vm.SourceTextModule(source, {
    context: vm.createContext({}),
    identifier: 'whatsapp-campaign.js'
  });
  await module.link(() => { throw new Error('whatsapp-campaign.js deve ser independente'); });
  await module.evaluate();
  return module.namespace;
}

const occurrenceA = { occurrenceId: 'occ-a', idRota: '1', data: '2026-09-18', cliente: 'A', roteiro: 'R1', intercorrencia: 'Acesso bloqueado' };
const occurrenceB = { occurrenceId: 'occ-b', idRota: '2', data: '2026-09-17', cliente: 'B', roteiro: 'R2', intercorrencia: 'Sem bombona' };
const occurrenceC = { occurrenceId: 'occ-c', idRota: '3', data: '2026-09-16', cliente: 'C', roteiro: 'R3', intercorrencia: 'Recusou' };
const frozenPhones = [
  { slot: 1, exibicao: '(48) 99999-0000', digits: '5548999990000' },
  { slot: 2, exibicao: '(48) 98888-0000', digits: '5548988880000' }
];

test('campanha ativa prevalece e confirmados externos sao removidos', async () => {
  const { buildWhatsappQueue } = await loadCampaignModule();
  const contacts = [
    { idRota: '1', cliente: 'A atualizada', roteiroNome: 'R9', phones: [{ slot: 1, exibicao: 'novo', digits: '5548999999999' }] },
    { idRota: '2', cliente: 'B', roteiroNome: 'R2', phones: [] }
  ];
  const activeItems = [{
    itemId: 'item-a',
    occurrenceId: 'occ-a',
    idRota: '1',
    cliente: 'A congelada',
    roteiro: 'R1 congelado',
    coletaData: '2026-09-18',
    intercorrencia: 'Acesso bloqueado congelado',
    status: 'opened',
    phones: frozenPhones
  }];
  const before = JSON.stringify({ occurrences: [occurrenceA, occurrenceB, occurrenceC], contacts, activeItems });

  const queue = buildWhatsappQueue({
    occurrences: [occurrenceA, occurrenceB, occurrenceC],
    contacts,
    confirmedOccurrenceIds: ['occ-c'],
    activeItems
  });

  assert.equal(queue.length, 2);
  const active = queue.find(item => item.occurrenceId === 'occ-a');
  assert.equal(active.status, 'opened');
  assert.equal(active.cliente, 'A congelada');
  assert.equal(active.roteiro, 'R1 congelado');
  assert.equal(active.phones.length, 2);
  assert.notEqual(active.phones, frozenPhones);
  assert.equal(queue.find(item => item.occurrenceId === 'occ-b').blockedReason, 'Sem telefone válido');
  assert.ok(!queue.some(item => item.occurrenceId === 'occ-c'));
  assert.equal(JSON.stringify({ occurrences: [occurrenceA, occurrenceB, occurrenceC], contacts, activeItems }), before);
});

test('preserva todos os itens ativos ausentes no remoto, inclusive confirmed', async () => {
  const { buildWhatsappQueue } = await loadCampaignModule();
  const activeItems = [
    { occurrenceId: 'occ-old-open', status: 'opened', cliente: 'Aberto', phones: frozenPhones },
    { occurrenceId: 'occ-old-confirmed', status: 'confirmed', cliente: 'Confirmado', phones: frozenPhones }
  ];

  const queue = buildWhatsappQueue({
    occurrences: [],
    contacts: [],
    confirmedOccurrenceIds: ['occ-old-confirmed'],
    activeItems
  });

  assert.deepEqual(Array.from(queue, item => [item.occurrenceId, item.status]), [
    ['occ-old-open', 'opened'],
    ['occ-old-confirmed', 'confirmed']
  ]);
});

test('itens novos usam diretorio atual, ficam pending e ordenam sem mutar entradas', async () => {
  const { buildWhatsappQueue } = await loadCampaignModule();
  const occurrences = [
    { occurrenceId: 'occ-z', idRota: '9', data: '2026-09-17', cliente: 'Zulu', roteiro: 'R2', intercorrencia: 'Z' },
    { occurrenceId: 'occ-b', idRota: '2', data: '2026-09-18', cliente: 'Beta', roteiro: 'R2', intercorrencia: 'B' },
    { occurrenceId: 'occ-a', idRota: '1', data: '2026-09-18', cliente: 'Alfa', roteiro: 'R1', intercorrencia: 'A' },
    { occurrenceId: 'occ-c', idRota: '3', data: '2026-09-18', cliente: 'Charlie', roteiro: 'R1', intercorrencia: 'C' }
  ];
  const contacts = [
    { idRota: '1', phones: frozenPhones },
    { idRota: '2', phones: [frozenPhones[0]] },
    { idRota: '3', phones: [frozenPhones[1]] }
  ];
  const inputOrder = occurrences.map(item => item.occurrenceId);

  const queue = buildWhatsappQueue({ occurrences, contacts, confirmedOccurrenceIds: [], activeItems: [] });

  assert.deepEqual(Array.from(queue, item => item.occurrenceId), ['occ-a', 'occ-c', 'occ-b', 'occ-z']);
  assert.ok(queue.every(item => item.status === 'pending'));
  assert.equal(queue.find(item => item.occurrenceId === 'occ-z').blockedReason, 'Cadastro não localizado');
  assert.deepEqual(occurrences.map(item => item.occurrenceId), inputOrder);
  assert.notEqual(queue[0].phones, contacts[0].phones);
});

test('substitui todas as tags da mensagem sem diferenciar maiusculas', async () => {
  const { buildWhatsappMessage } = await loadCampaignModule();
  const message = buildWhatsappMessage(
    '{NOME}: {intercorrencia}; em {DATA}; resíduo {residuo}. Outra vez: {nome}/{INTERCORRENCIA}/{data}/{RESIDUO}',
    {
      cliente: 'Cliente A',
      intercorrencia: 'Sem bombona',
      data: '2026-09-18',
      residuo: 'Orgânicos'
    }
  );

  assert.equal(
    message,
    'Cliente A: Sem bombona; em 18/09/2026; resíduo Orgânicos. Outra vez: Cliente A/Sem bombona/18/09/2026/Orgânicos'
  );
});

test('interpola valores literalmente sem reinterpretar cifrões ou tags embutidas', async () => {
  const { buildWhatsappMessage } = await loadCampaignModule();
  const cliente = "Nome $& $$ $` $' {intercorrencia}";
  const intercorrencia = 'Falha $& {nome}';
  const residuo = 'Vidro $$ {data}';

  const message = buildWhatsappMessage(
    'Cliente={nome}; Ocorrência={intercorrencia}; Data={data}; Resíduo={residuo}',
    { cliente, intercorrencia, data: '2026-09-18', residuo }
  );

  assert.equal(
    message,
    `Cliente=${cliente}; Ocorrência=${intercorrencia}; Data=18/09/2026; Resíduo=${residuo}`
  );
});

test('resume os itens em seis contadores exclusivos', async () => {
  const { summarizeWhatsappItems } = await loadCampaignModule();
  const summary = summarizeWhatsappItems([
    { status: 'pending' },
    { status: 'opened' },
    { status: 'confirmed' },
    { status: 'deferred' },
    { status: 'pending', blockedReason: 'Sem telefone válido' },
    { status: 'opened', blockedReason: 'Cadastro não localizado' }
  ]);

  assert.deepEqual(
    {
      pending: summary.pending,
      opened: summary.opened,
      confirmed: summary.confirmed,
      deferred: summary.deferred,
      blocked: summary.blocked,
      total: summary.total
    },
    { pending: 1, opened: 1, confirmed: 1, deferred: 1, blocked: 2, total: 6 }
  );
});
