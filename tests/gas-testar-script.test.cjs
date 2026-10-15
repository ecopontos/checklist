const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { ambiente } = require('./helpers/gas-ambiente.cjs');

// Servidor que imita o Web App do Apps Script, inclusive o redirecionamento 302:
// o resultado de cada chamada (GET ou POST) é entregue numa segunda requisição GET.
function servidorGas(gas, { aoReceber } = {}) {
  const resultados = new Map();
  let proximo = 1;
  const servidor = http.createServer((req, res) => {
    const alvo = new URL(req.url, 'http://localhost');
    if (alvo.pathname.startsWith('/resultado/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(resultados.get(alvo.pathname.split('/').pop()) ?? '{}');
    }
    let corpo = '';
    req.on('data', c => { corpo += c; });
    req.on('end', () => {
      let texto;
      try {
        if (aoReceber) { const forcado = aoReceber(req.method, alvo, corpo); if (forcado) texto = forcado; }
        if (texto === undefined) {
          texto = req.method === 'POST'
            ? gas.context.doPost({ postData: { contents: corpo } }).value
            : gas.context.doGet({ parameter: Object.fromEntries(alvo.searchParams) }).value;
        }
      } catch (erro) {
        texto = JSON.stringify({ ok: false, error: erro.message });
      }
      const id = String(proximo++);
      resultados.set(id, texto);
      res.writeHead(302, { Location: `/resultado/${id}` });
      res.end();
    });
  });
  return new Promise(resolve => servidor.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${servidor.address().port}/exec`, fechar: () => servidor.close()
  })));
}

function rodarScript(url, args = [], env = {}) {
  return new Promise(resolve => {
    const filho = spawn(process.execPath, ['gas-teste/testar-gas.js', url, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let saida = '';
    filho.stdout.on('data', d => { saida += d; });
    filho.stderr.on('data', d => { saida += d; });
    filho.on('close', codigo => resolve({ codigo, saida }));
  });
}

async function copiaPreparada() {
  const gas = ambiente();
  gas.context.prepararTeste();
  return { gas, token: gas.properties.get('ROUTE_CHANGES_TOKEN') };
}

test('somente leitura: passa numa copia preparada e nao grava nada', async () => {
  const { gas, token } = await copiaPreparada();
  const servidor = await servidorGas(gas);
  const antes = JSON.stringify([...gas.sheets.keys()].map(n => [n, gas.sheets.get(n).rows.length]));
  const r = await rodarScript(servidor.url, [], { GAS_TOKEN: token });
  servidor.fechar();
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /OK\s+GAS responde e informa a versão — API v15/);
  assert.match(r.saida, /roteiros\/v1: 5 clientes, 2 roteiros, 6 pontos/);
  assert.match(r.saida, /OK\s+cadastroSync recusa token errado/);
  assert.match(r.saida, /PULOU grava um ponto/);
  assert.equal(JSON.stringify([...gas.sheets.keys()].map(n => [n, gas.sheets.get(n).rows.length])), antes, 'o modo leitura não pode gravar linhas');
});

test('com --escrever e --coletas: ponto, conflito, lapide e renomeacao de roteiro', async () => {
  const { gas, token } = await copiaPreparada();
  const servidor = await servidorGas(gas);
  const r = await rodarScript(servidor.url, ['--escrever', '--coletas', '--sim'], { GAS_TOKEN: token });
  servidor.fechar();
  assert.equal(r.codigo, 0, r.saida);
  for (const trecho of ['grava um ponto e outro aparelho o recebe', 'edição mais antiga perde', 'edição mais nova vence',
    'registro inválido é descartado', 'exclusão vira lápide', 'renomear roteiro não zera a última coleta']) {
    assert.match(r.saida, new RegExp(`OK\\s+${trecho}`), trecho);
  }
  assert.doesNotMatch(r.saida, /FALHA|PULOU/);
  assert.match(r.saida, /0 com falha, 0 pulado/);
});

test('sem confirmar nao grava: sem terminal interativo e sem --sim o script recusa', async () => {
  const { gas, token } = await copiaPreparada();
  const servidor = await servidorGas(gas);
  const linhasAntes = gas.sheets.get('CadastroPontos').rows.length;
  const r = await rodarScript(servidor.url, ['--escrever'], { GAS_TOKEN: token });
  servidor.fechar();
  assert.equal(r.codigo, 2, r.saida);
  assert.match(r.saida, /Gravação cancelada/);
  assert.equal(gas.sheets.get('CadastroPontos').rows.length, linhasAntes);
});

test('sem token: pula o que precisa dele e ainda confere o resto', async () => {
  const { gas } = await copiaPreparada();
  const servidor = await servidorGas(gas);
  const r = await rodarScript(servidor.url, [], { GAS_TOKEN: '' });
  servidor.fechar();
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /PULOU cadastroSync responde com o token — informe o token/);
  assert.match(r.saida, /OK\s+leitura de roteiros pelas abas/);
});

test('detecta GAS antigo (API 13), pagina HTML de login e token que o GAS aceita errado', async () => {
  const { gas, token } = await copiaPreparada();

  const antigo = await servidorGas(gas, { aoReceber: (metodo, alvo) =>
    alvo.searchParams.get('action') === 'status' ? JSON.stringify({ ok: true, service: 'satelite-gas', apiVersion: 13, routeChangesConfigured: true }) : null });
  let r = await rodarScript(antigo.url, [], { GAS_TOKEN: token });
  antigo.fechar();
  assert.equal(r.codigo, 1, r.saida);
  assert.match(r.saida, /FALHA\s+GAS responde e informa a versão — API v13/);

  const login = await servidorGas(gas, { aoReceber: () => '<!DOCTYPE html><html>Fazer login</html>' });
  r = await rodarScript(login.url, [], { GAS_TOKEN: token });
  login.fechar();
  assert.equal(r.codigo, 1, r.saida);
  assert.match(r.saida, /página HTML \(login ou erro\)/);

  const aberto = await servidorGas(gas, { aoReceber: (metodo, alvo, corpo) =>
    metodo === 'POST' && corpo.includes('token-errado') ? JSON.stringify({ ok: true, rev: 0, pontos: [], roteiros: [] }) : null });
  r = await rodarScript(aberto.url, [], { GAS_TOKEN: token });
  aberto.fechar();
  assert.equal(r.codigo, 1, r.saida);
  assert.match(r.saida, /ACEITOU um token errado/);
});

test('recusa URL que nao e de um Web App e mostra a ajuda sem argumentos', async () => {
  let r = await rodarScript('https://exemplo.com/x');
  assert.equal(r.codigo, 2);
  assert.match(r.saida, /não parece ser a de um Web App/);
  r = await new Promise(resolve => { const f = spawn(process.execPath, ['gas-teste/testar-gas.js'], { stdio: ['ignore', 'pipe', 'pipe'] }); let s = ''; f.stdout.on('data', d => { s += d; }); f.on('close', c => resolve({ codigo: c, saida: s })); });
  assert.equal(r.codigo, 2);
  assert.match(r.saida, /Uso: GAS_TOKEN/);
});
