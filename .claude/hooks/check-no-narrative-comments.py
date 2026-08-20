#!/usr/bin/env python3
"""PostToolUse hook (Edit|Write): warn on narrative code comments.

Rule enforced: code is self-documenting — names, types, structure instead of
prose. Do not add narrative / explanatory / historical comments. Only
FUNCTIONAL directives are allowed (eslint-disable*, @ts-expect-error,
prettier-ignore, /// <reference, biome-ignore, noqa, type: ignore, ...).

Reads tool_input from stdin, scans the added code (Write.content /
Edit.new_string), skips docs/markdown, and if a narrative comment appears it
prints a warning on stderr. WARN mode (exit 0) by default.

Wire it in settings.json under hooks.PostToolUse[matcher="Edit|Write"]:
    "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-no-narrative-comments.py"
"""
import json
import re
import sys
from pathlib import Path

# Set True (and the hook will exit 2) to hard-block edits with narrative comments.
STRICT = False

# Extensions treated as prose, not code — never scanned.
SKIP_EXT = {".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc"}

# Functional directives that are allowed even though they are comments.
FUNCTIONAL = re.compile(
    r"("
    r"eslint-disable|eslint-enable|"
    r"@ts-expect-error|@ts-ignore|@ts-nocheck|"
    r"prettier-ignore|biome-ignore|"
    r"///\s*<reference|"
    r"noqa|type:\s*ignore|pylint:|flake8:|mypy:|pyright:|"
    r"istanbul ignore|c8 ignore|v8 ignore|"
    r"coding[:=]\s*utf|-\*-|"
    r"@jsx|@license|@preserve|SPDX-License"
    r")",
    re.IGNORECASE,
)

# Leading comment markers we recognize across languages.
COMMENT = re.compile(r"^\s*(//+|#+|/\*+|\*+|<!--|--+)\s?(.*)$")

try:
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass


def added_text(data: dict) -> tuple[str, str]:
    ti = data.get("tool_input") or {}
    path = ti.get("file_path", "") or ""
    if "content" in ti and ti.get("content"):
        return path, str(ti["content"])
    if "new_string" in ti and ti.get("new_string"):
        return path, str(ti["new_string"])
    return path, ""


def is_narrative(body: str) -> bool:
    body = body.strip().rstrip("*/").rstrip("-->").strip()
    if not body:
        return False
    # Need at least two "word" tokens of letters to look like prose.
    words = re.findall(r"[A-Za-zЀ-ӿ]{2,}", body)
    return len(words) >= 2


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    path, text = added_text(data)
    if not text:
        return 0
    if Path(path).suffix.lower() in SKIP_EXT:
        return 0

    offenders = []
    for i, line in enumerate(text.splitlines(), start=1):
        if line.lstrip().startswith("#!"):  # shebang
            continue
        m = COMMENT.match(line)
        if not m:
            continue
        body = m.group(2) or ""
        if FUNCTIONAL.search(line):
            continue
        if is_narrative(body):
            offenders.append((i, line.strip()[:100]))

    if not offenders:
        return 0

    msg = ["", "[RULE] No narrative comments in code — code must be self-documenting."]
    msg.append("Move explanations (contracts, invariants, reasons) into docs/, not code.")
    msg.append("Allowed only: eslint-disable*, @ts-expect-error, prettier-ignore,")
    msg.append("/// <reference, biome-ignore, noqa, type: ignore.")
    for ln, snippet in offenders[:8]:
        msg.append(f"  {path}:{ln}  {snippet}")
    if len(offenders) > 8:
        msg.append(f"  ... and {len(offenders) - 8} more")
    msg.append("")
    sys.stderr.write("\n".join(msg) + "\n")

    return 2 if STRICT else 0


if __name__ == "__main__":
    sys.exit(main())
