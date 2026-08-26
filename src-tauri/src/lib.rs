#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[tauri::command]
fn save_checklist_pdf(
    app: tauri::AppHandle,
    pdf_base64: String,
    filename: String,
) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pdf_base64)
        .map_err(|e| format!("Base64 inválido: {e}"))?;

    let sanitized: String = filename
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c => c,
        })
        .collect();

    let downloads = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("Não foi possível localizar a pasta de Downloads: {e}"))?;

    let path = downloads.join(sanitized);
    fs::write(&path, bytes).map_err(|e| format!("Falha ao salvar o arquivo: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

// Caminho fixo da pasta de rede onde o Access publica o export do checklist
// (mesmo em todas as máquinas que rodam o app). Ver
// docs/superpowers/specs/2026-08-26-logradouros-rede-design.md.
const NETWORK_LOGRADOUROS_CSV_PATH: &str = r"\\192.168.12.1\Dados\SMMADS\Super. de Resíduos Sólidos\Ger. de Op. de Coleta\DVCOS\ColetaFlexDados\Check-list\Check list\app\cstExportaCheckList.csv";

#[derive(Serialize)]
struct NetworkCsvResult {
    bytes_base64: String,
    modified_time_ms: u64,
}

#[tauri::command]
fn read_network_logradouros_csv() -> Result<NetworkCsvResult, String> {
    let bytes = fs::read(NETWORK_LOGRADOUROS_CSV_PATH)
        .map_err(|e| format!("Não foi possível ler o arquivo na pasta de rede: {e}"))?;
    let metadata = fs::metadata(NETWORK_LOGRADOUROS_CSV_PATH)
        .map_err(|e| format!("Não foi possível ler os metadados do arquivo: {e}"))?;
    let modified_time_ms = metadata
        .modified()
        .map_err(|e| format!("Não foi possível ler a data de modificação: {e}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("Data de modificação inválida: {e}"))?
        .as_millis() as u64;

    Ok(NetworkCsvResult {
        bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        modified_time_ms,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            save_checklist_pdf,
            read_network_logradouros_csv
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
