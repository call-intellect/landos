#!/usr/bin/env bash
# RepoBrain — one-command installer.
#
#   ./install.sh                 build + expose the `repobrain` command
#   ./install.sh /path/to/repo   ...and immediately set it up in that repo
#
# Everything runs locally. No code and no embeddings leave your machine.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

# 1) preflight — Node 18+
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required (v18+). Install it from https://nodejs.org and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js v18+ required (found v$(node -v)). Please upgrade." >&2
  exit 1
fi
say "• Node $(node -v) ok"

# 2) install deps + build
say "• Installing dependencies…"
npm install --no-audit --no-fund >/dev/null 2>&1 || npm install
say "• Building…"
npm run build >/dev/null

# 3) expose the `repobrain` command (global link; falls back to a hint if not permitted)
if (cd apps/cli && npm link >/dev/null 2>&1); then
  say "• Linked the \`repobrain\` command globally"
  RB="repobrain"
else
  RB="node \"$HERE/apps/cli/dist/cli.js\""
  say "• Could not link globally — use: $RB"
fi

echo
say "✅ RepoBrain built."

# 4) optionally set up a repo right now
if [ "${1:-}" != "" ]; then
  TARGET="$(cd "$1" && pwd)"
  say "• Setting up in: $TARGET"
  # shellcheck disable=SC2086
  node "$HERE/apps/cli/dist/cli.js" --cwd "$TARGET" setup
else
  echo
  echo "Next — set it up inside any project:"
  echo "    $RB --cwd /path/to/your/repo setup"
  echo
  echo "That wires up Claude Code / Cursor (MCP + rules), indexes the repo, and verifies."
fi
