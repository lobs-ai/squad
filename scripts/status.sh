#!/usr/bin/env bash
# Show the squad list (delegates to `squad mgr ls`), or stream logs for the
# only squad if there's just one.
#
# Usage:
#   scripts/status.sh        # list squads + running status
#   scripts/status.sh logs   # follow logs (single squad), or list (multiple)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_bootstrap.sh
. "$SCRIPT_DIR/_bootstrap.sh"

sub="${1:-status}"

if ! mgr_registered; then
  echo "status: no squads registered. Run 'squad onboard' to create one."
  exit 0
fi

cli="$(ensure_mgr_cli)"

if [ "$sub" = "logs" ]; then
  only="$(node -e "const r=JSON.parse(require('fs').readFileSync('$REGISTRY_FILE','utf8'));console.log((r.squads||[]).length===1?r.squads[0].name:'')" 2>/dev/null || true)"
  if [ -n "$only" ]; then
    exec $cli mgr logs "$only" -f
  fi
  echo "multiple squads registered. Pick one: squad mgr logs <name> -f" >&2
  exec $cli mgr ls
fi

exec $cli mgr ls
