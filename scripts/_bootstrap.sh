#!/usr/bin/env bash
# Shared bootstrap: locate the repo, ensure docker/config.json and docker/.env
# exist (running the setup wizard if not), export the env file into the current
# shell, and expose helpers that start/stop/status scripts share.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DOCKER_DIR="$REPO_ROOT/docker"
CONFIG_FILE="$DOCKER_DIR/config.json"
ENV_FILE="$DOCKER_DIR/.env"
DATA_DIR="$DOCKER_DIR/data"
PID_FILE="$DATA_DIR/squad.pid"
MODE_FILE="$DATA_DIR/squad.mode"
LOG_FILE="$DATA_DIR/squad.log"

mkdir -p "$DATA_DIR"

ensure_config() {
  if [ ! -f "$CONFIG_FILE" ] || [ ! -f "$ENV_FILE" ]; then
    echo "→ first run — generating docker/config.json and docker/.env"
    if ! command -v node >/dev/null 2>&1; then
      echo "✗ node not found on PATH. Install Node 20+ and re-run." >&2
      exit 1
    fi
    node "$REPO_ROOT/scripts/setup.mjs"
  fi
}

load_env() {
  set -a
  # shellcheck disable=SC1091
  . "$ENV_FILE"
  set +a
  # Any one provider key is enough — gateway picks primary from config.json.
  for v in ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GOOGLE_API_KEY \
           GROQ_API_KEY DEEPSEEK_API_KEY XAI_API_KEY TOGETHER_API_KEY \
           MISTRAL_API_KEY PPLX_API_KEY FIREWORKS_API_KEY CEREBRAS_API_KEY \
           COHERE_API_KEY SAMBANOVA_API_KEY NOVITA_API_KEY HYPERBOLIC_API_KEY \
           LAMBDA_API_KEY ZAI_API_KEY MINIMAX_API_KEY KIMI_API_KEY \
           OPENCODE_API_KEY; do
    eval "val=\${$v:-}"
    if [ -n "$val" ]; then return; fi
  done
  echo "✗ no LLM provider key set in docker/.env — run 'squad onboard'" >&2
  exit 1
}

# Detect docker compose v2 vs legacy v1; echoes the command to use.
compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    echo "docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "docker-compose"
  else
    echo "✗ neither 'docker compose' nor 'docker-compose' is available" >&2
    exit 1
  fi
}

current_mode() {
  if [ -f "$MODE_FILE" ]; then
    cat "$MODE_FILE"
  else
    echo ""
  fi
}

is_local_running() {
  [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null
}
