#!/usr/bin/env python3
import json
import os
import re
import shutil
import sys

INDEX_NAME = "MEMORY.md"
INDEX_LINE_PREFIX = "- ["
MAX_CONTEXT_CHARS = 4000


def encode_project_path(root: str) -> str:
    return re.sub(r"[^A-Za-z0-9-]", "-", root)


def harness_memory_dir(root: str) -> str:
    return os.path.join(os.path.expanduser("~"), ".claude", "projects", encode_project_path(root), "memory")


def free_target(repo: str, name: str) -> str:
    candidate = os.path.join(repo, name)
    if not os.path.exists(candidate):
        return candidate
    stem, ext = os.path.splitext(name)
    index = 2
    while True:
        candidate = os.path.join(repo, f"{stem}-{index}{ext}")
        if not os.path.exists(candidate):
            return candidate
        index += 1


def merge_index(source: str, target: str) -> None:
    with open(source, "r", encoding="utf-8") as handle:
        incoming = [line.rstrip("\n") for line in handle if line.startswith(INDEX_LINE_PREFIX)]
    if not incoming:
        return
    current = ""
    if os.path.exists(target):
        with open(target, "r", encoding="utf-8") as handle:
            current = handle.read()
    existing = current.splitlines()
    missing = [line for line in incoming if line not in existing]
    if not missing:
        return
    prefix = "" if not current or current.endswith("\n") else "\n"
    with open(target, "a", encoding="utf-8") as handle:
        handle.write(prefix + "\n".join(missing) + "\n")


def migrate(link: str, repo: str) -> None:
    for name in sorted(os.listdir(link)):
        source = os.path.join(link, name)
        if not os.path.isfile(source):
            continue
        if name == INDEX_NAME:
            merge_index(source, os.path.join(repo, INDEX_NAME))
            os.remove(source)
            continue
        shutil.move(source, free_target(repo, name))
    if not os.listdir(link):
        os.rmdir(link)


def serve_index(repo: str) -> None:
    index = os.path.join(repo, INDEX_NAME)
    if not os.path.exists(index):
        return
    with open(index, "r", encoding="utf-8") as handle:
        body = handle.read().strip()
    if not body:
        return
    context = (
        "Память проекта (файлы memory/*.md, индекс memory/MEMORY.md). В этой сессии автоподача "
        "ещё не действовала — связь каталогов создана только что, — поэтому индекс подан хуком:\n\n"
        f"{body}\n\nНужен факт из строки индекса — открой её файл в memory/."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context[:MAX_CONTEXT_CHARS],
        }
    }, ensure_ascii=False))


def main() -> None:
    root = os.environ.get("CLAUDE_PROJECT_DIR")
    if not root or not os.path.isdir(root):
        return
    repo = os.path.join(root, "memory")
    os.makedirs(repo, exist_ok=True)
    link = harness_memory_dir(root)
    if os.path.islink(link):
        if os.path.realpath(link) == os.path.realpath(repo):
            return
        os.remove(link)
    elif os.path.isdir(link):
        migrate(link, repo)
    os.makedirs(os.path.dirname(link), exist_ok=True)
    if os.path.exists(link) or os.path.islink(link):
        return
    os.symlink(repo, link)
    serve_index(repo)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(f"memory-link: {error}\n")
    sys.exit(0)
