# backtrack

A read-only desktop app for re-reading your old Claude Code and Codex sessions.
It shows only the top-level conversation — what you said and what the agent said
back — with tool calls, results, thinking, and system noise stripped out. Sessions
are grouped by project, with fast full-text search across everything.

It never restarts or modifies sessions. It only reads the logs on disk.

## Data sources

- **Claude Code** — `~/.claude/projects/<encoded-cwd>/*.jsonl`
- **Codex** — `~/.codex/sessions/YYYY/MM/DD/*.jsonl`

The Rust backend (`src-tauri/src/sessions.rs`) parses both formats on launch and
holds an in-memory index. Project grouping uses the session's recorded `cwd`.

## Run

```sh
bun install
bun run tauri dev
```

## Build a distributable .app

```sh
bun run tauri build
# → src-tauri/target/release/bundle/macos/backtrack.app
```

## Usage

It opens straight to your most recent session, so "what was I just doing" is
answered immediately. Built around *recency + precision*: find the exact thing an
agent said a couple hours / a session or two ago without rehydrating a dead session.

- **Search** (`⌘K`): every message across all sessions. Returns one result per
  matching *message* — clicking lands you on that exact line, highlighted.
- **Filters** (under the search box): who spoke (you / agent), source, project,
  time window. Combine with a query to narrow the haystack.
- **Find in session** (`⌘F`): in-transcript find with `n`/`N` (or `⏎`/`⇧⏎`) to step
  matches and a live count.
- Badges: `CC` = Claude Code, `CX` = Codex.

### Keyboard

| Key | Action |
| --- | --- |
| `⌘K` | Search everything |
| `⌘F` | Find within the open session |
| `Tab` | Switch between list and transcript |
| `↑ ↓` / `j k` | Move in list · jump message-to-message |
| `→` / `⏎` | Open selected (expand project / open session) |
| `←` | Collapse project |
| `[` `]` | Previous / next session (global recency order) |
| `⏎` / `⇧⏎` | Next / previous find match |
| `Esc` | Close find · clear search · back out |
| `?` | Toggle the shortcut legend |

Moving the list selection auto-previews the session (Mail.app style), so you can
scan fast.

## Notes / next

- The index is built once at startup. Use the `reindex` command (already wired in
  the backend) to refresh without restarting — not yet exposed in the UI.
- Sessions with no real top-level prose (command-only / empty logs) are skipped,
  so the indexed count is lower than the raw file count.
- Search ranking is recency-first; match-count ranking is a planned follow-on.
