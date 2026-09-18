const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function setup(saved) {
  const storage = new Map(saved ? [['app3_db', saved]] : []);
  let failPersistence = false;
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    removeItem: key => storage.delete(key),
    setItem(key, value) {
      if (failPersistence && key === 'app3_db') throw new Error('QuotaExceeded');
      storage.set(key, String(value));
    }
  };
  const context = vm.createContext({
    console,
    crypto: require('node:crypto').webcrypto,
    localStorage,
    initSqlJs: () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.resolve('vendor', file)
    })
  });
  const module = new vm.SourceTextModule(fs.readFileSync('database.js', 'utf8'), { context });
  await module.link(() => {});
  await module.evaluate();
  const db = module.namespace.default;
  await db.init();
  return {
    db,
    storage,
    failPersistence: value => { failPersistence = value; }
  };
}

function item(overrides = {}) {
  return {
    itemId: 'item-1', occurrenceId: 'occ-1', idRota: '42',
    cliente: 'Cliente A', roteiro: 'R1', coletaData: '2026-09-18',
    intercorrencia: 'Bombona suja', message: 'Olá Cliente A: Bombona suja',
    phones: [{ slot: 1, exibicao: '(48) 99999-0000', digits: '5548999990000' }],
    ...overrides
  };
}

function campaign(overrides = {}) {
  return {
    campaignId: 'campaign-1',
    messageTemplate: 'Olá {nome}: {intercorrencia}',
    createdAt: '2026-09-18T11:59:00.000Z',
    items: [item()],
    ...overrides
  };
}

test('init cria o schema e campanha ativa pode ser retomada do armazenamento', async () => {
  const h = await setup();
  const tables = h.db.db.exec(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('whatsapp_campaigns', 'whatsapp_campaign_items')
    ORDER BY name`)[0].values.flat();
  assert.deepEqual(Array.from(tables), ['whatsapp_campaign_items', 'whatsapp_campaigns']);

  const created = h.db.createWhatsappCampaign(campaign());
  assert.equal(created.items[0].status, 'pending');
  assert.equal(created.createdAt, '2026-09-18T11:59:00.000Z');

  const reloaded = await setup(h.storage.get('app3_db'));
  const active = reloaded.db.getActiveWhatsappCampaign();
  assert.equal(active.campaignId, 'campaign-1');
  assert.equal(active.items[0].message, 'Olá Cliente A: Bombona suja');
  assert.equal(active.items[0].phones[0].digits, '5548999990000');
  assert.equal(reloaded.db.getWhatsappCampaignHistory().length, 0);
});

test('transições persistem abertura e confirmação idempotente preserva o primeiro horário', async () => {
  const { db } = await setup();
  db.createWhatsappCampaign(campaign());
  const opened = db.transitionWhatsappCampaignItem('item-1', 'opened', {
    phoneSlot: 1, phone: '5548999990000', at: '2026-09-18T12:00:00.000Z'
  });
  assert.equal(opened.status, 'opened');
  assert.equal(db.getActiveWhatsappCampaign().items[0].status, 'opened');

  db.transitionWhatsappCampaignItem('item-1', 'confirmed', {
    at: '2026-09-18T12:01:00.000Z'
  });
  const repeated = db.transitionWhatsappCampaignItem('item-1', 'confirmed', {
    at: '2026-09-18T12:02:00.000Z'
  });
  assert.deepEqual(Array.from(db.getConfirmedWhatsappOccurrenceIds()), ['occ-1']);
  assert.equal(repeated.confirmedAt, '2026-09-18T12:01:00.000Z');
  assert.equal(db.getActiveWhatsappCampaign().items[0].confirmedAt, '2026-09-18T12:01:00.000Z');
});

test('falha de persistência restaura memória e armazenamento durante transição', async () => {
  const h = await setup();
  h.db.createWhatsappCampaign(campaign());
  const savedPending = h.storage.get('app3_db');
  h.failPersistence(true);
  assert.throws(() => h.db.transitionWhatsappCampaignItem('item-1', 'deferred', {
    at: '2026-09-18T12:00:00.000Z'
  }), /QuotaExceeded/);
  assert.equal(h.db.getActiveWhatsappCampaign().items[0].status, 'pending');
  assert.equal(h.storage.get('app3_db'), savedPending);

  const reloaded = await setup(savedPending);
  assert.equal(reloaded.db.getActiveWhatsappCampaign().items[0].status, 'pending');
});

test('uma segunda campanha ativa é rejeitada e pending impede conclusão', async () => {
  const { db } = await setup();
  db.createWhatsappCampaign(campaign());
  assert.throws(() => db.createWhatsappCampaign(campaign({ campaignId: 'campaign-2' })), /ativa/i);
  assert.throws(() => db.completeWhatsappCampaign('campaign-1', '2026-09-18T12:03:00.000Z'), /pending|pendente/i);
  assert.equal(db.getActiveWhatsappCampaign().status, 'active');
});

test('deferred permite concluir, não confirma ocorrência e histórico contém só concluídas', async () => {
  const { db } = await setup();
  db.createWhatsappCampaign(campaign());
  db.transitionWhatsappCampaignItem('item-1', 'deferred', {
    at: '2026-09-18T12:00:00.000Z'
  });
  assert.deepEqual(Array.from(db.getConfirmedWhatsappOccurrenceIds()), []);
  db.completeWhatsappCampaign('campaign-1', '2026-09-18T12:03:00.000Z');
  assert.equal(db.getActiveWhatsappCampaign(), null);

  db.createWhatsappCampaign(campaign({
    campaignId: 'campaign-2',
    createdAt: '2026-09-18T13:00:00.000Z',
    items: [item({ itemId: 'item-2', occurrenceId: 'occ-2' })]
  }));
  const history = db.getWhatsappCampaignHistory();
  assert.equal(history.length, 1);
  assert.equal(history[0].campaignId, 'campaign-1');
  assert.equal(history[0].completedAt, '2026-09-18T12:03:00.000Z');
  assert.equal(history[0].items[0].status, 'deferred');
});

test('valida identificadores, data civil, telefones e transições permitidas', async () => {
  const { db } = await setup();
  assert.throws(() => db.createWhatsappCampaign(campaign({ campaignId: '' })), /campanha|id/i);
  assert.throws(() => db.createWhatsappCampaign(campaign({
    items: [item({ coletaData: '2026-02-30' })]
  })), /data/i);
  assert.throws(() => db.createWhatsappCampaign(campaign({
    items: [item({ phones: '5548999990000' })]
  })), /telefone|phones/i);

  db.createWhatsappCampaign(campaign());
  assert.throws(() => db.transitionWhatsappCampaignItem('item-1', 'confirmed', {
    at: '2026-09-18T12:01:00.000Z'
  }), /transição|status/i);
  assert.throws(() => db.transitionWhatsappCampaignItem('missing', 'deferred', {
    at: '2026-09-18T12:01:00.000Z'
  }), /item/i);
});

test('diretório agrupa os telefones normalizados por idRota', async () => {
  const { db } = await setup();
  db.addRoteiro('R1');
  const roteiroId = db.getRoteiros()[0].id;
  db.upsertCliente({
    idRota: '42', idCliente: 'cliente-42', Cliente: 'Cliente A', logradouro: '',
    'Número': '', Complemento: '', CEP: '', Telefone1: '(48) 99999-0000',
    Telefone2: '48 3333-4444', roteiro_id: roteiroId, Ordem: 1, ativo: true
  });
  db.upsertCliente({
    idRota: '43', idCliente: 'cliente-43', Cliente: 'Sem telefone', logradouro: '',
    'Número': '', Complemento: '', CEP: '', Telefone1: '123', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 2, ativo: true
  });

  const directory = db.getWhatsappContactDirectory();
  assert.equal(directory.length, 1);
  assert.equal(directory[0].idRota, '42');
  assert.equal(directory[0].cliente, 'Cliente A');
  assert.equal(directory[0].roteiroNome, 'R1');
  assert.deepEqual(JSON.parse(JSON.stringify(directory[0].phones)), [
    { slot: 1, exibicao: '(48) 99999-0000', digits: '5548999990000' },
    { slot: 2, exibicao: '48 3333-4444', digits: '554833334444' }
  ]);
});
