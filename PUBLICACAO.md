# Saneamento para publicacao

## Pode publicar

- HTML, JS e WASM locais em `vendor/`
- Fluxo de importacao de planilhas
- Persistencia local no navegador
- Backup manual do banco SQLite

## Nao ha no pacote atual

- Backend obrigatorio
- Atualizacao automatica do aplicativo desktop

## Ponto de atencao

- A area "Sincronizacao Google" em `admin.html` envia dados reais para um Web App Google Apps Script (sem autenticacao, URL configuravel na propria pagina). O backend vive em `gas/` e pode ser publicado manualmente ou pelo workflow protegido descrito em `gas/README.md`.
- O aplicativo desktop e gerado com `npm run build` (Tauri). Mudancas em HTML/JS locais exigem distribuir o novo instalador; mudancas exclusivas no GAS chegam a todos os aplicativos que usam a mesma URL `/exec`.
- A URL do GAS e o token de alteracoes de roteiros podem vir pre-configurados no instalador: copie `config.local.example.js` para `config.local.js` (arquivo local, ignorado pelo git) e preencha os valores reais antes de rodar `npm run build`. A tela Admin sempre pode sobrescrever esses valores manualmente (localStorage tem prioridade sobre o embutido).
- Se o repo for publicado como GitHub Pages, o nome `checklist` e adequado porque a aplicacao usa caminhos relativos.
- O app usa Tauri 2.x com WebView2 nativo do Windows. O instalador gera um NSIS de ~2 MB (vs ~79 MB do Electron anterior).
