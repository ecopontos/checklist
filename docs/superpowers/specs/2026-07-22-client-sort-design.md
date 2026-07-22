# Ordenação de Clientes no Checklist de Coleta — Design

**Goal:** Dar ao operador, na tela `coleta-checklist.html`, uma opção para escolher como a lista de clientes do roteiro selecionado é exibida: por número de ordem do roteiro (atual/padrão), alfabeticamente pelo nome do cliente, ou pela quantidade de recipientes (bombonas/contentores) já digitada nesta sessão.

**Escopo:** Apenas `coleta-checklist.html` (tela de operação de coleta em campo). Não afeta `roteiros.html`, `imprimir.html` ou qualquer outra tela.

## Arquitetura

A ordenação é aplicada **somente no momento de renderizar** (`renderList`), sobre uma cópia do array `currentClients` — `currentClients` em si nunca é reordenado. Isso preserva a ordem original para tudo que depende dela fora da renderização da lista: a geração do PDF (`buildChecklistDoc`, que itera `currentClients` na ordem do roteiro) e qualquer outro consumidor futuro. A alternativa de reordenar `currentClients` diretamente foi descartada por exigir lembrar de restaurar a ordem antes de gerar o PDF — mais frágil, sem ganho.

## UI

Novo `<select id="sortSelect">` no `.controls` do cabeçalho, entre `#opDate` e `#btnChecklist`:

```html
<select id="sortSelect">
    <option value="ordem">Número de Ordem</option>
    <option value="alfabetica">Ordem Alfabética</option>
    <option value="quantidade">Qtd. Digitada</option>
</select>
```

Nenhum CSS novo é necessário — `select` já tem estilo global definido no arquivo.

## Comportamento de ordenação

Estado: nova variável de módulo `let currentSort = 'ordem';`.

Nova função `sortClients(list)`:
- `'ordem'` (padrão): ordena por `c.ordem` (numérico, ascendente) — equivalente ao comportamento atual (que já vem ordenado assim da query SQL; reordenar aqui é redundante mas inofensivo e deixa o código simétrico entre os 3 modos).
- `'alfabetica'`: ordena por `c.cliente` via `localeCompare(..., 'pt-BR')` (acentuação correta).
- `'quantidade'`: ordena por `sessionData[c.id_rota]?.qty || 0`, **decrescente** (maior quantidade primeiro). Pontos ainda não digitados (`qty` 0 ou ausente) ficam ao final. Empate de quantidade desempata por `c.ordem` ascendente (estabilidade visual, evita reordenação aparentemente aleatória entre itens com a mesma quantidade).

`renderList(filterId)`: quando `filterId` é `null` (lista completa), aplica `sortClients` antes do `.map()`. Quando `filterId` está presente (resultado da busca por ID), não ordena — é sempre um único item.

**Número exibido no card:** continua sendo `c.ordem` (o número real do roteiro), não a posição da linha na tela. Isso já é o comportamento atual (`c.ordem || i + 1`) e não muda — só deixamos de depender de `i` para exibir a posição, já que `i` agora reflete a ordem escolhida, não a posição no roteiro.

**Edge case aceito (não corrigido nesta feature):** se um cliente não tiver `ordem` definido (falsy — `null`/`0`), o fallback existente `i + 1` exibe a posição no array *já ordenado*, não a posição real no roteiro. Isso é um comportamento pré-existente (o fallback só age quando o dado de origem não tem `ordem`) e não piora com esta feature — é um caso de qualidade de dados, fora de escopo.

## Reset ao trocar de roteiro

`loadRoute()` reseta `currentSort = 'ordem'` e o valor do `<select id="sortSelect">` de volta para `'ordem'`, replicando o comportamento atual (sempre visualização por ordem de roteiro ao carregar um roteiro novo).

## Interação com fluxo de busca por ID

`#idSearch` continua idêntico — `focusItem(id)` filtra para um único card (`filterId` não passa por `sortClients`). O fluxo `finishEntry()` já chama `renderList()` (lista completa) após cada entrada via busca, então em modo "Qtd. Digitada" a lista reordena automaticamente a cada ponto resolvido por esse fluxo.

**Edição inline (sem busca):** editar a quantidade diretamente em um card da lista completa (`onchange` de `.qty-input`) chama apenas `updateEntry()`, que atualiza classes/estatísticas mas **não** re-renderiza/reordena a lista. Em modo "Qtd. Digitada", isso significa que a lista só reflete a nova ordem na próxima renderização completa (troca de roteiro, troca de opção no seletor, ou próxima entrada via busca). Decisão consciente: evita o card saltar de posição embaixo do cursor do operador logo após ele editar aquele mesmo card.

## Wiring

```js
document.getElementById('sortSelect').onchange = (e) => {
    currentSort = e.target.value;
    renderList();
};
```

Adicionado em `init()`, junto das demais atribuições de `onclick`/`onchange`.

## Fora de escopo

- Persistir a preferência de ordenação entre trocas de roteiro ou entre sessões (localStorage) — reseta sempre para "Número de Ordem".
- Refletir a ordenação escolhida na geração do PDF do checklist — o PDF continua na ordem do roteiro (`currentClients` original), independente do que está selecionado na tela.
- Reordenação ao vivo durante edição inline (ver "Edição inline" acima).
