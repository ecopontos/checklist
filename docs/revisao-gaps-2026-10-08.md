# Revisão de código — ecopontos/checklist (análise própria, 2026-10-08)

Escopo: app inteiro (frontend JS/HTML + gas/Code.gs). Atenção redobrada na leva
1.7.0 (imprimir.html, coleta-operation.js, config.js, sw.js). Eixos: segurança
(LGPD/XSS/auth), acessibilidade, correção, PWA.

## Veredito por eixo

- Segurança / privacidade: REPROVADO (escrita não autenticada no backend GAS;
  XSS em 3 pontos do frontend).
- Acessibilidade: COM RESSALVAS (botões só-ícone sem rótulo; resto razoável).
- Correção/robustez: APROVADO (validação de lote no GAS é sólida; dedup por
  sync_id ok; novo tipo-de-resíduo funciona).
- PWA: APROVADO (VERSION 1.7.0 alinhado com package.json).

## Achados

### 1. [ALTO] Escrita não autenticada no backend GAS
Arquivo: gas/Code.gs:838-882 (doPost) + 1930/2022/1606/1740 (handlers).
O web app roda `access: ANYONE_ANONYMOUS` (appsscript.json:7) e SEM login.
Os endpoints de ESCRITA que exigem token (routeChangesToken) são só três:
routeChanges, clientChanges, cadastroSync. Os demais NÃO pedem token:
- saveColetas_ (coletas) — Code.gs:1930
- saveChecklist_ (upload de PDF no Drive) — Code.gs:2022
- syncAgendamentos_ (agendamentos) — Code.gs:1606
- uploadAgendamentoFotos_ (fotos) — Code.gs:1740

Qualquer um que conheça a URL do /exec pode gravar coletas falsas, criar
agendamentos, ou subir PDFs/fotos na pasta de produção do Drive. O frontend
esconde a gasUrl de propósito, mas a URL continua no histórico do git e o
backend em si não exige nada.
Correção concreta: exigir o mesmo token (routeChangesToken ou um novo
WRITE_TOKEN) também nesses quatro handlers — `var err = routeChangesAuthError_(token)`.
Trade-off: hoje agentes de campo usam o app sem login; exigir token só funciona
se o token for embarcado por configuração (config.local.js/localStorage), nunca
versionado. É decisão de risco que cabe ao Marcelo.

### 2. [ALTO] XSS em roteiros.html — tabela de clientes sem escape
Arquivo: roteiros.html:709-719.
`tr.innerHTML` interpola `${row.cliente}` e `${row.roteiro_nome}` SEM escape.
Esses valores vêm de CSV/planilha importada (não confiável). A função `esc`
existe (roteiros.html:600) mas NÃO é usada aqui — inconsistente com a linha
1191, que usa `esc(r.nome)` corretamente no modal de roteiros.
Correção: envolver com `esc(...)`, ou migrar para textContent como foi feito no
imprimir.html nesta mesma leva.

### 3. [MÉDIO] XSS no preview de importação legada
Arquivo: roteiros.html:1338-1342.
`item.innerHTML` interpola `${id}`, `${logr}`, `${num}`, `${suggestedName}`
sem escape. Dados vêm do parse de CSV legado (p.Logradouro, p.Numero etc.).
Correção: `esc(...)` em cada campo, ou textContent.

### 4. [MÉDIO] XSS em analise.html — tabela de relatório sem escape
Arquivo: analise.html:345-350.
`tr.innerHTML` interpola `${v[0]}` (nome do roteiro, pode vir de CSV via
roteiro_snapshot) sem escape. `${v[1]}` é SUM (numérico, seguro).
Correção: `esc`/textContent em v[0].

### 5. [BAIXO] imprimir.html showError usa innerHTML com err.message
Arquivo: imprimir.html:247.
`ev.innerHTML += ...${msg}` onde msg = "Erro técnico: " + err.message.
Risco baixo (mensagem de exceção JS), mas por consistência usar textContent
ou esc.

### 6. [BAIXO/a11y] Botões só-ícone sem rótulo acessível
Arquivo: roteiros.html:716-717 (✏️ editar, 🔄 alternar status) sem aria-label
nem texto. Leitor de tela anuncia "botão" sem sentido. Mesmo padrão em
whatsapp-sender e outros.
Correção: `aria-label="Editar"` / `aria-label="Alternar status"`.

### 7. [INFORMATIVO] crypto.randomUUID no script legado
Arquivo: coleta-checklist.html:752. Está dentro do `<script type="text/plain"
id="legacyColetaScript">` (DESATIVADO, referência histórica) — não é bug vivo.
O módulo ativo (coleta-operation.js) importa `newUuid` de database.js com
fallback correto. Só registrar: o código morto ainda mostra o padrão proibido e
pode enganar manutenção futura.

### 8. [INFORMATIVO] escolherOpcaoTipoResiduo — match por substring
Arquivo: config.js (nova função). O 2º laço casa radical (>= 4 chars) por
`indexOf`, então "vidro" (5) casa qualquer alvo contendo "vidro". Para os tipos
reais (Vidros, Orgânicos, etc.) funciona; risco é falso-positivo futuro se
houver tipos com radicais contidos uns nos outros. Guarda `length >= 4` já
mitiga a maioria.

## O que NÃO consegui verificar (sem acesso vivo)
- Valores reais das Script Properties do GAS (SPREADSHEET_ID, tokens,
  CHECKLISTS_FOLDER_ID) — não legíveis via API; só a UI do Google.
- O deploy atual em produção responde com qual apiVersion (não chamei o
  endpoint — o pull não mudou o backend, mas a URL de produção não está aqui).
- Medições de contraste/a11y reais (não medi cores; só inspeção estática).

## Triagem sugerida
- Corrigir já (correção inequívoca): achados 2, 3, 4, 5, 6.
- Decisão do Marcelo (risco/aceitação): achado 1 (autenticação de escrita).
- Não se aplica / registrar: 7 (código morto), 8 (robustez futura).
