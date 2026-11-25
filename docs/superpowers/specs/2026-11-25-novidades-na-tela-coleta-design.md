# Destaque de novos pontos na tela de coleta

Data: 2026-11-25
Status: aprovado pelo usuário em 2026-11-25; implementação pendente.

## Contexto

A feature de novas inclusões ([2026-11-25-novas-inclusoes-roteiros-design.md](2026-11-25-novas-inclusoes-roteiros-design.md)) já destaca os pontos novos no **PDF** (`coleta-operation.js`) e na **tela de impressão** (`imprimir.html`): um marcador `NOVO` ao lado do cliente e um resumo "ATENÇÃO: X novos pontos neste roteiro" no topo.

A lacuna confirmada pelo usuário: na **tela interativa de coleta** (`coleta-checklist.html` / `coleta-operation.js`, função `renderList`) não há nenhuma indicação. A equipe só percebe os novos pontos ao gerar o papel. É uma lacuna de apresentação — os dados já chegam à tela, pois `syncNovidadesRoteiro` roda ao abrir o roteiro e `listarNovidades` já é consumido pelo caminho do PDF.

## Objetivo

Levar à tela de coleta o mesmo destaque que já existe no papel, com paridade total: tela e documento impresso mostram sempre o mesmo conjunto de pontos novos.

## Abordagem escolhida

Paridade com o papel. Reaproveitar `listarNovidades(db, roteiroId, clientes)` — a mesma chamada do PDF (`coleta-operation.js:734`) — para que o conjunto exibido na tela seja idêntico ao do documento, sem fonte de verdade paralela.

Abordagens descartadas:
- Apenas o aviso no topo (diz quantos, não quais na linha — fica aquém do papel).
- Aviso + filtro "Novos" (acionável em roteiros longos, mas adiciona escopo não pedido nesta versão).

## Comportamento proposto

1. No início de `renderList()`, calcular o conjunto de novos: `novosIds = new Set(listarNovidades(db, routeSelect.value, currentClients).map(n => n.id_rota))`.
2. **Badge na linha:** na coluna Cliente, quando `novosIds.has(String(client.id_rota))`, exibir um chip `NOVO` antes do nome, em cor de destaque. Na tela pode usar cor; o papel permanece P&B, de forma independente.
3. **Aviso no topo:** dentro da `table-toolbar` da lista, exibir "ATENÇÃO: X novos pontos neste roteiro" (mesmo texto de `tituloNovidades()`), escondido quando a contagem é 0.
4. O ponto novo permanece na sequência normal de atendimento; o badge apenas marca, não reordena nem filtra.
5. O destaque some somente quando `getNovidadesRoteiro` deixa de listar o ponto (coleta válida ou intercorrência salva e sincronizada). Como `listarNovidades` lê do estado salvo no banco, digitar quantidade ou intercorrência na sessão **sem salvar NÃO remove o badge imediatamente** — consistente com a regra "digitar sem salvar não encerra o destaque" do spec original e com o comportamento do papel. O badge se atualiza no próximo `renderList` após salvar.
6. `renderList` é reexecutado em troca de filtro, ordenação e commit; recalcular `novosIds` a cada render mantém a tela fresca. A consulta é local/em memória, de custo desprezível.

## Limites

- Sem lógica nova de ciclo de vida: a decisão de o que é "novo" continua inteiramente em `getNovidadesRoteiro`/`listarNovidades`.
- Sem alterações em banco, contratos de GAS ou sincronização.
- Sem filtro "Novos" nesta versão (fica como evolução possível).
- Sem reordenação da lista.

## Integração técnica

- `coleta-operation.js`: `renderList()` passa a calcular `novosIds` e a renderizar o badge na célula do cliente e o aviso na `table-toolbar`. `listarNovidades` já está importado no arquivo.
- `coleta-checklist.html`: CSS do chip `NOVO` e do aviso, alinhado ao estilo dos `status-badge` existentes.
- Pré-cache (`sw.js`): nenhum arquivo novo; `roteiro-novidades.js` já está listado.

## Verificação prevista

- `renderList` marca com `NOVO` exatamente os pontos retornados por `listarNovidades`, e nenhum outro.
- O aviso mostra a contagem correta e fica oculto quando é 0.
- Digitar quantidade/intercorrência sem salvar mantém o badge (paridade com o papel).
- Após salvar um atendimento válido e re-renderizar, o ponto perde o badge.
- Conferir o padrão de teste atual de `renderList` (jsdom ou helper puro) antes de escolher o formato do teste no plano.
