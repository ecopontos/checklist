# Ponto de retorno: estado pré-PWA

Registro do estado do app **antes** da migração para PWA, para permitir
voltar com segurança caso a migração dê problema.

| Item | Valor |
|---|---|
| Versão | `1.6.6` |
| Commit de referência | `43a7348eac69809d792933eb8d2c4436dabab397` (`main`) |
| Mensagem do commit | `chore(release): bump versao para 1.6.6` |
| Data do registro | 2026-10-02 |
| Tag sugerida | `pre-pwa` (anotada, apontando para o commit acima) |

## Como estava o app neste ponto

- App desktop empacotado com **Tauri 2.x** (WebView2 no Windows); o mesmo
  HTML/JS também roda no navegador.
- Banco **sql.js (SQLite em WASM)** persistido inteiro no `localStorage`
  (chave `app3_db`, como array JSON de bytes — limite prático ~1,5–2 MB).
- Sem `manifest.webmanifest`, sem service worker, sem ícones PWA.
- Layout pensado para desktop (`coleta-desktop.css`), poucas media queries.
- Pontos de integração com Tauri (ambos com fallback para navegador):
  - `save_checklist_pdf` — `coleta-operation.js`, `agendamentos.html`
  - `plugin:shell|open` para WhatsApp — `whatsapp-events.js`
- Sincronização via Google Apps Script (`gas/`, `google-sync.js`).

## Como voltar para este estado

Ver o código exatamente como estava:

```bash
git checkout 43a7348eac69809d792933eb8d2c4436dabab397
```

Criar um branch a partir dele:

```bash
git checkout -b restaura-pre-pwa 43a7348eac69809d792933eb8d2c4436dabab397
```

Criar a tag (caso ainda não exista no GitHub):

```bash
git tag -a pre-pwa 43a7348eac69809d792933eb8d2c4436dabab397 -m "Estado pre-PWA (v1.6.6)"
git push origin pre-pwa
```

> **Dados dos usuários:** a migração planejada move o banco de
> `localStorage` (`app3_db`) para IndexedDB. Antes de reverter o código em
> máquinas que já rodaram a versão PWA, faça o backup manual do banco SQLite
> pela tela Admin, pois a versão pré-PWA só lê a chave `app3_db` do
> `localStorage`.
