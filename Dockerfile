# ---- build stage ----
FROM node:20-bookworm-slim AS build

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages

RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile=false

RUN pnpm -r build

# ---- runtime stage ----
FROM node:20-bookworm-slim AS runtime

RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

WORKDIR /app

COPY --from=build /app /app

RUN mkdir -p /app/data

EXPOSE 8080

# Fail fast if essential secrets are missing.
CMD ["sh", "-c", "[ -n \"$ANTHROPIC_API_KEY\" ] || { echo 'ANTHROPIC_API_KEY is required' >&2; exit 1; }; exec pnpm --filter @squad/gateway start"]
