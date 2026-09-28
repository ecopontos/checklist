// Regressão da leitura em blocos de getIntercorrenciasAtuais_.
//
// A função agrega a última coleta de cada ponto em toda a história e passou a
// ler a aba Coletas em blocos (INTERCORRENCIAS_CHUNK_ROWS) para não carregar a
// aba inteira na memória. Este teste prova que dobrar os dados em blocos de
// QUALQUER tamanho produz exatamente o mesmo resultado que a varredura de uma
// vez só (buildIntercorrenciasAtuais_) — inclusive o desempate por posição
// (mesma data, mesmo ponto: a linha mais abaixo vence) quando o par cai em
// blocos diferentes. Também compara o endpoint doGet contra a função pura.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

class RangeMock {
  constructor(sheet, row, column, rows, columns) {
    Object.assign(this, { sheet, row, column, rows, columns });
  }
  getValues() {
    return Array.from({ length: this.rows }, (_, rowOffset) =>
      Array.from({ length: this.columns }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
      )
    );
  }
}

class SheetMock {
  constructor(rows = []) { this.rows = rows; this.rangeCalls = []; }
  getRange(row, column, rows = 1, columns = 1) {
    this.rangeCalls.push({ row, column, rows, columns });
    return new RangeMock(this, row, column, rows, columns);
  }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((max, row) => Math.max(max, row.length), 0); }
}

const sheets = new Map();
const context = vm.createContext({
  console, JSON, Date, Number, String, Boolean, Array, Object, Math, isFinite,
  PropertiesService: {
    getScriptProperties: () => ({ getProperty: key => key === 'SPREADSHEET_ID' ? 'test' : '' })
  },
  SpreadsheetApp: { openById: () => ({ getSheetByName: name => sheets.get(name) || null }) },
  CacheService: { getScriptCache: () => { throw new Error('sem cache neste teste'); } },
  ContentService: {
    MimeType: { JSON: 'json' },
    createTextOutput: value => ({ value, setMimeType() { return this; } })
  },
  Utilities: {
    formatDate: date => date.toISOString().slice(0, 10),
    computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(value, 'utf8').digest()),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' }
  }
});

vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

const header = ['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID'];

// Dataset com todos os casos sensíveis à ordem/fronteira:
// - ponto 1: coleta antiga com intercorrência + coleta nova SEM intercorrência
//   (a mais recente vence => some da fila).
// - ponto 3: duas coletas na MESMA data, a 2ª é a "verdadeira última"
//   (desempate por posição). O par é posicionado para poder ser cortado por um
//   bloco entre as duas linhas.
// - ponto 6: outro par mesma-data, longe do ponto 3, para cobrir múltiplas
//   fronteiras.
// - linhas inválidas (sem idRota / data inválida) e linha vazia contam para
//   quality e não podem deslocar o índice de forma diferente entre os caminhos.
const dataRows = [
  ['1', '2026-09-01', 'A', 'R1', 1, 'Bombona suja', '2026-09-01T12:00:00Z', 'sync-1-old'],
  ['2', '2026-09-03', 'B', 'R2', 0, 'Recusou coleta', '2026-09-03T12:00:00Z', 'sync-2'],
  ['3', '2026-09-04', 'C', 'R3', 1, 'Primeira do dia', '2026-09-04T10:00:00Z', ''],
  ['3', '2026-09-04', 'C', 'R3', 1, 'Última do dia', '2026-09-04T11:00:00Z', ''],
  ['', 'data-invalida', 'D', 'R4', 1, 'Sem id', '', ''],
  ['1', '2026-09-02', 'A', 'R1', 2, '', '2026-09-02T12:00:00Z', 'sync-1-new'],
  ['', '', '', '', '', '', '', ''],
  ['6', '2026-09-05', 'F', 'R6', 3, 'Antes', '2026-09-05T09:00:00Z', 'sync-6a'],
  ['6', '2026-09-05', 'F', 'R6', 3, 'Depois', '2026-09-05T10:00:00Z', 'sync-6b'],
  ['7', 'nao-e-data', 'G', 'R7', 1, 'Descartada', '', 'sync-7']
];

const full = context.buildIntercorrenciasAtuais_([header, ...dataRows]);

// Sanidade da referência: ponto 1 sumiu (última sem intercorrência); ponto 3
// ficou com "Última do dia"; ponto 6 ficou com "Depois".
assert.deepEqual(Array.from(full.data, item => item.idRota).sort(), ['2', '3', '6']);
assert.strictEqual(full.data.find(i => i.idRota === '3').intercorrencia, 'Última do dia');
assert.strictEqual(full.data.find(i => i.idRota === '6').intercorrencia, 'Depois');
assert.strictEqual(full.data.find(i => i.idRota === '6').occurrenceId, 'sync-6b');
assert.strictEqual(full.quality.excludedRecords, 2, 'linha sem idRota + linha com data inválida');
assert.strictEqual(full.quality.invalidDates, 2);
assert.strictEqual(full.quality.missingRouteIds, 1);

// Núcleo: dobrar em blocos de tamanho 1..N+1 dá SEMPRE o mesmo resultado.
function foldInChunks(size) {
  const state = context.newIntercorrenciasState_();
  context.setIntercorrenciasHeader_(state, header);
  for (let start = 0; start < dataRows.length; start += size) {
    context.foldIntercorrenciasRows_(state, dataRows.slice(start, start + size));
  }
  return context.finalizeIntercorrenciasAtuais_(state);
}

for (let size = 1; size <= dataRows.length + 1; size++) {
  const chunked = foldInChunks(size);
  assert.deepStrictEqual(chunked, full, `bloco de tamanho ${size} divergiu da varredura completa`);
}

// O par do ponto 3 está entre os índices 2 e 3 (0-based) das dataRows; um bloco
// de tamanho 3 corta exatamente entre as duas linhas. Já coberto pelo laço
// acima, mas asserção explícita para deixar a intenção clara.
const splitBetweenPair = foldInChunks(3);
assert.strictEqual(
  splitBetweenPair.data.find(i => i.idRota === '3').intercorrencia,
  'Última do dia',
  'desempate por posição deve sobreviver ao corte de bloco entre as duas linhas'
);

// Endpoint: com CHUNK grande cabe em um bloco; força blocos pequenos para
// exercitar o laço de leitura real do doGet e comparar contra a função pura.
context.INTERCORRENCIAS_CHUNK_ROWS = 3;
const sheet = new SheetMock([header, ...dataRows]);
sheets.set('Coletas', sheet);
const response = JSON.parse(context.doGet({ parameter: { action: 'intercorrenciasAtuais' } }).value);
assert.strictEqual(response.ok, true);
assert.strictEqual(response.source, 'intercorrenciasAtuais');
// full vem do realm do vm; response passou por JSON.parse no realm principal.
// Normaliza full pelo mesmo caminho para comparar conteúdo (não protótipos).
const fullJson = JSON.parse(JSON.stringify(full));
assert.deepStrictEqual(response.data, fullJson.data, 'endpoint em blocos deve casar com a função pura');
assert.deepStrictEqual(response.quality, fullJson.quality);

// Confere que realmente leu em blocos (cabeçalho + vários blocos de dados),
// e não a aba inteira de uma vez.
const dataReads = sheet.rangeCalls.filter(call => call.row >= 2);
assert.ok(dataReads.length >= 2, 'esperava múltiplas leituras de dados (uma por bloco)');
assert.ok(dataReads.every(call => call.rows <= 3), 'cada leitura de bloco deve respeitar o CHUNK');

console.log('intercorrenciasAtuais em blocos: equivalente à varredura completa em qualquer fronteira: OK');
