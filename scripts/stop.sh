#!/usr/bin/env bash
# Stop the Squad gateway (docker compose or local background process).
#
# Usage:
#   scripts/stop.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_bootstrap.sh
. "$SCRIPT_DIR/_bootstrap.sh"

mode="$(current_mode)"
if [ -z "$mode" ]; then
  echo "→ no running instance recorded (docker/data/squad.mode missing)"
  exit 0
fi

case "$mode" in
  docker)
    COMPOSE="$(compose_cmd)"
    echo "→ docker compose down"
    $COMPOSE --env-file "$ENV_FILE" down
    rm -f "$MODE_FILE"
    echo "✓ stopped"
    ;;
  local)
    if [ ! -f "$PID_FILE" ]; then
      echo "→ no pid file; clearing mode"
      rm -f "$MODE_FILE"
      exit 0
    fi
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "→ stopping pid $pid"
      kill "$pid"
      # Give it a moment, then SIGKILL if still alive.
      for _ in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$pid" 2>/dev/null; then
        echo "→ process still alive, sending SIGKILL"
        kill -9 "$pid" 2>/dev/null || true
      fi
    else
      echo "→ pid $pid not running"
    fi
    rm -f "$PID_FILE" "$MODE_FILE"
    echo "✓ stopped"
    ;;
  *)
    echo "✗ unknown mode in $MODE_FILE: $mode" >&2
    exit 1
    ;;
esac
