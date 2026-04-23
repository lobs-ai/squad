#!/usr/bin/env bash
# Build and run the full Squad stack in Docker via docker compose.
#
# Usage:
#   scripts/launch-docker.sh           # build + up (foreground)
#   scripts/launch-docker.sh -d        # build + up detached
#   scripts/launch-docker.sh down      # stop and remove containers
#   scripts/launch-docker.sh logs      # tail logs
#   scripts/launch-docker.sh rebuild   # force rebuild from scratch

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_bootstrap.sh
. "$SCRIPT_DIR/_bootstrap.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "✗ docker not found on PATH" >&2
  exit 1
fi

# Prefer `docker compose` (v2); fall back to legacy `docker-compose`.
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "✗ neither 'docker compose' nor 'docker-compose' is available" >&2
  exit 1
fi

case "${1:-up}" in
  down)
    "${COMPOSE[@]}" down
    ;;
  logs)
    "${COMPOSE[@]}" logs -f
    ;;
  rebuild)
    "${COMPOSE[@]}" build --no-cache
    "${COMPOSE[@]}" up
    ;;
  up)
    "${COMPOSE[@]}" up --build
    ;;
  -d|--detach)
    "${COMPOSE[@]}" up --build -d
    echo "→ stack running. Dashboard: http://localhost:8080"
    echo "  tail logs:   scripts/launch-docker.sh logs"
    echo "  stop:        scripts/launch-docker.sh down"
    ;;
  *)
    "${COMPOSE[@]}" "$@"
    ;;
esac
