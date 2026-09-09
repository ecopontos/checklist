# Disparo WhatsApp — tags {residuo} e {data} na mensagem

## Contexto

O filtro "Só com intercorrência" (`docs/superpowers/specs/2026-09-08-whatsapp-intercorrencias-design.md`) já busca a intercorrência e a data da última coleta de cada cliente do roteiro selecionado, via `getIntercorrenciasRoteiro` (GAS action `intercorrenciasRoteiro`). Hoje `buildMsg()` em `whatsapp-sender.html` só usa esse resultado pra substituir `{nome}` e `{intercorrencia}` — a data buscada fica sem uso.

O usuário quer uma mensagem no formato "Houve um problema na coleta de [tipo de resíduo] no dia [data] em [nome do cliente]. Problema encontrado: [intercorrência]". Faltam duas coisas: (1) uma tag pra data, cujo dado já existe mas não é usado; (2) uma tag pra tipo de resíduo, cujo dado **não existe em lugar nenhum da cadeia hoje** — o campo "Tipo de Resíduo" só aparece no modal de checklist de próxima coleta (`coleta-checklist.html`, usado pra gerar PDF), sem nenhuma ligação com a operação que grava intercorrência/quantidade (`saveOperation` → `pushColetas` → aba `Coletas`).

Investigação prévia confirmou que o pipeline atual (endpoint GAS, wrapper, toggle, filtro, substituição de `{nome}`/`{intercorrencia}`) funciona corretamente contra dados reais de produção — não há bug ali. O problema relatado era o usuário usar placeholders com colchetes (`[Intercorrência]`) que a regex de substituição (`{intercorrencia}`) não reconhece, mais a ausência da tag de resíduo.

Decisão de negócio (não uma escolha técnica): tipo de resíduo é fixo por roteiro (ex.: `SAT*`/`SOBI*` = Orgânicos, `SV*` = Vidro), não varia por operação/coleta individual.

## Objetivo

1. Adicionar tag `{data}` na mensagem (data da coleta com a intercorrência, formato `DD/MM/AAAA`).
2. Adicionar tag `{residuo}` (tipo de resíduo do roteiro do cliente), alimentada por um cadastro por roteiro que já vem sincronizado do Google Sheets pra todos os dispositivos.

## Design

### 1. Planilha — nova coluna em `tblRoteiros`

`tblRoteiros` já tem uma linha por roteiro (`idRoteiro`, `Roteiro`). Adicionar coluna `Tipo de Resíduo`, preenchida manualmente pelo usuário. Preenchimento inicial sugerido, a partir dos roteiros reais hoje:

- `SAT01`, `SAT02`, `SAT03`, `SAT04`, `SAT05`, `SatEpan`, `SOBI-C-01`, `SOBI-C-02`, `SOBI-C-03`, `ESCOLA-ORGANICO-1`, `ESCOLA-ORGANICO-2` → `Organicos`
- `SV01`...`SV08` → `Vidro`

Esta etapa é manual (edição direta na planilha pelo usuário) — não é algo que este repositório escreva ou automatize.

### 2. `gas/Code.gs`

Em `buildFlatRoteiros_`, o laço que monta `roteirosById` (linha ~190-196) passa a guardar um objeto em vez de só o nome:

```js
var roteirosById = {};
for (var t = 1; t < roteirosValues.length; t++) {
    var rowT = roteirosValues[t];
    var keyRoteiro = cleanIntString_(rowT[mapRoteiros['idRoteiro']]);
    if (!keyRoteiro) continue;
    roteirosById[keyRoteiro] = {
        nome: String(rowT[mapRoteiros['Roteiro']] || '').trim(),
        tipoResiduo: String(rowT[mapRoteiros['Tipo de Resíduo']] || '').trim()
    };
}
```

E onde `rows.push` monta cada linha achatada (linha ~210-211), troca a referência direta pelo objeto e inclui o novo campo:

```js
var roteiroInfo = roteirosById[cleanIntString_(rowR[mapRotas['idRoteiro']])] || { nome: '', tipoResiduo: '' };
rows.push({
    Roteiro: roteiroInfo.nome,
    TipoResiduo: roteiroInfo.tipoResiduo,
    idCliente: cliente.idCliente,
    ...
```

Se a coluna `Tipo de Resíduo` não existir ainda na aba (usuário não editou a planilha), `mapRoteiros['Tipo de Resíduo']` é `undefined` e `rowT[undefined]` é `undefined` — `tipoResiduo` cai pra string vazia, sem erro. Não precisa de validação de coluna ausente como em `getIntercorrenciasRoteiro_` (aqui é opcional, não uma feature que falha sem o dado).

`GAS_API_VERSION` sobe 7 → 8. Exige redeploy manual (etapa explícita do plano, não automatizável).

### 3. `database.js`

Migração idempotente (mesmo padrão de `migrateSchema()`, que hoje só cobre `clientes`): adicionar verificação e `ALTER TABLE roteiros ADD COLUMN tipo_residuo TEXT` quando a coluna não existir.

`addRoteiro` ganha um segundo parâmetro opcional e passa a fazer upsert (hoje é `INSERT OR IGNORE`, que nunca atualiza uma linha existente):

```js
addRoteiro(nome, tipoResiduo = '') {
    this.db.run(`
        INSERT INTO roteiros (nome, tipo_residuo) VALUES (?, ?)
        ON CONFLICT(nome) DO UPDATE SET tipo_residuo = excluded.tipo_residuo
    `, [nome, tipoResiduo]);
    this.save();
}
```

`getRoteiros()` inclui `tipo_residuo` no objeto retornado.

`importRoteirosRows` (usado tanto pelo import de CSV quanto pelo sync do Sheets) constrói o tipo de resíduo por roteiro a partir da primeira linha de cada nome único, antes do `uniqueRoteiros.forEach`:

```js
const tipoResiduoPorRoteiro = {};
data.forEach(row => {
    const nome = this._getCsvVal(row, 'Roteiro');
    if (nome && !(nome in tipoResiduoPorRoteiro)) {
        tipoResiduoPorRoteiro[nome] = this._getCsvVal(row, 'TipoResiduo') || '';
    }
});
uniqueRoteiros.forEach(name => this.addRoteiro(name, tipoResiduoPorRoteiro[name] || ''));
```

Import de CSV legado (sem a coluna `TipoResiduo`) continua funcionando — `_getCsvVal` retorna vazio, roteiro fica sem tipo de resíduo até o próximo sync do Sheets.

### 4. `whatsapp-sender.html`

`buildPendingContacts()` já resolve o roteiro por `db.getContatosWhatsapp(id)`, que internamente busca `this.getRoteiros().find(r => r.id === roteiroId)` (`database.js:212`) — só precisa passar `tipoResiduo` pro objeto de contato retornado (mesmo lugar onde `roteiroNome` já é setado, `database.js:227`).

`buildMsg` ganha as duas novas substituições:

```js
function formatDateBR(dateStr) {
  if (!dateStr) return '';
  const [ano, mes, dia] = dateStr.split('-');
  return `${dia}/${mes}/${ano}`;
}

function buildMsg(contact) {
  const nome = contact.nome || 'estabelecimento';
  const registro = intercorrenciasPorIdRota.get(contact.idRota) || {};
  const intercorrencia = registro.intercorrencia || '';
  const data = formatDateBR(registro.data || '');
  const residuo = contact.tipoResiduo || '';
  return message
    .replace(/\{nome\}/gi, nome)
    .replace(/\{intercorrencia\}/gi, intercorrencia)
    .replace(/\{data\}/gi, data)
    .replace(/\{residuo\}/gi, residuo);
}
```

Dica da mensagem (Passo 2) atualizada para citar as quatro tags: `{nome}`, `{intercorrencia}`, `{data}`, `{residuo}`.

## Fora de escopo

- Tela de edição do tipo de resíduo por roteiro no Admin — edição é direto na planilha por agora.
- Qualquer ligação com o campo "Tipo de Resíduo" do modal de checklist em `coleta-checklist.html` (continua isolado, só alimenta o PDF de próxima coleta).
- Retrofit de coletas antigas — o campo é por roteiro (cadastro), não por coleta individual, então não há dado histórico a migrar.
- Validação/aviso de coluna `Tipo de Resíduo` ausente na planilha — degrada silenciosamente pra tag vazia.
