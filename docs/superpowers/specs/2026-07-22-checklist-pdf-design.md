# Checklist da Próxima Coleta (PDF)

## Contexto

Existe uma versão legada do app (`legado/coleta-checklist.html`) que, ao final
de uma coleta, gera um checklist impresso para a coleta seguinte: um modal
pede data da próxima coleta, tipo de resíduo, motorista e veículo, e monta
uma página A4 paisagem com uma linha por ponto (quantidade prevista =
quantidade coletada hoje, coluna em branco para anotar a quantidade real na
próxima visita, e o problema relatado hoje como aviso). A geração usa
`window.print()` nativo do navegador — sem lib de PDF.

O app atual já tem uma função parecida, mas mais simples: `imprimir.html`,
acionado a partir de `roteiros.html`, mostra checklist de um roteiro a
qualquer momento usando a **média histórica** de coletas (`AVG(quantidade)`),
sem vínculo com uma coleta específica recém-salva.

Hoje, quem gera o PDF (via impressão) não é quem imprime — uma terceira
pessoa cuida disso, e esse hand-off é manual. O objetivo desta feature é
automatizar esse hand-off: o próprio app envia o PDF gerado para uma pasta
do Google Drive, para a pessoa que imprime acessar sem depender de quem
gerou.

Isso exige que o app tenha acesso aos bytes reais do PDF (o `window.print()`
não oferece isso — é só um diálogo do SO), então esta feature introduz
geração de PDF de verdade no cliente, via jsPDF + jsPDF-AutoTable.

## Escopo

- Fluxo **novo e separado**, adicionado a `coleta-checklist.html` — não
  substitui nem altera `imprimir.html`, que continua servindo impressão
  genérica com média histórica a qualquer momento.
- Botão "Gerar Checklist Próxima Coleta" no cabeçalho de
  `coleta-checklist.html`, disponível sempre que um roteiro estiver
  carregado (não depende de ter clicado "Salvar Operação" antes — mesma
  regra do legado, que só exige `currentRoteiro` selecionado).

## Modal de configuração

Campos, todos **transitórios** (não persistidos no banco local — nenhuma
mudança de schema):

- **Data da Próxima Coleta** (`input type="date"`, obrigatório para o nome
  do arquivo no Drive — ver "Nome do arquivo" abaixo).
- **Tipo de Resíduo** (`select`, mesmas opções do legado: Vidros,
  Orgânicos, Plásticos, Papel e Papelão, Óleo de Cozinha, Bombonas,
  Resíduos Sólidos).
- **Motorista** (texto livre, opcional).
- **Veículo** (texto livre, opcional).

## Conteúdo do PDF

Layout A4 paisagem, montado com jsPDF + jsPDF-AutoTable:

- Cabeçalho: nome do roteiro, data da coleta de hoje, data da próxima
  coleta, tipo de resíduo, motorista/veículo (se preenchidos), total de
  pontos, total de bombonas previstas (soma das quantidades desta coleta).
- Tabela, uma linha por ponto do roteiro (`currentClients`, na ordem
  atual), colunas: Ordem, Cliente, Logradouro, Número, CEP, ID,
  **Bomb. Qtd.** (quantidade digitada nesta coleta para o ponto —
  `sessionData[id_rota].qty`, vazio se não coletado hoje), **Qtd.
  Coletada** (sempre em branco — preenchimento manual na próxima visita),
  **Problema** (texto do problema relatado hoje para o ponto, vazio se não
  houver — aviso para quem for coletar da próxima vez).
- Rodapé: data/hora de geração do documento.
- Área de assinatura: duas caixas, "Motorista" e "Supervisor".

## Ações: baixar e enviar

Dois botões no modal, independentes:

- **Baixar PDF**: gera o PDF client-side e dispara download local
  (`doc.save(filename)`), sem tocar rede. Serve como fallback caso o envio
  ao Drive falhe ou o Web App não esteja configurado.
- **Enviar para Drive**: gera o mesmo PDF, converte para base64
  (`doc.output('datauristring')` ou equivalente), e envia via POST ao
  mesmo Web App do GAS já usado para sync (`google-sync.js`), com um novo
  export `sendChecklistToDrive(filename, pdfBase64)`. Usa o mesmo padrão
  `Content-Type: text/plain;charset=utf-8` para evitar preflight CORS.
  Erro (URL do GAS não configurada, falha de rede, erro no GAS) aparece
  como alerta; a opção de baixar local continua disponível
  independentemente do resultado do envio.

Data da Próxima Coleta vazia: "Baixar PDF" segue funcionando (o cabeçalho
do PDF mostra a data em branco, mesmo fallback do legado). "Enviar para
Drive" exige a data preenchida (é usada no nome do arquivo) — se vazia, o
botão mostra um alerta pedindo para preencher e não chama a rede.

### Nome do arquivo

`Checklist_{roteiro}_{dataProximaColeta em YYYY-MM-DD}.pdf` — por exemplo,
`Checklist_SAT01_2026-07-23.pdf`.

### Reenvio (substituição)

Reenviar o mesmo roteiro + mesma data da próxima coleta **substitui** o
arquivo anterior: o `doPost` do GAS apaga qualquer arquivo existente com
esse nome exato na pasta de destino antes de criar o novo. Sem acúmulo de
versões.

## Mudanças no GAS (`gas/Code.gs`)

- Nova Script Property: `CHECKLISTS_FOLDER_ID` (pasta separada da usada
  para ler `cstExportaCheckList.csv` — `DRIVE_FOLDER_ID` continua só para
  leitura).
- `doPost` passa a aceitar dois formatos de payload, discriminados pela
  chave presente no corpo JSON:
  - `{ coletas: [...] }` — comportamento existente (grava linhas na aba
    "Coletas").
  - `{ checklist: { filename, pdfBase64 } }` — novo: decodifica o base64,
    apaga qualquer arquivo existente com o mesmo `filename` em
    `CHECKLISTS_FOLDER_ID`, cria o novo arquivo PDF na pasta. Retorna
    `{ ok: true }` ou `{ ok: false, error }`.
- `gas/README.md` ganha um passo a mais nas instruções de deploy (criar a
  segunda pasta, configurar `CHECKLISTS_FOLDER_ID`).

## Vendoring

Duas novas bibliotecas em `vendor/` (build UMD pronta, baixada via `curl`
durante a implementação, sem gerenciador de pacotes, mesmo padrão de
`vendor/xlsx.full.min.js`/`vendor/papaparse.min.js`):

- `vendor/jspdf.umd.min.js`
- `vendor/jspdf.plugin.autotable.umd.min.js`

Carregadas como `<script>` clássico em `coleta-checklist.html`, antes do
`<script type="module">`, mesma ordem de carregamento já usada para as
demais libs vendorizadas.

## Fora do escopo

- Não altera `imprimir.html` nem seu fluxo (roteiros.html → média
  histórica).
- Não persiste tipo de resíduo/motorista/veículo/data da próxima coleta no
  banco local.
- Sem histórico de versões dos PDFs no Drive — cada reenvio substitui o
  anterior.
- Sem autenticação no envio ao GAS (mesma decisão já tomada para o resto
  do Web App).

## Testes

- Sem framework de testes automatizado no projeto (mesma situação da spec
  de sincronização anterior). Verificação manual: servidor estático local
  + navegador, conferindo o PDF baixado (conteúdo, colunas, layout) e o
  arquivo aparecendo/substituindo na pasta do Drive configurada.
- `doPost` com payload `{ checklist: ... }`: testável manualmente via
  `curl` com um base64 pequeno antes de integrar ao front-end, mesma
  prática usada para a rota de coletas.
