import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import { marked } from "marked";

type Project = {
  path: string;
  name: string;
  session_count: number;
  last_at: string | null;
  sources: string[];
};
type SessionMeta = {
  id: string;
  source: string;
  project_path: string;
  project_name: string;
  title: string;
  model: string | null;
  started_at: string | null;
  last_at: string | null;
  msg_count: number;
};
type Message = { role: string; text: string; ts: string | null; phase?: string | null };
type SessionDetail = { meta: SessionMeta; messages: Message[] };
type SearchHit = { session: SessionMeta; msg_index: number; snippet: string; role: string };

type NavItem =
  | { kind: "project"; path: string }
  | { kind: "session"; id: string; path: string }
  | { kind: "hit"; id: string; msgIndex: number };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const listEl = $("#list");
const transcriptEl = $("#transcript");
const headEl = $("#transcript-head");
const tabbarEl = $("#tabbar");
const searchEl = $<HTMLInputElement>("#search");
const refreshBtn = $<HTMLButtonElement>("#refresh");
const findBar = $("#find");
const findInput = $<HTMLInputElement>("#find-input");
const findCount = $("#find-count");
const legendEl = $("#legend");

const fSource = $<HTMLSelectElement>("#f-source");
const fRole = $<HTMLSelectElement>("#f-role");
const fProject = $<HTMLSelectElement>("#f-project");
const fSince = $<HTMLSelectElement>("#f-since");

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("text", plaintext);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("javascript", typescript);
hljs.registerLanguage("js", typescript);
hljs.registerLanguage("jsx", typescript);

// ---- state -----------------------------------------------------------------

let projects: Project[] = [];
let allSessions: SessionMeta[] = []; // global recency order, for [ ] hops
const sessionsCache = new Map<string, SessionMeta[]>();
const expanded = new Set<string>();
const pinned = new Set<string>(JSON.parse(localStorage.getItem("bt-pinned") ?? "[]") as string[]);
const projectSourceFilters = new Map<string, string>(
  JSON.parse(localStorage.getItem("bt-project-sources") ?? "[]") as [string, string][],
);

function savePin() {
  localStorage.setItem("bt-pinned", JSON.stringify([...pinned]));
}

function togglePin(path: string) {
  if (pinned.has(path)) pinned.delete(path);
  else pinned.add(path);
  savePin();
  renderList();
}

function saveProjectSourceFilters() {
  localStorage.setItem("bt-project-sources", JSON.stringify([...projectSourceFilters]));
}

function setProjectSourceFilter(path: string, source: string | null) {
  if (source) projectSourceFilters.set(path, source);
  else projectSourceFilters.delete(path);
  saveProjectSourceFilters();
  expanded.add(path);
  ensureSessions(path).then(() => renderList(currentListFilters()));
  renderList(currentListFilters());
}
let mode: "browse" | "search" = "browse";

// ---- tabs ------------------------------------------------------------------

type Tab = { id: string; detail: SessionDetail | null };
let tabs: Tab[] = [];
let activeTabId: string | null = null;

let activeId: string | null = null;
let currentDetail: SessionDetail | null = null;
let globalTerms: string[] = []; // terms from the global search, highlighted in transcript

let zone: "list" | "transcript" = "list";
let navItems: NavItem[] = [];
let navIndex = -1;
let msgIndex = -1;

let marks: HTMLElement[] = []; // current highlight marks (find or global)
let markIndex = -1;
let refreshing = false;

const FONT_SCALE_KEY = "bt-font-scale";
const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.35;
const FONT_SCALE_STEP = 0.08;
let fontScale = Number(localStorage.getItem(FONT_SCALE_KEY) ?? "1");

// ---- helpers ---------------------------------------------------------------

function applyFontScale() {
  fontScale = Math.max(FONT_SCALE_MIN, Math.min(FONT_SCALE_MAX, fontScale));
  document.documentElement.style.setProperty("--font-scale", fontScale.toFixed(2));
  localStorage.setItem(FONT_SCALE_KEY, fontScale.toFixed(2));
}

function adjustFontScale(dir: number) {
  fontScale += dir * FONT_SCALE_STEP;
  applyFontScale();
}

function resetFontScale() {
  fontScale = 1;
  applyFontScale();
}

function fmtExact(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function fmtSessionRange(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  if (!start) return fmtExact(end);
  const startDate = new Date(start);
  const endDate = end ? new Date(end) : null;
  if (!endDate || isNaN(endDate.getTime()) || start === end) return fmtExact(start);
  const sameDay =
    startDate.getFullYear() === endDate.getFullYear() &&
    startDate.getMonth() === endDate.getMonth() &&
    startDate.getDate() === endDate.getDate();
  if (sameDay) return `${fmtExact(start)} - ${fmtTime(end)}`;
  return `${fmtExact(start)} - ${fmtExact(end)}`;
}

function relDay(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff} days ago`;
  return fmtExact(iso);
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}

function highlightHtml(text: string, terms: string[]): string {
  let html = escapeHtml(text);
  for (const t of terms) {
    if (!t) continue;
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    html = html.replace(re, "<mark>$1</mark>");
  }
  return html;
}

function renderAgentText(text: string, terms: string[] = []): HTMLElement {
  const body = el("div", "turn-body");
  const html = marked.parse(text, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
  body.innerHTML = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "a",
      "blockquote",
      "br",
      "code",
      "del",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "hr",
      "li",
      "ol",
      "p",
      "pre",
      "strong",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ],
    ALLOWED_ATTR: ["class", "href", "rel", "target"],
  });
  body.querySelectorAll("a").forEach((a) => {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noreferrer");
  });
  body.querySelectorAll("pre code").forEach((code) => hljs.highlightElement(code as HTMLElement));
  markTerms(body, terms);
  return body;
}

function renderCommentaryGroup(messages: Message[]): HTMLElement {
  const turn = el("div", "turn assistant commentary collapsed");
  const summary = el("button", "commentary-summary") as HTMLButtonElement;
  const preview = messages[0]?.text.replace(/\s+/g, " ").trim() ?? "";
  summary.type = "button";
  summary.append(
    el("span", "commentary-caret", "›"),
    el("span", "turn-role", messages.length > 1 ? `Worklog ${messages.length}` : "Worklog"),
    el("span", "commentary-preview", preview),
  );
  const body = el("div", "commentary-group-body");
  messages.forEach((msg) => body.append(renderAgentText(msg.text, globalTerms)));
  turn.append(summary, body);
  summary.addEventListener("click", () => {
    turn.classList.toggle("collapsed");
  });
  return turn;
}

function markTerms(root: HTMLElement, terms: string[]) {
  const cleanTerms = terms.map((t) => t.trim()).filter(Boolean);
  if (!cleanTerms.length) return;
  const re = new RegExp(`(${cleanTerms.map(escapeRegExp).join("|")})`, "gi");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("mark")) return NodeFilter.FILTER_REJECT;
      re.lastIndex = 0;
      return re.test(node.nodeValue ?? "") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of (node.nodeValue ?? "").split(re)) {
      if (!part) continue;
      if (cleanTerms.some((t) => t.toLowerCase() === part.toLowerCase())) {
        frag.append(el("mark", undefined, part));
      } else {
        frag.append(document.createTextNode(part));
      }
    }
    node.replaceWith(frag);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function agentLabel(source: string): string {
  return source === "claude" ? "Claude" : "Codex";
}
function badgeShort(source: string): string {
  return source === "claude" ? "CC" : "CX";
}

function resumeCommand(m: SessionMeta): string {
  return m.source === "claude" ? `claude --resume ${m.id}` : `codex resume ${m.id}`;
}

async function copyText(text: string, btn: HTMLElement) {
  await navigator.clipboard.writeText(text);
  const original = btn.textContent;
  btn.textContent = "Copied";
  window.setTimeout(() => {
    btn.textContent = original;
  }, 900);
}

function currentListFilters() {
  const hasFilters = !!(fSource.value || fRole.value || fProject.value || fSince.value);
  return hasFilters ? buildFilters() : undefined;
}

// ---- browse view -----------------------------------------------------------

async function loadData() {
  [projects, allSessions] = await Promise.all([
    invoke<Project[]>("get_projects"),
    invoke<SessionMeta[]>("get_recent"),
  ]);
  fProject.replaceChildren(el("option", undefined, "All projects"));
  (fProject.firstElementChild as HTMLOptionElement).value = "";
  for (const p of projects) {
    const o = document.createElement("option");
    o.value = p.path;
    o.textContent = p.name;
    fProject.append(o);
  }
  renderList();
  // Auto-open the most recent session so "what was I just doing" is immediate.
  if (allSessions.length) openSession(allSessions[0].id);
}

async function refreshHistories() {
  if (refreshing) return;
  refreshing = true;
  refreshBtn.disabled = true;
  refreshBtn.classList.add("refreshing");
  const scrollTop = transcriptEl.scrollTop;
  const activeBefore = activeTabId;
  const selectedProject = fProject.value;
  try {
    await invoke<number>("reindex");
    sessionsCache.clear();
    [projects, allSessions] = await Promise.all([
      invoke<Project[]>("get_projects"),
      invoke<SessionMeta[]>("get_recent"),
    ]);
    fProject.replaceChildren(el("option", undefined, "All projects"));
    (fProject.firstElementChild as HTMLOptionElement).value = "";
    for (const p of projects) {
      const o = document.createElement("option");
      o.value = p.path;
      o.textContent = p.name;
      fProject.append(o);
    }
    if (selectedProject && projects.some((p) => p.path === selectedProject)) {
      fProject.value = selectedProject;
    } else if (selectedProject) {
      fProject.value = "";
      fProject.classList.remove("set");
    }
    for (let i = tabs.length - 1; i >= 0; i--) {
      const detail = await invoke<SessionDetail | null>("get_transcript", { id: tabs[i].id });
      if (detail) tabs[i].detail = detail;
      else tabs.splice(i, 1);
    }
    if (activeBefore && tabs.some((t) => t.id === activeBefore)) {
      switchTab(activeBefore);
      transcriptEl.scrollTop = scrollTop;
    } else if (tabs[0]) {
      switchTab(tabs[0].id);
    } else if (allSessions.length) {
      await openSession(allSessions[0].id);
    }
    await runSearch();
    renderTabBar();
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove("refreshing");
    refreshing = false;
  }
}

function renderList(filters?: Record<string, string>) {
  mode = "browse";
  listEl.innerHTML = "";
  navItems = [];

  const cutoff = filters?.since ? new Date(filters.since) : null;
  let visible = [...projects].sort((a, b) => {
    const ap = pinned.has(a.path) ? 0 : 1;
    const bp = pinned.has(b.path) ? 0 : 1;
    return ap - bp;
  });
  if (filters?.source) visible = visible.filter((p) => p.sources.includes(filters.source!));
  if (filters?.project) visible = visible.filter((p) => p.path === filters.project);

  for (const p of visible) {
    const isOpen = expanded.has(p.path) || !!(filters?.project || filters?.source || cutoff);
    const isPinned = pinned.has(p.path);
    const projectSource = filters?.source || projectSourceFilters.get(p.path) || "";
    const head = el("div", isPinned ? "proj-head pinned" : "proj-head");
    head.dataset.nav = String(navItems.length);
    navItems.push({ kind: "project", path: p.path });
    const pinBtn = el("span", "pin-btn", isPinned ? "◆" : "◇");
    pinBtn.title = isPinned ? "Unpin" : "Pin to top";
    pinBtn.onclick = (e) => { e.stopPropagation(); togglePin(p.path); };
    const count = sessionsCache.has(p.path) && projectSource
      ? sessionsCache.get(p.path)!.filter((s) => s.source === projectSource).length
      : p.session_count;
    const left = el("span", "proj-left");
    left.append(el("span", "twisty", isOpen ? "▾" : "▸"), el("span", "proj-name", p.name));
    const controls = el("span", "proj-controls");
    if (!filters?.source && p.sources.length > 1) {
      const sourceSwitch = el("span", "proj-source-switch");
      for (const [value, label] of [["", "All"], ["claude", "CC"], ["codex", "CX"]] as const) {
        const btn = el("button", value === projectSource ? "proj-source active" : "proj-source", label);
        btn.title = value ? `Show only ${agentLabel(value)} sessions in this project` : "Show all sessions in this project";
        btn.onclick = (e) => {
          e.stopPropagation();
          setProjectSourceFilter(p.path, value || null);
        };
        sourceSwitch.append(btn);
      }
      controls.append(sourceSwitch);
    }
    controls.append(el("span", "proj-count", String(count)), pinBtn);
    head.append(left, controls);
    head.onclick = () => toggleProject(p.path);
    listEl.append(head);

    if (isOpen) {
      const cached = sessionsCache.get(p.path) || [];
      let rows = cached;
      if (projectSource) rows = rows.filter((s) => s.source === projectSource);
      if (cutoff) rows = rows.filter((s) => s.last_at && new Date(s.last_at) >= cutoff);
      if (!cached.length) {
        // sessions not loaded yet under a filter — load lazily
        ensureSessions(p.path).then(() => renderList(filters));
      }
      const wrap = el("div", "sessions");
      for (const s of rows) {
        const r = sessionRow(s);
        r.dataset.nav = String(navItems.length);
        navItems.push({ kind: "session", id: s.id, path: p.path });
        wrap.append(r);
      }
      listEl.append(wrap);
    }
  }
  syncNavSelection();
}

function sessionRow(s: SessionMeta): HTMLElement {
  const r = el("div", "session");
  r.classList.toggle("active", s.id === activeId);
  r.dataset.id = s.id;
  const meta = el("div", "session-meta");
  meta.append(
    el("span", `badge ${s.source}`, badgeShort(s.source)),
    ...(s.model ? [el("span", "session-model", s.model)] : []),
    el("span", "session-date", fmtSessionRange(s.started_at, s.last_at)),
    el("span", "session-msgs", `${s.msg_count} msgs`),
  );
  r.append(el("div", "session-title", s.title), meta);
  r.onclick = () => openSession(s.id);
  return r;
}

async function ensureSessions(path: string) {
  if (!sessionsCache.has(path)) {
    sessionsCache.set(path, await invoke<SessionMeta[]>("get_sessions", { projectPath: path }));
  }
}

async function toggleProject(path: string) {
  if (expanded.has(path)) expanded.delete(path);
  else {
    expanded.add(path);
    await ensureSessions(path);
  }
  renderList();
}

// ---- transcript ------------------------------------------------------------

function renderTabBar() {
  tabbarEl.innerHTML = "";
  if (!tabs.length) return;
  for (const tab of tabs) {
    const title = tab.detail?.meta.title ?? "…";
    const isActive = tab.id === activeTabId;
    const t = el("div", isActive ? "tab active" : "tab");
    t.title = title;
    const label = el("span", "tab-label", title);
    const close = el("button", "tab-close", "×");
    close.title = "Close";
    close.onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };
    t.append(label, close);
    t.onclick = () => switchTab(tab.id);
    tabbarEl.append(t);
  }
  // Scroll active tab into view
  const activeEl = tabbarEl.querySelector<HTMLElement>(".tab.active");
  activeEl?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function switchTab(id: string) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeTabId = id;
  activeId = id;
  document.querySelectorAll(".session.active, .hit.active").forEach((e) => e.classList.remove("active"));
  document.querySelector(`[data-id="${id}"]`)?.classList.add("active");
  if (tab.detail) {
    currentDetail = tab.detail;
    renderTranscript(tab.detail);
  }
  renderTabBar();
}

function switchTabByOffset(offset: number) {
  if (tabs.length < 2 || !activeTabId) return;
  const i = tabs.findIndex((t) => t.id === activeTabId);
  if (i < 0) return;
  const next = tabs[(i + offset + tabs.length) % tabs.length];
  switchTab(next.id);
}

function closeTab(id: string) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  tabs.splice(idx, 1);
  if (activeTabId === id) {
    const next = tabs[idx] ?? tabs[idx - 1] ?? null;
    if (next) switchTab(next.id);
    else {
      activeTabId = null;
      activeId = null;
      headEl.innerHTML = "";
      transcriptEl.innerHTML = "";
      currentDetail = null;
    }
  }
  renderTabBar();
  document.querySelectorAll(".session.active, .hit.active").forEach((e) => e.classList.remove("active"));
  if (activeId) document.querySelector(`[data-id="${activeId}"]`)?.classList.add("active");
}

function closeActiveTab(): boolean {
  if (!activeTabId) return false;
  closeTab(activeTabId);
  return true;
}

async function openSession(id: string, jumpMsg?: number) {
  // If already open, just switch to it
  const existing = tabs.find((t) => t.id === id);
  if (existing) {
    switchTab(id);
    if (jumpMsg != null) {
      zone = "transcript";
      focusMessage(jumpMsg);
    }
    return;
  }

  // Add a placeholder tab immediately so the UI responds
  const placeholder: Tab = { id, detail: null };
  tabs.push(placeholder);
  activeTabId = id;
  activeId = id;
  renderTabBar();
  document.querySelectorAll(".session.active, .hit.active").forEach((e) => e.classList.remove("active"));
  document.querySelector(`[data-id="${id}"]`)?.classList.add("active");

  const detail = await invoke<SessionDetail | null>("get_transcript", { id });
  if (!detail) { closeTab(id); return; }

  placeholder.detail = detail;
  currentDetail = detail;
  renderTranscript(detail);
  renderTabBar(); // update title now that detail is loaded

  if (jumpMsg != null) {
    zone = "transcript";
    focusMessage(jumpMsg);
    const turn = transcriptEl.children[jumpMsg] as HTMLElement | undefined;
    const m = turn?.querySelector("mark");
    if (m) {
      marks = Array.from(transcriptEl.querySelectorAll("mark"));
      markIndex = marks.indexOf(m);
      setCurrentMark();
    }
  }
}

function renderTranscript(d: SessionDetail) {
  const m = d.meta;
  headEl.innerHTML = "";
  const copyId = el("button", "head-action", "ID") as HTMLButtonElement;
  copyId.title = `Copy session ID: ${m.id}`;
  copyId.onclick = () => copyText(m.id, copyId);
  const copyResume = el("button", "head-action", "Resume") as HTMLButtonElement;
  copyResume.title = `Copy resume command: ${resumeCommand(m)}`;
  copyResume.onclick = () => copyText(resumeCommand(m), copyResume);
  headEl.append(
    el("h1", "head-title", m.title),
    (() => {
      const sub = el("div", "head-sub");
      sub.append(
        el("span", `badge ${m.source}`, m.source === "claude" ? "Claude Code" : "Codex"),
        ...(m.model ? [el("span", "head-model", m.model)] : []),
        el("span", "head-proj", m.project_name),
        el("span", "head-date", fmtSessionRange(m.started_at, m.last_at)),
        el("span", "head-msgs", `${m.msg_count} messages`),
        copyId,
        copyResume,
      );
      return sub;
    })(),
  );

  transcriptEl.innerHTML = "";
  for (let i = 0; i < d.messages.length; i++) {
    const msg = d.messages[i];
    if (msg.role === "assistant" && msg.phase === "commentary") {
      const group = [msg];
      while (
        d.messages[i + 1]?.role === "assistant" &&
        d.messages[i + 1]?.phase === "commentary"
      ) {
        group.push(d.messages[++i]);
      }
      transcriptEl.append(renderCommentaryGroup(group));
      continue;
    }
    const turn = el("div", `turn ${msg.role}`);
    turn.append(
      el("div", "turn-role", msg.role === "user" ? "You" : agentLabel(m.source)),
      renderAgentText(msg.text, globalTerms),
    );
    transcriptEl.append(turn);
  }
  transcriptEl.scrollTop = 0;
  msgIndex = -1;
  marks = globalTerms.length ? Array.from(transcriptEl.querySelectorAll("mark")) : [];
  markIndex = -1;
}

function toggleCurrentWorklog(): boolean {
  const current = transcriptEl.children[msgIndex] as HTMLElement | undefined;
  if (!current?.classList.contains("commentary")) return false;
  current.classList.toggle("collapsed");
  current.scrollIntoView({ block: "nearest" });
  return true;
}

function focusMessage(i: number, block: ScrollLogicalPosition = "nearest") {
  const turns = transcriptEl.children;
  if (!turns.length) return;
  msgIndex = Math.max(0, Math.min(i, turns.length - 1));
  Array.from(turns).forEach((t, idx) => t.classList.toggle("cursor", idx === msgIndex));
  (turns[msgIndex] as HTMLElement).scrollIntoView({ block });
}

function moveMsg(dir: number) {
  if (!currentDetail) return;
  focusMessage(msgIndex < 0 ? (dir > 0 ? 0 : transcriptEl.children.length - 1) : msgIndex + dir);
}

function moveUserMsg(dir: number) {
  if (!currentDetail) return;
  const userIndexes = currentDetail.messages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);
  if (!userIndexes.length) return;
  const current = msgIndex < 0 ? (dir > 0 ? -1 : transcriptEl.children.length) : msgIndex;
  const next = dir > 0
    ? userIndexes.find((i) => i > current) ?? userIndexes[0]
    : [...userIndexes].reverse().find((i) => i < current) ?? userIndexes[userIndexes.length - 1];
  focusMessage(next, "center");
}

function sessionMatchesActiveFilters(s: SessionMeta): boolean {
  const projectPath = currentDetail?.meta.project_path;
  if (!projectPath || s.project_path !== projectPath) return false;
  if (fProject.value && s.project_path !== fProject.value) return false;
  const source = fSource.value || projectSourceFilters.get(projectPath) || "";
  if (source && s.source !== source) return false;
  if (fSince.value) {
    const cutoff = new Date(Date.now() - parseInt(fSince.value, 10) * 86400000);
    if (!s.last_at || new Date(s.last_at) < cutoff) return false;
  }
  return true;
}

function hopSession(dir: number) {
  const q = searchEl.value.trim().toLowerCase();
  const searchSessionIds = q
    ? new Set(
        navItems
          .filter((it): it is Extract<NavItem, { kind: "hit" }> => it.kind === "hit")
          .map((it) => it.id),
      )
    : null;
  const scopedSessions = allSessions.filter((s) => {
    if (!sessionMatchesActiveFilters(s)) return false;
    return searchSessionIds ? searchSessionIds.has(s.id) : true;
  });
  if (!scopedSessions.length) return;
  let i = scopedSessions.findIndex((s) => s.id === activeId);
  if (i < 0) i = 0;
  const next = scopedSessions[Math.max(0, Math.min(i + dir, scopedSessions.length - 1))];
  if (next && next.id !== activeId) openSession(next.id, 0);
}

// ---- search ----------------------------------------------------------------

let searchTimer: number | undefined;
searchEl.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, 130);
});
[fSource, fRole, fProject, fSince].forEach((sel) =>
  sel.addEventListener("change", () => {
    sel.classList.toggle("set", !!sel.value);
    runSearch();
  }),
);
refreshBtn.addEventListener("click", () => refreshHistories());

function buildFilters() {
  const f: Record<string, string> = {};
  if (fSource.value) f.source = fSource.value;
  if (fRole.value) f.role = fRole.value;
  if (fProject.value) f.project = fProject.value;
  if (fSince.value) {
    const cutoff = new Date(Date.now() - parseInt(fSince.value, 10) * 86400000);
    f.since = cutoff.toISOString();
  }
  return f;
}

async function runSearch() {
  const q = searchEl.value.trim();
  globalTerms = q ? q.split(/\s+/) : [];
  const hasFilters = !!(fSource.value || fRole.value || fProject.value || fSince.value);
  if (!q && !hasFilters) {
    renderList();
    return;
  }
  if (!q) {
    renderList(buildFilters());
    return;
  }
  const hits = await invoke<SearchHit[]>("search", { query: q, filters: buildFilters() });
  renderHits(hits);
}

function renderHits(hits: SearchHit[]) {
  mode = "search";
  listEl.innerHTML = "";
  navItems = [];
  listEl.append(el("div", "search-count", `${hits.length} match${hits.length === 1 ? "" : "es"}`));
  for (const h of hits) {
    const r = el("div", "hit");
    r.classList.toggle("active", h.session.id === activeId);
    r.dataset.id = h.session.id;
    r.dataset.nav = String(navItems.length);
    navItems.push({ kind: "hit", id: h.session.id, msgIndex: h.msg_index });
    const top = el("div", "hit-top");
    top.append(
      el("span", `badge ${h.session.source}`, badgeShort(h.session.source)),
      ...(h.session.model ? [el("span", "hit-model", h.session.model)] : []),
      el("span", "hit-proj", h.session.project_name),
      el("span", "hit-date", relDay(h.session.last_at)),
      el("span", "hit-who", h.role === "user" ? "you" : "agent"),
    );
    const snip = el("div", "hit-snip");
    snip.innerHTML = highlightHtml(h.snippet, globalTerms);
    r.append(top, el("div", "hit-title", h.session.title), snip);
    r.onclick = () => openSession(h.session.id, h.msg_index);
    listEl.append(r);
  }
  navIndex = -1;
}

function clearSearch() {
  searchEl.value = "";
  globalTerms = [];
  renderList();
  searchEl.blur();
}

// ---- in-session find (⌘F) --------------------------------------------------

let findVisible = false;

function openFind() {
  if (!currentDetail) return;
  findVisible = true;
  findBar.classList.remove("hidden");
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind();
}

function closeFind() {
  findVisible = false;
  findBar.classList.add("hidden");
  // restore global-search highlight (if any)
  if (currentDetail) renderTranscript(currentDetail);
  if (msgIndex >= 0) focusMessage(msgIndex);
  transcriptEl.focus();
}

findInput.addEventListener("input", runFind);

function runFind() {
  if (!currentDetail) return;
  const q = findInput.value.trim();
  const terms = q ? [q] : [];
  // Re-render bodies highlighting the find term (independent of global search).
  Array.from(transcriptEl.children).forEach((turn, i) => {
    const body = turn.querySelector(".turn-body") as HTMLElement;
    body.replaceWith(renderAgentText(currentDetail!.messages[i].text, terms));
  });
  marks = Array.from(transcriptEl.querySelectorAll("mark"));
  markIndex = marks.length ? 0 : -1;
  updateFindCount();
  setCurrentMark();
}

function updateFindCount() {
  findCount.textContent = marks.length ? `${markIndex + 1}/${marks.length}` : "0/0";
}

function setCurrentMark() {
  marks.forEach((m, i) => m.classList.toggle("current", i === markIndex));
  if (markIndex >= 0 && marks[markIndex]) {
    marks[markIndex].scrollIntoView({ block: "center" });
  }
  updateFindCount();
}

function findStep(dir: number) {
  if (!marks.length) return;
  markIndex = (markIndex + dir + marks.length) % marks.length;
  setCurrentMark();
}

$("#find-next").onclick = () => findStep(1);
$("#find-prev").onclick = () => findStep(-1);
$("#find-close").onclick = closeFind;

// ---- keyboard nav ----------------------------------------------------------

function syncNavSelection() {
  listEl.querySelectorAll(".sel").forEach((e) => e.classList.remove("sel"));
  if (navIndex < 0 || navIndex >= navItems.length) return;
  const e = listEl.querySelector(`[data-nav="${navIndex}"]`);
  if (e) {
    e.classList.add("sel");
    e.scrollIntoView({ block: "nearest" });
  }
}

async function moveNav(dir: number) {
  if (!navItems.length) return;
  navIndex = navIndex < 0 ? (dir > 0 ? 0 : navItems.length - 1) : navIndex + dir;
  navIndex = Math.max(0, Math.min(navIndex, navItems.length - 1));
  syncNavSelection();
  // Auto-preview sessions/hits as you scan, like Mail.app.
  const it = navItems[navIndex];
  if (it.kind === "session") openSession(it.id);
  else if (it.kind === "hit") openSession(it.id, it.msgIndex);
}

async function activateNav() {
  const it = navItems[navIndex];
  if (!it) return;
  if (it.kind === "project") {
    await toggleProject(it.path);
    // keep selection on the project row
    syncNavSelection();
  } else if (it.kind === "session") {
    openSession(it.id);
    zone = "transcript";
  } else {
    openSession(it.id, it.msgIndex);
    zone = "transcript";
  }
}

async function collapseNav() {
  const it = navItems[navIndex];
  if (!it) return;
  if (it.kind === "project" && expanded.has(it.path)) {
    await toggleProject(it.path);
  } else if (it.kind === "session") {
    // jump selection back up to the owning project
    const pIdx = navItems.findIndex((n) => n.kind === "project" && n.path === it.path);
    if (pIdx >= 0) {
      navIndex = pIdx;
      syncNavSelection();
    }
  }
}

function toggleLegend(force?: boolean) {
  const show = force ?? legendEl.classList.contains("hidden");
  legendEl.classList.toggle("hidden", !show);
}

window.addEventListener("keydown", (e) => {
  const ae = document.activeElement as HTMLElement | null;
  const inSearch = ae === searchEl;
  const inFind = ae === findInput;
  const inSelect = ae?.tagName === "SELECT";

  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    openFind();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") {
    e.preventDefault();
    refreshHistories();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "w") {
    if (closeActiveTab()) e.preventDefault();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === "+" || e.key === "=")) {
    e.preventDefault();
    adjustFontScale(1);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "-") {
    e.preventDefault();
    adjustFontScale(-1);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "0") {
    e.preventDefault();
    resetFontScale();
    return;
  }
  if (e.ctrlKey && e.key === "Tab") {
    e.preventDefault();
    switchTabByOffset(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.ctrlKey && e.key === "PageDown") {
    e.preventDefault();
    switchTabByOffset(1);
    return;
  }
  if (e.ctrlKey && e.key === "PageUp") {
    e.preventDefault();
    switchTabByOffset(-1);
    return;
  }

  if (inFind) {
    if (e.key === "Enter") {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFind();
    }
    return;
  }
  if (inSearch) {
    if (e.key === "Escape") {
      e.preventDefault();
      clearSearch();
    } else if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      zone = "list";
      searchEl.blur();
      if (navItems.length) {
        navIndex = 0;
        syncNavSelection();
        if (e.key === "Enter") activateNav();
        else moveNav(0);
      }
    }
    return;
  }
  if (inSelect) {
    if (e.key === "Escape") ae!.blur();
    return;
  }

  if (e.key === "?") {
    e.preventDefault();
    toggleLegend();
    return;
  }
  if (!legendEl.classList.contains("hidden")) {
    if (e.key === "Escape") toggleLegend(false);
    return;
  }
  if (e.key === "Escape") {
    if (findVisible) closeFind();
    else if (mode === "search") clearSearch();
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    zone = zone === "list" ? "transcript" : "list";
    if (zone === "transcript" && msgIndex < 0) focusMessage(0);
    if (zone === "list") syncNavSelection();
    return;
  }

  if (zone === "list") {
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      moveNav(1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      moveNav(-1);
    } else if (e.key === "ArrowRight" || e.key === "l" || e.key === "Enter") {
      e.preventDefault();
      activateNav();
    } else if (e.key === "ArrowLeft" || e.key === "h") {
      e.preventDefault();
      collapseNav();
    }
  } else {
    if (e.key.toLowerCase() === "w") {
      if (toggleCurrentWorklog()) e.preventDefault();
    } else if (e.key === "J") {
      e.preventDefault();
      moveUserMsg(1);
    } else if (e.key === "K") {
      e.preventDefault();
      moveUserMsg(-1);
    } else if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      moveMsg(1);
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      moveMsg(-1);
    } else if (e.key === "[") {
      e.preventDefault();
      hopSession(-1);
    } else if (e.key === "]") {
      e.preventDefault();
      hopSession(1);
    }
  }
});

legendEl.addEventListener("click", () => toggleLegend(false));

// Keep the keyboard zone in sync with where the user clicks.
listEl.addEventListener("mousedown", () => (zone = "list"));
transcriptEl.addEventListener("mousedown", () => {
  zone = "transcript";
  if (msgIndex < 0) focusMessage(0);
});

// Wire up drag regions — data-tauri-drag-region alone requires Tauri's runtime
// injection; explicit startDragging() is more reliable.
const appWin = getCurrentWindow();
document.querySelectorAll<HTMLElement>("[data-tauri-drag-region]").forEach((el) => {
  el.addEventListener("mousedown", (e) => {
    if (e.buttons === 1 && e.target === el) appWin.startDragging();
  });
});

applyFontScale();
loadData();
