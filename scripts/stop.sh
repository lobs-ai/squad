#!/usr/bin/env bash
# Stop every registered squad (delegates to `squad mgr stop --all`).
#
# Usage:
#   scripts/stop.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_bootstrap.sh
. "$SCRIPT_DIR/_bootstrap.sh"

if ! mgr_registered; then
  echo "→ no squads registered. Nothing to stop."
  exit 0
fi

cli="$(ensure_mgr_cli)"
exec $cli mgr stop --all
