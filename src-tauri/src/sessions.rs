// Parses Claude Code and Codex session logs into clean, top-level transcripts.
//
// Both tools store one JSONL file per session. We keep only what the human said
// and what the agent said back as prose — no tool calls, results, thinking, or
// system/meta noise.

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize)]
pub struct Message {
    pub role: String, // "user" | "assistant"
    pub text: String,
    pub ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub source: String, // "claude" | "codex"
    pub project_path: String,
    pub project_name: String,
    pub title: String,
    pub model: Option<String>,
    pub started_at: Option<String>,
    pub last_at: Option<String>,
    pub msg_count: usize,
    #[serde(skip)]
    pub messages: Vec<Message>,
    #[serde(skip)]
    pub haystack: String, // lowercased concatenation of all message text, for search
    #[serde(skip)]
    pub log_path: PathBuf,
}

#[derive(Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub source: String,
    pub project_path: String,
    pub project_name: String,
    pub title: String,
    pub model: Option<String>,
    pub started_at: Option<String>,
    pub last_at: Option<String>,
    pub msg_count: usize,
}

impl From<&Session> for SessionMeta {
    fn from(s: &Session) -> Self {
        SessionMeta {
            id: s.id.clone(),
            source: s.source.clone(),
            project_path: s.project_path.clone(),
            project_name: s.project_name.clone(),
            title: s.title.clone(),
            model: s.model.clone(),
            started_at: s.started_at.clone(),
            last_at: s.last_at.clone(),
            msg_count: s.msg_count,
        }
    }
}

#[derive(Serialize)]
pub struct Project {
    pub path: String,
    pub name: String,
    pub session_count: usize,
    pub last_at: Option<String>,
    pub sources: Vec<String>,
}

#[derive(Serialize)]
pub struct SearchHit {
    pub session: SessionMeta,
    pub msg_index: usize, // index into the session's messages, for jump-to-match
    pub snippet: String,
    pub role: String,
}

#[derive(Deserialize, Default)]
pub struct Filters {
    pub role: Option<String>,    // "user" | "assistant"
    pub source: Option<String>,  // "claude" | "codex"
    pub project: Option<String>, // project_path
    pub since: Option<String>,   // ISO cutoff; keep sessions with last_at >= since
}

#[derive(Serialize)]
pub struct SessionDetail {
    pub meta: SessionMeta,
    pub messages: Vec<Message>,
}

fn project_name_from_path(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| p.to_string())
}

fn title_from(messages: &[Message]) -> String {
    let raw = messages
        .iter()
        .find(|m| m.role == "user")
        .or_else(|| messages.first())
        .map(|m| m.text.as_str())
        .unwrap_or("");
    let line = raw
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut t: String = line.chars().take(120).collect();
    if line.chars().count() > 120 {
        t.push('…');
    }
    if t.is_empty() {
        "(untitled)".into()
    } else {
        t
    }
}

// ---- Claude ----------------------------------------------------------------

fn parse_claude_file(path: &Path) -> Option<Session> {
    let content = fs::read_to_string(path).ok()?;
    let mut messages = Vec::new();
    let mut project_path: Option<String> = None;
    let mut first_ts: Option<String> = None;
    let mut last_ts: Option<String> = None;
    let mut model: Option<String> = None;

    for line in content.lines() {
        let d: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if project_path.is_none() {
            if let Some(cwd) = d.get("cwd").and_then(|v| v.as_str()) {
                project_path = Some(cwd.to_string());
            }
        }
        if d.get("isMeta").and_then(|v| v.as_bool()).unwrap_or(false)
            || d.get("isSidechain")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        {
            continue;
        }
        if model.is_none() {
            model = d
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|v| v.as_str())
                .filter(|value| !value.starts_with('<'))
                .map(String::from);
        }
        let role = match d.get("type").and_then(|v| v.as_str()) {
            Some(r @ ("user" | "assistant")) => r,
            _ => continue,
        };
        let phase = if role == "assistant"
            && d.get("message")
                .and_then(|m| m.get("stop_reason"))
                .and_then(|v| v.as_str())
                == Some("tool_use")
        {
            Some("commentary".to_string())
        } else {
            None
        };
        let content_val = match d.get("message").and_then(|m| m.get("content")) {
            Some(c) => c,
            None => continue,
        };
        let text = extract_text(content_val);
        let text = text.trim();
        if model.is_none() {
            model = extract_model_command(text);
        }
        if text.is_empty() || is_noise(text) {
            continue;
        }
        let ts = d
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(String::from);
        if first_ts.is_none() {
            first_ts = ts.clone();
        }
        if ts.is_some() {
            last_ts = ts.clone();
        }
        messages.push(Message {
            role: role.to_string(),
            text: text.to_string(),
            ts,
            phase,
        });
    }

    if messages.is_empty() {
        return None;
    }
    let id = path.file_stem()?.to_string_lossy().to_string();
    let pp = project_path.unwrap_or_else(|| "(unknown)".into());
    Some(finalize(
        id,
        "claude",
        pp,
        messages,
        model,
        first_ts,
        last_ts,
        path.to_path_buf(),
    ))
}

// Claude content is either a string (user) or an array of blocks; we keep only
// text blocks, dropping tool_use / tool_result / thinking / images.
fn extract_text(c: &Value) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(arr) => {
            let parts: Vec<&str> = arr
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            parts.join("\n")
        }
        _ => String::new(),
    }
}

fn is_noise(text: &str) -> bool {
    text.starts_with("<local-command")
        || text.starts_with("<command-")
        || text.starts_with("Caveat:")
        || text.starts_with("<system-reminder>")
        || text.starts_with("# AGENTS.md")
        || text.starts_with("<permissions")
        || text.starts_with("<environment_context>")
        || text.starts_with("<user_instructions>")
}

fn extract_model_command(text: &str) -> Option<String> {
    let marker = "Set model to";
    let start = text.find(marker)? + marker.len();
    let after = strip_ansi(&text[start..]);
    let model = after
        .replace("</local-command-stdout>", "")
        .trim()
        .to_string();
    if model.is_empty() {
        None
    } else {
        Some(model)
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' && chars.peek() == Some(&'[') {
            chars.next();
            for ch in chars.by_ref() {
                if ch.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

// ---- Codex -----------------------------------------------------------------

fn parse_codex_file(path: &Path) -> Option<Session> {
    let content = fs::read_to_string(path).ok()?;
    let mut messages = Vec::new();
    let mut project_path: Option<String> = None;
    let mut id: Option<String> = None;
    let mut first_ts: Option<String> = None;
    let mut last_ts: Option<String> = None;
    let mut model: Option<String> = None;

    for line in content.lines() {
        let d: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let payload = match d.get("payload") {
            Some(p) => p,
            None => continue,
        };
        if model.is_none() {
            model = payload
                .get("model")
                .and_then(|v| v.as_str())
                .map(String::from);
        }
        let ptype = payload.get("type").and_then(|v| v.as_str()).unwrap_or("");

        if ptype == "session_meta" || d.get("type").and_then(|v| v.as_str()) == Some("session_meta")
        {
            if let Some(cwd) = payload.get("cwd").and_then(|v| v.as_str()) {
                project_path = Some(cwd.to_string());
            }
            if let Some(sid) = payload.get("id").and_then(|v| v.as_str()) {
                id = Some(sid.to_string());
            }
            continue;
        }

        if ptype != "message" {
            continue;
        }
        let role = match payload.get("role").and_then(|v| v.as_str()) {
            Some(r @ ("user" | "assistant")) => r,
            _ => continue,
        };
        let phase = payload
            .get("phase")
            .and_then(|v| v.as_str())
            .map(String::from);
        let text = extract_codex_text(payload.get("content"));
        let text = text.trim();
        if text.is_empty() || is_noise(text) {
            continue;
        }
        let ts = d
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(String::from);
        if first_ts.is_none() {
            first_ts = ts.clone();
        }
        if ts.is_some() {
            last_ts = ts.clone();
        }
        messages.push(Message {
            role: role.to_string(),
            text: text.to_string(),
            ts,
            phase,
        });
    }

    if messages.is_empty() {
        return None;
    }
    let id = id.unwrap_or_else(|| {
        path.file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    });
    let pp = project_path.unwrap_or_else(|| "(unknown)".into());
    Some(finalize(
        id,
        "codex",
        pp,
        messages,
        model,
        first_ts,
        last_ts,
        path.to_path_buf(),
    ))
}

fn extract_codex_text(c: Option<&Value>) -> String {
    match c {
        Some(Value::Array(arr)) => {
            let parts: Vec<&str> = arr
                .iter()
                .filter(|b| {
                    matches!(
                        b.get("type").and_then(|t| t.as_str()),
                        Some("input_text" | "output_text")
                    )
                })
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            parts.join("\n")
        }
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

// ---- shared ----------------------------------------------------------------

fn finalize(
    id: String,
    source: &str,
    project_path: String,
    messages: Vec<Message>,
    model: Option<String>,
    first_ts: Option<String>,
    last_ts: Option<String>,
    log_path: PathBuf,
) -> Session {
    let project_name = project_name_from_path(&project_path);
    let title = title_from(&messages);
    let haystack = messages
        .iter()
        .map(|m| m.text.to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    let msg_count = messages.len();
    Session {
        id,
        source: source.to_string(),
        project_path,
        project_name,
        title,
        model,
        started_at: first_ts,
        last_at: last_ts,
        msg_count,
        messages,
        haystack,
        log_path,
    }
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

pub fn build_index() -> Vec<Session> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return Vec::new(),
    };

    let mut claude_files = Vec::new();
    collect_files(&home.join(".claude/projects"), &mut claude_files);
    let mut codex_files = Vec::new();
    collect_files(&home.join(".codex/sessions"), &mut codex_files);

    let mut sessions: Vec<Session> = claude_files
        .par_iter()
        .filter_map(|p| parse_claude_file(p))
        .collect();
    let codex: Vec<Session> = codex_files
        .par_iter()
        .filter_map(|p| parse_codex_file(p))
        .collect();
    sessions.extend(codex);

    // Most recent first.
    sessions.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    sessions
}

pub fn history_roots() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    vec![home.join(".claude/projects"), home.join(".codex/sessions")]
}

pub enum FileUpdate {
    Upsert(Session),
    Remove(String),
}

pub fn read_file_update(path: &Path) -> Option<FileUpdate> {
    if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
        return None;
    }
    if !path.exists() {
        return path
            .file_stem()
            .map(|id| FileUpdate::Remove(id.to_string_lossy().to_string()));
    }

    let roots = history_roots();
    if roots.first().is_some_and(|root| path.starts_with(root)) {
        parse_claude_file(path).map(FileUpdate::Upsert)
    } else if roots.get(1).is_some_and(|root| path.starts_with(root)) {
        parse_codex_file(path).map(FileUpdate::Upsert)
    } else {
        None
    }
}

pub fn apply_file_updates(sessions: &mut Vec<Session>, updates: Vec<FileUpdate>) -> usize {
    let mut changed = 0;
    for update in updates {
        match update {
            FileUpdate::Upsert(session) => {
                if let Some(existing) = sessions.iter_mut().find(|item| item.id == session.id) {
                    *existing = session;
                } else {
                    sessions.push(session);
                }
                changed += 1;
            }
            FileUpdate::Remove(id) => {
                let before = sessions.len();
                sessions.retain(|item| item.id != id);
                changed += before - sessions.len();
            }
        }
    }
    if changed > 0 {
        sessions.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    }
    changed
}

pub fn projects(sessions: &[Session]) -> Vec<Project> {
    use std::collections::HashMap;
    let mut map: HashMap<&str, Project> = HashMap::new();
    for s in sessions {
        let entry = map.entry(&s.project_path).or_insert_with(|| Project {
            path: s.project_path.clone(),
            name: s.project_name.clone(),
            session_count: 0,
            last_at: None,
            sources: Vec::new(),
        });
        entry.session_count += 1;
        if s.last_at > entry.last_at {
            entry.last_at = s.last_at.clone();
        }
        if !entry.sources.contains(&s.source) {
            entry.sources.push(s.source.clone());
        }
    }
    let mut v: Vec<Project> = map.into_values().collect();
    v.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    v
}

pub fn search(
    sessions: &[Session],
    query: &str,
    filters: &Filters,
    limit: usize,
) -> Vec<SearchHit> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let terms: Vec<&str> = q.split_whitespace().collect();
    let mut hits = Vec::new();
    for s in sessions {
        // Session-level filters.
        if let Some(src) = &filters.source {
            if &s.source != src {
                continue;
            }
        }
        if let Some(proj) = &filters.project {
            if &s.project_path != proj {
                continue;
            }
        }
        if let Some(since) = &filters.since {
            match &s.last_at {
                Some(la) if la.as_str() >= since.as_str() => {}
                _ => continue,
            }
        }
        // Session IDs are metadata rather than message text. Treat a full or
        // partial ID match as one session result instead of manufacturing a
        // match for every message in the transcript.
        let id = s.id.to_lowercase();
        if terms.iter().all(|t| id.contains(t)) {
            let target = s
                .messages
                .iter()
                .enumerate()
                .find(|(_, m)| filters.role.as_ref().is_none_or(|role| &m.role == role));
            if let Some((msg_index, message)) = target {
                hits.push(SearchHit {
                    session: s.into(),
                    msg_index,
                    snippet: format!("Session ID: {}", s.id),
                    role: message.role.clone(),
                });
            }
            if hits.len() >= limit {
                return hits;
            }
            continue;
        }
        // Quick reject: every term must appear somewhere in the session.
        if !terms.iter().all(|t| s.haystack.contains(t)) {
            continue;
        }
        // Emit one hit per matching message (a message matches if it contains
        // all terms), so each result jumps to an exact location.
        for (i, m) in s.messages.iter().enumerate() {
            if let Some(role) = &filters.role {
                if &m.role != role {
                    continue;
                }
            }
            let lower = m.text.to_lowercase();
            if !terms.iter().all(|t| lower.contains(t)) {
                continue;
            }
            if let Some(snippet) = make_snippet(&m.text, terms[0]) {
                hits.push(SearchHit {
                    session: s.into(),
                    msg_index: i,
                    snippet,
                    role: m.role.clone(),
                });
            }
            if hits.len() >= limit {
                return hits;
            }
        }
    }
    hits
}

fn make_snippet(text: &str, needle: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let pos = lower.find(needle)?;
    let chars: Vec<char> = text.chars().collect();
    // Convert byte pos to char index.
    let char_pos = text[..pos].chars().count();
    let start = char_pos.saturating_sub(60);
    let end = (char_pos + needle.chars().count() + 60).min(chars.len());
    let mut snip: String = chars[start..end].iter().collect();
    if start > 0 {
        snip = format!("…{}", snip);
    }
    if end < chars.len() {
        snip.push('…');
    }
    Some(snip.replace('\n', " "))
}
