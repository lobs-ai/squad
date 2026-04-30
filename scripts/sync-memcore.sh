#!/usr/bin/env bash
# Mirror an external MemCore checkout into packages/memcore so the vendored
# workspace copy stays current. No-op when the source dir is missing (e.g.
# inside the Docker build, or on machines that don't have a sibling checkout).
#
# Override the source path with MEMCORE_SRC. Default: ../MemCore relative to
# the squad repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

src="${MEMCORE_SRC:-$REPO_ROOT/../MemCore}"
dst="$REPO_ROOT/packages/memcore"

if [ ! -d "$src" ]; then
  exit 0
fi

src="$(cd "$src" && pwd)"
if [ "$src" = "$dst" ]; then
  exit 0
fi

# --delete keeps the vendored copy a true mirror; the workspace package.json
# rewrite below restores anything we need to differ.
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='coverage' \
  --exclude='.turbo' \
  --exclude='pnpm-lock.yaml' \
  --exclude='pnpm-workspace.yaml' \
  --exclude='docker-compose.yml' \
  "$src/" "$dst/"

echo "→ synced memcore from $src"
