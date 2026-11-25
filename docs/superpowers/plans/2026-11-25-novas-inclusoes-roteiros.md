# Novas inclusões nos roteiros — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Método de execução ainda não escolhido pelo usuário; recomendação: execução nesta sessão.

**Goal:** identificar novos pontos no PDF até o registro salvo de coleta positiva ou intercorrência após a inclusão naquele roteiro.

**Architecture:** registrar cada inclusão com identidade própria, persistida no SQLite e em uma aba dedicada do GAS. O servidor acompanha a composição do cadastro efetivo (CSV do Drive com sobreposição do cadastro compartilhado), estabelece uma base inicial única e distribui as inclusões e evidências de atendimento. Uma consulta local combina essas evidências com retornos salvos ainda não sincronizados; os dois caminhos de impressão consomem a mesma consulta.

**Tech Stack:** JavaScript ES modules, sql.js/SQLite, Google Apps Script/Sheets, jsPDF/AutoTable, HTML de impressão, testes node:test e node:vm já usados no projeto; sem novas dependências de produção.

**Spec:** `docs/superpowers/specs/2026-11-25-novas-inclusoes-roteiros-design.md` (aprovada).

## Global Constraints

- Quantidade maior que zero OU intercorrência não vazia encerra o destaque; digitação não salva não encerra.
- Data da viagem igual ou posterior ao dia da inclusão, em America/Sao_Paulo; não usar a data da digitação como data da viagem.
- Histórico de outro vínculo/roteiro não encerra a novidade atual; editar nome/endereço/ordem e reativar o mesmo vínculo não criam inclusão.
- Base existente na ativação não vira novidade. Primeiro uso em outro aparelho não constitui inclusão.
- Regerar antes do retorno mantém a indicação. Documentos já produzidos não são modificados pelo atendimento.
- Manter a sequência dos pontos, a legibilidade em preto e branco e a paginação.
- Persistência e convergência entre aparelhos, inclusive após reinício e repetição de sincronização.
- Falha remota conserva o estado conhecido e informa sincronização pendente; sem notificações externas nem confirmação manual adicional.
- Sem deploy remoto neste trabalho. Preparar e documentar a atualização necessária do GAS.

## Review Focus

- A→B→A no mesmo dia: evidência de uma passagem anterior não encerra o novo episódio (tarefas 1 e 2).
- Aparelho limpo ou sem histórico: não classificar toda a base como nova, nem perder novidades já reconhecidas pelo servidor (tarefas 2 e 3).
- CSV antigo e conflito de cadastro: não ressuscitar vínculo anterior ou aceitar a inclusão de uma edição rejeitada (tarefas 2 e 3).
- Resposta remota atrasada após troca de roteiro: não aplicar resumo na impressão de outro roteiro (tarefas 3 e 4).
- Muitos nomes longos, acentos e várias páginas: resumo não encobre tabela, legenda ou assinaturas (tarefa 4).

## Mapa dos arquivos e constatações

- `database.js`: migrações, criação/importação/aplicação remota de pontos, operações de coleta e persistência atômica.
- `gas/Code.gs`: única fonte de código do GAS usada pelo mock; cadastro compartilhado, CSV e coletas. API atual 16; acrescentar capacidade `novidadesRoteiros` e versão 17.
- `google-sync.js`: cadastro paginado, envio de coletas e chamadas remotas; acrescentar sincronização de novidades por roteiro.
- `coleta-operation.js`: controlador ativo e geração efetiva do PDF. O script dentro de `coleta-checklist.html` está em `type="text/plain"` e não deve receber implementação duplicada.
- `imprimir.html`: impressão ativa acessível pela tela de roteiros; aplicar a mesma regra.
- Criar `roteiro-novidades.js` para consulta/preparação compartilhada de apresentação, sem acesso ao DOM nem efeitos de gravação.
- `sw.js`: pré-cache; `package.json` e arquivos de versão do Tauri: publicação futura da atualização local.
- Criar testes `novidades-persistence.test.cjs`, `gas-novidades.test.cjs`, `novidades-sync.test.cjs` e `novidades-impressao.test.cjs`; reutilizar `tests/helpers/gas-mock.cjs` e os padrões de aparelhos independentes de `tests/cadastro-sync.test.cjs`.

## Contrato comum

`Inclusao = { inclusao_id: string, id_rota: string, roteiro_chave: string, incluido_em: string|null, baseline: boolean, rev: number, atendimento: { data: string, sync_id: string }|null }`.

`incluido_em` é ISO UTC; a comparação com a data civil da coleta usa America/Sao_Paulo. `roteiro_chave` usa a chave estável já existente, com resolução de aliases; não usar ID numérico local nem nome atual como identidade compartilhada. Baseline tem `incluido_em: null`, nunca aparece como NOVO. Cada transferência cria outro `inclusao_id`, inclusive na volta ao mesmo roteiro.

SQLite: tabela `roteiro_inclusoes` para episódios e evidência remota, `roteiro_inclusao_atual` para mapear cada ponto ao episódio atual, e metadados persistidos para versão/última sincronização. Manter episódios anteriores. Coletas ganham colunas opcionais `inclusao_id` e `roteiro_chave` congeladas no salvamento; operações, outbox e reenvios preservam esses campos.

GAS: aba `NovidadesRoteiros` com colunas `Inclusao ID`, `ID Rota`, `Roteiro Chave`, `Incluido Em`, `Baseline`, `Atual`, `Atendimento Data`, `Atendimento Sync ID`, `Rev`; metadados de inicialização/versionamento em Script Properties. Acrescentar `Inclusao ID` e `Roteiro Chave` ao final de `Coletas`, preservando as primeiras oito colunas e os leitores existentes.

Reconciliar o catálogo completo antes de aplicar o primeiro lote de cadastro novo: CSV mais recente do Drive com `CadastroPontos`/`CadastroRoteiros` por cima, incluindo exclusões e aliases. Não usar `tblRotas` como substituto silencioso do CSV: o app atual importa `roteirosCsv`; o endpoint normalizado atende outro consumidor. Base inicial exige leitura válida da fonte configurada; falha não equivale a catálogo vazio. Não marcar a inicialização como concluída até persistir o catálogo inicial inteiro. Repetição deve recuperar uma inicialização parcial sem produzir inclusões.

Para mudanças futuras do CSV, o marco será a data de modificação da versão que primeiro apresenta o vínculo; para criação no app, usar o marco explícito criado no app e validado pelo GAS. O CSV não fornece a hora real do cadastro: registrar essa origem no código/documentação. Não comparar novamente uma versão já reconciliada. A sobreposição do cadastro compartilhado impede que um CSV antigo reverta uma transferência feita no app.

`POST { action: 'novidadesRoteiro', token, roteiro: <chave> }` retorna `{ ok:true, apiVersion:17, novidadesRoteiros:true, rev, roteiro_chave, inclusoes: Inclusao[] }` para os episódios atuais do roteiro. Resposta completa por roteiro, sem usar o cursor do cadastro. Falha retorna `ok:false`; falta de capacidade nunca significa lista vazia confiável. A consulta reconcilia fontes e evidências sob o lock existente, sem locks aninhados. Usar leitura em blocos para coletas; não limitar a evidência às últimas 8.000 linhas.

## Task 1: persistir episódios e reconhecer o retorno local

**Files:** `database.js`, criar `roteiro-novidades.js`, criar `tests/novidades-persistence.test.cjs`; ampliar `tests/coleta-persistence.test.cjs`.

**Interfaces:** produzir `db.getInclusaoAtual(idRota): Inclusao|null`, `db.aplicarInclusoesRemotas({ roteiro_chave, rev, inclusoes }): void` e `db.getNovidadesRoteiro(roteiroId): Inclusao[]`. Produzir `listarNovidades(db, roteiroId, clientes): Array<{ id_rota, cliente, ordem }>` em `roteiro-novidades.js`, sem gravações.

- [ ] Escrever testes com SQLite real do vendor: base migrada resulta em `[]`; criação via `criarPonto` resulta em um episódio; edição comum e reativação preservam o ID; transferência e volta geram IDs diferentes. Verificar que a mesma importação/aplicação remota não cria IDs locais novos.
- [ ] Testar `getNovidadesRoteiro`: quantidade 1 encerra; quantidade 0 e intercorrência `1` encerra; zero e espaços mantém; data anterior mantém; data do mesmo dia encerra; episódio/roteiro diferente mantém. Reconstruir o banco a partir dos bytes e repetir a consulta.
- [ ] Executar `node --experimental-vm-modules --test tests/novidades-persistence.test.cjs`; confirmar falha pelas interfaces ausentes.
- [ ] Implementar migração idempotente, tabela de episódios e gravação do marco na criação/transferência com `origemApp`. Importação de base ou aplicação remota não fabrica evento: usa metadados compartilhados. Não reutilizar `editado_em`. Conservar novidade provisória local até o GAS confirmar ou rejeitar a edição correspondente.
- [ ] Congelar o episódio em `_insertColeta` e `saveColetaOperation`, incluindo serialização idempotente e `getUnsyncedColetas`. A decisão de atendimento local usa registros persistidos do episódio exato, e nunca `sessionData`, quantidade anterior do PDF ou `context_source='legacy-local'` atribuído por migração.
- [ ] Implementar `listarNovidades` na ordem fornecida, excluindo pontos inativos e registros fora do roteiro. Conservar dados remotos em falha ou revisão mais antiga; uma resposta de episódio anterior não substitui criação/transferência local ainda pendente.
- [ ] Executar `node --experimental-vm-modules --test tests/novidades-persistence.test.cjs tests/coleta-persistence.test.cjs tests/cadastro-app.test.cjs`. Esperado: nenhuma falha. Commit apenas dos arquivos desta tarefa.

## Task 2: registrar inclusões e atendimentos no GAS

**Files:** `gas/Code.gs`, `tests/helpers/gas-mock.cjs`, criar `tests/gas-novidades.test.cjs`; ampliar `tests/gas-cadastro.test.cjs` e `tests/gas-checklist-integrity.test.cjs`.

**Interfaces:** consumir/produzir `Inclusao`; implementar `novidadesRoteiro_(body)` e funções internas `reconcileNovidades_(ss, snapshot, nowIso)` e `reconcileAtendimentosNovidades_(ss, roteiroChave)`. O primeiro recebe o catálogo efetivo com versão da fonte e vínculos; ambos são chamados com o lock já adquirido.

- [ ] Escrever testes no mock: baseline compartilhada antes do primeiro lote novo; segunda inicialização idempotente; CSV alterado cria só diferenças; cadastro sobrepõe CSV; fonte indisponível não confirma baseline; falha após escrita parcial recupera a mesma baseline. Validar token antes de qualquer escrita.
- [ ] Testar coleta positiva e intercorrência com zero, histórico anterior/retroativo, aliases após renomeação, A→B→A, retorno sincronizado antes do cadastro e reenvio do mesmo `sync_id`. Evidência explícita só atende o episódio correspondente.
- [ ] Executar `node --test tests/gas-novidades.test.cjs` e confirmar falha pela capacidade ausente.
- [ ] Implementar aba e reconciliação conforme contrato. Extrair leitura do CSV de `getRoteirosCsv_` para reutilização, preservando conteúdo/encoding/modifiedTime e sem alterar o contrato atual. No `cadastroSync_`, inicializar/reconciliar o estado anterior e depois registrar apenas mudanças vencedoras. Transportar o episódio como metadado opcional do ponto, preservando-o em edições comuns feitas por clientes antigos.
- [ ] Acrescentar metadados das coletas ao final da aba e preservar deduplicação. Para registros de clientes antigos sem `inclusao_id`, exigir ID do ponto, roteiro/alias compatível, data da viagem não anterior e `Sincronizado Em` não anterior ao marco; associar uma única vez ao episódio vigente no recebimento. Coletas antigas já existentes não são reatribuídas em uma volta ao mesmo roteiro. Não inferir correspondência se o contexto for ambíguo.
- [ ] Reconciliar novamente na consulta para cobrir coletas que chegaram antes do cadastro. Atualizar status para API 17 e capacidade `novidadesRoteiros:true`; clientes antigos continuam podendo enviar coletas/cadastro. Se a fonte de novidades falhar, manter funcionamento anterior dessas gravações e devolver aviso explícito da funcionalidade pendente, sem descartar os dados principais.
- [ ] Executar `node --test tests/gas-novidades.test.cjs tests/gas-cadastro.test.cjs tests/gas-checklist-integrity.test.cjs tests/gas-roteiros-csv-drive.test.cjs tests/gas-roteiros-normalizado.test.cjs`. Ajustar somente expectativas de versão pertinentes; esperado: nenhuma falha. Commit dos arquivos desta tarefa.

## Task 3: sincronizar novidades entre aparelhos

**Files:** `google-sync.js`, `database.js`, criar `tests/novidades-sync.test.cjs`; ampliar `tests/cadastro-sync.test.cjs` e `tests/google-sync-coletas.test.cjs`.

**Interfaces:** produzir `syncNovidadesRoteiro(db, roteiroId): Promise<{ ok:boolean, error?:string, rev?:number }>`; consumir `db.aplicarInclusoesRemotas`, o endpoint da tarefa 2 e os campos opcionais do cadastro/coletas.

- [ ] Escrever teste com dois aparelhos falando com o mesmo GAS: A cria e sincroniza; B sem histórico recebe uma novidade; A salva intercorrência e sincroniza; B deixa de mostrar NOVO. Terceiro aparelho recebe base antiga sem novidades falsas e o estado correto das inclusões reais.
- [ ] Testar retorno local antes da rede; perda da resposta e reenvio; ausência de capacidade em API 16; token ausente; erro de rede; resposta com roteiro errado ou revisão antiga; conflito que rejeita a transferência local. Confirmar que evidência recebida antes do evento permanece disponível para reconciliação.
- [ ] Executar `node --experimental-vm-modules --test tests/novidades-sync.test.cjs`; confirmar falha antes da implementação.
- [ ] Transportar episódio no cadastro e nas coletas sem alterar contagens de confirmação, paginação ou deduplicação. A resposta de cadastro deve devolver também os metadados canônicos dos pontos aceitos do próprio lote (hoje o pull os omite). Eventos rejeitados adotam o episódio vencedor.
- [ ] Implementar sincronização por banco/roteiro, deduplicando chamadas simultâneas. Antes da consulta, tentar sincronizar cadastro pendente; falha conserva a novidade local e resulta em aviso. Validar contrato/capacidade/roteiro antes de persistir; flush antes de confirmar sucesso local. Não exigir API 17 para funcionalidades anteriores.
- [ ] Executar `node --experimental-vm-modules --test tests/novidades-sync.test.cjs tests/cadastro-sync.test.cjs tests/google-sync-coletas.test.cjs`. Esperado: nenhuma falha. Commit dos arquivos desta tarefa.

## Task 4: destacar as inclusões nos dois documentos operacionais

**Files:** `coleta-operation.js`, `imprimir.html`, `roteiro-novidades.js`, criar `tests/novidades-impressao.test.cjs`; ampliar `tests/coleta-operation.test.cjs` e `tests/xss-render.test.cjs` se necessário.

**Interfaces:** consumir `listarNovidades` e `syncNovidadesRoteiro`. Exportar `desenharResumoNovidades(doc, novidades, { startY, bottomReserve }): number` para o resumo do PDF; devolve a posição inicial da tabela na página corrente.

- [ ] Criar teste executando o renderizador e o controlador com banco e jsPDF controlados: resumo e marcações correspondem aos mesmos IDs; ordem original mantida; salvar atendimento atualiza geração seguinte; entrada não salva e downloads repetidos mantêm destaque. Evitar testes que apenas procuram texto no código-fonte.
- [ ] Testar paginação com muitos nomes longos, acentos e caracteres `<>&`; resumo sem pontos não ocupa espaço. Testar cancelamento/troca de roteiro durante consulta e preservação do estado local após erro remoto.
- [ ] Executar `node --experimental-vm-modules --test tests/novidades-impressao.test.cjs`; confirmar falha por ausência dos destaques.
- [ ] No controlador ativo, incorporar a consulta à promessa `checklistDataReady`, sequencialmente às consultas GAS existentes e protegida pelo mesmo requestId. Exibir falha no status existente sem zerar novidades. Consultar o banco novamente ao gerar para considerar retornos salvos depois de abrir o modal.
- [ ] Renderizar `ATENÇÃO: N novos pontos neste roteiro` (singular quando N=1), lista com posição e nome, e `NOVO` em negrito junto ao cliente. Usar AutoTable para paginar o resumo e a tabela sem invadir a reserva de 42 mm da legenda/assinaturas; não depender de cor nem alterar a sequência de atendimento. Baixar e enviar ao Drive usam o mesmo documento.
- [ ] Em `imprimir.html`, atualizar novidades antes de habilitar impressão e conservar fallback local com aviso na área não impressa. Criar resumo/etiquetas com DOM/textContent e CSS de impressão, sem interpolar cadastro em innerHTML; manter cabeçalho repetido e linhas indivisíveis. Não editar o bloco legado desativado.
- [ ] Executar `node --experimental-vm-modules --test tests/novidades-impressao.test.cjs tests/coleta-operation.test.cjs tests/xss-render.test.cjs tests/tipo-residuo-impressao.test.cjs`. Produzir PDF de fixture com nomes fictícios e conferir páginas, contraste e assinaturas em visualizador disponível; registrar eventual limitação da inspeção. Commit dos arquivos desta tarefa.

## Task 5: integração, empacotamento e documentação operacional

**Files:** `package.json`, `package-lock.json`, `sw.js`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `ajuda-coleta.html`, `gas/README.md`, este plano.

**Interfaces:** sem novos contratos; entrega os módulos das tarefas anteriores no PWA e no pacote desktop.

- [ ] Incluir os novos testes no script `npm test` e `roteiro-novidades.js` no pré-cache. Alinhar a versão do app/cache/Tauri em 1.8.0, inclusive entradas raiz do package-lock; não atualizar dependências.
- [ ] Documentar na ajuda o significado de NOVO, o encerramento por retorno salvo e o comportamento das reimpressões. No README do GAS, registrar API 17, aba adicional, baseline única, limitação da data do CSV e ordem futura de implantação: GAS atualizado e baseline confirmada antes da distribuição do app. Preparar instruções, sem executar deploy nem escrever na planilha real.
- [ ] Executar `npm test`; esperado: todos os testes passam. Executar `git diff --check`; esperado: nenhum erro. Executar `npm run prepare-dist` somente após verificar que `dist` resolve dentro do workspace isolado, pois o script remove essa pasta; conferir o novo módulo na saída.
- [ ] Revisar o diff completo contra a spec e os cinco itens de Review Focus. Registrar resultados e pendências reais neste plano; marcar apenas etapas verificadas. Commit dos arquivos restantes, sem incluir configurações locais ou artefatos de fixture.
- [ ] Entregar resumo das mudanças, evidências dos testes e estado do deploy (não realizado). Integração da branch segue o método de execução escolhido e as instruções vigentes; não fazer merge/publicação remota implicitamente.

## Autorrevisão do plano

Cobertura: regra e persistência (1), fonte compartilhada e baseline (2), convergência/falhas (3), PDFs e reimpressões (4), distribuição/documentação (5). Interfaces e nomes acima são compartilhados entre tarefas. Decisões técnicas propostas pelo plano: aba dedicada, API 17, episódios por transferência, metadados no retorno, marco do CSV baseado na versão e versão local 1.8.0. O plano não foi executado e nenhum teste de implementação foi alegado como aprovado.
