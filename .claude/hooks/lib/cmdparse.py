#!/usr/bin/env python3
"""Разбор Bash-команды до действия: сегменты, файловые аргументы, присваивания,
подстановки, склейки литералов. Только stdlib (shlex, re)."""
import re
import shlex

_ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
_VAR = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")
_REDIR = re.compile(r"^(\d?>>?|&>|>&|<<<|<)(.*)$")
_LITERAL = re.compile(r"'[^']*'|\"[^\"]*\"")
_JOIN = re.compile(r"(?:'[^']*'|\"[^\"]*\")(?:\s*\+\s*(?:'[^']*'|\"[^\"]*\"))+")
_PLACEHOLDER = re.compile(r"\x00(\d+)\x00")
_HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")


def strip_heredocs(text: str) -> str:
    """Убирает тела heredoc: это данные на входе программы, а не её аргументы."""
    out = text
    while True:
        opener = _HEREDOC.search(out)
        if not opener:
            return out
        rest = out[opener.end() :]
        closer = re.search(r"^[ \t]*%s[ \t]*$" % re.escape(opener.group(2)), rest, re.M)
        out = out[: opener.start()] + (rest[closer.end() :] if closer else rest)


def command_substitutions(text: str) -> list:
    """Содержимое $( ... ) и обратных кавычек, вложенность учитывается."""
    found = []
    i = 0
    while i < len(text):
        if text.startswith("$(", i):
            depth = 0
            j = i + 1
            while j < len(text):
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            if j < len(text):
                found.append(text[i + 2 : j])
                i = j + 1
                continue
        if text[i] == "`":
            j = text.find("`", i + 1)
            if j > 0:
                found.append(text[i + 1 : j])
                i = j + 1
                continue
        i += 1
    return found


def _mask(text: str):
    parts = []
    out = []
    i = 0
    while i < len(text):
        if text.startswith("$(", i):
            depth = 0
            j = i + 1
            while j < len(text):
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            if j < len(text):
                parts.append(text[i : j + 1])
                out.append("\x00%d\x00" % (len(parts) - 1))
                i = j + 1
                continue
        if text[i] == "`":
            j = text.find("`", i + 1)
            if j > 0:
                parts.append(text[i : j + 1])
                out.append("\x00%d\x00" % (len(parts) - 1))
                i = j + 1
                continue
        out.append(text[i])
        i += 1
    return "".join(out), parts


def _unmask(token: str, parts: list) -> str:
    return _PLACEHOLDER.sub(lambda m: parts[int(m.group(1))], token)


def _split_control(text: str) -> list:
    chunks = []
    buf = []
    quote = None
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:
            buf.append(ch)
            if ch == quote:
                quote = None
            elif ch == "\\" and quote == '"' and i + 1 < len(text):
                buf.append(text[i + 1])
                i += 1
        elif ch in "'\"":
            quote = ch
            buf.append(ch)
        elif ch in ";|&\n":
            chunks.append("".join(buf))
            buf = []
            while i + 1 < len(text) and text[i + 1] in ";|&":
                i += 1
        else:
            buf.append(ch)
        i += 1
    chunks.append("".join(buf))
    return [c for c in (chunk.strip() for chunk in chunks) if c]


def segments(command: str) -> list:
    """Режет команду по ; && || | и токенизирует каждый сегмент через shlex.
    Бросает ValueError, если shlex не разобрал строку."""
    masked, parts = _mask(strip_heredocs(command))
    out = []
    for chunk in _split_control(masked):
        tokens = shlex.split(chunk, posix=True)
        out.append([_unmask(t, parts) for t in tokens])
    return out


def file_args(tokens: list) -> list:
    """Токены сегмента без имени программы и без флагов (-x, --long, --k=v).
    Цель перенаправления на запись отбрасывается, источник чтения остаётся."""
    out = []
    i = 1
    while i < len(tokens):
        token = tokens[i]
        redirect = _REDIR.match(token)
        if redirect:
            operator, tail = redirect.group(1), redirect.group(2)
            target = tail
            if not target and i + 1 < len(tokens):
                i += 1
                target = tokens[i]
            if operator.startswith("<") and target:
                out.append(target)
            i += 1
            continue
        if token.startswith("-") or _ASSIGN.match(token):
            i += 1
            continue
        out.append(token)
        i += 1
    return out


def assignments(segs: list) -> dict:
    """VAR=value из любого сегмента → {'F': '.env'}."""
    out = {}
    for tokens in segs:
        for token in tokens:
            match = _ASSIGN.match(token)
            if not match:
                break
            out[match.group(1)] = match.group(2)
    return out


def expand(token: str, env: dict) -> list:
    """Раскрывает $VAR/${VAR} по env и содержимое $(...) в отдельные кандидаты."""
    out = []
    for inner in command_substitutions(token):
        try:
            out.extend(shlex.split(inner, posix=True))
        except ValueError:
            out.extend(inner.split())
    replaced = _VAR.sub(lambda m: env.get(m.group(1) or m.group(2), ""), token)
    if replaced and replaced != token:
        out.append(replaced)
    return out


def literal_joins(code: str) -> list:
    """Склейки строковых литералов в коде для -c/-e: "'.'+'env'" → ['.env'].
    Одиночные литералы возвращаются тоже — путь может быть записан целиком."""
    out = []
    for joined in _JOIN.finditer(code):
        out.append("".join(part[1:-1] for part in _LITERAL.findall(joined.group(0))))
    for literal in _LITERAL.finditer(code):
        value = literal.group(0)[1:-1]
        if value:
            out.append(value)
    return out
