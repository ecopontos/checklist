# Correções da digitação e sincronização do checklist

> Execução com `superpowers:subagent-driven-development` e testes de regressão
> antes das mudanças. Autorização: pedido para aplicar todas as correções da revisão.

**Objetivo:** resolver F01–F11 da [revisão](../../reviews/2026-09-18-checklist-digitacao-sync.md).

**Desenho:** a operação recebe identidade estável e é persistida de uma vez,
restaurando o banco em memória se o armazenamento falhar. Cada coleta guarda
nome/roteiro do registro; a migração congela o contexto local disponível dos
registros antigos, sem inventar contexto histórico ausente. Todos os callers
usam a fila compartilhada e só concluem envios confirmados. Datas seguem São
Paulo e quantidades exigem inteiro não negativo. PDF novo deve existir antes
de retirar o anterior; consultas usam contexto imutável por abertura do modal.

**Restrições:** preservar alterações existentes e históricos; sem deduplicação
por nome ou ponto/data; sem publicar GAS ou novo instalador nesta etapa.
As decisões adicionais da seção de limitações (estorno de operação já enviada,
fila durável de PDFs, desativação por ausência de CSV) não são parte de F01–F11.

## Tarefas

- [x] Persistência e identidade (F01, F04, F06): testes SQL.js com falha no
  armazenamento, retentativa, migração, contexto e importação por idRota;
  `database.js`, consumidores dos históricos locais e testes.
- [x] Digitação e PDF cliente (F02, F08, F09, F10): testes DOM/VM antes de
  alterações em `coleta-operation.js`; proteção do formulário ativo,
  números estritos, data civil, contexto de consulta e bloqueio de envio repetido.
- [x] GAS (F05, F08): testes de falha de criação/substituição do PDF e
  validação de lotes antes da gravação em `gas/Code.gs`.
- [x] Sync comum (F03, F07, F11): validação do lote, identidade legada
  persistida, serialização e reenvio em Início/Coleta/Análise; testes dos
  callers e recuperação em `google-sync.js` e módulo coordenador.
- [x] Integração: conectar salvamento atômico à tela, contexto histórico ao
  dashboard e relatórios; rodar testes e corrigir regressões.
- [x] Revisão independente; atualizar relatório e documentação; `npm test`,
  sintaxe, preparação do frontend e verificação de imports/arquivos distribuídos.

## Evidências de conclusão

- `npm test`: 22 scripts concluídos com sucesso, incluindo as regressões de
  persistência, fila compartilhada, digitação, importação histórica, GAS e
  dashboard.
- `node --check`: módulos alterados de banco, sync, operação e dashboard sem
  erro de sintaxe.
- `npm run prepare-dist`: frontend regenerado; dez fontes/páginas afetadas
  conferidas por SHA-256 contra `dist`.
- Grafos dos módulos de Coleta, Início, Análise e Dashboard ligados com
  `vm.SourceTextModule`; IDs das quatro páginas verificados sem duplicidade.
- Revisão independente executada após a integração; o único achado inicial,
  truncamento na importação histórica, foi corrigido e coberto por teste.
