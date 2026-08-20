#!/usr/bin/env python3
"""PreToolUse Bash safety guard (dependency-free).

Читает вход из stdin (JSON), разбирает tool_input.command и выходит с кодом 2
(блок), если команда ДЕЛАЕТ опасное; причина уходит в stderr. Код 0 — можно.

Push в защищённую ветку опознаётся разбором команды (lib/cmdparse.py): ветка
ищется среди аргументов сегмента, чья программа — git с подкомандой push.
Строка «git push origin main» внутри аргумента чужой программы действием не
является и не блокируется.

Разблокировка одного push: touch .claude/.push-unlock — сторож съедает флаг.

Wire it in settings.json under hooks.PreToolUse[matcher="Bash"]:
    "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/pre-bash-guard.py"

Tune PROTECTED_BRANCHES below to match your project's protected branches.
"""
import json
import os
import re
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib"))

try:
    import cmdparse
except ImportError:
    cmdparse = None

try:
    import unlock
except ImportError:
    unlock = None

PROTECTED_BRANCHES = ["main", "master"]

UNLOCK_FILE = ".push-unlock"

GIT_VALUE_FLAGS = ("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path")

try:
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass


def git_arguments(tokens: list) -> list:
    out = []
    i = 1
    while i < len(tokens):
        token = tokens[i]
        if token in GIT_VALUE_FLAGS:
            i += 2
            continue
        if token.startswith("-"):
            i += 1
            continue
        out.append(token)
        i += 1
    return out


def names_protected_branch(argument: str) -> bool:
    if argument in PROTECTED_BRANCHES:
        return True
    return ":" in argument and argument.rsplit(":", 1)[-1] in PROTECTED_BRANCHES


def rough_push_check(command: str) -> bool:
    branches = "|".join(re.escape(b) for b in PROTECTED_BRANCHES)
    return bool(branches and re.search(r"git\s+push\b(?:\s+\S+)*\s+\b(" + branches + r")\b", command))


def pushes_to_protected(command: str) -> bool:
    if cmdparse is None:
        return rough_push_check(command)
    try:
        segments = cmdparse.segments(command)
    except ValueError:
        return rough_push_check(command)
    for tokens in segments:
        if not tokens:
            continue
        if os.path.basename(tokens[0]) != "git":
            continue
        arguments = git_arguments(tokens)
        if not arguments or arguments[0] != "push":
            continue
        if any(names_protected_branch(a) for a in arguments[1:]):
            return True
    return False


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    cmd = (data.get("tool_input") or {}).get("command", "") or ""
    if not isinstance(cmd, str) or not cmd:
        return 0

    if pushes_to_protected(cmd):
        if unlock is not None and unlock.consume(UNLOCK_FILE):
            return 0
        sys.stderr.write(
            "BLOCKED: push в защищённую ветку "
            f"({', '.join(PROTECTED_BRANCHES)}) без разблокировки владельцем.\n"
            f"Разблокировать один push: touch .claude/{UNLOCK_FILE}\n"
        )
        return 2

    if re.search(r"rm\s+-rf\s+/(?:\s|$|\*)", cmd):
        sys.stderr.write("BLOCKED: rm -rf on root\n")
        return 2

    if re.search(r"\bDROP\s+TABLE\b", cmd, re.IGNORECASE):
        sys.stderr.write(
            "BLOCKED: DROP TABLE detected — confirm explicitly via a raw DB shell\n"
        )
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
