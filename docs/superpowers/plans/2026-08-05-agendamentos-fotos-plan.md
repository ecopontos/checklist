# Agendamentos com 3 Fotos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar 3 fotos por agendamento no fluxo de agendamentos
(`agendamentos.html`). As fotos são selecionadas do computador, enviadas ao
Google Drive via GAS e exibidas no roteiro PDF gerado por data.

**Architecture:** O app já fala com o GAS (`gas/Code.gs`) via
`google-sync.js`. As fotos ficam numa subpasta do Drive
`AgendamentosFotos/<agendamentoId>/` dentro da pasta já configurada em
`CHECKLISTS_FOLDER_ID` — sem configuração nova. Cada slot é um arquivo fixo
(`foto_1.jpg/png`, `foto_2...`, `foto_3...`), o que torna o reenvio
idempotente (substitui o mesmo arquivo). O PDF por data é gerado com jsPDF +
autoTable e embute as fotos (redimensionadas no cliente) usando `didParseCell`.

**Tech Stack:** Google Apps Script (GAS) + vanilla HTML/CSS/JS (frontend já
existente), jsPDF + autoTable (vendor/), Tauri 2.x como wrapper desktop.
Build target: Windows NSIS installer.

## Global Constraints

- Não alterar as rotas existentes do GAS (`coletas`, `checklist`,
  `routeChanges`, `alteracoesRoteiros`, `agendamentos`,
  `ultimaColeta`, `ultimaColetaDetalhada`). Somente ações aditivas.
- As fotos são **online-only** (como os agendamentos): sem conexão não há
  preview das fotos no Drive nem upload.
- O CSP do Tauri já permite `img-src 'self' data:` — previews em data-URL
  funcionam sem mudança de configuração.
- A coluna `Fotos` da planilha **não muda**: as fotos ficam no Drive,
  vinculadas pelo `ID` do agendamento.
- Máximo de 3 fotos por agendamento (slots fixos `foto_1`, `foto_2`,
  `foto_3`), extensões `.jpg`/`.jpeg`/`.png`, limite ~8 MB por foto.
- Redeploy do GAS (nova versão na implantação atual) + `npm run build` são
  necessários ao final para a mudança valer no app desktop.

---

## Task 1: GAS — upload e listagem de fotos

**Files:**
- Modify: `gas/Code.gs`

**Interfaces:**
- Produces: `POST uploadAgendamentoFotos` (upload + remoção em lote) e
  `GET agendamentoFotos` (lista com base64 opcional).

- [ ] **Step 1: Constantes e helper de pasta**

Adicionar:

```js
var AGENDAMENTOS_FOTOS_SUBFOLDER = 'AgendamentosFotos';
```

Criar `getAgendamentosFotosFolder_()`: obtém a subpasta
`AgendamentosFotos` dentro de `CHECKLISTS_FOLDER_ID`
(`DriveApp.getFolderById` → `getFoldersByName` → cria se não existir).
Guardar o ID em `CacheService.getScriptCache()` para evitar re-resolução
a cada chamada.

- [ ] **Step 2: Helper da subpasta do agendamento**

Criar `getAgendamentoFotosFolder_(id)`: obtém/cria a subpasta
`AgendamentosFotos/<id>`. Validar `id` com a mesma regex usada em
`normalizeAgendamento_` (`/^[A-Za-z0-9-]{8,64}$/`).

- [ ] **Step 3: `doPost` — action `uploadAgendamentoFotos`**

Handler em `doPost`:

```js
if (body.action === 'uploadAgendamentoFotos') {
    return uploadAgendamentoFotos_(body.id || '', body.fotos || [], body.remover || []);
}
```

`uploadAgendamentoFotos_(id, fotos, remover)`:
- Valida `id`; `fotos.length <= 3`; cada `foto.nome` deve casar
  `/^foto_[123]\.(jpg|jpeg|png)$/i`; cada `base64` <= ~8 MB
  (`Utilities.base64Decode` para validar/contar bytes).
- Apaga os arquivos de `remover` (nomes válidos) na subpasta do
  agendamento.
- Grava os arquivos de `fotos` (substituindo os de mesmo nome).
- Retorna `jsonResponse_({ ok: true, count })`.

- [ ] **Step 4: `doGet` — action `agendamentoFotos`**

Handler em `doGet`:

```js
if (params.action === 'agendamentoFotos') {
    return getAgendamentoFotos_(params.id || '', params.incluirBase64 === 'true');
}
```

`getAgendamentoFotos_(id, incluirBase64)`:
- Valida `id`; se a subpasta não existir, retorna `{ ok: true, fotos: [] }`.
- Lista os arquivos `foto_1/2/3` existentes.
- Com `incluirBase64`, anexa `base64` (puro, sem `data:` prefix) de cada
  arquivo (`file.getBlob().getBytes()` → `Utilities.base64Encode`).

- [ ] **Step 5: Sintaxe**

Copiar `gas/Code.gs` para um `.js` temporário e rodar `node --check`.

---

## Task 2: Cliente — google-sync.js

**Files:**
- Modify: `google-sync.js`

**Interfaces:**
- Produces: `uploadAgendamentoFotos(id, fotos, remover)` e
  `getAgendamentoFotos(id, incluirBase64)`.

- [ ] **Step 1: `uploadAgendamentoFotos(id, fotos, remover)`**

POST com `Content-Type: text/plain;charset=utf-8` e body
`{ action: 'uploadAgendamentoFotos', id, fotos, remover }`, no mesmo
padrão de `syncAgendamentos`. Retorna `{ ok: false, error }` se a URL do
GAS não estiver configurada.

- [ ] **Step 2: `getAgendamentoFotos(id, incluirBase64 = false)`**

GET `${url}?action=agendamentoFotos&id=...&incluirBase64=...` usando
`gasGetJsonWithRetry_` (retry padrão).

- [ ] **Step 3: Sintaxe**

`node --check google-sync.js`.

---

## Task 3: UI — agendamentos.html

**Files:**
- Modify: `agendamentos.html`

**Interfaces:**
- Produces: 3 slots de foto no formulário, preview de fotos existentes ao
  editar, upload/remoção ao salvar e fotos embutidas no PDF por data.

- [ ] **Step 1: Estado dos slots**

No módulo, manter um array `slots` (índices 0–2). Cada slot:
`{ base64, nome }` (data-URL para preview) e `{ existia, marcadoRemover }`
(flag de estado). Carregar `getAgendamentoFotos(id, true)` no
`startEdit` para popular os slots com as fotos do Drive.

- [ ] **Step 2: Markup dos 3 slots**

No card "Novo Agendamento", adicionar 3 slots de foto (rótulo "Foto 1/2/3"):
botão "Selecionar foto" com `<input type="file" accept="image/*">`
escondido, `<img>` para thumbnail (data-URL) e botão ✕ para remover.

- [ ] **Step 3: Lógica de seleção/remoção**

- Selecionar arquivo → `FileReader.readAsDataURL` → thumbnail + marca o slot
  como "novo" (`nome = foto_{i+1}.<ext>`).
- ✕ → limpa o slot; se o slot tinha foto existente, marca para `remover`.

- [ ] **Step 4: Adicionar agendamento**

`addAgendamento`: `syncAgendamentos([...])` (gera o `id`) → se houver slots
preenchidos, `uploadAgendamentoFotos(id, fotos, [])`. Toast com resultado.

- [ ] **Step 5: Salvar edição**

`saveEdit`: `syncAgendamentos([...])` → `uploadAgendamentoFotos(id, fotos,
remover)` onde `fotos` = slots com seleção nova e `remover` = slots com
foto existente que foram limpos. Limpar estado dos slots após salvar.

- [ ] **Step 6: PDF com fotos**

`generatePdf`: para cada agendamento da data, buscar as fotos
(`getAgendamentoFotos(id, true)`), converter data-URL para `Uint8Array`
via canvas (redimensionar para largura máx. ~300 px e comprimir JPEG q0.7),
e embutir na tabela com autoTable `didParseCell` — coluna "Fotos" com as
até 3 miniaturas lado a lado na linha. Linha sem fotos fica em branco.
Layout landscape (atual). Se o carregamento das fotos falhar, gerar o PDF
sem elas e mostrar aviso no toast.

- [ ] **Step 7: Estados de loading**

Botões desabilitados durante upload/busca; toast para progresso e erros.

---

## Task 4: Documentação e verificação

**Files:**
- Modify: `gas/README.md`

**Interfaces:**
- Produces: exemplos curl das novas actions e nota sobre o limite por foto.

- [ ] **Step 1: Seção no gas/README.md**

Documentar `uploadAgendamentoFotos` e `agendamentoFotos` com exemplos
`curl` (upload, remoção, listagem com base64) e o layout da pasta
`AgendamentosFotos/<id>/foto_1..3`.

- [ ] **Step 2: Testes**

`npm test` (regressão dos testes existentes).

- [ ] **Step 3: Build do dist**

`node prepare-dist.js` e conferir `dist/agendamentos.html`,
`dist/google-sync.js`, `dist/gas` não são copiados (gas fica fora do dist).

- [ ] **Step 4: Sintaxe do módulo da página**

Extrair o `<script type="module">` de `agendamentos.html` para um `.mjs`
temporário e rodar `node --check`.

- [ ] **Step 5: Relatório final**

Resumo de pass/fail por checagem; nada de commit sem instrução explícita.

---

## Deploy (manual, após aprovação)

- Redeploy do GAS com nova versão na implantação atual (mantém a URL
  `/exec` e o `apiVersion`).
- `npm run build` para gerar o instalador NSIS com a UI nova.
- Validar manualmente: criar agendamento com 3 fotos, editar (preview +
  substituir/remover), gerar PDF por data com fotos embutidas.
