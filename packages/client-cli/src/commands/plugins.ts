import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ProtocolClient } from "../protocol-client.js";
import { resolveEnv } from "../env.js";
import * as render from "../render.js";
import { color, fg } from "../ui/colors.js";
import { roleColor } from "../ui/skin.js";

async function withClient<T>(fn: (c: ProtocolClient) => Promise<T>): Promise<T> {
  const env = resolveEnv();
  const client = new ProtocolClient({ url: env.url, token: env.token });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * List the preinstalled plugin catalog with installed/loaded status.
 *
 * The CLI shows three states because they can disagree:
 *   - on  : installed in config + loaded in the running gateway
 *   - off : not installed
 *   - !   : installed but failed to load (or pending reload)
 */
export async function listPlugins(): Promise<void> {
  await withClient(async (client) => {
    const { entries } = await client.request("plugins.catalog", {});
    if (entries.length === 0) {
      render.renderInfo("(no preinstalled plugins available)");
      return;
    }
    const ok = fg(roleColor("ok"));
    const muted = fg(roleColor("muted"));
    const errColor = fg(roleColor("err"));

    render.renderHeader("Preinstalled plugins");
    for (const e of entries) {
      const mark = e.installed
        ? e.loaded
          ? color("●", ok)
          : color("●", errColor)
        : color("○", muted);
      const status = e.installed
        ? e.loaded
          ? color("on", ok)
          : color("install error", errColor)
        : color("off", muted);
      const kinds = color(`(${e.kinds.join(", ")})`, muted);
      process.stdout.write(
        `  ${mark} ${e.id.padEnd(34)} ${status.padEnd(20)} ${kinds}\n`,
      );
      process.stdout.write(`    ${color(e.description, muted)}\n`);
    }
    process.stdout.write("\n");
    process.stdout.write(
      `  ${color("install:", muted)} squad plugins install <id>  ${color("·", muted)}  ${color("uninstall:", muted)} squad plugins uninstall <id>\n\n`,
    );
  });
}

/**
 * Install a plugin by catalog id. Calls `plugins.describe` first, prompts
 * for any required fields, then sends `plugins.install` with the resulting
 * config. Secrets-with-autoGenerate accept blank input — the gateway fills
 * those in.
 *
 * `--yes` skips the prompt loop entirely (useful for scripts), accepting
 * defaults and auto-generating any secrets.
 */
export async function installPlugin(
  id: string | undefined,
  opts: { yes?: boolean } = {},
): Promise<void> {
  if (!id) throw new Error("usage: squad plugins install <id> [--yes]");
  await withClient(async (client) => {
    const desc = await client.request("plugins.describe", { id });
    const config: Record<string, unknown> = {};
    const accent = fg(roleColor("accent"));
    const muted = fg(roleColor("muted"));

    const secrets: Record<string, string> = {};

    const needsConfigInput = desc.fields.length > 0 && !opts.yes;
    const needsSecretInput =
      (desc.secrets ?? []).some((s) => s.required && !s.set) && !opts.yes;

    if (needsConfigInput || needsSecretInput) {
      process.stdout.write(`\n  ${color("configure", accent)} ${desc.name}\n`);
      if (desc.description) process.stdout.write(`  ${color(desc.description, muted)}\n`);
      if (desc.needsAuthToken)
        process.stdout.write(
          `  ${color("(install will create a matching auth.tokens entry)", muted)}\n`,
        );
      process.stdout.write("\n");

      const rl = createInterface({ input: stdin, output: stdout });
      try {
        if (needsConfigInput) {
          for (const f of desc.fields) {
            const cur =
              desc.currentConfig?.[f.name] ?? desc.defaultConfig[f.name] ?? f.default;
            const hint = [
              f.description ? `\n      ${color(f.description, muted)}` : "",
              f.options ? `\n      ${color(`options: ${f.options.join(", ")}`, muted)}` : "",
            ].join("");
            const defaultDisplay =
              cur !== undefined
                ? typeof cur === "string"
                  ? cur
                  : JSON.stringify(cur)
                : "";
            const prompt =
              `  ${color(f.name, accent)}` +
              (f.required ? color(" *", fg(roleColor("err"))) : "") +
              (defaultDisplay ? color(` [${defaultDisplay}]`, muted) : "") +
              hint +
              "\n  > ";
            const answer = (await rl.question(prompt)).trim();
            if (answer === "") {
              if (cur !== undefined) config[f.name] = cur;
              continue;
            }
            config[f.name] = coerceField(f, answer);
          }
        }

        if ((desc.secrets ?? []).length > 0) {
          process.stdout.write(
            `\n  ${color("secrets", accent)} ${color("(stored locally, mode 0600 — never written to config.json)", muted)}\n\n`,
          );
          for (const s of desc.secrets) {
            const label = s.label ?? s.envVar;
            const required = s.required ? color(" *", fg(roleColor("err"))) : "";
            const setHint = s.set ? color(" [set — leave blank to keep]", muted) : "";
            const hintLine = s.hint ? `\n      ${color(s.hint, muted)}` : "";
            const envLine = `\n      ${color(`stored as $${s.envVar}`, muted)}`;
            const prompt =
              `  ${color(label, accent)}${required}${setHint}${hintLine}${envLine}\n  > `;
            const answer = (await readSecret(rl, prompt)).trim();
            if (answer === "") continue;
            secrets[s.envVar] = answer;
          }
        }
      } finally {
        rl.close();
      }
    }

    try {
      const { plugin } = await client.request("plugins.install", {
        id,
        config,
        ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
      });
      render.renderSuccess(`installed ${plugin.name} (${plugin.id} v${plugin.version})`);
    } catch (e) {
      formatInstallError(e);
      process.exitCode = 1;
    }
  });
}

/**
 * Read input from the user without echoing it to the terminal — used for
 * secret prompts. Falls back to plain `rl.question` when stdin isn't a TTY
 * (CI, piped input) so non-interactive flows still work.
 */
async function readSecret(
  rl: import("node:readline/promises").Interface,
  promptText: string,
): Promise<string> {
  if (!stdin.isTTY) return rl.question(promptText);
  process.stdout.write(promptText);
  return new Promise<string>((resolve) => {
    let buf = "";
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") {
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (ch === "") {
          // Ctrl-C
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.exit(130);
        }
        if (ch === "" || ch === "\b") {
          // Backspace
          if (buf.length > 0) buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Spin up a setup chat for a plugin, fire the briefing as the first
 * message (so the agent starts streaming a reply right away), and print a
 * resume hint. Doesn't auto-launch `squad repl` — the user might prefer
 * the dashboard.
 */
export async function setupPlugin(id: string | undefined): Promise<void> {
  if (!id) throw new Error("usage: squad plugins setup <id>");
  await withClient(async (client) => {
    const { sessionId, seedMessage } = await client.request(
      "plugins.start_setup_chat",
      { id },
    );
    // Fire the briefing through chat.send from this connection — same
    // path as a manually-typed message, so any error broadcasts back
    // through the same channels and the agent's reply lands in history
    // for the next `squad repl --resume`.
    try {
      await client.request("chat.send", { sessionId, content: seedMessage });
    } catch (err) {
      const errColor = fg(roleColor("err"));
      process.stdout.write(
        `  ${color("warning:", errColor)} setup chat opened but the briefing didn't auto-send: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    const accent = fg(roleColor("accent"));
    const muted = fg(roleColor("muted"));
    render.renderSuccess(`started setup chat for ${id}`);
    process.stdout.write(`\n  ${color("session:", muted)} ${color(sessionId, accent)}\n`);
    process.stdout.write(
      `  ${color("resume:", muted)} ${color(`squad repl --resume ${sessionId}`, accent)}\n`,
    );
    process.stdout.write(
      `  ${color("(or open it in the dashboard chat view)", muted)}\n\n`,
    );
  });
}

export async function uninstallPlugin(id: string | undefined): Promise<void> {
  if (!id) throw new Error("usage: squad plugins uninstall <id>");
  await withClient(async (client) => {
    const { id: removed } = await client.request("plugins.uninstall", { id });
    render.renderSuccess(`uninstalled ${removed}`);
  });
}

/**
 * Describe-only command: dump the configure form for a plugin without
 * installing. Handy when scripting `squad plugins install --yes` to know
 * what env vars the user needs to set first.
 */
export async function describePlugin(id: string | undefined): Promise<void> {
  if (!id) throw new Error("usage: squad plugins describe <id>");
  await withClient(async (client) => {
    const desc = await client.request("plugins.describe", { id });
    const accent = fg(roleColor("accent"));
    const muted = fg(roleColor("muted"));
    render.renderHeader(`${desc.name} (${desc.id})`);
    if (desc.description) process.stdout.write(`  ${color(desc.description, muted)}\n`);
    if (desc.needsAuthToken)
      process.stdout.write(
        `  ${color("→ install creates an auth.tokens entry", muted)}\n`,
      );
    process.stdout.write("\n");
    if (desc.fields.length === 0) {
      process.stdout.write(
        `  ${color("(no configuration — install with `squad plugins install <id>`)", muted)}\n\n`,
      );
      return;
    }
    for (const f of desc.fields) {
      const tags: string[] = [f.kind];
      if (f.required && !f.secret) tags.push("required");
      if (f.secret) tags.push("secret");
      if (f.envRef) tags.push("env-var-name");
      const dflt = f.default !== undefined ? `  default=${JSON.stringify(f.default)}` : "";
      process.stdout.write(
        `  ${color(f.name, accent)}  ${color("[" + tags.join(", ") + "]", muted)}${color(dflt, muted)}\n`,
      );
      if (f.description) process.stdout.write(`    ${color(f.description, muted)}\n`);
      if (f.options)
        process.stdout.write(`    ${color("options: " + f.options.join(", "), muted)}\n`);
    }
    process.stdout.write("\n");
  });
}

// ── Back-compat wrappers ────────────────────────────────────────────────────
//
// Pre-feature CLI used `enable`/`disable` for the install/uninstall flow
// (without prompting). Keep them so existing scripts keep working — they
// just delegate to the new commands with --yes so they stay non-interactive.

export async function enablePlugin(id: string | undefined): Promise<void> {
  return installPlugin(id, { yes: true });
}

export async function disablePlugin(id: string | undefined): Promise<void> {
  return uninstallPlugin(id);
}

// ── Internals ────────────────────────────────────────────────────────────

interface RpcLikeError {
  code?: string;
  message?: string;
  data?: { code?: string; field?: string; envVar?: string; hint?: string };
}

function formatInstallError(e: unknown): void {
  const err = e as RpcLikeError;
  const msg = err.message ?? String(e);
  const errColor = fg(roleColor("err"));
  const muted = fg(roleColor("muted"));
  process.stdout.write(`  ${color("install failed:", errColor)} ${msg}\n`);
  if (err.data?.code === "missing_config" && err.data.field) {
    process.stdout.write(
      `  ${color(`field "${err.data.field}" is required`, muted)}` +
        (err.data.envVar ? color(` — set env ${err.data.envVar}`, muted) : "") +
        "\n",
    );
    if (err.data.hint) process.stdout.write(`  ${color(err.data.hint, muted)}\n`);
  }
}

function coerceField(
  field: import("@squad/protocol").PluginConfigFieldDescription,
  raw: string,
): unknown {
  switch (field.kind) {
    case "string":
    case "enum":
      return raw;
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      return raw === "true" || raw === "yes" || raw === "1";
    case "array":
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        // For arrays specifically, accept comma-separated bare strings as a
        // friendlier fallback. The schema validator on the gateway will
        // catch anything still malformed.
        if (field.kind === "array") return raw.split(",").map((s) => s.trim()).filter(Boolean);
        return raw;
      }
    default:
      return raw;
  }
}
