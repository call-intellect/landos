#!/usr/bin/env python3
"""PreToolUse guard: блокирует ДЕЙСТВИЕ над файлом секретов, а не упоминание строки.

Команда разбирается до действия (.claude/hooks/lib/cmdparse.py): сегменты →
присваивания → файловые аргументы, раскрытые подстановки и склейки литералов.
Блок — когда программа получает секретный путь. Упоминание строки (process.env,
x.key==='a', grep env) действием не является и проходит.

Секретным считается путь, у которого секретен БАЗОВЫЙ компонент: .env, .env.*,
id_rsa*, credentials*, secrets?.{json,yaml,yml,toml}, а также любой .pem и .key.

Разрешённое исключение: grep '^VAR=' .env (одна переменная для отладки).
Одноразовая разблокировка: .claude/.env-unlock — сторож съедает флаг и пропускает
ровно одно действие.

Wire in settings.json under hooks.PreToolUse for BOTH matchers:
  Bash  -> tool_input.command
  Read  -> tool_input.file_path
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

SECRET_BASENAMES = [
    r"^\.env$",
    r"^\.env\.[A-Za-z0-9_.-]+$",
    r"^[^/]*\.pem$",
    r"^[^/]*\.key$",
    r"^id_rsa[^/]*$",
    r"^credentials[^/]*$",
    r"^secrets?\.(json|ya?ml|toml)$",
]

SECRET_SIGNATURES = [
    ("ключ Anthropic/OpenAI", r"\bsk-[A-Za-z0-9_-]{16,}"),
    ("токен GitHub", r"\bgh[pousr]_[A-Za-z0-9]{20,}"),
    ("ключ AWS", r"\bAKIA[0-9A-Z]{16}\b"),
    ("приватный ключ", r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    ("пароль в строке подключения", r"://[^/\s:@]+:[^/\s:@]+@"),
    ("пароль/токен присваиванием", r"\b(password|passwd|token|secret)\s*[=:]\s*['\"]?[^\s'\"]{8,}"),
]

MEMORY_FILE = re.compile(r"(^|/)memory/.*\.md$")

CODE_FLAGS = ("-c", "-e", "--eval", "--command")

PATH_UNSAFE = re.compile(r"[=()\s'\"\\]")

SINGLE_VAR_GREP = re.compile(
    r"""^\s*(grep|rg)\s+(-\w+\s+)*['"]?\^[A-Za-z_][A-Za-z0-9_]*=?['"]?\s+\S*\.env"""
)

ROUGH_TOKEN = re.compile(r"[^\s'\";|&()<>]+")

BLOCK_TEXT = (
    "BLOCKED: команда обращается к файлу секретов — заблокировано хуком env-guard. "
    "Нужна одна переменная — grep '^ИМЯ=' .env. Запись новых значений (echo >> .env) разрешена."
)


def consume_unlock() -> bool:
    if unlock is None:
        return False
    return unlock.consume(".env-unlock")


def is_secret_path(token: str) -> bool:
    base = token.replace("\\", "/").rstrip("/").split("/")[-1]
    return any(re.match(pattern, base) for pattern in SECRET_BASENAMES)


def candidate_is_secret(token: str) -> bool:
    if not token or PATH_UNSAFE.search(token):
        return False
    return is_secret_path(token)


def block(reason: str) -> int:
    sys.stderr.write(reason + "\n")
    return 2


def verdict(secret_found: bool, reason: str) -> int:
    if not secret_found:
        return 0
    if consume_unlock():
        return 0
    return block(reason)


def code_payloads(tokens: list) -> list:
    out = []
    for i, token in enumerate(tokens):
        if token in CODE_FLAGS and i + 1 < len(tokens):
            out.append(tokens[i + 1])
    return out


def rough_check(command: str) -> int:
    for token in ROUGH_TOKEN.findall(command):
        if candidate_is_secret(token.replace("\\", "")):
            return verdict(True, BLOCK_TEXT)
    return 0


def check_read(tool_input: dict) -> int:
    path = tool_input.get("file_path", "") or ""
    if path and is_secret_path(path):
        return verdict(
            True,
            "BLOCKED: чтение файла секретов заблокировано хуком env-guard. "
            "Нужна одна переменная — используй: grep '^ИМЯ_ПЕРЕМЕННОЙ=' .env",
        )
    return 0


def is_memory_file(path: str) -> bool:
    return bool(MEMORY_FILE.search(path.replace("\\", "/")))


def check_write(tool_input: dict) -> int:
    path = tool_input.get("file_path", "") or ""
    if not path or not is_memory_file(path):
        return 0
    text = tool_input.get("content") or tool_input.get("new_string") or ""
    if not text:
        return 0
    for name, pattern in SECRET_SIGNATURES:
        if re.search(pattern, text):
            return verdict(
                True,
                f"BLOCKED: в записи в файл памяти сработала сигнатура «{name}» — "
                "секретам в памяти места нет (memory/README.md:93). "
                "Координаты инфраструктуры (адрес, домен, хост, порт) писать можно и нужно.",
            )
    return 0


def check_bash(tool_input: dict) -> int:
    command = tool_input.get("command", "") or ""
    if not command:
        return 0
    if SINGLE_VAR_GREP.match(command.strip()):
        return 0
    if cmdparse is None:
        return rough_check(command)
    try:
        segs = cmdparse.segments(command)
    except ValueError:
        return rough_check(command)

    env = cmdparse.assignments(segs)
    for tokens in segs:
        candidates = list(cmdparse.file_args(tokens))
        for token in tokens[1:]:
            candidates.extend(cmdparse.expand(token, env))
        for payload in code_payloads(tokens):
            candidates.extend(cmdparse.literal_joins(payload))
        for candidate in candidates:
            if candidate_is_secret(candidate):
                return verdict(True, BLOCK_TEXT)
    return 0


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    tool = data.get("tool_name", "")
    tool_input = data.get("tool_input") or {}
    if tool == "Read":
        return check_read(tool_input)
    if tool == "Bash":
        return check_bash(tool_input)
    if tool in ("Write", "Edit"):
        return check_write(tool_input)
    return 0


if __name__ == "__main__":
    sys.exit(main())
