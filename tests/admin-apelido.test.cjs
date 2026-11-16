// tests/admin-apelido.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('admin.html', 'utf8');

test('admin.html tem input de apelido do dispositivo', () => {
  assert.match(html, /id="deviceApelido"/);
});

test('admin.html importa e usa setApelido/getApelido', () => {
  assert.match(html, /instance-identity\.js/);
  assert.match(html, /setApelido/);
  assert.match(html, /getApelido/);
});
