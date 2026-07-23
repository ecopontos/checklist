# Empacotamento como App Windows (Electron) — Design

**Goal:** Distribuir o app hoje estático (HTML/CSS/JS) como um instalador Windows
(`Setup.exe`) que os operadores rodam uma única vez, ganhando um atalho na área de
trabalho e uma janela própria — sem depender de um servidor de rede compartilhado nem
de caminhos `\\servidor\pasta` abertos direto no Explorer.

**Escopo:** Adiciona um wrapper Electron + configuração de empacotamento
(`electron-builder`) por cima do app existente. **Não modifica** nenhum dos arquivos
estáticos atuais (`index.html`, `roteiros.html`, `coleta-checklist.html`,
`analise.html`, `admin.html`, `imprimir.html`, `whatsapp-sender.html`, `database.js`,
`google-sync.js`, `vendor/`) — eles continuam servindo tanto o GitHub Pages/IIS quanto
o app empacotado, sem duplicação. `docs/deploy-rede-local.md` (guia de IIS) continua
válido como alternativa para quem preferir servidor de rede em vez de instalar em cada
PC; este documento cobre a via alternativa de distribuição via instalador.

## Por que precisa de um servidor embutido

O app usa `<script type="module">` e `database.js` carrega `sql.js` via `fetch()` de um
arquivo `.wasm`. Ambos são bloqueados por navegadores (e pelo Chromium que roda dentro
do Electron) quando a página é carregada via `file://`. A solução é o próprio processo
principal do Electron subir um servidor HTTP local minimalista e carregar a app a
partir dele — o mesmo modelo já usado durante o desenvolvimento
(`python -m http.server`), só que embutido no `.exe` em vez de rodado manualmente.

## Arquitetura de arquivos

Novo `package.json` na **raiz do repositório** (não em subpasta), com
`"main": "electron/main.js"`. Isso evita duplicar os arquivos estáticos: o
`electron-builder` empacota os arquivos existentes na raiz diretamente (via `files` no
`package.json`), sem copiá-los para dentro de `electron/`.

```
electron/
  main.js       # processo principal: servidor embutido + janela + link handling
  icon.ico      # ícone do app (placeholder genérico inicialmente)
package.json    # dependências (electron, electron-builder) + config de build
```

`node_modules/` e a pasta de saída do build (`dist/`) entram no `.gitignore`. Isso
**não** torna o site estático "com build" — GitHub Pages e o guia de IIS continuam
servindo os arquivos da raiz diretamente, ignorando `package.json` por completo; só
quem for gerar o `.exe` roda o build do Electron, e isso é opcional.

## Servidor embutido e porta fixa

`electron/main.js` sobe um servidor HTTP estático simples (módulo `http` do Node, sem
framework — leitura de arquivo + `Content-Type` por extensão) na porta fixa
**`47821`**, escutando só em `127.0.0.1` (não exposto à rede). A `BrowserWindow` carrega
`http://127.0.0.1:47821/index.html`.

**Mapeamento de MIME type explícito**, incluindo `.wasm` → `application/wasm` (sem
isso, `sql.js` falha ao carregar e o app não abre nenhum roteiro/cliente — mesmo
problema documentado em `docs/deploy-rede-local.md` para o IIS).

**A porta é fixa deliberadamente, não escolhida dinamicamente.** `localStorage` (onde
mora o banco `app3_db`) é isolado por origem (protocolo+host+porta); se a porta mudasse
a cada abertura do app, cada execução veria uma origem diferente e o banco local
pareceria "sumir" a cada reinício. Com `http://127.0.0.1:47821` fixo, a origem é sempre
a mesma entre reinícios do app na mesma máquina — os dados persistem normalmente, igual
já acontece hoje no navegador.

**Se a porta 47821 já estiver em uso** ao iniciar (outra instância do app, ou colisão
rara com outro software), o app mostra uma caixa de diálogo de erro nativa
(`dialog.showErrorBox`) e encerra, em vez de tentar outra porta silenciosamente — uma
porta diferente teria uma origem diferente, e trocar silenciosamente esconderia os
dados já salvos do operador atrás de uma origem "vazia".

## Janela e tratamento de links

`BrowserWindow` padrão (com moldura do SO, redimensionável, ~1280x800 inicial, ícone
próprio) carregando a URL do servidor embutido. Sem qualquer UI de navegador (barra de
endereço, abas) — isso já é o comportamento padrão de uma `BrowserWindow` do Electron,
não precisa de configuração extra.

Dois pontos do app existente abrem novas janelas via `window.open(..., '_blank')` e
precisam de tratamento explícito no `main.js` via `setWindowOpenHandler` (sem isso, o
Electron tentaria abrir os dois casos dentro do próprio app):

- **`whatsapp-sender.html` → `https://wa.me/...`** (disparo de mensagem): URL externa,
  redirecionada para o navegador padrão do Windows via `shell.openExternal` — abre
  WhatsApp Web/Desktop normalmente, fora da janela do app.
- **`roteiros.html` → `imprimir.html?id=...`** (impressão de uma rota): URL interna
  (mesma origem `http://127.0.0.1:47821`), abre como uma nova `BrowserWindow` dentro do
  ecossistema do app. `window.print()` já funciona nativamente em `BrowserWindow`,
  disparando o diálogo de impressão do Windows sem mudança nenhuma no código de
  `imprimir.html`.

A distinção entre os dois casos, no handler, é feita pela origem da URL solicitada:
mesma origem do servidor embutido → nova `BrowserWindow` interna; qualquer outra origem
→ `shell.openExternal`.

Nenhuma mudança de código nos arquivos `.html`/`.js` existentes — toda a lógica de
roteamento de links vive só no `main.js` do Electron.

## Empacotamento (electron-builder)

Alvo Windows via **NSIS**, configurado para instalação **por usuário**
(`"perMachine": false`), instalando em `%LOCALAPPDATA%\Programs\<nome-do-app>` em vez de
`C:\Program Files\<nome-do-app>`. Isso não exige permissão de administrador para
instalar — importante porque operadores podem não ter acesso admin nas máquinas.
`Setup.exe` gerado cria atalho na área de trabalho e entrada no menu Iniciar
automaticamente durante a instalação.

`files`/`extraResources` no `package.json` apontam para os arquivos estáticos já
existentes na raiz (`*.html`, `database.js`, `google-sync.js`, `vendor/**`) mais
`electron/**` — sem cópia/duplicação.

Ícone: placeholder genérico nesta primeira versão; trocável depois sem mudança de
arquitetura.

**Sem assinatura de código (certificado).** O Windows SmartScreen provavelmente exibirá
aviso de "Editor desconhecido" na primeira execução em cada PC — o operador precisa
clicar em "Mais informações → Executar assim mesmo". Isso é esperado para instaladores
não assinados; evitar isso exigiria comprar um certificado de assinatura de código, fora
do escopo desta feature.

Build roda só na máquina de desenvolvimento (`npm run build`, gera `Setup.exe` em
`dist/`); distribuição para os PCs dos operadores é manual (cópia do arquivo), conforme
decidido — sem infraestrutura de atualização automática nesta versão.

## Verificação

Sem suíte de testes automatizada neste repo (mesmo padrão do restante do projeto).
Verificação manual, rodando o app empacotado (ou `electron .` em modo dev antes de
empacotar) numa máquina Windows:

1. App abre numa janela própria, sem UI de navegador, carregando `index.html` a partir
   do servidor embutido (`http://127.0.0.1:47821`).
2. Navegar entre as páginas via a barra de navegação (`roteiros.html`,
   `coleta-checklist.html`, `analise.html`, `admin.html`) funciona normalmente dentro da
   mesma janela.
3. `sql.js` carrega sem erro (confirmar que um roteiro cadastrado aparece na lista em
   `coleta-checklist.html` — se o MIME type do `.wasm` estivesse errado, a lista
   ficaria vazia mesmo com dados salvos).
4. Registrar uma coleta, fechar o app completamente e reabrir: o dado salvo
   (`localStorage`/`app3_db`) continua lá — confirma que a porta fixa está preservando
   a origem entre execuções.
5. Em `roteiros.html`, clicar em "🖨️ Imprimir" para uma rota: abre `imprimir.html` numa
   nova janela do app (não no navegador externo), e o diálogo de impressão do Windows
   aparece ao clicar em "IMPRIMIR AGORA".
6. Em `admin.html` → card "Ferramentas" → `whatsapp-sender.html`, preparar um disparo e
   clicar para enviar: abre o navegador padrão do Windows (não uma janela do Electron)
   em `wa.me`.
7. Sincronização com Google Sheets/Drive (`admin.html`, URL do Web App já configurada)
   funciona igual ao navegador — sem mudança nesse fluxo, só confirmar que o `fetch()`
   cross-origin pra `script.google.com` funciona de dentro do Electron.
8. Instalar via `Setup.exe` numa máquina limpa (ou usuário sem admin, se disponível):
   confirmar que não pede elevação, e que cria o atalho na área de trabalho sozinho.

## Fora de escopo

- Atualização automática do app instalado — redistribuição é manual (novo
  `Setup.exe`, reinstalar em cada PC) sempre que o código mudar.
- Assinatura de código / certificado — SmartScreen vai avisar "Editor desconhecido" na
  primeira execução, aceito como conhecido.
- Empacotamento para macOS/Linux — só Windows, único SO usado pelos operadores.
- Qualquer mudança no fluxo de sincronização Google Sheets/Drive existente
  (`gas/`, `google-sync.js`) — o app empacotado usa exatamente o mesmo mecanismo já
  implementado, sem alteração.
- Ícone personalizado com identidade visual da empresa — usa placeholder genérico por
  ora, trocável numa iteração futura sem mudança de arquitetura.
