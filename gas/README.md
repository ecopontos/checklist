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

Esperado: `{"ok":true,"service":"satelite-gas","apiVersion":3,"routeChangesConfigured":true}`.

```bash
curl "<URL>"
```

Esperado: JSON com `"ok":true`, `"content":"Fonte;idRota;..."`,
`"modifiedTime"` e `"encoding":"UTF-16LE"` para o arquivo do Access.

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
