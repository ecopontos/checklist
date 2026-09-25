# Implementação do ADR-0001 — indicadores do dashboard

> Execução nesta sessão com `superpowers:executing-plans` e testes antes das alterações de comportamento.

**Objetivo:** aplicar as definições, os períodos comparáveis e os avisos de qualidade do ADR-0001.

**Referência:** [ADR-0001](../../adr/0001-indicadores-dashboard-periodos-e-qualidade-dados.md).

**Arquitetura:** um módulo puro `dashboard-metrics.js` recebe registros, fonte, mês e instante de referência. A interface consome os mesmos resultados para todos os indicadores. O GAS informa os registros excluídos sem alterar os históricos.

**Tecnologias:** JavaScript ES modules, SQLite/sql.js, Google Apps Script e testes Node/VM já usados pelo projeto.

## Restrições

- Fuso operacional `America/Sao_Paulo`; datas de evento são datas civis.
- Preservar alterações anteriores do workspace e não migrar lançamentos.
- Não introduzir metas, projeções, status de execução ou conversões de unidade presumidos.
- Totais parciais identificados; comparações suspensas quando a base é local ou inconsistente.
- Implementar e validar localmente; publicação do GAS e novo instalador são etapas separadas.

## Etapas

### 1. Cálculo compartilhado

- [x] Criar `tests/dashboard-metrics.test.cjs`: testar 17/09, 31/03, 01/10, ano bissexto, virada de ano, fuso, contagens, taxas, deduplicação, lacunas e dados inválidos.
- [x] Executar `node --experimental-vm-modules tests/dashboard-metrics.test.cjs` e verificar as falhas.
- [x] Criar `dashboard-metrics.js` com `operationalToday(now)`, `buildDashboardMetrics({remote, local, remoteQuality, now, month})` e `scheduleWindow(rows, now)`.
- [x] Verificar que os resultados expõem período, totais, comparação, série mensal, ranking, categorias e avisos, sem depender do DOM.

### 2. Qualidade do histórico GAS

- [x] Estender `tests/gas-dashboard.test.cjs` com datas impossíveis, quantidades inválidas, zero legítimo, resposta vazia e cache de metadados.
- [x] Atualizar `getHistoricoColetas_` em `gas/Code.gs`: retornar `quality` com `invalidDates`, `invalidQuantities` e `excludedRecords`; invalidar o formato antigo do cache.
- [x] Validar os testes do GAS e manter o contrato `ok`/`data` compatível.

### 3. Integração e apresentação

- [x] Alterar `dashboard.js` para consumir o módulo e os metadados; preservar o fluxo de atualização e envio das pendências.
- [x] Alterar `dashboard.html`: seleção de mês, datas de corte, contagens distintas, séries contínuas, cores neutras e detalhes técnicos agrupados.
- [x] Atualizar `tests/dashboard-sync.test.cjs` e cobrir período histórico, fallback parcial, qualidade e agenda em São Paulo.
- [x] Incluir a nova suíte no comando `npm test`.

### 4. Verificação e documentação

- [x] Executar `npm test`, verificar sintaxe/imports e preparar `dist` após conferir o destino do build.
- [x] Revisar os 12 critérios de aceitação do ADR e corrigir lacunas encontradas.
- [x] Atualizar o status e as referências do ADR, índice e documentação do GAS com o estado real da implementação.

## Evidências de validação — 2026-09-18

- `npm test`: todos os 17 scripts passaram; as quatro suítes de dashboard e
  sincronização incluem 33 cenários automatizados.
- `node --check dashboard.js` e `node --check dashboard-metrics.js`: passaram.
- `npm run prepare-dist`: executado após conferir que `dist` é um diretório
  dentro do workspace, sem link/junção.
- Grafo real de imports de `dist/dashboard.js`: quatro módulos vinculados
  com sucesso; os arquivos distribuídos conferem com os fontes.
- HTML: aninhamento validado e 43 identificadores sem repetição.
- Os 12 critérios do ADR foram confrontados com os testes de cálculo,
  integração e GAS. Não houve validação visual em navegador/app instalado.
- Publicação do GAS e geração/distribuição de novo instalador pendentes.
