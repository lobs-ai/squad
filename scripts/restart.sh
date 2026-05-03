#!/usr/bin/env bash
# Restart every registered squad: full stop + start cycle (delegates to
# `squad mgr stop --all` then `squad mgr start --all`). Use this when an
# in-place `docker compose restart` isn't enough — e.g. compose template
# changed, env file edits, image rebuild needed.
#
# Usage:
#   scripts/restart.sh [--rebuild|--build]   # extra flags forwarded to `mgr start`

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_bootstrap.sh
. "$SCRIPT_DIR/_bootstrap.sh"

if ! mgr_registered; then
  echo "→ no squads registered. Nothing to restart."
  exit 0
fi

cli="$(ensure_mgr_cli)"
$cli mgr stop --all
exec $cli mgr start --all "$@"
