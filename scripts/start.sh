#!/usr/bin/env bash
# Start every registered squad as docker containers (delegates to `squad mgr
# start --all`). On a fresh machine with no squads registered, drops into the
# onboarding wizard first to create one.
#
# Usage:
#   scripts/start.sh [--rebuild|--build]   # extra flags forwarded to `mgr start`

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_bootstrap.sh
. "$SCRIPT_DIR/_bootstrap.sh"

if ! mgr_registered; then
  echo "→ no squads registered. Running onboarding wizard."
  node "$REPO_ROOT/scripts/setup.mjs"
fi

cli="$(ensure_mgr_cli)"
exec $cli mgr start --all "$@"
