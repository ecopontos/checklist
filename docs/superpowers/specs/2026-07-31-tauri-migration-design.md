# Migração de Electron para Tauri — Design

**Goal:** Substituir o wrapper Electron por Tauri, eliminando o Chromium embutido
(~150 MB) e usando o WebView nativo do sistema operacional. O app mantém 100%
do comportamento atual — frontend vanilla HTML/CSS/JS, banco SQLite em
`localStorage`, sincronização com Google Apps Script — com ganho substancial
de desempenho em máquinas com poucos recursos.

**Escopo:** Remove a dependência de Electron e `electron-builder`, adiciona
Tauri 2.x como framework de empacotamento. **Não modifica** nenhum arquivo
estático do frontend (`*.html`, `*.css`, `database.js`, `google-sync.js`,
`vendor/**`). As únicas mudanças no frontend são pontuais e relacionadas a
como o app abre links externos e janelas de impressão — tarefas antes
delegadas ao `electron/main.js`.

## Por que migrar

O app atual gera um instalador de **~79 MB** (versão 1.3.1) porque Electron
embala o Chromium completo. Em máquinas com pouca RAM (2–4 GB), o Chromium
consome **200–400 MB** só para manter a janela ociosa, competindo com o
próprio app e com outros processos do operador.

Tauri resolve isso por arquitetura:

| Aspecto | Electron (atual) | Tauri (destino) |
|---|---|---|
| WebView | Chromium embutido (~150 MB) | WebView2 nativo do Windows |
| Pacote instalador | ~79 MB | ~5–10 MB |
| Memória ociosa | 200–400 MB | 30–50 MB |
| Inicialização | ~1.5s | < 0.8s |
| Backend | Node.js | Rust |

## Arquitetura atual (Electron)

```
electron/main.js (219 linhas)
  ├── Servidor HTTP estático (porta 47821, 127.0.0.1)
  ├── BrowserWindow → http://127.0.0.1:47821/index.html
  ├── setWindowOpenHandler (interno vs externo)
  └── shell.openExternal (WhatsApp)

Frontend (renderer, sandboxizado)
  ├── index.html, roteiros.html, coleta-checklist.html, etc.
  ├── database.js (sql.js WASM + localStorage)
  ├── google-sync.js (fetch para GAS)
  └── vendor/ (sql.js, PapaParse, SheetJS, jsPDF)
```

O Electron aqui é apenas um servidor HTTP + janela. Não existe IPC, não existe
acesso a Node.js pelo renderer, não existem módulos nativos.

## Arquitetura destino (Tauri)

```
src-tauri/
  ├── src/main.rs          # Backend Rust (mínimo)
  ├── tauri.conf.json       # Configuração do Tauri
  ├── capabilities/default.json  # Permissões
  └── icons/                # Ícone do app

Frontend (inalterado, servido pelo Tauri)
  ├── index.html, roteiros.html, coleta-checklist.html, etc.
  ├── database.js (sql.js WASM + localStorage)
  ├── google-sync.js (fetch para GAS)
  └── vendor/ (sql.js, PapaParse, SheetJS, jsPDF)
```

O Tauri serve os assets automaticamente via protocolo `tauri://localhost`.
Não é necessário servidor HTTP customizado.

## Mudanças necessárias no frontend

### 1. Abertura de links externos (WhatsApp)

**Antes (Electron):** `window.open('https://wa.me/...', '_blank')` é
interceptado pelo `setWindowOpenHandler` no main process, que chama
`shell.openExternal()`.

**Depois (Tauri):** Usar a API `open` do plugin `shell` do Tauri:

```javascript
import { open } from '@tauri-apps/plugin-shell';
open('https://wa.me/...');
```

**Arquivo afetado:** `whatsapp-sender.html` (1 ocorrência, linha 671).

### 2. Impressão em nova janela

**Antes (Electron):** `window.open('imprimir.html?id=...', '_blank')` abre
uma nova `BrowserWindow` via `setWindowOpenHandler`.

**Depois (Tauri):** Duas opções:

- **Opção A (recomendada):** Usar multiwindow do Tauri — declarar a janela
  de impressão em `tauri.conf.json` ou criar via Rust. A janela de impressão
  carrega `imprimir.html` com os parâmetros da query string.
- **Opção B (simplificada):** Abrir `imprimir.html` como rota dentro da
  mesma janela, usando `window.location.href`. Mais simples, mas muda o
  fluxo do usuário (volta à janela anterior ao fechar).

**Arquivo afetado:** `roteiros.html` (1 ocorrência, linha 877).

### 3. CSP e permissões de rede

O Tauri 2.x usa um sistema de capabilities. O `fetch()` cross-origin para
`script.google.com` precisa ser permitido na configuração de permissões.
O frontend não precisa de alteração — a configuração é no
`src-tauri/capabilities/default.json`.

### 4. Origem do localStorage

**Electron:** Usa `http://127.0.0.1:47821` como origem fixa.
**Tauri:** Usa `https://tauri.localhost` (ou `http://tauri.localhost` em
algumas versões). A origem é estável entre reinícios, então o
`localStorage` persiste normalmente. Porém, **dados salvos no Electron não
migrarão automaticamente** — o operador precisará importar novamente (via
CSV ou sincronização com GAS). Isso é aceitável porque o app já suporta
importação e sincronização.

### 5. Carregamento do sql.js WASM

O `database.js` usa `locateFile: file => './vendor/${file}'` para carregar
o WASM. No Tauri, os assets são servidos via `tauri://localhost/vendor/`.
O caminho relativo `./vendor/` funciona corretamente porque o Tauri mantém
a estrutura de diretórios dos assets. Não é necessária alteração.

## O que NÃO muda

- Todos os arquivos HTML, CSS e JS do frontend
- `database.js` — sql.js WASM + localStorage funciona idêntico
- `google-sync.js` — fetch para GAS funciona (desde que o CSP permita)
- `vendor/` — bibliotecas web puras
- Fluxo de importação de CSV/XLSX
- Geração de PDF com jsPDF
- Sincronização com Google Sheets/Drive
- Tema dark/light
- Navegação entre páginas

## Segurança

O Tauri 2.x usa um modelo de permissões baseado em capabilities (tudo
desabilitado por padrão, opt-in explícito). Isso é mais seguro que o
modelo do Electron onde o desenvolvedor precisa endurecer o renderer
manualmente. Permissões necessárias:

- `core:default` — janela, navegação
- `shell:allow-open` — abrir URLs externas (WhatsApp)
- `core:event:default` — comunicação frontend/backend (se necessário)

## Fora de escopo

- Atualização automática — redistribuição continua manual (novo instalador)
- Assinatura de código — SmartScreen continua avisando
- Empacotamento para macOS/Linux — só Windows
- Migração de dados do localStorage do Electron para o Tauri
- Mudanças no backend GAS (`gas/`)
- Ícone personalizado — usa placeholder, trocável depois
