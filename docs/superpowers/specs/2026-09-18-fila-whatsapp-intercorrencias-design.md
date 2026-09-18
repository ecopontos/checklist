# Fila de WhatsApp orientada por intercorrências

Data: 2026-09-18
Status: desenho aprovado

## Contexto

O módulo de WhatsApp exige atualmente que o operador abra cada roteiro,
selecione a opção de intercorrências e percorra os contatos manualmente. O
estado da sessão existe apenas em memória e a tela marca o contato como enviado
logo após abrir o WhatsApp, embora não receba confirmação de envio da plataforma.
Ao fechar a página, o app perde tanto as pendências quanto a evidência dos itens
processados.

O cadastro de pontos já é sincronizado localmente e as coletas consolidadas
existem no GAS. A melhoria deve usar essas fontes para apresentar uma fila única
com as intercorrências da última coleta de cada ponto, sem seleção prévia de
roteiros. O histórico de tratamento ficará somente no computador em que foi
criado.

## Objetivos

- Carregar automaticamente as intercorrências atuais de todos os roteiros.
- Mostrar ao operador o que está pendente, aberto e confirmado.
- Chamar de enviado apenas o item confirmado manualmente pelo operador.
- Preservar campanhas e suas evidências após fechar ou reiniciar o app.
- Retirar uma ocorrência confirmada da fila até que exista uma nova coleta com
  uma nova intercorrência para o mesmo ponto.
- Considerar o ponto resolvido após a confirmação de qualquer um de seus
  telefones.
- Manter campanhas separadas, com mensagem e contatos registrados como
  snapshots.

## Fora do escopo

- Confirmação de entrega ou leitura fornecida pelo WhatsApp.
- Compartilhamento do histórico entre computadores.
- Identificação ou autenticação do responsável pelo disparo.
- Automação do clique de envio dentro do WhatsApp.
- Alteração dos dados históricos de coletas.

## Fluxo do operador

Ao abrir a página, o app inicializa o banco local, atualiza o cadastro de pontos
pelos mecanismos já existentes e consulta a fila consolidada de intercorrências.
A tela inicial mostra três contadores: pendentes, aguardando confirmação e
enviadas. A lista apresenta cliente, roteiro, data da coleta, intercorrência e
telefones disponíveis.

Todos os roteiros entram por padrão. Busca, filtro por roteiro e seleção de itens
servem apenas para reduzir a campanha que será iniciada. O operador escreve ou
reutiliza a mensagem e inicia uma campanha com os itens selecionados. A campanha
congela os dados exibidos para que alterações posteriores no cadastro não mudem
a evidência.

Para cada ponto:

1. **Abrir no WhatsApp** abre um dos telefones e grava o estado `opened`, o
   telefone escolhido, a mensagem final e o horário. A interface exibe
   **Aguardando confirmação**.
2. **Confirmar envio** grava `confirmed` e o horário da confirmação. Qualquer
   telefone confirmado resolve a ocorrência inteira; os demais não precisam ser
   processados.
3. **Adiar** grava `deferred`, avança para o próximo item e mantém a ocorrência
   entre as pendências.

Uma campanha em andamento reaparece ao reabrir a página. A aba **Histórico**
lista campanhas separadamente e permite abrir os itens, conferir mensagem,
telefone e horários e exportar o resultado para planilha.

Existe no máximo uma campanha ativa. O operador pode concluí-la mesmo com itens
adiados; nesse caso, os adiados permanecem na fila e podem integrar uma campanha
posterior, enquanto a campanha encerrada conserva seu próprio resultado.

## Fonte consolidada de intercorrências

O GAS passa a expor `action=intercorrenciasAtuais`. A consulta percorre a aba
`Coletas` e escolhe exatamente uma linha por `ID Rota`: a maior data civil e,
em empate, a linha gravada por último. Se essa última coleta não possuir
intercorrência, o ponto não entra na resposta, mesmo que coletas anteriores
possuam ocorrências. Quantidade zero é válida e não interfere no filtro.

A resposta bem-sucedida terá o contrato:

```json
{
  "ok": true,
  "apiVersion": 11,
  "source": "intercorrenciasAtuais",
  "generatedAt": "2026-09-18T15:00:00.000Z",
  "data": [
    {
      "occurrenceId": "collection-sync-id",
      "idRota": "42",
      "data": "2026-09-18",
      "cliente": "Cliente exemplo",
      "roteiro": "SAT01",
      "intercorrencia": "Bombona indisponível"
    }
  ],
  "quality": {
    "invalidDates": 0,
    "missingRouteIds": 0,
    "legacyIds": 0,
    "excludedRecords": 0
  }
}
```

`occurrenceId` usa o `sync_id` da coleta. Para linhas legadas sem esse campo, o
GAS produz `legacy:<digest-do-conteúdo-canônico>`, calculado com ponto, data,
cliente, roteiro, quantidade, intercorrência e instante de sincronização. Essa
identidade não depende da posição da linha. Linhas legadas completamente
idênticas são indistinguíveis e resultam na mesma identidade; para a fila da
última ocorrência isso evita duplicar o mesmo fato operacional.

O endpoint lê todas as linhas necessárias para determinar a última coleta de
cada ponto. A resposta fica em cache por cinco minutos. O salvamento de novas
coletas invalida esse cache. Falha de cache não impede a leitura direta da
planilha.

O cliente valida `ok`, `apiVersion`, `source`, `data` e os campos essenciais de
cada item. Uma implantação antiga do GAS não pode ser confundida com uma fila
vazia.

## Dados locais

O SQLite recebe duas tabelas.

### `whatsapp_campaigns`

| Campo | Regra |
| --- | --- |
| `campaign_id` | UUID, chave primária |
| `message_template` | mensagem-base congelada |
| `status` | `active`, `completed` ou `cancelled` |
| `created_at` | instante ISO |
| `completed_at` | instante ISO opcional |

### `whatsapp_campaign_items`

| Campo | Regra |
| --- | --- |
| `item_id` | UUID, chave primária |
| `campaign_id` | referência à campanha |
| `occurrence_id` | identidade retornada pelo GAS |
| `id_rota` | identidade do ponto |
| `cliente_snapshot` | cliente no início da campanha |
| `roteiro_snapshot` | roteiro no início da campanha |
| `coleta_data` | data civil da ocorrência |
| `intercorrencia_snapshot` | texto exibido ao operador |
| `message_snapshot` | mensagem final com tags substituídas |
| `status` | `pending`, `opened`, `deferred` ou `confirmed` |
| `phone_slot` | telefone 1 ou 2, opcional até a abertura |
| `phone_snapshot` | telefone efetivamente aberto |
| `opened_at` | instante ISO opcional |
| `confirmed_at` | instante ISO opcional |

Um índice por `occurrence_id` permite verificar se qualquer campanha já
confirmou a ocorrência. Um índice por `campaign_id` sustenta retomada e
histórico. As transições são persistidas com o mesmo mecanismo atômico que
restaura o banco em memória quando a gravação do arquivo local falha.

O cálculo da fila é:

1. obter as ocorrências atuais válidas do GAS;
2. remover aquelas que possuem ao menos um item local `confirmed` com o mesmo
   `occurrence_id`;
3. associar cada `idRota` aos telefones ativos do cadastro local;
4. separar itens sem telefone válido, mostrando-os como impedidos em vez de
   descartá-los;
5. incorporar os itens `opened` ou `deferred` da campanha ativa para permitir
   retomada.

Somente `confirmed` resolve a ocorrência. `opened` e `deferred` continuam no
total de pendências. A confirmação é idempotente: repeti-la para o mesmo item
mantém o primeiro estado válido e não cria outra evidência.

## Interface

A etapa atual de seleção obrigatória de roteiros deixa de ser a entrada da tela.
A página passa a ter duas abas:

- **Fila atual:** contadores, atualização, busca, filtro opcional por roteiro,
  seleção e processamento da campanha.
- **Histórico:** campanhas em ordem decrescente, com totais e detalhamento.

Estados visuais:

- **Pendente:** neutro; ainda não houve abertura.
- **Aguardando confirmação:** destaque âmbar; houve abertura, sem evidência de
  envio.
- **Enviado:** verde; confirmado manualmente com data e hora.
- **Adiado:** retorna à fila pendente com indicação de tentativa anterior.
- **Sem telefone:** bloqueado, acompanhado do motivo.

O progresso usa ocorrências, não a quantidade de telefones. O resumo não usa a
expressão “enviados” para itens apenas abertos. Nomes, roteiros, ocorrências e
mensagens continuam escapados antes de entrar no HTML.

## Falhas e recuperação

- Se o GAS falhar, a campanha ativa continua acessível. A tela informa que a
  lista remota não pôde ser atualizada e não declara ausência de pendências.
- Se o cadastro local não contiver o `idRota`, a ocorrência fica visível como
  **Cadastro não localizado**, sem telefone para abertura.
- Se a persistência local falhar, a transição visual é revertida e o operador
  recebe erro explícito; o app não avança automaticamente.
- Se a abertura externa falhar, o item permanece `pending` e não recebe
  `opened_at`.
- Se o app encerrar depois de abrir o WhatsApp, o item reaparece como
  **Aguardando confirmação**.
- Atualizações concorrentes na mesma janela compartilham uma única consulta.

## Migração e compatibilidade

As tabelas são criadas por migração idempotente. Nenhum status atual em memória
é migrado, pois não existe evidência durável confiável. O botão de exportação
continua disponível, agora alimentado pelos snapshots persistidos.

O GAS passa à API 11. A constante global usada para proteger o contrato de
sincronização de coletas permanece na API mínima necessária a esse fluxo; o
módulo de WhatsApp valida separadamente a presença e a versão do novo endpoint.
Frontend e GAS devem ser publicados juntos para disponibilizar a fila, mas uma
versão antiga do GAS resulta em erro explícito e não altera campanhas locais.

## Testes

### GAS

- consolida todos os roteiros em uma consulta;
- escolhe a última coleta por ponto por data e ordem de gravação;
- inclui quantidade zero;
- remove o ponto quando sua última coleta não tem intercorrência;
- devolve identidade estável, incluindo o fallback legado;
- contabiliza registros inválidos e invalida o cache após novas coletas;
- não transforma falha da planilha ou contrato antigo em fila vazia.

### Banco local

- migração idempotente das duas tabelas e índices;
- criação atômica de campanha e itens;
- restauração após falha de persistência;
- retomada dos estados `opened` e `deferred`;
- confirmação idempotente;
- confirmação de um telefone resolve o ponto inteiro;
- ocorrência confirmada não reaparece;
- nova `occurrence_id` do mesmo ponto reaparece.

### Interface e integração

- entrada direta pela fila, sem seleção obrigatória de roteiro;
- filtros não alteram a fonte nem apagam itens;
- abertura bem-sucedida leva a `opened`, nunca a `confirmed`;
- abertura com falha preserva `pending`;
- adiar mantém a ocorrência pendente;
- contadores e progresso usam ocorrências;
- campanha ativa é retomada ao reabrir;
- histórico e exportação usam snapshots;
- itens sem telefone ou sem cadastro permanecem visíveis;
- falha e contrato antigo do GAS aparecem como erro explícito;
- conteúdo dinâmico permanece escapado.

## Publicação

1. Implantar o GAS API 11 com o novo endpoint e a invalidação de cache.
2. Publicar o frontend que valida esse contrato e contém a migração local.
3. Confirmar em ambiente controlado uma ocorrência com dois telefones, fechar e
   reabrir o app e registrar uma nova coleta para o mesmo ponto.
4. Verificar que a ocorrência confirmada permanece no histórico, que não aparece
   novamente antes de nova coleta e que a nova ocorrência volta à fila.
