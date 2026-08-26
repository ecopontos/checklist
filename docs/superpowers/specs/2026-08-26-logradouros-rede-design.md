# Import automático do CSV de logradouros a partir de pasta de rede

**Data:** 2026-08-26
**Status:** Proposto — aguardando plano de implementação
**Escopo desta entrega:** ler automaticamente o `cstExportaCheckList.csv` de uma pasta de rede fixa
e aplicar o mesmo backfill de logradouro que hoje só roda via upload manual. Não muda o formato do
CSV nem a lógica de casamento/persistência (`database.js`), só a origem do texto do arquivo.

## Contexto

O backfill de logradouro (`db.importLogradourosCsv`, ver
[2026-08-12-roteiros-fonte-sheets-design.md](2026-08-12-roteiros-fonte-sheets-design.md) para o
histórico de por que ele existe separado do fluxo principal de roteiros) hoje só roda quando alguém
abre o Admin e faz upload manual do `cstExportaCheckList.csv` pelo seletor de arquivo do navegador.
Isso depende de um humano lembrar de fazer isso toda vez que o Access gera um novo export — na
prática, o dado fica velho ou nunca é importado.

O arquivo é gerado pelo Access numa pasta de rede fixa, acessível de todas as máquinas que rodam o
app:

```
\\192.168.12.1\Dados\SMMADS\Super. de Resíduos Sólidos\Ger. de Op. de Coleta\DVCOS\ColetaFlexDados\Check-list\Check list\app\cstExportaCheckList.csv
```

Dois bugs de perda de dados nesse backfill foram corrigidos nesta mesma sessão (não documentados em
spec por serem bugfixes pontuais, ver commits correspondentes em `database.js`):

1. `upsertCliente` sobrescrevia `logradouro` com vazio a cada resync de roteiros do Sheets (Sheets
   nunca traz essa coluna).
2. Se o backfill rodasse antes do cliente existir localmente (rota nova), o dado era descartado sem
   ficar disponível para quando o cliente fosse criado depois.

Essas correções tornam o backfill seguro para rodar repetidamente e fora de ordem — pré-requisito
para automatizá-lo.

## Objetivo

Ao abrir o app, checar automaticamente se há uma versão nova do `cstExportaCheckList.csv` na pasta
de rede e, se houver, importar sem intervenção do usuário — mesmo padrão de "sync silenciosa em
background" que `checkAndImportRoteiros` já faz para roteiros/clientes vindos do Google Sheets.

### Não-objetivos

- Tornar o caminho da pasta configurável pela UI (é fixo, igual em todas as máquinas).
- Mudar o formato do CSV ou a lógica de casamento por `id_rota` em `database.js`.
- Remover o upload manual do CSV no Admin (continua existindo como alternativa).
- Notificar visivelmente o usuário sobre sucesso/falha da checagem (mesmo padrão silencioso do sync
  de roteiros).

## Abordagem escolhida

**Novo comando Rust customizado + reaproveitar `db.importLogradourosCsv` existente.** O app já tem
um precedente: `save_checklist_pdf` em `src-tauri/src/lib.rs` grava arquivos direto no disco via
`std::fs`, chamado do JS por `window.__TAURI__.core.invoke(...)`. Vamos espelhar esse padrão para
leitura: um comando `read_network_logradouros_csv` que lê os bytes e a data de modificação do
arquivo na pasta de rede, sem precisar tocar no sistema de `capabilities` do Tauri (comandos
customizados rodam com acesso total ao filesystem — as `capabilities` só restringem os plugins
oficiais do Tauri, que não estamos usando aqui).

Alternativas descartadas:

- **Plugin oficial `tauri-plugin-fs`** — adiciona uma dependência nova e um sistema de permissões
  (`capabilities`) só para um caminho fixo e único; um comando customizado de ~15 linhas resolve com
  menos superfície nova.
- **Rodar a checagem via GAS** (o app baixaria o CSV do Drive via HTTP, como faz hoje com roteiros)
  — exigiria alguém subir o CSV pro Drive periodicamente, e o arquivo já existe pronto numa pasta de
  rede acessível; adicionar Drive no meio é um passo a mais sem necessidade.

## Fluxo novo

```
Access → cstExportaCheckList.csv (pasta de rede fixa)
       → read_network_logradouros_csv (comando Rust, invoke)
       → checkAndImportLogradourosRede (google-sync.js)
            compara modified_time com app3_last_logradouros_sync
            decodifica BOM/UTF-16LE (helper compartilhado)
       → db.importLogradourosCsv (já existente, já corrigido)
       → SQLite (sql.js em localStorage)
```

Disparado a partir de `index.html`, logo após a chamada existente a `checkAndImportRoteiros(db)`,
mesmo estilo fire-and-forget.

## Componentes

**1. Rust — `src-tauri/src/lib.rs`: comando `read_network_logradouros_csv`**

- Caminho hardcoded (constante no arquivo): o UNC path listado acima.
- Lê os bytes do arquivo (`std::fs::read`) e o timestamp de modificação (`std::fs::metadata(...).modified()`).
- Retorno em sucesso: `{ bytes_base64: String, modified_time: String (RFC3339) }`.
- Retorno em falha: `Err(String)` com mensagem legível (pasta inacessível, arquivo não encontrado,
  erro de permissão) — mesmo padrão de erro do `save_checklist_pdf`.
- Registrado em `invoke_handler![save_checklist_pdf, read_network_logradouros_csv]`.

**2. JS — `google-sync.js`: função `checkAndImportLogradourosRede(db)`**

- Se `window.__TAURI__?.core?.invoke` não existir (ex: rodando em navegador puro fora do app
  empacotado), retorna `{ checked: false, reason: 'not-tauri' }` sem erro — mesmo guard já usado em
  `coleta-operation.js` para `save_checklist_pdf`.
- Chama `invoke('read_network_logradouros_csv')`.
- Compara `modified_time` com `localStorage['app3_last_logradouros_sync']`; se não for mais recente,
  retorna `{ checked: true, updated: false }` sem reimportar.
- Decodifica `bytes_base64` → `Uint8Array` → texto, usando a mesma detecção de BOM/UTF-16LE/UTF-8
  que hoje está inline em `admin.html` (`handleLogradourosFile`) — vou extrair esse trecho para uma
  função exportada compartilhada (`decodeLegacyCsvBytes` ou nome similar) usada pelos dois lugares,
  evitando duplicar a lógica de encoding.
- Chama `db.importLogradourosCsv(texto)`.
- Em sucesso, grava o novo `modified_time` em `localStorage['app3_last_logradouros_sync']` e retorna
  `{ checked: true, updated: true, ...resultado }`.
- Qualquer exceção (rede fora do ar, etc.) é capturada pelo `.catch` de quem chama — sem alterar o
  fluxo do app.

**3. `index.html`**

- Import de `checkAndImportLogradourosRede` ao lado de `checkAndImportRoteiros`.
- Chamada logo após a existente: `checkAndImportLogradourosRede(db).then(...).catch(e =>
  console.error(...))`.

**4. `admin.html`**

- Sem mudanças — upload manual continua funcionando exatamente como hoje, como alternativa quando a
  pasta de rede estiver inacessível.

## Tratamento de erros

Falha silenciosa em qualquer ponto (pasta inacessível, arquivo ausente, erro de parsing): loga no
console (`console.error`), não interrompe o carregamento do app, não mostra alerta ao usuário. Nova
tentativa acontece automaticamente na próxima vez que o app for aberto — mesmo comportamento já
existente para o sync de roteiros via `checkAndImportRoteiros`.

## Testes

- **Unidade (Node, como os testes existentes em `tests/`):** `checkAndImportLogradourosRede` testável
  simulando `window.__TAURI__.core.invoke` com um stub — cobre a lógica de comparação de
  `modified_time` (importa só quando muda) e o encaminhamento correto para `db.importLogradourosCsv`.
- **Helper de decodificação compartilhado:** teste unitário direto (BOM UTF-16LE/BE, UTF-8 sem BOM),
  reaproveitando o CSV real em `legado/cstExportaCheckList.csv` como fixture, igual ao já feito em
  `tests/import-logradouros.test.cjs`.
- **Comando Rust:** não há harness de teste Rust no projeto hoje; verificação manual, rodando o app
  de verdade apontado para o caminho de rede real, checando que os campos `logradouro` aparecem no
  checklist sem exigir upload manual.
