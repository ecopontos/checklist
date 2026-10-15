# Cópia de teste do backend (GAS)

Para testar o app (inclusive o cadastro compartilhado, API v14 ou posterior; a atual é a 15) sem acesso ao
GAS e ao banco de produção, crie uma cópia no **seu** Google. Nada aqui toca a
produção.

> `PrepararTeste.gs` fica fora da pasta `gas/` de propósito: o workflow
> "Publicar GAS" envia `gas/` inteira para produção, e este script não deve ir junto.

## Passo a passo

1. Crie uma planilha nova no Google Sheets e copie o id da URL
   (`https://docs.google.com/spreadsheets/d/<ID>/edit`).
2. Em <https://script.google.com>, crie um projeto e cole **dois** arquivos:
   `gas/Code.gs` (substituindo o `Code.gs` padrão) e `gas-teste/PrepararTeste.gs`.
   Em "Configurações do projeto", marque "Mostrar arquivo de manifesto" e cole o
   conteúdo de `gas/appsscript.json`.
3. Em "Propriedades do script", crie:
   - `SPREADSHEET_ID` = o id do passo 1
   - `AMBIENTE_TESTE` = `sim`
4. Selecione a função `prepararTeste` e clique em **Executar**. Autorize o acesso
   a Planilhas e Drive. Ele cria:
   - as abas `tblRoteiros`, `shtClientes`, `tblRotas` (6 pontos fictícios em 2
     roteiros, um cliente em dois roteiros e um ponto inativo), `Coletas`,
     `AlteracoesRoteiros`, `AlteracoesClientes`, `verdesagendados`,
     `CadastroPontos` e `CadastroRoteiros`;
   - o `ROUTE_CHANGES_TOKEN` (se ainda não existir) — **copie o valor mostrado em
     "Registro de execução"**;
   - duas pastas no seu Drive (CSV e checklists) e o `cstExportaCheckList.csv` de exemplo.
5. Execute `verificarTeste` e confirme que tudo aparece como `OK`.
6. **Implantar → Nova implantação → App da Web** (Executar como: Eu; Quem tem
   acesso: Qualquer pessoa). Copie a URL que termina em `/exec`.
7. No app, na tela Admin, informe essa URL e o token do passo 4.

## Testar o GAS de uma vez (script)

Depois do passo 6, o script `testar-gas.js` confere o backend pela URL, sem abrir
o app. Precisa do Node 18 ou mais novo e roda no seu computador:

```bash
# só leitura: versão, roteiros, CSV, token errado, cadastroSync
GAS_TOKEN=<token> node gas-teste/testar-gas.js "<URL do /exec>"

# com gravação (SÓ NA CÓPIA DE TESTE): ponto, conflito, exclusão e renomear roteiro
GAS_TOKEN=<token> node gas-teste/testar-gas.js "<URL do /exec>" --escrever --coletas
```

- Mostra `OK`, `FALHA` ou `PULOU` para cada teste e termina com código 1 se algo falhar.
- O token vai na variável `GAS_TOKEN` para não ficar no histórico do terminal.
- Com `--escrever` ele pede para você digitar `teste` antes de gravar (ou use
  `--sim`). Os registros ficam como `TESTE-...`: o ponto é marcado como excluído e
  o roteiro `TESTE-ROT-...` permanece na aba `CadastroRoteiros` (apague as linhas
  à mão para limpar). `--coletas` também grava uma coleta de teste na aba
  `Coletas`, e depois disso `prepararTeste` não roda mais nessa planilha.
- Nunca aponte `--escrever` para a produção: o cadastro é compartilhado entre os
  aparelhos que usam a mesma URL.

## Cuidados

- Use um **perfil de navegador separado** para testar. A URL digitada na tela
  Admin fica no navegador e o `config.js` do repositório traz a URL de produção
  como padrão; assim o app de produção não passa a falar com a cópia.
- O script se recusa a rodar sem `AMBIENTE_TESTE = sim` ou numa planilha cuja aba
  `Coletas` já tenha registros. Rodar de novo é seguro: abas com dados são
  mantidas e o token, as pastas e o CSV não são recriados.
- Para recomeçar do zero, use outra planilha ou apague as abas e as propriedades
  `DRIVE_FOLDER_ID` e `CHECKLISTS_FOLDER_ID`.
- Sem as abas `tblRotas`/`shtClientes`/`tblRoteiros`, só as alterações de pontos
  vindos do Access (fila legada) falham; o resto funciona.
