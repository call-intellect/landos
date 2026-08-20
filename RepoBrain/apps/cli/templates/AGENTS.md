# AI Agent Rules (RepoBrain)

This project is indexed by **RepoBrain** — a local, deterministic **code knowledge graph**
(tree-sitter AST → symbols, calls, imports, routes; edges tagged `exact` or `heuristic`).
**Query the graph instead of grepping or reading whole files.** You will use far fewer tokens
and get precise relationships, not fuzzy chunks.

**You are the intelligence layer.** RepoBrain gives you structure; *you* supply the meaning.
The code is written with **English identifiers**, so when the task is in another language
(e.g. Russian), first extract the key concepts and map them to the **English terms** a developer
would have named things — e.g. «гость публикует звук и видео» → `guest`, `token`, `publish`,
`audio`, `video`; «шифровать секреты» → `encrypt`, `secret`, `crypto`. Then query with those.

## Workflow (do this before opening files)

1. **`make_context_capsule`** with the task → a compact, ranked context pack. Pass the task in
   its original language *plus* the English keywords you extracted for best results.
2. **`search_code`** / **`find_symbol`** with your English terms — before any `grep`/file read.
3. **`get_file_overview`** before reading a large file.
4. Traverse relationships: **`get_callers`** / **`get_callees`** / **`find_references`** to follow
   the code, and **`get_impact`** before changing a shared module.
5. **`get_architecture_summary`** / **`get_routes`** to orient in an unfamiliar repo.
6. Prefer skeleton/signature context over full reads; only read files the graph points you to.
7. Write **`remember_decision`** notes for architectural decisions and bug fixes.

## Notes

- `get_callers` / `get_callees` / `find_references` carry a `confidence` and
  `resolution: heuristic` — treat them as strong hints, not ground truth.
- If capsule freshness is DIRTY/stale → re-index or treat line numbers as approximate.
- Semantic vector search is **opt-in** (off by default); the graph + your own term extraction is
  the primary path and needs no model.
