const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Sheet } = require('./gas-mock.cjs');

// Ambiente simulado do Apps Script (planilha, Drive, propriedades) com o
// gas/Code.gs e o gas-teste/PrepararTeste.gs carregados.
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
    Utilities: { getUuid: () => require('node:crypto').randomUUID(), newBlob: (texto, tipo, nome) => ({ texto, tipo, nome }),
      // Só o formato 'yyyy-MM-dd' é usado pelo GAS nas coletas.
      formatDate: date => new Date(date).toISOString().slice(0, 10) },
    DriveApp: { createFolder: () => novaPasta(), getFolderById: id => { if (!folders.has(id)) throw new Error('pasta inexistente'); return folders.get(id); },
      getFileById: () => { throw new Error('sem acesso'); } },
    Logger: { log: m => logs.push(m) } });
  vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);
  vm.runInContext(fs.readFileSync('gas-teste/PrepararTeste.gs', 'utf8'), context);
  return { context, properties, sheets, folders, logs };
}

module.exports = { ambiente };
