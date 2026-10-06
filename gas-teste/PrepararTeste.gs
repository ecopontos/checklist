/**
 * Preparação de uma cópia de TESTE do backend do SATELITE.
 *
 * NÃO publique este arquivo no projeto de produção (por isso ele fica fora da
 * pasta gas/, que é a enviada pelo workflow "Publicar GAS"). Cole-o, junto com
 * gas/Code.gs, no projeto Apps Script da SUA planilha de teste.
 *
 * Uso (detalhes em gas-teste/README.md):
 *   1. Em "Propriedades do script", crie SPREADSHEET_ID (id da planilha de
 *      teste) e AMBIENTE_TESTE = sim.
 *   2. Execute prepararTeste() uma vez e autorize o acesso a Planilhas e Drive.
 *   3. Execute verificarTeste() para conferir o resultado.
 *
 * O script nunca sobrescreve dados: uma aba que já tem linhas de dados é
 * mantida como está, e ele se recusa a rodar numa planilha cuja aba Coletas já
 * tem registros (parece uma planilha em uso).
 */

var TESTE_PROP_AMBIENTE = 'AMBIENTE_TESTE';
var TESTE_CSV_COLUNAS = ['Fonte', 'idRota', 'Inativo', 'Ordem', 'Roteiro', 'Cliente', 'logradouro',
    'Número', 'CEP', 'Complemento', 'Telefone1', 'Telefone2', 'TipoResiduo', 'idCliente'];
var TESTE_COLETAS_HEADERS = ['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência',
    'Sincronizado Em', 'Sync ID'];

// Tabelas espelhando as do Access (cabeçalhos exatos que o Code.gs procura).
var TESTE_TBL_ROTEIROS_HEADERS = ['idRoteiro', 'Roteiro'];
var TESTE_SHT_CLIENTES_HEADERS = ['idPJ', 'idUnico2', 'Cliente', 'Número', 'Complemento', 'CEP', 'Telefone1', 'Telefone2'];
var TESTE_TBL_ROTAS_HEADERS = ['idRota', 'idPJ', 'idRoteiro', 'Ordem', 'Inativo'];

// Dados fictícios.
var TESTE_ROTEIROS = [
    { id: 1, nome: 'SAT01', tipo: 'Organicos' },
    { id: 2, nome: 'SV01', tipo: 'Vidro' }
];
var TESTE_CLIENTES = [
    { idPJ: 101, nome: 'Padaria Teste', logradouro: 'Rua das Flores', numero: '10', complemento: '', cep: '88010000', tel1: '48999990001', tel2: '' },
    { idPJ: 102, nome: 'Restaurante Teste', logradouro: 'Avenida do Mar', numero: '250', complemento: 'Loja 2', cep: '88020000', tel1: '48999990002', tel2: '48999990003' },
    { idPJ: 103, nome: 'Mercado Teste', logradouro: 'Rua Central', numero: '77', complemento: '', cep: '01001000', tel1: '48999990004', tel2: '' },
    { idPJ: 104, nome: 'Bar Teste', logradouro: 'Travessa Sul', numero: '5', complemento: 'Fundos', cep: '88030000', tel1: '', tel2: '' },
    { idPJ: 105, nome: 'Escola Teste', logradouro: 'Rua da Escola', numero: '300', complemento: '', cep: '88040000', tel1: '48999990005', tel2: '' }
];
// idRota, cliente (idPJ), roteiro (idRoteiro), ordem, inativo. O cliente 101
// está em dois roteiros (como no Access) e o 105 está inativo.
var TESTE_ROTAS = [
    { idRota: 1, idPJ: 101, idRoteiro: 1, ordem: 1, inativo: false },
    { idRota: 2, idPJ: 102, idRoteiro: 1, ordem: 2, inativo: false },
    { idRota: 3, idPJ: 103, idRoteiro: 1, ordem: 3, inativo: false },
    { idRota: 4, idPJ: 101, idRoteiro: 2, ordem: 1, inativo: false },
    { idRota: 5, idPJ: 104, idRoteiro: 2, ordem: 2, inativo: false },
    { idRota: 6, idPJ: 105, idRoteiro: 2, ordem: 3, inativo: true }
];

function prepararTeste() {
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty(TESTE_PROP_AMBIENTE) !== 'sim') {
        throw new Error('Defina a propriedade do script ' + TESTE_PROP_AMBIENTE + ' = sim para confirmar que este é um projeto de TESTE.');
    }
    var spreadsheetId = props.getProperty('SPREADSHEET_ID');
    if (!spreadsheetId) throw new Error('Defina a propriedade do script SPREADSHEET_ID com o id da planilha de teste.');

    var ss = SpreadsheetApp.openById(spreadsheetId);
    var coletas = ss.getSheetByName(COLETAS_SHEET_NAME);
    if (coletas && coletas.getLastRow() > 1) {
        throw new Error('A aba Coletas desta planilha já tem registros: ela parece estar em uso. Use uma planilha nova.');
    }

    var relatorio = [];
    var ids = {};
    TESTE_CLIENTES.forEach(function (cliente) { ids[cliente.idPJ] = Utilities.getUuid(); });

    relatorio.push(escreverAbaTeste_(ss, 'tblRoteiros', TESTE_TBL_ROTEIROS_HEADERS,
        TESTE_ROTEIROS.map(function (r) { return [r.id, r.nome]; }), []));
    relatorio.push(escreverAbaTeste_(ss, 'shtClientes', TESTE_SHT_CLIENTES_HEADERS,
        TESTE_CLIENTES.map(function (c) {
            return [c.idPJ, ids[c.idPJ], c.nome, c.numero, c.complemento, c.cep, c.tel1, c.tel2];
        }), [4, 6, 7, 8]));
    relatorio.push(escreverAbaTeste_(ss, 'tblRotas', TESTE_TBL_ROTAS_HEADERS,
        TESTE_ROTAS.map(function (r) { return [r.idRota, r.idPJ, r.idRoteiro, r.ordem, r.inativo]; }), []));
    relatorio.push(escreverAbaTeste_(ss, COLETAS_SHEET_NAME, TESTE_COLETAS_HEADERS, [], []));

    // Abas que o próprio Code.gs sabe criar, para sair com o formato oficial.
    getRouteChangesSheet_();
    getClientChangesSheet_();
    getAgendamentosSheet_();
    getCadastroSheet_(CADASTRO_PONTOS_SHEET_NAME, CADASTRO_PONTOS_HEADERS);
    getCadastroSheet_(CADASTRO_ROTEIROS_SHEET_NAME, CADASTRO_ROTEIROS_HEADERS);
    relatorio.push('Abas AlteracoesRoteiros, AlteracoesClientes, ' + AGENDAMENTOS_SHEET_NAME + ', ' +
        CADASTRO_PONTOS_SHEET_NAME + ' e ' + CADASTRO_ROTEIROS_SHEET_NAME + ': prontas.');

    if (!props.getProperty('ROUTE_CHANGES_TOKEN')) {
        var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 48);
        props.setProperty('ROUTE_CHANGES_TOKEN', token);
        relatorio.push('ROUTE_CHANGES_TOKEN gerado: ' + token + '  (cole este valor no campo de token da tela Admin do app)');
    } else {
        relatorio.push('ROUTE_CHANGES_TOKEN: já configurado (mantido).');
    }

    var pastaCsv = garantirPastaTeste_(props, 'DRIVE_FOLDER_ID', 'SATELITE teste - CSV', relatorio);
    garantirPastaTeste_(props, 'CHECKLISTS_FOLDER_ID', 'SATELITE teste - Checklists', relatorio);
    relatorio.push(criarCsvTeste_(pastaCsv, ids));

    relatorio.push('Pronto. Próximos passos: implante como Web App (Executar como: Eu; Acesso: Qualquer pessoa), ' +
        'copie a URL /exec para a tela Admin do app e rode verificarTeste().');
    Logger.log(relatorio.join('\n'));
    return relatorio;
}

// Confere a cópia de teste sem alterar dados (só garante as abas do cadastro).
function verificarTeste() {
    var props = PropertiesService.getScriptProperties();
    var itens = [];
    function item(nome, ok, detalhe) { itens.push({ item: nome, ok: Boolean(ok), detalhe: detalhe || '' }); }

    var spreadsheetId = props.getProperty('SPREADSHEET_ID');
    item('Propriedade SPREADSHEET_ID', spreadsheetId);
    var token = props.getProperty('ROUTE_CHANGES_TOKEN') || '';
    item('Propriedade ROUTE_CHANGES_TOKEN (mín. 32 caracteres)', /^[A-Za-z0-9_-]{32,}$/.test(token));
    item('Propriedade DRIVE_FOLDER_ID', props.getProperty('DRIVE_FOLDER_ID'));
    item('Propriedade CHECKLISTS_FOLDER_ID', props.getProperty('CHECKLISTS_FOLDER_ID'));

    if (spreadsheetId) {
        var ss = SpreadsheetApp.openById(spreadsheetId);
        [['tblRoteiros', TESTE_TBL_ROTEIROS_HEADERS], ['shtClientes', TESTE_SHT_CLIENTES_HEADERS],
            ['tblRotas', TESTE_TBL_ROTAS_HEADERS], [COLETAS_SHEET_NAME, TESTE_COLETAS_HEADERS]
        ].forEach(function (par) {
            var sheet = ss.getSheetByName(par[0]);
            if (!sheet || sheet.getLastRow() === 0) { item('Aba ' + par[0], false, 'não encontrada'); return; }
            var header = sheet.getRange(1, 1, 1, par[1].length).getValues()[0].map(String);
            item('Aba ' + par[0] + ' (cabeçalho)', header.join('|') === par[1].join('|'), header.join(', '));
        });
    }

    var status = JSON.parse(doGet({ parameter: { action: 'status' } }).getContent());
    item('API do GAS na versão 14 ou mais', status.apiVersion >= 14, 'apiVersion ' + status.apiVersion);
    var cadastro = JSON.parse(cadastroSync_({ token: token, since: 0, pontos: [], roteiros: [] }).getContent());
    item('cadastroSync responde', cadastro.ok, cadastro.error || ('rev ' + cadastro.rev));
    var planilha = JSON.parse(doGet({ parameter: {} }).getContent());
    item('Leitura de roteiros pelas abas', planilha.ok && planilha.counts && planilha.counts.pontos > 0,
        planilha.error || ((planilha.counts ? planilha.counts.pontos : 0) + ' pontos'));
    var csv = JSON.parse(doGet({ parameter: { action: 'roteirosCsv' } }).getContent());
    item('Leitura do CSV no Drive', csv.ok, csv.error || csv.modifiedTime);

    Logger.log(itens.map(function (i) { return (i.ok ? 'OK    ' : 'FALHA ') + i.item + (i.detalhe ? ' - ' + i.detalhe : ''); }).join('\n'));
    return itens;
}

// Cria a aba com cabeçalho e linhas de exemplo, sem nunca sobrescrever dados.
// colunasTexto: colunas (base 1) gravadas como texto, para manter zeros à esquerda.
function escreverAbaTeste_(ss, nome, headers, linhas, colunasTexto) {
    var sheet = ss.getSheetByName(nome);
    if (sheet && sheet.getLastRow() > 1) return 'Aba ' + nome + ': já tem dados, mantida como está.';
    if (!sheet) sheet = ss.insertSheet(nome);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    if (linhas.length) {
        colunasTexto.forEach(function (coluna) {
            sheet.getRange(2, coluna, linhas.length, 1).setNumberFormat('@');
        });
        sheet.getRange(2, 1, linhas.length, headers.length).setValues(linhas);
    }
    return 'Aba ' + nome + ': criada' + (linhas.length ? ' com ' + linhas.length + ' linha(s) de exemplo.' : ' (só o cabeçalho).');
}

function garantirPastaTeste_(props, chave, nome, relatorio) {
    var id = props.getProperty(chave);
    if (id) {
        try {
            var existente = DriveApp.getFolderById(id);
            relatorio.push(chave + ': pasta existente mantida.');
            return existente;
        } catch (err) {
            relatorio.push(chave + ' aponta para uma pasta inacessível; criando outra.');
        }
    }
    var pasta = DriveApp.createFolder(nome);
    props.setProperty(chave, pasta.getId());
    relatorio.push(chave + ': pasta "' + nome + '" criada no seu Drive.');
    return pasta;
}

// Gera o cstExportaCheckList.csv de exemplo (mesmo formato que o app importa e exporta).
function criarCsvTeste_(pasta, idsCliente) {
    if (pasta.getFilesByName(CSV_FILE_NAME).hasNext()) {
        return 'CSV ' + CSV_FILE_NAME + ': já existe na pasta, mantido.';
    }
    function campo(valor) {
        var texto = String(valor === null || valor === undefined ? '' : valor);
        return /[;"\r\n]/.test(texto) ? '"' + texto.replace(/"/g, '""') + '"' : texto;
    }
    var linhas = [TESTE_CSV_COLUNAS.join(';')];
    TESTE_ROTAS.forEach(function (rota) {
        var cliente = TESTE_CLIENTES.filter(function (c) { return c.idPJ === rota.idPJ; })[0];
        var roteiro = TESTE_ROTEIROS.filter(function (r) { return r.id === rota.idRoteiro; })[0];
        linhas.push([roteiro.nome + '-' + rota.ordem, rota.idRota, rota.inativo ? 1 : 0,
            rota.ordem.toFixed(2).replace('.', ','), roteiro.nome, cliente.nome, cliente.logradouro,
            cliente.numero, cliente.cep, cliente.complemento, cliente.tel1, cliente.tel2, roteiro.tipo,
            idsCliente[cliente.idPJ]].map(campo).join(';'));
    });
    pasta.createFile(Utilities.newBlob(linhas.join('\r\n'), 'text/csv', CSV_FILE_NAME));
    return 'CSV ' + CSV_FILE_NAME + ': criado na pasta com ' + TESTE_ROTAS.length + ' pontos de exemplo.';
}
