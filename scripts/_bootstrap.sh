#!/usr/bin/env bash
# Shared bootstrap: ensure docker/config.json and docker/.env exist (running
# the setup wizard if not), then export .env vars into the current shell.
# Sourced by launch-docker.sh and launch-local.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOCKER_DIR="$REPO_ROOT/docker"
CONFIG_FILE="$DOCKER_DIR/config.json"
ENV_FILE="$DOCKER_DIR/.env"

if [ ! -f "$CONFIG_FILE" ] || [ ! -f "$ENV_FILE" ]; then
  echo "→ docker/config.json or docker/.env missing — running setup wizard"
  if ! command -v node >/dev/null 2>&1; then
    echo "✗ node not found on PATH. Install Node 20+ and re-run." >&2
    exit 1
  fi
  node "$REPO_ROOT/scripts/setup.mjs"
fi

mkdir -p "$DOCKER_DIR/data"

# Export every non-comment KEY=VALUE pair from docker/.env into the current shell.
set -a
# shellcheck disable=SC1091
. "$ENV_FILE"
set +a

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "✗ ANTHROPIC_API_KEY is empty in docker/.env — run 'pnpm setup' to fix" >&2
  exit 1
fi
