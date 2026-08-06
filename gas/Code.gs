/**
 * Google Apps Script Web App bridge for the SATELITE v3 checklist app.
 * Deploy as Web App (Execute as: Me, Who has access: Anyone).
 *
 * Script Properties required (Project Settings > Script Properties):
 *   SPREADSHEET_ID        - id of the Google Sheet that receives coleta rows
 *   DRIVE_FOLDER_ID        - id of the Drive folder containing cstExportaCheckList.csv
 *   CHECKLISTS_FOLDER_ID   - id of the Drive folder that receives checklist PDFs
 *   ROUTE_CHANGES_TOKEN    - shared token used by apps and the Access frontend
 */

var CSV_FILE_NAME = 'cstExportaCheckList.csv';
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
var GAS_API_VERSION = 3;
var CSV_DECODE_SYNC_OFFSET_MS = 1;
// Consultas de última coleta varrem apenas as linhas mais recentes da aba
// Coletas (append-only, cronológica). Varrer a aba inteira chega a ~37s e pode
// estourar o limite do GAS. Se o roteiro não aparecer na janela, há fallback
// para varredura completa.
var COLETAS_RECENT_ROWS = 8000;

function getConfig_() {
    var props = PropertiesService.getScriptProperties();
    return {
        spreadsheetId: props.getProperty('SPREADSHEET_ID'),
        folderId: props.getProperty('DRIVE_FOLDER_ID'),
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

    if (params.action === 'agendamentos') {
        return getAgendamentos_(params.data || '');
    }

    if (params.action === 'agendamentoFotos') {
        return getAgendamentoFotos_(params.id || '', params.incluirBase64 === 'true');
    }


    var config = getConfig_();
    if (!config.folderId) {
        return jsonResponse_({ ok: false, error: 'DRIVE_FOLDER_ID não configurado' });
    }

    try {
        var folder = DriveApp.getFolderById(config.folderId);
        var files = folder.getFilesByName(CSV_FILE_NAME);

        if (!files.hasNext()) {
            return jsonResponse_({ ok: false, error: 'Arquivo ' + CSV_FILE_NAME + ' não encontrado na pasta' });
        }

        var file = files.next();
        var decoded = decodeCsvBlob_(file.getBlob());
        var modifiedTime = file.getLastUpdated();

        // Clients that already cached the timestamp while UTF-16 was decoded
        // as UTF-8 need to import this same Drive revision once more. A stable
        // 1 ms offset preserves the normal "only when changed" behavior.
        if (decoded.encoding !== 'UTF-8') {
            modifiedTime = new Date(modifiedTime.getTime() + CSV_DECODE_SYNC_OFFSET_MS);
        }

        return jsonResponse_({
            ok: true,
            content: decoded.content,
            modifiedTime: modifiedTime.toISOString(),
            encoding: decoded.encoding
        });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}

function decodeCsvBlob_(blob) {
    var bytes = blob.getBytes();
    var encoding = detectCsvEncoding_(bytes);
    var content = blob.getDataAsString(encoding);

    // Remove BOM after decoding so Papa Parse sees "Fonte" as the first
    // header, regardless of the source encoding.
    content = content.replace(/^\uFEFF/, '');

    return { content: content, encoding: encoding };
}

function detectCsvEncoding_(bytes) {
    if (bytes.length >= 2) {
        var first = bytes[0] & 255;
        var second = bytes[1] & 255;
        if (first === 255 && second === 254) return 'UTF-16LE';
        if (first === 254 && second === 255) return 'UTF-16BE';
    }

    // Access normally writes a BOM, but also recognize BOM-less UTF-16 by
    // the alternating NUL bytes in the ASCII CSV header.
    var sampleSize = Math.min(bytes.length, 200);
    var evenNulls = 0;
    var oddNulls = 0;
    for (var i = 0; i < sampleSize; i++) {
        if ((bytes[i] & 255) !== 0) continue;
        if (i % 2 === 0) evenNulls++;
        else oddNulls++;
    }

    if (sampleSize >= 8 && oddNulls >= sampleSize / 4 && oddNulls > evenNulls * 2) {
        return 'UTF-16LE';
    }
    if (sampleSize >= 8 && evenNulls >= sampleSize / 4 && evenNulls > oddNulls * 2) {
        return 'UTF-16BE';
    }

    return 'UTF-8';
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

function doPost(e) {
    try {
        var body = JSON.parse(e.postData.contents);

        if (body.action === 'routeChanges') {
            return saveRouteChanges_(body.changes || [], body.token || '');
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
            normalized.forEach(function (change) {
                if (existingIds[change.changeId]) {
                    duplicateIds.push(change.changeId);
                    return;
                }
                existingIds[change.changeId] = true;
                acceptedIds.push(change.changeId);
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
                duplicateIds: duplicateIds
            });
        } finally {
            lock.releaseLock();
        }
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
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
