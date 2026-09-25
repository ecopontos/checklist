# ADR-0001 — Semântica, períodos e qualidade dos dados dos indicadores do dashboard

- **Data:** 2026-09-17
- **Status:** Implementado localmente; publicação pendente.
- **Escopo:** dashboard do aplicativo Checklist standalone.
- **Origem:** revisão dos indicadores após a correção da sincronização e a geração da versão 1.6.1.
- **Implementação:** regras aplicadas em 2026-09-18; a implantação do GAS e a distribuição de um novo instalador permanecem pendentes.

## Contexto

O dashboard já consulta o histórico consolidado do Google Sheets, acrescenta
pendências locais e elimina repetições pelo identificador de sincronização.
Quando a consulta remota falha, utiliza o banco local e informa essa condição.

A correção da origem dos dados não resolve, sozinha, a interpretação dos
indicadores. A revisão identificou os seguintes problemas:

1. “Coletas este mês” conta lançamentos, inclusive ocorrências sem retirada.
2. O percentual mensal compara um mês em andamento com o mês anterior inteiro.
   Assim, uma indicação como “−42%” pode decorrer apenas de períodos diferentes.
3. O cartão de intercorrências usa o mês atual; o ranking de roteiros e a lista
   de intercorrências por tipo usam todo o histórico.
4. O gráfico e a tabela misturam meses encerrados com o mês em andamento.
   Meses sem registros desaparecem da sequência.
5. As cores associam aumento de volume a melhora e taxas acima de 5% ou 10% a
   problemas, sem metas operacionais definidas que sustentem esses julgamentos.
6. Cadastro atual, atividade registrada, programação futura e estado da
   sincronização aparecem sem uma separação suficientemente clara.
7. Uma consulta remota bem-sucedida não comprova que todos os dispositivos
   enviaram seus registros nem que um período está operacionalmente encerrado.

Precisamos de definições compartilhadas entre os cartões, gráficos, tabelas e
comparações, evitando que cada apresentação adote uma regra diferente.

## Decisão

### 1. Centralizar as regras dos indicadores

O dashboard terá uma camada de cálculo compartilhada para seleção de período,
deduplicação, contagem, agregação e comparação. A renderização consumirá esses
resultados, sem reproduzir regras diferentes em cada cartão ou gráfico.

Os cálculos deverão informar, além do valor, o intervalo utilizado, a fonte e
as limitações conhecidas. Datas de referência serão fornecidas aos cálculos de
forma explícita, permitindo testar viradas de mês, ano e fuso horário.

Esta decisão não exige trocar SQLite, Google Sheets ou o mecanismo de sync.

### 2. Definir a unidade de cada indicador

| Conceito | Definição |
| --- | --- |
| Atendimento registrado | Um lançamento de coleta válido, após deduplicação. Pode conter retirada, intercorrência ou ambos. Não comprova visita quando o registro não a documenta. |
| Coleta com retirada | Atendimento registrado cuja quantidade é maior que zero. Conta um evento, independentemente da quantidade recolhida. |
| Recipientes recolhidos | Soma das quantidades dos atendimentos do período, na unidade efetivamente registrada pelo app. |
| Atendimento com intercorrência | Atendimento com ocorrência informada, excluídos vazio e o valor equivalente a “Nenhuma”. Pode também ter retirada. |
| Ponto ativo no roteiro | Vínculo ativo identificado por `id_rota` no cadastro local. Não equivale necessariamente a um cliente único. |
| Roteiro com pontos ativos | Roteiro com pelo menos um ponto ativo no cadastro local. |
| Agendamento | Registro de programação com data prevista. Não comprova execução nem representa automaticamente uma pendência operacional. |

Um lançamento com cinco recipientes representa um atendimento, uma coleta com
retirada e cinco recipientes. Um lançamento com quantidade zero e ocorrência
representa um atendimento com intercorrência, sem coleta com retirada.

“Coletas este mês” será substituído por um rótulo explícito, “Coletas com
retirada neste mês”. “Atendimentos registrados” ficará disponível como medida
distinta e será a base da taxa de intercorrências. A mesma definição de coleta
será utilizada no ranking e no resumo mensal.

A nomenclatura “Bombonas” somente será mantida se essa for a unidade de todos
os registros agregados. Não converter quantidades em peso ou volume, nem somar
unidades diferentes como se fossem uma única medida.

### 3. Utilizar períodos de calendário explícitos

O período padrão dos resultados operacionais será o mês civil atual, do dia 1
até hoje. “Mês” não significa uma janela móvel dos últimos trinta dias.

- O fuso operacional de referência será `America/Sao_Paulo`.
- A data do evento define o período; a data de sincronização não altera sua classificação.
- Datas civis `YYYY-MM-DD` serão tratadas como datas, sem conversão implícita para meia-noite UTC.
- Lançamentos datados após hoje não entrarão nos resultados realizados.
- O período escolhido será aplicado aos cartões de atividade, ao ranking e à lista de intercorrências.
- Cadastro atual, agenda futura e série histórica terão intervalos próprios, explicitamente identificados.

O total do mês incluirá os registros disponíveis de hoje e será identificado
como parcial. Para evitar comparar um dia ainda em andamento com um dia
inteiro, a variação utilizará apenas dias de calendário encerrados.

Para a comparação do mês atual, definir:

```text
dias_comparáveis = mínimo(dia de hoje − 1, quantidade de dias do mês anterior)

período atual de comparação: dia 1 até dias_comparáveis do mês atual
período anterior:           dia 1 até dias_comparáveis do mês anterior
```

O cartão deve expor as datas da comparação, pois seu total inclui hoje, mas a
variação tem um corte anterior. Não apresentar somente “vs mês anterior”.

| Situação | Total exibido | Comparação |
| --- | --- | --- |
| 17/09/2026 | 01–17/09, parcial | 01–16/09 × 01–16/08 |
| 31/03/2026 | 01–31/03, parcial | 01–28/03 × 01–28/02 |
| 01/10/2026 | Registros de 01/10, parcial | “Sem dias encerrados para comparação” |
| Setembro selecionado em outubro | Setembro inteiro | Setembro inteiro × agosto inteiro; ambos encerrados no calendário |

Ao selecionar meses passados, a comparação poderá usar os dois meses completos,
com datas visíveis. Isso compara totais mensais e não produtividade diária:
meses de durações diferentes, dias úteis e feriados continuam influenciando os
resultados. Nenhuma projeção de fechamento será apresentada como resultado real.

### 4. Padronizar variações, taxas e cores

Para contagens ou quantidades comparáveis:

```text
variação percentual = ((valor atual − valor anterior) / valor anterior) × 100
```

- Arredondar somente na apresentação; usar uma casa decimal nas variações.
- Base anterior zero: mostrar “Sem base de comparação”, nunca infinito ou crescimento de 100% por convenção.
- Base anterior positiva e valor atual zero, com dados comparáveis: mostrar −100%.
- Ausência de dados ou base sabidamente parcial: não apresentar variação de desempenho.

Para intercorrências:

```text
taxa = atendimentos com intercorrência / atendimentos registrados × 100
```

Exibir numerador e denominador, por exemplo: “8 de 100 atendimentos — 8,0%”.
Comparar taxas pela diferença em pontos percentuais: de 10% para 8% corresponde
a −2,0 p.p. Com denominador zero, mostrar “Sem atendimentos no período”.

Remover as faixas arbitrárias de 5% e 10% como julgamento de desempenho. Volume
maior ou menor terá apresentação neutra. Cores de alerta continuam apropriadas
para erro, pendência e dados incompletos; cores associadas a metas dependerão de
critérios operacionais formalizados posteriormente.

### 5. Aplicar as regras a cada apresentação

| Apresentação | Comportamento definido |
| --- | --- |
| Pontos ativos nos roteiros | Mostrar quantidade atual e data de atualização do cadastro; não atribuir esse retrato a meses passados. |
| Roteiros com pontos ativos | Contar somente roteiros que possuam vínculos ativos. Não confundir com roteiros executados. |
| Coletas com retirada no período | Contar atendimentos com quantidade maior que zero; comparar pelos intervalos definidos neste ADR. |
| Atendimentos com intercorrência | Mostrar contagem, denominador, taxa e diferença em pontos percentuais quando comparável. |
| Evolução mensal de recipientes | Exibir seis meses consecutivos, identificar o mês atual como parcial e manter meses sem registros na sequência. |
| Roteiros com maior quantidade coletada | Aplicar o período escolhido; mostrar recipientes, coletas com retirada e média de recipientes por coleta com retirada. Não nomear como ranking de eficiência. |
| Intercorrências por tipo | Aplicar o mesmo período do cartão; normalizar categorias conhecidas, mostrar quantidade e participação. Incluir “Outros tipos” se houver limite visual. |
| Agendamentos de hoje | Contar registros previstos para hoje. Não inferir conclusão ou atraso. |
| Agendamentos dos próximos sete dias | Incluir hoje e os seis dias seguintes; informar que o total de hoje já está incluído. |
| Resumo por mês | Exibir doze meses consecutivos com atendimentos, coletas com retirada, recipientes, atendimentos com intercorrência e taxa. Identificar meses parciais. |
| Atualização dos dados | Reunir conexão, última consulta bem-sucedida, origem do cadastro, pendências de envio e erros. Versão da API ficará em detalhes técnicos. |

Datas de atualização do CSV representam a geração do cadastro pelo Access; a
última consulta do histórico representa uma leitura pelo app. Nenhuma delas
comprova que todas as coletas até aquele instante foram registradas.

Ausência de registros em um mês será apresentada como “Sem registros na base
consultada”. Só tratar essa ausência como zero operacional confirmado quando
houver evidência de cobertura do período. Não interpretar lacunas como ausência
de operação automaticamente.

Categorias de intercorrência serão normalizadas por códigos ou mapeamentos
explícitos. Preservar o texto original; não juntar descrições distintas por
semelhança presumida. Se houver múltiplas ocorrências em um atendimento, a taxa
contará esse atendimento uma vez, e a distribuição por tipo explicitará sua base.

### 6. Tornar a abrangência dos dados parte do resultado

O histórico remoto e as pendências locais continuarão sendo conciliados pelo
`syncId`, preservando a prioridade do registro remoto em caso de repetição do
mesmo identificador. Registros sem identificador estável não serão deduplicados
por nome, data e quantidade, pois dois atendimentos legítimos podem coincidir.

O painel distinguirá:

- **Base consolidada consultada:** consulta remota válida, acrescida das pendências deste dispositivo.
- **Visão local parcial:** consulta remota indisponível; resultados restritos ao banco local.
- **Dados com inconsistências:** datas inválidas, futuras ou quantidades incompatíveis detectadas na base recebida.

Na visão local parcial, os totais poderão ser exibidos com esse aviso, mas as
variações de desempenho ficarão indisponíveis. Registros inválidos serão
contabilizados em um aviso de qualidade e excluídos dos cálculos afetados de
forma consistente. Não substituir um erro de consulta por zero.

“Consolidado” significa a base disponível no servidor, não garantia de cobertura
total. Pendências de outros dispositivos não são conhecidas por este app.
As comparações permitidas serão descritas como comparações dos registros
disponíveis; não presumir fechamento operacional ou cumprimento de metas.

## Alternativas consideradas

| Alternativa | Avaliação |
| --- | --- |
| Manter mês parcial contra mês anterior completo | Rejeitada: produz diferenças influenciadas pela duração dos períodos sem informar isso. |
| Usar últimos trinta dias contra trinta dias anteriores | Não adotada como padrão: muda o significado de “mês” e dificulta conciliação com relatórios mensais. Pode ser um filtro futuro, com outro rótulo. |
| Comparar até hoje nos dois meses | Possível, mas compara o dia atual incompleto com um dia anterior completo. A proposta prefere dias encerrados e explicita os intervalos. |
| Projetar o fechamento do mês por média diária | Não adotada nesta etapa: exigiria hipóteses sobre calendário e distribuição das coletas; projeção não é resultado realizado. |
| Comparar por dias úteis ou por execução planejada | Adiada: o app não dispõe de calendário operacional nem planejamento versionado suficiente para uma medida confiável. |

## Consequências

- Os valores de “coletas” poderão diminuir em relação à versão 1.6.1, porque
  ocorrências sem retirada passarão a integrar atendimentos, não coletas com retirada.
- Ranking, cartões e distribuição de intercorrências terão período e definições coerentes.
- Um total mensal poderá incluir dias que não entram no cálculo da variação;
  os intervalos visíveis são obrigatórios para explicar essa diferença.
- A interface precisará mostrar ausência de base e dados parciais, em vez de
  sempre produzir um percentual ou uma classificação por cor.
- O cálculo compartilhado reduz divergências entre componentes e permite testes por data de referência.
- Não há migração de históricos prevista: muda a interpretação, preservando os lançamentos originais.
- Normalização de datas, identificação de registros excluídos e configuração de
  fuso deverão ser verificadas também no GAS. Se o backend descartar registros
  silenciosamente, deverá fornecer metadados suficientes para o aviso de qualidade.
- Calendário encerrado não significa dados completos ou imutáveis: importações
  e sincronizações tardias podem corrigir meses anteriores.

## Fora do escopo

Não calcular, sem novos dados de suporte:

- cumprimento de roteiro ou cobertura dos pontos previstos;
- produtividade por equipe, veículo, hora ou distância;
- agendamentos atrasados ou concluídos sem vínculo com execução;
- clientes únicos atendidos a partir apenas do nome do cliente;
- peso, volume físico ou eficiência a partir de contagens de recipientes.

## Critérios de aceitação para a implementação

1. Um atendimento com quantidade zero e ocorrência não aumenta coletas com retirada, mas entra na base de atendimentos e intercorrências.
2. Um atendimento com quantidade cinco e ocorrência aumenta as quatro medidas correspondentes, sem duplicar o atendimento.
3. Os cenários de 17/09, 31/03 e 01/10 da tabela de períodos produzem exatamente os cortes documentados.
4. Virada de ano, fevereiro bissexto e execução após 21h no Brasil não deslocam a data civil.
5. Base anterior zero e ausência de dias encerrados não produzem percentual enganoso.
6. A comparação de taxas distingue percentual relativo de pontos percentuais.
7. Ranking e intercorrências por tipo respeitam o mesmo período dos cartões de atividade.
8. Séries mensais preservam meses sem registros e identificam meses parciais.
9. Falha remota mantém o aviso de visão local e suspende variações de desempenho, sem converter erro em zero.
10. Reenvio do mesmo `syncId` não altera os totais; registros distintos não são fundidos por coincidência de campos.
11. Agendamentos de hoje integram os próximos sete dias sem serem apresentados como execução confirmada.
12. Quantidades inválidas, datas futuras e registros descartados não passam despercebidos nem contaminam cálculos relacionados.

## Implementação e validação local

As regras estão centralizadas em `dashboard-metrics.js`, consumidas por
`dashboard.js` e apresentadas em `dashboard.html`. O seletor de mês aplica o
mesmo período aos cartões de atividade, ranking e tipos de intercorrência.

O GAS API 9 acrescenta `quality` ao histórico: `invalidDates`,
`invalidQuantities` e `excludedRecords`. A contagem cobre toda a aba lida,
inclusive quando há filtro de mês; uma linha com dois problemas é excluída
uma única vez. Datas futuras são identificadas pelo dashboard. Sem os
metadados de qualidade, o histórico ainda pode ser exibido, mas a comparação
fica suspensa e o painel informa que o GAS precisa ser atualizado.

A suíte `npm test` inclui testes de cálculo puro, integração da interface,
qualidade do histórico GAS e reenvio idempotente. Ela cobre os critérios
acima com datas de referência controladas. A verificação local não comprova
publicação, cobertura de todos os dispositivos ou validação visual no app.

O instalador 1.6.1 gerado antes desta implementação não contém estas regras.
Para disponibilizá-las, publicar o GAS atualizado e gerar/distribuir um novo
instalador incluindo os três arquivos do dashboard.

## Referências

- [Regras compartilhadas dos indicadores](../../dashboard-metrics.js).
- [Cálculo e atualização do dashboard](../../dashboard.js).
- [Apresentação do dashboard](../../dashboard.html).
- [Registro das operações de coleta](../../coleta-operation.js).
- [Banco local e identidade dos lançamentos](../../database.js).
- [Cliente de sincronização](../../google-sync.js).
- [Backend GAS](../../gas/Code.gs).
- [Contrato e funcionamento do histórico consolidado](../../gas/README.md#reenvio-de-coletas-e-histórico-do-dashboard).
