const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = nome => fs.readFileSync(nome, 'utf8');
const paginasComMenu = fs.readdirSync('.').filter(f => f.endsWith('.html') && html(f).includes('<nav class="page-nav">'));

test('a pagina inicial tem um cartao para Roteiros e Clientes', () => {
  assert.match(html('index.html'), /<a href="roteiros\.html" class="card">[\s\S]*?Roteiros e Clientes/);
});

test('toda pagina com menu leva a Roteiros (ou e a propria pagina de Roteiros)', () => {
  assert.ok(paginasComMenu.length >= 6, `esperava varias paginas com menu, achei ${paginasComMenu.join(', ')}`);
  for (const pagina of paginasComMenu) {
    const menu = html(pagina).match(/<nav class="page-nav">[\s\S]*?<\/nav>/)[0];
    const temLink = menu.includes('<a href="roteiros.html">📍 Roteiros</a>');
    const eAPropriaPagina = pagina === 'roteiros.html' && menu.includes('<span class="active">📍 Roteiros</span>');
    assert.ok(temLink || eAPropriaPagina, `${pagina}: o menu nao leva a Roteiros`);
  }
});

test('o link de Roteiros fica logo depois de Inicio nas paginas que ganharam o atalho', () => {
  for (const pagina of ['admin.html', 'agendamentos.html', 'coleta-checklist.html', 'whatsapp-sender.html']) {
    assert.match(html(pagina), /<a href="index\.html">🏠 Início<\/a>\s*\n\s*<a href="roteiros\.html">📍 Roteiros<\/a>/, pagina);
  }
});
