#!/usr/bin/env python3
"""PostToolUse hook: end-of-work checklist reminder after `git push`.

Fires after every Bash tool call, detects a real `git push` (not --dry-run, and
not the reflection/docs commit itself), and prints a neutral completion
checklist on stderr that the agent will see and act on.

Exit 0 always — never blocks; only reminds.

Wire it in settings.json under hooks.PostToolUse[matcher="Bash"]:
    "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/post-push-reflection.py"
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# Directory where session reflections / worklog notes live (project-relative).
REFLECTION_DIR = "second-brain/05_history"

# second-brain root map + note folders whose entries must be registered in their OWN sub-index
# (INDEX_RULES: a note without a link in its folder's index.md does not exist).
SECOND_BRAIN_INDEX = "second-brain/index.md"
NOTE_DIRS = (
    "05_history",
    "01_projects",
    "02_architecture",
    "03_processes",
    "04_not-done",
    "06_marketing",
    "13_glossary",
)
# stub/template files that are not real notes and are not expected in the index
NOTE_STUBS = {"README.md", "_template.md", "index.md"}


def unindexed_notes():
    """Notes on disk (in NOTE_DIRS, nested files included) not referenced anywhere —
    neither in the folder's own sub-index nor in the root map. Returns sorted
    'folder/stem' keys. Fail-open: error -> []."""
    try:
        idx = Path(SECOND_BRAIN_INDEX)
        if not idx.exists():
            return []
        sb = Path("second-brain")
        # combined index surface: main index + each section's own index/README register
        text = idx.read_text(encoding="utf-8", errors="replace")
        for folder in NOTE_DIRS:
            for reg in ("index.md", "README.md"):
                regp = sb / folder / reg
                if regp.exists():
                    text += "\n" + regp.read_text(encoding="utf-8", errors="replace")
        missing = []
        for folder in NOTE_DIRS:
            d = sb / folder
            if not d.exists():
                continue
            for p in d.rglob("*.md"):
                if p.name in NOTE_STUBS:
                    continue
                # indexed if referenced by folder/stem (root map), by bare stem or by the
                # path relative to the folder (sub-index may link a nested note as sub/stem)
                rel = p.relative_to(d).with_suffix("").as_posix()
                if (
                    f"{folder}/{p.stem}" not in text
                    and f"[[{p.stem}" not in text
                    and rel not in text
                ):
                    missing.append(f"{folder}/{rel}")
        return sorted(missing)
    except Exception:
        return []

try:
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0  # malformed input — silently no-op

    cmd = (data.get("tool_input") or {}).get("command", "") or ""
    if not isinstance(cmd, str) or not cmd:
        return 0

    if not re.search(r"\bgit\s+push\b", cmd):
        return 0
    if "--dry-run" in cmd:
        return 0

    proj = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    try:
        os.chdir(proj)
    except Exception:
        return 0

    if not Path(".git").exists():
        return 0

    # If the last commit is already the reflection/docs commit, don't nag again.
    try:
        subj = (
            subprocess.check_output(
                ["git", "log", "-1", "--format=%s"], stderr=subprocess.DEVNULL
            )
            .decode("utf-8", errors="replace")
            .strip()
        )
    except Exception:
        return 0

    if re.search(r"(reflection|worklog|рефлекс|docs\(history\))", subj, re.IGNORECASE):
        return 0

    try:
        today = (
            subprocess.check_output(
                ["git", "log", "-1", "--format=%cs"], stderr=subprocess.DEVNULL
            )
            .decode("utf-8", errors="replace")
            .strip()
            or ""
        )
    except Exception:
        today = ""

    history_dir = Path(REFLECTION_DIR)
    today_files = []
    if history_dir.exists() and today:
        today_files = sorted(p.name for p in history_dir.glob(f"{today}-*.md"))

    msg = ["", "[POST-PUSH] Completion checklist after git push:"]
    msg.append(
        "  1. Update second-brain/ knowledge base if business logic or architecture changed."
    )
    if today_files:
        msg.append(
            f"  2. Reflection for {today} already exists: {', '.join(today_files)}"
        )
        msg.append("     -> commit it separately (docs(history): ...) and push.")
    else:
        msg.append(
            f"  2. Write a reflection in {REFLECTION_DIR}/{today or 'YYYY-MM-DD'}-short-title.md"
        )
        msg.append(
            "     (what was asked / how you solved it / what verified / what you learned)."
        )
        msg.append("  3. Commit it separately (docs(history): ...) and push.")
    msg.append(
        "  4. If DB / config / deploy-relevant files changed: update the deploy log"
    )
    msg.append(
        "     and emit the deploy-steps diff (only what this push adds, not the whole file)."
    )

    missing = unindexed_notes()
    if missing:
        shown = ", ".join(missing[:8]) + (" …" if len(missing) > 8 else "")
        msg.append(
            f"  5. ⚠ {len(missing)} note(s) NOT linked in their folder's index.md — a note "
            "without a link does not exist (INDEX_RULES):"
        )
        msg.append(f"     {shown}")
        msg.append(
            "     -> add each to second-brain/<folder>/index.md (NOT to the root map)."
        )

    msg.append("")
    msg.append("If all of this is already done this session — ignore.")
    sys.stderr.write("\n".join(msg) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
