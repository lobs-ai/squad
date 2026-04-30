#!/usr/bin/env bash
# One-shot installer: ensure pnpm, install deps, build the workspace, link the
# `squad` binary globally, and verify it's on PATH.
#
# Usage:
#   scripts/install.sh            # install
#   scripts/install.sh --uninstall  # remove the global link

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then return; fi
  if command -v corepack >/dev/null 2>&1; then
    echo "→ pnpm not found, enabling via corepack"
    corepack enable
    corepack prepare pnpm@9.0.0 --activate
    return
  fi
  echo "✗ pnpm not found and corepack unavailable. Install Node 20+ first." >&2
  exit 1
}

# Ensure pnpm has a global bin dir configured. If not, create one under
# ~/.local/share/pnpm (Linux default) or ~/Library/pnpm (macOS default),
# point pnpm at it, export PNPM_HOME for the rest of this script, and print
# the PATH line the user needs to add to their shell rc.
ensure_pnpm_bin_dir() {
  # `pnpm bin -g` exits 0 even when no dir is configured — check the output.
  local existing
  existing="$(pnpm bin -g 2>/dev/null || true)"
  if [ -n "$existing" ] && [ -d "$existing" ]; then
    PNPM_BIN_DIR="$existing"
    export PNPM_HOME="${PNPM_HOME:-$existing}"
    export PATH="$PNPM_HOME:$PATH"
    return
  fi

  if [ "$(uname -s)" = "Darwin" ]; then
    PNPM_HOME="${PNPM_HOME:-$HOME/Library/pnpm}"
  else
    PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"
  fi
  mkdir -p "$PNPM_HOME"
  export PNPM_HOME
  export PATH="$PNPM_HOME:$PATH"
  pnpm config set global-bin-dir "$PNPM_HOME" >/dev/null
  PNPM_BIN_DIR="$PNPM_HOME"

  echo "→ configured pnpm global bin: $PNPM_HOME"
  cat <<EOF
  add this to your ~/.zshrc or ~/.bashrc so 'squad' stays on PATH:

    export PNPM_HOME="$PNPM_HOME"
    export PATH="\$PNPM_HOME:\$PATH"

EOF
}

if [ "${1:-}" = "--uninstall" ]; then
  ensure_pnpm
  ensure_pnpm_bin_dir
  echo "→ unlinking squad globally"
  (cd "$REPO_ROOT/packages/client-cli" && pnpm unlink --global) || true
  echo "✓ uninstalled. Restart your shell or 'hash -r' to drop the old path."
  exit 0
fi

ensure_pnpm
ensure_pnpm_bin_dir

"$SCRIPT_DIR/sync-memcore.sh"

if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules ]; then
  echo "→ pnpm install"
  pnpm install
fi

echo "→ building workspace"
pnpm -r build

echo "→ linking squad globally"
(cd "$REPO_ROOT/packages/client-cli" && pnpm link --global)

# The linked binary uses import.meta.dirname to locate the source repo (for
# scripts/ + the docker build context). SQUAD_REPO is a fallback for edge
# cases like sourcing the binary through a wrapper that strips that.
mkdir -p "$HOME/.squad"
if ! grep -q "^SQUAD_REPO=" "$HOME/.squad/env" 2>/dev/null; then
  echo "SQUAD_REPO=$REPO_ROOT" >> "$HOME/.squad/env"
fi

if [ ! -x "$PNPM_BIN_DIR/squad" ]; then
  echo "✗ link succeeded but 'squad' binary not found in $PNPM_BIN_DIR" >&2
  exit 1
fi
echo "✓ installed: $PNPM_BIN_DIR/squad"

# Make sure PNPM_BIN_DIR is on the user's PATH for future shells. Append the
# export lines to whichever shell rc matches $SHELL, if not already present.
ensure_on_path_in_rc() {
  local rc=""
  case "${SHELL:-}" in
    */zsh)  rc="$HOME/.zshrc" ;;
    */bash) rc="$HOME/.bashrc" ;;
    *)      rc="" ;;
  esac
  if [ -z "$rc" ]; then
    echo ""
    echo "  add to your shell rc so 'squad' stays on PATH:"
    echo "    export PNPM_HOME=\"$PNPM_BIN_DIR\""
    echo "    export PATH=\"\$PNPM_HOME:\$PATH\""
    return
  fi
  if [ -f "$rc" ] && grep -q "squad-install: PNPM_HOME" "$rc"; then
    return
  fi
  cat >> "$rc" <<EOF

# squad-install: PNPM_HOME
export PNPM_HOME="$PNPM_BIN_DIR"
export PATH="\$PNPM_HOME:\$PATH"
EOF
  echo "→ appended PNPM_HOME + PATH to $rc"
  echo "  open a new terminal (or: source $rc) to pick up 'squad' on PATH."
}

ensure_on_path_in_rc

echo ""
echo "  squad onboard       create your first squad (config + LLM keys)"
echo "  squad mgr ls        list registered squads"
echo "  squad mgr start --all   start every squad as a docker container"
echo "  squad repl          open an interactive session against the current squad"
echo "  squad --help        all commands"
