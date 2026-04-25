#!/usr/bin/env bash
# Container entrypoint. Wires up git + ssh + gh from environment variables set
# by docker/.env, then execs the real command.
#
# Env that matters:
#   GIT_USER_NAME          global git committer name
#   GIT_USER_EMAIL         global git committer email
#   GITHUB_TOKEN           PAT; used by gh and (via gh) by git over HTTPS
#   ANTHROPIC_API_KEY      required; gateway will error if missing

set -euo pipefail

SSH_DIR=/app/docker/data/ssh
KNOWN_HOSTS="$SSH_DIR/known_hosts"
DEFAULT_KEY="$SSH_DIR/id_ed25519"

# --- git identity ---------------------------------------------------------
if [ -n "${GIT_USER_NAME:-}" ]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "${GIT_USER_EMAIL:-}" ]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

# --- ssh: trust github.com once, point git at the generated key ----------
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR" 2>/dev/null || true

if [ ! -f "$KNOWN_HOSTS" ]; then
  ssh-keyscan -t rsa,ecdsa,ed25519 github.com 2>/dev/null > "$KNOWN_HOSTS" || true
fi

if [ -f "$DEFAULT_KEY" ]; then
  chmod 600 "$DEFAULT_KEY" 2>/dev/null || true
  export GIT_SSH_COMMAND="ssh -i $DEFAULT_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN_HOSTS -o StrictHostKeyChecking=accept-new"
fi

# --- gh auth + git https via gh -------------------------------------------
# gh reads GITHUB_TOKEN directly, so `gh` and `git clone https://…` (via the
# gh credential helper) both work without an interactive login.
if [ -n "${GITHUB_TOKEN:-}" ]; then
  # Wire gh as the git credential helper for github.com HTTPS. Idempotent.
  gh auth setup-git 2>/dev/null || true
fi

# --- required secret check ------------------------------------------------
# Accept any of the supported provider keys — the gateway only needs one to be
# able to run the primary/fallback chain configured in docker/config.json.
have_key=
for v in \
  ANTHROPIC_API_KEY \
  OPENAI_API_KEY \
  OPENROUTER_API_KEY \
  GOOGLE_API_KEY \
  GROQ_API_KEY \
  DEEPSEEK_API_KEY \
  XAI_API_KEY \
  TOGETHER_API_KEY \
  MISTRAL_API_KEY \
  PPLX_API_KEY \
  FIREWORKS_API_KEY \
  CEREBRAS_API_KEY \
  COHERE_API_KEY \
  SAMBANOVA_API_KEY \
  NOVITA_API_KEY \
  HYPERBOLIC_API_KEY \
  LAMBDA_API_KEY \
  ZAI_API_KEY \
  MINIMAX_API_KEY \
  KIMI_API_KEY \
  OPENCODE_API_KEY; do
  eval "val=\${$v:-}"
  if [ -n "$val" ]; then have_key=1; break; fi
done
if [ -z "$have_key" ]; then
  echo "no LLM provider key set. Run 'squad onboard' to configure one." >&2
  exit 1
fi

exec "$@"
