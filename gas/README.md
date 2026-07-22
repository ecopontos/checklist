# Deploy do Web App (Code.gs)

1. Crie uma planilha Google Sheets (vazia, qualquer nome) — copie o ID dela
   da URL: `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.
2. Crie uma pasta no Google Drive onde o arquivo `cstExportaCheckList.csv`
   será colocado (e substituído a cada atualização) — copie o ID dela da URL:
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
7. Clique em "Implantar" > "Nova implantação" > tipo "App da Web".
   - Executar como: **Eu** (sua conta)
   - Quem tem acesso: **Qualquer pessoa**
8. Autorize as permissões solicitadas (acesso a Sheets e Drive).
9. Copie a URL do Web App gerada (termina em `/exec`) — essa é a URL que
   vai no campo "URL do Web App do Google Apps Script" em `admin.html`.

## Teste manual pós-deploy

Depois de colocar um `cstExportaCheckList.csv` na pasta configurada, teste
com `curl` (substitua `<URL>` pela URL do passo 9):

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

Toda vez que o `Code.gs` for editado no editor do Apps Script, é preciso
criar uma **nova implantação** (ou gerenciar implantações > editar a
implantação existente) para que as mudanças valham para a URL já em uso.

## Limitação conhecida: linhas duplicadas em reenvios

O `doPost` sempre adiciona uma nova linha na aba "Coletas" — ele não usa a
coluna "Sync ID" para evitar duplicatas. Se uma coleta for gravada na
planilha mas a resposta nunca chegar de volta ao app (ex: conexão caiu logo
após o envio), o app mantém a coleta como "não sincronizada" localmente e
vai reenviá-la na próxima sincronização automática ou manual — criando uma
segunda linha para a mesma coleta na planilha. Isso é aceitável dado que o
app assume conexão sempre disponível no momento da coleta (sem fila
offline), mas é bom saber que a coluna "Sync ID" existe justamente para
permitir identificar e limpar duplicatas manualmente na planilha, caso
aconteçam.

## Limitação conhecida: arquivo duplicado no Drive

Se a pasta configurada acabar com mais de um arquivo chamado
`cstExportaCheckList.csv` (por exemplo, por engano ao enviar um novo em vez
de substituir o existente), o `doGet` pode retornar qualquer um dos dois —
não necessariamente o mais recente. Sempre **substitua** o arquivo existente
na pasta (mantendo um único arquivo com esse nome) em vez de fazer upload de
uma cópia adicional.
