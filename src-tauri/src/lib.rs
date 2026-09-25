#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use std::fs;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![save_checklist_pdf])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
