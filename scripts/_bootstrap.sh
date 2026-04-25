#!/usr/bin/env bash
# Shared helpers for scripts that delegate to the multi-squad manager. The
# legacy single-squad `./docker/` install path is gone — these scripts are
# all thin shims around `squad mgr ...`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SQUAD_HOME="${SQUAD_HOME:-$HOME/.squad}"
REGISTRY_FILE="$SQUAD_HOME/squads.json"

# True iff at least one squad is registered in ~/.squad/squads.json.
mgr_registered() {
  [ -f "$REGISTRY_FILE" ] && \
    node -e "const r=JSON.parse(require('fs').readFileSync('$REGISTRY_FILE','utf8'));process.exit((r.squads||[]).length>0?0:1)" 2>/dev/null
}

# Path to a runnable squad CLI. Prefers the repo's built binary; falls back to
# the globally-installed `squad`. Echoes the command (may be multi-word).
mgr_cli_or_empty() {
  local local_bin="$REPO_ROOT/packages/client-cli/dist/cli.js"
  if [ -f "$local_bin" ]; then
    echo "node $local_bin"
  elif command -v squad >/dev/null 2>&1; then
    echo "squad"
  else
    echo ""
  fi
}

# Like mgr_cli_or_empty, but builds the CLI if neither the dist nor a global
# install is present. Exits 1 if even building fails.
ensure_mgr_cli() {
  local cli
  cli="$(mgr_cli_or_empty)"
  if [ -n "$cli" ]; then
    echo "$cli"
    return
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "✗ neither dist/cli.js nor 'squad' on PATH, and pnpm isn't available to build it." >&2
    exit 1
  fi
  echo "→ building @squad/client-cli (one-time)" >&2
  pnpm --filter @squad/client-cli build >&2
  cli="$(mgr_cli_or_empty)"
  if [ -z "$cli" ]; then
    echo "✗ build succeeded but cli.js is still missing." >&2
    exit 1
  fi
  echo "$cli"
}
