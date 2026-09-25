# Revisão de digitação de checklist e sincronização

Data: 2026-09-18. Escopo: código do workspace do Checklist standalone,
incluindo alterações ainda não commitadas. O documento registra a revisão
original e, abaixo, o estado após a implementação.

**Status em 2026-09-18:** F01–F11 corrigidos e validados localmente. Publicação
do GAS API 10 e distribuição de um novo frontend/instalador permanecem pendentes.

## Resultado

Foram identificados 11 gaps acionáveis. Os mais urgentes envolvem perda de
digitação, gravação parcial, duplicação no reenvio legado, alteração do contexto
histórico e substituição de PDF no Drive.

O dashboard já utiliza uma rotina mais robusta de sincronização, mas as telas
de Coleta e Análise ainda usam caminhos próprios. As melhorias do dashboard
não se propagaram automaticamente a esses fluxos.

P1 = corrigir prioritariamente por risco de perda, duplicação ou atribuição
incorreta dos registros. P2 = corrigir em seguida por inconsistência ou falha
de recuperação. As prioridades não afirmam que houve perda em produção.

## Implementação aplicada

| Achados | Correção local |
| --- | --- |
| F01, F04 | Operação persistida de uma vez, com restauração em falha, identidade idempotente e snapshots de cliente/roteiro. |
| F02 | Formulário ativo integra o estado pendente; salvar registra a edição e troca/saída não a descarta silenciosamente. |
| F03, F07, F11 | Uma fila compartilhada persiste IDs legados, valida o reconhecimento integral do lote, serializa envios e tenta novamente ao abrir, recuperar conexão, voltar à tela e por ação manual. |
| F05 | O GAS cria o novo PDF antes de retirar o anterior, sob lock, e informa limpeza incompleta. |
| F06 | Importação usa `idRota` como identidade e rejeita conflitos do mesmo ID antes de alterar o cadastro. |
| F08, F09 | Quantidades exigem inteiro seguro não negativo e datas civis válidas, não futuras, em São Paulo; cliente, banco e GAS aplicam a regra. |
| F10 | Cada abertura do modal possui contexto imutável; respostas e ações antigas são canceladas após fechar, reabrir ou trocar roteiro. |

Registros locais anteriores recebem o contexto disponível durante a migração,
marcado como `legacy-local`; isso não reconstrói uma verdade histórica ausente.
O cadastro é relido uma vez para recuperar pontos que versões antigas poderiam
ter unido pelo nome.

## Achados

### F01 — P1 — Salvar uma operação não é atômico

**Código:** `coleta-operation.js:465`, `database.js:660` e `database.js:127`.

Cada atendimento é inserido e persistido separadamente. Se o segundo
salvamento falhar, o primeiro já ficou gravado, e a segunda inserção permanece
na memória. A tela informa falha da operação, mantendo-a disponível para nova
tentativa; essa tentativa gera novos registros e novos identificadores.

**Reprodução:** com SQL.js real e `localStorage` simulado, uma falha na segunda
gravação deixou dois registros em memória e um persistido. Repetir o lote após
recuperar o armazenamento produziu quatro registros: dois para cada ponto.

**Correção indicada:** salvar o conjunto como uma unidade e restaurar o estado
em memória se a persistência falhar; atribuir identidade estável à operação e
às suas entradas antes da tentativa. Uma transação SQL isolada não resolve a
falha posterior ao exportar o banco para `localStorage`.

### F02 — P1 — Digitação ainda não registrada pode desaparecer sem aviso

**Código:** `coleta-operation.js:38`, `:89`, `:180`, `:427` e `:452`.

`hasUnsavedEntries()` só verifica `sessionData`. Quantidade e intercorrência
nos campos de entrada rápida só chegam a essa estrutura depois de Registrar.
Trocar de roteiro, selecionar outro ponto ou sair pode descartar o formulário
ativo. Se já houver outras entradas registradas, Salvar operação também pode
salvar essas entradas e limpar o formulário ativo sem incluí-lo.

**Reprodução:** selecionar um ponto, preencher quantidade 8 e uma ocorrência,
sem Registrar, resulta em `hasUnsavedEntries() === false` no código executado
com DOM simulado.

**Correção indicada:** rastrear o formulário ativo como edição pendente e
validá-lo/confirmá-lo antes de salvar, trocar de ponto, trocar de roteiro ou sair.

### F03 — P1 — Reenvio manual de registros legados pode duplicar coletas

**Código:** `analise.html:274`, especialmente `:289`.

O botão Forçar sincronização gera um UUID para linhas sem `sync_id`, mas não
o persiste antes do POST. Se o servidor gravar e a resposta se perder, a
tentativa seguinte usa outro UUID e a deduplicação do GAS não a reconhece.

**Reprodução:** executar duas vezes o handler real com uma mesma pendência
legada e respostas de falha enviou IDs diferentes, mantendo o ID local nulo.
O dashboard não tem essa falha: `syncPendingColetas()` persiste o ID antes.

**Correção indicada:** reutilizar a rotina compartilhada em todos os caminhos,
incluindo a geração persistente de IDs e o processamento em lotes.

### F04 — P1 — Pendências não preservam o roteiro e o nome no momento da coleta

**Código:** `database.js:88`, `:660` e `:715`; `dashboard.js:231`.

A coleta local armazena o vínculo `id_rota`, mas não o roteiro/nome usados no
registro. O reenvio monta esses campos com JOIN no cadastro atual. Se o CSV
mudar o ponto de roteiro antes do envio, a coleta antiga será enviada com o
novo roteiro. O dashboard importa o cadastro antes de reenviar pendências,
portanto essa sequência é alcançável no fluxo normal.

**Reprodução:** manter a coleta pendente e alterar o cadastro de ORIGINAL para
NOVO mudou o payload retornado por `getUnsyncedColetas()` sem alterar a coleta.
O nome do cliente também mudou. A classificação local dos históricos usa o
mesmo tipo de JOIN.

**Correção indicada:** persistir os identificadores e o contexto necessários
no momento da operação, separando histórico do retrato atual do cadastro.

### F05 — P1 — Substituir um PDF pode retirar o anterior sem gravar o novo

**Código:** `gas/Code.gs:1670`, especialmente `:1681` a `:1688`.

`saveChecklist_()` move o PDF anterior para a lixeira antes de decodificar e
criar o substituto. Uma falha nessas etapas deixa a pasta sem a versão válida
anterior. O arquivo fica na lixeira, sem recuperação automática pelo fluxo.

**Reprodução:** executar a função real com Drive simulado e `createFile()`
lançando erro confirmou que `setTrashed(true)` já havia sido executado.

**Correção indicada:** criar e confirmar o substituto antes de retirar o
anterior, protegendo também a substituição contra envios concorrentes.

### F06 — P1 — Importação elimina pontos distintos com o mesmo nome

**Código:** `database.js:365` a `:370`.

O import deduplica por `Roteiro + Cliente`, em vez de `idRota`. Dois pontos
legítimos com o mesmo nome no mesmo roteiro são reduzidos à última linha,
mesmo quando têm IDs e endereços diferentes. Um deles fica indisponível para
digitação em uma base nova.

**Reprodução:** importar IDs 101 e 102, mesmo nome/roteiro e ruas diferentes,
retornou um único cliente; só o ID 102 ficou no banco.

**Correção indicada:** deduplicar pela identidade do vínculo e informar conflitos,
preservando pontos diferentes que compartilham nome.

### F07 — P2 — Há confirmação de sync sem conferir a confirmação do lote

**Código:** `coleta-operation.js:502` e `analise.html:292`.

Ambos os caminhos marcam todas as linhas como sincronizadas se receberem
`ok:true`, sem conferir `count` e `duplicates`. Uma resposta incompleta ou
incompatível encerra as pendências mesmo sem confirmação integral. A rotina
usada pelo dashboard já exige que a soma corresponda ao tamanho do lote.

**Reprodução:** `syncColetasToSheet()` recebeu `{ok:true,count:0}` para uma
coleta; chamou `markColetaSynced()` e terminou em `syncState = 'saved'`.
Essa é uma falha de validação do contrato: não foi observada resposta parcial
real do GAS publicado nesta revisão.

**Correção indicada:** centralizar a validação e concluir apenas registros
confirmados; tratar respostas incompatíveis como pendências, com erro visível.

### F08 — P2 — Quantidade digitada pode ser truncada ou inválida

**Código:** `coleta-operation.js:184` e `:365`.

A entrada rápida e a tabela usam `parseInt`. A entrada 1.5 vira 1 e 1e2 vira
1; a tabela ainda não repete a rejeição de negativos da entrada rápida. O
atributo HTML `min` não impede os handlers de consumir um valor inválido.
Com uma ocorrência preenchida, uma quantidade negativa pode permanecer na
sessão e chegar ao salvamento. O GAS também grava `c.quantidade || 0` sem
validar o domínio (`gas/Code.gs:1653`).

**Reprodução:** a função real `commitQuickEntry()` recebeu 1.5 e armazenou 1
sem erro. A inspeção dos handlers confirma validações diferentes entre os
dois modos de digitação.

**Correção indicada:** uma validação compartilhada de inteiro não negativo e
seguro na entrada rápida, tabela, salvamento e GAS; não corrigir silenciosamente
o valor digitado. Validar também datas civis e os campos essenciais no servidor.

### F09 — P2 — Data inicial ainda usa UTC, diferente do dashboard

**Código:** `coleta-operation.js:28` e `:452`.

`opDate.valueAsDate = new Date()` atribui a data UTC ao `input type=date`.
Após 21h em São Paulo, a data UTC já é a do dia seguinte. O salvamento verifica
apenas se a data está preenchida. Assim, a coleta pode ser registrada em data
futura e depois excluída dos indicadores pelas regras do ADR.

**Evidência:** atribuição no código e semântica de `valueAsDate`; não houve
execução em navegador nesta revisão. Exemplo de instante: 18/09 às 01h30 UTC
é 17/09 às 22h30 em São Paulo.

**Correção indicada:** preencher a data civil usando `America/Sao_Paulo`, de
forma compartilhada com o dashboard; definir explicitamente a política de
datas futuras e de lançamentos retroativos.

### F10 — P2 — Resposta antiga pode sobrescrever os dados do PDF atual

**Código:** `coleta-operation.js:566`, `:577` e `:601`.

O modal carrega data e quantidades sequencialmente. A primeira consulta tem
um identificador de requisição, mas a segunda captura o identificador global
somente quando começa. Se o modal for fechado/reaberto enquanto a primeira
consulta antiga aguarda, a continuação antiga pode usar o identificador do
novo modal e sobrescrever suas quantidades.

**Reprodução:** iniciar OLD, fechar/reabrir com NEW e concluir NEW primeiro
produziu `{NEW:1}`. Ao concluir a primeira consulta OLD, sua continuação
substituiu o estado por `{OLD:99}`, aceita como se fosse a consulta atual.

**Correção indicada:** capturar o contexto de roteiro/requisição uma vez e
validá-lo nas duas etapas; a geração do PDF deve consumir o resultado desse
contexto, sem depender de variáveis globais que outra consulta pode alterar.

### F11 — P2 — Recuperação das pendências depende da tela acessada

**Código:** `coleta-operation.js:489`, `index.html:331`,
`dashboard.js:234` e `:273`, `analise.html:274`.

Depois de uma falha no envio, a tela Coleta mostra sincronização pendente,
mas não oferece nova tentativa ali nem reenvia ao recuperar conexão. Salvar
outra operação envia apenas suas novas entradas. Reabrir a página inicial
atualiza cadastros, mas não processa coletas pendentes. A recuperação automática
foi implementada no dashboard; há também o botão manual de Análise.

**Evidência:** rastreamento dos callers e eventos de sincronização nas páginas.
O caso é alcançável ficando no fluxo Início → Coleta sem abrir Dashboard ou
Análise depois de um envio offline.

**Correção indicada:** um coordenador comum de envio e status, inicializado
nas telas operacionais, com reenvio ao recuperar conexão e ação manual clara.

## Limitações e decisões que precisam de definição operacional

- **Rascunho e correção:** a sessão de digitação fica em memória e não há
  retomada durável após encerramento inesperado. A operação salva agora possui
  identidade estável para tornar a retentativa idempotente, mas ainda não há
  fluxo explícito de correção/estorno. Uma segunda visita legítima não deve ser
  bloqueada por uma deduplicação simples por ponto/data.
- **Pontos inativos ou ausentes do CSV:** a tela e o PDF percorrem todos os
  clientes do roteiro, sem filtro de `ativo`; o import não desativa pontos
  ausentes no novo arquivo. Definir se devem aparecer para fins históricos,
  mas identificados e separados dos pontos previstos para a próxima operação.
- **PDF offline:** não existe fila persistente de PDFs a enviar. O envio
  manual captura falhas de rede, mas não tem timeout explícito nem bloqueio
  contra cliques repetidos. Download local é o caminho alternativo atual.

## Validação e limites da revisão

- `npm test` executou com sucesso os 22 scripts do projeto. O comando inclui
  persistência da operação, coordenador de sync, digitação, reenvio da Análise,
  importação histórica, integridade GAS e as suítes anteriores.
- `npm run prepare-dist` regenerou o frontend. Os dez arquivos afetados foram
  comparados por SHA-256 com as fontes; os grafos dos módulos foram ligados e
  os IDs das páginas foram verificados sem duplicidade.
- Reproduções adicionais executaram código real em Node/VM com SQL.js e
  simulações isoladas de DOM, armazenamento, transporte e Drive. Nenhuma
  chamada foi feita ao GAS/Drive de produção e nenhum registro real foi alterado.
- Houve revisão independente dos fluxos de entrada e sync. Os achados acima
  foram consolidados com leitura dos callers ativos e reproduções locais.
- O script antigo embutido em `coleta-checklist.html` está em `type=text/plain`;
  suas falhas não foram atribuídas ao código executado atualmente.
- Download de PDF sem data foi conferido como comportamento permitido pela
  especificação existente, portanto não foi classificado como bug.
- Não houve validação visual no app instalado nem verificação da versão
  atualmente implantada no GAS. A revisão descreve o código do workspace.

## Ordem aplicada na correção

1. Gravação e envio unificados: F01, F03, F04, F07 e F11.
2. Digitação, identidade e validação: F02, F06, F08 e F09.
3. Consulta e substituição seguras dos PDFs: F05 e F10.
4. Testes de regressão integrados ao comando padrão do projeto.
