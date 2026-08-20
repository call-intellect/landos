# RepoBrain

**A local context engine between your repository and your AI coding agent.** It indexes your
code once, structurally, and hands the agent a small, ranked, explained **context capsule** for
each task — so the agent stops grepping and reading whole files. You spend **far fewer tokens**
and the agent finds the **right code**.

Everything runs locally. **No code and no embeddings leave your machine.**

```text
Your repo ──▶ Indexer ──▶ Code graph (SQLite) ──▶ Context capsule ──▶ MCP ──▶ Claude Code / Cursor
```

## Why you'd want it

An AI agent normally explores a codebase by grepping and opening 20 files — burning tokens on
wrong guesses and re-reads. RepoBrain does that exploration **once**, deterministically, and gives
the agent a compact pack of only the relevant code plus the *why* behind it.

- **Fewer tokens** — capsules are token-budgeted (default 8k) and hundreds× smaller than the repo.
- **Right code, not fuzzy chunks** — a real tree-sitter graph (symbols, calls, imports, routes).
- **Graph-first, no model needed** — the agent supplies the English identifiers; semantic
  embeddings are strictly opt-in. Fast, tiny, fully offline.
- **Language-agnostic** — validated on TypeScript/TSX and Python.

## Install

```bash
git clone <this-repo> && cd repobrain
./install.sh /path/to/your/project
```

That builds RepoBrain, exposes the `repobrain` command, and runs **setup** in your project:
it detects **Claude Code / Cursor**, wires up the MCP server + agent rules, indexes the repo,
and verifies. Restart your agent and work normally — it will call RepoBrain instead of grepping.

Prefer to do it in two steps?

```bash
./install.sh                                   # build + expose `repobrain`
repobrain --cwd /path/to/your/project setup    # wire up + index + verify
```

## What setup does

- Writes **`AGENTS.md`** — the rule that tells the agent to query the graph (not grep) and to map a
  task in any language to the English identifiers a developer used.
- Merges an **MCP server** entry into `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor),
  preserving any servers you already have.
- Writes **`.repobrain.yaml`** (config; graph-first defaults, embeddings off).
- **Indexes** your code and auto-drafts a code-grounded knowledge layer (see below).
- **Builds the wiki** into a visible `wiki/` folder — so the docs exist from minute one, not only
  if someone remembers to run a command. `repobrain index` keeps it in sync.

## What the agent gets (MCP tools)

`make_context_capsule` (task → ranked, budgeted context pack), `search_code` / `find_symbol`,
`get_callers` / `get_callees` / `find_references`, `get_impact`, `get_file_overview` /
`get_routes` / `get_architecture_summary`, and `remember_decision` / `get_team_memory`.

## Beyond code: the knowledge layer

RepoBrain also carries a **second brain** — the *why/how* behind the code — into the same capsule:

- **Double search** — one query returns the code **and** the reason for it.
- **Auto-bootstrap** — on a repo with no notes, RepoBrain generates a code-grounded skeleton so the
  knowledge layer works from day one; if you keep hand-written notes, it uses those too.
- **Staleness** — notes that cite code which no longer exists are flagged, so the agent never trusts
  outdated context.
- **A wiki for people** — a visible `wiki/` folder, built automatically at setup and refreshed on every
  index. Markdown, so it reads on GitHub, in your editor, and in git diffs. It gives a newcomer the
  project overview plus, per module: key files, **key functions** (signature, what it does, how many
  callers), HTTP routes, the real dependency graph, and the *why* quoted from the second brain —
  with a ⚠ on anything that has gone stale. `repobrain wiki --html` also emits one self-contained
  page you can open by double-click or send to someone.

  RepoBrain never overwrites a `wiki/` folder it didn't create.

## Proven, not asserted

Measured on real repositories (graph-first, zero embeddings):

- **Code retrieval:** the right file lands in the capsule **26/27 (96%)** across three repos in two
  languages (a 5,052-file app, a 410-file app, and a Python library).
- **Knowledge retrieval:** the correct *why* note lands in the capsule **21/22 (95%)**.

Reproduce with the harnesses in [`scripts/`](scripts/); rationale and numbers in
[`docs/DECISIONS.md`](docs/DECISIONS.md).

## Everyday commands

```bash
repobrain index            # re-index after changes (incremental by default)
repobrain doctor           # health check
repobrain wiki             # regenerate the human wiki
repobrain capsule "…"      # preview a capsule for a task
```

## Requirements

Node.js 18+. macOS / Linux. Works offline.
