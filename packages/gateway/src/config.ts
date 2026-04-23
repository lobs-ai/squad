import { readFileSync } from "node:fs";
import { z } from "zod";
import { parse as parseYaml } from "yaml";

const authTokenSchema = z.object({
  label: z.string(),
  key_env: z.string().optional(),
  key: z.string().optional(),
  scopes: z.array(z.string()).default(["*"]),
});

const providerConfigSchema = z.object({
  api_key_env: z.string().optional(),
  api_key: z.string().optional(),
  base_url: z.string().optional(),
});

export const configSchema = z.object({
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().positive().default(8080),
      data_dir: z.string().default("./data"),
    })
    .default({}),
  auth: z
    .object({
      tokens: z.array(authTokenSchema).default([]),
    })
    .default({ tokens: [] }),
  llm: z
    .object({
      default_model: z.string().default("claude-sonnet-4-5"),
      providers: z.record(providerConfigSchema).default({}),
    })
    .default({ default_model: "claude-sonnet-4-5", providers: {} }),
  subagents: z
    .object({
      max_concurrent_global: z.number().int().positive().default(8),
      max_concurrent_per_parent: z.number().int().positive().default(4),
      max_tree_depth: z.number().int().positive().default(3),
    })
    .default({}),
  policy: z
    .object({
      approvals: z
        .object({
          default: z.enum(["tag-match", "allow-all", "deny-all"]).default("tag-match"),
          require_for_tags: z.array(z.string()).default(["write", "exec", "network"]),
          timeout_seconds: z.number().int().positive().default(120),
        })
        .default({}),
    })
    .default({}),
  plugins: z.array(z.string()).default([]),
  channels: z.record(z.unknown()).default({}),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(path: string | undefined): Config {
  if (!path) return configSchema.parse({});
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw);
  return configSchema.parse(parsed ?? {});
}

/**
 * Resolve every auth token's actual secret value. Tokens configured with
 * `key_env` read from the environment; tokens with literal `key` are used
 * as-is. Throws if a configured env var is unset.
 */
export function resolveTokenSecrets(config: Config): Array<{
  label: string;
  secret: string;
  scopes: string[];
}> {
  return config.auth.tokens.map((t) => {
    const secret = t.key ?? (t.key_env ? process.env[t.key_env] : undefined);
    if (!secret) {
      throw new Error(
        `Auth token "${t.label}" has no secret (set config.auth.tokens[].key or the ${t.key_env} env var)`,
      );
    }
    return { label: t.label, secret, scopes: t.scopes };
  });
}
