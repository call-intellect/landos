#!/usr/bin/env python3
import json
import os
import sys
import time
import urllib.request
import urllib.error

STORE = os.environ.get("VIBEOS_STORE_URL", "https://vibe-os.ru")
CHECK_INTERVAL_SECONDS = 24 * 60 * 60
TIMEOUT_SECONDS = 3


def project_root(payload):
    return os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()


def installed_version(root):
    path = os.path.join(root, "kit.manifest.yaml")
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("kit_version:"):
                    return line.split(":", 1)[1].strip().strip('"').strip("'")
    except OSError:
        return None
    return None


def parse_semver(value):
    parts = []
    for chunk in str(value).split("."):
        digits = ""
        for char in chunk:
            if char.isdigit():
                digits += char
            else:
                break
        parts.append(int(digits) if digits else 0)
    return parts


def is_newer(latest, installed):
    left, right = parse_semver(latest), parse_semver(installed)
    for index in range(max(len(left), len(right))):
        x = left[index] if index < len(left) else 0
        y = right[index] if index < len(right) else 0
        if x != y:
            return x > y
    return False


def recently_checked(root):
    stamp = os.path.join(root, ".vibeos", "last-update-check")
    try:
        return os.path.exists(stamp) and (time.time() - os.path.getmtime(stamp)) < CHECK_INTERVAL_SECONDS
    except OSError:
        return False


def mark_checked(root):
    try:
        vibeos = os.path.join(root, ".vibeos")
        os.makedirs(vibeos, exist_ok=True)
        with open(os.path.join(vibeos, "last-update-check"), "w", encoding="utf-8") as handle:
            handle.write(str(int(time.time())))
    except OSError:
        pass


def fetch_latest_version():
    request = urllib.request.Request(f"{STORE}/api/kit/latest", headers={"accept": "application/json"})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload.get("version")


def emit(context):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": context,
        }
    }))


def main():
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        payload = {}
    root = project_root(payload)
    installed = installed_version(root)
    if not installed or recently_checked(root):
        return
    try:
        latest = fetch_latest_version()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError):
        return
    mark_checked(root)
    if latest and is_newer(latest, installed):
        emit(
            f"Доступна новая версия кита VibeOS: {latest} (установлена {installed}). "
            "Предложи владельцу обновиться скиллом kit-updater — он обновит без потери его работы "
            "(одна фраза «обнови кит»). Обновление не запускай без согласия владельца."
        )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
