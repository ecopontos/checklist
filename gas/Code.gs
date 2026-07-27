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
var ROUTE_CHANGES_SHEET_NAME = 'AlteracoesRoteiros';
var ROUTE_CHANGES_HEADERS = [
    'Change ID', 'ID Rota', 'Inativo', 'Ordem', 'Roteiro', 'Alterado Em',
    'Origem', 'Status', 'Recebido Em', 'Processado Em', 'Mensagem'
];
var GAS_API_VERSION = 3;
var CSV_DECODE_SYNC_OFFSET_MS = 1;

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
        if (!sheet) {
            return jsonResponse_({ ok: true, data: null });
        }
        if (sheet.getLastRow() === 0) {
            return jsonResponse_({ ok: true, data: null });
        }

        var values = sheet.getDataRange().getValues();
        var header = values[0];
        var colData = header.indexOf('Data');
        var colRoteiro = header.indexOf('Roteiro');
        if (colData === -1 || colRoteiro === -1) {
            return jsonResponse_({ ok: false, error: 'Colunas Data/Roteiro não encontradas na aba ' + COLETAS_SHEET_NAME });
        }

        var roteiroAlvo = roteiroNome.trim();
        var lastDate = null;
        for (var i = 1; i < values.length; i++) {
            var row = values[i];
            if (String(row[colRoteiro]).trim() !== roteiroAlvo) continue;

            var normalized = normalizeDateValue_(row[colData]);
            if (normalized && (!lastDate || normalized > lastDate)) {
                lastDate = normalized;
            }
        }

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
            for (var i = 0; i < values.length && pendingCount < 100; i++) {
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
    if (!Array.isArray(changeIds) || changeIds.length > 100) {
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

function saveColetas_(coletas) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }

    var ss = SpreadsheetApp.openById(config.spreadsheetId);
    var sheet = ss.getSheetByName(COLETAS_SHEET_NAME);
    if (!sheet) {
        sheet = ss.insertSheet(COLETAS_SHEET_NAME);
        sheet.appendRow(['ID Rota', 'Data', 'Cliente', 'Roteiro', 'Quantidade', 'Intercorrência', 'Sincronizado Em', 'Sync ID']);
    }

    var now = new Date().toISOString();
    coletas.forEach(function (c) {
        sheet.appendRow([
            c.id_rota || '',
            c.data || '',
            c.cliente || '',
            c.roteiro || '',
            c.quantidade || 0,
            c.intercorrencia || '',
            now,
            c.sync_id || ''
        ]);
    });

    return jsonResponse_({ ok: true, count: coletas.length });
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
