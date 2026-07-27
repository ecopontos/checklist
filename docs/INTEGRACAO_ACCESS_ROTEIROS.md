# Integração de alterações de roteiros: app → GAS → Access

## Objetivo e escopo

Esta primeira versão devolve ao Access alterações feitas pelo app em pontos que
já possuem um `idRota` numérico originado de `tblRotas`:

- `tblRotas.Inativo`;
- `tblRotas.Ordem`;
- `tblRotas.idRoteiro`, resolvido pelo texto de `tblRoteiros.Roteiro`.

Nome do cliente, endereço e inclusão de novos pontos continuam somente locais
no app. Esses dados pertencem a `tblPJuridicas`/`tblCEP`, podem ser compartilhados
entre várias rotas e exigem regras próprias antes de serem editados com segurança.

## Fluxo

1. Ao salvar um ponto existente, o app grava a alteração no banco local e em
   uma fila de saída persistente.
   No modo **Organizar roteiro**, todas as posições afetadas são atualizadas em
   uma única transação e a sequência é normalizada de 1 até o último ponto.
2. O app envia a fila ao GAS usando a URL já configurada e um token separado.
3. O GAS registra as linhas idempotentemente na aba `AlteracoesRoteiros`, com
   status `PENDENTE`.
4. No formulário `frmRoteirosParaChecklist`, o operador clica em **Importar
   alterações do app**.
5. O Access baixa as linhas, valida todos os IDs e roteiros, mostra uma prévia e
   pede confirmação.
6. As atualizações são aplicadas em uma única transação DAO. Se qualquer linha
   falhar, nenhuma é confirmada.
7. O Access confirma os `Change ID` no GAS e executa a exportação existente
   `Comando95_Click`, regenerando `cstExportaCheckList.csv`.

Se a confirmação no GAS falhar depois do commit, as mesmas linhas reaparecem na
próxima importação. Reaplicá-las é seguro: são atualizações idempotentes pelos
mesmos valores.

O app envia lotes de até 100 alterações por requisição e continua até esvaziar
a fila. O Access pode receber até 2.000 alterações pendentes em uma única
importação, evitando que roteiros grandes precisem ser confirmados em etapas.

## Preparação do GAS

1. Em **Configurações do projeto → Propriedades do script**, crie
   `ROUTE_CHANGES_TOKEN`.
2. Use um segredo com pelo menos 32 caracteres formado apenas por letras,
   números, hífen e sublinhado. Não o grave no Git.
3. Publique o `gas/Code.gs` atualizado na implantação existente. O endpoint
   `?action=status` deve informar `apiVersion: 3` e
   `routeChangesConfigured: true`.

A propriedade `ROUTE_CHANGES_TOKEN` é configuração do projeto GAS. Ela não é
um secret do workflow GitHub e não é alterada pelo deploy automatizado.

## Preparação do app

Na tela **Admin → Sincronização Google**:

1. mantenha a URL `/exec` já utilizada;
2. informe o mesmo token em **Token para alterações de roteiros**;
3. clique em **Verificar Atualização**.

O contador **Alterações de Roteiro Pendentes** mostra operações que ainda não
chegaram ao GAS. Depois que o GAS aceita a linha, ela sai dessa fila local e fica
aguardando o Access.

## Preparação do Access 365

Use primeiro uma cópia de homologação:

- original preservado: `legado/ColetaFlex_BD_Andreza.accdb`;
- cópia preparada: `legado/ColetaFlex_BD_Andreza_integracao.accdb`;
- fonte VBA versionada:
  `legado/vba/frmRoteirosParaChecklist_integracao.bas`.

A cópia preparada mantém as tabelas vinculadas e a exportação do frontend
original. Ela acrescenta ao formulário `frmRoteirosParaChecklist` o botão
**Importar alterações do app**. No primeiro uso, o código cria duas tabelas
locais no frontend:

- `tblIntegracaoConfig`, que guarda URL e token;
- `tmpAlteracoesRoteiros`, usada somente para validação e aplicação do lote.

O token fica armazenado em texto na tabela local do frontend. Restrinja o acesso
ao arquivo `.accdb` às mesmas pessoas que já podem operar a base compartilhada.

## Piloto recomendado

1. Faça backup do backend e abra a cópia integrada do frontend.
2. Escolha um `idRota` de teste existente.
3. No app, altere somente a ordem ou o status desse ponto.
4. Confirme na tela Admin que não restou item na fila local.
5. No Access, clique em **Importar alterações do app**, confira a prévia e
   confirme.
6. Verifique diretamente em `tblRotas` os campos `Inativo`, `Ordem` e
   `idRoteiro`.
7. Confirme que o CSV foi regenerado e que o app mantém o mesmo valor após a
   sincronização seguinte.

Não troque o frontend de produção antes desse ciclo completo ser aprovado. Os
arquivos `.accdb` em `legado/` são ignorados pelo Git; somente o VBA reproduzível
é versionado.
