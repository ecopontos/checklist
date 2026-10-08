const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const window = {};
vm.runInContext(fs.readFileSync('config.js', 'utf8'), vm.createContext({ window }));
const OPCOES = ['Vidros', 'Organicos', 'Plasticos', 'Papel e Papelao', 'Oleo de Cozinha', 'Bombonas', 'Residuos Solidos'];
const escolher = tipo => window.escolherOpcaoTipoResiduo(OPCOES, tipo);

test('escolhe a opcao do checklist a partir do tipo cadastrado no roteiro', () => {
  assert.equal(escolher('Vidro'), 'Vidros');
  assert.equal(escolher('vidros'), 'Vidros');
  assert.equal(escolher('Organicos'), 'Organicos');
  assert.equal(escolher('Orgânicos'), 'Organicos');
  assert.equal(escolher('Recicláveis Orgânico (Restos de Alimentos)'), 'Organicos', 'texto longo do Access');
  assert.equal(escolher('óleo de cozinha'), 'Oleo de Cozinha');
  assert.equal(escolher('Bombona'), 'Bombonas');
});

test('tipo desconhecido ou vazio nao escolhe nada (quem chama mostra o texto cadastrado)', () => {
  assert.equal(escolher('Eletronicos'), '');
  assert.equal(escolher(''), '');
  assert.equal(escolher(null), '');
  assert.equal(escolher('abc'), '', 'radical curto demais nao casa por acaso');
});

test('imprimir.html: tipo vem do roteiro e dados nao entram como HTML', () => {
  const html = fs.readFileSync('imprimir.html', 'utf8');
  assert.doesNotMatch(html, /Restos de Alimentos<\/strong>/, 'tipo de residuo nao pode ser fixo');
  assert.match(html, /tipo_residuo FROM roteiros/);
  assert.match(html, /<script src="config\.js"><\/script>/);
  assert.match(html, /td\.textContent = String\(texto\)/);
  assert.doesNotMatch(html, /\$\{c\.(cliente|logradouro|numero|complemento)/, 'sem interpolacao em innerHTML');
  assert.match(html, /break-inside: avoid/);
});

test('checklist em PDF pre-seleciona o tipo do roteiro ao abrir o modal', () => {
  const js = fs.readFileSync('coleta-operation.js', 'utf8');
  assert.match(js, /function aplicarTipoResiduoDoRoteiro/);
  assert.match(js, /aplicarTipoResiduoDoRoteiro\(routeSelect\.value\);\s*\n\s*document\.getElementById\('checklistModal'\)\.classList\.add\('open'\)/);
  assert.match(js, /roteiro\.tipo_residuo/);
});
