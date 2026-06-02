#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function usage() {
  console.log(`Usage:
  node export_session.mjs --id <session-id> --db <sqlite-path> --out <dir> [--all]

Defaults:
  --db  ./work/codex-sessions.sqlite
  --out ./outputs`);
}

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

function sqlString(value) {
  if (value == null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function jsonSql(db, sql) {
  const out = execFileSync("sqlite3", ["-json", db, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 100,
  }).trim();
  return out ? JSON.parse(out) : [];
}

function shellSql(db, sql) {
  return execFileSync("sqlite3", [db], {
    encoding: "utf8",
    input: sql,
    maxBuffer: 1024 * 1024 * 100,
  });
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

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const id = argValue(args, "--id");
const db = argValue(args, "--db", join(process.cwd(), "work", "codex-sessions.sqlite"));
const outDir = argValue(args, "--out", join(process.cwd(), "outputs"));
const all = args.includes("--all");

if (!id) {
  console.error("Missing --id.");
  usage();
  process.exit(1);
}
if (!existsSync(db)) {
  console.error(`SQLite index not found: ${db}`);
  process.exit(1);
}

const sessions = jsonSql(db, `SELECT * FROM sessions WHERE id = ${sqlString(id)};`);
if (!sessions.length) {
  console.error(`Session not found: ${id}`);
  process.exit(1);
}
const session = sessions[0];
const messages = jsonSql(
  db,
  `SELECT role,content,created_at,sequence FROM messages WHERE session_id = ${sqlString(
    id
  )} ${all ? "" : "AND role IN ('user','assistant')"} ORDER BY sequence ASC;`
);

mkdirSync(outDir, { recursive: true });
const date = (session.updated_at_iso || session.created_at_iso || new Date().toISOString()).slice(0, 10);
const file = join(outDir, `${date}-${slugify(session.title)}-${id.slice(0, 8)}.md`);
writeFileSync(file, renderSessionMarkdown(session, messages));
try {
  shellSql(db, "ALTER TABLE sessions ADD COLUMN exported_path TEXT;");
} catch {
  // Column already exists.
}
shellSql(db, `UPDATE sessions SET exported_path = ${sqlString(file)} WHERE id = ${sqlString(id)};`);
console.log(file);
