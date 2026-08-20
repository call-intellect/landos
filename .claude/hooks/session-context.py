#!/usr/bin/env python3
import json
import os
import sqlite3
import sys

MAX_TITLES = 5
MAX_CONTEXT_CHARS = 4000


def stale_notes(db_path: str):
    uri = f"file:{db_path}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=2)
    try:
        cursor = connection.execute(
            "select count(*) from memories where type = 'second_brain' and stale_status <> 'fresh'"
        )
        total = cursor.fetchone()[0]
        titles = [
            row[0]
            for row in connection.execute(
                "select title from memories where type = 'second_brain' and stale_status <> 'fresh' limit ?",
                (MAX_TITLES,),
            )
        ]
    finally:
        connection.close()
    return total, titles


def main() -> None:
    root = os.environ.get("CLAUDE_PROJECT_DIR")
    if not root:
        return
    db_path = os.path.join(root, ".repobrain", "graph.sqlite")
    if not os.path.exists(db_path):
        return
    total, titles = stale_notes(db_path)
    if not total:
        return
    listed = ", ".join(f"«{title}»" for title in titles)
    context = (
        f"Второй мозг: {total} заметок помечены протухшими — код, на который они ссылаются, "
        f"изменился или исчез: {listed}. Перед тем как опереться на такую заметку, проверь её по коду."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context[:MAX_CONTEXT_CHARS],
        }
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
