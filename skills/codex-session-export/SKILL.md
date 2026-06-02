---
name: codex-session-export
description: Export Codex conversation sessions to Markdown from a local codex-sessions SQLite index. Use when the user asks to export, save, archive, convert, or write Codex session history, archived conversations, active conversations, or a specific session ID as a Markdown document.
---

# Codex Session Export

## Workflow

Use this skill to export a Codex session that has already been indexed by the local `codex-sessions` prototype.

1. Ensure a SQLite index exists. In the prototype project, run:

   ```bash
   node src/cli.mjs scan
   ```

2. If the user gives a session ID, export that ID directly. If not, search or list sessions first:

   ```bash
   node src/cli.mjs search "关键词" --limit 10
   node src/cli.mjs list --status archived --limit 20
   ```

3. Export through the project CLI when available:

   ```bash
   node src/cli.mjs export <session-id> --out outputs
   ```

4. If the project CLI is not available but the SQLite index is, run the bundled script:

   ```bash
   node ~/.codex/skills/codex-session-export/scripts/export_session.mjs \
     --id <session-id> \
     --db /path/to/codex-sessions.sqlite \
     --out /path/to/output-dir
   ```

5. Use `--all` only when the user wants the raw/full record, including developer messages, tool calls, and tool outputs. Otherwise export only user/assistant conversation messages.

## Output

The export writes a Markdown file containing:

- Session title
- Metadata: ID, status, workspace, source path, created/updated/exported time
- Conversation transcript

Return the generated Markdown path to the user.
