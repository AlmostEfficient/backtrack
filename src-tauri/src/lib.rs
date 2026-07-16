mod sessions;

use notify::{Event, RecursiveMode, Watcher};
use sessions::{Filters, Project, SearchHit, Session, SessionDetail, SessionMeta};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

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
async fn reindex(state: State<'_, AppState>) -> Result<usize, String> {
    let rebuilt = tauri::async_runtime::spawn_blocking(sessions::build_index)
        .await
        .map_err(|error| error.to_string())?;
    let count = rebuilt.len();
    state.lock().map_err(|error| error.to_string())?.sessions = rebuilt;
    Ok(count)
}

fn start_history_watcher(app: tauri::AppHandle) -> notify::Result<()> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })?;
    for root in sessions::history_roots() {
        if root.exists() {
            watcher.watch(&root, RecursiveMode::Recursive)?;
        }
    }

    thread::spawn(move || {
        let _watcher = watcher;
        loop {
            let first = match rx.recv() {
                Ok(Ok(event)) => event,
                Ok(Err(error)) => {
                    eprintln!("backtrack: history watcher error: {error}");
                    continue;
                }
                Err(_) => break,
            };

            let mut paths: HashSet<PathBuf> = first.paths.into_iter().collect();
            let deadline = Instant::now() + Duration::from_millis(180);
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match rx.recv_timeout(remaining) {
                    Ok(Ok(event)) => paths.extend(event.paths),
                    Ok(Err(error)) => eprintln!("backtrack: history watcher error: {error}"),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }

            // Parsing can be expensive for long transcripts, so do it before
            // taking the shared index lock.
            let updates = paths
                .iter()
                .filter_map(|path| sessions::read_file_update(path))
                .collect();
            let changed = {
                let state = app.state::<AppState>();
                let mut index = match state.lock() {
                    Ok(index) => index,
                    Err(error) => {
                        eprintln!("backtrack: history index lock failed: {error}");
                        continue;
                    }
                };
                sessions::apply_file_updates(&mut index.sessions, updates)
            };
            if changed > 0 {
                let _ = app.emit("histories-changed", changed);
            }
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let sessions = sessions::build_index();
    eprintln!("backtrack: indexed {} sessions", sessions.len());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(Index { sessions }))
        .setup(|app| {
            if let Err(error) = start_history_watcher(app.handle().clone()) {
                eprintln!("backtrack: could not start history watcher: {error}");
            }
            Ok(())
        })
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
