# Contrato GAS normalizado de roteiros/clientes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o builder achatado do `action=roteiros` no GAS por um builder **normalizado** (`clientes[]` + `roteiros[]`/`pontos[]`), que o `desktop/logistics` vai consumir como fonte de roteiro/cliente.

**Architecture:** O `doGet` do `gas/Code.gs` já monta a resposta a partir de 3 abas do Sheets (`tblRotas`, `shtClientes`, `tblRoteiros`) via uma função pura testável. Trocamos essa função pura por uma que devolve o shape normalizado do contrato `roteiros/v1`, e ajustamos o envelope (`contract`, `counts`, `apiVersion`). Sem camada de compatibilidade — o builder flat é removido.

**Tech Stack:** Google Apps Script (arquivo `.gs`, ES5), testes Node com `vm` + mocks das APIs do GAS (padrão já usado em `tests/gas-*.test.cjs`), `assert` nativo.

## Global Constraints

- **Sem back-compat:** o `desktop/logistics` está em desenvolvimento; não preservar o formato flat antigo. (Premissa: o standalone em campo puxa roteiro do CSV de rede, não do GAS `action=roteiros`.)
- **Identidade v1:** `idUnico` (= `shtClientes.idUnico2`, legado) é a chave de junção; campo `uuid` sempre `null` (UUIDv7 vem depois, na ADR-091).
- **Formato:** normalizado — `clientes[]` deduplicado + `roteiros[]` com `pontos[]`.
- **Chaves JSON ascii minúsculas** (`numero`, `cep`, `telefone1`…), não `Número`/`Telefone1`.
- **Snapshot completo** com `modifiedTime`; sem delta/cursor/tombstones.
- **Tipo de Resíduo fora do contrato:** o resíduo é configurado client-side (`config.js`), não trafega no snapshot; o builder normalizado **não** lê `Tipo de Resíduo`.
- **Leitura defensiva** de `logradouro`: se a coluna não existir em `shtClientes`, o campo sai `""` — nunca quebra.
- Contrato de referência: `docs/superpowers/specs/2026-09-15-gas-contrato-logistica-roteiros-design.md`.
- Reaproveitar os helpers já existentes `cleanIntString_` e `formatPhone_` (não reimplementar).

---

## Task 1: Builder puro normalizado + teste unitário

**Files:**
- Modify: `gas/Code.gs` — substituir a função `buildFlatRoteiros_` (linhas ~158–226) por `buildRoteirosNormalizados_`.
- Create: `tests/gas-roteiros-normalizado.test.cjs`
- Modify: `package.json` — registrar o novo teste no script `test`.

**Interfaces:**
- Consumes: helpers já existentes em `Code.gs`: `cleanIntString_(val) -> string`, `formatPhone_(val) -> string`.
- Produces: `buildRoteirosNormalizados_(rotasValues, clientesValues, roteirosValues) -> { clientes: Array<{idUnico, uuid, cliente, logradouro, numero, cep, complemento, telefone1, telefone2}>, roteiros: Array<{roteiro, pontos: Array<{idRota, idUnico, ordem, inativo}>}>, skipped: number }`. Função pura (sem chamadas ao Sheets), acessível no teste como `context.buildRoteirosNormalizados_`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `tests/gas-roteiros-normalizado.test.cjs`:

```javascript
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = vm.createContext({
  console, JSON, Date, Number, String, Boolean, Array, Object, Math, isNaN
});
vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

// Matrizes como getValues() devolveria (linha 0 = cabeçalho).
const rotas = [
  ['idRota', 'idPJ', 'idRoteiro', 'Ordem', 'Inativo'],
  ['3', '100', '10', '1,00', 0],   // ok
  ['6', '101', '10', '5,00', 0],   // ok, mesmo roteiro
  ['7', '999', '10', '6,00', 0],   // idPJ sem cliente -> skipped
  ['8', '102', '20', '2,00', 1]    // outro roteiro, inativo=1
];
const clientes = [
  ['idPJ', 'idUnico2', 'Cliente', 'logradouro', 'Número', 'CEP', 'Complemento', 'Telefone1', 'Telefone2'],
  ['100', 'U-100', 'CEPON', 'Rodovia Admar Gonzaga', '655,00', 88034001, '', '', ''],
  ['101', 'U-101', 'BIARRITZ', 'Rua Pastor', '504,00', 88034100, '', 48984097003, ''],
  ['102', 'U-102', 'VILLA', 'Rua Pastor', '655,00', 88034100, 'fundos', '', ''],
  ['103', '', 'SEM IDUNICO', 'Rua X', '10', 88000000, '', '', '']  // sem idUnico2, nunca referenciado
];
const roteiros = [
  ['idRoteiro', 'Roteiro'],
  ['10', 'SAT01'],
  ['20', 'SAT02']
];

const out = context.buildRoteirosNormalizados_(rotas, clientes, roteiros);

assert.strictEqual(out.skipped, 1, 'ponto com idPJ sem cliente deve entrar em skipped');

assert.strictEqual(out.clientes.length, 3, 'só clientes referenciados por pontos válidos');
const cep = out.clientes.find(c => c.idUnico === 'U-100');
assert.ok(cep, 'cliente U-100 presente');
assert.strictEqual(cep.uuid, null, 'uuid reservado sempre null na v1');
assert.strictEqual(cep.cliente, 'CEPON');
assert.strictEqual(cep.logradouro, 'Rodovia Admar Gonzaga', 'logradouro emitido quando a coluna existe');
assert.strictEqual(cep.numero, '655', 'número limpo do ",00"');
assert.strictEqual(cep.cep, '88034001', 'cep limpo do ".0"');

const biarritz = out.clientes.find(c => c.idUnico === 'U-101');
assert.strictEqual(biarritz.telefone1, '48984097003', 'telefone limpo do artefato ,00/.0');

assert.strictEqual(out.roteiros.length, 2);
const sat01 = out.roteiros.find(r => r.roteiro === 'SAT01');
assert.strictEqual(sat01.pontos.length, 2, 'SAT01 tem 2 pontos válidos');
assert.ok(!('tipoResiduo' in sat01), 'resíduo não faz parte do contrato GAS');
const p3 = sat01.pontos.find(p => p.idRota === '3');
assert.strictEqual(p3.idUnico, 'U-100', 'FK do ponto resolve para clientes[]');
assert.strictEqual(p3.ordem, 1, 'ordem numérica convertida de "1,00"');
assert.strictEqual(p3.inativo, 0);

const sat02 = out.roteiros.find(r => r.roteiro === 'SAT02');
assert.strictEqual(sat02.pontos[0].inativo, 1, 'inativo=1 preservado');

const idsClientes = new Set(out.clientes.map(c => c.idUnico));
out.roteiros.forEach(r => r.pontos.forEach(p => {
  assert.ok(idsClientes.has(p.idUnico), 'ponto ' + p.idRota + ' referencia cliente inexistente');
}));

// logradouro ausente na aba -> "" (leitura defensiva)
const clientesSemLograd = [
  ['idPJ', 'idUnico2', 'Cliente', 'Número', 'CEP', 'Complemento', 'Telefone1', 'Telefone2'],
  ['100', 'U-100', 'CEPON', '655,00', 88034001, '', '', '']
];
const rotasMin = [
  ['idRota', 'idPJ', 'idRoteiro', 'Ordem', 'Inativo'],
  ['3', '100', '10', '1,00', 0]
];
const out2 = context.buildRoteirosNormalizados_(rotasMin, clientesSemLograd, roteiros);
assert.strictEqual(out2.clientes[0].logradouro, '', 'logradouro vira "" quando a coluna não existe');

console.log('buildRoteirosNormalizados_: dedup, FK, skipped, limpeza, logradouro defensivo: OK');
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node tests/gas-roteiros-normalizado.test.cjs`
Expected: FAIL — `TypeError: context.buildRoteirosNormalizados_ is not a function` (a função ainda não existe; só há `buildFlatRoteiros_`).

- [ ] **Step 3: Substituir `buildFlatRoteiros_` por `buildRoteirosNormalizados_`**

Em `gas/Code.gs`, apagar a função `buildFlatRoteiros_` inteira (do comentário em ~linha 155 até o `}` de fechamento em ~linha 226) e colocar no lugar:

```javascript
// Função pura (sem chamadas ao Sheets), testável: recebe as matrizes de
// getValues() das 3 abas (tblRotas, shtClientes, tblRoteiros) e devolve a
// visão normalizada { clientes, roteiros, skipped } do contrato roteiros/v1.
// Junta tblRotas -> cliente por idPJ e -> roteiro por idRoteiro; emite cliente
// deduplicado por idUnico (= idUnico2). logradouro é lido defensivamente
// (coluna a confirmar na aba real; "" se ausente). Tipo de Resíduo NÃO faz
// parte do contrato — é config client-side.
function buildRoteirosNormalizados_(rotasValues, clientesValues, roteirosValues) {
    if (!rotasValues || rotasValues.length < 2) {
        return { clientes: [], roteiros: [], skipped: 0 };
    }

    function headerMap_(headers) {
        var map = {};
        for (var i = 0; i < headers.length; i++) {
            var col = String(headers[i]).trim();
            if (col) map[col] = i;
        }
        return map;
    }

    var mapRotas = headerMap_(rotasValues[0]);
    var mapClientes = headerMap_(clientesValues[0]);
    var mapRoteiros = headerMap_(roteirosValues[0]);

    var colLogradouro = mapClientes['logradouro'];
    var clientesByIdPJ = {};
    for (var c = 1; c < clientesValues.length; c++) {
        var rowC = clientesValues[c];
        var keyPJ = cleanIntString_(rowC[mapClientes['idPJ']]);
        if (!keyPJ) continue;
        clientesByIdPJ[keyPJ] = {
            idUnico: String(rowC[mapClientes['idUnico2']] || '').trim(),
            uuid: null,
            cliente: String(rowC[mapClientes['Cliente']] || '').trim(),
            logradouro: colLogradouro === undefined ? '' : String(rowC[colLogradouro] || '').trim(),
            numero: cleanIntString_(rowC[mapClientes['Número']]),
            cep: cleanIntString_(rowC[mapClientes['CEP']]),
            complemento: String(rowC[mapClientes['Complemento']] || '').trim(),
            telefone1: formatPhone_(rowC[mapClientes['Telefone1']]),
            telefone2: formatPhone_(rowC[mapClientes['Telefone2']])
        };
    }

    var roteirosById = {};
    for (var t = 1; t < roteirosValues.length; t++) {
        var rowT = roteirosValues[t];
        var keyRoteiro = cleanIntString_(rowT[mapRoteiros['idRoteiro']]);
        if (!keyRoteiro) continue;
        roteirosById[keyRoteiro] = String(rowT[mapRoteiros['Roteiro']] || '').trim();
    }

    var clientesByIdUnico = {};
    var gruposByRoteiro = {};
    var ordemGrupos = [];
    var skipped = 0;

    for (var r = 1; r < rotasValues.length; r++) {
        var rowR = rotasValues[r];
        var cliente = clientesByIdPJ[cleanIntString_(rowR[mapRotas['idPJ']])];

        // Ponto sem cliente, sem nome, ou sem idUnico (a FK do contrato): descarta.
        if (!cliente || !cliente.cliente || !cliente.idUnico) { skipped++; continue; }

        var nomeRoteiro = roteirosById[cleanIntString_(rowR[mapRotas['idRoteiro']])] || '';

        if (!gruposByRoteiro[nomeRoteiro]) {
            gruposByRoteiro[nomeRoteiro] = { roteiro: nomeRoteiro, pontos: [] };
            ordemGrupos.push(nomeRoteiro);
        }

        var ordemVal = rowR[mapRotas['Ordem']];
        var inativoVal = rowR[mapRotas['Inativo']];

        gruposByRoteiro[nomeRoteiro].pontos.push({
            idRota: cleanIntString_(rowR[mapRotas['idRota']]),
            idUnico: cliente.idUnico,
            ordem: (ordemVal !== '' && ordemVal !== null && !isNaN(ordemVal)) ? Number(ordemVal) : 0,
            inativo: (inativoVal === true || String(inativoVal).trim() === '1' || String(inativoVal).toLowerCase() === 'true') ? 1 : 0
        });

        clientesByIdUnico[cliente.idUnico] = cliente;
    }

    var clientes = [];
    for (var k in clientesByIdUnico) {
        if (Object.prototype.hasOwnProperty.call(clientesByIdUnico, k)) {
            clientes.push(clientesByIdUnico[k]);
        }
    }

    var roteiros = ordemGrupos.map(function (nome) { return gruposByRoteiro[nome]; });

    return { clientes: clientes, roteiros: roteiros, skipped: skipped };
}
```

Nota: `getRoteirosFlat_` (que ainda chama `buildFlatRoteiros_`) fica quebrada ao fim deste passo — é consertada na Task 2. Isso é aceitável entre tarefas; o teste desta task exercita só a função pura.

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node tests/gas-roteiros-normalizado.test.cjs`
Expected: PASS — imprime `buildRoteirosNormalizados_: ... : OK`.

- [ ] **Step 5: Registrar o teste no `package.json`**

Em `package.json`, no script `test`, acrescentar ao final da cadeia (antes das aspas de fechamento):

```
 && node tests/gas-roteiros-normalizado.test.cjs
```

- [ ] **Step 6: Commit**

```bash
git add gas/Code.gs tests/gas-roteiros-normalizado.test.cjs package.json
git commit -m "feat(gas): builder normalizado de roteiros/clientes (contrato roteiros/v1)"
```

---

## Task 2: Envelope `roteiros/v1` + wiring no `doGet` + apiVersion

**Files:**
- Modify: `gas/Code.gs` — substituir `getRoteirosFlat_` por `getRoteirosNormalizados_`; atualizar a chamada no `doGet`; subir `GAS_API_VERSION` de `8` para `9`.
- Modify: `tests/gas-roteiros-normalizado.test.cjs` — anexar os asserts de envelope via `doGet`.

**Interfaces:**
- Consumes: `buildRoteirosNormalizados_` (Task 1); helpers `getConfig_`, `jsonResponse_`; constantes `TBL_ROTAS`, `TBL_CLIENTES`, `TBL_ROTEIROS`, `GAS_API_VERSION`.
- Produces: `getRoteirosNormalizados_() -> ContentService JSON` com envelope `{ ok, apiVersion, contract:"roteiros/v1", modifiedTime, counts:{clientes,roteiros,pontos}, skipped, clientes, roteiros }`; e `doGet` roteando `action=roteiros` (e default) para ela.

- [ ] **Step 1: Anexar o teste de envelope que falha**

Ao final de `tests/gas-roteiros-normalizado.test.cjs`, acrescentar:

```javascript
// --- Envelope via doGet(action=roteiros) ---
function sheetMock(rows) {
  return { getDataRange: () => ({ getValues: () => rows }) };
}
const sheetsMap = new Map([
  ['tblRotas', sheetMock(rotas)],
  ['shtClientes', sheetMock(clientes)],
  ['tblRoteiros', sheetMock(roteiros)]
]);
context.PropertiesService = {
  getScriptProperties: () => ({ getProperty: k => ({ SPREADSHEET_ID: 'sheet-test' })[k] || '' })
};
context.SpreadsheetApp = { openById: () => ({ getSheetByName: n => sheetsMap.get(n) || null }) };
context.DriveApp = { getFileById: () => ({ getLastUpdated: () => new Date('2026-09-15T12:00:00Z') }) };
context.ContentService = {
  MimeType: { JSON: 'json' },
  createTextOutput: value => ({ value, setMimeType() { return this; } })
};

const resp = JSON.parse(context.doGet({ parameter: { action: 'roteiros' } }).value);
assert.strictEqual(resp.ok, true);
assert.strictEqual(resp.contract, 'roteiros/v1');
assert.strictEqual(resp.apiVersion, 9, 'apiVersion deve ter subido para 9');
assert.strictEqual(resp.modifiedTime, '2026-09-15T12:00:00.000Z');
assert.strictEqual(resp.counts.clientes, 3);
assert.strictEqual(resp.counts.roteiros, 2);
assert.strictEqual(resp.counts.pontos, 3);
assert.strictEqual(resp.skipped, 1);
assert.ok(Array.isArray(resp.clientes) && Array.isArray(resp.roteiros));
assert.strictEqual(resp.clientes[0].uuid, null);

// default (sem action) também cai no snapshot normalizado
const respDefault = JSON.parse(context.doGet({ parameter: {} }).value);
assert.strictEqual(respDefault.contract, 'roteiros/v1');

console.log('doGet(action=roteiros): envelope roteiros/v1, counts, apiVersion 9: OK');
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node tests/gas-roteiros-normalizado.test.cjs`
Expected: FAIL — o envelope ainda é o antigo (`getRoteirosFlat_` referencia `buildFlatRoteiros_`, agora inexistente → `ReferenceError`, ou `contract`/`counts` ausentes).

- [ ] **Step 3: Subir o `apiVersion`**

Em `gas/Code.gs` linha 35, trocar:

```javascript
var GAS_API_VERSION = 8;
```
por
```javascript
var GAS_API_VERSION = 9;
```

- [ ] **Step 4: Substituir `getRoteirosFlat_` por `getRoteirosNormalizados_`**

Em `gas/Code.gs`, substituir a função `getRoteirosFlat_` inteira (do comentário em ~linha 97 até o `}` em ~linha 153) por:

```javascript
// Lê tblRotas + shtClientes + tblRoteiros e devolve o snapshot normalizado
// (contrato roteiros/v1) que o desktop/logistics consome. Substitui o antigo
// formato achatado.
function getRoteirosNormalizados_() {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }

    var ss;
    try {
        ss = SpreadsheetApp.openById(config.spreadsheetId);
    } catch (err) {
        return jsonResponse_({ ok: false, error: 'Não foi possível abrir a planilha ' + config.spreadsheetId + ': ' + err.message });
    }

    var sheetRotas = ss.getSheetByName(TBL_ROTAS);
    var sheetClientes = ss.getSheetByName(TBL_CLIENTES);
    var sheetRoteiros = ss.getSheetByName(TBL_ROTEIROS);

    var missing = [];
    if (!sheetRotas) missing.push(TBL_ROTAS);
    if (!sheetClientes) missing.push(TBL_CLIENTES);
    if (!sheetRoteiros) missing.push(TBL_ROTEIROS);
    if (missing.length) {
        return jsonResponse_({ ok: false, error: 'Aba(s) não encontrada(s): ' + missing.join(', ') });
    }

    try {
        var norm = buildRoteirosNormalizados_(
            sheetRotas.getDataRange().getValues(),
            sheetClientes.getDataRange().getValues(),
            sheetRoteiros.getDataRange().getValues()
        );

        var pontos = 0;
        for (var i = 0; i < norm.roteiros.length; i++) pontos += norm.roteiros[i].pontos.length;

        // "Só reimporta quando muda": data de modificação da planilha.
        var modifiedTime;
        try {
            modifiedTime = DriveApp.getFileById(config.spreadsheetId).getLastUpdated().toISOString();
        } catch (e) {
            modifiedTime = new Date().toISOString();
        }

        return jsonResponse_({
            ok: true,
            apiVersion: GAS_API_VERSION,
            contract: 'roteiros/v1',
            modifiedTime: modifiedTime,
            counts: { clientes: norm.clientes.length, roteiros: norm.roteiros.length, pontos: pontos },
            skipped: norm.skipped,
            clientes: norm.clientes,
            roteiros: norm.roteiros
        });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}
```

- [ ] **Step 5: Apontar o `doGet` para a nova função**

Em `gas/Code.gs` (~linha 92–94), substituir:

```javascript
    // Fonte de roteiros: antes um CSV no Drive (exportado do Access), agora
    // montada direto das abas do Sheets. Vale como action=roteiros e como padrão.
    return getRoteirosFlat_();
```
por
```javascript
    // Fonte de roteiros: snapshot normalizado (contrato roteiros/v1) montado das
    // abas do Sheets. Vale como action=roteiros e como padrão.
    return getRoteirosNormalizados_();
```

- [ ] **Step 6: Rodar o teste e confirmar que passa**

Run: `node tests/gas-roteiros-normalizado.test.cjs`
Expected: PASS — imprime tanto a linha do builder quanto `doGet(action=roteiros): ... : OK`.

- [ ] **Step 7: Commit**

```bash
git add gas/Code.gs tests/gas-roteiros-normalizado.test.cjs
git commit -m "feat(gas): envelope roteiros/v1 no doGet e apiVersion 9"
```

---

## Task 3: Verificação da suíte completa e checagem de consumidores

**Files:** Nenhum modificado — verificação. Se surgir falha, consertar no arquivo relevante das Tasks 1–2 e re-rodar.

**Interfaces:** Nenhuma.

- [ ] **Step 1: Rodar a suíte inteira**

Run: `npm test`
Expected: PASS em todos os testes da cadeia, incluindo `tests/gas-roteiros-normalizado.test.cjs`. Nenhum teste deve assertar `apiVersion === 8` (a mudança para 9 não pode quebrar `action=status` nem outros).

- [ ] **Step 2: Confirmar que nenhum código-cliente depende do formato flat antigo**

Run: `grep -rn "action=roteiros\|getRoteirosFlat_\|buildFlatRoteiros_" --include=*.js --include=*.html --include=*.cjs .`
Expected: as únicas ocorrências de `getRoteirosFlat_`/`buildFlatRoteiros_` são as que acabamos de remover (nenhuma restante fora de docs). Se algum HTML/JS cliente consumir `action=roteiros` esperando o array flat `rows[...]`, anotar no relatório — pela premissa do plano não há consumidor de produção, mas um consumidor inesperado precisa ser sinalizado, não silenciado.

- [ ] **Step 3: Relatar resultados**

Resumir pass/fail de cada checagem. Registrar explicitamente as 3 dependências abertas que ficaram resolvidas de forma defensiva e ainda precisam de confirmação contra o Sheets real na hora do deploy:
1. `logradouro` existe em `shtClientes`? (se não, sai `""`)
2. `idUnico2` preenchido para todos os clientes? (pontos sem ele caem em `skipped`)

Sem commit nesta task, salvo se uma checagem exigir correção.

---

## Notas de deploy (fora do escopo de código)

Após o merge, o GAS precisa ser **reimplantado** (nova versão do Web App) para o `action=roteiros` passar a devolver o formato normalizado — mudanças em `.gs` não entram em produção sem redeploy. O consumidor `desktop/logistics` (ingestão do snapshot) é uma spec/plano separado.
