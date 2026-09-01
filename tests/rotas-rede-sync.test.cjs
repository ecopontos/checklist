const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createContext() {
  const storage = new Map();
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key)
  };
  const windowRef = { __TAURI__: undefined };
  const context = vm.createContext({
    console, localStorage, window: windowRef, globalThis: null,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout, atob,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    })
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'vendor', 'papaparse.min.js'), 'utf8'), context);
  return { context, windowRef, localStorage };
}

const moduleCache = new Map();
async function loadModule(context, filename) {
  if (moduleCache.has(filename)) return moduleCache.get(filename).namespace;
  const source = fs.readFileSync(filename, 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: filename });
  moduleCache.set(filename, module);
  await module.link(async specifier => {
    const resolved = specifier.replace(/^\.\//, '');
    if (moduleCache.has(resolved)) return moduleCache.get(resolved);
    throw new Error(`Import inesperado em ${filename}: ${specifier}`);
  });
  await module.evaluate();
  return module.namespace;
}

const HEADER = 'Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP;Complemento;Telefone1;Telefone2';
function csvBase64(rows) {
  const text = '﻿' + HEADER + '\r\n' + rows.join('\r\n');
  return Buffer.from(text, 'utf16le').toString('base64');
}

(async () => {
  const { context, windowRef, localStorage } = createContext();
  const databaseModule = await loadModule(context, 'database.js');
  const syncModule = await loadModule(context, 'google-sync.js');
  const db = databaseModule.default;
  await db.init();

  // Fora do app empacotado (sem window.__TAURI__): nao tenta nada.
  const semTauri = await syncModule.checkAndImportRoteirosRede(db);
  assert.strictEqual(semTauri.checked, false);
  assert.strictEqual(semTauri.reason, 'not-tauri');

  db.addRoteiro('SAT01');
  const roteiroId = db.getRoteiros().find(r => r.nome === 'SAT01').id;
  db.upsertCliente({
    idRota: '777', idCliente: 'uuid-777', Cliente: 'TESTE REDE', logradouro: '',
    'Número': '10', Complemento: '', CEP: '88000000', Telefone1: '', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 1, ativo: true
  });

  // Primeira checagem: nunca sincronizado antes -> importa (agora completo:
  // roteiro/cliente/ordem/logradouro/telefone/complemento, nao so logradouro).
  windowRef.__TAURI__ = {
    core: {
      invoke: async cmd => {
        assert.strictEqual(cmd, 'read_network_logradouros_csv');
        return {
          bytes_base64: csvBase64(['SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua da Rede;10,00;88000000;Fundos;3333-3333;']),
          modified_time_ms: 1000
        };
      }
    }
  };
  const primeira = await syncModule.checkAndImportRoteirosRede(db);
  assert.strictEqual(primeira.checked, true);
  assert.strictEqual(primeira.updated, true);
  const c1 = db.getClienteByIdRota('777');
  assert.strictEqual(c1.logradouro, 'Rua da Rede');
  assert.strictEqual(c1.complemento, 'Fundos');
  assert.strictEqual(c1.telefone1, '3333-3333');

  // Mesmo modified_time_ms -> nao reimporta.
  let invokedDeNovo = false;
  windowRef.__TAURI__.core.invoke = async () => {
    invokedDeNovo = true;
    return {
      bytes_base64: csvBase64(['SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua Errada;10,00;88000000;Errado;0000-0000;']),
      modified_time_ms: 1000
    };
  };
  const segunda = await syncModule.checkAndImportRoteirosRede(db);
  assert.strictEqual(invokedDeNovo, true);
  assert.strictEqual(segunda.updated, false);
  assert.strictEqual(db.getClienteByIdRota('777').logradouro, 'Rua da Rede');

  // modified_time_ms maior -> reimporta de fato.
  windowRef.__TAURI__.core.invoke = async () => ({
    bytes_base64: csvBase64(['SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua Nova Da Rede;10,00;88000000;Fundos;3333-3333;']),
    modified_time_ms: 2000
  });
  const terceira = await syncModule.checkAndImportRoteirosRede(db);
  assert.strictEqual(terceira.updated, true);
  assert.strictEqual(db.getClienteByIdRota('777').logradouro, 'Rua Nova Da Rede');

  // Reordenacao local pendente (roteiro_change_outbox, ainda nao enviada)
  // deve sobreviver a um import do CSV que ainda traz a ordem antiga.
  db.db.run('UPDATE clientes SET ordem = ? WHERE id_rota = ?', [5, '777']);
  db.queueRoteiroChange('777');
  assert.strictEqual(db.getPendingRoteiroChangesCount(), 1);

  windowRef.__TAURI__.core.invoke = async () => ({
    bytes_base64: csvBase64(['SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua Nova Da Rede;10,00;88000000;Fundos;3333-3333;']),
    modified_time_ms: 3000
  });
  const quarta = await syncModule.checkAndImportRoteirosRede(db);
  assert.strictEqual(quarta.updated, true);
  assert.strictEqual(quarta.pulados, 1);
  assert.strictEqual(
    db.getClienteByIdRota('777').ordem, 5,
    'reordenacao local pendente nao deveria ser revertida pelo import do CSV'
  );

  // Envia a alteracao pendente (limpa a fila) e confirma que o proximo import volta a valer.
  db.markRoteiroChangesSent(db.getPendingRoteiroChanges().map(c => c.change_id));
  windowRef.__TAURI__.core.invoke = async () => ({
    bytes_base64: csvBase64(['SAT01-1;777;0;9,00;SAT01;TESTE REDE;Rua Nova Da Rede;10,00;88000000;Fundos;3333-3333;']),
    modified_time_ms: 4000
  });
  const quinta = await syncModule.checkAndImportRoteirosRede(db);
  assert.strictEqual(quinta.pulados, 0);
  assert.strictEqual(db.getClienteByIdRota('777').ordem, 9);

  // Edicao local de cliente pendente (cliente_change_outbox) tambem deve
  // sobreviver a um import do CSV que ainda traz o telefone antigo.
  db.db.run('UPDATE clientes SET telefone1 = ? WHERE id_rota = ?', ['9999-9999', '777']);
  db.queueClienteChange('uuid-777', { Telefone1: '9999-9999' });
  assert.strictEqual(db.getPendingClienteChangesCount(), 1);

  windowRef.__TAURI__.core.invoke = async () => ({
    bytes_base64: csvBase64(['SAT01-1;777;0;9,00;SAT01;TESTE REDE;Rua Nova Da Rede;10,00;88000000;Fundos;1111-1111;']),
    modified_time_ms: 5000
  });
  const sexta = await syncModule.checkAndImportRoteirosRede(db);
  assert.strictEqual(sexta.pulados, 1);
  assert.strictEqual(
    db.getClienteByIdRota('777').telefone1, '9999-9999',
    'edicao de cliente pendente nao deveria ser revertida pelo import do CSV'
  );

  // getLastRotasRedeSyncLabel: reflete os 3 estados possiveis.
  windowRef.__TAURI__ = undefined;
  assert.strictEqual(
    syncModule.getLastRotasRedeSyncLabel(),
    'Sincronização automática só funciona no app instalado'
  );

  windowRef.__TAURI__ = { core: { invoke: async () => ({ bytes_base64: '', modified_time_ms: 0 }) } };
  localStorage.removeItem('app3_last_rotas_rede_sync');
  assert.strictEqual(
    syncModule.getLastRotasRedeSyncLabel(),
    'Dados: nunca sincronizados automaticamente'
  );

  localStorage.setItem('app3_last_rotas_rede_sync', '1735732800000');
  assert.match(
    syncModule.getLastRotasRedeSyncLabel(),
    /^Dados atualizados em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}$/
  );

  // Pasta de rede inacessivel -> erro tratado, sem lancar excecao.
  windowRef.__TAURI__.core.invoke = async () => { throw 'pasta inacessivel'; };
  const falha = await syncModule.checkAndImportRoteirosRede(db);
  assert.strictEqual(falha.checked, true);
  assert.strictEqual(falha.updated, false);
  assert.strictEqual(falha.error, 'pasta inacessivel');

  console.log('checkAndImportRoteirosRede (not-tauri, import completo, idempotencia por modified_time, protege alteracoes pendentes, falha tratada): OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
