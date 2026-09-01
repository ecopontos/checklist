# Notificação de última sincronização da pasta de rede

**Data:** 2026-09-01
**Status:** Aprovado — pronto para plano de implementação

## Contexto

Desde a mudança que reabilitou o import completo a partir do `cstExportaCheckList.csv` da
pasta de rede (`checkAndImportRoteirosRede`, ver
[2026-08-26-logradouros-rede-design.md](2026-08-26-logradouros-rede-design.md)), o app sincroniza
automaticamente ao abrir, mas isso acontece em silêncio — não há nenhum indício visível pro
operador de que os dados na tela são os mais recentes do Access, nem de quando foi a última vez
que o arquivo mudou.

## Objetivo

Mostrar, de forma discreta e sempre visível, a data/hora de modificação do arquivo
`cstExportaCheckList.csv` mais recente que o app já processou — dando confiança ao operador de que
está vendo dados atualizados, sem exigir que ele visite o Admin pra conferir.

### Não-objetivos

- Alertar/colorir quando o dado estiver "desatualizado" (exigiria definir um limite arbitrário de
  horas; fica de fora por ora).
- Toast ou notificação transitória — a informação fica sempre visível, não pisca e some.
- Rodar uma nova checagem de rede a partir de `coleta-checklist.html` — só `index.html` já faz
  isso hoje, no `init()`.

## Dado exibido

`localStorage['app3_last_rotas_rede_sync']` já guarda o `modified_time_ms` do arquivo (não o
horário em que o app rodou a checagem) — é o dado certo pra responder "isso é o CSV mais recente
do Access?", já setado por `checkAndImportRoteirosRede` em `google-sync.js`.

Formato de exibição: `Dados atualizados em 01/09/2026 às 14:26` (pt-BR, `toLocaleDateString` +
`toLocaleTimeString` com `hour`/`minute`).

### Casos especiais

- **Nunca sincronizado** (chave vazia/0): `Dados: nunca sincronizados automaticamente`.
- **Fora do app instalado** (sem `window.__TAURI__`, ex.: teste no navegador): reaproveita a
  mensagem já usada em `admin.html`: `Sincronização automática só funciona no app instalado`.

## Componentes

### `google-sync.js`

Novo getter exportado, seguindo o padrão já existente (`getGasUrl`, `getGasRouteToken`):

```js
export function getLastRotasRedeSync() {
    const tauri = typeof window !== 'undefined' ? window.__TAURI__ : undefined;
    if (!tauri || !tauri.core || typeof tauri.core.invoke !== 'function') {
        return { available: false };
    }
    const ms = Number(localStorage.getItem(LAST_ROTAS_REDE_SYNC_KEY) || 0);
    return { available: true, ms: ms || null };
}
```

Retorna `available:false` quando fora do Tauri (mesma checagem que `checkAndImportRoteirosRede` já
faz), e `ms:null` quando nunca sincronizou. Pura leitura de `localStorage` — nenhuma chamada de
rede nova.

### `index.html`

Depois que `checkAndImportRoteirosRede(db)` resolve (sucesso, falha ou not-tauri), renderiza a
label num elemento de texto discreto perto do cabeçalho, chamando um helper local
`renderSyncLabel()` que usa `getLastRotasRedeSync()`.

### `coleta-checklist.html`

No `init()`, sem chamar nenhuma função de sync nova: só chama `getLastRotasRedeSync()` e renderiza
o mesmo texto no mesmo lugar relativo (perto do cabeçalho da página).

### Estilo

Texto pequeno, cor mutada (reaproveita a paleta já usada pro `sync-status` do admin, sem o
dot colorido — não é um indicador de saúde de conexão, é só uma data). Sem botão de fechar, sem
popup.

## Testes

Sem teste automatizado dedicado — é renderização de texto estático a partir de um valor já
coberto pelos testes de `checkAndImportRoteirosRede` (`tests/rotas-rede-sync.test.cjs`). Verificação
manual no navegador (Playwright) cobre os 3 casos: nunca sincronizado, not-tauri, e com timestamp
salvo (setando a chave manualmente antes de carregar a página).
