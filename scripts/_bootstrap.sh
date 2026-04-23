#!/usr/bin/env bash
# Shared bootstrap: ensure ./config.yaml and ./.env exist, then export .env vars.
# Sourced by launch-docker.sh and launch-local.sh.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f config.yaml ]; then
  echo "→ config.yaml not found, copying from examples/config.yaml"
  cp examples/config.yaml config.yaml
fi

if [ ! -f .env ]; then
  echo "→ .env not found, copying from examples/.env.example"
  cp examples/.env.example .env
  echo "  edit .env to set ANTHROPIC_API_KEY (and DISCORD_BOT_TOKEN if using Discord)"
fi

# Export every non-comment KEY=VALUE pair from .env into the current shell.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "✗ ANTHROPIC_API_KEY is empty in .env — set it before launching" >&2
  exit 1
fi
