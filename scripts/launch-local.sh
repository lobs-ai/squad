#!/usr/bin/env bash
# Run the Squad gateway directly via Node + pnpm — no Docker.
#
# Usage:
#   scripts/launch-local.sh           # install (if needed) + build + start
#   scripts/launch-local.sh dev       # install (if needed) + tsx watch (no build)
#   scripts/launch-local.sh build     # install + build only, no run

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_bootstrap.sh
. "$SCRIPT_DIR/_bootstrap.sh"

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    echo "→ pnpm not found, enabling via corepack"
    corepack enable
    corepack prepare pnpm@9.0.0 --activate
  else
    echo "✗ pnpm not found and corepack unavailable. Install Node 20+ or run: npm i -g pnpm@9" >&2
    exit 1
  fi
fi

# Point the gateway at the repo-local config and create its data dir.
export SQUAD_CONFIG="${SQUAD_CONFIG:-$REPO_ROOT/config.yaml}"
mkdir -p "$REPO_ROOT/data"

# Only re-install if node_modules is missing or the lockfile is newer.
if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules ]; then
  echo "→ pnpm install"
  pnpm install
fi

case "${1:-start}" in
  dev)
    echo "→ pnpm --filter @squad/gateway dev (watch mode)"
    exec pnpm --filter @squad/gateway dev
    ;;
  build)
    echo "→ pnpm -r build"
    exec pnpm -r build
    ;;
  start)
    if [ ! -d packages/gateway/dist ]; then
      echo "→ no dist/ found, running pnpm -r build"
      pnpm -r build
    fi
    echo "→ pnpm --filter @squad/gateway start"
    exec pnpm --filter @squad/gateway start
    ;;
  *)
    echo "unknown subcommand: $1" >&2
    echo "usage: $0 [dev|build|start]" >&2
    exit 2
    ;;
esac
