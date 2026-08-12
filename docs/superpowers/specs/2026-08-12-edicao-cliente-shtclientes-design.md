# Escrita de volta: edição de cliente existente em shtClientes (Subprojeto B)

**Data:** 2026-08-12
**Status:** Aprovado — pronto para plano de implementação
**Epic:** Escrita de volta ao Sheets. Subprojeto **B** de quatro:
A (reorg/status ✅) → **B (edição de cliente · este)** → C (criação de cliente) → D (criação de roteiro).

## Contexto

Com o Access aposentado e o Sheets como fonte de verdade, editar os dados de um cliente
(nome, endereço, telefone) precisa **gravar de volta** na aba `shtClientes`. Hoje o modal de edição
só permite mudar o nome, e essa mudança **fica apenas local** (o `queueRoteiroChange` só enfileira
`ordem`/`inativo`, que é o subprojeto A). Endereço e telefone nem aparecem no modal.

### Identidade do cliente: UUID, não idPJ

Decisão importante (confirmada com o dono): a chave do cliente é o **UUID `idUnico2`**, não o `idPJ`.
Motivos, confirmados nos dados reais:

- `idPJ` é um auto-incremento **legado do Access**, que **não será mais incrementado**.
- `idPJ` já é **incompleto**: dos 5.548 clientes em `shtClientes`, só **3.298 (59%)** têm `idPJ`.
- `idUnico2` (UUID v7) está em **100% das linhas, todos únicos** — chave completa, durável e
  **mintável** para clientes novos (subprojeto C).

O UUID é **chave interna**: nunca é exibido. O app mostra o **nome** do cliente; o UUID só viaja
escondido (na row achatada e no outbox) para o GAS localizar a linha da `shtClientes`. A "feiura" do
UUID não aparece para o usuário.

### Um cliente aparece em vários roteiros

Uma linha em `shtClientes` = um cliente. Ele pode estar em vários roteiros (várias linhas em
`tblRotas` apontando o mesmo cliente). Portanto **editar o cliente reflete em toda a cadeia** onde
ele aparece — comportamento desejado e inerente ao dado.

## Objetivo

Permitir editar, no app, os dados do cliente e **gravá-los em `shtClientes`** (por UUID), com escrita
**apenas dos campos alterados** (sem clobber de edições manuais concorrentes).

**Campos editáveis (conjunto completo):** `Cliente` (nome), `Número`, `Complemento`, `CEP`,
`Telefone1`, `Telefone2`.

### Não-objetivos

- Criar cliente novo (C) e criar roteiro (D). O "+ Novo Ponto" segue local por ora.
- Editar `Ordem`/`Inativo` do ponto — isso é o subprojeto A (já entregue).
- Editar campos administrativos (`catCliente`, `idClienteTipo`, `Inativo` de cliente, etc.).

## Abordagem: escrita só dos campos alterados

Ao salvar, comparar cada campo com o valor carregado e enviar ao GAS **apenas os que mudaram**; o GAS
grava só essas células em `shtClientes`. Não sobrescreve campos que alguém tenha alterado online
(a planilha é editável por humanos) — mesma filosofia da escrita direcionada do subprojeto A.

Alternativa descartada — gravar o registro inteiro: mais simples, mas clobbera campos concorrentes.

## Componentes

### 1. Leitura — `getRoteirosFlat_` / `buildFlatRoteiros_` (GAS)

As rows achatadas passam a emitir também:

- **`idCliente`** = `idUnico2` (UUID), resolvido via o join por `idPJ` já existente.
- **`Complemento`** (de `shtClientes`).

(`Cliente`, `Número`, `CEP`, `Telefone1`, `Telefone2` já são emitidos.) Campos extras na row são
**backward-compatible**: apps antigos usam `_getCsvVal` por nome e ignoram chaves que não conhecem.

### 2. Schema local — `database.js`

Adicionar à tabela `clientes`: `id_cliente` (TEXT, UUID), `complemento` (TEXT), `telefone1` (TEXT),
`telefone2` (TEXT). Migração idempotente com `ALTER TABLE ... ADD COLUMN` protegida (verifica via
`PRAGMA table_info` ou try/catch) para não quebrar bancos locais já existentes.

Na migração que adiciona `id_cliente`, **zerar `app3_last_drive_sync`** uma vez, para forçar um
reimport e popular os campos novos a partir das rows achatadas.

`importRoteirosRows` passa a gravar `id_cliente`, `complemento`, `telefone1`, `telefone2` no upsert.

### 3. UI de edição — `roteiros.html`

Expandir o modal com **Número, Complemento, CEP, Telefone1, Telefone2** (o nome já existe),
agrupados sob o rótulo **"Dados do cliente (valem para todos os roteiros)"**, separados de
`Ordem`/`Status` (do ponto/roteiro). Ao salvar:

1. Comparar os campos do cliente com os valores carregados; montar o conjunto **alterado**.
2. Atualizar **todas as linhas locais** com o mesmo `id_cliente` (consistência imediata na UI).
3. Se houve mudança de campo de cliente, enfileirar no `cliente_change_outbox` e sincronizar.
4. Mudanças de `Ordem`/`Status` seguem pelo caminho do subprojeto A (inalterado).

Se o ponto não tiver `id_cliente` (ex.: ponto criado só localmente, ou app ainda sem reimport),
a edição de campos de cliente é salva localmente e a UI avisa que a sincronização virá quando o
cliente existir na planilha.

### 4. Outbox + sync — `database.js` + `google-sync.js`

Nova tabela **`cliente_change_outbox`**: `change_id` (PK), `id_cliente` (UUID), `campos` (JSON só com
os campos alterados: `{ Cliente?, Número?, Complemento?, CEP?, Telefone1?, Telefone2? }`),
`alterado_em`, `origem`, `sent_at`. Espelha o padrão do outbox de roteiros.

Novo **`syncPendingClienteChanges(db)`** em `google-sync.js`, espelhando `syncPendingRoteiroChanges`:
lotes, idempotência por `change_id`, confirmação por `acceptedIds`/`duplicateIds`, autenticação pelo
mesmo `ROUTE_CHANGES_TOKEN`.

### 5. GAS — nova ação `clientChanges`

POST autenticado (mesmo token). No `LockService`:

1. Dedup por `change_id` contra um log de auditoria **`AlteracoesClientes`** (idempotência +
   confirmação), espelhando `AlteracoesRoteiros`.
2. Abre `shtClientes`, resolve os índices das colunas (`idUnico2`, `Cliente`, `Número`,
   `Complemento`, `CEP`, `Telefone1`, `Telefone2`); coluna ausente → erro nomeando-a.
3. Lê a coluna `idUnico2` e mapeia `UUID → linha`.
4. Função pura **`planClienteWrites_(uuidRowMap, changes)`** → lista de escritas
   `[{ row, campos }]` + `skipped` (UUID sem linha). Testável fora do Apps Script.
5. Escreve **só as células dos campos enviados** de cada linha (direcionada). `Número`/`CEP` como
   texto (mantendo o tratamento de `.0`); telefones como texto.
6. UUID ausente → aceita o `change_id` (não trava o outbox), conta em `skippedApply`.

`GAS_API_VERSION` sobe **5 → 6** (rastreabilidade; não muda contrato — cliente exige ≥ 4).

## Rollout — GAS-first (seguro)

1. As mudanças do GAS são **backward-compatible**: campos extras nas rows (apps antigos ignoram) e a
   ação `clientChanges` (só apps novos chamam). Deploy do GAS primeiro, na mesma implantação/URL.
2. Distribuir o app novo depois — aí ele encontra `idCliente` nas rows e a ação `clientChanges`
   prontos. A migração do schema local dispara um reimport para popular os campos.

Não há janela de quebra: apps antigos continuam funcionando (não editam cliente); apps novos ganham
a capacidade quando atualizam.

## Tratamento de erros / offline

- GAS indisponível / `{ok:false}` / rede caída → a alteração fica no `cliente_change_outbox`
  (reenvio depois); a edição local persiste.
- UUID não encontrado em `shtClientes` → aceito (não trava o outbox), contado em `skippedApply`,
  registrado no log com mensagem.
- Coluna ausente em `shtClientes` → `{ok:false, error}` nomeando a coluna; o app mantém o outbox.
- Após aplicar, o `getLastUpdated` muda → o próximo reimport converge o cache com o que foi gravado.

## Testes / verificação

- **`planClienteWrites_` (pura):** casa por UUID contra a `shtClientes` real; grava só os campos
  enviados; UUID ausente vira skip. Testável em node (como `buildFlatRoteiros_`/`planRotaWrites_`).
- **Sync de cliente:** teste espelhando `gas-route-queue` — envia alterações de cliente, confirma
  aplicação em `shtClientes` simulada (só campos enviados) e `skippedApply` para UUID ausente.
- **Migração:** adicionar colunas em banco local pré-existente não perde dados; reimport popula os
  campos novos.
- **`npm test`** verde; verificação ponta a ponta no app (editar telefone/endereço → sincronizar →
  conferir a célula em `shtClientes` e o reflexo em outro roteiro do mesmo cliente).

## Riscos

- **Edição manual concorrente** no mesmo campo entre leitura e escrita: a escrita só-dos-alterados
  reduz a superfície, mas última escrita vence no campo. Aceitável.
- **`idCliente` ausente em pontos locais** (criados só no app): edição de cliente fica local até o
  ponto existir na planilha (subprojeto C). UI avisa.
- **Migração de schema** em bancos antigos: usar `ADD COLUMN` idempotente e testar com banco
  pré-existente.
- **Reimport forçado** ao migrar: reprocessa o dataset uma vez (upsert idempotente, barato).
