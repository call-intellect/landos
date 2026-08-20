#!/usr/bin/env python3
"""PreToolUse guard (Edit|Write): машинная точка одобрения замысла (§6 правил).

Две границы, обе — только на СОЗДАНИЕ файла, правка существующих не трогается:
  1. plans/architecture/*.md не рождается со status: approved — approved ставит владелец.
  2. plans/tz/*.md не создаётся без ссылки во frontmatter на существующую
     архитектуру со status: approved.

Исключения зашиты данными: _template.md и *-orchestrator-prompt.md.

Wire in settings.json under hooks.PreToolUse[matcher="Edit|Write"]:
    "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/approval-gate.py"
"""
import json
import os
import re
import sys

ARCHITECTURE = re.compile(r"(^|/)plans/architecture/[^/]+\.md$")
TZ = re.compile(r"(^|/)plans/tz/[^/]+\.md$")
APPROVED = re.compile(r"^status:\s*approved\s*$", re.M)
FRONTMATTER = re.compile(r"^---\n([\s\S]*?)\n---")
ARCHITECTURE_REF = re.compile(r"plans/architecture/[^\s\"'`)]+\.md")

EXEMPT_SUFFIXES = ("_template.md", "-orchestrator-prompt.md")

RULE_TZ = (
    "BLOCKED: §6 правил — ТЗ не пишется, пока нет plans/architecture/<feature>.md "
    "со status: approved. Добавь во frontmatter ссылку relates_to на одобренную "
    "архитектуру или сначала напиши замысел и дождись approved от владельца."
)

RULE_ARCHITECTURE = (
    "BLOCKED: §6 правил — архитектура рождается со status: draft; approved ставит владелец, "
    "агент — никогда сам."
)

try:
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass


def project_root() -> str:
    return os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())


def normalize(path: str) -> str:
    return path.replace("\\", "/")


def is_exempt(path: str) -> bool:
    base = normalize(path).split("/")[-1]
    return any(base.endswith(suffix) for suffix in EXEMPT_SUFFIXES)


def resolve(path: str) -> str:
    return path if os.path.isabs(path) else os.path.join(project_root(), path)


def added_text(tool_input: dict) -> str:
    return tool_input.get("content") or tool_input.get("new_string") or ""


def frontmatter_of(text: str) -> str:
    match = FRONTMATTER.match(text)
    return match.group(1) if match else text[:2000]


def approved_architecture_exists(reference: str) -> bool:
    target = resolve(reference)
    if not os.path.isfile(target):
        return False
    try:
        with open(target, encoding="utf-8") as handle:
            return bool(APPROVED.search(handle.read()))
    except OSError:
        return False


def block(reason: str) -> int:
    sys.stderr.write(reason + "\n")
    return 2


def check(tool_input: dict) -> int:
    path = tool_input.get("file_path", "") or ""
    if not path or is_exempt(path):
        return 0
    normalized = normalize(path)
    if os.path.isfile(resolve(path)):
        return 0

    text = added_text(tool_input)
    if not text:
        return 0

    if ARCHITECTURE.search(normalized):
        if APPROVED.search(frontmatter_of(text)):
            return block(RULE_ARCHITECTURE)
        return 0

    if TZ.search(normalized):
        references = ARCHITECTURE_REF.findall(frontmatter_of(text))
        if any(approved_architecture_exists(ref) for ref in references):
            return 0
        return block(RULE_TZ)

    return 0


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name", "") not in ("Write", "Edit"):
        return 0
    return check(data.get("tool_input") or {})


if __name__ == "__main__":
    sys.exit(main())
