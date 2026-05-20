import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProviderConfig, buildCodexAuthService } from "./llm-config.js";

describe("resolveProviderConfig", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    // Wipe every relevant key so a real ANTHROPIC_API_KEY in dev doesn't
    // bleed into the tests.
    for (const k of Object.keys(process.env)) {
      if (k.endsWith("_API_KEY")) delete process.env[k];
    }
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.OPENAI_CODEX_REFRESH_TOKEN;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("returns empty results when no providers are configured", () => {
    const r = resolveProviderConfig({});
    expect(r.resolved).toEqual([]);
    expect(r.missingKeys).toEqual([]);
    expect(r.clientConfig.keys).toEqual({});
  });

  it("uses literal api_key when provided", () => {
    const r = resolveProviderConfig({ minimax: { api_key: "sk-test" } });
    expect(r.resolved).toEqual(["minimax"]);
    expect(r.clientConfig.keys?.minimax?.keys[0]?.key).toBe("sk-test");
    expect(r.missingKeys).toEqual([]);
  });

  it("falls back to api_key_env when literal api_key is missing", () => {
    process.env["MY_CUSTOM_KEY"] = "sk-from-env";
    const r = resolveProviderConfig({ minimax: { api_key_env: "MY_CUSTOM_KEY" } });
    expect(r.resolved).toEqual(["minimax"]);
    expect(r.clientConfig.keys?.minimax?.keys[0]?.key).toBe("sk-from-env");
  });

  it("falls back to the standard env var when neither is provided", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-claude";
    const r = resolveProviderConfig({ anthropic: {} });
    expect(r.resolved).toEqual(["anthropic"]);
    expect(r.clientConfig.keys?.anthropic?.keys[0]?.key).toBe("sk-claude");
  });

  it("flags providers configured but with no resolvable key", () => {
    const r = resolveProviderConfig({ minimax: {}, openai: {} });
    expect(r.resolved).toEqual([]);
    expect(r.missingKeys.map((m) => m.provider).sort()).toEqual(["minimax", "openai"]);
    expect(r.missingKeys[0]?.envVar).toMatch(/_API_KEY$/);
  });

  it("threads base_url into clientConfig.baseUrls", () => {
    const r = resolveProviderConfig({
      minimax: { api_key: "sk", base_url: "https://api.minimaxi.chat/v1" },
    });
    expect(r.clientConfig.baseUrls?.minimax).toBe("https://api.minimaxi.chat/v1");
  });

  it("treats local providers as resolved without a key", () => {
    const r = resolveProviderConfig({ ollama: { base_url: "http://localhost:11434/v1" } });
    expect(r.resolved).toEqual(["ollama"]);
    expect(r.missingKeys).toEqual([]);
  });

  it("synthesizes an env var name for unknown providers", () => {
    const r = resolveProviderConfig({ "weirdo-net": {} });
    expect(r.missingKeys[0]?.envVar).toBe("WEIRDO_NET_API_KEY");
  });

  it("resolves claude-cli from CLAUDE_CODE_OAUTH_TOKEN by default", () => {
    process.env["CLAUDE_CODE_OAUTH_TOKEN"] = "oauth-default";
    const r = resolveProviderConfig({ "claude-cli": {} });
    expect(r.resolved).toEqual(["claude-cli"]);
    expect(r.clientConfig.keys?.["claude-cli"]?.keys[0]?.key).toBe("oauth-default");
    expect(r.missingKeys).toEqual([]);
  });

  it("resolves claude-cli from a custom oauth_token_env", () => {
    process.env["MY_CLAUDE_TOKEN"] = "oauth-custom";
    const r = resolveProviderConfig({
      "claude-cli": { oauth_token_env: "MY_CLAUDE_TOKEN" },
    });
    expect(r.clientConfig.keys?.["claude-cli"]?.keys[0]?.key).toBe("oauth-custom");
  });

  it("resolves claude-cli from a literal oauth_token", () => {
    const r = resolveProviderConfig({
      "claude-cli": { oauth_token: "oauth-literal" },
    });
    expect(r.clientConfig.keys?.["claude-cli"]?.keys[0]?.key).toBe("oauth-literal");
  });

  it("flags claude-cli with a setup-token hint when the token is missing", () => {
    const r = resolveProviderConfig({ "claude-cli": {} });
    expect(r.resolved).toEqual([]);
    expect(r.missingKeys[0]?.provider).toBe("claude-cli");
    expect(r.missingKeys[0]?.envVar).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(r.missingKeys[0]?.reason).toMatch(/claude setup-token/);
  });

  // ── openai-codex ────────────────────────────────────────────────────────

  it("resolves openai-codex from OPENAI_CODEX_REFRESH_TOKEN by default", () => {
    process.env["OPENAI_CODEX_REFRESH_TOKEN"] = "rt_default";
    const r = resolveProviderConfig({ "openai-codex": {} });
    expect(r.resolved).toEqual(["openai-codex"]);
    expect(r.missingKeys).toEqual([]);
    // The refresh token is NOT put into the keys pool — it travels via
    // providerOptions on the live CodexAuthService instead.
    expect(r.clientConfig.keys?.["openai-codex"]).toBeUndefined();
  });

  it("resolves openai-codex from a custom refresh_token_env", () => {
    process.env["MY_CODEX_TOKEN"] = "rt_custom";
    const r = resolveProviderConfig({
      "openai-codex": { refresh_token_env: "MY_CODEX_TOKEN" },
    });
    expect(r.resolved).toEqual(["openai-codex"]);
  });

  it("flags openai-codex with a codex-auth hint when missing", () => {
    const r = resolveProviderConfig({ "openai-codex": {} });
    expect(r.resolved).toEqual([]);
    expect(r.missingKeys[0]?.provider).toBe("openai-codex");
    expect(r.missingKeys[0]?.envVar).toBe("OPENAI_CODEX_REFRESH_TOKEN");
    expect(r.missingKeys[0]?.reason).toMatch(/squad codex-auth login/);
  });
});

describe("buildCodexAuthService", () => {
  const savedEnv = { ...process.env };
  let tmp: string;
  beforeEach(() => {
    delete process.env.OPENAI_CODEX_REFRESH_TOKEN;
    tmp = mkdtempSync(join(tmpdir(), "codex-cfg-"));
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when no refresh token is configured", () => {
    expect(buildCodexAuthService({}, tmp)).toBeNull();
  });

  it("returns null when given undefined", () => {
    expect(buildCodexAuthService(undefined, tmp)).toBeNull();
  });

  it("constructs a service with the default cache path under data_dir", () => {
    const svc = buildCodexAuthService({ refresh_token: "rt_lit" }, tmp);
    expect(svc).not.toBeNull();
    expect(svc!.credsPath).toBe(join(tmp, "codex-creds.json"));
  });

  it("resolves a relative creds_path against data_dir", () => {
    const svc = buildCodexAuthService(
      { refresh_token: "rt_lit", creds_path: "subdir/creds.json" },
      tmp,
    );
    expect(svc!.credsPath).toBe(join(tmp, "subdir/creds.json"));
  });

  it("honours an absolute creds_path verbatim", () => {
    const abs = join(tmp, "elsewhere", "creds.json");
    const svc = buildCodexAuthService(
      { refresh_token: "rt_lit", creds_path: abs },
      "/should/be/ignored",
    );
    expect(svc!.credsPath).toBe(abs);
  });
});
