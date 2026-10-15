#!/usr/bin/env node
// Testes remotos do backend (GAS) — para a CÓPIA DE TESTE, ver gas-teste/README.md.
//
//   GAS_TOKEN=<token> node gas-teste/testar-gas.js <URL do /exec>
//   GAS_TOKEN=<token> node gas-teste/testar-gas.js <URL> --escrever [--coletas] [--sim]
//
// Sem opções só LÊ (e confere a segurança do token). Com --escrever grava
// registros "TESTE-..." no cadastro compartilhado; com --coletas grava também
// uma coleta de teste. Use SOMENTE na cópia de teste: o cadastro é compartilhado
// entre os aparelhos que usam a mesma URL. O token vem da variável GAS_TOKEN
// (preferível, não fica no histórico do terminal) ou do segundo argumento.
//
// Requer Node 18 ou mais novo. Código de saída: 0 tudo certo, 1 falhas, 2 uso.
'use strict';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const posicionais = args.filter(a => !a.startsWith('--'));
const url = (process.env.GAS_URL || posicionais[0] || '').trim();
const token = (process.env.GAS_TOKEN || posicionais[1] || '').trim();
const escrever = flags.has('--escrever');
const comColetas = flags.has('--coletas');

if (!url || flags.has('--ajuda') || flags.has('--help')) {
  console.log(`Uso: GAS_TOKEN=<token> node gas-teste/testar-gas.js <URL do /exec> [--escrever] [--coletas] [--sim]

  (sem opções)  só leitura: versão, roteiros, CSV, token errado, cadastroSync vazio
  --escrever    grava e confere registros TESTE-* no cadastro (SÓ NA CÓPIA DE TESTE)
  --coletas     com --escrever, confere também "última coleta" após renomear roteiro
  --sim         não pergunta antes de gravar`);
  process.exit(url ? 0 : 2);
}
if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('A URL não parece ser a de um Web App do Apps Script (https://script.google.com/macros/s/.../exec).');
  process.exit(2);
}

const cor = process.stdout.isTTY ? { ok: '\x1b[32m', falha: '\x1b[31m', aviso: '\x1b[33m', fim: '\x1b[0m' } : { ok: '', falha: '', aviso: '', fim: '' };
const resultados = [];

async function requisitar(metodo, alvo, corpo) {
  const controlador = new AbortController();
  const limite = setTimeout(() => controlador.abort(), 90000);
  try {
    const resposta = await fetch(alvo, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'text/plain;charset=utf-8' } : undefined,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: controlador.signal
    });
    const texto = await resposta.text();
    try {
      return JSON.parse(texto);
    } catch (_) {
      throw new Error(/<html|<!doctype/i.test(texto)
        ? 'O Google devolveu uma página HTML (login ou erro). Confira se a implantação está como "Executar como: Eu" e "Quem tem acesso: Qualquer pessoa".'
        : `Resposta que não é JSON: ${texto.slice(0, 120)}`);
    }
  } finally {
    clearTimeout(limite);
  }
}
const ler = (params = {}) => requisitar('GET', `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`);
const gravar = corpo => requisitar('POST', url, corpo);
const sincronizar = (corpo, tokenUsado = token) => gravar({ action: 'cadastroSync', token: tokenUsado, ...corpo });

function exigir(condicao, mensagem) { if (!condicao) throw new Error(mensagem); }

async function teste(nome, corpo, { precisaToken = false, precisaEscrever = false, precisaColetas = false } = {}) {
  const motivoPulo = (precisaToken && !token && 'informe o token (GAS_TOKEN)')
    || (precisaEscrever && !escrever && 'use --escrever')
    || (precisaColetas && !comColetas && 'use --escrever --coletas');
  if (motivoPulo) {
    resultados.push({ nome, estado: 'pulado', detalhe: motivoPulo });
    console.log(`${cor.aviso}PULOU${cor.fim} ${nome} — ${motivoPulo}`);
    return;
  }
  try {
    const detalhe = await corpo();
    resultados.push({ nome, estado: 'ok', detalhe: detalhe || '' });
  } catch (erro) {
    resultados.push({ nome, estado: 'falha', detalhe: erro.message });
  }
  const r = resultados[resultados.length - 1];
  const marca = r.estado === 'ok' ? `${cor.ok}OK   ${cor.fim}` : `${cor.falha}FALHA${cor.fim}`;
  console.log(`${marca} ${nome}${r.detalhe ? ` — ${r.detalhe}` : ''}`);
}

// Lê todas as páginas do cadastro a partir de `since`.
async function lerCadastro(since = 0) {
  const pontos = [];
  const roteiros = [];
  let cursor = since;
  for (let pagina = 0; pagina < 50; pagina++) {
    const r = await sincronizar({ since: cursor, pontos: [], roteiros: [] });
    exigir(r.ok, r.error || 'cadastroSync falhou');
    pontos.push(...r.pontos);
    roteiros.push(...r.roteiros);
    if (!r.hasMore) return { pontos, roteiros, rev: r.rev };
    cursor = r.cursor;
  }
  throw new Error('Cadastro grande demais para o teste (mais de 50 páginas).');
}

async function confirmar() {
  if (flags.has('--sim')) return true;
  if (!process.stdin.isTTY) return false;
  const readline = require('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resposta = await rl.question(`${cor.aviso}Vai GRAVAR registros TESTE-* em ${url}\nIsto compartilha dados entre aparelhos. É a cópia de TESTE? Digite "teste" para continuar: ${cor.fim}`);
  rl.close();
  return resposta.trim().toLowerCase() === 'teste';
}

(async () => {
  console.log(`Testando ${url}${escrever ? '  [com gravação]' : '  [só leitura]'}\n`);
  let versao = 0;

  await teste('GAS responde e informa a versão', async () => {
    const s = await ler({ action: 'status' });
    exigir(s.ok && s.service === 'satelite-gas', 'resposta de status inesperada (é o Web App do SATELITE?)');
    versao = Number(s.apiVersion);
    exigir(versao >= 14, `API v${versao}; o cadastro compartilhado precisa da v14 ou mais (esperado v15)`);
    exigir(s.cadastro === true, 'status sem "cadastro": true');
    exigir(s.routeChangesConfigured === true, 'ROUTE_CHANGES_TOKEN não está configurado no GAS');
    return `API v${versao}${versao < 15 ? ' (a v15 é a mais recente)' : ''}`;
  });

  await teste('leitura de roteiros pelas abas', async () => {
    const r = await ler();
    exigir(r.ok, r.error || 'falhou (faltam as abas tblRotas/shtClientes/tblRoteiros?)');
    if (r.contract) {
      exigir(r.contract === 'roteiros/v1', `contrato inesperado: ${r.contract}`);
      exigir(r.counts && r.counts.pontos > 0, 'nenhum ponto retornado');
      const extra = (r.conflitosIdUnico || []).length ? `; ATENÇÃO: idUnico2 em conflito: ${r.conflitosIdUnico.join(', ')}` : '';
      return `roteiros/v1: ${r.counts.clientes} clientes, ${r.counts.roteiros} roteiros, ${r.counts.pontos} pontos${extra}`;
    }
    exigir(r.count > 0, 'nenhum ponto retornado');
    return `formato antigo: ${r.count} pontos`;
  });

  await teste('CSV do Drive (roteirosCsv)', async () => {
    const r = await ler({ action: 'roteirosCsv' });
    exigir(r.ok, r.error || 'falhou (DRIVE_FOLDER_ID e o arquivo cstExportaCheckList.csv existem?)');
    exigir(typeof r.content === 'string' && r.content.includes('idRota'), 'CSV sem a coluna idRota');
    return `${r.content.split(/\r?\n/).length - 1} linhas, ${r.encoding}`;
  });

  await teste('última coleta responde', async () => {
    const r = await ler({ action: 'ultimaColeta', roteiro: 'SAT01' });
    exigir(r.ok, r.error || 'falhou');
    return r.data ? `SAT01: ${r.data}` : 'sem coletas ainda';
  });

  await teste('cadastroSync recusa token errado', async () => {
    const r = await sincronizar({ since: 0, pontos: [], roteiros: [] }, 'token-errado-com-bem-mais-de-trinta-caracteres');
    exigir(r.ok === false, 'ACEITOU um token errado: o cadastro está aberto!');
    return 'recusado como esperado';
  });

  await teste('cadastroSync responde com o token', async () => {
    const r = await sincronizar({ since: 0, pontos: [], roteiros: [] });
    exigir(r.ok, r.error || 'falhou (token certo?)');
    exigir(Number.isInteger(r.rev) && Array.isArray(r.pontos) && Array.isArray(r.roteiros), 'formato de resposta inesperado');
    return `rev ${r.rev}, ${r.pontos.length} pontos, ${r.roteiros.length} roteiros`;
  }, { precisaToken: true });

  if (escrever && token) {
    if (!(await confirmar())) {
      console.log('\nGravação cancelada.');
      process.exit(2);
    }
  }

  const marca = Date.now().toString(36);
  const idPonto = `TESTE-${marca}`;
  const chave = `TESTE-ROT-${marca}`;
  const agora = Date.now();
  const em = minutosAtras => new Date(agora - minutosAtras * 60000).toISOString();
  const ponto = (cliente, editadoEm, origem = 'testar-gas', extra = {}) => ({
    id_rota: idPonto, cliente, logradouro: 'Rua de Teste', numero: '1', cep: '01001000', telefone1: '48999990000',
    roteiro: chave, ordem: 1, ativo: 1, excluido: 0, editado_em: editadoEm, origem, ...extra
  });

  await teste('grava um ponto e outro aparelho o recebe', async () => {
    const r = await sincronizar({ origem: 'testar-gas', roteiros: [{ chave, nome: chave, tipo_residuo: 'Teste', apelidos: [], editado_em: em(10), origem: 'testar-gas' }],
      pontos: [ponto('Cliente de teste', em(10))] });
    exigir(r.ok, r.error || 'falhou');
    exigir([...r.accepted.pontos].includes(idPonto), 'o ponto não foi aceito');
    const lido = await lerCadastro(0);
    const achado = lido.pontos.find(p => p.id_rota === idPonto);
    exigir(achado, 'o ponto gravado não voltou na leitura');
    exigir(achado.cep === '01001000', `CEP mudou ao gravar: "${achado.cep}" (zero à esquerda perdido?)`);
    exigir(lido.roteiros.some(x => x.chave === chave), 'o roteiro gravado não voltou na leitura');
    return `${idPonto} ida e volta ok (rev ${lido.rev})`;
  }, { precisaToken: true, precisaEscrever: true });

  await teste('edição mais antiga perde e recebe a versão do servidor', async () => {
    const r = await sincronizar({ pontos: [ponto('Edição antiga', em(60), 'outro-aparelho')], roteiros: [] });
    exigir(r.ok, r.error || 'falhou');
    exigir(![...r.accepted.pontos].includes(idPonto), 'aceitou uma edição mais antiga que a do servidor');
    const conflito = r.conflitos.pontos.find(p => p.id_rota === idPonto);
    exigir(conflito && conflito.cliente === 'Cliente de teste', 'não devolveu a versão do servidor no conflito');
    return 'conflito resolvido a favor da mais recente';
  }, { precisaToken: true, precisaEscrever: true });

  await teste('edição mais nova vence', async () => {
    const r = await sincronizar({ pontos: [ponto('Cliente atualizado', em(1), 'outro-aparelho')], roteiros: [] });
    exigir(r.ok && [...r.accepted.pontos].includes(idPonto), r.error || 'edição mais nova foi recusada');
    const achado = (await lerCadastro(0)).pontos.find(p => p.id_rota === idPonto);
    exigir(achado && achado.cliente === 'Cliente atualizado', 'a leitura não mostra a edição nova');
    return 'ok';
  }, { precisaToken: true, precisaEscrever: true });

  await teste('registro inválido é descartado sem derrubar o lote', async () => {
    const r = await sincronizar({ pontos: [{ id_rota: 'x y z', cliente: 'Inválido', roteiro: chave, editado_em: em(1), origem: 'testar-gas' }], roteiros: [] });
    exigir(r.ok, r.error || 'o lote inteiro falhou por causa de um registro inválido');
    exigir(r.invalid.pontos.length === 1, 'o registro inválido não foi apontado em "invalid"');
    return 'apontado em invalid';
  }, { precisaToken: true, precisaEscrever: true });

  await teste('exclusão vira lápide', async () => {
    const r = await sincronizar({ pontos: [{ id_rota: idPonto, excluido: 1, cliente: '', roteiro: '', editado_em: em(0), origem: 'testar-gas' }], roteiros: [] });
    exigir(r.ok && [...r.accepted.pontos].includes(idPonto), r.error || 'exclusão recusada');
    const achado = (await lerCadastro(0)).pontos.find(p => p.id_rota === idPonto);
    exigir(achado && achado.excluido === 1, 'a lápide não aparece na leitura');
    return 'lápide entregue (o ponto de teste fica marcado como excluído)';
  }, { precisaToken: true, precisaEscrever: true });

  await teste('renomear roteiro não zera a última coleta', async () => {
    const nomeNovo = `${chave}-NOVO`;
    const data = new Date(agora - 86400000).toISOString().slice(0, 10);
    const roteiro = await sincronizar({ pontos: [], roteiros: [{ chave, nome: nomeNovo, tipo_residuo: 'Teste', apelidos: [chave], editado_em: em(0), origem: 'testar-gas' }] });
    exigir(roteiro.ok, roteiro.error || 'falhou ao renomear');
    const coleta = await gravar({ coletas: [{ id_rota: idPonto, data, cliente: 'Cliente de teste', roteiro: chave, quantidade: 1, intercorrencia: '', sync_id: `teste-${marca}` }] });
    exigir(coleta.ok, coleta.error || 'falhou ao gravar a coleta de teste');
    const pelaNova = await ler({ action: 'ultimaColeta', roteiro: nomeNovo });
    const pelaAntiga = await ler({ action: 'ultimaColeta', roteiro: chave });
    exigir(pelaNova.ok && pelaNova.data === data, `pelo nome NOVO veio "${pelaNova.data}" (esperado ${data}): GAS sem a v14?`);
    exigir(pelaAntiga.ok && pelaAntiga.data === data, `pelo nome ANTIGO veio "${pelaAntiga.data}" (esperado ${data})`);
    return `os dois nomes retornam ${data}`;
  }, { precisaToken: true, precisaEscrever: true, precisaColetas: true });

  const falhas = resultados.filter(r => r.estado === 'falha');
  const pulados = resultados.filter(r => r.estado === 'pulado');
  console.log(`\n${resultados.filter(r => r.estado === 'ok').length} ok, ${falhas.length} com falha, ${pulados.length} pulado(s).`);
  if (pulados.length) console.log(`${cor.aviso}Pulados:${cor.fim} ${pulados.map(p => `${p.nome} (${p.detalhe})`).join('; ')}`);
  if (escrever) console.log(`\nRegistros de teste: ponto ${idPonto} (marcado como excluído) e roteiro ${chave}-NOVO na aba CadastroRoteiros; apague as linhas à mão se quiser limpar.`);
  process.exit(falhas.length ? 1 : 0);
})().catch(erro => {
  console.error(`${cor.falha}Erro inesperado:${cor.fim} ${erro.message}`);
  process.exit(1);
});
