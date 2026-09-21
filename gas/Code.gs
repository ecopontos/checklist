/**
 * Google Apps Script Web App bridge for the SATELITE v3 checklist app.
 * Deploy as Web App (Execute as: Me, Who has access: Anyone).
 *
 * Script Properties required (Project Settings > Script Properties):
 *   SPREADSHEET_ID        - id of the Google Sheet (coletas + abas de roteiros)
 *   CHECKLISTS_FOLDER_ID   - id of the Drive folder that receives checklist PDFs
 *   ROUTE_CHANGES_TOKEN    - shared token used by apps and the Access frontend
 */

var TBL_ROTAS = 'tblRotas';
var TBL_CLIENTES = 'shtClientes';
var TBL_ROTEIROS = 'tblRoteiros';
var COLETAS_SHEET_NAME = 'Coletas';
var AGENDAMENTOS_SHEET_NAME = 'verdesagendados';
var AGENDAMENTOS_HEADERS = [
    'ID', 'Cliente', 'Endereço', 'Materiais', 'Data Prevista', 'Sincronizado Em'
];
var AGENDAMENTOS_FOTOS_SUBFOLDER = 'AgendamentosFotos';
var AGENDAMENTO_FOTO_NOME_RE = /^foto_[123]\.(jpg|jpeg|png)$/i;
var AGENDAMENTO_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
var AGENDAMENTO_FOTO_MAX_BYTES = 8 * 1024 * 1024;
var ROUTE_CHANGES_SHEET_NAME = 'AlteracoesRoteiros';
var ROUTE_CHANGES_HEADERS = [
    'Change ID', 'ID Rota', 'Inativo', 'Ordem', 'Roteiro', 'Alterado Em',
    'Origem', 'Status', 'Recebido Em', 'Processado Em', 'Mensagem'
];
var ROUTE_CHANGES_MAX_DELIVERY = 2000;
var CLIENT_CHANGES_SHEET_NAME = 'AlteracoesClientes';
var CLIENT_CHANGES_HEADERS = [
    'Change ID', 'ID Cliente', 'Campos', 'Alterado Em', 'Origem',
    'Status', 'Recebido Em', 'Processado Em', 'Mensagem'
];
var CLIENT_EDITABLE_FIELDS = ['Cliente', 'Número', 'Complemento', 'CEP', 'Telefone1', 'Telefone2'];
var GAS_API_VERSION = 11;
var INTERCORRENCIAS_ATUAIS_CACHE_KEY = 'intercorrenciasAtuais:v1';
// Consultas de última coleta varrem apenas as linhas mais recentes da aba
// Coletas (append-only, cronológica). Varrer a aba inteira chega a ~37s e pode
// estourar o limite do GAS. Se o roteiro não aparecer na janela, há fallback
// para varredura completa.
var COLETAS_RECENT_ROWS = 8000;

function getConfig_() {
    var props = PropertiesService.getScriptProperties();
    return {
        spreadsheetId: props.getProperty('SPREADSHEET_ID'),
        checklistsFolderId: props.getProperty('CHECKLISTS_FOLDER_ID'),
        routeChangesToken: props.getProperty('ROUTE_CHANGES_TOKEN')
    };
}

function jsonResponse_(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
        .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
    var params = (e && e.parameter) || {};

    if (params.action === 'status') {
        return jsonResponse_({
            ok: true,
            service: 'satelite-gas',
            apiVersion: GAS_API_VERSION,
            routeChangesConfigured: Boolean(getConfig_().routeChangesToken)
        });
    }

    if (params.action === 'alteracoesRoteiros') {
        return getPendingRouteChanges_(params.token || '');
    }

    if (params.action === 'ultimaColeta') {
        return getUltimaColeta_(params.roteiro || '');
    }

    if (params.action === 'ultimaColetaDetalhada') {
        return getUltimaColetaDetalhada_(params.roteiro || '');
    }

    if (params.action === 'intercorrenciasRoteiro') {
        return getIntercorrenciasRoteiro_(params.roteiro || '');
    }

    if (params.action === 'intercorrenciasAtuais') {
        return getIntercorrenciasAtuais_();
    }

    if (params.action === 'agendamentos') {
        return getAgendamentos_(params.data || '');
    }

    if (params.action === 'agendamentoFotos') {
        return getAgendamentoFotos_(params.id || '', params.incluirBase64 === 'true');
    }

    // Fonte de roteiros: antes um CSV no Drive (exportado do Access), agora
    // montada direto das abas do Sheets. Vale como action=roteiros e como padrão.
    return getRoteirosFlat_();
}

// L\u00EA tblRotas + shtClientes + tblRoteiros e devolve a vis\u00E3o achatada que o app
// j\u00E1 consome (mesmas colunas do antigo CSV). Substitui a leitura do
// cstExportaCheckList.csv no Drive.
function getRoteirosFlat_() {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID n\u00E3o configurado' });
    }

    var ss;
    try {
        ss = SpreadsheetApp.openById(config.spreadsheetId);
    } catch (err) {
        return jsonResponse_({ ok: false, error: 'N\u00E3o foi poss\u00EDvel abrir a planilha ' + config.spreadsheetId + ': ' + err.message });
    }

    var sheetRotas = ss.getSheetByName(TBL_ROTAS);
    var sheetClientes = ss.getSheetByName(TBL_CLIENTES);
    var sheetRoteiros = ss.getSheetByName(TBL_ROTEIROS);

    var missing = [];
    if (!sheetRotas) missing.push(TBL_ROTAS);
    if (!sheetClientes) missing.push(TBL_CLIENTES);
    if (!sheetRoteiros) missing.push(TBL_ROTEIROS);
    if (missing.length) {
        return jsonResponse_({ ok: false, error: 'Aba(s) n\u00E3o encontrada(s): ' + missing.join(', ') });
    }

    try {
        var flat = buildFlatRoteiros_(
            sheetRotas.getDataRange().getValues(),
            sheetClientes.getDataRange().getValues(),
            sheetRoteiros.getDataRange().getValues()
        );

        // "S\u00F3 reimporta quando muda": usa a data de modifica\u00E7\u00E3o da planilha.
        // Muda a cada edi\u00E7\u00E3o de qualquer aba; reimportar a mais \u00E9 barato (o
        // upsert \u00E9 idempotente). Se falhar, cai para agora (reimport inofensivo).
        var modifiedTime;
        try {
            modifiedTime = DriveApp.getFileById(config.spreadsheetId).getLastUpdated().toISOString();
        } catch (e) {
            modifiedTime = new Date().toISOString();
        }

        return jsonResponse_({
            ok: true,
            apiVersion: GAS_API_VERSION,
            modifiedTime: modifiedTime,
            count: flat.rows.length,
            skipped: flat.skipped,
            rows: flat.rows
        });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

// Fun\u00E7\u00E3o pura (sem chamadas ao Sheets), test\u00E1vel: recebe as matrizes de
// getValues() das 3 abas e devolve a vis\u00E3o achatada. Junta tblRotas -> cliente
// por idPJ e -> roteiro por idRoteiro.
function buildFlatRoteiros_(rotasValues, clientesValues, roteirosValues) {
    if (!rotasValues || rotasValues.length < 2) return { rows: [], skipped: 0 };

    function headerMap_(headers) {
        var map = {};
        for (var i = 0; i < headers.length; i++) {
            var col = String(headers[i]).trim();
            if (col) map[col] = i;
        }
        return map;
    }

    var mapRotas = headerMap_(rotasValues[0]);
    var mapClientes = headerMap_(clientesValues[0]);
    var mapRoteiros = headerMap_(roteirosValues[0]);

    var clientesByIdPJ = {};
    for (var c = 1; c < clientesValues.length; c++) {
        var rowC = clientesValues[c];
        var keyPJ = cleanIntString_(rowC[mapClientes['idPJ']]);
        if (!keyPJ) continue;
        clientesByIdPJ[keyPJ] = {
            idCliente: String(rowC[mapClientes['idUnico2']] || '').trim(),
            Cliente: String(rowC[mapClientes['Cliente']] || '').trim(),
            Numero: cleanIntString_(rowC[mapClientes['N\u00FAmero']]),
            Complemento: String(rowC[mapClientes['Complemento']] || '').trim(),
            CEP: cleanIntString_(rowC[mapClientes['CEP']]),
            Telefone1: formatPhone_(rowC[mapClientes['Telefone1']]),
            Telefone2: formatPhone_(rowC[mapClientes['Telefone2']])
        };
    }

    var roteirosById = {};
    for (var t = 1; t < roteirosValues.length; t++) {
        var rowT = roteirosValues[t];
        var keyRoteiro = cleanIntString_(rowT[mapRoteiros['idRoteiro']]);
        if (!keyRoteiro) continue;
        roteirosById[keyRoteiro] = {
            nome: String(rowT[mapRoteiros['Roteiro']] || '').trim(),
            tipoResiduo: String(rowT[mapRoteiros['Tipo de Resíduo']] || '').trim()
        };
    }

    var rows = [];
    var skipped = 0;
    for (var r = 1; r < rotasValues.length; r++) {
        var rowR = rotasValues[r];
        var cliente = clientesByIdPJ[cleanIntString_(rowR[mapRotas['idPJ']])];

        // Ponto sem cliente correspondente: o app j\u00E1 o descartaria (sem nome).
        if (!cliente || !cliente.Cliente) { skipped++; continue; }

        var ordemVal = rowR[mapRotas['Ordem']];
        var inativoVal = rowR[mapRotas['Inativo']];

        var roteiroInfo = roteirosById[cleanIntString_(rowR[mapRotas['idRoteiro']])] || { nome: '', tipoResiduo: '' };
        rows.push({
            Roteiro: roteiroInfo.nome,
            TipoResiduo: roteiroInfo.tipoResiduo,
            idCliente: cliente.idCliente,
            Cliente: cliente.Cliente,
            idRota: cleanIntString_(rowR[mapRotas['idRota']]),
            Ordem: (ordemVal !== '' && ordemVal !== null && !isNaN(ordemVal)) ? Number(ordemVal) : 0,
            'N\u00FAmero': cliente.Numero,
            Complemento: cliente.Complemento,
            CEP: cliente.CEP,
            Inativo: (inativoVal === true || String(inativoVal).trim() === '1' || String(inativoVal).toLowerCase() === 'true') ? 1 : 0,
            Telefone1: cliente.Telefone1,
            Telefone2: cliente.Telefone2
        });
    }

    return { rows: rows, skipped: skipped };
}

// Remove o ".0" artificial que o Sheets pode anexar a inteiros (o app trata
// N\u00FAmero/CEP/idRota como texto). No Apps Script os n\u00FAmeros normalmente j\u00E1
// chegam sem o ".0"; o regex cobre o caso de c\u00E9lula textual.
function cleanIntString_(val) {
    if (val === undefined || val === null || val === '') return '';
    return String(val).trim().replace(/\.0+$/, '');
}

function formatPhone_(val) {
    if (val === undefined || val === null || val === '') return '';
    if (typeof val === 'number') return val.toFixed(0);
    return String(val).trim().replace(/\.0+$/, '');
}

function getUltimaColeta_(roteiroNome) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }
    if (!roteiroNome) {
        return jsonResponse_({ ok: false, error: 'Parâmetro roteiro ausente' });
    }

    try {
        var ss = SpreadsheetApp.openById(config.spreadsheetId);
        var sheet = ss.getSheetByName(COLETAS_SHEET_NAME);
        if (!sheet || sheet.getLastRow() < 2) {
            return jsonResponse_({ ok: true, data: null });
        }

        var roteiroAlvo = roteiroNome.trim();
        var lastRow = sheet.getLastRow();

        // Cache com chave que inclui lastRow: novas coletas mudam lastRow e
        // invalidam a entrada automaticamente. Evita revarrer a aba Coletas
        // (que pode ter milhares de linhas) a cada geração de checklist.
        var cache = CacheService.getScriptCache();
        var cacheKey = 'uc:' + lastRow + ':' + roteiroAlvo;
        var cached = cache.get(cacheKey);
        if (cached !== null) {
            return jsonResponse_({ ok: true, data: cached === '' ? null : cached });
        }

        var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        var colData = header.indexOf('Data');
        var colRoteiro = header.indexOf('Roteiro');
        if (colData === -1 || colRoteiro === -1) {
            return jsonResponse_({ ok: false, error: 'Colunas Data/Roteiro não encontradas na aba ' + COLETAS_SHEET_NAME });
        }

        // Lê apenas o intervalo de colunas necessário (Data..Roteiro) e apenas
        // as linhas mais recentes.
        var minCol = Math.min(colData, colRoteiro);
        var width = Math.max(colData, colRoteiro) - minCol + 1;
        var dOff = colData - minCol;
        var rOff = colRoteiro - minCol;

        function scanLastDate(startRow) {
            var num = lastRow - startRow + 1;
            if (num < 1) return null;
            var values = sheet.getRange(startRow, minCol + 1, num, width).getValues();
            var ld = null;
            for (var i = 0; i < values.length; i++) {
                if (String(values[i][rOff]).trim() !== roteiroAlvo) continue;
                var normalized = normalizeDateValue_(values[i][dOff]);
                if (normalized && (!ld || normalized > ld)) {
                    ld = normalized;
                }
            }
            return ld;
        }

        var recentStart = Math.max(2, lastRow - COLETAS_RECENT_ROWS + 1);
        var lastDate = scanLastDate(recentStart);
        // Fallback: roteiro não coletado dentro da janela recente — varre tudo.
        if (!lastDate && recentStart > 2) {
            lastDate = scanLastDate(2);
        }

        cache.put(cacheKey, lastDate || '', 21600);
        return jsonResponse_({ ok: true, data: lastDate });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function normalizeDateValue_(value) {
    if (!value) return null;
    if (Object.prototype.toString.call(value) === '[object Date]') {
        return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }
    var match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : null;
}

function getUltimaColetaDetalhada_(roteiroNome) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }
    if (!roteiroNome) {
        return jsonResponse_({ ok: false, error: 'Parâmetro roteiro ausente' });
    }

    try {
        var ss = SpreadsheetApp.openById(config.spreadsheetId);
        var sheet = ss.getSheetByName(COLETAS_SHEET_NAME);
        if (!sheet || sheet.getLastRow() < 2) {
            return jsonResponse_({ ok: true, data: [] });
        }

        var roteiroAlvo = roteiroNome.trim();
        var lastRow = sheet.getLastRow();

        var cache = CacheService.getScriptCache();
        var cacheKey = 'ucd:' + lastRow + ':' + roteiroAlvo;
        var cached = cache.get(cacheKey);
        if (cached !== null) {
            return jsonResponse_({ ok: true, data: JSON.parse(cached) });
        }

        var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        var colIdRota = header.indexOf('ID Rota');
        var colData = header.indexOf('Data');
        var colRoteiro = header.indexOf('Roteiro');
        var colQuantidade = header.indexOf('Quantidade');
        if (colIdRota === -1 || colData === -1 || colRoteiro === -1 || colQuantidade === -1) {
            return jsonResponse_({ ok: false, error: 'Colunas ID Rota/Data/Roteiro/Quantidade não encontradas na aba ' + COLETAS_SHEET_NAME });
        }

        var wanted = [colIdRota, colData, colRoteiro, colQuantidade];
        var minCol = Math.min.apply(null, wanted);
        var width = Math.max.apply(null, wanted) - minCol + 1;
        var iOff = colIdRota - minCol;
        var dOff = colData - minCol;
        var rOff = colRoteiro - minCol;
        var qOff = colQuantidade - minCol;

        // Varre apenas as linhas recentes (ver getUltimaColeta_). Retorna os
        // recipientes coletados na data mais recente do roteiro, ou null se o
        // roteiro não aparecer no intervalo (dispara o fallback completo).
        function computeFromRange(startRow) {
            var num = lastRow - startRow + 1;
            if (num < 1) return null;
            var values = sheet.getRange(startRow, minCol + 1, num, width).getValues();
            var ld = null;
            for (var i = 0; i < values.length; i++) {
                if (String(values[i][rOff]).trim() !== roteiroAlvo) continue;
                var normalized = normalizeDateValue_(values[i][dOff]);
                if (normalized && (!ld || normalized > ld)) {
                    ld = normalized;
                }
            }
            if (!ld) return null;
            var pontos = {};
            for (var j = 0; j < values.length; j++) {
                if (String(values[j][rOff]).trim() !== roteiroAlvo) continue;
                if (normalizeDateValue_(values[j][dOff]) !== ld) continue;
                var idRota = String(values[j][iOff]).trim();
                if (!idRota) continue;
                var quantidade = Number(values[j][qOff]) || 0;
                if (quantidade > 0) {
                    pontos[idRota] = quantidade;
                }
            }
            return Object.keys(pontos).map(function (idRota) {
                return { id_rota: idRota, quantidade: pontos[idRota] };
            });
        }

        var recentStart = Math.max(2, lastRow - COLETAS_RECENT_ROWS + 1);
        var data = computeFromRange(recentStart);
        // Fallback: roteiro não coletado dentro da janela recente — varre tudo.
        if (data === null && recentStart > 2) {
            data = computeFromRange(2);
        }
        if (data === null) data = [];

        cache.put(cacheKey, JSON.stringify(data), 21600);
        return jsonResponse_({ ok: true, data: data });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

// Le a aba Coletas e devolve, por cliente do roteiro pedido, a intercorrencia
// da coleta MAIS RECENTE desse cliente (nao a data mais recente do roteiro
// inteiro, como em getUltimaColetaDetalhada_ — um cliente pode ter sido
// coletado num dia diferente do resto do roteiro). Nao filtra por
// quantidade: uma intercorrencia tipica ("recusou coleta", "sem bombona") e
// registrada com quantidade 0, e getUltimaColetaDetalhada_ descartaria
// exatamente esses registros.
function getIntercorrenciasRoteiro_(roteiroNome) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }
    if (!roteiroNome) {
        return jsonResponse_({ ok: false, error: 'Parâmetro roteiro ausente' });
    }

    try {
        var ss = SpreadsheetApp.openById(config.spreadsheetId);
        var sheet = ss.getSheetByName(COLETAS_SHEET_NAME);
        if (!sheet || sheet.getLastRow() < 2) {
            return jsonResponse_({ ok: true, data: [] });
        }

        var roteiroAlvo = roteiroNome.trim();
        var lastRow = sheet.getLastRow();

        var cache = CacheService.getScriptCache();
        var cacheKey = 'ic:' + lastRow + ':' + roteiroAlvo;
        var cached = cache.get(cacheKey);
        if (cached !== null) {
            return jsonResponse_({ ok: true, data: JSON.parse(cached) });
        }

        var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        var colIdRota = header.indexOf('ID Rota');
        var colData = header.indexOf('Data');
        var colRoteiro = header.indexOf('Roteiro');
        var colIntercorrencia = header.indexOf('Intercorrência');
        if (colIdRota === -1 || colData === -1 || colRoteiro === -1 || colIntercorrencia === -1) {
            return jsonResponse_({ ok: false, error: 'Colunas ID Rota/Data/Roteiro/Intercorrência não encontradas na aba ' + COLETAS_SHEET_NAME });
        }

        var wanted = [colIdRota, colData, colRoteiro, colIntercorrencia];
        var minCol = Math.min.apply(null, wanted);
        var width = Math.max.apply(null, wanted) - minCol + 1;
        var iOff = colIdRota - minCol;
        var dOff = colData - minCol;
        var rOff = colRoteiro - minCol;
        var xOff = colIntercorrencia - minCol;

        function computeFromRange(startRow) {
            var num = lastRow - startRow + 1;
            if (num < 1) return null;
            var values = sheet.getRange(startRow, minCol + 1, num, width).getValues();
            var ultimaPorPonto = {};
            var achouRoteiro = false;
            for (var i = 0; i < values.length; i++) {
                if (String(values[i][rOff]).trim() !== roteiroAlvo) continue;
                achouRoteiro = true;
                var idRota = String(values[i][iOff]).trim();
                if (!idRota) continue;
                var normalized = normalizeDateValue_(values[i][dOff]);
                if (!normalized) continue;
                var atual = ultimaPorPonto[idRota];
                if (!atual || normalized > atual.data) {
                    ultimaPorPonto[idRota] = {
                        data: normalized,
                        intercorrencia: String(values[i][xOff] || '').trim()
                    };
                }
            }
            // achouRoteiro=false sinaliza "roteiro nao aparece nesta janela",
            // dispara o fallback de varredura completa. achouRoteiro=true com
            // ultimaPorPonto vazio (ou so intercorrencias vazias) e um
            // resultado valido: retorna [] em vez de forcar a varredura toda.
            if (!achouRoteiro) return null;
            return Object.keys(ultimaPorPonto)
                .map(function (idRota) {
                    return {
                        id_rota: idRota,
                        data: ultimaPorPonto[idRota].data,
                        intercorrencia: ultimaPorPonto[idRota].intercorrencia
                    };
                })
                .filter(function (ponto) { return ponto.intercorrencia !== ''; });
        }

        var recentStart = Math.max(2, lastRow - COLETAS_RECENT_ROWS + 1);
        var data = computeFromRange(recentStart);
        if (data === null && recentStart > 2) {
            data = computeFromRange(2);
        }
        if (data === null) data = [];

        cache.put(cacheKey, JSON.stringify(data), 21600);
        return jsonResponse_({ ok: true, data: data });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function normalizeOccurrenceInstant_(value) {
    return Object.prototype.toString.call(value) === '[object Date]'
        ? value.toISOString()
        : String(value == null ? '' : value).trim();
}

function legacyOccurrenceId_(item) {
    var canonical = JSON.stringify([
        item.idRota, item.data, item.cliente, item.roteiro,
        String(item.quantidade), item.intercorrencia, item.sincronizadoEm
    ]);
    var digest = Utilities.computeDigest(
        Utilities.DigestAlgorithm.SHA_256,
        canonical,
        Utilities.Charset.UTF_8
    );
    return 'legacy:' + digest.map(function (byte) {
        return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
    }).join('');
}

function buildIntercorrenciasAtuais_(values) {
    var quality = {
        invalidDates: 0,
        missingRouteIds: 0,
        legacyIds: 0,
        excludedRecords: 0
    };
    if (!Array.isArray(values) || values.length < 2) {
        return { data: [], quality: quality };
    }

    var columns = Object.create(null);
    values[0].forEach(function (header, index) {
        columns[String(header == null ? '' : header).trim()] = index;
    });
    var required = ['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID'];
    for (var r = 0; r < required.length; r++) {
        if (columns[required[r]] === undefined) {
            throw new Error('Coluna ' + required[r] + ' não encontrada na aba ' + COLETAS_SHEET_NAME);
        }
    }

    var colIdRota = columns['ID Rota'];
    var colData = columns['Data'];
    var colCliente = columns['Cliente'];
    var colRoteiro = columns['Roteiro'];
    var colQuantidade = columns['Quantidade'];
    var colIntercorrencia = columns['Intercorrência'];
    var colSincronizadoEm = columns['Sincronizado Em'];
    var colSyncId = columns['Sync ID'];
    var latestByRoute = Object.create(null);

    for (var i = 1; i < values.length; i++) {
        var row = values[i];
        if (row.every(function (value) { return value === '' || value === null; })) continue;

        var idRota = String(row[colIdRota] == null ? '' : row[colIdRota]).trim();
        var data = normalizeHistoryDate_(row[colData]);
        if (!data) quality.invalidDates++;
        if (!idRota) quality.missingRouteIds++;
        if (!data || !idRota) {
            quality.excludedRecords++;
            continue;
        }

        if (!String(row[colSyncId] == null ? '' : row[colSyncId]).trim()) {
            quality.legacyIds++;
        }
        var current = latestByRoute[idRota];
        if (!current || data > current.data || (data === current.data && i > current.index)) {
            latestByRoute[idRota] = { row: row, idRota: idRota, data: data, index: i };
        }
    }

    var data = Object.keys(latestByRoute).map(function (idRota) {
        var current = latestByRoute[idRota];
        var row = current.row;
        var syncId = String(row[colSyncId] == null ? '' : row[colSyncId]).trim();
        var item = {
            idRota: current.idRota,
            data: current.data,
            cliente: String(row[colCliente] || '').trim(),
            roteiro: String(row[colRoteiro] || '').trim(),
            quantidade: Number(row[colQuantidade]),
            intercorrencia: String(row[colIntercorrencia] || '').trim(),
            sincronizadoEm: normalizeOccurrenceInstant_(row[colSincronizadoEm])
        };
        return {
            occurrenceId: syncId || legacyOccurrenceId_(item),
            idRota: item.idRota,
            data: item.data,
            cliente: item.cliente,
            roteiro: item.roteiro,
            intercorrencia: item.intercorrencia
        };
    }).filter(function (item) { return item.intercorrencia !== ''; });

    return { data: data, quality: quality };
}

function getIntercorrenciasAtuais_() {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }

    try {
        var cache = null;
        try { cache = CacheService.getScriptCache(); } catch (_) { /* cache é opcional */ }
        var cached = null;
        if (cache) {
            try { cached = cache.get(INTERCORRENCIAS_ATUAIS_CACHE_KEY); } catch (_) { /* cache é opcional */ }
        }
        if (cached !== null) {
            try { return jsonResponse_(JSON.parse(cached)); } catch (_) { /* cache inválido equivale a miss */ }
        }

        var ss = SpreadsheetApp.openById(config.spreadsheetId);
        var sheet = ss.getSheetByName(COLETAS_SHEET_NAME);
        if (!sheet) {
            return jsonResponse_({ ok: false, error: 'Aba ' + COLETAS_SHEET_NAME + ' não encontrada' });
        }
        var result = {
            ok: true,
            apiVersion: GAS_API_VERSION,
            source: 'intercorrenciasAtuais',
            generatedAt: new Date().toISOString(),
            data: [],
            quality: { invalidDates: 0, missingRouteIds: 0, legacyIds: 0, excludedRecords: 0 }
        };
        if (sheet.getLastRow() >= 2) {
            var values = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getValues();
            var built = buildIntercorrenciasAtuais_(values);
            result.data = built.data;
            result.quality = built.quality;
        }
        if (cache) {
            try { cache.put(INTERCORRENCIAS_ATUAIS_CACHE_KEY, JSON.stringify(result), 300); } catch (_) { /* cache é opcional */ }
        }
        return jsonResponse_(result);
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function doPost(e) {
    try {
        var body = JSON.parse(e.postData.contents);

        if (body.action === 'routeChanges') {
            return saveRouteChanges_(body.changes || [], body.token || '');
        }

        if (body.action === 'clientChanges') {
            return saveClientChanges_(body.changes || [], body.token || '');
        }

        if (body.action === 'getRouteChanges') {
            return getPendingRouteChanges_(body.token || '');
        }

        if (body.action === 'confirmRouteChanges') {
            return confirmRouteChanges_(
                body.changeIds || [],
                body.token || '',
                body.message || ''
            );
        }

        if (body.action === 'syncAgendamentos') {
            return syncAgendamentos_(body.ops || []);
        }

        if (body.action === 'uploadAgendamentoFotos') {
            return uploadAgendamentoFotos_(body.id || '', body.fotos || [], body.remover || []);
        }

        if (body.checklist) {
            return saveChecklist_(body.checklist);
        }

        return saveColetas_(body.coletas || []);
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function textResponse_(text) {
    return ContentService.createTextOutput(text)
        .setMimeType(ContentService.MimeType.TEXT);
}

function routeChangesAuthError_(providedToken) {
    var expectedToken = getConfig_().routeChangesToken;
    if (!expectedToken) return 'ROUTE_CHANGES_TOKEN não configurado no GAS';
    if (!safeEqual_(String(providedToken || ''), String(expectedToken))) {
        return 'Token de alterações de roteiros inválido';
    }
    return '';
}

function safeEqual_(left, right) {
    if (left.length !== right.length) return false;
    var difference = 0;
    for (var i = 0; i < left.length; i++) {
        difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
    }
    return difference === 0;
}

function getRouteChangesSheet_() {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        throw new Error('SPREADSHEET_ID não configurado');
    }

    var spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
    var sheet = spreadsheet.getSheetByName(ROUTE_CHANGES_SHEET_NAME);
    if (!sheet) {
        sheet = spreadsheet.insertSheet(ROUTE_CHANGES_SHEET_NAME);
        sheet.getRange(1, 1, 1, ROUTE_CHANGES_HEADERS.length)
            .setValues([ROUTE_CHANGES_HEADERS]);
        sheet.setFrozenRows(1);
        return sheet;
    }

    if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, ROUTE_CHANGES_HEADERS.length)
            .setValues([ROUTE_CHANGES_HEADERS]);
        sheet.setFrozenRows(1);
        return sheet;
    }

    var header = sheet.getRange(1, 1, 1, ROUTE_CHANGES_HEADERS.length)
        .getValues()[0];
    for (var i = 0; i < ROUTE_CHANGES_HEADERS.length; i++) {
        if (String(header[i]) !== ROUTE_CHANGES_HEADERS[i]) {
            throw new Error('Cabeçalho inválido na aba ' + ROUTE_CHANGES_SHEET_NAME);
        }
    }
    return sheet;
}

function normalizeRouteChange_(change) {
    var changeId = String(change.change_id || change.changeId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(changeId)) {
        throw new Error('Change ID inválido');
    }

    var idRota = String(change.id_rota || change.idRota || '').trim();
    if (!/^\d+$/.test(idRota) || Number(idRota) <= 0) {
        throw new Error('ID Rota inválido para ' + changeId);
    }

    var rawInativo = change.inativo;
    if (![true, false, 0, 1, '0', '1'].some(function (value) {
        return value === rawInativo;
    })) {
        throw new Error('Inativo inválido para ' + changeId);
    }
    var inativo = rawInativo === true || rawInativo === 1 || rawInativo === '1';

    var ordem = Number(change.ordem);
    if (!Number.isFinite(ordem) || ordem < 0) {
        throw new Error('Ordem inválida para ' + changeId);
    }

    var roteiro = String(change.roteiro || '').trim();
    if (!roteiro || roteiro.length > 255 || /[\t\r\n]/.test(roteiro)) {
        throw new Error('Roteiro inválido para ' + changeId);
    }

    var alteredAt = new Date(change.alterado_em || change.alteradoEm || '');
    if (isNaN(alteredAt.getTime())) {
        throw new Error('Data da alteração inválida para ' + changeId);
    }

    var origem = String(change.origem || '').trim();
    if (!origem || origem.length > 100 || /[\t\r\n]/.test(origem)) {
        throw new Error('Origem inválida para ' + changeId);
    }

    return {
        changeId: changeId,
        idRota: Number(idRota),
        inativo: inativo ? 1 : 0,
        ordem: ordem,
        roteiro: roteiro,
        alteredAt: alteredAt.toISOString(),
        origem: origem
    };
}

function saveRouteChanges_(changes, token) {
    var authError = routeChangesAuthError_(token);
    if (authError) return jsonResponse_({ ok: false, error: authError });
    if (!Array.isArray(changes) || changes.length > 100) {
        return jsonResponse_({ ok: false, error: 'O lote deve conter no máximo 100 alterações' });
    }

    try {
        var normalized = changes.map(normalizeRouteChange_);
        var lock = LockService.getScriptLock();
        lock.waitLock(30000);
        try {
            var sheet = getRouteChangesSheet_();
            var lastRow = sheet.getLastRow();
            var existingValues = lastRow > 1
                ? sheet.getRange(2, 1, lastRow - 1, 1).getValues()
                : [];
            var existingIds = {};
            existingValues.forEach(function (row) {
                existingIds[String(row[0])] = true;
            });

            var now = new Date().toISOString();
            var rows = [];
            var acceptedIds = [];
            var duplicateIds = [];
            var accepted = [];
            normalized.forEach(function (change) {
                if (existingIds[change.changeId]) {
                    duplicateIds.push(change.changeId);
                    return;
                }
                existingIds[change.changeId] = true;
                acceptedIds.push(change.changeId);
                accepted.push(change);
                rows.push([
                    change.changeId,
                    change.idRota,
                    change.inativo,
                    change.ordem,
                    change.roteiro,
                    change.alteredAt,
                    change.origem,
                    'PENDENTE',
                    now,
                    '',
                    ''
                ]);
            });

            // Aplica em tblRotas ANTES de gravar o log de auditoria: se a
            // aplicacao falhar, o log nao e escrito e o reenvio reprocessa como
            // aceito (aplicar Ordem/Inativo e idempotente, repetir e seguro).
            var applyResult = applyRouteChangesToRotas_(accepted);

            if (rows.length) {
                sheet.getRange(
                    sheet.getLastRow() + 1,
                    1,
                    rows.length,
                    ROUTE_CHANGES_HEADERS.length
                ).setValues(rows);
            }

            return jsonResponse_({
                ok: true,
                count: acceptedIds.length,
                acceptedIds: acceptedIds,
                duplicateIds: duplicateIds,
                skippedApply: applyResult.skipped.length
            });
        } finally {
            lock.releaseLock();
        }
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

// Aplica as alteracoes aceitas na aba tblRotas (Ordem/Inativo), por idRota.
// Escrita direcionada apenas nas celulas alteradas, para nao sobrescrever
// edicoes manuais concorrentes. Lanca em erro de configuracao/coluna ausente.
function applyRouteChangesToRotas_(changes) {
    if (!changes || !changes.length) return { applied: 0, skipped: [] };

    var config = getConfig_();
    if (!config.spreadsheetId) throw new Error('SPREADSHEET_ID nao configurado');
    var sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(TBL_ROTAS);
    if (!sheet) throw new Error('Aba nao encontrada: ' + TBL_ROTAS);

    var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var colIdRota = header.indexOf('idRota');
    var colInativo = header.indexOf('Inativo');
    var colOrdem = header.indexOf('Ordem');
    if (colIdRota === -1) throw new Error('Coluna idRota nao encontrada em ' + TBL_ROTAS);
    if (colInativo === -1) throw new Error('Coluna Inativo nao encontrada em ' + TBL_ROTAS);
    if (colOrdem === -1) throw new Error('Coluna Ordem nao encontrada em ' + TBL_ROTAS);

    var lastRow = sheet.getLastRow();
    var idRowMap = {};
    if (lastRow > 1) {
        var idValues = sheet.getRange(2, colIdRota + 1, lastRow - 1, 1).getValues();
        for (var i = 0; i < idValues.length; i++) {
            var key = cleanIntString_(idValues[i][0]);
            if (key) idRowMap[key] = i + 2; // numero real da linha na planilha
        }
    }

    var plan = planRotaWrites_(idRowMap, changes);

    // Inativo e Ordem sao colunas adjacentes em tblRotas: grava as duas de uma
    // vez quando possivel. Inativo como booleano (respeita o checkbox).
    var adjacent = (colOrdem === colInativo + 1);
    plan.writes.forEach(function (w) {
        if (adjacent) {
            sheet.getRange(w.row, colInativo + 1, 1, 2).setValues([[w.inativo, w.ordem]]);
        } else {
            sheet.getRange(w.row, colInativo + 1).setValue(w.inativo);
            sheet.getRange(w.row, colOrdem + 1).setValue(w.ordem);
        }
    });

    return { applied: plan.writes.length, skipped: plan.skipped };
}

// Funcao pura (sem chamadas ao Sheets), testavel: dado idRota->linha e as
// alteracoes aceitas, devolve as escritas {row, ordem, inativo} e os idRota sem
// linha correspondente (skipped).
function planRotaWrites_(idRowMap, changes) {
    var writes = [];
    var skipped = [];
    for (var i = 0; i < changes.length; i++) {
        var ch = changes[i];
        var key = cleanIntString_(ch.idRota);
        var row = idRowMap[key];
        if (!row) { skipped.push(key); continue; }
        writes.push({ row: row, ordem: Number(ch.ordem), inativo: ch.inativo === 1 });
    }
    return { writes: writes, skipped: skipped };
}

// ===== Alteracoes de cliente (subprojeto B): grava campos em shtClientes =====

function saveClientChanges_(changes, token) {
    var authError = routeChangesAuthError_(token);
    if (authError) return jsonResponse_({ ok: false, error: authError });
    if (!Array.isArray(changes) || changes.length > 100) {
        return jsonResponse_({ ok: false, error: 'O lote deve conter no maximo 100 alteracoes' });
    }

    try {
        // Cada alteracao e validada individualmente: uma alteracao invalida
        // (ex: texto longo demais, com quebra de linha) e descartada sozinha
        // em vez de travar o lote inteiro - antes, um unico item invalido
        // fazia o .map() lancar e nenhuma alteracao do lote era aplicada,
        // inclusive as validas, travando a fila do cliente para sempre.
        var normalized = [];
        var invalidIds = [];
        changes.forEach(function (change) {
            try {
                normalized.push(normalizeClientChange_(change));
            } catch (err) {
                var fallbackId = String((change && (change.change_id || change.changeId)) || '').trim();
                if (fallbackId) invalidIds.push(fallbackId);
            }
        });
        var lock = LockService.getScriptLock();
        lock.waitLock(30000);
        try {
            var sheet = getClientChangesSheet_();
            var lastRow = sheet.getLastRow();
            var existingValues = lastRow > 1
                ? sheet.getRange(2, 1, lastRow - 1, 1).getValues()
                : [];
            var existingIds = {};
            existingValues.forEach(function (row) { existingIds[String(row[0])] = true; });

            var now = new Date().toISOString();
            var rows = [];
            var acceptedIds = [];
            var duplicateIds = [];
            var accepted = [];
            normalized.forEach(function (change) {
                if (existingIds[change.changeId]) {
                    duplicateIds.push(change.changeId);
                    return;
                }
                existingIds[change.changeId] = true;
                acceptedIds.push(change.changeId);
                accepted.push(change);
                rows.push([
                    change.changeId,
                    change.idCliente,
                    JSON.stringify(change.campos),
                    change.alteredAt,
                    change.origem,
                    'PENDENTE',
                    now,
                    '',
                    ''
                ]);
            });

            // Aplica em shtClientes ANTES de gravar o log (mesma logica do A):
            // se a aplicacao falhar, o log nao e escrito e o reenvio reprocessa
            // (gravar os mesmos campos e idempotente).
            var applyResult = applyClientChangesToClientes_(accepted);

            if (rows.length) {
                sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, CLIENT_CHANGES_HEADERS.length)
                    .setValues(rows);
            }

            return jsonResponse_({
                ok: true,
                count: acceptedIds.length,
                acceptedIds: acceptedIds,
                duplicateIds: duplicateIds,
                invalidIds: invalidIds,
                skippedApply: applyResult.skipped.length
            });
        } finally {
            lock.releaseLock();
        }
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function normalizeClientChange_(change) {
    var changeId = String(change.change_id || change.changeId || '').trim();
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(changeId)) {
        throw new Error('Change ID invalido');
    }

    var idCliente = String(change.id_cliente || change.idCliente || '').trim();
    if (!idCliente || idCliente.length > 100 || /[\t\r\n]/.test(idCliente)) {
        throw new Error('ID Cliente invalido para ' + changeId);
    }

    var rawCampos = change.campos;
    if (!rawCampos || typeof rawCampos !== 'object') {
        throw new Error('Campos invalidos para ' + changeId);
    }
    var campos = {};
    var count = 0;
    for (var i = 0; i < CLIENT_EDITABLE_FIELDS.length; i++) {
        var field = CLIENT_EDITABLE_FIELDS[i];
        if (Object.prototype.hasOwnProperty.call(rawCampos, field)) {
            var value = rawCampos[field];
            if (value === null || value === undefined) value = '';
            value = String(value);
            if (value.length > 255 || /[\t\r\n]/.test(value)) {
                throw new Error('Valor invalido no campo ' + field + ' para ' + changeId);
            }
            campos[field] = value;
            count++;
        }
    }
    if (!count) throw new Error('Nenhum campo editavel para ' + changeId);

    var alteredAt = new Date(change.alterado_em || change.alteradoEm || '');
    if (isNaN(alteredAt.getTime())) {
        throw new Error('Data da alteracao invalida para ' + changeId);
    }

    var origem = String(change.origem || '').trim();
    if (!origem || origem.length > 100 || /[\t\r\n]/.test(origem)) {
        throw new Error('Origem invalida para ' + changeId);
    }

    return {
        changeId: changeId,
        idCliente: idCliente,
        campos: campos,
        alteredAt: alteredAt.toISOString(),
        origem: origem
    };
}

function getClientChangesSheet_() {
    var config = getConfig_();
    if (!config.spreadsheetId) throw new Error('SPREADSHEET_ID nao configurado');
    var spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
    var sheet = spreadsheet.getSheetByName(CLIENT_CHANGES_SHEET_NAME);
    if (!sheet) {
        sheet = spreadsheet.insertSheet(CLIENT_CHANGES_SHEET_NAME);
        sheet.getRange(1, 1, 1, CLIENT_CHANGES_HEADERS.length).setValues([CLIENT_CHANGES_HEADERS]);
        sheet.setFrozenRows(1);
        return sheet;
    }
    if (sheet.getLastRow() === 0) {
        sheet.getRange(1, 1, 1, CLIENT_CHANGES_HEADERS.length).setValues([CLIENT_CHANGES_HEADERS]);
        sheet.setFrozenRows(1);
        return sheet;
    }
    var header = sheet.getRange(1, 1, 1, CLIENT_CHANGES_HEADERS.length).getValues()[0];
    for (var i = 0; i < CLIENT_CHANGES_HEADERS.length; i++) {
        if (String(header[i]) !== CLIENT_CHANGES_HEADERS[i]) {
            throw new Error('Cabecalho invalido na aba ' + CLIENT_CHANGES_SHEET_NAME);
        }
    }
    return sheet;
}

var FORMULA_TRIGGER_CHARS_ = ['=', '+', '-', '@'];

// Previne injecao de formula no Sheets: um valor que comeca com =, +, - ou @
// seria interpretado como formula se gravado cru. Prefixar com aspa simples
// forca o Sheets a tratar como texto literal (mesmo efeito de digitar ='foo'
// na UI) - a aspa nao aparece no valor salvo/exibido.
function escapeSheetTextValue_(value) {
    var str = String(value);
    if (str && FORMULA_TRIGGER_CHARS_.indexOf(str.charAt(0)) !== -1) {
        return "'" + str;
    }
    return str;
}

// Aplica as alteracoes aceitas em shtClientes, por idUnico2 (UUID). Escrita
// direcionada apenas nas celulas dos campos enviados. Lanca em coluna ausente.
function applyClientChangesToClientes_(changes) {
    if (!changes || !changes.length) return { applied: 0, skipped: [] };

    var config = getConfig_();
    if (!config.spreadsheetId) throw new Error('SPREADSHEET_ID nao configurado');
    var sheet = SpreadsheetApp.openById(config.spreadsheetId).getSheetByName(TBL_CLIENTES);
    if (!sheet) throw new Error('Aba nao encontrada: ' + TBL_CLIENTES);

    var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var colUuid = header.indexOf('idUnico2');
    if (colUuid === -1) throw new Error('Coluna idUnico2 nao encontrada em ' + TBL_CLIENTES);
    var colByField = {};
    for (var f = 0; f < CLIENT_EDITABLE_FIELDS.length; f++) {
        var field = CLIENT_EDITABLE_FIELDS[f];
        var idx = header.indexOf(field);
        if (idx === -1) throw new Error('Coluna ' + field + ' nao encontrada em ' + TBL_CLIENTES);
        colByField[field] = idx;
    }

    var lastRow = sheet.getLastRow();
    var uuidRowMap = {};
    if (lastRow > 1) {
        var uuidValues = sheet.getRange(2, colUuid + 1, lastRow - 1, 1).getValues();
        for (var i = 0; i < uuidValues.length; i++) {
            var key = String(uuidValues[i][0] || '').trim();
            if (key) uuidRowMap[key] = i + 2;
        }
    }

    var plan = planClienteWrites_(uuidRowMap, changes);

    // Grava so as celulas dos campos enviados (uma por campo alterado).
    // Formato de texto ('@') evita que CEP/telefone percam zero a esquerda
    // virando numero; escapeSheetTextValue_ evita injecao de formula.
    plan.writes.forEach(function (w) {
        for (var field in w.campos) {
            if (!Object.prototype.hasOwnProperty.call(w.campos, field)) continue;
            var range = sheet.getRange(w.row, colByField[field] + 1);
            range.setNumberFormat('@');
            range.setValue(escapeSheetTextValue_(w.campos[field]));
        }
    });

    return { applied: plan.writes.length, skipped: plan.skipped };
}

// Funcao pura (sem chamadas ao Sheets), testavel: dado uuid->linha e as
// alteracoes aceitas, devolve as escritas {row, campos} e os UUID sem linha.
function planClienteWrites_(uuidRowMap, changes) {
    var writes = [];
    var skipped = [];
    for (var i = 0; i < changes.length; i++) {
        var ch = changes[i];
        var key = String(ch.idCliente || '').trim();
        var row = uuidRowMap[key];
        if (!row) { skipped.push(key); continue; }
        writes.push({ row: row, campos: ch.campos });
    }
    return { writes: writes, skipped: skipped };
}

function getPendingRouteChanges_(token) {
    var authError = routeChangesAuthError_(token);
    if (authError) return jsonResponse_({ ok: false, error: authError });

    try {
        var sheet = getRouteChangesSheet_();
        var lastRow = sheet.getLastRow();
        var lines = [
            'changeId\tidRota\tInativo\tOrdem\tRoteiro\tAlteradoEm\tOrigem'
        ];
        if (lastRow > 1) {
            var values = sheet.getRange(
                2,
                1,
                lastRow - 1,
                ROUTE_CHANGES_HEADERS.length
            ).getValues();
            var pendingCount = 0;
            for (var i = 0; i < values.length && pendingCount < ROUTE_CHANGES_MAX_DELIVERY; i++) {
                var row = values[i];
                if (String(row[7]) !== 'PENDENTE') continue;
                lines.push([
                    row[0], row[1], row[2] ? 1 : 0, row[3],
                    row[4], row[5], row[6]
                ].join('\t'));
                pendingCount++;
            }
        }
        return textResponse_(lines.join('\r\n'));
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function confirmRouteChanges_(changeIds, token, message) {
    var authError = routeChangesAuthError_(token);
    if (authError) return jsonResponse_({ ok: false, error: authError });
    if (!Array.isArray(changeIds) || changeIds.length > ROUTE_CHANGES_MAX_DELIVERY) {
        return jsonResponse_({ ok: false, error: 'Confirmação inválida' });
    }

    try {
        var wanted = {};
        changeIds.forEach(function (changeId) {
            wanted[String(changeId)] = true;
        });

        var lock = LockService.getScriptLock();
        lock.waitLock(30000);
        try {
            var sheet = getRouteChangesSheet_();
            var lastRow = sheet.getLastRow();
            if (lastRow <= 1) {
                return jsonResponse_({ ok: true, count: 0 });
            }

            var values = sheet.getRange(
                2,
                1,
                lastRow - 1,
                ROUTE_CHANGES_HEADERS.length
            ).getValues();
            var now = new Date().toISOString();
            var count = 0;
            values.forEach(function (row) {
                if (!wanted[String(row[0])]) return;
                row[7] = 'PROCESSADO';
                row[9] = now;
                row[10] = String(message || '').slice(0, 500);
                count++;
            });
            if (count) {
                sheet.getRange(
                    2,
                    1,
                    values.length,
                    ROUTE_CHANGES_HEADERS.length
                ).setValues(values);
            }
            return jsonResponse_({ ok: true, count: count });
        } finally {
            lock.releaseLock();
        }
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function getAgendamentosSheet_() {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        throw new Error('SPREADSHEET_ID não configurado');
    }

    var spreadsheet = SpreadsheetApp.openById(config.spreadsheetId);
    var sheet = spreadsheet.getSheetByName(AGENDAMENTOS_SHEET_NAME);

    if (sheet && sheet.getLastRow() > 0) {
        var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        var hasId = String(header[0]).trim() === 'ID';
        var missing = AGENDAMENTOS_HEADERS.filter(function (name, i) {
            return !hasId && i === 0
                ? false
                : String(header[i] || '').trim() !== name;
        });
        if (hasId && !missing.length) {
            return sheet;
        }
        // Aba existente sem o formato esperado: reescreve o cabeçalho com a
        // coluna ID. Linhas antigas digitadas manualmente ficam com ID vazio
        // (somente-leitura na UI, mas aparecem no PDF).
        sheet.getRange(1, 1, 1, AGENDAMENTOS_HEADERS.length)
            .setValues([AGENDAMENTOS_HEADERS]);
        sheet.setFrozenRows(1);
        return sheet;
    }

    if (sheet) {
        sheet.getRange(1, 1, 1, AGENDAMENTOS_HEADERS.length)
            .setValues([AGENDAMENTOS_HEADERS]);
        sheet.setFrozenRows(1);
        return sheet;
    }

    sheet = spreadsheet.insertSheet(AGENDAMENTOS_SHEET_NAME);
    sheet.getRange(1, 1, 1, AGENDAMENTOS_HEADERS.length)
        .setValues([AGENDAMENTOS_HEADERS]);
    sheet.setFrozenRows(1);
    return sheet;
}

function getAgendamentos_(data) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }

    var dataAlvo = String(data || '').trim();
    if (dataAlvo && !/^\d{4}-\d{2}-\d{2}$/.test(dataAlvo)) {
        return jsonResponse_({ ok: false, error: 'Data inválida' });
    }

    try {
        var sheet = getAgendamentosSheet_();
        var lastRow = sheet.getLastRow();
        if (lastRow < 2) {
            return jsonResponse_({ ok: true, data: [] });
        }

        var cache = CacheService.getScriptCache();
        var cacheKey = 'age:' + lastRow + ':' + (dataAlvo || '*');
        var cached = cache.get(cacheKey);
        if (cached !== null) {
            return jsonResponse_({ ok: true, data: JSON.parse(cached) });
        }

        var values = sheet.getRange(
            2,
            1,
            lastRow - 1,
            AGENDAMENTOS_HEADERS.length
        ).getValues();
        var rows = [];
        for (var i = 0; i < values.length; i++) {
            var row = values[i];
            // O Sheets converte "YYYY-MM-DD" para data interna ao gravar;
            // normaliza Date/string para "YYYY-MM-DD" antes de comparar.
            var dataPrevista = normalizeDateValue_(row[4]) || '';
            if (dataAlvo && dataPrevista !== dataAlvo) continue;
            rows.push({
                id: String(row[0] || '').trim(),
                cliente: String(row[1] || ''),
                endereco: String(row[2] || ''),
                materiais: String(row[3] || ''),
                dataPrevista: dataPrevista,
                sincronizadoEm: String(row[5] || '')
            });
        }

        cache.put(cacheKey, JSON.stringify(rows), 600);
        return jsonResponse_({ ok: true, data: rows });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function normalizeAgendamento_(op) {
    if (op.op !== 'upsert' && op.op !== 'delete') {
        throw new Error('Operação inválida (esperado upsert ou delete)');
    }

    var id = String(op.id || '').trim();
    if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) {
        throw new Error('ID de agendamento inválido');
    }

    if (op.op === 'delete') {
        return { op: 'delete', id: id };
    }

    var cliente = String(op.cliente || '').trim();
    if (!cliente) {
        throw new Error('Cliente é obrigatório para ' + id);
    }
    if (cliente.length > 255 || /[\t\r\n]/.test(cliente)) {
        throw new Error('Cliente inválido para ' + id);
    }

    var endereco = String(op.endereco || '').trim();
    if (endereco.length > 255 || /[\t\r\n]/.test(endereco)) {
        throw new Error('Endereço inválido para ' + id);
    }

    var materiais = String(op.materiais || '').trim();
    if (materiais.length > 500 || /[\t\r\n]/.test(materiais)) {
        throw new Error('Materiais inválidos para ' + id);
    }

    var dataPrevista = String(op.dataPrevista || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dataPrevista)) {
        throw new Error('Data Prevista inválida para ' + id);
    }

    return {
        op: 'upsert',
        id: id,
        cliente: cliente,
        endereco: endereco,
        materiais: materiais,
        dataPrevista: dataPrevista
    };
}

function syncAgendamentos_(ops) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }
    if (!Array.isArray(ops) || ops.length > 200) {
        return jsonResponse_({ ok: false, error: 'O lote deve conter no máximo 200 operações' });
    }

    try {
        var normalized = ops.map(normalizeAgendamento_);
        var lock = LockService.getScriptLock();
        lock.waitLock(30000);
        try {
            var sheet = getAgendamentosSheet_();
            var lastRow = sheet.getLastRow();
            var values = lastRow > 1
                ? sheet.getRange(2, 1, lastRow - 1, AGENDAMENTOS_HEADERS.length).getValues()
                : [];

            var byId = {};
            values.forEach(function (row) {
                var id = String(row[0] || '').trim();
                if (id) byId[id] = row;
            });

            var now = new Date().toISOString();
            var upserts = 0;
            var deletes = 0;
            var updated = [];
            normalized.forEach(function (op) {
                if (op.op === 'delete') {
                    var target = byId[op.id];
                    if (!target) return;
                    target[0] = '__DELETE__';
                    deletes++;
                    return;
                }

                var existing = byId[op.id];
                if (existing) {
                    existing[1] = op.cliente;
                    existing[2] = op.endereco;
                    existing[3] = op.materiais;
                    existing[4] = op.dataPrevista;
                    existing[5] = now;
                } else {
                    updated.push([
                        op.id, op.cliente, op.endereco, op.materiais,
                        op.dataPrevista, now
                    ]);
                }
                upserts++;
            });

            var newRows = [];
            for (var i = 0; i < values.length; i++) {
                if (values[i][0] === '__DELETE__') continue;
                newRows.push(values[i]);
            }
            updated.forEach(function (row) { newRows.push(row); });

            if (newRows.length) {
                sheet.getRange(2, 1, newRows.length, AGENDAMENTOS_HEADERS.length)
                    .setValues(newRows);
            }
            if (values.length > newRows.length) {
                sheet.getRange(
                    2 + newRows.length,
                    1,
                    values.length - newRows.length,
                    AGENDAMENTOS_HEADERS.length
                ).clearContent();
            }

            return jsonResponse_({
                ok: true,
                upserts: upserts,
                deletes: deletes
            });
        } finally {
            lock.releaseLock();
        }
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

// Obtém/cria a subpasta "AgendamentosFotos" dentro de CHECKLISTS_FOLDER_ID.
// O ID resolvido é guardado no cache para evitar re-resolução a cada chamada.
function getAgendamentosFotosFolder_() {
    var config = getConfig_();
    if (!config.checklistsFolderId) {
        throw new Error('CHECKLISTS_FOLDER_ID não configurado');
    }

    var cache = CacheService.getScriptCache();
    var cacheKey = 'agefotos:root:' + config.checklistsFolderId;
    var cachedId = cache.get(cacheKey);
    if (cachedId) {
        try {
            return DriveApp.getFolderById(cachedId);
        } catch (e) {
            // Pasta em cache não existe mais: recria abaixo.
        }
    }

    var parent = DriveApp.getFolderById(config.checklistsFolderId);
    var it = parent.getFoldersByName(AGENDAMENTOS_FOTOS_SUBFOLDER);
    var folder = it.hasNext() ? it.next() : parent.createFolder(AGENDAMENTOS_FOTOS_SUBFOLDER);
    cache.put(cacheKey, folder.getId(), 21600);
    return folder;
}

// Obtém/cria a subpasta "AgendamentosFotos/<id>".
function getAgendamentoFotosFolder_(id, criar) {
    if (!AGENDAMENTO_ID_RE.test(id)) {
        throw new Error('ID de agendamento inválido');
    }
    var root = getAgendamentosFotosFolder_();
    var it = root.getFoldersByName(id);
    if (it.hasNext()) return it.next();
    return criar ? root.createFolder(id) : null;
}

function uploadAgendamentoFotos_(id, fotos, remover) {
    var config = getConfig_();
    if (!config.checklistsFolderId) {
        return jsonResponse_({ ok: false, error: 'CHECKLISTS_FOLDER_ID não configurado' });
    }
    if (!AGENDAMENTO_ID_RE.test(String(id || '').trim())) {
        return jsonResponse_({ ok: false, error: 'ID de agendamento inválido' });
    }
    if (!Array.isArray(fotos) || fotos.length > 3) {
        return jsonResponse_({ ok: false, error: 'Máximo de 3 fotos por agendamento' });
    }
    if (!Array.isArray(remover)) {
        remover = [];
    }

    id = String(id).trim();

    // Valida tudo antes de tocar no Drive.
    var validas = [];
    for (var i = 0; i < fotos.length; i++) {
        var foto = fotos[i] || {};
        var nome = String(foto.nome || '').trim();
        if (!AGENDAMENTO_FOTO_NOME_RE.test(nome)) {
            return jsonResponse_({ ok: false, error: 'Nome de foto inválido: ' + nome });
        }
        var base64 = String(foto.base64 || '');
        if (!base64) {
            return jsonResponse_({ ok: false, error: 'base64 ausente para ' + nome });
        }
        var bytes;
        try {
            bytes = Utilities.base64Decode(base64);
        } catch (e) {
            return jsonResponse_({ ok: false, error: 'base64 inválido para ' + nome });
        }
        if (bytes.length > AGENDAMENTO_FOTO_MAX_BYTES) {
            return jsonResponse_({ ok: false, error: 'Foto ' + nome + ' excede 8 MB' });
        }
        var mime = /\.png$/i.test(nome) ? 'image/png' : 'image/jpeg';
        validas.push({ nome: nome, bytes: bytes, mime: mime });
    }

    var removerValidos = [];
    for (var r = 0; r < remover.length; r++) {
        var rn = String(remover[r] || '').trim();
        if (AGENDAMENTO_FOTO_NOME_RE.test(rn)) removerValidos.push(rn);
    }

    try {
        var lock = LockService.getScriptLock();
        lock.waitLock(30000);
        try {
            var folder = getAgendamentoFotosFolder_(id, true);

            // Remoções explícitas + substituição de mesmo nome: descarta os
            // arquivos existentes cujo nome está em remover ou vai ser regravado.
            var descartar = {};
            removerValidos.forEach(function (n) { descartar[n] = true; });
            validas.forEach(function (f) { descartar[f.nome] = true; });

            Object.keys(descartar).forEach(function (nome) {
                var existing = folder.getFilesByName(nome);
                while (existing.hasNext()) {
                    existing.next().setTrashed(true);
                }
            });

            validas.forEach(function (f) {
                var blob = Utilities.newBlob(f.bytes, f.mime, f.nome);
                folder.createFile(blob);
            });

            return jsonResponse_({ ok: true, count: validas.length });
        } finally {
            lock.releaseLock();
        }
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function getAgendamentoFotos_(id, incluirBase64) {
    var config = getConfig_();
    if (!config.checklistsFolderId) {
        return jsonResponse_({ ok: false, error: 'CHECKLISTS_FOLDER_ID não configurado' });
    }
    if (!AGENDAMENTO_ID_RE.test(String(id || '').trim())) {
        return jsonResponse_({ ok: false, error: 'ID de agendamento inválido' });
    }

    try {
        var folder = getAgendamentoFotosFolder_(String(id).trim(), false);
        if (!folder) {
            return jsonResponse_({ ok: true, fotos: [] });
        }

        var fotos = [];
        ['foto_1', 'foto_2', 'foto_3'].forEach(function (slot) {
            ['jpg', 'jpeg', 'png'].forEach(function (ext) {
                var nome = slot + '.' + ext;
                var it = folder.getFilesByName(nome);
                if (!it.hasNext()) return;
                var file = it.next();
                var item = { nome: nome, slot: slot };
                if (incluirBase64) {
                    item.base64 = Utilities.base64Encode(file.getBlob().getBytes());
                    item.mime = /\.png$/i.test(nome) ? 'image/png' : 'image/jpeg';
                }
                fotos.push(item);
            });
        });

        return jsonResponse_({ ok: true, fotos: fotos });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function normalizeHistoryDate_(value) {
    var text = Object.prototype.toString.call(value) === '[object Date]'
        ? Utilities.formatDate(value, 'America/Sao_Paulo', 'yyyy-MM-dd')
        : String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    var date = new Date(text + 'T12:00:00Z');
    return isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
}

function saveColetas_(coletas) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }

    if (!Array.isArray(coletas)) {
        return jsonResponse_({ ok: false, error: 'coletas deve ser uma lista' });
    }

    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
        var ss = SpreadsheetApp.openById(config.spreadsheetId);
        var sheet = ss.getSheetByName(COLETAS_SHEET_NAME);
        if (!sheet) {
            sheet = ss.insertSheet(COLETAS_SHEET_NAME);
            sheet.appendRow(['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID']);
        }

        // Dedup por Sync ID (8ª coluna). Um reenvio após falha de resposta
        // traz o mesmo sync_id da 1ª tentativa; ignora os que já estão na aba
        // (e também repetidos dentro do próprio lote) para não duplicar.
        var lastRow = sheet.getLastRow();
        var vistos = {};
        if (lastRow > 1) {
            var ids = sheet.getRange(2, 8, lastRow - 1, 1).getValues();
            for (var i = 0; i < ids.length; i++) {
                var existente = String(ids[i][0] || '').trim();
                if (existente) vistos[existente] = true;
            }
        }

        var now = new Date().toISOString();
        var novos = [];
        var duplicados = 0;
        coletas.forEach(function (c) {
            var sid = String(c.sync_id || '').trim();
            if (sid) {
                if (vistos[sid]) { duplicados++; return; }
                vistos[sid] = true;
            }
            novos.push([
                c.id_rota || '',
                c.data || '',
                c.cliente || '',
                c.roteiro || '',
                c.quantidade || 0,
                c.intercorrencia || '',
                now,
                sid
            ]);
        });

        if (novos.length) {
            sheet.getRange(sheet.getLastRow() + 1, 1, novos.length, 8).setValues(novos);
        }

        try {
            CacheService.getScriptCache().remove(INTERCORRENCIAS_ATUAIS_CACHE_KEY);
        } catch (_) { /* cache é opcional */ }

        return jsonResponse_({ ok: true, count: novos.length, duplicates: duplicados });
    } finally {
        lock.releaseLock();
    }
}

function saveChecklist_(checklist) {
    var config = getConfig_();
    if (!config.checklistsFolderId) {
        return jsonResponse_({ ok: false, error: 'CHECKLISTS_FOLDER_ID não configurado' });
    }
    if (!checklist.filename || !checklist.pdfBase64) {
        return jsonResponse_({ ok: false, error: 'filename ou pdfBase64 ausente' });
    }

    var folder = DriveApp.getFolderById(config.checklistsFolderId);

    var existing = folder.getFilesByName(checklist.filename);
    while (existing.hasNext()) {
        existing.next().setTrashed(true);
    }

    var bytes = Utilities.base64Decode(checklist.pdfBase64);
    var blob = Utilities.newBlob(bytes, 'application/pdf', checklist.filename);
    folder.createFile(blob);

    return jsonResponse_({ ok: true });
}
