# checklist

Aplicacao estatica para gestao local de roteiros e coletas.

## Escopo atual

- `index.html`: dashboard principal
- `roteiros.html`: cadastro e ordenacao de roteiros e pontos
- `coleta-checklist.html`: operacao de coleta
- `analise.html`: consulta e analise
- `imprimir.html`: saida para impressao
- `admin.html`: importacao legada, backup local e sincronizacao com Google Sheets/Drive via Apps Script
- `whatsapp-sender.html`: preparo de disparos via WhatsApp
- `database.js`: persistencia local em SQLite via `sql.js` + `localStorage`

## Como publicar

E um site estatico. Nao exige build.

1. Publique o conteudo na raiz do repositorio.
2. Habilite GitHub Pages a partir da branch `main`, pasta `/ (root)`.
3. Acesse `index.html` como entrada principal.

## Observacoes tecnicas

- O banco e local ao navegador, salvo na chave `app3_db` do `localStorage`.
- `admin.html` sincroniza de verdade: coletas sao enviadas a uma planilha Google Sheets e rotas/pontos sao importados automaticamente de um CSV numa pasta do Google Drive, atraves de um Web App Google Apps Script. Codigo-fonte e instrucoes de deploy do script em `gas/`.
- Os arquivos em `vendor/` fazem parte da aplicacao e devem permanecer versionados.
