# Contrato GAS de roteiros/clientes para `desktop/logistics` — Design

**Data:** 2026-09-15
**Status:** Design aprovado — pronto para virar plano de implementação.
**Repositório desta spec:** `checklist` (onde vive o GAS). O consumidor (`ecoforms/desktop/logistics`)
é tratado em spec própria.

## Contexto

Decisão de rumo (ver `ecoforms/docs/2026-09-01-levantamento-migracao-checklist-standalone.md` e a memória
`project-logistics-data-source-and-identity`): a fonte operacional de roteiro/cliente para o
`desktop/logistics` será o **GAS, no trânsito dos demais dados do ecoforms** — não o Postgres `geo_fpolis`
nem o CSV do Access. Esta spec define **o contrato de dados desse endpoint GAS**: o shape que o
`desktop/logistics` vai consumir para popular seu SQLite local.

O `gas/Code.gs` já tem um `doGet` com `action=roteiros` que devolve uma visão **achatada** montada das abas
do Sheets (`buildFlatRoteiros_`). Esta spec **substitui** esse builder por um **normalizado**.

### Premissa assumida

O `desktop/logistics` está **em desenvolvimento, não em produção**, portanto **não há requisito de
compatibilidade retroativa**. O standalone em campo puxa roteiro do **CSV da pasta de rede**
(`checkAndImportRoteirosRede`), **não** do GAS `action=roteiros`; logo, substituir o builder desse action
não afeta o app em campo. Se essa premissa for falsa, esta spec precisa ser revista.

## Decisões de design

| Questão | Decisão |
|---|---|
| Fonte | GAS, `action=roteiros` (builder substituído, sem action nova) |
| Identidade de cliente | `idUnico` (legado) como chave de junção v1; `uuid` (UUIDv7) reservado/`null` |
| Origem do UUIDv7 | Cunhado depois, na migração ADR-091; **fora** do escopo desta spec |
| Formato | Normalizado: `clientes[]` + `roteiros[]` com `pontos[]` |
| Sync | Snapshot completo + `modifiedTime`; reconciliação por substituição no desktop |
| Compatibilidade | Nenhuma — builder flat é substituído, não mantido em paralelo |
| Tipo de Resíduo | **Fora** do contrato GAS; não trafega no snapshot de roteiros. O standalone atual resolve seu uso no WhatsApp em `config.js`; a fonte do futuro consumidor pertence à spec dele. |

## Contrato: `action=roteiros` v1

### Envelope

```jsonc
GET {GAS_WEB_APP_URL}/exec?action=roteiros
→ {
    "ok": true,
    "apiVersion": <int>,                // GAS_API_VERSION, incrementado nesta entrega
    "contract": "roteiros/v1",          // versão explícita do shape
    "modifiedTime": "2026-09-15T12:34:56.000Z", // getLastUpdated() da planilha
    "counts": { "clientes": 1689, "roteiros": 19, "pontos": 1674 },
    "skipped": 0,                       // pontos sem cliente correspondente (descartados)
    "clientes": [ /* §clientes[] */ ],
    "roteiros": [ /* §roteiros[] */ ]
  }
```

Em erro, mantém o padrão atual do GAS: `{ "ok": false, "error": "<mensagem>" }`.

### `clientes[]` — deduplicado por `idUnico`

```jsonc
{
  "idUnico": "…",     // chave de junção v1 (= shtClientes.idUnico2, legado). Obrigatório.
  "uuid": null,       // RESERVADO p/ UUIDv7 (ADR-091). Sempre null na v1.
  "cliente": "CEPON", // nome
  "logradouro": "Rodovia Admar Gonzaga", // ver "Dependências abertas" — pode sair "" na v1
  "numero": "655",    // limpo do "655,00"/".0" via cleanIntString_
  "cep": "88034001",  // limpo via cleanIntString_
  "complemento": "",
  "telefone1": "",    // limpo do artefato ",00" via formatPhone_
  "telefone2": ""
}
```

- **Chaves ascii minúsculas** (não `Número`/`Telefone1` como no builder flat) — evita a chave acentuada
  em JSON/Rust no consumidor.
- Um cliente aparece **uma vez**, mesmo que atendido por vários pontos/roteiros.
- Reaproveita os helpers existentes `cleanIntString_` e `formatPhone_`.

### `roteiros[]` com `pontos[]`

```jsonc
{
  "roteiro": "SAT01",  // nome do roteiro
  "pontos": [
    { "idRota": "3", "idUnico": "…", "ordem": 1, "inativo": 0 }
  ]
}
```

> **Tipo de Resíduo não faz parte deste contrato.** O `config.js` citado neste
> repositório atende somente ao standalone atual. Esta spec não determina como o
> futuro `desktop/logistics` obterá o resíduo.

- `idRota` = id da linha em `tblRotas` (id do **ponto**, não do cliente); string, limpo de `.0`.
- `idUnico` no ponto é **FK** para `clientes[].idUnico`.
- `ordem` = número (inteiro), convertido de `"1,00"`; `0` quando ausente/inválido.
- `inativo` = `0|1`, derivado como no builder atual (aceita `true`/`1`/`"true"`).

## Semântica de snapshot e deleção

O snapshot é a **verdade completa** a cada chamada. Como o volume é pequeno (~1,7 mil pontos), o consumidor
`desktop/logistics` **reconcilia por substituição**: registra o `modifiedTime`, e só reprocessa se ele
mudou; ao reprocessar, o que **não veio** no snapshot é considerado removido (deleção implícita, sem
tombstones). `inativo:1` significa presente-mas-inativo (distinto de removido). Sem estado de cursor.

## Dependências abertas (confirmar na implementação; não bloqueiam o design)

1. **`logradouro` em `shtClientes`:** o builder flat atual **não emite** `logradouro`; o levantamento
   suspeita que ele viva só no Access (`tblCEP`), não replicado ao Sheets. Se a coluna não existir em
   `shtClientes`, `logradouro` sai `""` na v1 até ser replicado — não é regressão frente ao que o GAS
   emite hoje (nada).
2. **`idUnico2` preenchido:** pontos cujo cliente não tem `idUnico2` caem em `skipped` (mesmo
   comportamento do builder atual, que descarta ponto sem cliente).

## Escopo

**Dentro:**
- Substituir `buildFlatRoteiros_` por um builder normalizado (`clientes[]` + `roteiros[]`/`pontos[]`).
- Ajustar `getRoteirosFlat_`/`doGet` para o novo envelope e `apiVersion`.
- Testes unitários do builder puro (recebe as matrizes das abas, devolve o shape normalizado), cobrindo:
  dedup de cliente, junção ponto→cliente, `skipped`, limpeza de número/telefone, `inativo`, `uuid:null`.
- Este documento de contrato como referência para o consumidor.

**Fora (YAGNI / outras specs):**
- Delta incremental, tombstones, cursor.
- Minting de UUIDv7 (é da ADR-091).
- **Tipo de Resíduo** — não trafega no snapshot; sua fonte no futuro consumidor
  será definida na spec de ingestão desse projeto.
- Ingestão/reconciliação no `desktop/logistics` (spec própria do consumidor).
- Push/escrita (coletas, edição) — segue como está.
- Qualquer camada de back-compat ou action duplicada.

## Critérios de sucesso

- `GET ?action=roteiros` devolve o envelope v1 com `clientes[]` normalizado e `roteiros[]`/`pontos[]`
  bem-formados a partir das abas reais do Sheets.
- Cada cliente aparece uma vez; todo `ponto.idUnico` resolve para um item de `clientes[]`.
- `numero`/`cep`/`telefone*`/`idRota` sem artefatos `,00`/`.0`; `ordem` numérico.
- `uuid` sempre `null`; `contract` = `"roteiros/v1"`.
- `counts` e `skipped` consistentes com o conteúdo.
- Testes do builder puro passam.
