#!/usr/bin/env bash
# VibeOS: incremental RepoBrain reindex.
#   Triggers: (a) Stop hook after every turn, (b) post-commit hook on any commit
#   (including manual `git commit` from the terminal). Two triggers so nothing is missed.
#   Fail-open, non-blocking (detached), deduped by a lock. Also self-installs the git
#   post-commit hook (idempotent) so every project gets terminal-commit reindex for free.
set -u

ROOT="${CLAUDE_PROJECT_DIR:-}"
[ -z "$ROOT" ] && ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -z "$ROOT" ] && exit 0
cd "$ROOT" 2>/dev/null || exit 0

command -v git  >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

CLI="$ROOT/RepoBrain/apps/cli/dist/cli.js"
[ -f "$CLI" ] || exit 0

GITDIR="$(git rev-parse --git-dir 2>/dev/null || echo .git)"
case "$GITDIR" in /*) ;; *) GITDIR="$ROOT/$GITDIR" ;; esac
LOG="$GITDIR/repobrain-reindex.log"
LOCK="$GITDIR/repobrain-reindex.lock"

LOG_MAX_BYTES=1048576

if [ "${_RB_WORKER:-}" = "1" ]; then
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
  fi
  {
    echo "--- reindex $(date '+%Y-%m-%d %H:%M:%S') ---"
    node "$CLI" --cwd "$ROOT" index
  } >> "$LOG" 2>&1
  exit 0
fi

hooks_dir() {
  local configured
  configured="$(git config core.hooksPath 2>/dev/null || true)"
  if [ -n "$configured" ]; then
    case "$configured" in
      /*) printf '%s\n' "$configured" ;;
      *)  printf '%s\n' "$ROOT/$configured" ;;
    esac
    return 0
  fi
  if [ -d "$ROOT/.husky/_" ]; then
    printf '%s\n' "$ROOT/.husky/_"
    return 0
  fi
  if [ -d "$ROOT/.husky" ]; then
    printf '%s\n' "$ROOT/.husky"
    return 0
  fi
  printf '%s\n' "$GITDIR/hooks"
}

install_post_commit() {
  local marker="vibeos-repobrain-reindex"
  local dir
  dir="$(hooks_dir)"
  local hook="$dir/post-commit"
  mkdir -p "$dir" 2>/dev/null || return 0
  if [ -f "$hook" ] && grep -q "$marker" "$hook" 2>/dev/null; then
    return 0
  fi
  [ -f "$hook" ] || printf '%s\n' '#!/usr/bin/env bash' > "$hook"
  {
    printf '%s\n' "# >>> $marker >>>"
    printf '%s\n' 'RB_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"'
    printf '%s\n' '[ -n "$RB_ROOT" ] && [ -x "$RB_ROOT/.claude/hooks/repobrain-reindex.sh" ] && "$RB_ROOT/.claude/hooks/repobrain-reindex.sh" >/dev/null 2>&1 || true'
    printf '%s\n' "# <<< $marker <<<"
  } >> "$hook"
  chmod +x "$hook" 2>/dev/null || true
}
install_post_commit

mkdir "$LOCK" 2>/dev/null || exit 0

_RB_WORKER=1 nohup "$0" >/dev/null 2>&1 < /dev/null &
disown 2>/dev/null || true
exit 0
