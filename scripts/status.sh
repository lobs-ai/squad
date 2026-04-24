#!/usr/bin/env bash
# Report Squad gateway status (mode, URL, liveness). Also tails logs on request.
#
# Usage:
#   scripts/status.sh        # print status
#   scripts/status.sh logs   # tail logs (docker compose logs -f or tail -f)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_bootstrap.sh
. "$SCRIPT_DIR/_bootstrap.sh"

mode="$(current_mode)"
sub="${1:-status}"

if [ "$sub" = "logs" ]; then
  case "$mode" in
    docker)
      COMPOSE="$(compose_cmd)"
      exec $COMPOSE --env-file "$ENV_FILE" logs -f
      ;;
    local)
      exec tail -f "$LOG_FILE"
      ;;
    *)
      echo "→ no running instance recorded" >&2
      exit 1
      ;;
  esac
fi

if [ -z "$mode" ]; then
  echo "status: stopped"
  exit 0
fi

# Load env so SQUAD_PORT is available for the URL line.
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ENV_FILE"
  set +a
fi
PORT="${SQUAD_PORT:-8080}"

case "$mode" in
  docker)
    COMPOSE="$(compose_cmd)"
    if $COMPOSE --env-file "$ENV_FILE" ps --services --filter "status=running" 2>/dev/null | grep -q '^squad$'; then
      echo "status: running (docker)"
      echo "url:    http://localhost:$PORT"
    else
      echo "status: stopped (docker mode file exists but no running service)"
    fi
    ;;
  local)
    if is_local_running; then
      echo "status: running (local, pid $(cat "$PID_FILE"))"
      echo "url:    http://localhost:$PORT"
      echo "logs:   $LOG_FILE"
    else
      echo "status: stopped (stale pid file)"
    fi
    ;;
esac
