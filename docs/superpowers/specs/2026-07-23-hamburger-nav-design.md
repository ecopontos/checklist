# Menu Hambúguer + Link de Ajuda na Navegação — Design

**Goal:** Substituir a barra de navegação horizontal (5 links visíveis) nas 4 páginas
de trabalho por um ícone de menu hambúguer no canto superior direito, que abre um
painel dropdown com os mesmos 5 destinos mais um novo item "❓ Ajuda". Remove o ícone
de ajuda avulso adicionado anteriormente em `coleta-checklist.html`.

**Escopo:** `roteiros.html`, `coleta-checklist.html`, `analise.html`, `admin.html`.
`index.html` não muda (nunca teve a barra de navegação — continua só com os cards).
`ajuda-coleta.html` não muda de conteúdo.

## Arquitetura

100% CSS, sem JavaScript novo — usa o padrão "checkbox hack": um
`<input type="checkbox">` oculto + um `<label>` (o ícone "☰") que, ao ser clicado,
marca o checkbox; um seletor CSS de irmão (`:checked ~`) revela o painel dropdown.
Mantém a mesma filosofia sem-JS da barra de navegação atual (documentada no design
anterior de navegação entre páginas).

Um segundo `<label for="navToggle">`, estilizado como overlay de tela cheia
(`position: fixed`, cobrindo todo o viewport, atrás do dropdown na pilha de
`z-index`), fecha o menu ao clicar em qualquer lugar fora dele — clicar nesse overlay
também alterna o mesmo checkbox.

## Estrutura HTML (compartilhada, com adaptação de posicionamento por página)

```html
<div class="nav-wrapper">
    <input type="checkbox" id="navToggle" class="nav-toggle">
    <label for="navToggle" class="hamburger-icon">☰</label>
    <label for="navToggle" class="nav-overlay"></label>
    <nav class="page-nav">
        <a href="index.html">🏠 Início</a>
        <a href="roteiros.html">📍 Roteiros</a>
        <a href="coleta-checklist.html">✅ Coleta</a>
        <a href="analise.html">📊 Análise</a>
        <a href="admin.html">⚙️ Admin</a>
        <a href="ajuda-coleta.html" target="_blank">❓ Ajuda</a>
    </nav>
</div>
```

Em cada página, o item correspondente à página atual vira `<span class="active">` (sem
`href`), igual ao padrão já usado — só o conteúdo do `<nav>` muda por arquivo, a
estrutura do `.nav-wrapper` é idêntica nas 4 páginas.

"❓ Ajuda" abre em nova aba (`target="_blank"`) em todas as 4 páginas, sempre apontando
para `ajuda-coleta.html` — mesmo comportamento que já existia no ícone avulso de
`coleta-checklist.html`, agora disponível também em Roteiros, Análise e Admin (o
conteúdo continua específico do módulo Coleta; isso é aceito por ora, conforme
decidido).

## CSS (regras compartilhadas, adicionadas em cada uma das 4 páginas)

```css
.nav-wrapper { position: relative; }

.nav-toggle { display: none; }

.hamburger-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    border: 1px solid var(--card-border);
    border-radius: 8px;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 1.1rem;
    transition: all 0.3s;
    position: relative;
    z-index: 210;
}
.hamburger-icon:hover { border-color: var(--primary); color: var(--primary); }

.nav-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 190;
    cursor: default;
}
.nav-toggle:checked ~ .nav-overlay { display: block; }

.page-nav {
    display: none;
    flex-direction: column;
    gap: 4px;
    position: absolute;
    top: 44px;
    right: 0;
    background: var(--surface);
    border: 1px solid var(--card-border);
    border-radius: 12px;
    padding: 10px;
    min-width: 180px;
    z-index: 200;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
}
.nav-toggle:checked ~ .page-nav { display: flex; }

.page-nav a, .page-nav .active {
    padding: 8px 10px;
    border-radius: 8px;
    color: var(--text-dim);
    text-decoration: none;
    transition: background 0.2s, color 0.2s;
}
.page-nav a:hover { background: rgba(255, 255, 255, 0.05); color: var(--primary); }
.page-nav .active { color: var(--primary); font-weight: 600; }
```

Substitui as regras `.page-nav`/`.page-nav a`/`.page-nav a:hover`/`.page-nav .active`
já existentes em cada arquivo (que hoje descrevem a barra horizontal) — mesmos nomes de
classe reaproveitados, comportamento visual totalmente diferente (painel vertical
posicionado, não mais uma linha).

## Posicionamento por página

- **`roteiros.html`, `analise.html`, `admin.html`**: `.header-nav` (que hoje só contém
  a nav) passa a ter `justify-content: flex-end`, alinhando o `.nav-wrapper` à direita
  do header.
- **`coleta-checklist.html`**: `.nav-wrapper` entra como último item dentro de
  `.controls` (bloco que já fica à direita do header, ao lado do botão
  "📋 Checklist Próxima Coleta"). O `<nav class="page-nav">` sai de dentro de
  `.logo-area` — a "OPERAÇÃO" fica sozinha ali.

## Remoção do ícone de ajuda avulso

Em `coleta-checklist.html`, o link `<a href="ajuda-coleta.html" target="_blank"
class="btn-help" title="Ajuda">❓</a>` e a regra CSS `.btn-help`/`.btn-help:hover`
(adicionados numa mudança anterior) são removidos — substituídos pelo item
"❓ Ajuda" dentro do novo menu.

## Verificação

Sem lógica JS, então verificação via Playwright: em cada uma das 4 páginas, confirmar
que (1) a barra horizontal antiga sumiu e só o ícone "☰" aparece no canto superior
direito, (2) clicar no ícone abre o painel com os 6 itens, item da página atual sem
link e destacado, (3) clicar em qualquer lugar fora do painel fecha o menu, (4) clicar
no ícone de novo também fecha, (5) cada um dos 5 links de página (excluindo o atual)
navega corretamente, (6) "❓ Ajuda" abre `ajuda-coleta.html` em nova aba. Em
`coleta-checklist.html` especificamente, confirmar que o antigo ícone "❓" avulso não
existe mais e que os controles existentes (seletor de rota, data, ordenação, botão de
checklist) continuam funcionando normalmente.

## Fora de escopo

- `index.html` — não recebe o menu (nunca teve a barra de navegação).
- Adaptar `ajuda-coleta.html` para cobrir outros módulos além de Coleta — o link
  "Ajuda" nas outras 3 páginas aponta pro mesmo conteúdo específico de Coleta por
  enquanto, decisão consciente.
- Atalho de teclado (Esc) para fechar o menu — só clique no ícone ou fora dele.
