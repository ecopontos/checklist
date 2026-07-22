# Saneamento para publicacao

## Pode publicar

- HTML, JS e WASM locais em `vendor/`
- Fluxo de importacao de planilhas
- Persistencia local no navegador
- Backup manual do banco SQLite

## Nao ha no pacote atual

- Chaves ou tokens embutidos
- Backend obrigatorio
- Processo de build

## Ponto de atencao

- A area "Sincronizacao Google" em `admin.html` envia dados reais para um Web App Google Apps Script (sem autenticacao, URL configuravel na propria pagina). O codigo do Apps Script vive em `gas/` e nao faz parte do deploy do site estatico — e colado manualmente no editor do Apps Script (ver `gas/README.md`).
- Se o repo for publicado como GitHub Pages, o nome `checklist` e adequado porque a aplicacao usa caminhos relativos.
