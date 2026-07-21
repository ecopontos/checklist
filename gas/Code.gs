/**
 * Google Apps Script Web App bridge for the SATELITE v3 checklist app.
 * Deploy as Web App (Execute as: Me, Who has access: Anyone).
 *
 * Script Properties required (Project Settings > Script Properties):
 *   SPREADSHEET_ID  - id of the Google Sheet that receives coleta rows
 *   DRIVE_FOLDER_ID - id of the Drive folder containing cstExportaCheckList.csv
 */

var CSV_FILE_NAME = 'cstExportaCheckList.csv';
var COLETAS_SHEET_NAME = 'Coletas';

function getConfig_() {
    var props = PropertiesService.getScriptProperties();
    return {
        spreadsheetId: props.getProperty('SPREADSHEET_ID'),
        folderId: props.getProperty('DRIVE_FOLDER_ID')
    };
}

function jsonResponse_(obj) {
    return ContentService.createTextOutput(JSON.stringify(obj))
        .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
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

function doPost(e) {
    var config = getConfig_();
    if (!config.spreadsheetId) {
        return jsonResponse_({ ok: false, error: 'SPREADSHEET_ID não configurado' });
    }

    try {
        var body = JSON.parse(e.postData.contents);
        var coletas = body.coletas || [];

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
    } catch (err) {
        return jsonResponse_({ ok: false, error: err.message });
    }
}
