# Disparo WhatsApp — tags `{residuo}` e `{data}` na mensagem

**Status:** decisão revisada e alinhada à implementação do standalone.

> **Histórico:** a primeira versão desta spec propunha cadastrar `Tipo de Resíduo`
> em `tblRoteiros` e propagá-lo pelo GAS e pelo SQLite local. Essa solução foi
> substituída: o standalone resolve `{residuo}` localmente a partir do nome do
> roteiro. A proposta antiga não deve ser usada como instrução de implementação.

## Contexto

O disparo de WhatsApp já consulta a última coleta com intercorrência de cada
cliente do roteiro selecionado por meio de `getIntercorrenciasRoteiro`. A mensagem
precisa poder usar a data dessa coleta e o tipo de resíduo associado ao roteiro.

Neste projeto, o tipo de resíduo é fixo por roteiro e não varia por operação ou
coleta individual. Para o uso atual do standalone, os nomes dos roteiros seguem
convenções suficientes para resolver esse valor localmente.

## Objetivo

Permitir estas substituições na mensagem:

- `{nome}`: nome do cliente;
- `{intercorrencia}`: intercorrência da última coleta relevante;
- `{data}`: data dessa coleta no formato `DD/MM/AAAA`;
- `{residuo}`: tipo de resíduo resolvido pelo nome do roteiro.

## Design

### 1. Resolução local do resíduo

`config.js` expõe:

- `window.ROTEIRO_TIPOS_RESIDUO`: regras versionadas de tipo e padrões de roteiro;
- `window.getTipoResiduoPorRoteiro(roteiroNome)`: função que aplica essas regras.

Um padrão terminado em `*` corresponde por prefixo; os demais padrões exigem
correspondência exata. A comparação ignora maiúsculas/minúsculas, a primeira
regra encontrada vence e um roteiro sem correspondência produz string vazia.

Mapeamento inicial:

- `SAT*`, `SOBI*`, `SatEpan` e `ESCOLA-ORGANICO-*` → `Organicos`;
- `SV*` → `Vidro`.

Esse mapeamento pertence ao standalone deste repositório. Alterá-lo exige uma
nova versão do aplicativo; ele não é lido do Google Sheets nem sincronizado pelo
GAS ou pelo SQLite.

### 2. Uso no disparo de WhatsApp

`database.js` continua entregando `roteiroNome` para cada contato. Em
`whatsapp-sender.html`, `buildMsg(contact)` resolve o resíduo com
`getTipoResiduoPorRoteiro(contact.roteiroNome)`.

A data e a intercorrência continuam vindo do registro em
`intercorrenciasPorIdRota`. Valor ausente em qualquer tag degrada para string
vazia, sem impedir o disparo.

### 3. Limites da decisão

Esta spec não define a fonte de `tipoResiduo` para o futuro
`ecoforms/desktop/logistics`. A ingestão desse consumidor pertence a outra spec e
outro projeto.

## Fora de escopo

- Coluna `Tipo de Resíduo` em `tblRoteiros`.
- Propagação de `TipoResiduo` pelo `action=roteiros`.
- Coluna `roteiros.tipo_residuo` no SQLite local.
- Ligação com o seletor de tipo de resíduo do PDF em `coleta-checklist.html`.
- Fonte de resíduo do futuro `desktop/logistics`.

## Critérios de sucesso

- Os padrões conhecidos retornam o tipo esperado sem distinguir caixa.
- Roteiro desconhecido retorna string vazia.
- `{data}` usa `DD/MM/AAAA` e `{residuo}` usa o resultado da configuração local.
- A dica da interface apresenta as quatro tags disponíveis.
- Nenhum dado de resíduo é exigido do Sheets, do GAS ou do SQLite.
