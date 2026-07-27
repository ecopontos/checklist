# Saneamento para publicacao

## Pode publicar

- HTML, JS e WASM locais em `vendor/`
- Fluxo de importacao de planilhas
- Persistencia local no navegador
- Backup manual do banco SQLite

## Nao ha no pacote atual

- Chaves ou tokens embutidos
- Backend obrigatorio
- Atualizacao automatica do aplicativo Electron instalado

## Ponto de atencao

- A area "Sincronizacao Google" em `admin.html` envia dados reais para um Web App Google Apps Script (sem autenticacao, URL configuravel na propria pagina). O backend vive em `gas/` e pode ser publicado manualmente ou pelo workflow protegido descrito em `gas/README.md`.
- O aplicativo desktop e gerado com `npm run build`. Mudancas em HTML/JS locais exigem distribuir o novo instalador; mudancas exclusivas no GAS chegam a todos os aplicativos que usam a mesma URL `/exec`.
- Se o repo for publicado como GitHub Pages, o nome `checklist` e adequado porque a aplicacao usa caminhos relativos.
