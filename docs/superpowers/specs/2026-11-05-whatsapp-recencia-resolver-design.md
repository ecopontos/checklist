# Fila de WhatsApp: janela de recência e ação de resolver

Data: 2026-11-05
Status: desenho aprovado

## Contexto

A fila do módulo de WhatsApp (ver
`2026-09-18-fila-whatsapp-intercorrencias-design.md`) lista, para cada ponto,
a intercorrência da sua coleta mais recente. Duas consequências incomodam o
operador:

1. **Problemas antigos permanecem na fila.** O endpoint
   `intercorrenciasAtuais` não aplica nenhum piso de data: um ponto coletado há
   meses, com intercorrência e sem visita posterior, continua "atual"
   indefinidamente.
2. **Itens já tratados reaparecem.** A única forma de uma ocorrência sair da
   fila é ser `confirmed` dentro de uma campanha concluída. Quando o operador
   envia a mensagem mas adia, fecha o app antes de confirmar ou simplesmente não
   deseja mensagear aquele ponto, a ocorrência volta no próximo refresh.

O `occurrenceId` é estável entre consultas (usa o `sync_id` da coleta ou um
digest determinístico), portanto o filtro de confirmados já funciona. O que
falta é (a) envelhecer ocorrências antigas e (b) permitir que o operador retire
manualmente da fila ocorrências que não serão mensageadas.

Esta melhoria adiciona duas capacidades independentes sem alterar o fluxo de
campanha existente.

## Objetivos

- Permitir que a fila mostre apenas intercorrências dentro de uma janela de
  recência, escolhida pelo operador (30, 60 ou 90 dias; padrão 90).
- Aplicar o corte de recência no GAS, por parâmetro, mantendo uma única fonte
  da verdade para a fila.
- Permitir que o operador marque uma ocorrência como resolvida/ignorada sem
  passar por uma campanha, e desfazer essa marcação.
- Preservar a semântica existente: confirmados continuam filtrados; uma nova
  coleta (novo `occurrenceId`) traz a ocorrência de volta.
- Não afetar a campanha ativa nem a retomada.

## Fora do escopo

- Alterar o contrato de campanha, histórico ou exportação.
- Compartilhar o estado de resolvidas entre computadores (continua local).
- Automação ou confirmação de entrega no WhatsApp.
- Filtro de recência em outros consumidores do GAS (apenas
  `intercorrenciasAtuais`).

## Feature 1 — Janela de recência (GAS, parametrizada)

### GAS (`gas/Code.gs`)

- `getIntercorrenciasAtuais_()` passa a aceitar `params.dias`. Normalização:
  inteiro pertencente a `{30, 60, 90}`; qualquer valor ausente, não numérico ou
  fora do conjunto resulta em **90**. O valor normalizado é usado tanto para o
  filtro quanto para a chave de cache.
- O corte é aplicado ao resultado final (após escolher a última coleta por
  ponto): descarta ocorrências cuja `data` civil seja **anterior** a
  `hoje − N dias`. "Hoje" é calculado no fuso da planilha e formatado como
  `YYYY-MM-DD`; a comparação é lexicográfica entre strings `YYYY-MM-DD`, que é
  equivalente à comparação cronológica para esse formato.
- O corte ocorre depois da agregação por ponto. Ou seja: escolhe-se primeiro a
  coleta mais recente do ponto; se essa coleta estiver fora da janela, o ponto
  não entra. Coletas antigas nunca "ressuscitam" um ponto cuja última coleta é
  recente e sem intercorrência.
- **Cache por período.** A chave passa de `intercorrenciasAtuais:v1` para
  `intercorrenciasAtuais:v2:dias=<N>`. Cada N mantém seu próprio cache de cinco
  minutos. A invalidação disparada ao salvar novas coletas deve limpar todas as
  variações de período (`30`, `60`, `90`).
- `GAS_API_VERSION` sobe de 15 para 16 (deploy verificável via
  `?action=status`). O contrato permanece compatível: a resposta só *remove*
  linhas antigas, mantendo os mesmos campos. O cliente continua exigindo no
  mínimo API 11.

### App (`google-sync.js`, `whatsapp-sender.js`)

- `getIntercorrenciasAtuais(dias)` anexa `&dias=N` à URL. Sem argumento, não
  envia o parâmetro (o GAS assume 90), preservando compatibilidade.
- A UI ganha um seletor de período (30 / 60 / 90 dias) próximo ao botão
  Atualizar. O valor é persistido em `localStorage` e relido em
  `refreshWhatsappQueue`, que o repassa a `getIntercorrenciasAtuais`.
- Trocar o período dispara um refresh. A fonte exibida informa o período
  aplicado.

## Feature 2 — Resolver/Ignorar (reversível)

### DB (`database.js`)

- Nova tabela, criada por migração idempotente:

  | Campo | Regra |
  | --- | --- |
  | `occurrence_id` | identidade da ocorrência, chave primária |
  | `dismissed_at` | instante ISO da marcação |

- `dismissWhatsappOccurrence(occurrenceId, at)` — insere ou mantém o registro
  (idempotente); valida id e timestamp com os mesmos helpers do módulo.
- `restoreWhatsappOccurrence(occurrenceId)` — remove o registro (idempotente).
- `getDismissedWhatsappOccurrenceIds()` — lista os ids resolvidos.

### Fila (`whatsapp-campaign.js`)

- `buildWhatsappQueue` recebe `dismissedOccurrenceIds = []`. As ocorrências
  "fresh" cujo id esteja resolvido recebem `dismissed: true` em vez de serem
  removidas na origem (para que a UI possa revelá-las sob demanda).
- Itens da campanha ativa (`activeItems`) nunca recebem `dismissed`; a marcação
  só se aplica à fonte.
- Como a chave é o `occurrenceId` estável, uma nova coleta gera novo id e a
  ocorrência reaparece sozinha — mesma semântica do conjunto de confirmados.

### UI (`whatsapp-sender.js`, `whatsapp-events.js`)

- Cada linha da fila ganha um botão **Resolver** (ao lado do checkbox de
  seleção). Itens da campanha ativa ou bloqueados seguem as regras de
  habilitação já existentes e não exibem Resolver.
- Por padrão, itens resolvidos não aparecem na fila.
- Toggle **"Mostrar resolvidas"**: quando ligado, os itens resolvidos aparecem
  marcados com o estado *Resolvido* e um botão **Desfazer** (chama
  `restoreWhatsappOccurrence`). Itens resolvidos não podem ser selecionados para
  uma campanha e saem de `selectedOccurrences` ao serem resolvidos.
- `whatsapp-events.js` ganha os `data-action` correspondentes
  (`resolver-ocorrencia`, `desfazer-resolucao`) e o `data-change-action` do
  toggle, seguindo o padrão sem `onclick` exigido pelo CSP do Tauri.
- Os contadores refletem a fila efetivamente exibida.

## Casos de borda e consistência

- A janela de recência não afeta a campanha ativa nem a retomada: itens ativos
  vêm do banco local, não da fonte filtrada.
- Resolver aplica-se somente a itens da fonte. Itens em campanha ativa
  permanecem bloqueados para resolver, como já ocorre com a seleção.
- Recência, confirmados e resolvidas são três filtros independentes. Uma
  ocorrência pode sair da fila por qualquer um deles; voltar exige,
  respectivamente, estar dentro da janela, não estar confirmada e não estar
  resolvida — ou receber um novo `occurrenceId` via nova coleta.
- Falha do GAS ou contrato antigo continua aparecendo como erro explícito e não
  é confundido com fila vazia (comportamento preservado).
- Resolver com falha de persistência reverte a mudança visual e mostra erro,
  como nas demais transições locais.

## Testes

### GAS

- `dias` filtra ocorrências por data civil (dentro/fora da janela);
- valor ausente, não numérico ou fora de `{30,60,90}` usa 90;
- o corte é aplicado após a agregação por ponto (última coleta recente sem
  intercorrência não é "ressuscitada" por coleta antiga com intercorrência);
- cache separado por N; invalidação após nova coleta limpa todas as variações;
- filtro não transforma falha da planilha nem contrato antigo em fila vazia.

### Banco local

- migração idempotente da tabela de resolvidas;
- `dismiss` idempotente e `restore` idempotente;
- `getDismissedWhatsappOccurrenceIds` reflete o estado;
- restauração do banco após falha de persistência preserva a regra.

### Fila e interface

- ocorrência resolvida some da fila por padrão;
- toggle "Mostrar resolvidas" revela a ocorrência marcada como Resolvido;
- Desfazer devolve a ocorrência à fila pendente;
- ocorrência resolvida não é selecionável e sai da seleção ao ser resolvida;
- nova `occurrenceId` do mesmo ponto reaparece mesmo após resolver;
- o seletor de período repassa `dias` e persiste a escolha no dispositivo;
- conteúdo dinâmico permanece escapado.

## Publicação

1. Implantar o GAS API 16 com o parâmetro `dias`, o filtro de recência e o
   cache por período.
2. Publicar o frontend com o seletor de período, a tabela local de resolvidas e
   os controles de Resolver/Desfazer.
3. Em ambiente controlado: confirmar que uma intercorrência fora da janela some
   ao reduzir o período; que Resolver remove um item e Desfazer o traz de volta;
   e que registrar nova coleta para um ponto resolvido o devolve à fila.
