#!/usr/bin/env python3
"""Одноразовый разблокировщик сторожей: файл-флаг в .claude/, который сторож съедает.

Единый приём кита: .env-unlock для сторожа секретов, .push-unlock для сторожа push.
Владелец создаёт файл, следующее действие проходит, флаг исчезает."""
import os


def unlock_path(name: str) -> str:
    root = os.environ.get("CLAUDE_PROJECT_DIR", ".")
    return os.path.join(root, ".claude", name)


def consume(name: str) -> bool:
    path = unlock_path(name)
    if os.path.isfile(path):
        try:
            os.remove(path)
            return True
        except OSError:
            return False
    return False
