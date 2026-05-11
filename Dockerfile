# ---- build stage ----
FROM node:25-bookworm-slim AS build

# better-sqlite3 has no Node 25 prebuilt binary yet, so it compiles from
# source during `pnpm install` — needs python3 + a C++ toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.0.0

WORKDIR /app

# Copy only the files that affect dependency resolution first. This lets the
# `pnpm install` layer cache survive any source edit — it only invalidates
# when a package.json or the lockfile actually changes.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages/channel-discord/package.json        packages/channel-discord/package.json
COPY packages/channel-sdk/package.json            packages/channel-sdk/package.json
COPY packages/channel-slack/package.json          packages/channel-slack/package.json
COPY packages/client-cli/package.json             packages/client-cli/package.json
COPY packages/dashboard/package.json              packages/dashboard/package.json
COPY packages/gateway/package.json                packages/gateway/package.json
COPY packages/llm/package.json                    packages/llm/package.json
COPY packages/memcore/package.json                packages/memcore/package.json
COPY packages/plugin-gmail/package.json           packages/plugin-gmail/package.json
COPY packages/plugin-google-auth/package.json     packages/plugin-google-auth/package.json
COPY packages/plugin-google-calendar/package.json packages/plugin-google-calendar/package.json
COPY packages/plugin-google-drive/package.json    packages/plugin-google-drive/package.json
COPY packages/plugin-sdk/package.json             packages/plugin-sdk/package.json
COPY packages/plugin-test/package.json            packages/plugin-test/package.json
COPY packages/protocol/package.json               packages/protocol/package.json
COPY packages/runner/package.json                 packages/runner/package.json
COPY packages/tools/package.json                  packages/tools/package.json

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Now bring in the actual sources. Edits here re-run `pnpm -r build` but do
# NOT re-run `pnpm install` (different layer).
COPY packages ./packages
# Agent-facing documentation: read by the running agent when it needs to know
# how Squad itself works. Pointed at by the system prompt in agent-prompt.ts.
COPY docs ./docs

RUN pnpm -r build

# Pre-fetch the Playwright browser into the build stage so the runtime stage
# can copy a fixed directory rather than re-running the download whenever
# upstream layers change. System libs are still installed in runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @squad/tools exec playwright install chromium

# ---- runtime stage ----
FROM node:25-bookworm-slim AS runtime

RUN npm install -g pnpm@9.0.0

# git + openssh for agent-driven clone/push; gh CLI for GitHub API + as git's
# HTTPS credential helper (wired by scripts/entrypoint.sh when GITHUB_TOKEN set).
# ripgrep powers the code_search tool. Playwright's Chromium needs a pile of
# shared libs (fonts, X11, NSS, etc.) — we install them explicitly here so the
# build-stage `playwright install` doesn't have to.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      ca-certificates \
      curl \
      gnupg \
      ripgrep \
      fonts-liberation \
      libasound2 \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libatspi2.0-0 \
      libcairo2 \
      libcups2 \
      libdbus-1-3 \
      libdrm2 \
      libgbm1 \
      libglib2.0-0 \
      libnspr4 \
      libnss3 \
      libpango-1.0-0 \
      libx11-6 \
      libxcb1 \
      libxcomposite1 \
      libxdamage1 \
      libxext6 \
      libxfixes3 \
      libxkbcommon0 \
      libxrandr2 \
      xdg-utils \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y --auto-remove gnupg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Claude Code CLI — used by the `claude-cli` LLM provider to call Anthropic
# models via OAuth. Auth comes in at runtime via CLAUDE_CODE_OAUTH_TOKEN
# (produced by `claude setup-token` on a machine with browser access); no
# credentials are baked into the image.
RUN npm install -g @anthropic-ai/claude-code

COPY --from=build /app /app
COPY --from=build /ms-playwright /ms-playwright
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Bind-mount target for host-side state (config.json, .env, sqlite, uploads, ssh).
# `squad mgr` mounts ~/.squad/squads/<name>/ over the top at runtime.
RUN mkdir -p /app/docker/data/ssh

COPY scripts/entrypoint.sh /usr/local/bin/squad-entrypoint
RUN chmod +x /usr/local/bin/squad-entrypoint

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/squad-entrypoint"]
CMD ["pnpm", "--filter", "@squad/gateway", "start"]
