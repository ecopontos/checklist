const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function runGas(files, folderId = 'csv-folder') {
  const context = vm.createContext({
    console,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => key === 'DRIVE_FOLDER_ID' ? folderId : 'sheet-id'
    }) },
    DriveApp: { getFolderById: id => {
      assert.equal(id, 'csv-folder');
      let cursor = 0;
      return { getFilesByName: name => {
        assert.equal(name, 'cstExportaCheckList.csv');
        return { hasNext: () => cursor < files.length, next: () => files[cursor++] };
      } };
    } },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: value => ({
        value,
        setMimeType() { return this; }
      })
    }
  });
  vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);
  return context;
}

function csvFile(csv, modifiedTime, encoding = 'utf16le') {
  const bytes = Buffer.from((encoding === 'utf16le' ? '\uFEFF' : '') + csv, encoding);
  return {
    getLastUpdated: () => new Date(modifiedTime),
    getBlob: () => ({
      getBytes: () => [...bytes],
      getDataAsString: charset => bytes.toString(charset === 'UTF-16LE' ? 'utf16le' : 'utf8')
    })
  };
}

const header = 'Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP;Complemento;Telefone1;Telefone2;Tipo de Resíduo';

test('GAS devolve o CSV mais recente do Drive sem alterar colunas ou acentos', () => {
  const oldFile = csvFile(`${header}\nSAT01-1;3;0;1,00;SAT01;Antigo`, '2026-09-01T10:00:00Z');
  const currentCsv = `${header}\nSAT01-1;3;0;1,00;SAT01;CEPON;Rodovia Admar Gonzaga;655,00;88034001;;;;Recicláveis Orgânico (Restos de Alimentos)`;
  const currentFile = csvFile(currentCsv, '2026-09-25T10:00:00Z');
  const gas = runGas([oldFile, currentFile]);

  const response = JSON.parse(gas.doGet({ parameter: { action: 'roteirosCsv' } }).value);
  assert.equal(response.ok, true);
  assert.equal(response.source, 'drive-csv');
  assert.equal(response.apiVersion, 14);
  assert.equal(response.modifiedTime, '2026-09-25T10:00:00.000Z');
  assert.equal(response.content, currentCsv);
  assert.equal(response.encoding, 'UTF-16LE');
});

test('GAS informa configuração ou arquivo ausente sem devolver cadastro vazio', () => {
  const missingConfig = JSON.parse(runGas([], '').doGet({ parameter: { action: 'roteirosCsv' } }).value);
  assert.equal(missingConfig.ok, false);
  assert.match(missingConfig.error, /DRIVE_FOLDER_ID/);

  const missingFile = JSON.parse(runGas([]).doGet({ parameter: { action: 'roteirosCsv' } }).value);
  assert.equal(missingFile.ok, false);
  assert.match(missingFile.error, /cstExportaCheckList\.csv/);
});
