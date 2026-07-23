# Página de Ajuda do Módulo Coleta — Design

**Goal:** Dar ao operador de campo uma referência rápida, acessível de dentro de
`coleta-checklist.html`, explicando os 4 fluxos principais da tela: seleção de
rota/ordenação, busca por ID, registro de quantidade/intercorrência, e geração do
checklist da próxima coleta em PDF.

**Escopo:** Nova página estática `ajuda-coleta.html` + um ícone de acesso adicionado ao
header de `coleta-checklist.html`. Não modifica nenhuma outra página nem lógica
existente.

## Arquitetura

Página estática nova, sem JavaScript — só HTML/CSS, seguindo o padrão já usado para
`imprimir.html` (página de apoio contextual, fora da barra de navegação principal).
Funciona offline (sem dependência de rede), consistente com o app Electron.

Reaproveita a mesma paleta de `coleta-checklist.html` (`--primary: #00f2fe`,
`--bg: #0b0e14`, `--text-dim: #8b949e` etc.) para parecer parte do mesmo sistema, sem
introduzir um novo design system.

## Ponto de acesso

Em `coleta-checklist.html`, dentro de `.controls` (ao lado do botão
"📋 Checklist Próxima Coleta"), um novo botão/ícone:

```html
<a href="ajuda-coleta.html" target="_blank" class="btn-help" title="Ajuda">❓</a>
```

Abre em nova aba (`target="_blank"`) — mesmo padrão de `imprimir.html`, que também abre
via `window.open(..., '_blank')` a partir de `roteiros.html`. Isso mantém a tela de
Coleta aberta e com seu estado intacto enquanto o operador consulta a ajuda.

No Electron, um link `target="_blank"` para uma URL da mesma origem
(`http://127.0.0.1:47821/ajuda-coleta.html`) já é tratado pelo `setWindowOpenHandler`
existente (adicionado no plano do app desktop) como uma nova janela interna do app —
nenhuma mudança adicional é necessária ali.

## Estrutura da página

```
Header: "❓ Ajuda — Coleta" + link "⬅️ Voltar" para coleta-checklist.html
Corpo: 4 seções, cada uma com título, parágrafo de contexto, e passo a passo numerado
```

### Seção 1 — Selecionar rota e ordenar a lista
Como escolher o roteiro em "Selecione o Roteiro"; o que cada opção do seletor de
ordenação faz: "Número de Ordem" (ordem cadastrada da rota, padrão), "Ordem
Alfabética" (por nome do cliente), "Qtd. Digitada" (maior quantidade já digitada
primeiro, pendentes no fim).

### Seção 2 — Busca por ID Rota
Digitar o ID no campo "DIGITE O ID ROTA..." e apertar Enter isola aquele cliente na
tela. Para voltar à lista completa sem preencher nada: apertar **Esc** a qualquer
momento, ou apertar Enter com o campo vazio.

### Seção 3 — Registrar quantidade e intercorrência
Preencher o campo numérico de cada cliente; usar "+ Problema" para marcar uma
intercorrência naquele ponto; Enter no campo de quantidade avança pro campo de
problema (se aberto) ou finaliza o registro.

### Seção 4 — Checklist da Próxima Coleta (PDF)
Abrir pelo botão "📋 Checklist Próxima Coleta"; preencher Data da Próxima Coleta, Tipo
de Resíduo, Motorista/Veículo (opcionais); "Baixar PDF" ou "Enviar para Drive". Lista
dos 8 códigos de intercorrência que aparecem no rodapé do PDF (para o motorista usar em
vez de escrever o problema por extenso), reproduzida integralmente na ajuda.

## Verificação

Sem lógica nova além de um link — verificação via Playwright: abrir
`coleta-checklist.html`, clicar no ícone "❓", confirmar que `ajuda-coleta.html` abre
numa nova aba/janela com as 4 seções e o link de volta funcionando, e que a tela de
Coleta original permanece com seu estado (rota selecionada, dados digitados) intacto.

## Fora de escopo

- Ajuda para outras páginas do app (Roteiros, Análise, Admin) — só o módulo Coleta,
  como pedido.
- Busca ou índice dentro da própria página de ajuda — só rolagem, dado o tamanho
  pequeno do conteúdo (4 seções).
- Capturas de tela / imagens — só texto, para não precisar manter screenshots
  sincronizados com mudanças futuras de UI.
