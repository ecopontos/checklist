const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Sheet } = require('./helpers/gas-mock.cjs');

function ambiente({ props = { SPREADSHEET_ID: 'ss-teste', AMBIENTE_TESTE: 'sim' }, sheets = new Map() } = {}) {
  const properties = new Map(Object.entries(props));
  const folders = new Map();
  let nextFolder = 1;
  const novaPasta = () => {
    const id = `pasta-${nextFolder++}`;
    const arquivos = [];
    const pasta = { id, arquivos, getId: () => id,
      getFilesByName: nome => { const achados = arquivos.filter(a => a.nome === nome); let i = 0; return { hasNext: () => i < achados.length, next: () => achados[i++] }; },
      createFile: blob => { const arquivo = { nome: blob.nome, texto: blob.texto, getLastUpdated: () => new Date('2026-10-01T12:00:00Z'),
        getBlob: () => ({ getBytes: () => Array.from(Buffer.from(blob.texto)), getDataAsString: () => blob.texto }) }; arquivos.push(arquivo); return arquivo; } };
    folders.set(id, pasta);
    return pasta;
  };
  const spreadsheet = { getSheetByName: n => sheets.get(n) || null, insertSheet: n => { const s = new Sheet(); sheets.set(n, s); return s; } };
  const saida = value => ({ value, getContent: () => value, setMimeType() { return this; } });
  const logs = [];
  const context = vm.createContext({ console, JSON, Date, Number, String, Boolean, Array, Object, Math, isFinite, isNaN, RegExp, Error,
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => properties.get(k) ?? null, setProperty: (k, v) => properties.set(k, String(v)) }) },
    SpreadsheetApp: { openById: () => spreadsheet },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: saida },
    Utilities: { getUuid: () => require('node:crypto').randomUUID(), newBlob: (texto, tipo, nome) => ({ texto, tipo, nome }) },
    DriveApp: { createFolder: () => novaPasta(), getFolderById: id => { if (!folders.has(id)) throw new Error('pasta inexistente'); return folders.get(id); },
      getFileById: () => { throw new Error('sem acesso'); } },
    Logger: { log: m => logs.push(m) } });
  vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);
  vm.runInContext(fs.readFileSync('gas-teste/PrepararTeste.gs', 'utf8'), context);
  return { context, properties, sheets, folders, logs };
}

test('recusa rodar sem confirmar que e ambiente de teste', () => {
  const a = ambiente({ props: { SPREADSHEET_ID: 'ss' } });
  assert.throws(() => a.context.prepararTeste(), /AMBIENTE_TESTE/);
  assert.equal(a.sheets.size, 0, 'nada e criado');
});

test('recusa planilha que parece em uso (Coletas com registros)', () => {
  const sheets = new Map();
  const coletas = new Sheet();
  coletas.rows = [['ID Rota'], ['1']];
  sheets.set('Coletas', coletas);
  const a = ambiente({ sheets });
  assert.throws(() => a.context.prepararTeste(), /em uso/);
  assert.equal(sheets.has('tblRotas'), false);
});

test('cria abas com os cabecalhos que o Code.gs procura, token e pastas', () => {
  const a = ambiente();
  const relatorio = a.context.prepararTeste();
  const cabecalho = nome => a.sheets.get(nome).rows[0].map(String).join('|');
  assert.equal(cabecalho('tblRotas'), 'idRota|idPJ|idRoteiro|Ordem|Inativo');
  assert.equal(cabecalho('shtClientes'), 'idPJ|idUnico2|Cliente|Número|Complemento|CEP|Telefone1|Telefone2');
  assert.equal(cabecalho('tblRoteiros'), 'idRoteiro|Roteiro');
  assert.equal(cabecalho('Coletas'), 'ID Rota|Data|Cliente|Roteiro|Quantidade|Intercorrência|Sincronizado Em|Sync ID');
  for (const aba of ['AlteracoesRoteiros', 'AlteracoesClientes', 'verdesagendados', 'CadastroPontos', 'CadastroRoteiros']) {
    assert.ok(a.sheets.has(aba), `aba ${aba}`);
  }
  assert.equal(a.sheets.get('tblRotas').rows.length, 7);
  assert.match(a.properties.get('ROUTE_CHANGES_TOKEN'), /^[A-Za-z0-9_-]{32,}$/);
  assert.ok(relatorio.some(l => l.includes(a.properties.get('ROUTE_CHANGES_TOKEN'))), 'token novo aparece no relatorio');
  assert.ok(a.properties.get('DRIVE_FOLDER_ID') && a.properties.get('CHECKLISTS_FOLDER_ID'));
  assert.equal(a.sheets.get('shtClientes').formatCalls.length >= 4, true, 'CEP, numero e telefones como texto');
});

test('e idempotente e nunca sobrescreve dados existentes nem o token', () => {
  const a = ambiente();
  a.context.prepararTeste();
  const token = a.properties.get('ROUTE_CHANGES_TOKEN');
  const pasta = a.properties.get('DRIVE_FOLDER_ID');
  a.sheets.get('tblRotas').rows[1][3] = 99; // edicao feita pelo usuario
  const relatorio = a.context.prepararTeste();
  assert.equal(a.sheets.get('tblRotas').rows[1][3], 99);
  assert.equal(a.sheets.get('tblRotas').rows.length, 7);
  assert.equal(a.properties.get('ROUTE_CHANGES_TOKEN'), token);
  assert.equal(a.properties.get('DRIVE_FOLDER_ID'), pasta);
  assert.equal(a.folders.get(pasta).arquivos.length, 1, 'CSV nao e duplicado');
  assert.ok(relatorio.some(l => /tblRotas: já tem dados/.test(l)));
  assert.ok(!relatorio.some(l => l.startsWith('ROUTE_CHANGES_TOKEN gerado')));
});

test('o GAS le as abas criadas e o CSV gerado e importado pelo proprio app', async () => {
  const a = ambiente();
  a.context.prepararTeste();

  const abas = JSON.parse(a.context.doGet({ parameter: {} }).value);
  assert.equal(abas.ok, true, abas.error);
  assert.equal(abas.count, 6);
  const clienteCompartilhado = abas.rows.filter(r => r.Cliente === 'Padaria Teste');
  assert.equal(clienteCompartilhado.length, 2, 'o mesmo cliente em dois roteiros');
  assert.equal(clienteCompartilhado[0].CEP, '88010000');
  assert.equal(abas.rows.find(r => r.Cliente === 'Mercado Teste').CEP, '01001000', 'zero a esquerda preservado');

  const csv = JSON.parse(a.context.doGet({ parameter: { action: 'roteirosCsv' } }).value);
  assert.equal(csv.ok, true, csv.error);

  const storage = new Map();
  const ctx = vm.createContext({ console, crypto: require('node:crypto').webcrypto, Papa: require('../vendor/papaparse.min.js'),
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    initSqlJs: () => require('../vendor/sql-wasm.js')({ locateFile: f => path.resolve('vendor', f) }) });
  const mod = new vm.SourceTextModule(fs.readFileSync('database.js', 'utf8'), { context: ctx });
  await mod.link(() => {}); await mod.evaluate();
  const db = mod.namespace.default; await db.init();
  const r = db.importRoteirosCsv(csv.content);
  assert.equal(r.clientes, 6);
  assert.equal(r.roteiros, 2);
  assert.equal(db.getClienteByIdRota('2').logradouro, 'Avenida do Mar');
  assert.ok(db.getClienteByIdRota('2').id_cliente, 'idCliente vem do CSV para a edicao de clientes');
  assert.equal(db.getClienteByIdRota('6').ativo, 0);
  assert.deepEqual(db.getRoteiros().map(x => `${x.nome}:${x.tipo_residuo}`).sort(), ['SAT01:Organicos', 'SV01:Vidro']);
});

test('as filas legadas e o cadastro compartilhado funcionam na cópia', () => {
  const a = ambiente();
  a.context.prepararTeste();
  const token = a.properties.get('ROUTE_CHANGES_TOKEN');
  const idUnico = a.sheets.get('shtClientes').rows[1][1];

  const rota = JSON.parse(a.context.saveRouteChanges_([{ change_id: 'rota-teste-0001', id_rota: 3, inativo: 1, ordem: 9, roteiro: 'SAT01',
    alterado_em: '2026-10-01T10:00:00Z', origem: 'teste' }], token).value);
  assert.equal(rota.ok, true, rota.error);
  assert.equal(a.sheets.get('tblRotas').rows[3][4], true);
  assert.equal(a.sheets.get('tblRotas').rows[3][3], 9);

  const cli = JSON.parse(a.context.saveClientChanges_([{ change_id: 'cli-teste-00001', id_cliente: idUnico, campos: { Cliente: 'Padaria Renomeada' },
    alterado_em: '2026-10-01T10:00:00Z', origem: 'teste' }], token).value);
  assert.equal(cli.ok, true, cli.error);
  assert.equal(a.sheets.get('shtClientes').rows[1][2], 'Padaria Renomeada');

  const cad = JSON.parse(a.context.cadastroSync_({ token, since: 0, origem: 'teste', roteiros: [],
    pontos: [{ id_rota: 'APP-1', cliente: 'Novo', roteiro: 'SAT01', editado_em: '2026-10-01T10:00:00Z', origem: 'teste' }] }).value);
  assert.equal(cad.ok, true, cad.error);
  assert.deepEqual([...cad.accepted.pontos], ['APP-1']);
});

test('verificarTeste aprova a copia preparada e aponta o que falta', () => {
  const a = ambiente();
  a.context.prepararTeste();
  const itens = a.context.verificarTeste();
  const falhas = itens.filter(i => !i.ok);
  assert.equal(falhas.length, 0, JSON.stringify(falhas));
  assert.ok(itens.length >= 10);

  a.properties.delete('CHECKLISTS_FOLDER_ID');
  a.sheets.get('tblRotas').rows[0][4] = 'Inativo?';
  const depois = a.context.verificarTeste().filter(i => !i.ok).map(i => i.item);
  assert.ok(depois.includes('Propriedade CHECKLISTS_FOLDER_ID'));
  assert.ok(depois.includes('Aba tblRotas (cabeçalho)'));
});

test('o script de preparacao nao fica na pasta gas/, que e enviada para producao', () => {
  assert.equal(fs.existsSync('gas/PrepararTeste.gs'), false);
  assert.match(fs.readFileSync('prepare-dist.js', 'utf8'), /'gas-teste'/, 'fora do build do app');
});
