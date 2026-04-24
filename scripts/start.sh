#!/usr/bin/env bash
# Start the Squad gateway as a background process.
#
# Usage:
#   scripts/start.sh                # docker if available, else local
#   scripts/start.sh --docker       # force docker compose
#   scripts/start.sh --local        # force local pnpm process
#
# Writes docker/data/squad.mode so stop.sh and `squad` know which one is up.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_bootstrap.sh
. "$SCRIPT_DIR/_bootstrap.sh"

MODE=""
case "${1:-}" in
  --docker) MODE="docker" ;;
  --local)  MODE="local"  ;;
  "")
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      MODE="docker"
    else
      MODE="local"
    fi
    ;;
  *)
    echo "usage: $0 [--docker|--local]" >&2
    exit 2
    ;;
esac

existing="$(current_mode)"
if [ -n "$existing" ]; then
  if [ "$existing" = "docker" ]; then
    COMPOSE="$(compose_cmd)"
    if $COMPOSE ps --services --filter "status=running" 2>/dev/null | grep -q '^squad$'; then
      echo "→ already running (docker). Use scripts/stop.sh first." >&2
      exit 0
    fi
  elif [ "$existing" = "local" ] && is_local_running; then
    echo "→ already running (local, pid $(cat "$PID_FILE")). Use scripts/stop.sh first." >&2
    exit 0
  fi
fi

ensure_config
load_env

case "$MODE" in
  docker)
    COMPOSE="$(compose_cmd)"
    echo "→ starting docker stack on port ${SQUAD_PORT:-8080}"
    # --env-file lets compose substitute ${SQUAD_PORT} from docker/.env into
    # the ports + healthcheck blocks in docker-compose.yml.
    $COMPOSE --env-file "$ENV_FILE" up --build -d
    echo "docker" > "$MODE_FILE"
    rm -f "$PID_FILE"
    echo "✓ running at http://localhost:${SQUAD_PORT:-8080}"
    echo "  logs:  scripts/status.sh logs   (or: squad logs -f)"
    echo "  stop:  scripts/stop.sh          (or: squad stop)"
    ;;
  local)
    if ! command -v pnpm >/dev/null 2>&1; then
      if command -v corepack >/dev/null 2>&1; then
        corepack enable
        corepack prepare pnpm@9.0.0 --activate
      else
        echo "✗ pnpm not found and corepack unavailable" >&2
        exit 1
      fi
    fi

    export SQUAD_CONFIG="${SQUAD_CONFIG:-$CONFIG_FILE}"

    if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules ]; then
      echo "→ pnpm install"
      pnpm install
    fi
    if [ ! -d packages/gateway/dist ]; then
      echo "→ pnpm -r build"
      pnpm -r build
    fi

    echo "→ starting gateway in background (logs: $LOG_FILE)"
    : > "$LOG_FILE"
    nohup pnpm --filter @squad/gateway start >>"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "local" > "$MODE_FILE"
    sleep 1
    if ! is_local_running; then
      echo "✗ process exited immediately — tail $LOG_FILE" >&2
      exit 1
    fi
    echo "✓ running at http://localhost:8080 (pid $(cat "$PID_FILE"))"
    echo "  logs:  tail -f $LOG_FILE   (or: squad logs -f)"
    echo "  stop:  scripts/stop.sh     (or: squad stop)"
    ;;
esac
