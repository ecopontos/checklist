const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Regressão dos XSS fechados em 2026-10-08 (branch claude/fix-xss-aria):
// dados de cliente/roteiro vindos de CSV/planilha nunca podem entrar em
// innerHTML sem escape. Trava por inspeção do fonte.

test('roteiros.html: tabela de clientes escapa dados antes do innerHTML', () => {
  const html = fs.readFileSync('roteiros.html', 'utf8');
  assert.doesNotMatch(html, /\$\{row\.cliente\}[^<]*<|>[\s\n]*\$\{row\.cliente\}/, 'row.cliente não pode entrar cru');
  assert.match(html, /esc\(row\.cliente\)/);
  assert.match(html, /esc\(row\.roteiro_nome\)/);
  assert.match(html, /esc\(row\.id_rota\)/);
});

test('roteiros.html: preview de importação legada escapa os campos do CSV', () => {
  const html = fs.readFileSync('roteiros.html', 'utf8');
  assert.match(html, /esc\(logr\)/);
  assert.match(html, /esc\(num\)/);
  assert.match(html, /esc\(suggestedName\)/);
});

test('roteiros.html: botões de ação só-ícone têm rótulo acessível', () => {
  const html = fs.readFileSync('roteiros.html', 'utf8');
  assert.match(html, /btn-icon" aria-label="Editar"/);
  assert.match(html, /btn-icon" aria-label="Alternar status"/);
});

test('analise.html: tabela de relatório escapa nome de roteiro', () => {
  const html = fs.readFileSync('analise.html', 'utf8');
  assert.match(html, /esc\(v\[0\]\)/);
  assert.match(html, /esc\(v\[1\]\)/);
});

test('imprimir.html: showError usa textContent, nunca innerHTML com mensagem', () => {
  const html = fs.readFileSync('imprimir.html', 'utf8');
  assert.match(html, /p\.textContent = msg/);
  assert.doesNotMatch(html, /innerHTML \+= `.*\$\{msg\}/, 'mensagem de erro não pode virar HTML');
});

test('roteiros.html: id_rota nunca entra em codigo de onclick (usa data-* e delegacao)', () => {
  const html = fs.readFileSync('roteiros.html', 'utf8');
  assert.doesNotMatch(html, /onclick="(editItem|toggleStatus)\(/, 'id_rota dentro de onclick: o navegador desfaz o escape antes de executar');
  assert.match(html, /data-acao="editar" data-id-rota="\$\{esc\(row\.id_rota\)\}"/);
  assert.match(html, /getElementById\('clientsBody'\)\.addEventListener\('click'/);
});
