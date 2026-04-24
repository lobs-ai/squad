import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { hostname, userInfo } from "node:os";

/**
 * Locate the squad repo (docker/data is bind-mounted into the container, so
 * keys written there become available at /app/docker/data/ssh/ in the gateway).
 */
function findRepoRoot(): string {
  let dir = resolve(process.env.SQUAD_REPO ?? process.cwd());
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "can't locate the squad repo. Set SQUAD_REPO=/path/to/squad or run from inside it.",
  );
}

function sshDir(): string {
  const dir = join(findRepoRoot(), "docker", "data", "ssh");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort.
  }
  return dir;
}

function keyPaths(label: string): { priv: string; pub: string } {
  const base = join(sshDir(), label);
  return { priv: base, pub: `${base}.pub` };
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => resolveP(code ?? 0));
  });
}

export async function generateKey(opts: {
  label?: string;
  type?: string;
  force?: boolean;
  comment?: string;
}): Promise<void> {
  const label = opts.label ?? "id_ed25519";
  const type = opts.type ?? "ed25519";
  const { priv, pub } = keyPaths(label);

  if (existsSync(priv) && !opts.force) {
    process.stdout.write(
      `key already exists: ${priv}\n` +
        `use 'squad key show' to print the public key, or pass --force to overwrite.\n`,
    );
    return;
  }

  if (existsSync(priv)) {
    rmSync(priv);
    rmSync(pub, { force: true });
  }

  const comment =
    opts.comment ?? `squad@${userInfo().username}@${hostname()}`;

  const code = await run("ssh-keygen", [
    "-t", type,
    "-f", priv,
    "-N", "", // no passphrase — agents can't type one
    "-C", comment,
    "-q",
  ]);
  if (code !== 0) {
    throw new Error(`ssh-keygen exited with code ${code}`);
  }

  try {
    chmodSync(priv, 0o600);
    chmodSync(pub, 0o644);
  } catch {
    // Best effort.
  }

  process.stdout.write(`\n✓ generated ${priv}\n`);
  process.stdout.write(`  public key (paste into GitHub → Settings → SSH keys):\n\n`);
  process.stdout.write(readFileSync(pub, "utf8"));
  process.stdout.write(
    `\n  GitHub: https://github.com/settings/ssh/new\n`,
  );
}

export async function showKey(opts: { label?: string; path?: boolean }): Promise<void> {
  const label = opts.label ?? "id_ed25519";
  const { priv, pub } = keyPaths(label);
  if (!existsSync(pub)) {
    throw new Error(
      `no key at ${pub}. Run 'squad key new' to generate one.`,
    );
  }
  if (opts.path) {
    process.stdout.write(`private: ${priv}\npublic:  ${pub}\n`);
    return;
  }
  process.stdout.write(readFileSync(pub, "utf8"));
}

export async function listKeys(): Promise<void> {
  const dir = sshDir();
  const { readdirSync } = await import("node:fs");
  const entries = readdirSync(dir).filter((f) => f.endsWith(".pub"));
  if (!entries.length) {
    process.stdout.write(`no keys in ${dir}\n`);
    process.stdout.write(`run 'squad key new' to generate one.\n`);
    return;
  }
  for (const f of entries) {
    const label = f.replace(/\.pub$/, "");
    const content = readFileSync(join(dir, f), "utf8").trim();
    const fingerprint = content.split(/\s+/).slice(0, 2).join(" ");
    process.stdout.write(`${label}  ${fingerprint.slice(0, 60)}…\n`);
  }
}

export async function runWizard(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    process.stdout.write(
      `\nSquad SSH key wizard\n` +
        `Generates a keypair under docker/data/ssh/ so the gateway container and\n` +
        `any agents can git-push on your behalf. Private key stays on disk; you\n` +
        `paste the public key into GitHub once.\n\n`,
    );

    const label =
      (await rl.question(`Key label [id_ed25519]: `)).trim() || "id_ed25519";
    const type =
      (await rl.question(`Key type [ed25519]: `)).trim() || "ed25519";

    const { priv } = keyPaths(label);
    let force = false;
    if (existsSync(priv)) {
      const answer = (await rl.question(
        `${priv} already exists. Overwrite? [y/N] `,
      ))
        .trim()
        .toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        process.stdout.write(`keeping existing key. 'squad key show' to print it.\n`);
        return;
      }
      force = true;
    }

    await generateKey({ label, type, force });

    process.stdout.write(
      `\nNext: open https://github.com/settings/ssh/new, paste the key above,\n` +
        `give it a title, and hit Add SSH key.\n\n`,
    );
    const verify = (await rl.question(`Test the key against GitHub now? [Y/n] `))
      .trim()
      .toLowerCase();
    if (verify === "" || verify === "y" || verify === "yes") {
      await testKey(label);
    }
  } finally {
    rl.close();
  }
}

export async function testKey(label = "id_ed25519"): Promise<void> {
  const { priv } = keyPaths(label);
  if (!existsSync(priv)) {
    throw new Error(`no key at ${priv}`);
  }
  process.stdout.write(`→ ssh -T -i ${priv} git@github.com\n`);
  await run("ssh", [
    "-T",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "IdentitiesOnly=yes",
    "-i", priv,
    "git@github.com",
  ]);
  // GitHub's auth success exits with code 1 + the greeting on stderr — can't
  // trust the code here, so we just let the user read the output.
}

export async function removeKey(label = "id_ed25519"): Promise<void> {
  const { priv, pub } = keyPaths(label);
  if (existsSync(priv)) rmSync(priv);
  if (existsSync(pub)) rmSync(pub);
  process.stdout.write(`✓ removed ${label}\n`);
}
