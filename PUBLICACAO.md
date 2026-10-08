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

## PWA

- O app é instalável como PWA quando servido por HTTPS (ou `localhost`): `manifest.webmanifest`, ícones em `icons/` e o service worker `sw.js`, registrado por `pwa.js` em todas as páginas. No Tauri o service worker não é registrado.
- O `sw.js` guarda todo o app no cache para uso offline. **A cada release, atualize `VERSION` em `sw.js` junto com o `package.json`** — é isso que faz os PWAs instalados baixarem a versão nova (o `npm test` acusa se as versões divergirem ou se um arquivo novo ficar fora do `PRECACHE`).
- O banco local fica no IndexedDB (`satelite-checklist` → `kv` → `app3_db`), sem o limite de ~5 MB do localStorage. Na primeira abertura o banco antigo do localStorage é migrado automaticamente. O estado anterior a essa mudança está registrado em `docs/PRE-PWA.md`.

## Cadastro editado no app

- O app é o dono de clientes e roteiros. O que é criado ou editado nele (`editado_em`) **nunca** é sobrescrito pela importação do CSV do Access, nem pela automática nem pela manual, a menos que se marque "Sobrescrever" na importação manual. Pontos excluídos no app também não voltam.
- Pontos novos recebem ids `APP-n` e roteiros renomeados mantêm o nome antigo como apelido (`roteiro_alias`). "Exportar CSV" gera o arquivo no formato do Access (`;`, ordem `1,00`, BOM) e reimporta sem perdas.
- **Compartilhado entre aparelhos pelo GAS v14 ou posterior (atual: v15)** (`cadastroSync`, ver `gas/README.md`): pontos `APP-n`, edições de pontos do Access, ordem, roteiros criados/renomeados e exclusões. Vence a edição mais recente. Roda ao abrir o início e a tela de Roteiros, após cada alteração e no botão da tela Admin. Sem um GAS v14 ou posterior publicado, ou sem URL/token, o cadastro continua funcionando só no aparelho e as alterações ficam pendentes.
