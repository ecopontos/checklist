const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sw = fs.readFileSync('sw.js', 'utf8');
const precache = JSON.parse(sw.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"'));
const manifest = JSON.parse(fs.readFileSync('manifest.webmanifest', 'utf8'));
const NAO_CACHEADOS = new Set(['sw.js', 'prepare-dist.js', 'config.local.js', 'config.local.example.js']);

test('versao do cache do service worker acompanha o package.json', () => {
  const version = sw.match(/const VERSION = '([^']+)'/)[1];
  assert.equal(version, require('../package.json').version,
    'Atualize VERSION em sw.js junto com a versao do app para os PWAs instalados receberem a atualizacao.');
});

test('todos os arquivos de versao (app, instalador e service worker) estao alinhados', () => {
  const versao = require('../package.json').version;
  const tauri = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8')).version;
  const cargoToml = fs.readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)[1];
  const cargoLock = fs.readFileSync('src-tauri/Cargo.lock', 'utf8').match(/name = "satelite-checklist"\nversion = "([^"]+)"/)[1];
  const alvo = { 'tauri.conf.json': tauri, 'Cargo.toml': cargoToml, 'Cargo.lock': cargoLock };
  for (const [arquivo, valor] of Object.entries(alvo)) {
    assert.equal(valor, versao, `${arquivo} (${valor}) difere do package.json (${versao}); suba todos juntos no release.`);
  }
});

test('todo arquivo pre-cacheado existe', () => {
  for (const file of precache.filter(f => f !== './')) {
    assert.ok(fs.existsSync(file), `sw.js pre-cacheia ${file}, que nao existe`);
  }
});

test('todo arquivo do app esta no pre-cache, para funcionar offline', () => {
  const app = fs.readdirSync('.').filter(f => /\.(html|css|js|webmanifest)$/.test(f) && !NAO_CACHEADOS.has(f));
  const extras = ['vendor', 'icons'].flatMap(dir => fs.readdirSync(dir)
    .filter(f => !f.endsWith('.svg')).map(f => `${dir}/${f}`));
  for (const file of [...app, ...extras]) {
    assert.ok(precache.includes(file), `${file} falta no PRECACHE de sw.js`);
  }
});

test('toda pagina declara o manifest e registra o PWA', () => {
  for (const page of fs.readdirSync('.').filter(f => f.endsWith('.html'))) {
    const html = fs.readFileSync(page, 'utf8');
    assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/, page);
    assert.match(html, /<script src="pwa.js" defer><\/script>/, page);
    assert.doesNotMatch(html, /<script src="https?:/, `${page} carrega script externo, que nao funciona offline`);
  }
});

test('manifest aponta para icones existentes, incluindo maskable', () => {
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.normalize(icon.src)), icon.src);
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512'));
  assert.ok(manifest.icons.some(i => i.purpose === 'any' && i.sizes === '192x192'));
  assert.ok(fs.existsSync(manifest.start_url));
});
