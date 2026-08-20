---
name: python3-stub-windows
description: "На этой Windows-машине `python3` — нерабочая заглушка Microsoft Store; рабочий интерпретатор только `python`"
metadata: 
  node_type: memory
  type: project
  originSessionId: a2fba8c2-91be-4068-81e6-5a4d5c3a92c0
  modified: 2026-08-17T05:37:45.723Z
---

На машине владельца (Windows 10, c:\work\landos) команда `python3` разрешается в
`C:\Users\USER\AppData\Local\Microsoft\WindowsApps\python3` — заглушку Microsoft Store:
она печатает `Python` и завершается с кодом 49, ничего не выполняя. Рабочий интерпретатор —
`python` (3.12.8, `C:\Users\USER\AppData\Local\Programs\Python\Python312\python.exe`).

**Why:** любой скрипт с шебангом `#!/usr/bin/env python3` (в частности все хуки VibeOS в
`.claude/hooks/*.py`) молча не выполняется — хуки-сторожа `env-guard` и `pre-bash-guard`
выглядят установленными, но не срабатывают.

**How to apply:** в `.claude/settings.json` (2026-08-17) команды хуков переписаны на форму
`python "$CLAUDE_PROJECT_DIR/.claude/hooks/<имя>.py"`; туда же добавлено
`env.PYTHONUTF8=1`, иначе русские сообщения хуков уезжают в cp866 крокозябрами.
При обновлении кита (`kit-updater`) эту правку settings.json нужно сохранить.
Связано: [[example-project-fact]].
