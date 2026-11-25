# Novas inclusões nos roteiros

Data: 2026-11-25
Status: proposta para aprovação; abordagem escolhida pelo usuário.

## Objetivo e rotina confirmada

O operador digita o relatório da viagem anterior e gera o PDF que a equipe imprime para o motorista. Novos clientes também entram nessa lista. O motorista precisa perceber os novos pontos na folha que leva em viagem.

O usuário confirmou que o atendimento de um ponto é identificado por pelo menos um contentor coletado ou por uma intercorrência anotada. Escolheu encerrar automaticamente o destaque a partir desse retorno, sem confirmação manual adicional.

## Abordagens consideradas

- Prazo fixo: simples, mas pode retirar o destaque antes da visita.
- Confirmação manual: explícita, mas acrescenta trabalho ao operador.
- Relatório de retorno (escolhida): aproveita a digitação existente; depende do registro do retorno.

## Comportamento proposto

1. Uma inclusão passa a ter um marco persistente associado ao ponto e ao roteiro. Um cliente já existente também pode ser novo em outro roteiro.
2. Enquanto não houver atendimento válido, o PDF mostra `NOVO` em negrito junto ao cliente e um resumo inicial com quantidade, nomes e posições dos novos pontos. O ponto permanece na sequência normal de atendimento. O destaque deve funcionar em preto e branco e em documentos com várias páginas.
3. Atendimento válido é um registro salvo com quantidade maior que zero ou intercorrência não vazia, referente ao ponto e ao roteiro da inclusão. A data da viagem deve ser igual ou posterior ao dia da inclusão; salvar hoje um relatório anterior não encerra o destaque.
4. Como os relatórios usam datas sem horário, aceitar atendimento no mesmo dia da inclusão é uma decisão proposta. O histórico de outro vínculo/roteiro não encerra a novidade atual.
5. Digitar sem salvar, abrir o roteiro, gerar, baixar, enviar ou imprimir o PDF não encerra o destaque. Regerar antes do retorno mantém a indicação. PDFs já produzidos permanecem como estavam; PDFs gerados após o retorno válido refletem o atendimento.
6. Quantidade zero sem intercorrência mantém o destaque. Uma intercorrência basta mesmo sem coleta, conforme orientação do usuário.
7. O retorno salvo localmente pode atualizar o próximo PDF daquele aparelho, seguindo o fluxo offline existente. Após sincronização, os demais aparelhos devem chegar ao mesmo resultado.

## Implantação e limites propostos

- A base existente na ativação será o ponto de partida: não marcar todos os clientes antigos como novos por ausência de histórico local. A primeira carga em outro aparelho também não constitui inclusão.
- Registrar inclusões futuras tanto pelo aplicativo quanto pela fonte compartilhada de cadastro. Repetir uma importação ou sincronização não deve recriar a novidade.
- Alterar nome, endereço ou ordem não constitui nova inclusão. Reativar o mesmo vínculo também não constitui nova inclusão nesta versão. Uma transferência cria uma novidade no destino, inclusive se o código permitir alterar o roteiro do mesmo ponto.
- A informação precisa sobreviver a reinícios e ser compartilhada entre aparelhos; não pode depender apenas de memória, cache do navegador ou nome do cliente.
- Sem notificações externas, prazo de expiração ou botão adicional de ciência nesta versão.
- Se a consulta remota falhar, ausência de resposta não comprova atendimento: conservar o estado conhecido e apresentar a situação de sincronização existente.

## Integração técnica a detalhar no plano

O projeto tem caminhos de impressão em `coleta-checklist.html`, `coleta-operation.js` e `imprimir.html`. O plano deve identificar os caminhos ativos e aplicar a mesma regra nos documentos operacionais. Quantidades anteriores e data da última coleta, isoladamente, não substituem a evidência de atendimento da inclusão.

`database.js` guarda pontos, coletas, datas e contexto do roteiro; o cadastro e os retornos também passam pela integração com Google Sheets/GAS. O plano definirá o registro compartilhado do marco de inclusão e a consulta de atendimento, com identidade estável e compatibilidade com a base existente. Não reutilizar `editado_em` como data de inclusão, pois edições comuns também alteram esse campo.

As escolhas de campos, migração, contratos de sincronização e organização do código ficam para o planejamento técnico, respeitando as regras acima. Nenhum deploy remoto faz parte da aprovação deste desenho.

## Verificação prevista

Validar inclusão sem retorno; coleta positiva; intercorrência sem coleta; zero sem intercorrência; entrada não salva; relatório retroativo; atendimento no mesmo dia; transferência com histórico anterior; reimpressão; reinício; sincronização repetida; primeiro uso em outro aparelho; base antiga; indisponibilidade remota. Conferir visualmente a legibilidade do PDF em preto e branco, a sequência dos pontos e a paginação.
