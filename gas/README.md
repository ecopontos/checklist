# Deploy do Web App (Code.gs)

1. Crie uma planilha Google Sheets (vazia, qualquer nome) — copie o ID dela
   da URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
2. Crie uma pasta no Google Drive onde o arquivo `cstExportaCheckList.csv`
   será colocado (e substituído a cada atualização) — copie o ID dela da URL:
   `https://drive.google.com/drive/folders/<DRIVE_FOLDER_ID>`.
3. Acesse https://script.google.com/, crie um novo projeto.
4. Apague o conteúdo padrão de `Code.gs` e cole o conteúdo de
   `gas/Code.gs` deste repositório.
5. Em "Configurações do projeto" (ícone de engrenagem) > "Propriedades do
   script", adicione:
   - `SPREADSHEET_ID` = o ID copiado no passo 1
   - `DRIVE_FOLDER_ID` = o ID copiado no passo 2
6. Clique em "Implantar" > "Nova implantação" > tipo "App da Web".
   - Executar como: **Eu** (sua conta)
   - Quem tem acesso: **Qualquer pessoa**
7. Autorize as permissões solicitadas (acesso a Sheets e Drive).
8. Copie a URL do Web App gerada (termina em `/exec`) — essa é a URL que
   vai no campo "URL do Web App do Google Apps Script" em `admin.html`.

## Teste manual pós-deploy

Depois de colocar um `cstExportaCheckList.csv` na pasta configurada, teste
com `curl` (substitua `<URL>` pela URL do passo 8):

```bash
curl "<URL>"
```

Esperado: JSON com `"ok":true`, `"content":"Fonte;idRota;..."` e
`"modifiedTime"`.

```bash
curl -X POST "<URL>" -H "Content-Type: text/plain;charset=utf-8" \
  -d '{"coletas":[{"id_rota":"SAT01-1","data":"2026-07-21","cliente":"CEPON","roteiro":"SAT01","quantidade":3,"intercorrencia":"","sync_id":"teste-curl"}]}'
```

Esperado: `{"ok":true,"count":1}`, e uma nova linha na aba "Coletas" da
planilha configurada.

Toda vez que o `Code.gs` for editado no editor do Apps Script, é preciso
criar uma **nova implantação** (ou gerenciar implantações > editar a
implantação existente) para que as mudanças valham para a URL já em uso.
