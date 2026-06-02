# Codex Session Browser

一个本地优先的 Codex 会话浏览、搜索和导出工具。

它会扫描本机 `~/.codex` 里的 Codex 会话记录，把活跃会话、归档会话、单独对话和工作区缺失的会话统一索引到 SQLite，然后提供 CLI 和本地 Web UI 来查看、搜索和导出 Markdown。

## 作用

Codex 长期使用后，历史会话可能会分散在不同工作区、归档目录和 projectless 会话中。Codex 自带侧边栏不一定方便全量查找，尤其是：

- 归档会话不好找。
- 工作区删除后，会话不容易按原项目定位。
- 一些会话还在本地文件里，但在当前列表中不明显。
- 想把重要会话导出成 Markdown 保存或分享。

这个工具解决的是“把 Codex 本地所有可发现会话重新集中起来”的问题。

## 功能

- 全量扫描 Codex 本地会话。
- 合并展示活跃会话和归档会话。
- 识别 `active`、`archived`、`workspace_missing`、`projectless` 状态。
- 按工作区筛选。
- 将“单独对话 / Projectless”作为独立分组。
- 全文搜索标题、工作区和 user/assistant 对话正文。
- 查看会话详情。
- 导出单个会话为 Markdown。
- 记录已导出的 Markdown 路径，并在详情页显示。
- 提供本地 Web UI。

## 实现

主要数据来源：

- `~/.codex/state_5.sqlite`
  - 读取 `threads` 表作为会话元数据主来源。
  - 使用 `threads.rollout_path` 找到对应 JSONL 会话文件。
  - 使用 `threads.archived` 判断归档状态。
  - 使用 `threads.cwd` 识别工作区路径。

- `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
  - 活跃会话正文。

- `~/.codex/archived_sessions/*.jsonl`
  - 归档会话正文。

- `~/.codex/.codex-global-state.json`
  - 读取 projectless 会话、工作区 hint 和 UI 组织信息。

工具自己的索引库：

```text
work/codex-sessions.sqlite
```

索引库包含：

- `sessions`
- `messages`
- `workspaces`
- `session_fts`，SQLite FTS5 全文搜索表

Web UI 是内嵌在 `src/cli.mjs` 中的本地 HTTP 服务，默认只监听：

```text
127.0.0.1
```

## 依赖

需要：

- Node.js，建议 20+
- `sqlite3` 命令行工具
- macOS 或其他能访问 Codex 本地数据目录的系统

检查依赖：

```bash
node --version
sqlite3 --version
```

macOS 安装 `sqlite3`：

```bash
brew install sqlite
```

## 安装

克隆项目：

```bash
git clone <your-repo-url>
cd codex-session-browser
```

当前版本没有 npm 依赖，可以直接运行。

可选：让命令可执行：

```bash
chmod +x src/cli.mjs
```

## 使用

### 扫描会话

```bash
node src/cli.mjs scan
```

扫描会读取 `~/.codex`，然后生成或重建：

```text
work/codex-sessions.sqlite
```

### 查看最近会话

```bash
node src/cli.mjs list --limit 20
```

### 查看归档会话

```bash
node src/cli.mjs list --status archived --limit 20
```

### 查看工作区缺失的会话

```bash
node src/cli.mjs list --status workspace_missing --limit 20
```

### 搜索会话

```bash
node src/cli.mjs search "关键词" --limit 20
```

### 查看会话详情

默认只显示 user / assistant 对话：

```bash
node src/cli.mjs show <session-id>
```

显示完整底层记录，包括 developer 消息、工具调用和工具输出：

```bash
node src/cli.mjs show <session-id> --all
```

### 导出 Markdown

```bash
node src/cli.mjs export <session-id> --out outputs
```

导出完整底层记录：

```bash
node src/cli.mjs export <session-id> --out outputs --all
```

### 启动 Web UI

```bash
node src/cli.mjs serve --port 8787
```

打开：

```text
http://127.0.0.1:8787
```

Web UI 支持：

- 会话列表
- 状态筛选
- 工作区筛选
- 单独对话分组
- 全文搜索
- 详情查看
- 重新扫描
- 导出 Markdown
- 显示已导出路径
- 删除会话

### 删除会话

Web UI 的详情页提供 `删除会话` 按钮。删除会：

- 从本工具索引中移除该会话。
- 从 Codex 的 `~/.codex/state_5.sqlite` 删除对应 `threads` 记录。
- 删除对应的 Codex JSONL 会话文件。
- 清理 `.codex-global-state.json` 中对该会话 ID 的引用。

这是破坏性操作。Web UI 会要求二次确认，但删除后本工具不会保留恢复副本。

## 环境变量

指定 Codex 数据目录：

```bash
CODEX_HOME=/path/to/.codex node src/cli.mjs scan
```

指定索引数据库路径：

```bash
CODEX_SESSIONS_DB=/path/to/codex-sessions.sqlite node src/cli.mjs list
```

## Codex Skill

本项目还可以配合一个本地 Codex skill 使用。仓库中已经包含 skill 文件：

```text
skills/codex-session-export
```

安装到本机 Codex：

```bash
mkdir -p ~/.codex/skills
cp -R skills/codex-session-export ~/.codex/skills/
```

安装后的位置：

```text
~/.codex/skills/codex-session-export
```

skill 脚本可以从索引库导出指定会话：

```bash
node ~/.codex/skills/codex-session-export/scripts/export_session.mjs \
  --id <session-id> \
  --db work/codex-sessions.sqlite \
  --out outputs
```

如果要分发给其他人，建议把 skill 目录单独复制到对方的：

```text
~/.codex/skills/codex-session-export
```

## 数据安全

默认行为：

- 只读扫描 Codex 原始数据。
- 除非用户点击删除会话，否则不修改 `~/.codex` 里的原始会话文件。
- 派生索引写入项目自己的 `work/` 目录。
- Markdown 导出写入用户指定目录。
- Web UI 默认只监听 `127.0.0.1`。

注意：

- Codex 会话可能包含代码、路径、密钥、个人信息或业务内容。
- 不建议把 `work/`、`outputs/`、导出的 Markdown、SQLite 索引库提交到公开仓库。
- 发布到 GitHub 前，请检查 `.gitignore` 是否生效。

## 当前限制

- 当前是原型版本，主要面向本地使用。
- 每次 `scan` 会重建索引，不是增量扫描。
- Codex 内部数据结构可能随版本变化。
- `hidden` 状态目前没有精确判断，只保留可扩展空间。
- Web UI 目前是内嵌 HTML，没有独立前端构建系统。

## 推荐开发路线

后续可以继续增强：

- 增量扫描。
- 独立 React/Vite Web UI。
- 更好的搜索高亮。
- 工作区折叠分组视图。
- 批量导出 Markdown。
- 语义搜索。
- 自动摘要和标签。
