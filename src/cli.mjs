#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const home = homedir();
const cwd = process.cwd();
const defaultDataDir = join(cwd, "work");
const dbPath =
  process.env.CODEX_SESSIONS_DB || join(defaultDataDir, "codex-sessions.sqlite");
const codexDir = process.env.CODEX_HOME || join(home, ".codex");

function usage() {
  console.log(`Usage:
  codex-sessions scan
  codex-sessions list [--status active|archived|workspace_missing|projectless] [--workspace <path>] [--limit <n>]
  codex-sessions search <query> [--limit <n>]
  codex-sessions show <session-id>
  codex-sessions export <session-id> [--out <dir>] [--all]
  codex-sessions serve [--port <n>]
  codex-sessions db-path

Environment:
  CODEX_HOME         Codex data directory. Default: ~/.codex
  CODEX_SESSIONS_DB SQLite index path. Default: ./work/codex-sessions.sqlite`);
}

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function shellSql(db, sql) {
  return execFileSync("sqlite3", [db], {
    encoding: "utf8",
    input: sql,
    maxBuffer: 1024 * 1024 * 100,
  });
}

function jsonSql(db, sql) {
  const out = execFileSync("sqlite3", ["-json", db, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  }).trim();
  return out ? JSON.parse(out) : [];
}

function sqlString(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value) {
  if (value == null || Number.isNaN(Number(value))) return "NULL";
  return String(Number(value));
}

function truncate(value, max = 120) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function slugify(value, max = 70) {
  const slug = String(value || "codex-session")
    .replace(/[\\/:*?"<>|，。！？；：、（）【】《》“”‘’]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
  return slug || "codex-session";
}

function markdownEscape(value) {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

function walk(dir, predicate, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) walk(path, predicate, acc);
    else if (predicate(path)) acc.push(path);
  }
  return acc;
}

function extractContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      return (
        part.text ??
        part.input_text ??
        part.output_text ??
        part.content ??
        part.markdown ??
        ""
      );
    })
    .filter(Boolean)
    .join("\n");
}

function isConversationRole(role) {
  return role === "user" || role === "assistant";
}

function parseJsonlMessages(file) {
  const lines = readFileSync(file, "utf8").split(/\n/).filter(Boolean);
  const messages = [];
  let meta = {};
  let sequence = 0;
  let parseError = null;

  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const payload = row.payload || {};
      if (row.type === "session_meta") {
        meta = {
          ...meta,
          id: payload.id ?? meta.id,
          cwd: payload.cwd ?? meta.cwd,
          cliVersion: payload.cli_version ?? meta.cliVersion,
          source: payload.source ?? meta.source,
          threadSource: payload.thread_source ?? meta.threadSource,
          modelProvider: payload.model_provider ?? meta.modelProvider,
          timestamp: payload.timestamp ?? meta.timestamp,
        };
      }
      if (row.type !== "response_item") continue;

      const role = payload.role || payload.type || "unknown";
      let content = extractContent(payload.content);
      if (!content && payload.output) content = String(payload.output);
      if (!content && payload.arguments) content = String(payload.arguments);
      if (!content && payload.name) content = payload.name;
      if (!content) continue;
      if (payload.role === "user" && content.trim().startsWith("<environment_context>")) {
        continue;
      }

      messages.push({
        id: `${meta.id || basename(file)}:${sequence}`,
        sessionId: meta.id,
        role,
        content,
        createdAt: row.timestamp || null,
        sequence,
        rawJson: JSON.stringify(payload),
      });
      sequence += 1;
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  return { meta, messages, parseError, lineCount: lines.length };
}

function readGlobalState() {
  const path = join(codexDir, ".codex-global-state.json");
  if (!existsSync(path)) {
    return {
      projectlessIds: new Set(),
      workspaceHints: {},
      projectOrder: [],
      savedWorkspaceRoots: [],
    };
  }
  const state = JSON.parse(readFileSync(path, "utf8"));
  return {
    projectlessIds: new Set(state["projectless-thread-ids"] || []),
    workspaceHints: state["thread-workspace-root-hints"] || {},
    projectOrder: state["project-order"] || [],
    savedWorkspaceRoots: state["electron-saved-workspace-roots"] || [],
  };
}

function discoverJsonlFiles() {
  const files = new Map();
  for (const path of walk(join(codexDir, "sessions"), (p) => p.endsWith(".jsonl"))) {
    files.set(path, "sessions");
  }
  for (const path of walk(join(codexDir, "archived_sessions"), (p) => p.endsWith(".jsonl"))) {
    files.set(path, "archived_sessions");
  }
  return files;
}

function ensureSchema() {
  mkdirSync(dirname(dbPath), { recursive: true });
  shellSql(
    dbPath,
    `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  source_path TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  workspace_path TEXT,
  workspace_root_hint TEXT,
  workspace_exists INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER,
  created_at_iso TEXT,
  updated_at_iso TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  projectless INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_preview TEXT,
  first_user_message TEXT,
  preview TEXT,
  cli_version TEXT,
  model TEXT,
  model_provider TEXT,
  git_branch TEXT,
  git_origin_url TEXT,
  parse_error TEXT,
  raw_metadata_json TEXT,
  exported_path TEXT,
  scanned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  created_at TEXT,
  sequence INTEGER NOT NULL,
  raw_json TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS workspaces (
  path TEXT PRIMARY KEY,
  name TEXT,
  exists_on_disk INTEGER NOT NULL DEFAULT 0,
  session_count INTEGER NOT NULL DEFAULT 0,
  last_session_updated_at INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
  session_id UNINDEXED,
  title,
  workspace_path,
  message_text
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
`
  );
  try {
    shellSql(dbPath, "ALTER TABLE sessions ADD COLUMN exported_path TEXT;");
  } catch {
    // Column already exists in indexes created by a previous version.
  }
}

function resetIndex() {
  shellSql(
    dbPath,
    `
DELETE FROM session_fts;
DELETE FROM messages;
DELETE FROM sessions;
DELETE FROM workspaces;
`
  );
}

function exportedPathMap() {
  try {
    return new Map(
      jsonSql(dbPath, "SELECT id, exported_path FROM sessions WHERE exported_path IS NOT NULL AND exported_path != '';").map(
        (row) => [row.id, row.exported_path]
      )
    );
  } catch {
    return new Map();
  }
}

function stateRows() {
  const stateDb = join(codexDir, "state_5.sqlite");
  if (!existsSync(stateDb)) return [];
  return jsonSql(
    stateDb,
    `SELECT id,title,cwd,archived,archived_at,rollout_path,created_at,updated_at,created_at_ms,updated_at_ms,first_user_message,preview,cli_version,model,model_provider,git_branch,git_origin_url
     FROM threads
     ORDER BY updated_at DESC;`
  );
}

function isoFromUnixSeconds(value) {
  if (value == null) return null;
  return new Date(Number(value) * 1000).toISOString();
}

function computeStatus({ archived, workspacePath, workspaceExists, projectless, parseError, sourceOnly }) {
  const statuses = [];
  if (parseError) statuses.push("broken");
  statuses.push(archived ? "archived" : "active");
  if (sourceOnly) statuses.push("orphaned");
  if (workspacePath && !workspaceExists) statuses.push("workspace_missing");
  if (!workspacePath) statuses.push("no_workspace");
  if (projectless) statuses.push("projectless");
  return statuses.join(",");
}

function insertSession(session, messages) {
  const messageText = messages
    .filter((m) => isConversationRole(m.role))
    .map((m) => m.content)
    .join("\n\n");
  const values = [
    sqlString(session.id),
    sqlString(session.title),
    sqlString(session.sourcePath),
    sqlString(session.sourceKind),
    sqlString(session.workspacePath),
    sqlString(session.workspaceRootHint),
    sqlNumber(session.workspaceExists ? 1 : 0),
    sqlNumber(session.createdAt),
    sqlNumber(session.updatedAt),
    sqlString(session.createdAtIso),
    sqlString(session.updatedAtIso),
    sqlNumber(session.archived ? 1 : 0),
    sqlNumber(session.projectless ? 1 : 0),
    sqlString(session.status),
    sqlNumber(messages.length),
    sqlString(session.lastMessagePreview),
    sqlString(session.firstUserMessage),
    sqlString(session.preview),
    sqlString(session.cliVersion),
    sqlString(session.model),
    sqlString(session.modelProvider),
    sqlString(session.gitBranch),
    sqlString(session.gitOriginUrl),
    sqlString(session.parseError),
    sqlString(JSON.stringify(session.rawMetadata)),
    sqlString(session.exportedPath),
    sqlString(new Date().toISOString()),
  ].join(",");

  const messageSql = messages
    .map(
      (m) => `INSERT INTO messages VALUES (${[
        sqlString(`${session.id}:${m.sequence}`),
        sqlString(session.id),
        sqlString(m.role),
        sqlString(m.content),
        sqlString(m.createdAt),
        sqlNumber(m.sequence),
        sqlString(m.rawJson),
      ].join(",")});`
    )
    .join("\n");

  shellSql(
    dbPath,
    `
BEGIN;
INSERT OR REPLACE INTO sessions (
  id,title,source_path,source_kind,workspace_path,workspace_root_hint,workspace_exists,
  created_at,updated_at,created_at_iso,updated_at_iso,archived,projectless,status,
  message_count,last_message_preview,first_user_message,preview,cli_version,model,
  model_provider,git_branch,git_origin_url,parse_error,raw_metadata_json,exported_path,scanned_at
) VALUES (${values});
${messageSql}
INSERT INTO session_fts (session_id,title,workspace_path,message_text)
VALUES (${sqlString(session.id)}, ${sqlString(session.title)}, ${sqlString(
      session.workspacePath
    )}, ${sqlString(messageText)});
COMMIT;
`
  );
}

function rebuildWorkspaces() {
  shellSql(
    dbPath,
    `
INSERT OR REPLACE INTO workspaces(path,name,exists_on_disk,session_count,last_session_updated_at)
SELECT
  workspace_path,
  CASE
    WHEN workspace_path IS NULL OR workspace_path = '' THEN 'No Workspace'
    ELSE replace(workspace_path, rtrim(workspace_path, replace(workspace_path, '/', '')), '')
  END,
  max(workspace_exists),
  count(*),
  max(updated_at)
FROM sessions
WHERE workspace_path IS NOT NULL AND workspace_path != ''
GROUP BY workspace_path;
`
  );
}

function scan(options = {}) {
  const startedAt = Date.now();
  ensureSchema();
  const existingExports = exportedPathMap();
  resetIndex();

  const globalState = readGlobalState();
  const files = discoverJsonlFiles();
  const rows = stateRows();
  const seenPaths = new Set();
  let inserted = 0;
  let parseErrors = 0;

  for (const row of rows) {
    const sourcePath = row.rollout_path;
    const sourceKind = files.get(sourcePath) || (row.archived ? "archived_sessions" : "sessions");
    const parsed = sourcePath && existsSync(sourcePath)
      ? parseJsonlMessages(sourcePath)
      : { meta: {}, messages: [], parseError: "rollout_path missing", lineCount: 0 };
    if (sourcePath) seenPaths.add(sourcePath);
    if (parsed.parseError) parseErrors += 1;

    const workspacePath = row.cwd || parsed.meta.cwd || null;
    const workspaceExists = workspacePath ? existsSync(workspacePath) : false;
    const projectless = globalState.projectlessIds.has(row.id);
    const archived = Boolean(row.archived || sourceKind === "archived_sessions");
    const lastMessage = [...parsed.messages].reverse().find((m) => isConversationRole(m.role));

    const session = {
      id: row.id || parsed.meta.id,
      title: row.title || truncate(row.first_user_message, 80) || basename(sourcePath || ""),
      sourcePath,
      sourceKind,
      workspacePath,
      workspaceRootHint: globalState.workspaceHints[row.id] || null,
      workspaceExists,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      createdAtIso: row.created_at_ms ? new Date(row.created_at_ms).toISOString() : isoFromUnixSeconds(row.created_at),
      updatedAtIso: row.updated_at_ms ? new Date(row.updated_at_ms).toISOString() : isoFromUnixSeconds(row.updated_at),
      archived,
      projectless,
      lastMessagePreview: truncate(lastMessage?.content || row.preview || row.first_user_message, 180),
      firstUserMessage: row.first_user_message || null,
      preview: row.preview || null,
      cliVersion: row.cli_version || parsed.meta.cliVersion || null,
      model: row.model || null,
      modelProvider: row.model_provider || parsed.meta.modelProvider || null,
      gitBranch: row.git_branch || null,
      gitOriginUrl: row.git_origin_url || null,
      parseError: parsed.parseError,
      exportedPath: existingExports.get(row.id) || null,
      rawMetadata: { thread: row, jsonl: parsed.meta, lineCount: parsed.lineCount },
    };
    session.status = computeStatus({
      archived: session.archived,
      workspacePath,
      workspaceExists,
      projectless,
      parseError: parsed.parseError,
      sourceOnly: false,
    });

    insertSession(session, parsed.messages);
    inserted += 1;
  }

  for (const [sourcePath, sourceKind] of files.entries()) {
    if (seenPaths.has(sourcePath)) continue;
    const parsed = parseJsonlMessages(sourcePath);
    if (parsed.parseError) parseErrors += 1;
    const id = parsed.meta.id || basename(sourcePath);
    const workspacePath = parsed.meta.cwd || null;
    const workspaceExists = workspacePath ? existsSync(workspacePath) : false;
    const projectless = globalState.projectlessIds.has(id);
    const archived = sourceKind === "archived_sessions";
    const lastMessage = [...parsed.messages].reverse().find((m) => isConversationRole(m.role));
    const session = {
      id,
      title: truncate(parsed.messages.find((m) => m.role === "user")?.content || basename(sourcePath), 100),
      sourcePath,
      sourceKind,
      workspacePath,
      workspaceRootHint: globalState.workspaceHints[id] || null,
      workspaceExists,
      createdAt: null,
      updatedAt: null,
      createdAtIso: parsed.meta.timestamp || null,
      updatedAtIso: parsed.messages.at(-1)?.createdAt || parsed.meta.timestamp || null,
      archived,
      projectless,
      lastMessagePreview: truncate(lastMessage?.content, 180),
      firstUserMessage: parsed.messages.find((m) => m.role === "user")?.content || null,
      preview: null,
      cliVersion: parsed.meta.cliVersion || null,
      model: null,
      modelProvider: parsed.meta.modelProvider || null,
      gitBranch: null,
      gitOriginUrl: null,
      parseError: parsed.parseError,
      exportedPath: existingExports.get(id) || null,
      rawMetadata: { jsonl: parsed.meta, lineCount: parsed.lineCount },
    };
    session.status = computeStatus({
      archived,
      workspacePath,
      workspaceExists,
      projectless,
      parseError: parsed.parseError,
      sourceOnly: true,
    });
    insertSession(session, parsed.messages);
    inserted += 1;
  }

  rebuildWorkspaces();
  const counts = jsonSql(
    dbPath,
    "SELECT count(*) total, sum(archived) archived, sum(case when archived=0 then 1 else 0 end) active, sum(case when workspace_exists=0 and workspace_path is not null then 1 else 0 end) workspace_missing FROM sessions;"
  )[0];
  const report = {
    ok: true,
    dbPath,
    codexDir,
    inserted,
    parseErrors,
    counts,
    durationMs: Date.now() - startedAt,
    scannedAt: new Date().toISOString(),
  };
  if (!options.silent) console.log(JSON.stringify(report, null, 2));
  return report;
}

function requireDb() {
  if (!existsSync(dbPath)) {
    console.error(`Index not found: ${dbPath}\nRun: codex-sessions scan`);
    process.exit(1);
  }
}

function list(args) {
  requireDb();
  const limit = Number(argValue(args, "--limit", "30"));
  const status = argValue(args, "--status");
  const workspace = argValue(args, "--workspace");
  const where = [];
  if (status) where.push(`status LIKE ${sqlString(`%${status}%`)}`);
  if (workspace) where.push(`workspace_path = ${sqlString(resolve(workspace))}`);
  const rows = jsonSql(
    dbPath,
    `SELECT id,title,status,workspace_path,updated_at_iso,message_count,last_message_preview
     FROM sessions
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY updated_at DESC, updated_at_iso DESC
     LIMIT ${sqlNumber(limit)};`
  );
  for (const row of rows) {
    console.log(`[${row.status}] ${row.title}`);
    console.log(`  id: ${row.id}`);
    console.log(`  workspace: ${row.workspace_path || "No Workspace"}`);
    console.log(`  updated: ${row.updated_at_iso || "unknown"} · messages: ${row.message_count}`);
    if (row.last_message_preview) console.log(`  preview: ${truncate(row.last_message_preview, 160)}`);
    console.log("");
  }
}

function search(args) {
  requireDb();
  const limit = Number(argValue(args, "--limit", "20"));
  const queryParts = args.filter((arg, i) => arg !== "--limit" && args[i - 1] !== "--limit");
  const query = queryParts.join(" ").trim();
  if (!query) {
    console.error("Missing search query.");
    process.exit(1);
  }
  const rows = jsonSql(
    dbPath,
    `SELECT s.id, s.title, s.status, s.workspace_path, s.updated_at_iso, snippet(session_fts, 3, '[', ']', '...', 24) AS snippet
     FROM session_fts
     JOIN sessions s ON s.id = session_fts.session_id
     WHERE session_fts MATCH ${sqlString(query.replaceAll("'", " "))}
     ORDER BY bm25(session_fts)
     LIMIT ${sqlNumber(limit)};`
  );
  for (const row of rows) {
    console.log(`[${row.status}] ${row.title}`);
    console.log(`  id: ${row.id}`);
    console.log(`  workspace: ${row.workspace_path || "No Workspace"}`);
    console.log(`  updated: ${row.updated_at_iso || "unknown"}`);
    console.log(`  match: ${truncate(row.snippet, 220)}`);
    console.log("");
  }
}

function show(args) {
  requireDb();
  const all = args.includes("--all");
  const id = args.find((arg) => arg !== "--all");
  if (!id) {
    console.error("Missing session id.");
    process.exit(1);
  }
  const sessions = jsonSql(dbPath, `SELECT * FROM sessions WHERE id = ${sqlString(id)};`);
  if (!sessions.length) {
    console.error(`Session not found: ${id}`);
    process.exit(1);
  }
  const session = sessions[0];
  const messages = jsonSql(
    dbPath,
    `SELECT role,content,created_at,sequence FROM messages WHERE session_id = ${sqlString(
      id
    )} ${all ? "" : "AND role IN ('user','assistant')"} ORDER BY sequence ASC;`
  );
  console.log(`# ${session.title}`);
  console.log("");
  console.log(`id: ${session.id}`);
  console.log(`status: ${session.status}`);
  console.log(`workspace: ${session.workspace_path || "No Workspace"}`);
  console.log(`source: ${session.source_path}`);
  console.log(`created: ${session.created_at_iso || "unknown"}`);
  console.log(`updated: ${session.updated_at_iso || "unknown"}`);
  console.log("");
  for (const msg of messages) {
    console.log(`## ${msg.role} ${msg.created_at ? `(${msg.created_at})` : ""}`);
    console.log("");
    console.log(msg.content);
    console.log("");
  }
}

function loadSession(id, { all = false } = {}) {
  const sessions = jsonSql(dbPath, `SELECT * FROM sessions WHERE id = ${sqlString(id)};`);
  if (!sessions.length) return null;
  const session = sessions[0];
  const messages = jsonSql(
    dbPath,
    `SELECT role,content,created_at,sequence FROM messages WHERE session_id = ${sqlString(
      id
    )} ${all ? "" : "AND role IN ('user','assistant')"} ORDER BY sequence ASC;`
  );
  return { session, messages };
}

function renderSessionMarkdown(session, messages) {
  const lines = [];
  lines.push(`# ${markdownEscape(session.title)}`);
  lines.push("");
  lines.push("## Metadata");
  lines.push("");
  lines.push(`- id: \`${session.id}\``);
  lines.push(`- status: \`${session.status}\``);
  lines.push(`- workspace: ${session.workspace_path ? `\`${session.workspace_path}\`` : "No Workspace"}`);
  lines.push(`- workspace exists: ${session.workspace_exists ? "yes" : "no"}`);
  lines.push(`- source: \`${session.source_path}\``);
  lines.push(`- created: ${session.created_at_iso || "unknown"}`);
  lines.push(`- updated: ${session.updated_at_iso || "unknown"}`);
  lines.push(`- exported: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Conversation");
  lines.push("");
  for (const msg of messages) {
    lines.push(`### ${msg.role}${msg.created_at ? ` (${msg.created_at})` : ""}`);
    lines.push("");
    lines.push(markdownEscape(msg.content));
    lines.push("");
  }
  return lines.join("\n");
}

function markSessionExported(id, file) {
  shellSql(dbPath, `UPDATE sessions SET exported_path = ${sqlString(file)} WHERE id = ${sqlString(id)};`);
}

function exportSession(args) {
  requireDb();
  const all = args.includes("--all");
  const outIndex = args.indexOf("--out");
  const id = args.find(
    (arg, index) => arg !== "--all" && arg !== "--out" && !(outIndex !== -1 && index === outIndex + 1)
  );
  const outDir = argValue(args, "--out", join(cwd, "outputs"));
  if (!id) {
    console.error("Missing session id.");
    process.exit(1);
  }
  const loaded = loadSession(id, { all });
  if (!loaded) {
    console.error(`Session not found: ${id}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const date = (loaded.session.updated_at_iso || loaded.session.created_at_iso || new Date().toISOString()).slice(0, 10);
  const file = join(outDir, `${date}-${slugify(loaded.session.title)}-${id.slice(0, 8)}.md`);
  writeFileSync(file, renderSessionMarkdown(loaded.session, loaded.messages));
  markSessionExported(id, file);
  console.log(file);
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, body, contentType = "text/html; charset=utf-8", status = 200) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function webHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Codex Sessions</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --panel: #ffffff;
      --ink: #1f2528;
      --muted: #687176;
      --line: #d9dedb;
      --accent: #0f766e;
      --warn: #b45309;
      --bad: #b42318;
      --blue: #2563eb;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
    button, input, select { font: inherit; }
    .app { display: grid; grid-template-columns: 380px 1fr; height: 100vh; min-height: 640px; }
    .sidebar { border-right: 1px solid var(--line); background: var(--panel); min-width: 0; display: flex; flex-direction: column; }
    .toolbar { padding: 14px; border-bottom: 1px solid var(--line); display: grid; gap: 10px; }
    .search { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    input, select { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; background: #fff; color: var(--ink); }
    select {
      appearance: none;
      padding-right: 34px;
      background-image: linear-gradient(45deg, transparent 50%, #596166 50%), linear-gradient(135deg, #596166 50%, transparent 50%);
      background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
    }
    button { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; background: #fff; color: var(--ink); cursor: pointer; }
    button:disabled { opacity: .68; cursor: wait; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.icon { width: 38px; padding: 8px 0; }
    .filters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .workspace-filter { grid-column: 1 / -1; }
    .stats { color: var(--muted); font-size: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
    .scan-report { display: none; border: 1px solid #c9d8d4; background: #eef8f5; color: #28534c; border-radius: 6px; padding: 8px 10px; font-size: 12px; }
    .scan-report.visible { display: block; }
    .export-path { display: none; border: 1px solid #d8e2df; background: #fbfcfb; border-radius: 6px; padding: 8px 10px; font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
    .export-path.visible { display: block; }
    .export-path strong { color: var(--ink); }
    .spinner { display: none; width: 12px; height: 12px; border: 2px solid rgba(15,118,110,.25); border-top-color: var(--accent); border-radius: 999px; animation: spin .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
    button.scanning .spinner { display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .list { overflow: auto; padding: 8px; }
    .row { width: 100%; text-align: left; border: 1px solid transparent; background: transparent; padding: 10px; border-radius: 6px; display: grid; gap: 6px; }
    .row:hover, .row.active { background: #eef4f2; border-color: #c9d8d4; }
    .title { font-weight: 650; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .meta { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badges { display: flex; gap: 5px; flex-wrap: wrap; }
    .badge { font-size: 11px; padding: 2px 6px; border-radius: 999px; background: #edf1ef; color: #445; }
    .badge.archived { color: var(--warn); background: #fff4df; }
    .badge.active { color: var(--accent); background: #e4f5f1; }
    .badge.workspace_missing { color: var(--bad); background: #fff0ed; }
    .badge.projectless { color: var(--blue); background: #eaf1ff; }
    .detail { overflow: auto; padding: 22px 28px 60px; }
    .detail-head { border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 18px; display: grid; gap: 8px; }
    h1 { font-size: 24px; line-height: 1.25; margin: 0; letter-spacing: 0; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .message { border-bottom: 1px solid var(--line); padding: 16px 0; }
    .role { font-weight: 700; margin-bottom: 8px; color: var(--accent); }
    .content { white-space: pre-wrap; overflow-wrap: anywhere; }
    .empty { color: var(--muted); display: grid; place-items: center; min-height: 70vh; text-align: center; }
    @media (max-width: 860px) {
      .app { grid-template-columns: 1fr; height: auto; }
      .sidebar { height: 48vh; border-right: 0; border-bottom: 1px solid var(--line); }
      .detail { padding: 18px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="sidebar">
      <div class="toolbar">
        <div class="search">
          <input id="query" placeholder="搜索标题、消息、工作区" />
          <button id="searchBtn" class="primary">搜索</button>
        </div>
        <div class="filters">
          <select id="status">
            <option value="">全部状态</option>
            <option value="active">活跃</option>
            <option value="archived">归档</option>
            <option value="workspace_missing">工作区缺失</option>
            <option value="projectless">Projectless</option>
          </select>
          <button id="scanBtn"><span class="spinner"></span><span id="scanText">重新扫描</span></button>
          <select id="workspace" class="workspace-filter">
            <option value="">全部工作区</option>
          </select>
        </div>
        <div id="stats" class="stats"></div>
        <div id="scanReport" class="scan-report"></div>
      </div>
      <div id="list" class="list"></div>
    </aside>
    <main id="detail" class="detail"><div class="empty">选择一个会话查看详情</div></main>
  </div>
  <script>
    const state = { selected: null, sessions: [], workspaces: [] };
    const el = (id) => document.getElementById(id);
    function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
    function badges(status) {
      return String(status || '').split(',').filter(Boolean).map(s => '<span class="badge ' + esc(s) + '">' + esc(s) + '</span>').join('');
    }
    async function loadSessions() {
      const params = new URLSearchParams();
      const q = el('query').value.trim();
      const status = el('status').value;
      const workspace = el('workspace').value;
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (workspace) params.set('workspace', workspace);
      params.set('limit', '200');
      const data = await fetch('/api/sessions?' + params).then(r => r.json());
      state.sessions = data.sessions;
      el('stats').innerHTML = '<span>总数 ' + data.counts.total + '</span><span>活跃 ' + data.counts.active + '</span><span>归档 ' + data.counts.archived + '</span><span>缺失 ' + data.counts.workspace_missing + '</span>';
      renderList();
    }
    async function loadWorkspaces() {
      const data = await fetch('/api/workspaces').then(r => r.json());
      state.workspaces = data.workspaces || [];
      const projectless = state.workspaces.find(w => w.kind === 'projectless');
      const workspaces = state.workspaces.filter(w => w.kind !== 'projectless');
      el('workspace').innerHTML =
        '<option value="">全部工作区</option>' +
        (projectless ? '<optgroup label="单独对话"><option value="__projectless__">单独对话 · ' + projectless.session_count + '</option></optgroup>' : '') +
        '<optgroup label="工作区">' +
        workspaces.map(w => '<option value="' + esc(w.path) + '">' + esc(w.name) + ' · ' + w.session_count + (w.exists_on_disk ? '' : ' · 缺失') + '</option>').join('') +
        '</optgroup>';
    }
    function renderList() {
      el('list').innerHTML = state.sessions.map(s => '<button class="row ' + (state.selected === s.id ? 'active' : '') + '" data-id="' + esc(s.id) + '"><div class="title">' + esc(s.title) + '</div><div class="badges">' + badges(s.status) + '</div><div class="meta">' + esc(s.workspace_path || 'No Workspace') + '</div><div class="meta">' + esc(s.updated_at_iso || 'unknown') + ' · ' + s.message_count + ' messages</div></button>').join('');
      for (const row of document.querySelectorAll('.row')) row.onclick = () => loadDetail(row.dataset.id);
    }
    async function loadDetail(id) {
      state.selected = id;
      renderList();
      const data = await fetch('/api/sessions/' + encodeURIComponent(id)).then(r => r.json());
      const s = data.session;
      el('detail').innerHTML = '<section class="detail-head"><h1>' + esc(s.title) + '</h1><div class="badges">' + badges(s.status) + '</div><div class="meta">' + (s.projectless ? '单独对话 · ' : '') + esc(s.workspace_path || 'No Workspace') + '</div><div class="meta">创建 ' + esc(s.created_at_iso || 'unknown') + ' · 更新 ' + esc(s.updated_at_iso || 'unknown') + '</div><div class="actions"><button id="exportBtn" class="primary">导出 Markdown</button><button id="copyIdBtn">复制 ID</button></div><div id="exportPath" class="export-path ' + (s.exported_path ? 'visible' : '') + '">' + (s.exported_path ? '<strong>已导出：</strong>' + esc(s.exported_path) : '') + '</div></section><section>' + data.messages.map(m => '<article class="message"><div class="role">' + esc(m.role) + (m.created_at ? ' <span class="meta">(' + esc(m.created_at) + ')</span>' : '') + '</div><div class="content">' + esc(m.content) + '</div></article>').join('') + '</section>';
      el('exportBtn').onclick = async () => {
        const res = await fetch('/api/sessions/' + encodeURIComponent(id) + '/export', { method: 'POST' }).then(r => r.json());
        const path = el('exportPath');
        path.className = 'export-path visible';
        path.innerHTML = '<strong>已导出：</strong>' + esc(res.path);
      };
      el('copyIdBtn').onclick = () => navigator.clipboard.writeText(id);
    }
    el('searchBtn').onclick = loadSessions;
    el('query').onkeydown = (e) => { if (e.key === 'Enter') loadSessions(); };
    el('status').onchange = loadSessions;
    el('workspace').onchange = loadSessions;
    el('scanBtn').onclick = async () => {
      const btn = el('scanBtn');
      const report = el('scanReport');
      btn.disabled = true;
      btn.classList.add('scanning');
      el('scanText').textContent = '扫描中';
      report.className = 'scan-report visible';
      report.textContent = '正在重新扫描 Codex 会话...';
      try {
        const res = await fetch('/api/scan', { method: 'POST' }).then(r => r.json());
        const c = res.counts || {};
        report.textContent = '扫描完成：总数 ' + (c.total ?? 0) + '，活跃 ' + (c.active ?? 0) + '，归档 ' + (c.archived ?? 0) + '，工作区缺失 ' + (c.workspace_missing ?? 0) + '，解析失败 ' + (res.parseErrors ?? 0) + '，耗时 ' + (res.durationMs ?? 0) + 'ms';
        await loadWorkspaces();
        await loadSessions();
      } catch (err) {
        report.textContent = '扫描失败：' + (err && err.message ? err.message : String(err));
      } finally {
        btn.disabled = false;
        btn.classList.remove('scanning');
        el('scanText').textContent = '重新扫描';
      }
    };
    loadWorkspaces().then(loadSessions);
  </script>
</body>
</html>`;
}

function serve(args) {
  requireDb();
  const port = Number(argValue(args, "--port", "8787"));
  const host = "127.0.0.1";
  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${host}:${port}`);
      if (url.pathname === "/") return sendText(res, webHtml());
      if (url.pathname === "/api/scan" && req.method === "POST") {
        const report = scan({ silent: true });
        return sendJson(res, report);
      }
      if (url.pathname === "/api/workspaces") {
        const projectless = jsonSql(
          dbPath,
          `SELECT '__projectless__' AS path, '单独对话' AS name, 1 AS exists_on_disk, count(*) AS session_count, max(updated_at) AS last_session_updated_at, 'projectless' AS kind
           FROM sessions
           WHERE projectless = 1;`
        )[0];
        const workspaces = jsonSql(
          dbPath,
          `SELECT
             workspace_path AS path,
             CASE
               WHEN workspace_path IS NULL OR workspace_path = '' THEN 'No Workspace'
               ELSE replace(workspace_path, rtrim(workspace_path, replace(workspace_path, '/', '')), '')
             END AS name,
             max(workspace_exists) AS exists_on_disk,
             count(*) AS session_count,
             max(updated_at) AS last_session_updated_at,
             'workspace' AS kind
           FROM sessions
           WHERE projectless = 0 AND workspace_path IS NOT NULL AND workspace_path != ''
           GROUP BY workspace_path
           ORDER BY exists_on_disk DESC, session_count DESC, name ASC;`
        );
        return sendJson(res, { workspaces: projectless?.session_count ? [projectless, ...workspaces] : workspaces });
      }
      if (url.pathname === "/api/sessions") {
        const q = url.searchParams.get("q") || "";
        const status = url.searchParams.get("status") || "";
        const workspace = url.searchParams.get("workspace") || "";
        const workspaceFilter = workspace === "__projectless__"
          ? "s.projectless = 1"
          : workspace
            ? `s.workspace_path = ${sqlString(workspace)}`
            : "";
        const workspaceFilterPlain = workspace === "__projectless__"
          ? "projectless = 1"
          : workspace
            ? `workspace_path = ${sqlString(workspace)}`
            : "";
        const limit = Number(url.searchParams.get("limit") || "100");
        const counts = jsonSql(
          dbPath,
          "SELECT count(*) total, sum(archived) archived, sum(case when archived=0 then 1 else 0 end) active, sum(case when workspace_exists=0 and workspace_path is not null then 1 else 0 end) workspace_missing FROM sessions;"
        )[0];
        let rows;
        if (q) {
          rows = jsonSql(
            dbPath,
            `SELECT s.id,s.title,s.status,s.workspace_path,s.updated_at_iso,s.message_count,s.last_message_preview
             FROM session_fts JOIN sessions s ON s.id = session_fts.session_id
             WHERE session_fts MATCH ${sqlString(q.replaceAll("'", " "))} ${status ? `AND s.status LIKE ${sqlString(`%${status}%`)}` : ""} ${workspaceFilter ? `AND ${workspaceFilter}` : ""}
             ORDER BY bm25(session_fts)
             LIMIT ${sqlNumber(limit)};`
          );
        } else {
          const where = [
            status ? `status LIKE ${sqlString(`%${status}%`)}` : "",
            workspaceFilterPlain,
          ].filter(Boolean);
          rows = jsonSql(
            dbPath,
            `SELECT id,title,status,workspace_path,updated_at_iso,message_count,last_message_preview
             FROM sessions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
             ORDER BY updated_at DESC, updated_at_iso DESC LIMIT ${sqlNumber(limit)};`
          );
        }
        return sendJson(res, { counts, sessions: rows });
      }
      const detailMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (detailMatch) {
        const loaded = loadSession(decodeURIComponent(detailMatch[1]));
        if (!loaded) return sendJson(res, { error: "not found" }, 404);
        return sendJson(res, loaded);
      }
      const exportMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/export$/);
      if (exportMatch && req.method === "POST") {
        const id = decodeURIComponent(exportMatch[1]);
        const loaded = loadSession(id);
        if (!loaded) return sendJson(res, { error: "not found" }, 404);
        const outDir = join(cwd, "outputs");
        mkdirSync(outDir, { recursive: true });
        const date = (loaded.session.updated_at_iso || loaded.session.created_at_iso || new Date().toISOString()).slice(0, 10);
        const file = join(outDir, `${date}-${slugify(loaded.session.title)}-${id.slice(0, 8)}.md`);
        writeFileSync(file, renderSessionMarkdown(loaded.session, loaded.messages));
        markSessionExported(id, file);
        return sendJson(res, { ok: true, path: file });
      }
      return sendText(res, "Not found", "text/plain; charset=utf-8", 404);
    } catch (error) {
      return sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });
  server.listen(port, host, () => {
    console.log(`Codex Sessions Web UI: http://${host}:${port}`);
  });
}

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case "scan":
      scan();
      break;
    case "list":
      list(args);
      break;
    case "search":
      search(args);
      break;
    case "show":
      show(args);
      break;
    case "export":
      exportSession(args);
      break;
    case "serve":
      serve(args);
      break;
    case "db-path":
      console.log(dbPath);
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      usage();
      process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
