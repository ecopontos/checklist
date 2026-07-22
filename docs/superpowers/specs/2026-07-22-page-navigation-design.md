# Navegação entre Páginas — Design

**Goal:** Permitir que o operador troque de contexto entre as 4 páginas de trabalho (Roteiros, Coleta, Análise, Admin) diretamente, sem precisar voltar ao `index.html` a cada troca. Uso primário é desktop (escritório).

**Escopo:** `roteiros.html`, `coleta-checklist.html`, `analise.html`, `admin.html`. Não afeta `index.html` (continua como hub com os 4 cards grandes, sem mudanças) nem `imprimir.html` (continua acessível só via `roteiros.html?id=...`, contextual). `whatsapp-sender.html` ganha um ponto de entrada novo (ver seção "Card Ferramentas"), mas continua fora da navegação principal — não tem dependência dos dados do app (sem `localStorage`/import de `database.js`), então não faz sentido no mesmo nível de Roteiros/Coleta/Análise/Admin.

## Arquitetura

Sem JavaScript novo. É um bloco de HTML/CSS estático, duplicado nas 4 páginas — decisão consciente: o projeto inteiro já é HTML estático sem build step, e um componente de nav compartilhado via JS (`nav.js` injetado) foi descartado por adicionar indireção e um flash-of-no-nav para resolver um problema pequeno (4 páginas, 5 links). O custo de manter a duplicação (editar 4 arquivos se um destino mudar) é aceitável nesse tamanho de projeto.

Cada página já define `.header-nav` e `.btn-back` no seu `<style>`. O `<a class="btn-back">` único existente em cada uma é substituído por um `<nav class="page-nav">` com os 5 destinos.

## Markup e estilo

Estrutura (idêntica nas 4 páginas, só variando `href` ativo e as cores locais):

```html
<nav class="page-nav">
    <a href="index.html">🏠 Início</a>
    <a href="roteiros.html" class="active">📍 Roteiros</a>
    <a href="coleta-checklist.html">✅ Coleta</a>
    <a href="analise.html">📊 Análise</a>
    <a href="admin.html">⚙️ Admin</a>
</nav>
```

- O item da página atual recebe `class="active"` **e não tem `href`** (troca `<a>` por `<span>` ou remove o atributo `href`, mantendo a mesma tag para não quebrar o `display: flex` — decisão de implementação livre, mas sem navegação para a própria página).
- `.active`: cor de destaque usando a variável local de cada página (`var(--primary)` — todas as 4 páginas já usam `--primary: #00f2fe`), peso de fonte maior.
- Itens não ativos: `color: var(--text-dim)` (já definida em todas as 4 páginas), com `:hover { color: var(--primary); }` — mesmo padrão que `.btn-back:hover` já usa hoje.
- `.page-nav`: `display: flex; gap: 16px; flex-wrap: wrap;` dentro do `.header-nav` existente (que já é `display: flex`). Sem breakpoint dedicado — o foco é desktop, mas `flex-wrap` evita quebra de layout caso a janela seja estreita.
- Nenhuma mudança de cor de fundo, header ou logo — só o conteúdo do link único vira uma lista de links.

## Card "Ferramentas" em admin.html

Novo card na `.admin-grid` existente (mesmo padrão dos 3 cards atuais: Migração Legada, Sincronização Google, Manutenção do Banco):

```html
<div class="card">
    <h2>🛠️ Ferramentas</h2>
    <p>Utilitários auxiliares que não fazem parte do fluxo principal de coleta.</p>
    <a href="whatsapp-sender.html" class="btn btn-outline">📲 Disparo WhatsApp</a>
</div>
```

`admin.html` já define `.btn-outline` (usada em `roteiros.html` no botão de imprimir); reaproveitada aqui sem CSS novo.

## Verificação

Sem lógica nova, então a verificação é toda visual/navegacional, via Playwright (mesmo padrão usado na verificação do seletor de ordenação):

1. Abrir cada uma das 4 páginas e confirmar que a barra de nav aparece com o item correto marcado `.active` (sem link) e os outros 4 clicáveis.
2. Clicar em cada um dos 4 links não-ativos a partir de cada página e confirmar que chega na página certa.
3. Confirmar visualmente (screenshot) que nenhuma página teve o layout do header quebrado pela troca do link único pela barra de 5 itens.
4. Em `admin.html`, confirmar que o novo card "Ferramentas" aparece na grid e que o botão abre `whatsapp-sender.html`.

## Fora de escopo

- Mudanças em `index.html` — continua igual.
- Mover ou alterar o acesso a `imprimir.html` — continua só via `roteiros.html` com `id` na URL.
- Adicionar `whatsapp-sender.html` à navegação principal — fica só como link a partir do card "Ferramentas" em `admin.html`.
- Persistência de estado de navegação (breadcrumbs, histórico, etc.) — é só um conjunto fixo de 5 links por página.
- Responsividade mobile dedicada (breakpoints, menu hambúrguer) — uso primário é desktop; `flex-wrap` é a única concessão a telas estreitas.
