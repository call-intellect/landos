#!/usr/bin/env python3
"""PostToolUse hook (Edit|Write): warn on raw environment-variable access.

Rule enforced: knobs and secrets are read through a typed config layer, not by
touching the process environment directly. Direct access (process.env.*,
os.environ, os.getenv, System.getenv, ENV[...]) scatters config and skips
validation.

Reads tool_input from stdin, scans the added code (Write.content /
Edit.new_string), and warns if raw env access appears OUTSIDE an explicit
config module (files whose path names it as config/env/settings are exempt —
that is where the typed layer legitimately reads the environment).

WARN mode (exit 0) by default.

Wire it in settings.json under hooks.PostToolUse[matcher="Edit|Write"]:
    "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/check-no-raw-env.py"
"""
import json
import re
import sys
from pathlib import Path

# Set True (and the hook will exit 2) to hard-block raw env access.
STRICT = False

SKIP_EXT = {".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc", ".json", ".yaml", ".yml"}

# Path fragments that mark the legitimate typed-config layer (exempt).
CONFIG_PATH = re.compile(r"(^|/)(config|env|settings|\.env)", re.IGNORECASE)

# Raw env access patterns across common stacks.
RAW_ENV = re.compile(
    r"(process\.env\.\w|process\.env\[|"
    r"os\.environ\b|os\.getenv\s*\(|"
    r"System\.getenv\s*\(|"
    r"Deno\.env\.get\s*\(|"
    r"\bENV\[)"
)

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
    if CONFIG_PATH.search(path):  # the typed config layer itself
        return 0

    offenders = []
    for i, line in enumerate(text.splitlines(), start=1):
        if RAW_ENV.search(line):
            offenders.append((i, line.strip()[:100]))

    if not offenders:
        return 0

    msg = ["", "[RULE] Read knobs/secrets through the typed config layer, not raw env."]
    msg.append("Direct env access skips validation and scatters config.")
    msg.append("Route it through your config module (config/ · env schema · settings).")
    for ln, snippet in offenders[:8]:
        msg.append(f"  {path}:{ln}  {snippet}")
    if len(offenders) > 8:
        msg.append(f"  ... and {len(offenders) - 8} more")
    msg.append("")
    sys.stderr.write("\n".join(msg) + "\n")

    return 2 if STRICT else 0


if __name__ == "__main__":
    sys.exit(main())
