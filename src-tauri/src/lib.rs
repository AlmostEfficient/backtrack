mod sessions;

use sessions::{Filters, Project, SearchHit, Session, SessionDetail, SessionMeta};
use std::sync::Mutex;
use tauri::State;

struct Index {
    sessions: Vec<Session>,
}

type AppState = Mutex<Index>;

#[tauri::command]
fn get_projects(state: State<AppState>) -> Vec<Project> {
    let idx = state.lock().unwrap();
    sessions::projects(&idx.sessions)
}

#[tauri::command]
fn get_sessions(state: State<AppState>, project_path: String) -> Vec<SessionMeta> {
    let idx = state.lock().unwrap();
    idx.sessions
        .iter()
        .filter(|s| s.project_path == project_path)
        .map(SessionMeta::from)
        .collect()
}

#[tauri::command]
fn get_recent(state: State<AppState>) -> Vec<SessionMeta> {
    // Index is already sorted newest-first.
    let idx = state.lock().unwrap();
    idx.sessions.iter().map(SessionMeta::from).collect()
}

#[tauri::command]
fn get_transcript(state: State<AppState>, id: String) -> Option<SessionDetail> {
    let idx = state.lock().unwrap();
    idx.sessions
        .iter()
        .find(|s| s.id == id)
        .map(|s| SessionDetail {
            meta: SessionMeta::from(s),
            messages: s.messages.clone(),
        })
}

#[tauri::command]
fn search(state: State<AppState>, query: String, filters: Option<Filters>) -> Vec<SearchHit> {
    let idx = state.lock().unwrap();
    let filters = filters.unwrap_or_default();
    sessions::search(&idx.sessions, &query, &filters, 400)
}

#[tauri::command]
fn reindex(state: State<AppState>) -> usize {
    let mut idx = state.lock().unwrap();
    idx.sessions = sessions::build_index();
    idx.sessions.len()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sessions = sessions::build_index();
    eprintln!("backtrack: indexed {} sessions", sessions.len());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(Index { sessions }))
        .invoke_handler(tauri::generate_handler![
            get_projects,
            get_sessions,
            get_recent,
            get_transcript,
            search,
            reindex
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
