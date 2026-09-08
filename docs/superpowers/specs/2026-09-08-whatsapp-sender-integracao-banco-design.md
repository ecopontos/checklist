# Disparo WhatsApp — seleção de contatos via banco do app

## Contexto

`whatsapp-sender.html` é uma ferramenta standalone (acessada via botão "🛠️ Ferramentas" em `admin.html`) para disparo manual de mensagens no WhatsApp Web, um contato por vez. Hoje ela exige que o usuário exporte/faça upload de uma planilha própria (CSV/XLSX) e mapeie manualmente qual coluna é telefone e qual é nome — duplicando dados que já existem no banco SQLite (`database.js`) compartilhado pelo resto do app, que já guarda `telefone1`/`telefone2` por cliente, populados pelo import de roteiros/CSV existente.

Objetivo: eliminar o upload manual, selecionando os destinatários diretamente do banco, por roteiro.

## Fluxo atual (5 passos)

1. Upload de planilha (CSV/XLSX)
2. Mapear colunas (telefone, nome)
3. Escrever mensagem
4. Enviar um a um (WhatsApp Web), com pular/marcar enviado
5. Resumo final + exportar CSV do resultado

## Fluxo novo (4 passos)

1. **Selecionar roteiro(s)** — substitui upload + mapeamento
2. Escrever mensagem (inalterado)
3. Enviar um a um (inalterado)
4. Resumo final + exportar CSV (inalterado)

### Passo 1 — Selecionar roteiro(s)

- Ao carregar a página, inicializa `db` (`database.js`, mesmo padrão de `admin.html`/`roteiros.html`: carrega `vendor/sql-wasm.js` e `localStorage['app3_db']`).
- Lista todos os roteiros (`db.getRoteiros()`) como chips clicáveis (reaproveita estilo `.col-chip`/`.selected` já existente no CSS). Cada chip mostra o nome do roteiro e a contagem de contatos elegíveis nele (clientes `ativo=1` com `telefone1` e/ou `telefone2` não vazios após normalização).
- Selecionar um ou mais chips popula uma tabela de preview (reaproveita `.preview-table`) com uma linha por **telefone** (não por cliente): um cliente com `telefone1` e `telefone2` preenchidos vira duas linhas — "Nome (tel 1)" e "Nome (tel 2)" — cada uma com checkbox próprio, marcado por padrão, permitindo remover um número específico antes de prosseguir.
- Clientes inativos (`ativo=0`) nunca aparecem, não há opção de exibi-los.
- Telefones que sobram com menos de 8 dígitos após normalização (`replace(/\D/g,'')`) são descartados silenciosamente — nunca contam nem aparecem na lista.
- Botão "Próximo →" avança para o passo de mensagem com a lista de contatos marcados; fica desabilitado se zero contatos estiverem marcados.

### Estrutura de dados interna

Substitui `rows` (linhas de planilha) + `colPhone`/`colName` por:

```js
contacts = [{ nome, telefone, idRota, roteiroNome }]
```

`statuses` continua paralelo a `contacts` (`'pending' | 'sent' | 'skip'`), assim como `current`. `buildMsg`, `getPhone` (renomeada/adaptada para já receber telefone bruto do banco), `renderCurrentContact`, `renderHistory`, `markSent`, `markSkip`, `navigate`, `openWA`, `exportCSV` seguem a mesma lógica de hoje, só trocando a fonte do dado (`contacts[i]` em vez de `rows[i]` + lookups de coluna).

### O que é removido

- Upload zone (drag/drop, `<input type=file>`, `handleFile`)
- Parsing de planilha de entrada (`XLSX.read` sobre arquivo do usuário)
- Passo de mapeamento de colunas (`populateMappingStep`, `renderPreview` antigo, selects `colPhone`/`colName`)
- Dependência de `vendor/xlsx.full.min.js` **para entrada** — o arquivo continua incluído só para `exportCSV()` no passo final, que usa `XLSX.writeFile`.

### O que é adicionado

- `<script src="vendor/sql-wasm.js"></script>`
- `<script type="module">` importando `db` de `./database.js` e chamando `await db.init()` antes de popular os chips de roteiro.

## Fora de escopo

- Busca/filtro textual de clientes fora de um roteiro (usuário pediu seleção por roteiro apenas).
- Manter upload manual como alternativa (removido, não mantido como aba extra).
- Qualquer alteração no fluxo de envio (passos 2–4 do novo fluxo) além de trocar a fonte de dados.
