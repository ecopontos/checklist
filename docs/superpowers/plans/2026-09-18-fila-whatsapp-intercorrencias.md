# Fila de WhatsApp por Intercorrências Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** substituir a seleção manual de roteiros por uma fila automática das intercorrências atuais, com campanhas locais retomáveis e confirmação manual de envio.

**Architecture:** o GAS API 11 consolida a última coleta de cada ponto em uma única consulta. O cliente valida o contrato e combina as ocorrências com o cadastro local; o SQLite preserva campanhas e transições atômicas, enquanto um módulo de domínio puro calcula fila, mensagens e contadores. A página de WhatsApp consome essas interfaces e mantém abertura, confirmação e adiamento como estados distintos.

**Tech Stack:** JavaScript ES modules, Google Apps Script, SQL.js/SQLite persistido em `localStorage`, HTML/CSS, Node `assert`/`node:test`, Tauri shell plugin, XLSX.

**Spec:** `docs/superpowers/specs/2026-09-18-fila-whatsapp-intercorrencias-design.md`

## Global Constraints

- O GAS da nova fila usa `apiVersion: 11`; o mínimo global da sincronização de coletas continua `10`.
- O histórico de WhatsApp é local e não deve ser enviado ao GAS.
- `opened` nunca conta como envio; somente `confirmed` resolve a ocorrência.
- Confirmar qualquer telefone resolve o ponto inteiro.
- `deferred` continua pendente e pode integrar uma campanha posterior.
- A fila usa uma ocorrência por `idRota`: maior data civil e, em empate, última linha gravada.
- Quantidade zero não elimina uma intercorrência.
- Uma coleta mais recente sem intercorrência retira o ponto da fila.
- Conteúdo vindo da planilha ou do SQLite deve ser inserido no HTML somente após escape.
- Não adicionar dependências npm nem alterar autenticação, leitura/entrega do WhatsApp ou compartilhamento entre computadores.
- Antes de cada commit, verificar o índice com `git diff --cached --name-only`, pois o workspace contém alterações anteriores que não pertencem necessariamente à tarefa atual.

---

## Mapa de arquivos

- `gas/Code.gs`: endpoint consolidado, identidade legada e invalidação de cache.
- `gas/README.md`: contrato e exemplo de chamada do endpoint API 11.
- `google-sync.js`: cliente GET validado para `intercorrenciasAtuais`.
- `database.js`: schema e operações atômicas de campanhas e itens.
- `whatsapp-campaign.js` (novo): regras puras de fila, mensagem e resumo.
- `whatsapp-sender.html`: estrutura e estilos da fila/histórico; deixa de conter a lógica principal inline.
- `whatsapp-sender.js` (novo): inicialização, renderização e coordenação da tela.
- `whatsapp-events.js`: delegação CSP-safe das novas ações.
- `tests/gas-whatsapp-current.test.cjs` (novo): consolidação GAS e cache.
- `tests/whatsapp-campaign-persistence.test.cjs` (novo): migração e transições SQLite.
- `tests/google-sync-whatsapp.test.cjs` (novo): contrato do cliente remoto.
- `tests/whatsapp-campaign.test.cjs` (novo): regras puras da fila.
- `tests/whatsapp-ui.test.cjs` (novo): integração estrutural e estados da tela.
- `tests/whatsapp-events.test.cjs`: novas ações delegadas.
- `tests/whatsapp-open.test.cjs`: mantém o contrato do adaptador Tauri/browser.
- `package.json`: inclui as novas regressões no comando padrão.

---

### Task 1: Endpoint GAS consolidado

**Files:**
- Modify: `gas/Code.gs:35,80-82,424-513,1606-1680`
- Modify: `gas/README.md:80-105`
- Create: `tests/gas-whatsapp-current.test.cjs`

**Interfaces:**
- Consumes: aba `Coletas` com cabeçalhos `ID Rota`, `Data`, `Cliente`, `Roteiro`, `Quantidade`, `Intercorrência`, `Sincronizado Em`, `Sync ID`.
- Produces: `getIntercorrenciasAtuais_() -> TextOutput` e `buildIntercorrenciasAtuais_(values) -> {data, quality}`.
- Produces HTTP: `GET ?action=intercorrenciasAtuais -> {ok, apiVersion:11, source:'intercorrenciasAtuais', generatedAt, data, quality}`.

- [x] **Step 1: criar o teste falho da regra de consolidação**

Em `tests/gas-whatsapp-current.test.cjs`, carregue `gas/Code.gs` em `vm`, forneça `Utilities.formatDate`, `Utilities.computeDigest`, `Utilities.DigestAlgorithm.SHA_256` e `Utilities.Charset.UTF_8`, e exercite a função pura com esta matriz:

```js
const values = [
  ['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID'],
  ['1', '2026-09-01', 'A', 'R1', 1, 'Antiga', '2026-09-01T12:00:00Z', 'sync-1-old'],
  ['1', '2026-09-02', 'A', 'R1', 2, '', '2026-09-02T12:00:00Z', 'sync-1-new'],
  ['2', '2026-09-03', 'B', 'R2', 0, 'Recusou', '2026-09-03T12:00:00Z', 'sync-2'],
  ['3', '2026-09-04', 'C', 'R3', 1, 'Primeira', '2026-09-04T10:00:00Z', ''],
  ['3', '2026-09-04', 'C', 'R3', 1, 'Última do dia', '2026-09-04T11:00:00Z', ''],
  ['', 'data-inválida', 'D', 'R4', 1, 'Inválida', '', '']
];

const result = context.buildIntercorrenciasAtuais_(values);
assert.deepStrictEqual(Array.from(result.data, item => item.idRota), ['2', '3']);
assert.strictEqual(result.data[0].occurrenceId, 'sync-2');
assert.strictEqual(result.data[0].intercorrencia, 'Recusou');
assert.strictEqual(result.data[1].intercorrencia, 'Última do dia');
assert.match(result.data[1].occurrenceId, /^legacy:[0-9a-f]{64}$/);
assert.strictEqual(result.quality.invalidDates, 1);
assert.strictEqual(result.quality.missingRouteIds, 1);
assert.strictEqual(result.quality.legacyIds, 2);
assert.strictEqual(result.quality.excludedRecords, 1);
```

Inclua dois registros legados idênticos em posições diferentes e confirme que ambos produzem o mesmo digest canônico.

- [x] **Step 2: executar o teste e confirmar a falha**

Run: `node tests/gas-whatsapp-current.test.cjs`

Expected: FAIL porque `buildIntercorrenciasAtuais_` não existe e a API ainda é 10.

- [x] **Step 3: implementar a consolidação pura e o endpoint**

Em `gas/Code.gs`:

```js
var GAS_API_VERSION = 11;
var INTERCORRENCIAS_ATUAIS_CACHE_KEY = 'intercorrenciasAtuais:v1';

function normalizeOccurrenceInstant_(value) {
    return Object.prototype.toString.call(value) === '[object Date]'
        ? value.toISOString()
        : String(value == null ? '' : value).trim();
}

function legacyOccurrenceId_(item) {
    var canonical = JSON.stringify([
        item.idRota, item.data, item.cliente, item.roteiro,
        String(item.quantidade), item.intercorrencia, item.sincronizadoEm
    ]);
    var digest = Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        canonical,
        Utilities.Charset.UTF_8
    );
    return 'legacy:' + digest.map(function (byte) {
        return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
    }).join('');
}
```

Implemente `buildIntercorrenciasAtuais_` com mapa de cabeçalhos, normalização por `normalizeHistoryDate_`, comparação `data` e índice da linha, cálculo de qualidade e filtro somente depois de escolher a linha mais recente. A linha escolhida gera:

```js
{
    occurrenceId: syncId || legacyOccurrenceId_({
        idRota: idRota,
        data: data,
        cliente: String(row[colCliente] || '').trim(),
        roteiro: String(row[colRoteiro] || '').trim(),
        quantidade: Number(row[colQuantidade]),
        intercorrencia: String(row[colIntercorrencia] || '').trim(),
        sincronizadoEm: normalizeOccurrenceInstant_(row[colSincronizadoEm])
    }),
    idRota: idRota,
    data: data,
    cliente: String(row[colCliente] || '').trim(),
    roteiro: String(row[colRoteiro] || '').trim(),
    intercorrencia: String(row[colIntercorrencia] || '').trim()
}
```

Adicione ao `doGet`:

```js
if (params.action === 'intercorrenciasAtuais') {
    return getIntercorrenciasAtuais_();
}
```

`getIntercorrenciasAtuais_` deve tolerar falha de `cache.get/put`, usar TTL 300 segundos, incluir `source`, `generatedAt` e `apiVersion`, e devolver `ok:false` em falha da planilha. Após um lote válido em `saveColetas_`, execute `CacheService.getScriptCache().remove(INTERCORRENCIAS_ATUAIS_CACHE_KEY)` dentro de `try/catch`.

- [x] **Step 4: testar endpoint, contrato antigo e invalidação**

No mesmo teste, monte `SheetMock` e `CacheService` com registro de `remove`. Verifique:

```js
const response = JSON.parse(context.doGet({ parameter: { action: 'intercorrenciasAtuais' } }).value);
assert.strictEqual(response.ok, true);
assert.strictEqual(response.apiVersion, 11);
assert.strictEqual(response.source, 'intercorrenciasAtuais');
assert.ok(Array.isArray(response.data));

context.saveColetas_([{
  id_rota: '4', data: '2026-09-18', cliente: 'D', roteiro: 'R4',
  quantidade: 1, intercorrencia: 'Teste', sync_id: 'sync-4'
}]);
assert.ok(removedCacheKeys.includes('intercorrenciasAtuais:v1'));
```

Run: `node tests/gas-whatsapp-current.test.cjs && node tests/gas-intercorrencias.test.cjs && node tests/gas-checklist-integrity.test.cjs`

Expected: PASS.

- [x] **Step 5: documentar o endpoint e fazer commit**

Adicione ao `gas/README.md` o curl `?action=intercorrenciasAtuais`, o contrato API 11, a regra “última coleta por ponto” e a ressalva de que quantidade zero é aceita.

```bash
git add gas/Code.gs gas/README.md tests/gas-whatsapp-current.test.cjs
git diff --cached --name-only
git commit -m "feat(gas): consolida intercorrencias atuais"
```

---

### Task 2: Persistência local das campanhas

**Files:**
- Modify: `database.js:97-176,178-198,269-294,880-919`
- Create: `tests/whatsapp-campaign-persistence.test.cjs`

**Interfaces:**
- Consumes: `DatabaseManager._persistAtomic(action)` e `DatabaseManager._newChangeId()`.
- Produces: `getWhatsappContactDirectory() -> Array<{idRota, cliente, roteiroNome, phones:[{slot, exibicao, digits}]}>`.
- Produces: `createWhatsappCampaign({campaignId,messageTemplate,createdAt,items}) -> object`.
- Produces: `getActiveWhatsappCampaign() -> {campaignId,messageTemplate,status,createdAt,items} | null`.
- Produces: `transitionWhatsappCampaignItem(itemId,status,details) -> object`.
- Produces: `completeWhatsappCampaign(campaignId,completedAt) -> void`.
- Produces: `getConfirmedWhatsappOccurrenceIds() -> string[]` e `getWhatsappCampaignHistory() -> object[]`.

- [x] **Step 1: criar testes falhos de migração, retomada e idempotência**

Em `tests/whatsapp-campaign-persistence.test.cjs`, use SQL.js real e `localStorage` simulado. Depois de `db.init()`, confirme as tabelas e crie uma campanha:

```js
const campaign = db.createWhatsappCampaign({
  campaignId: 'campaign-1',
  messageTemplate: 'Olá {nome}: {intercorrencia}',
  createdAt: '2026-09-18T11:59:00.000Z',
  items: [{
    itemId: 'item-1', occurrenceId: 'occ-1', idRota: '42',
    cliente: 'Cliente A', roteiro: 'R1', coletaData: '2026-09-18',
    intercorrencia: 'Bombona suja', message: 'Olá Cliente A: Bombona suja',
    phones: [{ slot: 1, exibicao: '(48) 99999-0000', digits: '5548999990000' }]
  }]
});
assert.strictEqual(campaign.items[0].status, 'pending');
```

Cubra estes casos em subtests separados:

```js
db.transitionWhatsappCampaignItem('item-1', 'opened', {
  phoneSlot: 1, phone: '5548999990000', at: '2026-09-18T12:00:00.000Z'
});
assert.strictEqual(db.getActiveWhatsappCampaign().items[0].status, 'opened');

db.transitionWhatsappCampaignItem('item-1', 'confirmed', {
  at: '2026-09-18T12:01:00.000Z'
});
db.transitionWhatsappCampaignItem('item-1', 'confirmed', {
  at: '2026-09-18T12:02:00.000Z'
});
assert.deepStrictEqual(db.getConfirmedWhatsappOccurrenceIds(), ['occ-1']);
assert.strictEqual(db.getActiveWhatsappCampaign().items[0].confirmedAt, '2026-09-18T12:01:00.000Z');
```

Simule falha de `localStorage.setItem` durante uma transição e confirme que memória e armazenamento continuam em `pending`. Confirme também que uma segunda campanha ativa é rejeitada, uma campanha concluída aparece no histórico e itens `deferred` continuam sem ocorrência confirmada.

- [x] **Step 2: executar o teste e confirmar a falha**

Run: `node --experimental-vm-modules tests/whatsapp-campaign-persistence.test.cjs`

Expected: FAIL porque as tabelas e métodos ainda não existem.

- [x] **Step 3: criar schema e leitura normalizada**

Acrescente em `createTables()`:

```sql
CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
  campaign_id TEXT PRIMARY KEY,
  message_template TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS whatsapp_campaign_items (
  item_id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  occurrence_id TEXT NOT NULL,
  id_rota TEXT NOT NULL,
  cliente_snapshot TEXT NOT NULL,
  roteiro_snapshot TEXT NOT NULL,
  coleta_data TEXT NOT NULL,
  intercorrencia_snapshot TEXT NOT NULL,
  message_snapshot TEXT NOT NULL,
  phones_snapshot TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','opened','deferred','confirmed')),
  phone_slot INTEGER,
  phone_snapshot TEXT,
  opened_at TEXT,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_item_occurrence ON whatsapp_campaign_items(occurrence_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_item_campaign ON whatsapp_campaign_items(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_one_active ON whatsapp_campaigns(status) WHERE status = 'active';
```

Implemente um leitor interno que converta `phones_snapshot` com `JSON.parse` e devolva nomes camelCase conforme as interfaces acima. `getWhatsappCampaignHistory()` devolve somente campanhas concluídas em `createdAt` decrescente, cada uma com seu array `items` completo; `getActiveWhatsappCampaign()` usa a mesma forma para a única campanha ativa.

- [x] **Step 4: implementar comandos atômicos e diretório de contatos**

Todos os comandos de escrita devem executar dentro de `_persistAtomic`. Valide UUIDs/IDs não vazios, data civil de `coletaData`, arrays de telefones, estados e transições permitidas:

```js
const allowed = {
  pending: new Set(['opened', 'deferred']),
  deferred: new Set(['opened']),
  opened: new Set(['confirmed', 'deferred']),
  confirmed: new Set(['confirmed'])
};
```

Uma segunda confirmação retorna o item existente sem trocar `confirmed_at`. `completeWhatsappCampaign` aceita apenas campanha `active`; itens ainda `pending` impedem a conclusão, enquanto `deferred` é permitido. Extraia a normalização atual de telefone para um helper interno usado por `getContatosWhatsapp` e `getWhatsappContactDirectory`; o novo método agrupa `telefone1` e `telefone2` por `idRota` sem duplicar a regra.

- [x] **Step 5: executar regressões e fazer commit**

Run: `node --experimental-vm-modules tests/whatsapp-campaign-persistence.test.cjs && node --experimental-vm-modules tests/whatsapp-contatos.test.cjs && node --experimental-vm-modules tests/coleta-persistence.test.cjs`

Expected: PASS.

```bash
git add database.js tests/whatsapp-campaign-persistence.test.cjs
git diff --cached --name-only
git commit -m "feat(db): persiste campanhas de WhatsApp"
```

---

### Task 3: Cliente remoto e regras puras da fila

**Files:**
- Modify: `google-sync.js:234-294`
- Create: `whatsapp-campaign.js`
- Create: `tests/google-sync-whatsapp.test.cjs`
- Create: `tests/whatsapp-campaign.test.cjs`

**Interfaces:**
- Consumes: `getGasUrl()` e `gasGetJsonWithRetry_()` de `google-sync.js`.
- Produces: `getIntercorrenciasAtuais() -> Promise<{ok:true,data,quality,generatedAt}|{ok:false,error}>`.
- Produces: `buildWhatsappMessage(template, occurrence) -> string`.
- Produces: `buildWhatsappQueue({occurrences, contacts, confirmedOccurrenceIds, activeItems}) -> queueItem[]`.
- Produces: `summarizeWhatsappItems(items) -> {pending,opened,confirmed,deferred,blocked,total}`.

- [x] **Step 1: criar teste falho do contrato remoto**

Em `tests/google-sync-whatsapp.test.cjs`, carregue `database.js` e `google-sync.js` por `vm.SourceTextModule`, configure a URL do GAS e faça o fetch devolver sucessivamente: resposta válida API 11, API 10, `source` incorreta, `data` ausente e item sem `occurrenceId`.

```js
const ok = await sync.getIntercorrenciasAtuais();
assert.strictEqual(ok.ok, true);
assert.strictEqual(ok.data[0].occurrenceId, 'occ-1');
assert.strictEqual(requests[0], 'https://gas.example/exec?action=intercorrenciasAtuais');

const old = await sync.getIntercorrenciasAtuais();
assert.strictEqual(old.ok, false);
assert.match(old.error, /API 11/);
```

- [x] **Step 2: criar teste falho das regras da fila**

Em `tests/whatsapp-campaign.test.cjs`:

```js
const occurrenceA = { occurrenceId: 'occ-a', idRota: '1', data: '2026-09-18', cliente: 'A', roteiro: 'R1', intercorrencia: 'Acesso bloqueado' };
const occurrenceB = { occurrenceId: 'occ-b', idRota: '2', data: '2026-09-17', cliente: 'B', roteiro: 'R2', intercorrencia: 'Sem bombona' };
const occurrenceC = { occurrenceId: 'occ-c', idRota: '3', data: '2026-09-16', cliente: 'C', roteiro: 'R3', intercorrencia: 'Recusou' };
const frozenPhones = [{ slot: 1, exibicao: '(48) 99999-0000', digits: '5548999990000' }, { slot: 2, exibicao: '(48) 98888-0000', digits: '5548988880000' }];
const contactAWithTwoPhones = { idRota: '1', cliente: 'A', roteiroNome: 'R1', phones: frozenPhones };
const contactBWithoutPhone = { idRota: '2', cliente: 'B', roteiroNome: 'R2', phones: [] };

const queue = buildWhatsappQueue({
  occurrences: [occurrenceA, occurrenceB, occurrenceC],
  contacts: [contactAWithTwoPhones, contactBWithoutPhone],
  confirmedOccurrenceIds: ['occ-c'],
  activeItems: [{ occurrenceId: 'occ-a', status: 'opened', phones: frozenPhones }]
});
assert.strictEqual(queue.length, 2);
assert.strictEqual(queue.find(item => item.occurrenceId === 'occ-a').status, 'opened');
assert.strictEqual(queue.find(item => item.occurrenceId === 'occ-a').phones.length, 2);
assert.strictEqual(queue.find(item => item.occurrenceId === 'occ-b').blockedReason, 'Sem telefone válido');
assert.ok(!queue.some(item => item.occurrenceId === 'occ-c'));
```

Teste também as tags `{nome}`, `{intercorrencia}`, `{data}` e `{residuo}`, repetidas e sem diferenciar maiúsculas, e os seis contadores de `summarizeWhatsappItems`.

- [x] **Step 3: executar os testes e confirmar as falhas**

Run: `node --experimental-vm-modules tests/google-sync-whatsapp.test.cjs && node --experimental-vm-modules tests/whatsapp-campaign.test.cjs`

Expected: FAIL por exports ausentes.

- [x] **Step 4: implementar validação remota e módulo puro**

Em `google-sync.js`, valide sem lançar para o caller:

```js
export async function getIntercorrenciasAtuais() {
    const url = getGasUrl();
    if (!url) return { ok: false, error: 'URL do GAS não configurada' };
    const result = await gasGetJsonWithRetry_(`${url}?action=intercorrenciasAtuais`);
    if (!result || result.ok !== true) return result || { ok: false, error: 'Resposta vazia do GAS' };
    if (Number(result.apiVersion) < 11 || result.source !== 'intercorrenciasAtuais') {
        return { ok: false, error: 'O GAS precisa da API 11 para consultar as intercorrências atuais' };
    }
    if (!Array.isArray(result.data)) return { ok: false, error: 'Resposta inválida: data ausente' };
    const invalid = result.data.find(item => !item || !item.occurrenceId || !item.idRota || !item.data || !item.intercorrencia);
    if (invalid) return { ok: false, error: 'Resposta inválida: ocorrência incompleta' };
    return result;
}
```

Em `whatsapp-campaign.js`, mantenha funções puras e sem DOM. `buildWhatsappQueue` deve preservar todos os itens da campanha ativa, inclusive `confirmed`, mesmo que não estejam mais na resposta remota; isso sustenta retomada e progresso. Para ocorrências fora da campanha ativa, remova as já confirmadas, use o diretório atual e crie estado `pending`. Prefira `phones` e snapshots congelados do item ativo. Ordene itens novos por data decrescente, depois roteiro e cliente, sem alterar os arrays recebidos.

- [x] **Step 5: executar regressões e fazer commit**

Run: `node --experimental-vm-modules tests/google-sync-whatsapp.test.cjs && node --experimental-vm-modules tests/whatsapp-campaign.test.cjs && node --experimental-vm-modules tests/google-sync-intercorrencias.test.cjs`

Expected: PASS.

```bash
git add google-sync.js whatsapp-campaign.js tests/google-sync-whatsapp.test.cjs tests/whatsapp-campaign.test.cjs
git diff --cached --name-only
git commit -m "feat(whatsapp): calcula fila consolidada"
```

---

### Task 4: Tela, retomada e histórico

**Files:**
- Modify: `whatsapp-sender.html:1-880`
- Create: `whatsapp-sender.js`
- Modify: `whatsapp-events.js:1-60`
- Modify: `tests/whatsapp-events.test.cjs`
- Modify: `tests/whatsapp-open.test.cjs`
- Create: `tests/whatsapp-ui.test.cjs`

**Interfaces:**
- Consumes: Task 2 (`database.js` campaign API) and Task 3 (`getIntercorrenciasAtuais`, `buildWhatsappMessage`, `buildWhatsappQueue`, `summarizeWhatsappItems`).
- Produces: `initWhatsappSender()`, `refreshWhatsappQueue()`, `startWhatsappCampaign()`, `openCurrentWhatsapp()`, `confirmCurrentWhatsapp()`, `deferCurrentWhatsapp()`, `completeWhatsappCampaign()`, `showWhatsappTab(tab)`, `exportWhatsappCampaign(campaignId)`.
- Preserves: `window.openWhatsappUrl(url) -> Promise<void>` from `whatsapp-events.js`.

- [x] **Step 1: criar testes falhos da estrutura e das ações**

Em `tests/whatsapp-ui.test.cjs`, leia HTML/JS e verifique:

```js
assert.match(html, /id="queuePendingCount"/);
assert.match(html, /id="queueOpenedCount"/);
assert.match(html, /id="queueConfirmedCount"/);
assert.match(html, /id="queueError"/);
assert.match(html, /id="queueList"/);
assert.match(html, /id="campaignPanel"/);
assert.match(html, /id="campaignHistory"/);
assert.match(html, /src="whatsapp-sender\.js"/);
assert.doesNotMatch(html, /id="roteiroChips"/);
assert.doesNotMatch(html, /setTimeout\([^)]*markSent/);
assert.match(sender, /getActiveWhatsappCampaign/);
assert.match(sender, /getIntercorrenciasAtuais/);
assert.match(sender, /transitionWhatsappCampaignItem/);
assert.match(sender, /escapeHtml/);
```

Atualize `tests/whatsapp-events.test.cjs` para despachar e esperar estas chamadas:

```js
[
  ['showWhatsappTab', 'queue'], ['showWhatsappTab', 'history'],
  ['refreshWhatsappQueue'], ['toggleWhatsappOccurrence', 'occ-1', true],
  ['startWhatsappCampaign'], ['selectWhatsappPhone', 2],
  ['openCurrentWhatsapp'], ['confirmCurrentWhatsapp'],
  ['deferCurrentWhatsapp'], ['completeWhatsappCampaign'],
  ['exportWhatsappCampaign', 'campaign-1']
]
```

- [x] **Step 2: executar testes e confirmar as falhas**

Run: `node tests/whatsapp-ui.test.cjs && node tests/whatsapp-events.test.cjs && node tests/whatsapp-open.test.cjs`

Expected: FAIL porque a estrutura e as ações novas não existem.

- [x] **Step 3: substituir o fluxo de seleção de roteiros pela fila**

Em `whatsapp-sender.html`, mantenha cabeçalho, tema e navegação. Substitua os quatro passos atuais por:

- abas `Fila atual` e `Histórico`;
- três cards com IDs do teste;
- faixa de erro/fonte com botão `data-action="atualizar-fila"`;
- busca e `<select id="queueRouteFilter">` opcionais;
- lista `queueList` com checkboxes de seleção;
- editor `campaignMessage` e botão `data-action="iniciar-campanha"`;
- painel retomável com cliente, ocorrência, telefones, prévia e botões abrir/confirmar/adiar;
- histórico expansível e exportação.

Use classes explícitas `status-pending`, `status-opened`, `status-confirmed`, `status-deferred` e `status-blocked`. Remova o script de módulo inline e carregue:

```html
<script type="module" src="whatsapp-sender.js"></script>
<script src="whatsapp-events.js"></script>
```

- [x] **Step 4: implementar inicialização e atualização segura**

Em `whatsapp-sender.js`, exporte as funções listadas e também publique no `window` as usadas pelo delegador. A inicialização deve ocorrer nesta ordem:

```js
export async function initWhatsappSender() {
    await db.init();
    activeCampaign = db.getActiveWhatsappCampaign();
    contactDirectory = db.getWhatsappContactDirectory();
    renderActiveCampaign();
    renderHistory();
    await refreshWhatsappQueue();
}
```

`refreshWhatsappQueue` usa uma variável `refreshPromise` para single-flight. Em falha, preserva `activeCampaign`, mostra `queueError` e não escreve “0 pendências”. Em sucesso, combina resposta, confirmados, diretório e campanha ativa; preenche filtros e renderiza conteúdo somente via `textContent` ou `escapeHtml`.

- [x] **Step 5: implementar campanha e máquina de estados visual**

`startWhatsappCampaign` congela apenas itens selecionados e não bloqueados, gera UUIDs antes da persistência e chama `db.createWhatsappCampaign` uma única vez. Se já houver campanha ativa, a tela oferece retomada e não cria outra. `openCurrentWhatsapp` exige telefone selecionado, aguarda `window.openWhatsappUrl`, e só então persiste `opened`; se a abertura falhar, mantém `pending`. Se a persistência falhar depois da abertura externa, mostra erro explícito, mantém a tela no item e não o chama de aberto ou enviado. `confirmCurrentWhatsapp` só habilita em `opened` e chama a transição `confirmed`. `deferCurrentWhatsapp` chama `deferred` e avança somente depois de persistir.

Quando todos os itens forem `confirmed` ou `deferred`, exiba **Concluir campanha**. Ao concluir, chame o banco, recarregue histórico e reconcilie a fila: confirmados desaparecem e adiados continuam disponíveis. O histórico usa snapshots e `exportWhatsappCampaign` gera XLSX com campanha, ocorrência, cliente, roteiro, data, status, telefone, abertura, confirmação e mensagem.

- [x] **Step 6: ampliar o delegador de eventos e testar**

Em `whatsapp-events.js`, mapeie `data-action` sem handlers inline:

```js
case 'mostrar-aba': window.showWhatsappTab(control.dataset.tab); break;
case 'atualizar-fila': window.refreshWhatsappQueue(); break;
case 'iniciar-campanha': window.startWhatsappCampaign(); break;
case 'selecionar-telefone': window.selectWhatsappPhone(Number(control.dataset.slot)); break;
case 'abrir-whatsapp': window.openCurrentWhatsapp(); break;
case 'confirmar-envio': window.confirmCurrentWhatsapp(); break;
case 'adiar-envio': window.deferCurrentWhatsapp(); break;
case 'concluir-campanha': window.completeWhatsappCampaign(); break;
case 'exportar-campanha': window.exportWhatsappCampaign(control.dataset.campaignId); break;
```

No listener de `change`, mapeie `data-change-action="filtrar-fila"` para `window.applyWhatsappFilters()` e `data-change-action="alternar-ocorrencia"` para `window.toggleWhatsappOccurrence(control.dataset.occurrenceId, control.checked)`. No listener de `input`, filtre `#queueSearch` chamando a mesma função. Inclua `applyWhatsappFilters()` e `toggleWhatsappOccurrence(id, checked)` nos exports/publicações de `whatsapp-sender.js` e adapte o mock do teste para fornecer `checked: true`.

Run: `node tests/whatsapp-ui.test.cjs && node tests/whatsapp-events.test.cjs && node tests/whatsapp-open.test.cjs`

Expected: PASS.

- [x] **Step 7: fazer commit**

```bash
git add whatsapp-sender.html whatsapp-sender.js whatsapp-events.js tests/whatsapp-ui.test.cjs tests/whatsapp-events.test.cjs tests/whatsapp-open.test.cjs
git diff --cached --name-only
git commit -m "feat(whatsapp): exibe fila e historico local"
```

---

### Task 5: Integração, documentação e distribuição

**Files:**
- Modify: `package.json:10`
- Modify: `docs/superpowers/specs/2026-09-18-fila-whatsapp-intercorrencias-design.md`
- Modify: `docs/superpowers/plans/2026-09-18-fila-whatsapp-intercorrencias.md`
- Regenerate: `dist/` via `prepare-dist.js` (diretório ignorado pelo Git)

**Interfaces:**
- Consumes: todos os testes e módulos das Tasks 1–4.
- Produces: comando padrão cobrindo a funcionalidade e artefatos frontend atualizados.

- [x] **Step 1: adicionar as regressões ao comando padrão**

Acrescente ao script `test`, junto das suítes existentes:

```text
node tests/gas-whatsapp-current.test.cjs
node --experimental-vm-modules tests/whatsapp-campaign-persistence.test.cjs
node --experimental-vm-modules tests/google-sync-whatsapp.test.cjs
node --experimental-vm-modules tests/whatsapp-campaign.test.cjs
node tests/whatsapp-ui.test.cjs
```

- [x] **Step 2: executar a suíte completa**

Run: `npm test`

Expected: exit code 0, todas as suítes anteriores e cinco novas passando.

- [x] **Step 3: verificar sintaxe e contratos distribuídos**

Run:

```bash
node --check database.js
node --check google-sync.js
node --check whatsapp-campaign.js
node --check whatsapp-sender.js
node --check whatsapp-events.js
npm run prepare-dist
```

Depois compare SHA-256 de `whatsapp-sender.html`, `whatsapp-sender.js`, `whatsapp-campaign.js`, `whatsapp-events.js`, `database.js` e `google-sync.js` com seus equivalentes em `dist/`. Ligue os grafos de importação de `dist/whatsapp-sender.js` com `vm.SourceTextModule`. Verifique IDs duplicados no HTML após remover blocos `<script>`.

Expected: sintaxe válida, hashes iguais, imports resolvidos e nenhum ID duplicado.

- [x] **Step 4: executar revisão funcional controlada**

Com mocks ou ambiente local, confirme esta sequência sem tocar produção:

1. carregar duas ocorrências, uma com dois telefones;
2. abrir o segundo telefone e observar `Aguardando confirmação`;
3. fechar/reabrir a página e retomar o mesmo item;
4. confirmar e verificar remoção da ocorrência da fila;
5. adiar a segunda, concluir a campanha e verificar que ela continua pendente;
6. devolver nova `occurrenceId` para o primeiro ponto e verificar seu retorno;
7. simular GAS API 10 e confirmar erro explícito sem zerar a fila.

- [ ] **Step 5: atualizar evidências e fazer revisão independente** — evidências corrigidas; re-review independente pendente

Marque as tarefas concluídas neste plano e acrescente comandos/resultados reais. Atualize a especificação apenas se a implementação alterar um contrato aprovado. Faça revisão focada em falsos “enviados”, perda de campanha, identidade de ocorrência, conteúdo HTML não escapado e regressões no sync de coletas.

- [x] **Step 6: fazer commit final de integração**

```bash
git add package.json docs/superpowers/specs/2026-09-18-fila-whatsapp-intercorrencias-design.md docs/superpowers/plans/2026-09-18-fila-whatsapp-intercorrencias.md
git diff --cached --name-only
git commit -m "test(whatsapp): integra fila de intercorrencias"
```

## Critérios de conclusão

- A tela abre diretamente na fila consolidada, sem seleção obrigatória de roteiro.
- Nenhuma abertura externa é apresentada como envio confirmado.
- Campanha ativa sobrevive ao fechamento e retoma os snapshots originais.
- Uma confirmação em qualquer telefone resolve apenas a `occurrenceId` atual.
- Ocorrência confirmada não reaparece; outra coleta do mesmo ponto reaparece.
- Itens adiados continuam pendentes após concluir a campanha.
- Falha ou GAS antigo não é exibido como fila vazia.
- Histórico e exportação são separados por campanha e permanecem locais.
- `npm test`, sintaxe, `prepare-dist`, hashes, imports e IDs passam.
- GAS API 11 e frontend ficam prontos para publicação conjunta, sem publicar automaticamente.

## Evidências e estado da revisão — 2026-09-21

- Tasks 1–4: implementadas nos commits `83f6c3f`, `70f76cc`, `08c959f`, `00daab3`, `11ad835` e `b9822ee`.
- O primeiro review independente de `b9822ee..6d93070` reprovou a integração com 3 Important e 1 Minor: duas suítes fora do `npm test` rastreado, revisão funcional scratch sem controller/reload real, evidências produzidas no checkout sujo e os dois minors então conhecidos.
- Correções TDD: `b2a6278` inclui `whatsapp-events`/`whatsapp-open` no comando rastreado, teste integrado do controller, interpolação literal por regex única/callback e rótulo `Aguardando confirmação`; `56195a1`, `aaeab68` e `9314c80` incorporam três dependências que o primeiro checkout limpo revelou (`normalizeHistoryDate_`, rejeição de data inválida antes da invalidação do cache e `_persistAtomic`).
- RED observado: a interpolação reinterpretou sequências especiais de substituição e tags embutidas; a UI exibiu `Aberto`; o checkout limpo falhou sucessivamente por `normalizeHistoryDate_` e `_persistAtomic` ausentes e por lote inválido aceito. GREEN: domínio 6/6, persistência 9/9 e UI 12/12.
- Checkout de validação: `.worktrees/task5-clean-9314c80`, detached em `9314c80595c9e0288d64c6c98a83fbe798b7c1dc`, com `git status --short --branch` retornando somente `## HEAD (no branch)` antes e depois dos comandos.
- `npm test` nesse checkout: exit 0. Além das suítes anteriores, passaram GAS atual, persistência 9/9, cliente remoto 3/3, domínio 6/6, UI 12/12, eventos e abertura externa.
- `node --check database.js`, `google-sync.js`, `whatsapp-campaign.js`, `whatsapp-sender.js` e `whatsapp-events.js`: 5/5 com exit 0.
- `npm run prepare-dist`: exit 0. Os seis SHA-256 coincidiram entre origem e `dist/`: `whatsapp-sender.html` `06260EEC…8D8D1E`; `whatsapp-sender.js` `0CAD870A…19A55D`; `whatsapp-campaign.js` `5B6BD53C…8B4F1E`; `whatsapp-events.js` `E5FD7343…196FBD2`; `database.js` `7ADB406A…06B643F`; `google-sync.js` `65F0949A…9FDEB83`.
- `vm.SourceTextModule`: quatro módulos ligados a partir de `dist/whatsapp-sender.js`. HTML distribuído sem blocos `<script>`: 31 IDs, nenhuma duplicata.
- Revisão funcional automatizada no checkout limpo: `node --experimental-vm-modules tests/google-sync-whatsapp.test.cjs` (3/3) e `node tests/whatsapp-ui.test.cjs` (12/12), ambos exit 0. O controller abre sem confirmar, persiste `opened`, recria a página/banco pelo mesmo armazenamento, mantém campanha visível diante de erro de API 11, confirma uma ocorrência, adia outra, bloqueia contato sem telefone, conclui, mantém o adiado pendente, registra histórico/exportação e aceita nova `occurrenceId` do mesmo ponto.
- Distribuição: nenhum GAS foi publicado e nenhum instalador foi gerado ou distribuído. A especificação não mudou porque o contrato aprovado foi preservado.
- Estado: as correções e evidências acima aguardam novo review independente. Este plano não declara a revisão limpa.
