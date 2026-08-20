#!/usr/bin/env python3
import json
import os
import re
import sys
from datetime import datetime, timezone

MAX_HINTS = 3
MAX_CONTEXT_CHARS = 4000
MAX_LOG_BYTES = 1024 * 1024
REGISTRY = os.path.join(".claude", "lessons", "registry.jsonl")
TELEMETRY = "lesson-hints.jsonl"


def project_root(payload):
    return os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or ""


def load_lessons(root):
    path = os.path.join(root, REGISTRY)
    lessons = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                lesson = json.loads(line)
            except ValueError:
                continue
            if isinstance(lesson, dict) and lesson.get("status") == "active":
                lessons.append(lesson)
    return lessons


def git_dir(root):
    common = os.path.join(root, ".git")
    if os.path.isfile(common):
        with open(common, "r", encoding="utf-8") as handle:
            pointer = handle.read().strip()
        if pointer.startswith("gitdir:"):
            resolved = pointer.split(":", 1)[1].strip()
            return resolved if os.path.isabs(resolved) else os.path.join(root, resolved)
    return common


def telemetry_path(root):
    return os.path.join(git_dir(root), TELEMETRY)


def rotate(path):
    try:
        if os.path.exists(path) and os.path.getsize(path) > MAX_LOG_BYTES:
            os.replace(path, f"{path}.1")
    except OSError:
        pass


def append_telemetry(root, record):
    path = telemetry_path(root)
    if not os.path.isdir(os.path.dirname(path)):
        return
    rotate(path)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def normalize(command):
    return re.sub(r"\s+", " ", command).strip()


def failure_streak(root, session_id, command):
    path = telemetry_path(root)
    if not os.path.exists(path):
        return 0
    target = normalize(command)
    streak = 0
    try:
        with open(path, "r", encoding="utf-8") as handle:
            lines = handle.readlines()
    except OSError:
        return 0
    for line in lines:
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if record.get("kind") != "failure" or record.get("session_id") != session_id:
            continue
        if normalize(record.get("command", "")) == target:
            streak += 1
    return streak


def matches(lesson, event, tool, haystack):
    wanted_event = lesson.get("trigger", {}).get("event")
    if wanted_event and wanted_event != event:
        return False
    if not wanted_event and event == "PreToolUse":
        wanted_tool = lesson.get("trigger", {}).get("tool")
        if wanted_tool and wanted_tool != "*" and wanted_tool != tool:
            return False
    pattern = lesson.get("trigger", {}).get("match")
    if not pattern:
        return False
    try:
        return re.search(pattern, haystack, re.MULTILINE) is not None
    except re.error:
        return False


def main() -> None:
    payload = json.load(sys.stdin)
    root = project_root(payload)
    if not root or not os.path.isdir(root):
        return
    event = payload.get("hook_event_name") or "PreToolUse"
    tool = payload.get("tool_name") or ""
    command = (payload.get("tool_input") or {}).get("command") or ""
    session_id = payload.get("session_id") or "unknown"
    error_text = json.dumps(payload.get("tool_response") or {}, ensure_ascii=False)
    haystack = command if event == "PreToolUse" else f"{command}\n{error_text}"

    if event == "PostToolUseFailure" and command:
        append_telemetry(root, {
            "ts": datetime.now(timezone.utc).isoformat(),
            "kind": "failure",
            "session_id": session_id,
            "command": command,
        })

    picked = []
    for lesson in load_lessons(root):
        if len(picked) >= MAX_HINTS:
            break
        if not matches(lesson, event, tool, haystack):
            continue
        needed = lesson.get("trigger", {}).get("repeat_failures")
        if needed and failure_streak(root, session_id, command) < needed:
            continue
        picked.append(lesson)

    if not picked:
        return

    body = "\n".join(f"[{lesson['id']}] {lesson.get('hint', '')}" for lesson in picked)
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": body[:MAX_CONTEXT_CHARS],
        }
    }, ensure_ascii=False))

    for lesson in picked:
        append_telemetry(root, {
            "ts": datetime.now(timezone.utc).isoformat(),
            "kind": "hint",
            "event": event,
            "session_id": session_id,
            "lesson": lesson.get("id"),
            "command": command[:200],
        })


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
