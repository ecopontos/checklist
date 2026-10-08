# Deploy do Web App (Code.gs)

1. Crie uma planilha Google Sheets (vazia, qualquer nome) — copie o ID dela
   da URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
2. Crie uma pasta no Google Drive onde o arquivo `cstExportaCheckList.csv`
   será colocado a cada exportação do Access — copie o ID dela da URL:
   `https://drive.google.com/drive/folders/<DRIVE_FOLDER_ID>`.
3. Acesse https://script.google.com/, crie um novo projeto.
4. Apague o conteúdo padrão de `Code.gs` e cole o conteúdo de
   `gas/Code.gs` deste repositório.
5. Crie também uma pasta separada no Google Drive para os PDFs de checklist
   (não a mesma do CSV) e copie o ID dela da URL, do mesmo jeito que no
   passo 2.
6. Em "Configurações do projeto" (ícone de engrenagem) > "Propriedades do
   script", adicione:
   - `SPREADSHEET_ID` = o ID copiado no passo 1
   - `DRIVE_FOLDER_ID` = o ID copiado no passo 2
   - `CHECKLISTS_FOLDER_ID` = o ID da pasta de checklists criada agora
   - `ROUTE_CHANGES_TOKEN` = um segredo compartilhado com pelo menos 32
     caracteres (`A-Z`, `a-z`, `0-9`, hífen ou sublinhado)
7. Clique em "Implantar" > "Nova implantação" > tipo "App da Web".
   - Executar como: **Eu** (sua conta)
   - Quem tem acesso: **Qualquer pessoa**
8. Autorize as permissões solicitadas (acesso a Sheets e Drive).
9. Copie a URL do Web App gerada (termina em `/exec`) — essa é a URL que
   vai no campo "URL do Web App do Google Apps Script" em `admin.html`.

## Atualização sem trocar a URL dos aplicativos

Para publicar uma alteração, não crie outra implantação de produção:

1. Abra o mesmo projeto no Apps Script.
2. Acesse "Implantar" > "Gerenciar implantações".
3. Edite a implantação ativa.
4. Selecione "Nova versão" e confirme a implantação.

O Deployment ID e a URL `/exec` permanecem os mesmos. Todos os aplicativos
que já usam essa URL passam a acessar o backend novo sem reconfiguração.

O arquivo `gas/appsscript.json` mantém a seção `webapp` com acesso
`ANYONE_ANONYMOUS` e execução como `USER_DEPLOYING`. Não remova essa seção:
ela preserva o ponto de entrada público quando o projeto é enviado pelo
`clasp`.

## Teste manual pós-deploy

Depois de colocar um `cstExportaCheckList.csv` na pasta configurada, teste
com `curl` (substitua `<URL>` pela URL do passo 9):

O arquivo exportado pelo Access pode permanecer em UTF-16LE. O GAS detecta
UTF-16LE/UTF-16BE (com ou sem BOM) e UTF-8 automaticamente antes de enviar
o conteúdo ao aplicativo.

```bash
curl "<URL>?action=status"
```

Esperado: `{"ok":true,"service":"satelite-gas","apiVersion":15,"routeChangesConfigured":true,"cadastro":true}`.

```bash
curl "<URL>?action=roteirosCsv"
```

Esperado: JSON com `"ok":true`, `"apiVersion":15`, `"source":"drive-csv"`,
`"content":"Fonte;idRota;..."`, `"modifiedTime"` e `"encoding":"UTF-16LE"`
para o arquivo do Access. O GAS escolhe o arquivo mais recente caso existam
cópias com o mesmo nome. O app usa `roteirosCsv`. `GET <URL>` (sem `action`) e
`?action=roteiros` devolvem, desde a API 15, o snapshot normalizado
`roteiros/v1` montado das abas do Sheets (ver "Snapshot de roteiros (API v15)"
abaixo); o formato achatado antigo (`rows`, `count`) não existe mais.

O CSV deve manter o cabeçalho exportado pelo Access, incluindo `idRota`,
`Ordem`, `Roteiro`, `Cliente` e `logradouro`. O app aceita tanto
`Tipo de Resíduo` quanto `TipoResiduo`. A importação automática funciona no
app instalado e no navegador, desde que a URL do GAS esteja configurada.
O processo que gera o CSV precisa colocá-lo nessa pasta do Drive; este
repositório contém o leitor, não um publicador do export do Access.

```bash
curl -X POST "<URL>" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"coletas":[{"id_rota":"SAT01-1","data":"2026-07-21","cliente":"CEPON","roteiro":"SAT01","quantidade":3,"intercorrencia":"","sync_id":"teste-curl"}]}'
```

Esperado: `{"ok":true,"count":1}`, e uma nova linha na aba "Coletas" da
planilha configurada.

Para testar a consulta da última coleta de um roteiro (o nome deve ser o
mesmo gravado na coluna `Roteiro`):

```bash
curl "<URL>?action=ultimaColeta&roteiro=SAT01"
```

Esperado: `{"ok":true,"data":"2026-07-21"}` com a data mais recente do
roteiro, ou `{"ok":true,"data":null}` se ele ainda não tiver coletas.

Para testar a busca de intercorrências da última coleta de cada cliente de
um roteiro (mesmo nome gravado na coluna `Roteiro`):

```bash
curl "<URL>?action=intercorrenciasRoteiro&roteiro=SAT01"
```

Esperado: `{"ok":true,"data":[{"id_rota":"SAT01-1","data":"2026-07-21","intercorrencia":"recusou coleta"}]}`,
com um item por cliente cuja última coleta no roteiro teve intercorrência
registrada, ou `{"ok":true,"data":[]}` se nenhum teve.

Para consultar a fila consolidada de intercorrências atuais, sem escolher um
roteiro:

```bash
curl "<URL>?action=intercorrenciasAtuais"
```

O contrato introduzido na API 11 continua disponível nas versões seguintes
(`apiVersion` traz a versão atual):
`{"ok":true,"apiVersion":15,"source":"intercorrenciasAtuais","generatedAt":"...","data":[...],"quality":{...}}`.
O GAS escolhe a última coleta de cada ponto pela maior data civil e, em empate,
pela última linha gravada. Só então remove os pontos cuja coleta escolhida não
tem intercorrência; uma coleta com quantidade zero continua válida. A resposta
usa `syncId` como `occurrenceId` e gera um digest estável para linhas legadas
sem esse identificador. O resultado permanece em cache por até cinco minutos e
é invalidado depois de um lote válido de coletas.

Para testar o envio de checklist (substitua `<URL>`; o base64 abaixo é o
texto "teste" codificado, só para confirmar que a rota funciona — não é um
PDF válido, mas é suficiente para verificar que o arquivo aparece na pasta):

```bash
curl -X POST "<URL>" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"checklist":{"filename":"Checklist_TESTE_2026-01-01.pdf","pdfBase64":"dGVzdGU="}}'
```

Esperado: `{"ok":true}`, e um arquivo `Checklist_TESTE_2026-01-01.pdf` na
pasta configurada em `CHECKLISTS_FOLDER_ID`. Rodar o mesmo comando de novo
deve substituir esse arquivo (mesmo nome), não duplicar.

### Alterações de roteiros vindas do app

O app envia alterações de pontos existentes com a ação `routeChanges`. O GAS
cria automaticamente a aba `AlteracoesRoteiros` na planilha configurada em
`SPREADSHEET_ID`. Cada alteração é identificada por um `Change ID`, portanto um
reenvio não duplica a operação.

Somente este fluxo usa o `ROUTE_CHANGES_TOKEN`; as rotas históricas de leitura
do CSV e de envio de coletas permanecem compatíveis. O token deve ser informado
na tela Admin do app e no frontend Access integrado. A consulta do Access e a
confirmação das linhas processadas são feitas por `POST`, evitando expor o
segredo na URL.

O procedimento completo de instalação e piloto está em
[`docs/INTEGRACAO_ACCESS_ROTEIROS.md`](../docs/INTEGRACAO_ACCESS_ROTEIROS.md).

## Publicação automatizada com GitHub Actions

O workflow `.github/workflows/deploy-gas.yml` publica o conteúdo de `gas/`
no mesmo Deployment ID. Ele é manual e usa o ambiente protegido
`gas-production`.

Antes da primeira execução:

1. Ative a API do Google Apps Script em
   https://script.google.com/home/usersettings.
2. Execute `npx @google/clasp@3.3.0 login` em uma máquina confiável.
3. Crie no GitHub o ambiente `gas-production`, preferencialmente com
   aprovação obrigatória.

Configure nesse ambiente:

- Secret `CLASPRC_JSON`: conteúdo do arquivo `~/.clasprc.json` gerado por
  `clasp login`.
- Secret `CLASP_JSON`: JSON com o Script ID, normalmente
  `{"scriptId":"SEU_SCRIPT_ID"}`.
- Variable `GAS_DEPLOYMENT_ID`: ID da implantação de produção existente.
- Variable `GAS_WEB_APP_URL`: URL de produção terminada em `/exec`.

Para publicar, execute o workflow deixando `target_version` vazio. O fluxo
envia o código, cria uma versão, atualiza a implantação existente e testa o
endpoint `action=status`.

Para rollback, execute novamente informando em `target_version` o número de
uma versão GAS anterior. As propriedades do script
(`SPREADSHEET_ID`, `DRIVE_FOLDER_ID`, `CHECKLISTS_FOLDER_ID` e
`ROUTE_CHANGES_TOKEN`) não são
alteradas pelo workflow.

## Reenvio de coletas e histórico do dashboard

O GAS deduplica coletas pela coluna `Sync ID`. O dashboard reenvia pendências
em lotes de até 100 registros antes de consultar o histórico. O identificador
é persistido antes do envio, inclusive para registros legados sem ID, e uma
falha mantém a coleta pendente para a próxima tentativa.

O endpoint `GET ?action=historicoColetas` retorna
`{ "ok": true, "data": [...], "quality": { "invalidDates": 0, "invalidQuantities": 0, "excludedRecords": 0 } }`.
O parâmetro opcional `mes=YYYY-MM` filtra o
mês. Cada registro contém `idRota`, `data`, `cliente`, `roteiro`, `quantidade`,
`intercorrencia`, `sincronizadoEm` e `syncId`. Datas são normalizadas para
`YYYY-MM-DD` no fuso operacional `America/Sao_Paulo`. O cache do histórico dura
até cinco minutos; novas linhas mudam a chave, e falhas de cache não impedem
a resposta. Desde a API 9, os metadados de qualidade integram o cache. Datas
impossíveis e quantidades vazias, negativas, fracionárias ou não numéricas
são excluídas e contabilizadas; zero é uma quantidade válida. As contagens
de qualidade cobrem toda a aba consultada, mesmo com filtro de mês, e uma
linha inválida conta uma única vez em `excludedRecords`. Linhas inteiramente
vazias não contam como registros. O dashboard também exclui e informa datas
futuras. Servidores sem `quality` permitem exibir totais, mas não comparações.

A API 10 torna o contrato de escrita de coletas estrito: cada item exige
`id_rota`, `sync_id`, data civil válida até hoje e quantidade inteira não
negativa. O lote inteiro é validado antes da gravação. A resposta informa
`count` e `duplicates`, e o app só conclui as pendências quando essa soma
confirma todos os itens enviados. O reenvio manual, a tela inicial, a tela de
coleta e o dashboard usam a mesma fila e preservam o `sync_id` entre tentativas.

Ao substituir um checklist no Drive, a API 10 cria primeiro o PDF novo e só
depois move as cópias anteriores para a lixeira, sob lock. Se a criação falhar,
o arquivo anterior permanece disponível. Falhas ao limpar versões antigas são
retornadas em `warning` e exibidas pelo app como substituição incompleta.

Os indicadores de coletas, ranking, intercorrências e resumo mensal usam o
histórico remoto mais as pendências locais, sem repetir `syncId`. Se a
consulta falhar, o painel identifica que está mostrando somente dados locais.
Pontos e roteiros continuam vindo do cadastro local, atualizado pelo CSV do
Drive via GAS. A agenda cobre hoje e os seis dias seguintes no fuso
`America/Sao_Paulo`. Edições de agendamentos invalidam o cache geral e o filtrado por data.

O [ADR-0001](../docs/adr/0001-indicadores-dashboard-periodos-e-qualidade-dados.md)
define os indicadores. O mês atual mostra o total de 1 até hoje; sua variação
compara apenas dias encerrados equivalentes nos dois meses. Meses passados
comparam totais de meses completos, com os intervalos visíveis. Atendimentos,
coletas com retirada e recipientes são medidas distintas. A taxa de
intercorrências usa atendimentos como denominador e varia em pontos
percentuais. A visão local parcial ou dados inconsistentes suspendem as
comparações; meses sem registros não são tratados como zero operacional
confirmado.

O painel atualiza ao abrir, ao voltar a ficar visível, ao recuperar a conexão
e a cada cinco minutos enquanto estiver visível. Há também o botão
"Atualizar agora". Erros e pendências impedem a mensagem de sucesso completo.

Para disponibilizar essas correções, atualize a implantação existente do GAS
com `gas/Code.gs` e distribua o frontend incluindo `dashboard.html` e
`dashboard.js` e `dashboard-metrics.js`. Testar o código local não atualiza a
implantação de produção nem o instalador já gerado.

## Arquivos duplicados no Drive

Se a pasta configurada acabar com mais de um arquivo chamado
`cstExportaCheckList.csv` (por exemplo, por engano ao enviar um novo em vez
de substituir o existente), `roteirosCsv` escolhe o de modificação mais
recente. Ainda assim, mantenha apenas um arquivo com esse nome na pasta para
evitar ambiguidade quando duas cópias tiverem o mesmo horário.

## Agendamentos de coleta (aba "verdesagendados")

A aba `verdesagendados` recebe as coletas futuras registradas no app. Ela é
criada automaticamente pelo GAS com o cabeçalho:

`ID | Cliente | Endereço | Materiais | Data Prevista | Sincronizado Em`

- `ID` é o `sync_id` gerado pelo app e permite editar/excluir uma linha de
  forma estável (o lote é idempotente por ID).
- `Data Prevista` é gravada no formato `YYYY-MM-DD`.
- Se a aba já existir com apenas `Cliente | Endereço | Materiais | Data
  Prevista`, o cabeçalho é reescrito adicionando as colunas `ID` e
  `Sincronizado Em`; linhas antigas ficam com `ID` vazio (aparecem no PDF,
  mas não podem ser editadas/excluídas pelo app).

Buscar agendamentos (opcionalmente filtrados por data):

```bash
curl "<URL>?action=agendamentos"
curl "<URL>?action=agendamentos&data=2026-08-10"
```

Esperado: `{"ok":true,"data":[{...}]}`.

Enviar alterações (upsert/delete em lote):

```bash
curl -X POST "<URL>" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"action":"syncAgendamentos","ops":[{"op":"upsert","id":"abc-123","cliente":"CEPON","endereco":"Rua A, 1","materiais":"Papelão","dataPrevista":"2026-08-10"},{"op":"delete","id":"xyz-456"}]}'
```

Esperado: `{"ok":true,"upserts":1,"deletes":1}`.

## Fotos dos agendamentos (Drive)

Cada agendamento pode ter até **3 fotos** (`.jpg`/`.jpeg`/`.png`, até ~8 MB
cada). As fotos ficam no Drive, dentro da pasta já configurada em
`CHECKLISTS_FOLDER_ID`, no layout:

```
<CHECKLISTS_FOLDER_ID>/AgendamentosFotos/<idDoAgendamento>/foto_1.jpg
                                                          /foto_2.png
                                                          /foto_3.jpg
```

Os slots são fixos (`foto_1`, `foto_2`, `foto_3`), então reenviar um slot
**substitui** o arquivo anterior (idempotente). A planilha `verdesagendados`
**não muda** — as fotos são vinculadas pelo `ID` do agendamento.

Enviar/substituir fotos e remover slots (em lote):

```bash
curl -X POST "<URL>" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"action":"uploadAgendamentoFotos","id":"abc-123","fotos":[{"nome":"foto_1.jpg","base64":"<base64-sem-prefixo-data>"}],"remover":["foto_2.png"]}'
```

Esperado: `{"ok":true,"count":1}` (`count` = fotos gravadas).

Listar as fotos de um agendamento (metadados; use `incluirBase64=true` para
receber o conteúdo):

```bash
curl "<URL>?action=agendamentoFotos&id=abc-123"
curl "<URL>?action=agendamentoFotos&id=abc-123&incluirBase64=true"
```

Esperado: `{"ok":true,"fotos":[{"nome":"foto_1.jpg","slot":"foto_1"}]}`
(com `base64` e `mime` por foto quando `incluirBase64=true`). Se o agendamento
não tiver pasta de fotos, retorna `{"ok":true,"fotos":[]}`.


## Cadastro compartilhado (API v14 ou posterior)

A versão 14 adicionou a ação `cadastroSync`, que permite vários aparelhos
compartilharem os pontos e roteiros criados ou editados no app. Ela continua
igual na versão atual (15); o app exige a 14 ou posterior.

- **Nada novo para configurar:** usa `SPREADSHEET_ID` e o mesmo
  `ROUTE_CHANGES_TOKEN`. As abas `CadastroPontos` e `CadastroRoteiros` são
  criadas sozinhas na primeira sincronização. Só o GAS escreve nelas; as
  tabelas do Access (`tblRotas`, `shtClientes`, `tblRoteiros`) não são tocadas.
- **Publicar sem trocar a URL:** siga "Atualização sem trocar a URL dos
  aplicativos" acima (Nova versão na implantação ativa). Os apps antigos
  continuam funcionando; só não compartilham o cadastro até serem atualizados.
- **Conflitos:** vence a edição mais recente (`Editado Em`); em empate exato
  vence a maior `Origem`. Relógio adiantado mais de 5 minutos é limitado ao
  horário do servidor. Quem perde recebe a versão do servidor na própria
  resposta.
- **Exclusões** ficam como lápide (`Excluido=1`) para chegar aos outros
  aparelhos.
- **Roteiros renomeados:** `Chave` guarda o nome original e `Apelidos` os nomes
  antigos. As consultas `ultimaColeta`, `ultimaColetaDetalhada` e
  `intercorrenciasRoteiro` passam a considerar todos esses nomes, então
  renomear um roteiro no app não zera o histórico.
- **Planilha:** não edite as abas `Cadastro*` à mão (as colunas `Rev` e
  `Editado Em` controlam a sincronização).

Teste manual (substitua `<URL>` e `<TOKEN>`):

```bash
curl -X POST "<URL>" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"action":"cadastroSync","token":"<TOKEN>","since":0,"pontos":[],"roteiros":[]}'
```

Esperado: `"ok":true`, `"apiVersion":15`, `"rev"` e as listas `pontos`/`roteiros`
(vazias numa planilha nova).

## Snapshot de roteiros (API v15)

Desde a versão 15, `GET <URL>` e `?action=roteiros` devolvem o contrato
`roteiros/v1`, pensado para o `desktop/logistics` (plano em
`docs/superpowers/plans/2026-09-15-gas-contrato-logistica-roteiros.md`):

```json
{"ok":true,"apiVersion":15,"contract":"roteiros/v1","modifiedTime":"...",
 "counts":{"clientes":0,"roteiros":0,"pontos":0},"skipped":0,
 "skippedDetalhe":{"semCliente":0,"semRoteiro":0,"idUnicoConflitante":0},"conflitosIdUnico":[],
 "clientes":[{"idUnico":"...","uuid":null,"cliente":"...","logradouro":"...","numero":"...",
              "cep":"...","complemento":"...","telefone1":"...","telefone2":"..."}],
 "roteiros":[{"roteiro":"SAT01","pontos":[{"idRota":"3","idUnico":"...","ordem":1,"inativo":0}]}]}
```

- Lê só as abas do Access (`tblRotas`, `shtClientes`, `tblRoteiros`). **Não
  inclui o cadastro editado no app** (`CadastroPontos`/`CadastroRoteiros`):
  pontos `APP-n`, edições, exclusões e roteiros renomeados no app não aparecem.
- `logradouro` vem da coluna `logradouro` de `shtClientes`, se existir; sem
  ela, sai vazio.
- Pontos descartados entram em `skipped`, detalhados em `skippedDetalhe`:
  `semCliente` (idPJ sem cliente, sem nome ou sem `idUnico2`), `semRoteiro`
  (`idRoteiro` que não existe em `tblRoteiros`) e `idUnicoConflitante`.
- **`conflitosIdUnico`**: `idUnico2` usado por dois ou mais `idPJ` com dados
  diferentes. Os pontos desses clientes ficam de fora do snapshot (em vez de
  mostrarem os dados do cliente errado) até o `idUnico2` ser corrigido no
  Access. Cópias idênticas do mesmo cliente não contam como conflito.
- O tipo de resíduo não faz parte do contrato.
- Mudança incompatível com a API 14: quem lia `rows`/`count` precisa migrar.
  O app não usa este endereço (usa `roteirosCsv`).

## Cópia de teste

Para testar sem acesso à produção, `gas-teste/README.md` explica como montar uma
cópia no seu próprio Google com o script `gas-teste/PrepararTeste.gs` (que
propositalmente não fica nesta pasta).
