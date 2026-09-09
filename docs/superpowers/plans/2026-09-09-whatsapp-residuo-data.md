# Disparo WhatsApp — tags {residuo} e {data} Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Na mensagem de disparo WhatsApp, permitir citar o tipo de resíduo do roteiro (`{residuo}`) e a data da coleta com intercorrência (`{data}`), além das tags `{nome}`/`{intercorrencia}` já existentes.

**Architecture:** `tblRoteiros` na planilha ganha uma coluna "Tipo de Resíduo" (cadastro manual, um valor por roteiro). `buildFlatRoteiros_` em `gas/Code.gs` passa a incluir esse valor nas linhas achatadas que alimentam `action=roteiros`. `database.js` grava esse valor por roteiro (`roteiros.tipo_residuo`) a cada sync e o expõe em `getRoteiros()`/`getContatosWhatsapp()`. `whatsapp-sender.html` usa esse campo, mais o campo `data` já buscado por `getIntercorrenciasRoteiro` (feature anterior), para preencher as duas novas tags em `buildMsg()`.

**Tech Stack:** Google Apps Script (`gas/Code.gs`), ES modules (`database.js`, `whatsapp-sender.html`), Node `vm` module para testes.

## Global Constraints

- `gas/Code.gs` é testável via `vm.runInContext` com mocks de `SpreadsheetApp`/`PropertiesService`/`ContentService`/`CacheService` — ver `tests/gas-route-queue.test.cjs`. Para funções puras como `buildFlatRoteiros_`, não é preciso mockar `SpreadsheetApp` (a função só recebe arrays já extraídos).
- Testes de `database.js` seguem o padrão de `tests/whatsapp-contatos.test.cjs`/`tests/import-logradouros.test.cjs`: `vm.SourceTextModule` carregando `database.js` num contexto com `initSqlJs`/`localStorage`/`crypto` mockados.
- Mudanças em `gas/Code.gs` exigem **redeploy manual do Apps Script pelo usuário** — não testável nem automatizável por este repositório.
- A coluna "Tipo de Resíduo" em `tblRoteiros` é preenchida manualmente pelo usuário direto na planilha — não é escrita por nenhum código deste plano.
- Novos testes entram na cadeia do script `test` em `package.json` (`node --experimental-vm-modules tests/<nome>.test.cjs` para módulos ES, `node tests/<nome>.test.cjs` para o teste de `Code.gs`, que não usa ES modules).
- `whatsapp-sender.html` não tem framework de teste de UI automatizado — verificação da Task 4 é manual, no navegador, com Playwright MCP e `fetch` stubado (não há GAS real disponível no ambiente de teste).

---

## Task 1: `buildFlatRoteiros_` inclui Tipo de Resíduo por roteiro

**Files:**
- Modify: `gas/Code.gs`
  - `var GAS_API_VERSION = 7;` (linha 35) → `8`
  - `buildFlatRoteiros_` (linhas 190-221): montagem de `roteirosById` e do `rows.push`
- Test: `tests/gas-roteiro-tipo-residuo.test.cjs`

**Interfaces:**
- Produces: cada linha achatada devolvida por `buildFlatRoteiros_` (e, por extensão, por `getRoteirosFlat_`/`action=roteiros`) ganha o campo `TipoResiduo: string`. Consumido por `database.js` (`importRoteirosRows`, Task 2).

- [ ] **Step 1: Escrever o teste (falhando)**

Criar `tests/gas-roteiro-tipo-residuo.test.cjs`:

```js
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const context = vm.createContext({
  console, JSON, Date, Number, String, Boolean, Array, Object, Math, isNaN
});

vm.runInContext(fs.readFileSync('gas/Code.gs', 'utf8'), context);

const rotasValues = [
  ['idPJ', 'idRota', 'idRoteiro', 'Ordem', 'Inativo'],
  ['100', '2912', '1', '1', '0'],
  ['200', '2967', '1', '2', '0']
];

const clientesValues = [
  ['idPJ', 'idUnico2', 'Cliente', 'Número', 'Complemento', 'CEP', 'Telefone1', 'Telefone2'],
  ['100', 'uuid-1', 'CLIENTE UM', '10', '', '88000000', '48999990000', ''],
  ['200', 'uuid-2', 'CLIENTE DOIS', '20', '', '88000000', '48988880000', '']
];

const roteirosValues = [
  ['idRoteiro', 'Roteiro', 'Tipo de Resíduo'],
  ['1', 'SV07', 'Vidro']
];

const result = context.buildFlatRoteiros_(rotasValues, clientesValues, roteirosValues);

assert.strictEqual(result.rows.length, 2);
assert.strictEqual(result.rows[0].Roteiro, 'SV07');
assert.strictEqual(result.rows[0].TipoResiduo, 'Vidro', 'linha achatada deve trazer o tipo de residuo do roteiro');
assert.strictEqual(result.rows[1].TipoResiduo, 'Vidro', 'mesmo roteiro para os dois clientes -> mesmo tipo de residuo');

// Roteiro sem a coluna "Tipo de Resíduo" preenchida na planilha: nao deve
// falhar, so vem vazio.
const roteirosSemColuna = [
  ['idRoteiro', 'Roteiro'],
  ['1', 'SV07']
];
const resultSemColuna = context.buildFlatRoteiros_(rotasValues, clientesValues, roteirosSemColuna);
assert.strictEqual(resultSemColuna.rows[0].TipoResiduo, '', 'sem a coluna Tipo de Residuo, campo deve vir vazio, sem lancar erro');

console.log('buildFlatRoteiros_: propaga TipoResiduo por roteiro, tolera coluna ausente: OK');
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node tests/gas-roteiro-tipo-residuo.test.cjs`
Expected: FAIL — `result.rows[0].TipoResiduo` é `undefined`, pois `buildFlatRoteiros_` ainda não lê essa coluna.

- [ ] **Step 3: Bumpar `GAS_API_VERSION`**

Em `gas/Code.gs`, linha 35:
```js
var GAS_API_VERSION = 7;
```
vira:
```js
var GAS_API_VERSION = 8;
```

- [ ] **Step 4: Implementar a propagação de `TipoResiduo`**

Em `gas/Code.gs`, dentro de `buildFlatRoteiros_`, substituir o laço que monta `roteirosById` (linhas 190-196):

```js
    var roteirosById = {};
    for (var t = 1; t < roteirosValues.length; t++) {
        var rowT = roteirosValues[t];
        var keyRoteiro = cleanIntString_(rowT[mapRoteiros['idRoteiro']]);
        if (!keyRoteiro) continue;
        roteirosById[keyRoteiro] = String(rowT[mapRoteiros['Roteiro']] || '').trim();
    }
```

por:

```js
    var roteirosById = {};
    for (var t = 1; t < roteirosValues.length; t++) {
        var rowT = roteirosValues[t];
        var keyRoteiro = cleanIntString_(rowT[mapRoteiros['idRoteiro']]);
        if (!keyRoteiro) continue;
        roteirosById[keyRoteiro] = {
            nome: String(rowT[mapRoteiros['Roteiro']] || '').trim(),
            tipoResiduo: String(rowT[mapRoteiros['Tipo de Resíduo']] || '').trim()
        };
    }
```

E o `rows.push` (linhas 210-221), trocar a linha do campo `Roteiro`:

```js
        rows.push({
            Roteiro: roteirosById[cleanIntString_(rowR[mapRotas['idRoteiro']])] || '',
```

por:

```js
        var roteiroInfo = roteirosById[cleanIntString_(rowR[mapRotas['idRoteiro']])] || { nome: '', tipoResiduo: '' };
        rows.push({
            Roteiro: roteiroInfo.nome,
            TipoResiduo: roteiroInfo.tipoResiduo,
```

(mantém as demais linhas do objeto — `idCliente`, `Cliente`, `idRota`, `Ordem`, `Número`, `Complemento`, `CEP`, `Inativo` — sem alteração.)

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `node tests/gas-roteiro-tipo-residuo.test.cjs`
Expected: PASS — imprime `buildFlatRoteiros_: propaga TipoResiduo por roteiro, tolera coluna ausente: OK`

- [ ] **Step 6: Adicionar o teste à cadeia do script `test`**

Em `package.json`, `scripts.test`, adicionar ` && node tests/gas-roteiro-tipo-residuo.test.cjs` ao final.

- [ ] **Step 7: Rodar a suíte completa**

Run: `npm test`
Expected: todos os testes passam, incluindo o novo.

- [ ] **Step 8: Commit**

```bash
git add gas/Code.gs tests/gas-roteiro-tipo-residuo.test.cjs package.json
git commit -m "feat(gas): buildFlatRoteiros_ propaga Tipo de Residuo por roteiro"
```

**Notas para produção (não automatizáveis por este repositório):**
1. Adicionar coluna "Tipo de Resíduo" na aba `tblRoteiros` da planilha e preencher manualmente. Sugestão baseada nos roteiros existentes hoje: `SAT01`, `SAT02`, `SAT03`, `SAT04`, `SAT05`, `SatEpan`, `SOBI-C-01`, `SOBI-C-02`, `SOBI-C-03`, `ESCOLA-ORGANICO-1`, `ESCOLA-ORGANICO-2` → `Organicos`; `SV01` a `SV08` → `Vidro`.
2. Reimplantar o Apps Script (Deploy > Manage deployments > editar a implantação existente) com o `gas/Code.gs` atualizado.

---

## Task 2: `database.js` — cadastro de `tipo_residuo` por roteiro

**Files:**
- Modify: `database.js`
  - `migrateSchema()` (linhas 36-52): adicionar migração da tabela `roteiros`
  - `addRoteiro` (linhas 134-137): upsert com `tipo_residuo`
  - `getRoteiros` (linhas 139-142): expõe `tipo_residuo`
  - `importRoteirosRows` (linhas 353-424 aprox.): propaga `TipoResiduo` por roteiro único
- Test: `tests/import-roteiro-tipo-residuo.test.cjs`

**Interfaces:**
- Consumes: linhas achatadas com campo `TipoResiduo` (Task 1).
- Produces: `db.getRoteiros() => [{ id, nome, tipo_residuo }, ...]`. Consumido por `getContatosWhatsapp` (Task 3).

- [ ] **Step 1: Escrever o teste (falhando)**

Criar `tests/import-roteiro-tipo-residuo.test.cjs`:

```js
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
  const context = vm.createContext({
    console, localStorage, globalThis: null,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    Uint8Array, TextEncoder, TextDecoder, setTimeout, clearTimeout,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    })
  });
  context.globalThis = context;
  return context;
}

async function loadModule(context, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: filename });
  await module.link(() => { throw new Error(`Import inesperado em ${filename}`); });
  await module.evaluate();
  return module.namespace;
}

(async () => {
  const context = createContext();
  const databaseModule = await loadModule(context, 'database.js');
  const db = databaseModule.default;
  await db.init();

  // addRoteiro grava o tipo de residuo, e um segundo addRoteiro com o mesmo
  // nome ATUALIZA o valor (upsert) em vez de ser ignorado.
  db.addRoteiro('SV07', 'Vidro');
  let roteiro = db.getRoteiros().find(r => r.nome === 'SV07');
  assert.strictEqual(roteiro.tipo_residuo, 'Vidro');

  db.addRoteiro('SV07', 'Organicos');
  roteiro = db.getRoteiros().find(r => r.nome === 'SV07');
  assert.strictEqual(roteiro.tipo_residuo, 'Organicos', 'segundo addRoteiro deve atualizar o tipo de residuo (upsert, nao INSERT OR IGNORE)');

  // addRoteiro sem segundo parametro (import de CSV legado, sem essa coluna)
  // nao deve lancar erro, e deve gravar string vazia.
  db.addRoteiro('ROTA_SEM_TIPO');
  const roteiroSemTipo = db.getRoteiros().find(r => r.nome === 'ROTA_SEM_TIPO');
  assert.strictEqual(roteiroSemTipo.tipo_residuo, '');

  console.log('addRoteiro/getRoteiros: upsert de tipo_residuo por nome: OK');

  // importRoteirosRows propaga TipoResiduo da primeira linha de cada roteiro
  // unico (linhas 2 e 3 sao do mesmo roteiro SAT01).
  db.importRoteirosRows([
    { Roteiro: 'SAT01', TipoResiduo: 'Organicos', idRota: '10', idCliente: 'c10', Cliente: 'CLIENTE A', Ordem: 1, Inativo: 0 },
    { Roteiro: 'SAT01', TipoResiduo: 'Organicos', idRota: '11', idCliente: 'c11', Cliente: 'CLIENTE B', Ordem: 2, Inativo: 0 },
    { Roteiro: 'SV01', TipoResiduo: 'Vidro', idRota: '12', idCliente: 'c12', Cliente: 'CLIENTE C', Ordem: 1, Inativo: 0 }
  ]);

  const sat01 = db.getRoteiros().find(r => r.nome === 'SAT01');
  const sv01 = db.getRoteiros().find(r => r.nome === 'SV01');
  assert.strictEqual(sat01.tipo_residuo, 'Organicos');
  assert.strictEqual(sv01.tipo_residuo, 'Vidro');

  console.log('importRoteirosRows: propaga TipoResiduo por roteiro unico: OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --experimental-vm-modules tests/import-roteiro-tipo-residuo.test.cjs`
Expected: FAIL — `roteiro.tipo_residuo` é `undefined` (coluna não existe ainda) ou erro de SQL.

- [ ] **Step 3: Migração de schema**

Em `database.js`, dentro de `migrateSchema()` (depois do bloco que já existe para `clientes`, antes do fechamento do método):

```js
    migrateSchema() {
        const cols = this._tableColumns('clientes');
        if (!cols.length) return;
        const adds = [];
        if (!cols.includes('id_cliente')) adds.push('id_cliente TEXT');
        if (!cols.includes('complemento')) adds.push('complemento TEXT');
        if (!cols.includes('telefone1')) adds.push('telefone1 TEXT');
        if (!cols.includes('telefone2')) adds.push('telefone2 TEXT');
        if (!adds.length) return;

        const addedIdCliente = adds.some(def => def.startsWith('id_cliente'));
        adds.forEach(def => this.db.run(`ALTER TABLE clientes ADD COLUMN ${def}`));
        if (addedIdCliente) {
            localStorage.removeItem('app3_last_drive_sync');
        }
        this.save();
    }
```

vira (adiciona um segundo bloco de migração, para `roteiros`, ao final do método):

```js
    migrateSchema() {
        const cols = this._tableColumns('clientes');
        if (cols.length) {
            const adds = [];
            if (!cols.includes('id_cliente')) adds.push('id_cliente TEXT');
            if (!cols.includes('complemento')) adds.push('complemento TEXT');
            if (!cols.includes('telefone1')) adds.push('telefone1 TEXT');
            if (!cols.includes('telefone2')) adds.push('telefone2 TEXT');
            if (adds.length) {
                const addedIdCliente = adds.some(def => def.startsWith('id_cliente'));
                adds.forEach(def => this.db.run(`ALTER TABLE clientes ADD COLUMN ${def}`));
                if (addedIdCliente) {
                    localStorage.removeItem('app3_last_drive_sync');
                }
                this.save();
            }
        }

        const roteirosCols = this._tableColumns('roteiros');
        if (roteirosCols.length && !roteirosCols.includes('tipo_residuo')) {
            this.db.run('ALTER TABLE roteiros ADD COLUMN tipo_residuo TEXT');
            this.save();
        }
    }
```

- [ ] **Step 4: `addRoteiro` faz upsert com `tipo_residuo`**

Substituir:

```js
    addRoteiro(nome) {
        this.db.run("INSERT OR IGNORE INTO roteiros (nome) VALUES (?)", [nome]);
        this.save();
    }
```

por:

```js
    addRoteiro(nome, tipoResiduo = '') {
        this.db.run(`
            INSERT INTO roteiros (nome, tipo_residuo) VALUES (?, ?)
            ON CONFLICT(nome) DO UPDATE SET tipo_residuo = excluded.tipo_residuo
        `, [nome, tipoResiduo]);
        this.save();
    }
```

- [ ] **Step 5: `getRoteiros` expõe `tipo_residuo`**

Substituir:

```js
    getRoteiros() {
        const res = this.db.exec("SELECT * FROM roteiros ORDER BY nome");
        return res.length ? res[0].values.map(v => ({ id: v[0], nome: v[1] })) : [];
    }
```

por:

```js
    getRoteiros() {
        const res = this.db.exec("SELECT id, nome, tipo_residuo FROM roteiros ORDER BY nome");
        return res.length ? res[0].values.map(v => ({ id: v[0], nome: v[1], tipo_residuo: v[2] || '' })) : [];
    }
```

- [ ] **Step 6: `importRoteirosRows` propaga `TipoResiduo`**

Localizar em `database.js`:

```js
        const uniqueRoteiros = [...new Set(data.map(r => this._getCsvVal(r, 'Roteiro')).filter(Boolean))];
        uniqueRoteiros.forEach(name => this.addRoteiro(name));
```

Substituir por:

```js
        const uniqueRoteiros = [...new Set(data.map(r => this._getCsvVal(r, 'Roteiro')).filter(Boolean))];
        const tipoResiduoPorRoteiro = {};
        data.forEach(row => {
            const nome = this._getCsvVal(row, 'Roteiro');
            if (nome && !(nome in tipoResiduoPorRoteiro)) {
                tipoResiduoPorRoteiro[nome] = this._getCsvVal(row, 'TipoResiduo') || '';
            }
        });
        uniqueRoteiros.forEach(name => this.addRoteiro(name, tipoResiduoPorRoteiro[name] || ''));
```

- [ ] **Step 7: Rodar o teste e confirmar que passa**

Run: `node --experimental-vm-modules tests/import-roteiro-tipo-residuo.test.cjs`
Expected: PASS — imprime as duas linhas `OK`.

- [ ] **Step 8: Adicionar o teste à cadeia do script `test`**

Em `package.json`, `scripts.test`, adicionar ` && node --experimental-vm-modules tests/import-roteiro-tipo-residuo.test.cjs` ao final.

- [ ] **Step 9: Rodar a suíte completa**

Run: `npm test`
Expected: todos os testes passam, incluindo os novos. Atenção especial a `tests/import-logradouros.test.cjs` e `tests/rotas-rede-sync.test.cjs`, que também chamam `addRoteiro`/`importRoteirosRows` — confirmar que continuam passando com a assinatura nova (o parâmetro `tipoResiduo` é opcional, chamadas antigas com um argumento continuam válidas).

- [ ] **Step 10: Commit**

```bash
git add database.js tests/import-roteiro-tipo-residuo.test.cjs package.json
git commit -m "feat(db): cadastra tipo_residuo por roteiro via sync do Sheets"
```

---

## Task 3: `getContatosWhatsapp` expõe `tipoResiduo` por contato

**Files:**
- Modify: `database.js` (`getContatosWhatsapp`, linhas 211-232)
- Test: `tests/whatsapp-contatos.test.cjs` (modificar)

**Interfaces:**
- Consumes: `db.getRoteiros()` agora inclui `tipo_residuo` (Task 2).
- Produces: cada contato de `db.getContatosWhatsapp(roteiroId)` ganha o campo `tipoResiduo: string`. Consumido por `whatsapp-sender.html` (Task 4).

- [ ] **Step 1: Adicionar a asserção (falhando) em `tests/whatsapp-contatos.test.cjs`**

Em `tests/whatsapp-contatos.test.cjs`, logo depois da linha:

```js
  db.addRoteiro('CENTRO LESTE');
```

adicionar um segundo argumento:

```js
  db.addRoteiro('CENTRO LESTE', 'Organicos');
```

E, depois do bloco:

```js
  assert.strictEqual(padaria[0].roteiroNome, 'CENTRO LESTE');
```

adicionar:

```js
  assert.strictEqual(padaria[0].tipoResiduo, 'Organicos', 'contato deve trazer o tipo de residuo do roteiro');
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `node --experimental-vm-modules tests/whatsapp-contatos.test.cjs`
Expected: FAIL — `padaria[0].tipoResiduo` é `undefined`.

- [ ] **Step 3: Implementar**

Em `database.js`, `getContatosWhatsapp` (linhas 211-232), substituir:

```js
    getContatosWhatsapp(roteiroId) {
        const roteiro = this.getRoteiros().find(r => r.id === roteiroId);
        const roteiroNome = roteiro ? roteiro.nome : '';
        const clientes = this.getClientesByRoteiro(roteiroId).filter(c => c.ativo);

        const contatos = [];
        clientes.forEach(cliente => {
            [[1, cliente.telefone1], [2, cliente.telefone2]].forEach(([slot, raw]) => {
                const digits = this._normalizeTelefoneDigits(raw);
                if (!digits) return;
                contatos.push({
                    idRota: cliente.id_rota,
                    slot,
                    nome: cliente.cliente,
                    telefoneExibicao: raw,
                    telefoneDigits: digits,
                    roteiroNome
                });
            });
        });
        return contatos;
    }
```

por:

```js
    getContatosWhatsapp(roteiroId) {
        const roteiro = this.getRoteiros().find(r => r.id === roteiroId);
        const roteiroNome = roteiro ? roteiro.nome : '';
        const tipoResiduo = roteiro ? roteiro.tipo_residuo : '';
        const clientes = this.getClientesByRoteiro(roteiroId).filter(c => c.ativo);

        const contatos = [];
        clientes.forEach(cliente => {
            [[1, cliente.telefone1], [2, cliente.telefone2]].forEach(([slot, raw]) => {
                const digits = this._normalizeTelefoneDigits(raw);
                if (!digits) return;
                contatos.push({
                    idRota: cliente.id_rota,
                    slot,
                    nome: cliente.cliente,
                    telefoneExibicao: raw,
                    telefoneDigits: digits,
                    roteiroNome,
                    tipoResiduo
                });
            });
        });
        return contatos;
    }
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `node --experimental-vm-modules tests/whatsapp-contatos.test.cjs`
Expected: PASS — todas as linhas `OK` do arquivo, incluindo a nova asserção.

- [ ] **Step 5: Rodar a suíte completa**

Run: `npm test`
Expected: todos os testes passam.

- [ ] **Step 6: Commit**

```bash
git add database.js tests/whatsapp-contatos.test.cjs
git commit -m "feat(db): getContatosWhatsapp expoe tipoResiduo do roteiro"
```

---

## Task 4: Tags `{data}` e `{residuo}` em `whatsapp-sender.html`

**Files:**
- Modify: `whatsapp-sender.html`

**Interfaces:**
- Consumes: `contact.tipoResiduo` (Task 3); `intercorrenciasPorIdRota.get(contact.idRota).data` (já existente, feature de `docs/superpowers/specs/2026-09-08-whatsapp-intercorrencias-design.md`).

- [ ] **Step 1: Atualizar a dica de tags no Passo 2**

Em `whatsapp-sender.html`, substituir:

```html
    <div class="tag-hint">Use <code>{nome}</code> para personalizar com o nome do estabelecimento e <code>{intercorrencia}</code> para citar o problema da última coleta.</div>
```

por:

```html
    <div class="tag-hint">Use <code>{nome}</code>, <code>{intercorrencia}</code>, <code>{data}</code> (data da coleta com problema) e <code>{residuo}</code> (tipo de resíduo do roteiro) para personalizar a mensagem.</div>
```

- [ ] **Step 2: Implementar `formatDateBR` e atualizar `buildMsg`**

Substituir:

```js
function buildMsg(contact) {
  const nome = contact.nome || 'estabelecimento';
  const intercorrencia = (intercorrenciasPorIdRota.get(contact.idRota) || {}).intercorrencia || '';
  return message.replace(/\{nome\}/gi, nome).replace(/\{intercorrencia\}/gi, intercorrencia);
}
```

por:

```js
function formatDateBR(dateStr) {
  if (!dateStr) return '';
  const [ano, mes, dia] = dateStr.split('-');
  return `${dia}/${mes}/${ano}`;
}

function buildMsg(contact) {
  const nome = contact.nome || 'estabelecimento';
  const registro = intercorrenciasPorIdRota.get(contact.idRota) || {};
  const intercorrencia = registro.intercorrencia || '';
  const data = formatDateBR(registro.data || '');
  const residuo = contact.tipoResiduo || '';
  return message
    .replace(/\{nome\}/gi, nome)
    .replace(/\{intercorrencia\}/gi, intercorrencia)
    .replace(/\{data\}/gi, data)
    .replace(/\{residuo\}/gi, residuo);
}
```

- [ ] **Step 3: Verificação manual no navegador**

Não há teste automatizado de UI. Servir o worktree (`python -m http.server 8080`) e usar as ferramentas do Playwright MCP (`mcp__playwright__browser_*`):

1. Abrir `http://localhost:8080/whatsapp-sender.html`.
2. Via `browser_evaluate`, semear um roteiro e cliente de teste (mesma abordagem da verificação da feature anterior):

```js
async () => {
  localStorage.setItem('app3_gas_url', 'https://fake.example/exec');
  const db = (await import('./database.js')).default;
  await db.init();
  db.addRoteiro('SV07', 'Vidro');
  const roteiro = db.getRoteiros().find(r => r.nome === 'SV07');
  db.upsertCliente({
    idRota: '2912', idCliente: 'TESTE-2912', Cliente: 'Cliente Teste',
    logradouro: 'Rua Teste', 'Número': '1', Complemento: '', CEP: '',
    Telefone1: '48999990000', Telefone2: '',
    roteiro_id: roteiro.id, Ordem: 1, ativo: 1
  });
}
```

3. Recarregar a página, e via `browser_evaluate`, stubar `window.fetch` para simular a resposta do GAS antes de marcar o checkbox:

```js
() => {
  const original = window.fetch;
  window.fetch = async (url) => {
    if (String(url).includes('action=intercorrenciasRoteiro')) {
      return new Response(JSON.stringify({
        ok: true,
        data: [{ id_rota: '2912', intercorrencia: 'Contentor nao e padrao', data: '2026-09-05' }]
      }), { status: 200 });
    }
    return original(url);
  };
}
```

4. Selecionar o roteiro SV07, marcar "Só com intercorrência", avançar para o Passo 2.
5. Preencher a mensagem com `Olá {nome}! Problema de {residuo} em {data}: {intercorrencia}` e clicar "Iniciar disparos".
6. Verificar, via `browser_evaluate` (`document.getElementById('msgPreview').textContent`), que o resultado é exatamente:
   `Olá Cliente Teste! Problema de Vidro em 05/09/2026: Contentor nao e padrao`
7. Encerrar o processo do `python -m http.server`.

- [ ] **Step 4: Commit**

```bash
git add whatsapp-sender.html
git commit -m "feat(whatsapp): adiciona tags {data} e {residuo} na mensagem de disparo"
```
