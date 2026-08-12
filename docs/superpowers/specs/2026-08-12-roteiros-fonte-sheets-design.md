# Roteiros direto do Google Sheets (substituir o CSV do Access)

**Data:** 2026-08-12
**Status:** Implementado (cliente + GAS), verificado em unidade — pendente de deploy do GAS e validação no app real
**Escopo desta entrega:** somente leitura (import). Escrita de volta ao Sheets fica para etapas futuras.

## Contexto

Hoje os roteiros/clientes entram no app assim:

```
Access → cstExportaCheckList.csv (Google Drive)
      → GAS doGet (ramo padrão lê o arquivo CSV)
      → CSV (com detecção de UTF-16/BOM)
      → checkAndImportRoteiros → importRoteirosCsv → SQLite (sql.js em localStorage)
```

O Access está sendo **aposentado**. Os dados-mestre foram carregados para o Google Sheets
(planilha `Clientes.xlsx`, hoje online) para permitir edição de usuários e roteiros. A partir de
agora o **Google Sheets é a fonte de verdade**, com o SQLite local servindo como cache/persistência
offline.

Os dados no Sheets estão **normalizados** em abas separadas, diferente do CSV achatado que o app
consome. Decisão do dono: **manter o formato achatado no fluxo do app** — a normalização é resolvida
ao reconstruir a visão achatada a partir das abas.

Abas relevantes:

- `tblRoteiros` (999 linhas) — `idRoteiro`, `Roteiro`, `Situação`, `Periodicidade`, `Turno`, …
- `tblRotas` (2.022 linhas) — a sequência: `idRota`, `Ordem`, `Inativo`, `idPJ`, `idRoteiro`, `idUnico`
- `shtClientes` (5.548 linhas) — o cliente: `Cliente`, `Número`, `CEP`, `Telefone1`, `Telefone2`, `idPJ`, `idUnico2`, …

## Objetivo

Remover o `cstExportaCheckList.csv` do fluxo de importação e, no lugar, montar o **mesmo formato
achatado** a partir das abas do Sheets (dirigido pela `tblRotas`), sem mudar como o app consome os
dados. O app continua com cache local e com a otimização de "só reimporta quando muda".

### Não-objetivos (etapas futuras)

- Escrita de volta ao Sheets (reordenar, ativar/inativar, editar endereço/telefone).
- Criação de cliente/ponto novo (o "módulo solto" na edição de roteiro).
- WhatsApp puxando contatos sincronizados.
- Edição dos campos do próprio roteiro (`tblRoteiros`).

## Abordagem escolhida

**Achatar no GAS e devolver o formato achatado pronto (JSON).** O GAS lê as 3 abas, junta em
memória e devolve as linhas achatadas com as mesmas colunas que o app já consome. O app troca a
origem (deixa de baixar o CSV e passa a chamar `action=roteiros`), reaproveitando a mesma lógica de
upsert. Some toda a detecção de UTF-16/BOM.

Alternativas descartadas:

- **App baixa abas cruas e junta no cliente** — move o join e o tratamento de tipos para o cliente;
  mais código novo e mais risco no lado que hoje só sabe consumir achatado.
- **Gerar o CSV a partir do Sheets num gatilho agendado** — mantém o arquivo CSV no fluxo,
  exatamente o que queremos remover.

## Fluxo novo

```
Google Sheets (tblRotas ⨝ shtClientes[idPJ] ⨝ tblRoteiros[idRoteiro])
   → GAS action=roteiros  (junta + achata + formata em memória)
   → JSON { ok, rows[], modifiedTime, count }
   → checkAndImportRoteiros  (compara modifiedTime; retry/timeout já existentes)
   → db.importRoteirosRows(rows)  → SQLite (cache local)
```

## Reconstrução da visão achatada (join validado)

O join foi validado no DuckDB contra a planilha real: dos 2.022 pontos, **2 sem cliente** e
**0 sem roteiro**.

```
tblRotas r
  LEFT JOIN shtClientes c  ON r.idPJ = c.idPJ
  LEFT JOIN tblRoteiros t  ON r.idRoteiro = t.idRoteiro
```

### Contrato de colunas

| Coluna achatada (app consome) | Origem                         | Observação de formato |
|-------------------------------|--------------------------------|-----------------------|
| `Roteiro`                     | `tblRoteiros.Roteiro` via `idRoteiro` | texto |
| `Cliente`                     | `shtClientes.Cliente` via `idPJ`      | texto |
| `idRota`                      | `tblRotas.idRota`              | inteiro sem `.0` |
| `Ordem`                       | `tblRotas.Ordem`              | numérico como hoje |
| `Número`                      | `shtClientes.Número`         | tira `.0` artificial |
| `CEP`                         | `shtClientes.CEP`             | tira `.0` artificial |
| `Inativo`                     | `tblRotas.Inativo`            | `0`/`1` |
| `Telefone1`, `Telefone2`      | `shtClientes`                 | carregados mas **não usados** nesta etapa |

Não há coluna de logradouro nos dados; o import atual já trata `Logradouro`/`Rua` como opcional
(default `''`), então nada muda.

### Semântica preservada (idêntica ao import de CSV atual)

- Linhas com `Ordem == 0`/vazia são descartadas pelo filtro existente (`comOrdemValida`).
- Dedup por `Roteiro‖Cliente`, último vence.
- `ativo = Inativo != 1` (pontos inativos são importados, marcados `ativo=0`).
- Os 2 pontos sem cliente são **pulados no GAS** (sem `Cliente`, o app já os descartaria); o GAS
  conta e reporta quantos pulou.

## Componentes

### GAS (`gas/Code.gs`)

- Nova função `getRoteirosFlat_()` exposta em `action=roteiros`, que também passa a ser o **GET
  padrão** (sem `action`).
- **Remove** o ramo padrão que lia `CSV_FILE_NAME` do Drive e as funções de decode/detecção de
  encoding que ficarem órfãs (`decodeCsvBlob_`, `detectCsvEncoding_`) — confirmar no plano que não
  são usadas por outro caminho antes de remover.
- Constantes novas: `TBL_ROTAS = 'tblRotas'`, `TBL_CLIENTES = 'shtClientes'`,
  `TBL_ROTEIROS = 'tblRoteiros'`.
- Usa o `SPREADSHEET_ID` **já configurado** (mesma planilha das coletas). Nenhum secret novo.
- Lógica de junção isolada numa função pura testável
  `buildFlatRoteiros_(rotasValues, clientesValues, roteirosValues)` que recebe as matrizes de
  `getValues()` e devolve as linhas achatadas — assim a regra de join fica testável fora do Apps
  Script.
- `modifiedTime` = `getLastUpdated()` da planilha (via `DriveApp.getFileById(SPREADSHEET_ID)`).
  Isso muda a cada edição de qualquer aba; como o reimport é idempotente (upsert), reimportar a mais
  é barato e seguro. Hash de conteúdo fica como otimização futura, se necessário.
- Resposta: `{ ok:true, rows:[…], modifiedTime:<ISO>, count:<n>, skipped:<n> }`.
- Erros: `SPREADSHEET_ID` ausente ou aba não encontrada → `{ ok:false, error }` nomeando o que
  faltou.
- `apiVersion` sobe **3 → 4**; `REQUIRED_GAS_API_VERSION` no cliente sobe para `4` para detectar um
  deploy antigo ainda servindo CSV.

### Cliente — `google-sync.js`

- `checkAndImportRoteiros(db)` passa a chamar `${url}?action=roteiros`, mantendo o laço de retry
  inline já existente (3 tentativas com backoff — cobre o 404 transitório do redirecionamento de
  conteúdo do Google, que também vale para a resposta de roteiros).
- **Aceita os dois formatos** (compatibilidade de transição): se a resposta traz `data.rows`
  (array) → `db.importRoteirosRows(data.rows)` (GAS novo, abas do Sheets); senão →
  `db.importRoteirosCsv(data.content || '')` (GAS antigo, ainda servindo CSV). Ver
  "Estratégia de transição".
- Compara `data.modifiedTime` com `app3_last_drive_sync` para manter "só reimporta quando muda". A
  chave é **reaproveitada** (a semântica muda de "CSV do Drive" para "planilha"; sem migração).
- Guarda de vazio e de erro mantidas: em `{ok:false}`/rede caída ou resultado vazio, **preserva o
  cache local**.
- `REQUIRED_GAS_API_VERSION` sobe para `4` — usado **apenas** como rótulo de aviso no `admin.html`
  (`apiVersion < REQUIRED` mostra "atualização necessária"); **não bloqueia** o import.

### Cliente — `database.js`

- Extrai o miolo pós-parse de `importRoteirosCsv` para novo método
  **`importRoteirosRows(rows)`**, que recebe um array de objetos achatados (chaveados por nome de
  coluna) e faz filtro + dedup + upsert.
- `importRoteirosCsv(csvText)` passa a: `Papa.parse` → `importRoteirosRows(parsed)`. O botão manual
  "Importar CSV" em `roteiros.html` continua funcionando sem mudança.
- Sem mudança de schema SQLite.

## Estratégia de transição (rollout sem quebra)

Esta é uma mudança de protocolo: o GAS deixa de devolver `{ content: <csv> }` e passa a devolver
`{ rows: [...] }`. Como há **apps em uso em várias máquinas** e o GAS é uma **implantação única**
(uma URL que serve todos ao mesmo tempo), qualquer ordem ingênua abre uma janela de quebra.

**Decisão: app primeiro, com cliente tolerante aos dois formatos; GAS por último.**

1. Chamar `?action=roteiros` funciona **nas duas versões** do GAS: no GAS antigo essa action não é
   reconhecida e cai no ramo padrão, que devolve o CSV (`content`); no GAS novo devolve `rows`.
2. O cliente aceita `rows` (novo) **ou** `content` (fallback antigo). Assim o app novo funciona
   contra o GAS antigo **e** contra o novo.
3. Ordem de implantação:
   1. Distribuir o **app novo** para todas as máquinas — cada uma segue importando contra o GAS
      ainda antigo, via `content`.
   2. Só então **reimplantar o GAS** — todos os apps já entendem `rows` e viram a chave sozinhos,
      sem janela de quebra.
4. O aviso de versão no `admin.html` é **não bloqueante** (só rótulo), então um app novo contra um
   GAS antigo apenas exibe "atualização v4 necessária" e continua importando normalmente.
5. **Limpeza futura:** quando não houver mais app antigo em uso, remover o fallback de `content` do
   cliente e o suporte a resposta CSV (nada mais depende dele).

## Tratamento de erros / offline

- GAS indisponível, `{ok:false}` ou rede caída → mantém o cache local; a UI mostra o erro como hoje.
- Resposta vazia (`rows` vazio) → não apaga os dados locais; retorna `updated:false` com aviso
  (espelha o comportamento atual quando `roteiros===0 && clientes===0`).
- Deploy antigo do GAS (ainda servindo CSV / `apiVersion < 4`) → detectado pelo status; instrução ao
  usuário de reimplantar o GAS (o app já tem o mecanismo de aviso de implantação obsoleta).

## Testes / verificação

- **Paridade de dados:** comparar contagem de pontos e uma amostra de roteiros entre o import antigo
  (CSV) e o novo (Sheets). Join já validado no DuckDB (2.022 pontos; 2 sem cliente; 0 sem roteiro).
- **`importRoteirosRows`:** para uma mesma entrada (linhas equivalentes ao CSV), produz o mesmo
  estado de banco que `importRoteirosCsv` (mesma contagem de roteiros/clientes, mesma ordenação).
- **`buildFlatRoteiros_`:** testes de unidade da regra de join/formatN (tira `.0`, `Inativo` 0/1,
  pula ponto sem cliente).
- **Ponta a ponta:** apontar o app para a planilha real, abrir a Gestão de Roteiros e conferir que os
  roteiros carregam com a mesma aparência/ordenação de antes (usar a skill de verificação).

## Riscos

- **`getLastUpdated()` da planilha muda por qualquer aba** → reimports a mais (aceitável: upsert
  idempotente e barato). Mitigação futura: hash de conteúdo.
- **Formatação numérica** (`.0`, CEP, `Número`) precisa espelhar exatamente o que o CSV entregava,
  senão o `_normalizeNumero` do app pode divergir — coberto pelos testes de paridade.
- **Volume no Apps Script** (ler 3 abas, ~2 mil linhas de saída) — dentro dos limites; `getValues`
  em bloco por aba.
