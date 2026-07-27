/**
 * Google Apps Script Web App bridge for the SATELITE v3 checklist app.
 * Deploy as Web App (Execute as: Me, Who has access: Anyone).
 *
 * Script Properties required (Project Settings > Script Properties):
 *   SPREADSHEET_ID        - id of the Google Sheet that receives coleta rows
 *   DRIVE_FOLDER_ID        - id of the Drive folder containing cstExportaCheckList.csv
 *   CHECKLISTS_FOLDER_ID   - id of the Drive folder that receives checklist PDFs
 */

var CSV_FILE_NAME = 'cstExportaCheckList.csv';
var COLETAS_SHEET_NAME = 'Coletas';
var GAS_API_VERSION = 2;

function getConfig_() {
    var props = PropertiesService.getScriptProperties();
    return {
        spreadsheetId: props.getProperty('SPREADSHEET_ID'),
        folderId: props.getProperty('DRIVE_FOLDER_ID'),
        checklistsFolderId: props.getProperty('CHECKLISTS_FOLDER_ID')
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
            apiVersion: GAS_API_VERSION
        });
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
        return jsonResponse_({
            ok: true,
            content: file.getBlob().getDataAsString('UTF-8'),
            modifiedTime: file.getLastUpdated().toISOString()
        });
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
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

        if (body.checklist) {
            return saveChecklist_(body.checklist);
        }

        return saveColetas_(body.coletas || []);
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
