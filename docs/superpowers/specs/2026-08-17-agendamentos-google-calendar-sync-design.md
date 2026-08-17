# Sincronização bidirecional de Agendamentos com o Google Calendar

**Data:** 2026-08-17
**Status:** Design aprovado (aguardando revisão da spec)
**Abordagem:** A — GAS como hub; planilha `verdesagendados` = fonte estruturada; calendário compartilhado dedicado = camada visual bidirecional.

---

## 1. Contexto e objetivo

O app hoje tem um "agendamento frouxo": a página `agendamentos.html` faz CRUD de coletas
futuras gravadas na planilha `verdesagendados` (via GAS), com fotos no Drive e geração de
PDF por data. É uma lista datada, sem recorrência, sem status, sem hora, isolada dos
roteiros.

A organização adotou o Google Workspace como padrão. O objetivo é **delegar a camada
visual ao Google Calendar** — um calendário compartilhado que toda a equipe enxerga e
edita — mantendo a **planilha como fonte estruturada** para o app (leitura, PDF, vínculo
com fotos). O app local continua sendo a ferramenta principal de cadastro, mas edições
feitas direto no Calendar precisam voltar para a planilha.

Restrição arquitetural decisiva: **o app Tauri nunca fala com o Google diretamente.** Todo
acesso passa pelo GAS Web App (autenticado por token). Logo, toda a integração com o
Calendar mora no GAS, que já roda sob a conta Workspace autorizada. Nenhum OAuth é
adicionado ao app desktop.

## 2. Decisões travadas (do brainstorming)

| Decisão | Escolha |
|---|---|
| Direção do sync | **Bidirecional** (app ↔ Calendar) |
| Calendário alvo | **Um calendário compartilhado dedicado**, criado/gerenciado pelo GAS |
| Granularidade | **Data + horário opcional** (sem hora = evento de dia inteiro; com hora = evento cronometrado) |
| Conflitos | **Última edição vence** por timestamp; exclusão conta como edição (delete mais recente vence) |

## 3. Arquitetura

```
┌────────────┐  fetch (token)   ┌──────────────────────────┐
│ App Tauri  │ ───────────────▶ │  GAS Web App (Code.gs)    │
│ agendamen- │  syncAgenda-     │                           │
│ tos.html   │  mentos /        │  ┌─ syncAgendamentos_ ──┐ │  ida (síncrona)
│            │  getAgenda-      │  │  grava linha +        │─┼────────────┐
│            │  mentos          │  │  upsert/delete evento │ │            ▼
└────────────┘ ◀─────────────── │  └───────────────────────┘ │   ┌──────────────────┐
                  dados (+hora)  │                           │   │ Google Calendar   │
                                 │  ┌─ reverseSync (trigger)┐ │   │ "Coletas          │
        ┌──────────────────┐     │  │  Calendar.Events.list │◀┼───│  Agendadas"       │
        │ Planilha         │◀───▶│  │  (syncToken) → LWW    │ │   │ (compartilhado)   │
        │ verdesagendados  │     │  └───────────────────────┘ │   └──────────────────┘
        └──────────────────┘     └──────────────────────────┘     ▲ pessoas editam aqui
```

Dois fluxos:

- **Ida (síncrona, dentro de `syncAgendamentos_`):** quando o app grava/edita/exclui, o GAS,
  no mesmo request, reflete a mudança no evento correspondente do calendário dedicado.
- **Volta (assíncrona, gatilho de tempo):** um trigger periódico chama
  `reverseSyncAgendamentos_`, que lê as mudanças incrementais do calendário (via `syncToken`)
  e reconcilia contra a planilha por LWW.

Ambos os fluxos compartilham o mesmo `LockService.getScriptLock()` para serializar escritas
na planilha.

## 4. Modelo de dados

### 4.1 Planilha `verdesagendados`

Cabeçalho atual (`AGENDAMENTOS_HEADERS`):

```
ID | Cliente | Endereço | Materiais | Data Prevista | Sincronizado Em
```

Novo cabeçalho (colunas adicionadas ao final para preservar índices existentes):

```
ID | Cliente | Endereço | Materiais | Data Prevista | Sincronizado Em |
Hora Início | Hora Fim | Event ID | Hash Cal | Cancelado
```

| Coluna | Índice | Papel |
|---|---|---|
| `Sincronizado Em` | 5 | **Timestamp de LWW.** ISO 8601. Já é gravado a cada upsert; passa a ser gravado também no soft-delete e no sync reverso. |
| `Hora Início` | 6 | `HH:MM` opcional. Vazio = evento all-day. |
| `Hora Fim` | 7 | `HH:MM` opcional. Só usado quando há `Hora Início`. |
| `Event ID` | 8 | ID do evento no Google Calendar. Vazio = ainda não espelhado. |
| `Hash Cal` | 9 | Hash do conteúdo canônico refletido por último no Calendar. Guarda anti-ping-pong (ver §7). |
| `Cancelado` | 10 | `TRUE`/vazio. Tombstone de soft-delete (ver §8). |

`getAgendamentosSheet_` já reescreve o cabeçalho quando o formato diverge; a migração de
linhas antigas é automática (colunas novas ficam vazias, tratadas como all-day, não
canceladas, sem evento — o próximo reconcile as espelha).

### 4.2 Mapeamento agendamento ↔ evento

| Campo planilha | Campo evento (Calendar API v3) |
|---|---|
| `Cliente` | `summary` (título) |
| `Endereço` | `location` |
| `Materiais` | `description` |
| `Data Prevista` + `Hora Início`/`Hora Fim` | `start`/`end` (all-day quando sem hora) |
| `ID` (agendamento) | `extendedProperties.private.agId` |

- **All-day** (sem `Hora Início`): `start.date`/`end.date` (end = dia seguinte, convenção da
  Calendar API para all-day de 1 dia).
- **Cronometrado** (com `Hora Início`): `start.dateTime`/`end.dateTime` no timezone
  `America/Sao_Paulo` (do manifest). Sem `Hora Fim`, assume-se **+1h** por padrão.
- `agId` em `extendedProperties.private` é a chave imutável que amarra evento↔linha, imune a
  edições humanas de título/local/descrição.
- **Fotos não vão para o Calendar** nesta fase. Permanecem no Drive, vinculadas por `agId`, e
  seguem aparecendo no PDF. (Opcional futuro: anexar link do Drive na `description`.)

## 5. Fluxo de ida (planilha → Calendar)

Estende `syncAgendamentos_`. Após montar/gravar as linhas (lógica atual preservada), para
cada operação:

- **upsert:**
  1. Calcular `hashNovo` do conteúdo canônico (§7).
  2. Se `Event ID` vazio → `Calendar.Events.insert` no calendário dedicado com `agId`; guardar
     `Event ID` na linha.
  3. Se `Event ID` presente → `Calendar.Events.patch` com os campos mapeados.
  4. Gravar `Hash Cal = hashNovo` e `Sincronizado Em = now`.
- **delete:**
  1. `Calendar.Events.delete` do `Event ID` (se houver).
  2. Marcar linha `Cancelado = TRUE`, `Sincronizado Em = now` (tombstone; ver §8) — **não**
     remove a linha fisicamente.

`normalizeAgendamento_` passa a aceitar e validar `horaInicio`/`horaFim` (`^\d{2}:\d{2}$`,
`fim > inicio` quando ambos presentes; hora sem sentido em all-day é rejeitada só se `fim`
sem `inicio`).

**Isolamento de falha:** a gravação na planilha ocorre **antes** das chamadas ao Calendar.
Se uma chamada ao Calendar falhar, a linha é marcada com `Hash Cal` divergente (ou vazio) e
o erro é logado (Stackdriver); o próximo `reverseSyncAgendamentos_`/reconcile completo
reprocessa a ida. **O app nunca é bloqueado por indisponibilidade do Calendar** — o retorno
ao app reporta sucesso da parte estruturada e, opcionalmente, um aviso `calendarPendente:true`.

## 6. Fluxo de volta (Calendar → planilha)

`reverseSyncAgendamentos_`, disparado por **trigger de tempo a cada 5 min**:

1. Ler `AGENDAMENTOS_CAL_SYNC_TOKEN` das Script Properties.
2. `Calendar.Events.list(calendarId, { syncToken, showDeleted: true })` — retorna só o que
   mudou desde a última rodada (criados, editados, cancelados). Paginar via `pageToken`.
3. Se a API responder **410 GONE** (token expirado) → limpar token e fazer **resync completo**:
   listar todos os eventos com `agId` e reconciliar cada um.
4. Para cada evento retornado:
   - Ignorar eventos sem `agId` (criados à mão fora do fluxo — ver §11, fora de escopo).
   - Localizar a linha por `agId`.
   - `status === 'cancelled'` → tratar como **exclusão** (§8).
   - Caso contrário → mapear evento → agendamento, calcular `hashEvento`; se
     `hashEvento === Hash Cal` da linha → **sem mudança real** (foi eco da nossa própria ida),
     pular. Senão → aplicar LWW (§7).
5. Ao final, gravar o novo `nextSyncToken` retornado.
6. Invalidar cache (§9).

Envolvido no mesmo `LockService` da ida.

## 7. Reconciliação (LWW) e anti-ping-pong

**Hash de conteúdo canônico** (função pura, testável):

```
canonical(ag) = [cliente, endereco, materiais, dataPrevista,
                 horaInicio, horaFim, cancelado].join('')
hash(ag)      = MD5(canonical(ag))  // Utilities.computeDigest, hex
```

- `Hash Cal` guarda o hash refletido por último entre planilha e Calendar. Serve para
  **detectar mudança real** e cortar o ping-pong: quando a ida escreve um evento, isso bumpa o
  `updated` do evento; sem o hash, o `reverseSync` acharia que "mudou" e tentaria reescrever a
  planilha em loop. Com o hash, um evento cujo conteúdo bate com `Hash Cal` é ignorado.

- **Decisão do vencedor** (só quando há mudança real dos dois lados): comparar
  `evento.updated` (RFC3339) com `linha.SincronizadoEm`.
  - `evento.updated > SincronizadoEm` → **Calendar vence**: atualizar a linha com os campos do
    evento, `SincronizadoEm = evento.updated`, `Hash Cal = hashEvento`.
  - caso contrário → **planilha vence**: reescrever o evento a partir da linha (patch),
    `Hash Cal = hashLinha`.

- **Granularidade:** LWW é por registro inteiro, não por campo. Edições simultâneas em campos
  diferentes nos dois lados → o registro mais novo vence por completo; a edição mais antiga se
  perde. Aceitável para "agendamento frouxo"; documentado como limitação (§13).

## 8. Exclusão (tombstones)

Delete precisa de tombstone porque LWW compara timestamps — apagar a linha fisicamente
perderia o timestamp e um evento remanescente seria "ressuscitado" como novo.

- **App exclui** (`op:'delete'`): `Cancelado=TRUE`, `SincronizadoEm=now`, evento deletado no
  Calendar.
- **Calendar exclui** (`status==='cancelled'` no reverse): achar linha por `agId`; comparar
  `evento.updated` vs `SincronizadoEm`:
  - Calendar mais novo → `Cancelado=TRUE`, `SincronizadoEm=evento.updated`.
  - planilha mais nova (houve edição no app depois) → **recriar** o evento a partir da linha.
- **`getAgendamentos_` filtra linhas com `Cancelado=TRUE`** — some da UI/PDF, exatamente como
  hoje, mas a linha persiste como tombstone.
- **Limpeza:** o próprio trigger (ou um trigger diário) remove fisicamente tombstones com
  `SincronizadoEm` > 90 dias, compactando a planilha (mesma lógica de compactação já existente
  em `syncAgendamentos_`).

## 9. Cache

`getAgendamentos_` cacheia por `age:<lastRow>:<data>` por 600s. Edições in-place (upsert de
linha existente, e agora o reverse sync) não mudam `lastRow` → risco de servir dado velho.

Correção: manter Script Property `AGE_CACHE_VER` (inteiro), incrementada em **qualquer**
escrita na planilha (ida e volta), e incluí-la na chave: `age:<ver>:<lastRow>:<data>`. Assim
qualquer escrita invalida o cache logicamente sem varrer chaves.

## 10. Setup e configuração (uma vez)

1. **Manifest** (`gas/appsscript.json`): habilitar o Advanced Calendar Service e o escopo.
   ```json
   "dependencies": {
     "enabledAdvancedServices": [
       { "userSymbol": "Calendar", "version": "v3", "serviceId": "calendar" }
     ]
   },
   "oauthScopes": [ "https://www.googleapis.com/auth/calendar" ]
   ```
   (Manter os escopos já usados por Sheets/Drive; a lista precisa ser completa quando
   declarada explicitamente.)
2. **Função de setup** `setupAgendamentosCalendar()` (executada manualmente uma vez): cria o
   calendário "Coletas Agendadas" se não existir, grava `AGENDAMENTOS_CALENDAR_ID` nas Script
   Properties e loga o ID. O **compartilhamento com a equipe** é passo manual no Google
   Calendar/Admin (documentar no `gas/README.md`).
3. **Trigger** de tempo para `reverseSyncAgendamentos_` a cada 5 min (criado por
   `installAgendamentosTrigger()` ou manualmente).
4. **Redeploy** do Web App após alterar o manifest (novo consentimento de escopo).

Novas Script Properties: `AGENDAMENTOS_CALENDAR_ID`, `AGENDAMENTOS_CAL_SYNC_TOKEN`,
`AGE_CACHE_VER`.

## 11. Alterações no app (mínimas, aditivas)

- **`agendamentos.html`**: campos opcionais `Hora Início` / `Hora Fim` (`<input type="time">`)
  no formulário; incluir em `readForm`/`setFormFields`/`clearForm`; validar `fim > início`
  quando ambos presentes; exibir hora na tabela quando houver.
- **`google-sync.js`**: `getAgendamentos` passa a devolver `horaInicio`/`horaFim`;
  `syncAgendamentos` inclui esses campos no payload de upsert.
- **PDF (`gerarPdfDaData`)**: exibir a hora junto ao cliente/coluna quando presente.
- **Nada muda** na forma de o app acessar o Google (continua só GAS + token).

## 12. Tratamento de erros

| Situação | Comportamento |
|---|---|
| Calendar indisponível na ida | Planilha é gravada; erro logado; linha fica com `Hash Cal` divergente; reconcile posterior espelha. App recebe `ok:true` + `calendarPendente:true`. |
| `syncToken` expirado (410) | Limpa token, faz resync completo por `agId`. |
| Evento sem `agId` | Ignorado (fora de escopo criar via Calendar puro). |
| Evento corrompido/uma linha falha no reverse | `try/catch` por evento; não aborta o lote; erro logado. |
| Concorrência ida × volta | Serializadas pelo mesmo `ScriptLock` (`waitLock(30000)`). |

## 13. Escopo e não-escopo (YAGNI)

**No escopo:** calendário compartilhado dedicado; ida síncrona; volta por trigger+syncToken;
LWW por timestamp com hash anti-ping-pong; hora opcional; tombstones + limpeza; hardening de
cache.

**Fora de escopo (agora):**
- Agendas pessoais por coletor / mapeamento cliente→responsável.
- Fotos dentro do evento do Calendar (permanecem no Drive/PDF).
- Push/watch em tempo real (polling de 5 min basta).
- Recorrência/periodicidade (segue one-off).
- UI de resolução de conflito (LWW é automático).
- **Criar agendamento nascendo no Calendar sem `agId`** (evento "solto"): não é importado nesta
  fase — só reconciliamos eventos que o GAS criou. Adotar depois exige política de "adoção" de
  eventos órfãos.

## 14. Riscos e limitações

- **Latência não-realtime:** mudanças no Calendar aparecem no app em até ~5 min (intervalo do
  trigger).
- **LWW por registro inteiro** (não por campo): edições simultâneas em campos diferentes → a
  mais antiga é sobrescrita inteira.
- **Consistência de `extendedProperties`:** todas as operações de Calendar usam o Advanced
  Calendar Service (não `CalendarApp`), para garantir que `agId` seja escrito e lido de forma
  consistente. Validar no smoke test.
- **Passos manuais de Workspace:** criar/compartilhar calendário, habilitar Advanced Service,
  instalar trigger, redeploy — documentados no `gas/README.md`.
- **Crescimento de tombstones** mitigado pela limpeza de 90 dias.

## 15. Testes

Seguindo o padrão existente (`tests/*.cjs` com `vm` + mocks de serviços Google):

- **Unitários (Node, funções puras):**
  - `canonical`/`hash` — estabilidade e sensibilidade a cada campo.
  - `agendamento → evento` e `evento → agendamento` (all-day e cronometrado, +1h default).
  - Decisão LWW (`evento.updated` vs `SincronizadoEm`, incluindo empate).
- **Integração GAS (vm + mocks):** estender o harness com mocks de `Calendar` (advanced) e
  cobrir:
  - Ida: upsert cria evento e grava `Event ID`/`Hash Cal`; delete vira tombstone + delete de
    evento.
  - Volta: evento editado com `updated` mais novo → linha atualizada; eco (hash igual) →
    ignorado (sem ping-pong); `status:cancelled` mais novo → tombstone; `cancelled` mais velho
    que edição do app → evento recriado.
  - `getAgendamentos_` esconde `Cancelado=TRUE`.
- **Manual (round-trip real):** criar no app → aparece no Calendar; editar título/hora no
  Calendar → volta pra planilha/app em ≤5 min; excluir nos dois lados; validar `agId` em
  `extendedProperties` via API.

## 16. Passos de implementação (visão macro)

1. Manifest: Advanced Calendar Service + escopo; redeploy.
2. Script Properties + `setupAgendamentosCalendar()` + `installAgendamentosTrigger()`.
3. Estender `AGENDAMENTOS_HEADERS` + migração em `getAgendamentosSheet_`.
4. Helpers puros: `canonicalAgendamento_`, `hashAgendamento_`, `agToEvent_`, `eventToAg_`,
   `decideWinner_`.
5. Ida em `syncAgendamentos_` (+ `normalizeAgendamento_` com hora; soft-delete/tombstone).
6. `reverseSyncAgendamentos_` (syncToken, 410→resync, LWW, tombstone, limpeza).
7. Versionamento de cache (`AGE_CACHE_VER`).
8. Front-end: hora opcional em `agendamentos.html`, `google-sync.js`, PDF.
9. Testes (unitários + integração vm) e checklist manual.
10. Atualizar `gas/README.md` com setup e passos manuais.

O plano detalhado (ordem, arquivos, critérios de verificação) vem do skill de writing-plans.
