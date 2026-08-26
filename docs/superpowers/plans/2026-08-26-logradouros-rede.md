# Import automático do CSV de logradouros via pasta de rede — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ao abrir o app, ler automaticamente o `cstExportaCheckList.csv` de uma pasta de rede fixa e aplicar o backfill de logradouro (`db.importLogradourosCsv`), sem exigir upload manual.

**Architecture:** Um novo comando Rust (`read_network_logradouros_csv`) lê o arquivo e sua data de modificação da pasta de rede e devolve os bytes em base64 para o JS via `invoke`. Uma nova função `checkAndImportLogradourosRede(db)` em `google-sync.js` compara a data de modificação com a última importada, decodifica o texto (BOM/UTF-16LE, lógica extraída para `database.js` e reaproveitada também pelo upload manual em `admin.html`) e chama `db.importLogradourosCsv`. Disparada de `index.html` no mesmo estilo fire-and-forget do `checkAndImportRoteiros` existente.

**Tech Stack:** Tauri 2 (Rust) + JS puro (ES modules) + sql.js. Sem novas dependências (reaproveita `serde`/`base64`, já no `Cargo.toml`).

## Global Constraints

- Caminho da pasta de rede é fixo em todas as máquinas: `\\192.168.12.1\Dados\SMMADS\Super. de Resíduos Sólidos\Ger. de Op. de Coleta\DVCOS\ColetaFlexDados\Check-list\Check list\app\cstExportaCheckList.csv` (nome do arquivo sempre `cstExportaCheckList.csv`).
- Falha ao acessar a pasta/arquivo é silenciosa: só `console.error`, sem `alert`; nova tentativa na próxima abertura do app (mesmo padrão de `checkAndImportRoteiros`).
- O upload manual do CSV em `admin.html` (`Logradouros (cstExportaCheckList.csv)`) permanece funcionando sem mudança de comportamento.
- Não usar o plugin oficial `tauri-plugin-fs`; não alterar `src-tauri/capabilities/default.json` (comandos customizados já têm acesso total ao filesystem).
- Não mudar o formato do CSV nem a lógica de casamento por `id_rota` em `database.js` além da extração do helper de decodificação.
- Spec de referência: `docs/superpowers/specs/2026-08-26-logradouros-rede-design.md`.

---

### Task 1: Comando Rust `read_network_logradouros_csv`

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: comando Tauri `read_network_logradouros_csv` (sem argumentos), registrado em `invoke_handler!`. Sucesso: `{ bytes_base64: string, modified_time_ms: number }`. Falha: rejeita com `string` (mensagem de erro).

- [ ] **Step 1: Editar `src-tauri/src/lib.rs`**

Ler o arquivo atual primeiro (`Read src-tauri/src/lib.rs`) para confirmar que ainda bate com o trecho abaixo antes de editar — se o `save_checklist_pdf` tiver mudado, ajuste o `old_string` do Edit de acordo.

Substituir:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use std::fs;
use tauri::Manager;
```
por:
```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::time::UNIX_EPOCH;
use tauri::Manager;
```

Depois, logo após o fim da função `save_checklist_pdf` (antes de `#[cfg_attr(mobile, tauri::mobile_entry_point)]`), inserir:
```rust
// Caminho fixo da pasta de rede onde o Access publica o export do checklist
// (mesmo em todas as máquinas que rodam o app). Ver
// docs/superpowers/specs/2026-08-26-logradouros-rede-design.md.
const NETWORK_LOGRADOUROS_CSV_PATH: &str = r"\\192.168.12.1\Dados\SMMADS\Super. de Resíduos Sólidos\Ger. de Op. de Coleta\DVCOS\ColetaFlexDados\Check-list\Check list\app\cstExportaCheckList.csv";

#[derive(Serialize)]
struct NetworkCsvResult {
    bytes_base64: String,
    modified_time_ms: u64,
}

#[tauri::command]
fn read_network_logradouros_csv() -> Result<NetworkCsvResult, String> {
    let bytes = fs::read(NETWORK_LOGRADOUROS_CSV_PATH)
        .map_err(|e| format!("Não foi possível ler o arquivo na pasta de rede: {e}"))?;
    let metadata = fs::metadata(NETWORK_LOGRADOUROS_CSV_PATH)
        .map_err(|e| format!("Não foi possível ler os metadados do arquivo: {e}"))?;
    let modified_time_ms = metadata
        .modified()
        .map_err(|e| format!("Não foi possível ler a data de modificação: {e}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Data de modificação inválida: {e}"))?
        .as_millis() as u64;

    Ok(NetworkCsvResult {
        bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        modified_time_ms,
    })
}
```

Por fim, atualizar o registro do handler:
```rust
        .invoke_handler(tauri::generate_handler![save_checklist_pdf])
```
para:
```rust
        .invoke_handler(tauri::generate_handler![
            save_checklist_pdf,
            read_network_logradouros_csv
        ])
```

- [ ] **Step 2: Verificar que compila**

Run: `cd src-tauri && cargo check && cd ..`
Expected: termina com `Finished` (sem `error[...]`). Warnings são aceitáveis.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/lib.rs
git commit -m "feat(logradouros): comando Rust para ler CSV da pasta de rede fixa"
```

---

### Task 2: Helper compartilhado `decodeLegacyCsvBytes` em `database.js`

**Files:**
- Modify: `database.js:667` (logo antes de `const db = new AppDatabase();`)
- Test: `tests/decode-legacy-csv.test.cjs` (novo)
- Modify: `package.json:10` (adicionar o novo teste ao script `test`)

**Interfaces:**
- Produces: `export function decodeLegacyCsvBytes(buffer: ArrayBuffer): string` — detecta BOM UTF-16LE/UTF-16BE, senão assume UTF-8; usado por `admin.html` (Task 4) e `google-sync.js` (Task 3).

- [ ] **Step 1: Escrever o teste (vai falhar — a função ainda não existe)**

Criar `tests/decode-legacy-csv.test.cjs`:
```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createContext() {
  const context = vm.createContext({
    console, globalThis: null,
    Uint8Array, TextEncoder, TextDecoder,
    Date, Math, JSON, Object, Array, Number, String, Boolean, Error, Map, Set,
    setTimeout, clearTimeout,
    crypto: require('crypto').webcrypto,
    initSqlJs: async () => require('../vendor/sql-wasm.js')({
      locateFile: file => path.join(process.cwd(), 'vendor', file)
    }),
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
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
  const { decodeLegacyCsvBytes } = databaseModule;

  // UTF-16LE com BOM (formato real do export do Access).
  const utf16leBuffer = new Uint8Array(Buffer.from('﻿Fonte;idRota', 'utf16le')).buffer;
  assert.strictEqual(decodeLegacyCsvBytes(utf16leBuffer), '﻿Fonte;idRota');

  // UTF-8 sem BOM.
  const utf8Buffer = new Uint8Array(Buffer.from('Fonte;idRota', 'utf8')).buffer;
  assert.strictEqual(decodeLegacyCsvBytes(utf8Buffer), 'Fonte;idRota');

  // Arquivo real do Access (UTF-16LE com BOM, acentos e cedilha).
  const realFile = fs.readFileSync(path.join(process.cwd(), 'legado', 'cstExportaCheckList.csv'));
  const decodedReal = decodeLegacyCsvBytes(new Uint8Array(realFile).buffer);
  assert.ok(decodedReal.startsWith('﻿Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;'));

  console.log('decodeLegacyCsvBytes (UTF-16LE com BOM, UTF-8 sem BOM, CSV real do Access): OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `node --experimental-vm-modules tests/decode-legacy-csv.test.cjs`
Expected: falha porque `decodeLegacyCsvBytes` é `undefined` (`TypeError: decodeLegacyCsvBytes is not a function`).

- [ ] **Step 3: Implementar a função em `database.js`**

Ler `database.js` (linhas 660-668) primeiro para confirmar que o trecho abaixo ainda bate.

Substituir:
```js
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

const db = new AppDatabase();
export default db;
```
por:
```js
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

// O export do Access (cstExportaCheckList.csv) sai em UTF-16LE com BOM;
// detecta pelo BOM em vez de assumir UTF-8, para não corromper acentos.
// Usado tanto pelo upload manual (admin.html) quanto pela leitura automática
// da pasta de rede (google-sync.js).
export function decodeLegacyCsvBytes(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
        return new TextDecoder('utf-16le').decode(buffer);
    }
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return new TextDecoder('utf-16be').decode(buffer);
    }
    return new TextDecoder('utf-8').decode(buffer);
}

const db = new AppDatabase();
export default db;
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `node --experimental-vm-modules tests/decode-legacy-csv.test.cjs`
Expected: `decodeLegacyCsvBytes (UTF-16LE com BOM, UTF-8 sem BOM, CSV real do Access): OK`

- [ ] **Step 5: Adicionar ao script de testes do `package.json`**

Ler `package.json` primeiro. Substituir a linha `"test"` (linha 10) — que hoje termina em `tests/import-logradouros.test.cjs` — acrescentando ` && node --experimental-vm-modules tests/decode-legacy-csv.test.cjs` ao final da string.

- [ ] **Step 6: Commit**

```bash
git add database.js tests/decode-legacy-csv.test.cjs package.json
git commit -m "feat(logradouros): extrai decodeLegacyCsvBytes compartilhado"
```

---

### Task 3: `checkAndImportLogradourosRede` em `google-sync.js`

**Files:**
- Modify: `google-sync.js:1-9` (import + chave de localStorage), `google-sync.js:125` (nova função, logo após `checkAndImportRoteiros`)
- Modify: `tests/route-order.test.cjs:56-62` e `tests/client-edit-flow.test.cjs:45-51` (o `loadModule` desses dois testes precisa resolver o novo `import` de `./database.js` dentro de `google-sync.js` — hoje o linker deles lança erro em qualquer `import`)
- Test: `tests/logradouros-rede-sync.test.cjs` (novo)
- Modify: `package.json` (adicionar o novo teste ao script `test`)

**Interfaces:**
- Consumes: `decodeLegacyCsvBytes(buffer)` de `database.js` (Task 2); `db.importLogradourosCsv(text)` (já existente).
- Produces: `export async function checkAndImportLogradourosRede(db): Promise<{checked: boolean, reason?: string, updated?: boolean, error?: string, semLogradouro?: number, semCorrespondencia?: number, total?: number}>`.

- [ ] **Step 1: Corrigir o linker dos dois testes que carregam `database.js` + `google-sync.js` juntos**

Esse fix é pré-requisito: o Step 3 abaixo vai adicionar `import { decodeLegacyCsvBytes } from './database.js';` no topo de `google-sync.js`, e o `loadModule` atual desses dois testes lança `Import inesperado` para qualquer import. Sem esse fix, `npm test` quebra em `route-order.test.cjs` e `client-edit-flow.test.cjs` assim que o Step 3 rodar.

Em **`tests/route-order.test.cjs`**, ler o arquivo primeiro (linhas 56-62) e substituir:
```js
async function loadModule(context, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const module = new vm.SourceTextModule(source, { context, identifier: filename });
  await module.link(() => { throw new Error(`Import inesperado em ${filename}`); });
  await module.evaluate();
  return module.namespace;
}
```
por:
```js
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
```

Fazer a mesma substituição em **`tests/client-edit-flow.test.cjs`** (linhas 45-51, texto idêntico).

- [ ] **Step 2: Rodar os testes existentes e confirmar que ainda passam (fix é neutro sem o import novo)**

Run: `node --experimental-vm-modules tests/route-order.test.cjs && node --experimental-vm-modules tests/client-edit-flow.test.cjs`
Expected: as mesmas mensagens de sucesso de antes (`Reordenação em lote...OK`, `Fluxo de edicao de cliente...OK`), sem erros novos.

- [ ] **Step 3: Escrever o teste de `checkAndImportLogradourosRede` (vai falhar — a função ainda não existe)**

Criar `tests/logradouros-rede-sync.test.cjs`:
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
  return { context, windowRef };
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

function csvBase64(row) {
  const text = '﻿Fonte;idRota;Inativo;Ordem;Roteiro;Cliente;logradouro;Número;CEP\r\n' + row;
  return Buffer.from(text, 'utf16le').toString('base64');
}

(async () => {
  const { context, windowRef } = createContext();
  const databaseModule = await loadModule(context, 'database.js');
  const syncModule = await loadModule(context, 'google-sync.js');
  const db = databaseModule.default;
  await db.init();

  // Fora do app empacotado (sem window.__TAURI__): nao tenta nada.
  const semTauri = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(semTauri.checked, false);
  assert.strictEqual(semTauri.reason, 'not-tauri');

  db.addRoteiro('SAT01');
  const roteiroId = db.getRoteiros().find(r => r.nome === 'SAT01').id;
  db.upsertCliente({
    idRota: '777', idCliente: '', Cliente: 'TESTE REDE', logradouro: '',
    'Número': '10', Complemento: '', CEP: '88000000', Telefone1: '', Telefone2: '',
    roteiro_id: roteiroId, Ordem: 1, ativo: true
  });

  // Primeira checagem: nunca sincronizado antes -> importa.
  windowRef.__TAURI__ = {
    core: {
      invoke: async cmd => {
        assert.strictEqual(cmd, 'read_network_logradouros_csv');
        return {
          bytes_base64: csvBase64('SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua da Rede;10,00;88000000'),
          modified_time_ms: 1000
        };
      }
    }
  };
  const primeira = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(primeira.checked, true);
  assert.strictEqual(primeira.updated, true);
  assert.strictEqual(db.getClienteByIdRota('777').logradouro, 'Rua da Rede');

  // Mesmo modified_time_ms -> nao reimporta.
  let invokedDeNovo = false;
  windowRef.__TAURI__.core.invoke = async () => {
    invokedDeNovo = true;
    return {
      bytes_base64: csvBase64('SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua Errada;10,00;88000000'),
      modified_time_ms: 1000
    };
  };
  const segunda = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(invokedDeNovo, true);
  assert.strictEqual(segunda.updated, false);
  assert.strictEqual(db.getClienteByIdRota('777').logradouro, 'Rua da Rede');

  // modified_time_ms maior -> reimporta de fato.
  windowRef.__TAURI__.core.invoke = async () => ({
    bytes_base64: csvBase64('SAT01-1;777;0;1,00;SAT01;TESTE REDE;Rua Nova Da Rede;10,00;88000000'),
    modified_time_ms: 2000
  });
  const terceira = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(terceira.updated, true);
  assert.strictEqual(db.getClienteByIdRota('777').logradouro, 'Rua Nova Da Rede');

  // Pasta de rede inacessivel -> erro tratado, sem lancar excecao.
  windowRef.__TAURI__.core.invoke = async () => { throw 'pasta inacessivel'; };
  const falha = await syncModule.checkAndImportLogradourosRede(db);
  assert.strictEqual(falha.checked, true);
  assert.strictEqual(falha.updated, false);
  assert.strictEqual(falha.error, 'pasta inacessivel');

  console.log('checkAndImportLogradourosRede (not-tauri, primeira importacao, idempotencia por modified_time, falha tratada): OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 4: Rodar e confirmar que falha**

Run: `node --experimental-vm-modules tests/logradouros-rede-sync.test.cjs`
Expected: falha com `TypeError: syncModule.checkAndImportLogradourosRede is not a function`.

- [ ] **Step 5: Implementar em `google-sync.js`**

Ler `google-sync.js` (linhas 1-9) primeiro. Substituir:
```js
/**
 * Client for the Google Apps Script (GAS) Web App bridge to
 * Google Sheets (push coletas) and Google Drive (pull rotas/pontos CSV).
 */

const GAS_URL_KEY = 'app3_gas_url';
const LAST_DRIVE_SYNC_KEY = 'app3_last_drive_sync';
const GAS_ROUTE_TOKEN_KEY = 'app3_gas_route_token';
export const REQUIRED_GAS_API_VERSION = 4;
```
por:
```js
/**
 * Client for the Google Apps Script (GAS) Web App bridge to
 * Google Sheets (push coletas) and Google Drive (pull rotas/pontos CSV).
 */
import { decodeLegacyCsvBytes } from './database.js';

const GAS_URL_KEY = 'app3_gas_url';
const LAST_DRIVE_SYNC_KEY = 'app3_last_drive_sync';
const GAS_ROUTE_TOKEN_KEY = 'app3_gas_route_token';
const LAST_LOGRADOUROS_SYNC_KEY = 'app3_last_logradouros_sync';
export const REQUIRED_GAS_API_VERSION = 4;
```

Ler `google-sync.js` linhas 118-127 primeiro (para confirmar que ainda bate). Substituir:
```js
        localStorage.setItem(LAST_DRIVE_SYNC_KEY, data.modifiedTime);
        return { checked: true, updated: true, ...result };
    } catch (e) {
        return { checked: true, updated: false, error: e.message };
    }
}

// GET com timeout e retry para os endpoints JSON do GAS. O redirecionamento
```
por:
```js
        localStorage.setItem(LAST_DRIVE_SYNC_KEY, data.modifiedTime);
        return { checked: true, updated: true, ...result };
    } catch (e) {
        return { checked: true, updated: false, error: e.message };
    }
}

// Le o CSV legado de logradouros (cstExportaCheckList.csv) direto da pasta
// de rede fixa do Access, via comando Rust (so existe dentro do app
// empacotado com Tauri — no navegador comum, ou em testes sem
// window.__TAURI__, retorna checked:false). So reimporta quando o arquivo
// mudou (modified_time_ms), e ignora silenciosamente qualquer falha de
// acesso a rede: a proxima abertura do app tenta de novo. Ver
// docs/superpowers/specs/2026-08-26-logradouros-rede-design.md.
export async function checkAndImportLogradourosRede(db) {
    const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
        return { checked: false, reason: 'not-tauri' };
    }

    let result;
    try {
        result = await tauri.core.invoke('read_network_logradouros_csv');
    } catch (e) {
        return { checked: true, updated: false, error: typeof e === 'string' ? e : e.message };
    }

    const lastSync = Number(localStorage.getItem(LAST_LOGRADOUROS_SYNC_KEY) || 0);
    if (lastSync >= result.modified_time_ms) {
        return { checked: true, updated: false };
    }

    const bytes = Uint8Array.from(atob(result.bytes_base64), c => c.charCodeAt(0));
    const text = decodeLegacyCsvBytes(bytes.buffer);
    const importResult = db.importLogradourosCsv(text);

    localStorage.setItem(LAST_LOGRADOUROS_SYNC_KEY, String(result.modified_time_ms));
    return { checked: true, updated: true, ...importResult };
}

// GET com timeout e retry para os endpoints JSON do GAS. O redirecionamento
```

- [ ] **Step 6: Rodar e confirmar que passa**

Run: `node --experimental-vm-modules tests/logradouros-rede-sync.test.cjs`
Expected: `checkAndImportLogradourosRede (not-tauri, primeira importacao, idempotencia por modified_time, falha tratada): OK`

- [ ] **Step 7: Adicionar ao script de testes do `package.json`**

Ler `package.json` primeiro. Acrescentar ` && node --experimental-vm-modules tests/logradouros-rede-sync.test.cjs` ao final da string `"test"`.

- [ ] **Step 8: Rodar a suite completa**

Run: `npm test`
Expected: todas as linhas de sucesso, incluindo as duas novas, sem nenhum erro.

- [ ] **Step 9: Commit**

```bash
git add google-sync.js tests/route-order.test.cjs tests/client-edit-flow.test.cjs tests/logradouros-rede-sync.test.cjs package.json
git commit -m "feat(logradouros): checkAndImportLogradourosRede com sync idempotente"
```

---

### Task 4: `admin.html` — reaproveitar `decodeLegacyCsvBytes`

**Files:**
- Modify: `admin.html:325` (import), `admin.html:358-386` (`handleLogradourosFile`)

**Interfaces:**
- Consumes: `decodeLegacyCsvBytes(buffer)` de `database.js` (Task 2).

- [ ] **Step 1: Editar os imports**

Ler `admin.html` linhas 324-335 primeiro. Substituir:
```js
        import db from './database.js';
        import {
```
por:
```js
        import db, { decodeLegacyCsvBytes } from './database.js';
        import {
```

- [ ] **Step 2: Simplificar `handleLogradourosFile`**

Ler `admin.html` linhas 358-386 primeiro (para confirmar que ainda bate). Substituir:
```js
        // O export do Access (cstExportaCheckList.csv) sai em UTF-16LE com BOM;
        // detecta pelo BOM em vez de assumir UTF-8, para não corromper acentos.
        async function handleLogradourosFile(e) {
            const file = e.target.files[0];
            if (!file) return;

            const buffer = await file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let text;
            if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
                text = new TextDecoder('utf-16le').decode(buffer);
            } else if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
                text = new TextDecoder('utf-16be').decode(buffer);
            } else {
                text = new TextDecoder('utf-8').decode(buffer);
            }

            showLoader('Atualizando logradouros...');
            const result = db.importLogradourosCsv(text);
            hideLoader();

            alert(
                `Logradouros atualizados: ${result.updated}\n` +
                `Sem ponto correspondente no app: ${result.semCorrespondencia}\n` +
                `Sem logradouro no CSV: ${result.semLogradouro}\n` +
                `Total de linhas no arquivo: ${result.total}`
            );
            e.target.value = '';
        }
```
por:
```js
        async function handleLogradourosFile(e) {
            const file = e.target.files[0];
            if (!file) return;

            const buffer = await file.arrayBuffer();
            const text = decodeLegacyCsvBytes(buffer);

            showLoader('Atualizando logradouros...');
            const result = db.importLogradourosCsv(text);
            hideLoader();

            alert(
                `Logradouros atualizados: ${result.updated}\n` +
                `Sem ponto correspondente no app: ${result.semCorrespondencia}\n` +
                `Sem logradouro no CSV: ${result.semLogradouro}\n` +
                `Total de linhas no arquivo: ${result.total}`
            );
            e.target.value = '';
        }
```

- [ ] **Step 3: Verificação manual no navegador (upload continua funcionando)**

Servir o app localmente e testar o fluxo real de upload com o CSV de verdade:

Run: `python -m http.server 8791` (em background, na raiz do projeto)

Usar o Playwright MCP:
1. `mcp__playwright__browser_navigate` para `http://localhost:8791/admin.html`.
2. `mcp__playwright__browser_run_code_unsafe` para semear um cliente sem logradouro (mesmo padrão já usado nesta sessão para o backfill): importar `./database.js` dinamicamente, `db.init()`, `db.addRoteiro('SAT01')`, `db.upsertCliente({ idRota: '3', Cliente: 'CEPON', logradouro: '', 'Número': '655', roteiro_id: <id>, Ordem: 1, ativo: true, ... })`.
3. `mcp__playwright__browser_file_upload` apontando para `legado/cstExportaCheckList.csv`, no input `#legacyLogradouros` (clicar em "Logradouros (cstExportaCheckList.csv)" antes, ou usar o seletor do input diretamente).
4. Esperar o alert (`mcp__playwright__browser_handle_dialog` se necessário) e confirmar a mensagem de contagem.
5. `mcp__playwright__browser_run_code_unsafe` para reler `db.getClienteByIdRota('3').logradouro` e confirmar que é `'Rodovia Admar Gonzaga'`.

Expected: logradouro atualizado corretamente, sem erros no console (`mcp__playwright__browser_console_messages`).

Encerrar o servidor local (`TaskStop` no processo em background) e remover `.playwright-mcp/` se criado.

- [ ] **Step 4: Commit**

```bash
git add admin.html
git commit -m "refactor(admin): reaproveita decodeLegacyCsvBytes no upload manual"
```

---

### Task 5: `index.html` — disparar a checagem automática

**Files:**
- Modify: `index.html:307-332`

**Interfaces:**
- Consumes: `checkAndImportLogradourosRede(db)` de `google-sync.js` (Task 3).

- [ ] **Step 1: Editar `index.html`**

Ler `index.html` linhas 306-341 primeiro (para confirmar que ainda bate). Substituir:
```js
        import db from './database.js';
        import { checkAndImportRoteiros } from './google-sync.js';
```
por:
```js
        import db from './database.js';
        import { checkAndImportRoteiros, checkAndImportLogradourosRede } from './google-sync.js';
```

Substituir:
```js
                checkAndImportRoteiros(db).then(result => {
                    if (result.updated) refreshStats();
                }).catch(e => console.error("Drive sync check failed", e));
```
por:
```js
                checkAndImportRoteiros(db).then(result => {
                    if (result.updated) refreshStats();
                }).catch(e => console.error("Drive sync check failed", e));

                checkAndImportLogradourosRede(db).then(result => {
                    if (result.updated) refreshStats();
                }).catch(e => console.error("Network logradouros sync check failed", e));
```

- [ ] **Step 2: Verificação manual — sem Tauri, não deve quebrar nada**

Run: `python -m http.server 8791` (em background, na raiz do projeto, se não estiver rodando)

1. `mcp__playwright__browser_navigate` para `http://localhost:8791/index.html`.
2. `mcp__playwright__browser_console_messages` com `level: "error"` — não deve haver nenhum erro relacionado a `checkAndImportLogradourosRede` (fora do Tauri, `window.__TAURI__` é `undefined`, então a função retorna cedo sem lançar).

Expected: página carrega normalmente, sem novos erros de console.

Encerrar o servidor local.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(logradouros): dispara checagem automatica da pasta de rede no index"
```

---

### Task 6: Build final e verificação end-to-end

**Files:** nenhum (build + verificação manual)

- [ ] **Step 1: Rodar a suite de testes completa**

Run: `npm test`
Expected: todas as linhas de sucesso (7 arquivos de teste), sem erros.

- [ ] **Step 2: Rebuild do instalador**

Run: `npm run build`
Expected: termina com `Finished 1 bundle at: ...\src-tauri\target\release\bundle\nsis\SATELITE Checklist_1.4.0_x64-setup.exe` (mesmo padrão dos builds anteriores desta sessão).

- [ ] **Step 3: Verificação manual no app instalado**

Instruir o usuário a instalar o novo `.exe` e abrir o app numa máquina com acesso à pasta de rede
`\\192.168.12.1\Dados\...\app\`. Sem fazer nenhum upload manual, conferir que um roteiro que antes
mostrava só o número (ex: `CEPON`, ID 3) agora mostra o logradouro completo (`Rodovia Admar Gonzaga,
655`). Se a máquina não tiver acesso à pasta (VPN desligada), confirmar que o app abre normalmente
mesmo assim (falha silenciosa) e que o upload manual no Admin continua funcionando como alternativa.

- [ ] **Step 4: Commit final (se houver ajustes pendentes de Steps anteriores)**

```bash
git status
```
Se tudo já foi commitado nas tasks anteriores, nada a fazer aqui.
