# Escrita de volta: aplicar reorganização/status direto em tblRotas (Subprojeto A)

**Data:** 2026-08-12
**Status:** Aprovado — pronto para plano de implementação
**Epic:** Escrita de volta ao Sheets. Este é o **subprojeto A** de quatro:
A (reorg/status · este) → B (edição de cliente) → C (criação de cliente) → D (criação de roteiro).

## Contexto

Com o Access aposentado e o Google Sheets como fonte de verdade (ver
`2026-08-12-roteiros-fonte-sheets-design.md`), o caminho de escrita atual ficou **órfão**:

```
UI (reordenar / ativar-inativar)
  → outbox local (roteiro_change_outbox)
  → pushRoteiroChanges → GAS saveRouteChanges_
  → anexa linhas na aba-log AlteracoesRoteiros (status PENDENTE)
  → [Access lia o log e aplicava aos dados]   ← NINGUÉM FAZ MAIS ISSO
```

Ou seja: reorganizações e mudanças de status feitas no app **não voltam** para as abas
(`tblRotas`). Elas se acumulam num log que nada aplica.

### Modelo de domínio (confirmado com o dono)

Cada linha de `tblRotas` é **"cliente X no roteiro Y"**, com histórico. Não há operação de
"mover ponto entre roteiros": uma **transferência** é feita **inativando** o ponto no roteiro atual
e **inserindo** uma nova linha no outro roteiro. Isso preserva o histórico do cliente em cada
roteiro. (A inserção é criação de linha — subprojeto C.)

## Objetivo

Fazer o GAS **aplicar diretamente em `tblRotas`** as alterações de **`Ordem`** e **`Inativo`** que o
app já envia, no mesmo momento em que registra o log de auditoria. O log `AlteracoesRoteiros`
continua existindo como **trilha de auditoria + ledger de idempotência**.

### Não-objetivos (outros subprojetos / follow-ups)

- Editar nome/endereço/telefone do cliente → **B** (grava em `shtClientes`).
- Criar cliente/ponto novo e inserir em roteiro → **C**.
- Criar roteiro novo → **D**.
- Reescrever a página `ajuda-integracao-access.html` e textos de marketing/legado ("Substitua o
  Access", "Importar Legado (Access/Excel)") — follow-up de documentação, fora do A.

## Escopo do app: **zero mudança**

O lado do cliente já produz tudo que o A precisa e **não muda**:

- `applyRoteiroOrder` (reordenar em lote) enfileira no outbox `id_rota` + `ordem` novos.
- `toggleStatus` → `queueAndSyncAccessChange` → `queueRoteiroChange` enfileira `id_rota` + `inativo`.
- `syncPendingRoteiroChanges` → `pushRoteiroChanges` envia o lote; a confirmação por
  `acceptedIds`/`duplicateIds` limpa o outbox.

O A evolui **apenas o GAS**. Apps antigos e novos mandam o **mesmo payload** de `routeChanges`; o GAS
novo só passa a **aplicar** esse payload em `tblRotas`.

## Abordagem escolhida (A1): escrita direcionada

Aplicar em `tblRotas` **apenas as células alteradas** (`Inativo` + `Ordem`) das linhas afetadas,
localizando-as por `idRota`. Não reescrever coluna/faixa inteira, para **não sobrescrever edições
manuais** feitas online na planilha (ela é editável por humanos).

Alternativas descartadas:

- **A2 — reescrever a faixa inteira:** código mais simples, mas clobbera edições manuais
  concorrentes entre a leitura e a escrita.
- **A3 — largar o log e só aplicar:** perde auditoria/idempotência e o fluxo de confirmação do app
  depende de `acceptedIds`. Mais mudança, sem ganho.

## Design (GAS — `saveRouteChanges_`)

Tudo dentro do `LockService` que já existe na função:

1. **Como hoje:** dedup por `change_id` contra o log; monta `acceptedIds`/`duplicateIds`; anexa os
   aceitos na aba `AlteracoesRoteiros`.
2. **Novo — aplicar em `tblRotas`:**
   - Abre a aba `tblRotas` (`TBL_ROTAS`). Lê o cabeçalho e resolve os índices de `idRota`,
     `Inativo`, `Ordem`. Se algum faltar → `{ok:false, error}` nomeando a coluna.
   - Lê a coluna `idRota` uma vez e monta `idRota → número da linha`.
   - Para cada alteração **aceita** (não duplicada), usa uma função pura
     **`planRotaWrites_(idRowMap, changes)`** que devolve a lista de escritas
     `[{ row, ordem, inativo }]` — testável fora do Apps Script.
   - Executa as escritas direcionadas: `Inativo` como **booleano** (`change.inativo === 1`,
     respeitando o checkbox da coluna) e `Ordem` como **número**. Como `Inativo` e `Ordem` são
     colunas **adjacentes** em `tblRotas`, quando adjacentes grava as duas de uma vez
     (`getRange(row, colInativo, 1, 2).setValues([[inativo, ordem]])`); senão, duas escritas.
3. **`idRota` ausente em `tblRotas`:** registra no log uma mensagem ("id_rota ausente em tblRotas"),
   **mas ainda aceita** o `change_id` (o app limpa o outbox e não fica repetindo). Conta como
   `skippedApply`, devolvido na resposta para diagnóstico.

### Idempotência e concorrência

- **Idempotência:** mantida pelo `change_id` (dedup contra o log). Além disso, setar `Ordem`/`Inativo`
  ao mesmo valor é inócuo, então um reenvio é seguro mesmo que a linha do log já exista.
- **Concorrência:** reusa o `LockService.getScriptLock()` (30 s) já presente. A escrita direcionada
  minimiza conflito com edição manual concorrente.

### Versão / contrato

- `GAS_API_VERSION` sobe **4 → 5** apenas para rastreabilidade de deploy. Não muda o contrato de
  request nem de response; o cliente exige `≥ 4`, então nada quebra.
- Resposta de `routeChanges` ganha um campo opcional `skippedApply` (contagem de `idRota` não
  encontrados). O cliente atual ignora campos extras — sem impacto.

## Polimento de texto (parte do A)

Uma vez que o GAS aplica **na hora**, as mensagens que dizem "aguarda importação no Access" ficam
**factualmente erradas**. Reescrever para refletir aplicação direta na planilha:

| Arquivo | Linha (aprox.) | Hoje | Vira |
|---------|----------------|------|------|
| `roteiros.html` | 450 | "…são enviadas ao Access." | "…são salvas na planilha." |
| `roteiros.html` | 757 | "…cadastre-os no Access antes de reorganizar." | "…cadastre-os na planilha antes de reorganizar." |
| `roteiros.html` | 788 | "…enviar N alteração(ões) ao Access?" | "…salvar N alteração(ões) na planilha?" |
| `roteiros.html` | 823 | "…aguarda a importação no Access." | "…foi aplicada na planilha." |
| `roteiros.html` | 892 | "…ainda não enviada ao Access: …" | "…ainda não sincronizada: …" |
| `admin.html` | 600 | "…enviada(s); aguardando importação no Access" | "…aplicada(s) na planilha" |
| `database.js` | 165 | "…não existem no Access." | "…não existem na planilha." |
| `database.js` | 306 (comentário) | "…pendentes para o Access" | "…pendentes para a planilha" |

Os identificadores internos (`queueAndSyncAccessChange`, `isExistingAccessPoint`) **não** serão
renomeados nesta etapa (churn cosmético sem valor de usuário). A reescrita da página de ajuda fica
como follow-up.

## Rollout (seguro, só GAS)

1. Reimplantar o `Code.gs` (mesma implantação/URL). A partir daí **todos** os apps — antigos e novos
   — passam a ter suas reorganizações/status aplicadas em `tblRotas` (mandam o mesmo payload).
2. O polimento de texto viaja no próximo build/distribuição do app; é cosmético e independente do
   deploy do GAS.

Não há janela de quebra: o payload de `routeChanges` é o mesmo de antes; o GAS apenas faz mais.

## Tratamento de erros / edge

- Coluna ausente em `tblRotas` (`idRota`/`Inativo`/`Ordem`) → `{ok:false, error}` nomeando a coluna;
  o app mantém o outbox (reenvia depois).
- `idRota` não encontrado → aceita o `change_id`, conta em `skippedApply`, log com mensagem.
- Falha ao obter o lock em 30 s → erro atual do `LockService` propaga como hoje.
- Após aplicar, o `getLastUpdated` da planilha muda → o próximo `checkAndImportRoteiros` reimporta e
  o app converge com o que ele mesmo já aplicou localmente (round-trip consistente).

## Testes / verificação

- **`planRotaWrites_` (pura):** dado um mapa `idRota→linha` e um lote de alterações, devolve as
  escritas corretas; `idRota` ausente não entra nas escritas e conta como skipped. Testável em node
  contra a `tblRotas` real (mesma abordagem do `buildFlatRoteiros_`).
- **Idempotência:** reenviar o mesmo `change_id` não duplica no log nem altera o resultado em
  `tblRotas`.
- **Suíte existente:** `npm test` (route-order, fila multibatch) segue verde — o contrato do app não
  muda.
- **Ponta a ponta:** no app, reordenar/inativar um ponto, sincronizar, e confirmar que a `tblRotas`
  refletiu (checar a célula na planilha) e que um novo `checkAndImportRoteiros` traz o mesmo estado.

## Riscos

- **Edição manual concorrente** na mesma linha entre a leitura e a escrita do GAS: a escrita
  direcionada reduz, mas não elimina (o lock é do script, não bloqueia o editor humano). Aceitável
  para reorg/status; última escrita vence no campo. Mitigação futura se necessário: verificar valor
  atual antes de gravar.
- **`idRota` como número vs. texto** ao mapear: normalizar com o mesmo `cleanIntString_` usado na
  leitura, para casar `idRota` do outbox (string numérica) com a célula (número).
- **Volume:** lotes ≤ 100; escritas direcionadas por linha alterada — dentro dos limites do GAS.
