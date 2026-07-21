# Sincronização com Google Sheets (push) e Google Drive (pull)

## Contexto

O app é estático (GitHub Pages), sem backend, com persistência local em SQLite via
`sql.js` + `localStorage` (`database.js`). Hoje existem dois pontos desconectados da
nuvem:

- `admin.html` tem um card "Sincronização Supabase" que é **mock visual** — não
  transfere nada de verdade.
- `analise.html` tem um botão "Exportar para CSV" que gera um arquivo local para
  reimportação manual em outro lugar.
- A atualização de rotas/pontos é sempre manual: upload de `.xlsx`/`.csv` em
  `admin.html` ou `roteiros.html`.

Objetivo: substituir esses dois pontos por integração real com o Google, usando
Google Apps Script (GAS) como ponte, sem exigir backend próprio.

## Arquitetura

Um único Web App do Google Apps Script (`Code.gs`), publicado com acesso "Anyone"
(sem token, decisão explícita do usuário — dados não são sensíveis), com duas rotas:

- **Push** (`doPost`): recebe coletas novas do app e grava na planilha Google
  Sheets, permitindo que outros dispositivos na rede vejam os dados atualizados.
- **Pull** (`doGet`): devolve o conteúdo do arquivo `cstExportaCheckList.csv`
  mais recente de uma pasta do Google Drive, para o app importar rotas/pontos
  automaticamente.

```
coleta-checklist.html --POST--> GAS doPost --> Google Sheets (aba "Coletas")
admin.html / index.html --GET--> GAS doGet <-- Google Drive (cstExportaCheckList.csv)
```

CORS: o body do POST é enviado como `text/plain;charset=utf-8` (não
`application/json`) para evitar preflight OPTIONS, que o Apps Script Web App não
trata. O `Code.gs` faz `JSON.parse(e.postData.contents)` manualmente.

## Componentes

### 1. `gas/Code.gs` (novo)

Arquivo de referência para o usuário colar no editor do Apps Script e publicar
como Web App. Não faz parte do deploy do site estático.

Configuração via Script Properties (preenchidas pelo usuário após criar a
planilha e a pasta, não hardcoded):
- `SPREADSHEET_ID`
- `DRIVE_FOLDER_ID`

**`doPost(e)`**
- Espera `{ coletas: [{ id_rota, data, quantidade, intercorrencia, roteiro,
  cliente, sync_id }, ...] }`.
- Garante que a aba "Coletas" existe na planilha (cria com cabeçalho se não
  existir: `ID Rota, Data, Cliente, Roteiro, Quantidade, Intercorrência,
  Sincronizado Em, Sync ID`).
- Faz `appendRow` para cada item recebido.
- Retorna `{ ok: true, count: N }` ou `{ ok: false, error: "..." }` (HTTP 200
  sempre — Apps Script Web Apps não deixam customizar status code de forma
  confiável; o cliente decide sucesso/erro pelo campo `ok`).

**`doGet(e)`**
- Busca na pasta `DRIVE_FOLDER_ID` o arquivo de nome fixo
  `cstExportaCheckList.csv`.
- Se encontrado: retorna `{ ok: true, content: "<texto csv>", modifiedTime:
  "<ISO 8601>" }`.
- Se não encontrado: retorna `{ ok: false, error: "Arquivo não encontrado" }`.

### 2. `database.js`

- `addColeta(coleta)` passa a retornar o `id` da linha inserida (via
  `last_insert_rowid()`), necessário para marcar sincronização depois.
- Novo `markColetaSynced(id, syncId)`: `UPDATE coletas SET last_sync = ?,
  sync_id = ? WHERE id = ?`.
- Novo `getUnsyncedColetas()`: coletas com `last_sync IS NULL`, já com join de
  cliente/roteiro (mesmos campos usados no antigo `exportToCSV`).
- Novo `importRoteirosCsv(csvText)`: extrai a lógica hoje inline em
  `roteiros.html:handleFile` (parse com PapaParse, resolve/cria roteiros por
  nome, upsert de clientes por `idRota`, `Inativo` invertido para `ativo`).
  Retorna `{ roteiros: N, clientes: N }` para exibição de status.
  `roteiros.html` passa a chamar esse método em vez de duplicar a lógica.

### 3. `coleta-checklist.html`

- Em `saveOperation()`, após os `db.addColeta(...)` locais (que já acontecem
  hoje), chama `syncColetasToSheet(savedEntries)`:
  - Monta o payload com os dados já disponíveis em memória (mesmo formato do
    antigo `exportToCSV`: roteiro, data, cliente, id_rota, quantidade,
    intercorrência) mais o `id` local e um `sync_id` gerado com
    `crypto.randomUUID()`.
  - POST para a URL do GAS (lida de `localStorage`, configurada uma vez em
    `admin.html`).
  - Sucesso → `db.markColetaSynced(id, syncId)` para cada item.
  - Falha (rede, URL não configurada, resposta `ok:false`) → não bloqueia o
    fluxo; toast adicional "Sincronização pendente". O dado já está salvo
    localmente (`last_sync` permanece `NULL`), pronto para retry manual.

### 4. `analise.html`

- Remove o botão "Exportar para CSV" e a função `exportToCSV()`.
- Novo botão "Forçar sincronização": chama `db.getUnsyncedColetas()`, envia ao
  GAS do mesmo jeito que `syncColetasToSheet`, marca como sincronizado em caso
  de sucesso, mostra quantos foram enviados/quantos ainda falharam.

### 5. `admin.html`

Card "Sincronização Supabase" é substituído por "Sincronização Google":

- Um único campo: URL do Web App do GAS (salva em `localStorage`, mesma ideia
  dos campos de URL/Key do Supabase que existiam).
- Status: horário da última verificação de rotas/pontos no Drive, e contagem
  de coletas pendentes de envio (via `getUnsyncedColetas().length`).
- Ao carregar a página, dispara automaticamente uma checagem no `doGet`:
  compara `modifiedTime` retornado com o timestamp salvo em
  `localStorage` (`app3_last_drive_sync`); se for mais novo (ou não houver
  timestamp salvo ainda), chama `db.importRoteirosCsv(content)` e atualiza o
  timestamp local.
- Botão "Verificar agora" força essa mesma checagem sob demanda (fallback
  manual, espelhando o botão de força-sincronização do lado das coletas).
- Erro (rede, URL não configurada, arquivo não encontrado) aparece como aviso
  inline no card, sem travar a página; dados locais nunca são sobrescritos
  parcialmente — só há upsert após um CSV completo e válido ser recebido.

### 6. `index.html`

- No load, dispara a mesma checagem silenciosa de `doGet` + import (mesma
  função compartilhada de `admin.html`), sem UI de status — só para garantir
  que quem abre o dashboard já puxa rotas/pontos atualizados antes de ir
  coletar. Se a URL do GAS não estiver configurada ainda, a checagem é
  simplesmente pulada (sem erro visível).

## Fora do escopo

- Sem autenticação/token no Web App do GAS (decisão explícita do usuário).
- Fluxo de migração legada Access/Excel em `admin.html` (upload de
  `Rotas.xlsx`/`Pontos.xlsx`) não é alterado — é um processo separado de
  migração única, não a atualização contínua via `cstExportaCheckList.csv`.
- Sem fila de reenvio offline para coletas — assume-se que a coleta acontece
  sempre com internet disponível; falha de envio só marca como pendente para
  reenvio manual futuro (via "Forçar sincronização").
- Coluna `Fonte` do CSV não é usada (não é usada hoje em nenhum lugar do app).

## Testes

- `database.js`: testes manuais via console do navegador para
  `importRoteirosCsv`, `markColetaSynced`, `getUnsyncedColetas` (não há suíte
  de testes automatizados no projeto hoje).
- `Code.gs`: testado manualmente publicando o Web App e chamando `doGet`/
  `doPost` via `curl`/Postman antes de integrar ao front-end.
- Fluxo ponta a ponta: registrar uma coleta em `coleta-checklist.html` e
  conferir a linha na planilha; substituir o `cstExportaCheckList.csv` na
  pasta do Drive e conferir que `admin.html`/`index.html` reimportam os dados
  na próxima carga.
