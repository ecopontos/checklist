# Monitoramento de instâncias conectadas via API GAS — Design

**Data:** 2026-11-16
**Status:** Aprovado (brainstorming) — pronto para plano de implementação

## Problema

O app (PWA/Tauri) conversa com o Google Apps Script (GAS) por ações GET/POST
(`status`, `cadastroSync`, `routeChanges`, syncs de coleta/agendamento, etc.),
mas **não existe nenhuma identidade de instância**: nenhuma instalação/dispositivo
se identifica ao servidor. Não há como saber quais instâncias estão ativas, qual
versão de app/GAS cada uma usa, nem detectar instalações apontando para um
deployment errado (ver incidente do "deployment GAS v13 órfão").

## Objetivos (todos marcados pelo usuário)

1. **Saber quem está ativo** — ver quais dispositivos usam o app e sincronizam.
2. **Diagnóstico de config** — detectar instalações apontando para deployment/versão
   errada do GAS.
3. **Auditoria de uso** — histórico de quem sincronizou o quê e quando.
4. **Alerta de offline** — identificar instâncias que pararam de reportar há >X tempo.

Todos os quatro são atendidos pelo mesmo mecanismo central (identidade de instância
+ heartbeat por carona + aba de registro); mudam apenas as colunas capturadas.

## Decisões de escopo (do brainstorming)

- **Identidade:** UUID por instalação (gerado automaticamente) + apelido opcional +
  versão do app + URL/versão do GAS.
- **Heartbeat:** carona nas chamadas que o app **já faz** (sem timers, sem ação nova).
- **Visualização:** aba `Instancias` no Google Sheets. **Sem UI nova no app.**

## Arquitetura

```
App (PWA/Tauri)                         GAS (Code.gs)                 Planilha
─────────────                           ─────────────                 ────────
instance-identity.js                    recordHeartbeat_(src, meta)   aba "Instancias"
  • gera/guarda UUID (localStorage)  →    chamado no topo de       →    1 linha/instância
  • apelido + versão do app               doGet e doPost                 (upsert por UUID)
  • monta meta {iid,nick,av,gasUrl,ua}    antes de despachar a ação

google-sync.js
  • anexa a meta em toda chamada
    (query params no GET, campos no body do POST)
```

Toda chamada ao GAS carrega a identidade. O servidor, num único ponto central, faz
*upsert* na aba `Instancias` (acha a linha pelo UUID e atualiza; senão cria) e segue
o processamento normal da ação. Nenhuma ação nova no contrato, nenhum timer no cliente.

## Modelo de dados — aba `Instancias`

Uma linha por instalação, chaveada por `instanceId`.

| Coluna | Exemplo | Origem |
|---|---|---|
| `instanceId` | `a3f1c2e0-…` (UUIDv4) | cliente (localStorage, gerado 1x) |
| `apelido` | `Tablet Caminhão 07` | cliente (campo opcional no admin) |
| `appVersion` | `1.7.1` | cliente (lê do config/Tauri) |
| `gasUrlConfig` | `…/exec` que o app usa | cliente (localStorage) |
| `gasApiVersion` | `16` | **servidor** (constante `GAS_API_VERSION`) |
| `primeiroAcesso` | `2026-11-16T10:03Z` | servidor, só na criação |
| `ultimoAcesso` | `2026-11-16T14:21Z` | servidor, a cada chamada |
| `ultimaAcao` | `cadastroSync` | servidor (qual ação disparou) |
| `totalChamadas` | `342` | servidor (incrementa) |
| `userAgent` | `…Windows…` | cliente (`e` do GAS não traz UA) |

### Diagnóstico de config (caso v13 órfão)

`gasApiVersion` é gravada pelo **servidor**, então sempre reflete o deployment que
**efetivamente recebeu** a chamada. O campo que denuncia um órfão é o `gasUrlConfig`
reportado pelo cliente combinado com `appVersion`:

- Instância aponta pra URL certa → aparece com a URL correta. ✅
- Instância aponta pra URL errada **mas que ainda roda código com heartbeat** →
  aparece com `gasUrlConfig` divergente. 🚩 flag visível.
- Instância aponta pra deployment **velho (sem heartbeat)** → **não aparece** nesta
  aba (a chamada vai pro código antigo). A ausência é o próprio sinal: app ativo em
  campo que nunca registra = órfão.

### Mapeamento objetivo → colunas

- Quem está ativo: `ultimoAcesso` + `apelido`.
- Diagnóstico: `gasUrlConfig` + `appVersion` + `gasApiVersion`.
- Auditoria: `totalChamadas` + `ultimaAcao`.
- Alerta offline: `ultimoAcesso` vs. agora (coluna/formatação condicional
  "offline há >X" — ex.: destaque quando `agora - ultimoAcesso > 24h`).

## Pontos de código

### Cliente — novo módulo `instance-identity.js`

Pequeno, uma responsabilidade (identidade + metadados da instância):

- `getInstanceId()` — lê `satelite.instanceId` do localStorage; se não existe, gera
  `crypto.randomUUID()` e grava. Fallback (contexto não-seguro, sem `crypto`): id por
  `Date.now()` + `Math.random()`.
- `getApelido()` / `setApelido(v)` — campo opcional (`satelite.apelido`).
- `getInstanceMeta()` → `{ iid, nick, av, gasUrl, ua }` — junta UUID, apelido, versão
  do app (constante exposta a partir de `config.js`/`package.json` = `1.7.1`), URL do
  GAS em uso (`getGasUrl()` de `google-sync.js`) e `navigator.userAgent`.
- `appendInstanceParams(url)` — anexa `&iid=…&nick=…&av=…&ua=…` (encode) a uma URL GET.
- `withInstanceMeta(body)` — faz spread da meta num objeto de corpo POST.

### Cliente — `google-sync.js`

Os ~12 `fetch()` espalhados passam a usar os helpers. Para não editar 12 call sites
de forma frágil, centraliza em dois atalhos no fluxo:

- GETs (hoje `${url}?action=…`): helper `gasGet(action, params)` que já embute
  `appendInstanceParams`.
- POSTs (hoje `JSON.stringify(obj)`): objetos passam por `withInstanceMeta()` antes.

Nota: a versão do app precisa estar acessível em runtime no browser. Expor uma
constante `APP_VERSION` (sincronizada com `package.json`/`tauri.conf.json` = `1.7.1`),
preferencialmente no `prepare-dist.js` ou num `version.js` gerado, para não duplicar
manualmente.

### GAS — `Code.gs`

- Nova função `recordHeartbeat_(source, meta)`:
  - Abre/cria a aba `Instancias` (cria cabeçalho na 1ª vez).
  - Procura a linha pelo `instanceId`; faz upsert das colunas servidor + cliente;
    incrementa `totalChamadas`; grava `ultimaAcao = source`.
  - `gasApiVersion` = `GAS_API_VERSION`; `primeiroAcesso`/`ultimoAcesso` = `new Date()`.
  - `LockService.getScriptLock()` curto (~2s) em torno do upsert para dois
    dispositivos não corromperem a linha.
  - Tudo em `try/catch` — **nunca** derruba a ação principal se o log falhar.
- Chamada **uma vez** no topo de `doGet` e de `doPost`, lendo `iid/nick/av/ua` de
  `e.parameter` (GET) ou do `body` (POST). Se não vier `iid` (requisição legada/externa),
  não registra e segue normal.

## Tratamento de erros

- Heartbeat é *best-effort*: falha de escrita na aba é engolida (log em `Logger`), a
  ação segue normalmente.
- Cliente sem `crypto.randomUUID`: fallback por timestamp+random.
- Concorrência de escrita: `LockService` curto no upsert.
- Ausência de `iid`: ignora silenciosamente (compatível com chamadas antigas).

## Testes

- **Cliente (`instance-identity.js`):** gera id estável e persistente; `getInstanceMeta`
  bem formada; fallback sem `crypto`; `appendInstanceParams`/`withInstanceMeta` corretos.
- **GAS (`recordHeartbeat_`):** cria linha nova; upsert em linha existente incrementando
  contador; ignora quando `iid` ausente; não lança quando a escrita na aba falha.
- **Integração leve:** `fetch` mockado confirmando que a meta viaja no GET (query params)
  e no POST (campos do body).

## Fora de escopo (YAGNI)

- UI de painel no app (admin/dashboard) — usuário escolheu só a aba do Sheets.
- Ping dedicado/periódico com timer — usuário escolheu carona nas chamadas.
- Reportar roteiro atual da instância — não selecionado.
- Alerta ativo (e-mail/push) de offline — por ora, inspeção visual na planilha.
