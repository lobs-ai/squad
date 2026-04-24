# ---- build stage ----
FROM node:25-bookworm-slim AS build

# better-sqlite3 has no Node 25 prebuilt binary yet, so it compiles from
# source during `pnpm install` — needs python3 + a C++ toolchain.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9.0.0

WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

RUN pnpm -r build

# ---- runtime stage ----
FROM node:25-bookworm-slim AS runtime

RUN npm install -g pnpm@9.0.0

# git + openssh for agent-driven clone/push; gh CLI for GitHub API + as git's
# HTTPS credential helper (wired by docker/entrypoint.sh when GITHUB_TOKEN set).
# ripgrep powers the code_search tool.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      ca-certificates \
      curl \
      gnupg \
      ripgrep \
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

COPY --from=build /app /app

# Playwright Chromium (+ system deps) for web_search / web_fetch / html_to_pdf /
# html_check. Browsers live in a system path so they survive volume mounts over
# /root. --with-deps installs the required shared libs via apt.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm --filter @squad/tools exec playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

# Bind-mount target for host-side state (config.json, .env, sqlite, uploads, ssh).
# Owned by /app's user; docker-compose mounts ./docker over the top.
RUN mkdir -p /app/docker/data/ssh

COPY docker/entrypoint.sh /usr/local/bin/squad-entrypoint
RUN chmod +x /usr/local/bin/squad-entrypoint

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/squad-entrypoint"]
CMD ["pnpm", "--filter", "@squad/gateway", "start"]
