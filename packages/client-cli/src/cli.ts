#!/usr/bin/env node
import * as render from "./render.js";
import { runRepl } from "./commands/repl.js";
import { runChat } from "./commands/chat.js";
import { listSessions, newSession, renameSession, sessionTree } from "./commands/sessions.js";
import { listTasks } from "./commands/tasks.js";
import { answerQuestion, listQuestions } from "./commands/ask.js";
import { showStatus } from "./commands/status.js";
import {
  startGateway,
  stopGateway,
  restartGateway,
  gatewayLogs,
  runOnboard,
  runUpdate,
} from "./commands/lifecycle.js";
import { runMgr } from "./commands/mgr.js";
import { runTerminal } from "./commands/terminal.js";
import { runPair, runUnpair, runPairList } from "./commands/pair.js";
import {
  runPairBrowserApprove,
  runPairBrowserList,
  runPairBrowserCancel,
} from "./commands/pair-browser.js";
import {
  generateKey,
  showKey,
  listKeys,
  removeKey,
  runWizard as runKeyWizard,
  testKey,
} from "./commands/key.js";
import {
  listPlugins,
  enablePlugin,
  disablePlugin,
  installPlugin,
  uninstallPlugin,
  describePlugin,
  setupPlugin,
} from "./commands/plugins.js";
import { runTail } from "./commands/tail.js";
import type { LogLevel } from "@squad/protocol";
import { printCompactHeader, currentVersion } from "./ui/banner.js";
import { C, color, fg } from "./ui/colors.js";
import { roleColor } from "./ui/skin.js";

function helpText(): string {
  const accent = fg(roleColor("accent"));
  const muted = fg(roleColor("muted"));
  const brand = fg(roleColor("brand"));
  const H = (s: string) => `${C.BOLD}${accent}${s}${C.RESET}`;
  const K = (s: string) => `${brand}${s}${C.RESET}`;
  const D = (s: string) => `${muted}${s}${C.RESET}`;
  return [
    "",
    `  ${H("Usage")}  ${K("squad")} ${D("<command>")} ${D("[args]")}`,
    "",
    `  ${H("Lifecycle")}`,
    `    ${K("onboard")} ${D("[--force|--yes] [--squad <name>]")}  ${D("setup wizard (creates a squad)")}`,
    `    ${K("start")}                       ${D("docker compose up every registered squad")}`,
    `    ${K("stop")}                        ${D("docker compose stop every registered squad")}`,
    `    ${K("restart")}                     ${D("full stop + start cycle for every registered squad")}`,
    `    ${K("status")}                      ${D("current squad's gateway liveness + session")}`,
    `    ${K("logs")}    ${D("[-f]")}                 ${D("tail current squad's docker logs")}`,
    `    ${K("tail")}    ${D("[-f] [--level X] [--source Y] [-n N] [--grep q]")}  ${D("live in-process gateway logs")}`,
    `    ${K("terminal")} ${D("[name] [-- cmd ...]")} ${D("interactive shell in the squad container")}`,
    `    ${K("update")}  ${D("[--check] [--force]")}  ${D("git pull squad source + rebuild + relink")}`,
    "",
    `  ${H("Multi-squad")} ${D("— manage multiple squad containers from one host")}`,
    `    ${K("mgr")}     ${D("<subcommand>")}         ${D("create/start/stop/ls squads (try: squad mgr help)")}`,
    `    ${D("--squad <name>")}              ${D("target a specific squad for any command")}`,
    "",
    `  ${H("Chat")}`,
    `    ${K("repl")}    ${D("[--resume]")}           ${D("interactive REPL (default)")}`,
    `    ${K("chat")}    ${D("<message>")}            ${D("one-shot: send, stream reply, exit")}`,
    "",
    `  ${H("Sessions · Tasks · Questions")}`,
    `    ${K("sessions")}        ${D("[--all] [--search q]  list recent sessions")}`,
    `    ${K("sessions new")} ${D("[title]")}          ${D("create a new session (becomes current)")}`,
    `    ${K("sessions rename")} ${D("<id> <title>")}  ${D("rename an existing session")}`,
    `    ${K("sessions tree")} ${D("[id]")}            ${D("show parent → subagent hierarchy")}`,
    `    ${K("sessions search")} ${D("<q>")}           ${D("FTS search across session transcripts")}`,
    `    ${K("search")} ${D("<q>")}                    ${D("alias of sessions search")}`,
    `    ${K("tasks")}       ${D("[--session <id>]")}  ${D("list tasks in current session")}`,
    `    ${K("questions")}   ${D("[--session <id>]")}  ${D("list open ask-user questions")}`,
    `    ${K("ask")} ${D("<questionId> <answer>")}     ${D("answer a pending question")}`,
    "",
    `  ${H("Channel pairing")} ${D("— who can DM the bot on each channel")}`,
    `    ${K("pair")} ${D("<channel> <user-id>")}      ${D("add a user to the channel's DM allow list")}`,
    `    ${K("unpair")} ${D("<channel> <user-id>")}    ${D("remove a user from the allow list")}`,
    `    ${K("pair list")} ${D("[channel]")}           ${D("show the allow list(s)")}`,
    "",
    `  ${H("Browser pairing")} ${D("— grant a browser tab dashboard access")}`,
    `    ${K("pair browser")} ${D("<code>")}            ${D("approve a code shown in the dashboard's pair screen")}`,
    `    ${K("pair browser list")}             ${D("show pending/approved browser pairings")}`,
    `    ${K("pair browser cancel")} ${D("<code>")}     ${D("revoke a pairing (and its token)")}`,
    "",
    `  ${H("Plugins")} ${D("— preinstalled extensions you can install")}`,
    `    ${K("plugins")} ${D("[ls]")}                  ${D("show preinstalled plugin catalog + on/off state")}`,
    `    ${K("plugins describe")} ${D("<id>")}         ${D("show the configure form for a plugin")}`,
    `    ${K("plugins setup")} ${D("<id>")}            ${D("open a chat where the agent walks you through setup")}`,
    `    ${K("plugins install")} ${D("<id> [--yes]")}  ${D("prompt for required config + secrets, write config.json, load plugin")}`,
    `    ${K("plugins uninstall")} ${D("<id>")}        ${D("remove from config + auth.tokens + secrets, unload")}`,
    "",
    `  ${H("SSH keys")} ${D("— docker/data/ssh/; agents git-push with these")}`,
    `    ${K("key wizard")}                  ${D("interactive generate + paste-to-GitHub")}`,
    `    ${K("key new")} ${D("[--label X] [--type ed25519|rsa] [--force]")}`,
    `    ${K("key show")} ${D("[--label X] [--path]")}  ${D("print the public key")}`,
    `    ${K("key list")}                    ${D("list keys")}`,
    `    ${K("key test")} ${D("[--label X]")}          ${D("ssh -T git@github.com")}`,
    `    ${K("key rm")}   ${D("[--label X]")}          ${D("delete a keypair")}`,
    "",
    `  ${H("Environment")}`,
    `    ${D("SQUAD_NAME    name of squad to target (overridden by --squad)")}`,
    `    ${D("SQUAD_URL     ws://host:8080/ws      explicit override")}`,
    `    ${D("SQUAD_TOKEN   bearer token           explicit override")}`,
    `    ${D("SQUAD_SKIN    default|mono|slate|…  theme (see /skin list in the REPL)")}`,
    `    ${D("NO_COLOR=1                          disable ANSI colors")}`,
    "",
  ].join("\n");
}

function popFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
}

function hasFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // Global --squad <name> applies to every subcommand. Lifted into env so the
  // resolveEnv() chain picks it up regardless of which command runs next.
  const squadFlag = popFlag(argv, "--squad");
  if (squadFlag) process.env.SQUAD_NAME = squadFlag;
  const cmd = argv.shift() ?? "repl";

  switch (cmd) {
    case "help":
    case "--help":
    case "-h":
      printCompactHeader();
      process.stdout.write(helpText());
      return;
    case "--version":
    case "-V":
    case "version":
      process.stdout.write(`squad v${currentVersion()}\n`);
      return;

    case "onboard":
    case "setup":
      await runOnboard(argv);
      return;
    case "start":
      await startGateway(argv);
      return;
    case "stop":
      await stopGateway();
      return;
    case "restart":
      await restartGateway(argv);
      return;
    case "status":
      await showStatus();
      return;
    case "logs":
      await gatewayLogs(argv);
      return;
    case "tail": {
      const follow = hasFlag(argv, "-f") || hasFlag(argv, "--follow");
      const levelRaw = popFlag(argv, "--level") ?? "debug";
      const source = popFlag(argv, "--source");
      const query = popFlag(argv, "--grep") ?? popFlag(argv, "-q");
      const limitRaw = popFlag(argv, "-n") ?? popFlag(argv, "--limit") ?? "200";
      const validLevels = ["trace", "debug", "info", "warn", "error", "fatal"];
      if (!validLevels.includes(levelRaw)) {
        throw new Error(`invalid --level: ${levelRaw} (one of ${validLevels.join(", ")})`);
      }
      const limit = Number(limitRaw);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error(`invalid -n: ${limitRaw}`);
      }
      await runTail({
        follow,
        level: levelRaw as LogLevel,
        ...(source ? { source } : {}),
        ...(query ? { query } : {}),
        limit: Math.min(limit, 2000),
      });
      return;
    }
    case "update":
    case "upgrade":
      await runUpdate(argv);
      return;

    case "mgr":
      await runMgr(argv);
      return;

    case "terminal":
    case "shell":
    case "exec":
      await runTerminal(argv);
      return;

    case "repl": {
      const resume = hasFlag(argv, "--resume");
      await runRepl({ resume });
      return;
    }
    case "chat": {
      const session = popFlag(argv, "--session");
      const fresh = hasFlag(argv, "--new");
      const msg = argv.join(" ").trim();
      await runChat(msg, { sessionId: session, newSession: fresh });
      return;
    }

    case "sessions": {
      const sub = argv.shift();
      const all = hasFlag(argv, "--all");
      const search = popFlag(argv, "--search") ?? popFlag(argv, "-s");
      if (!sub || sub === "list") {
        await listSessions({ all, ...(search !== undefined ? { search } : {}) });
        return;
      }
      if (sub === "new") {
        await newSession(argv.join(" ").trim() || undefined);
        return;
      }
      if (sub === "rename") {
        const id = argv.shift();
        const title = argv.join(" ").trim();
        if (!id || !title) throw new Error('usage: squad sessions rename <id> "new title"');
        await renameSession(id, title);
        return;
      }
      if (sub === "tree") {
        await sessionTree(argv.shift());
        return;
      }
      if (sub === "search") {
        const q = argv.join(" ").trim();
        if (!q) throw new Error("usage: squad sessions search <query>");
        await listSessions({ search: q });
        return;
      }
      throw new Error(`unknown: sessions ${sub}`);
    }

    case "search": {
      // Top-level alias for `squad sessions search <query>`. Same backend,
      // shorter to type. Lands as a generic full-text search across every
      // session transcript.
      const q = argv.join(" ").trim();
      if (!q) throw new Error('usage: squad search "<query>"');
      await listSessions({ search: q });
      return;
    }

    case "tasks": {
      const session = popFlag(argv, "--session");
      await listTasks(session);
      return;
    }

    case "questions": {
      const session = popFlag(argv, "--session");
      await listQuestions(session);
      return;
    }

    case "ask": {
      const session = popFlag(argv, "--session");
      const qid = argv.shift();
      const answer = argv.join(" ").trim();
      if (!qid || !answer) throw new Error("usage: squad ask <questionId> <answer>");
      await answerQuestion(qid, answer, session);
      return;
    }

    case "pair": {
      // Sub-dispatch:
      //   squad pair <channel> <user-id>     — Discord-style channel allow list
      //   squad pair list [channel]          — show the channel allow list(s)
      //   squad pair browser <code>          — approve a browser pairing
      //   squad pair browser list            — list browser pairings
      //   squad pair browser cancel <code>   — revoke a browser pairing
      const sub = argv[0];
      if (sub === "browser") {
        argv.shift();
        const action = argv[0];
        if (action === "list" || action === "ls") {
          await runPairBrowserList();
          return;
        }
        if (action === "cancel" || action === "rm") {
          argv.shift();
          await runPairBrowserCancel(argv.shift());
          return;
        }
        // Anything else is treated as the code itself (so `squad pair browser
        // 7F2-4QK` works as the primary affordance the dashboard prints).
        await runPairBrowserApprove(argv.shift());
        return;
      }
      if (sub === "list" || sub === "ls") {
        argv.shift();
        runPairList(argv[0]);
        return;
      }
      const channel = argv.shift();
      const userId = argv.shift();
      runPair(channel, userId);
      return;
    }
    case "unpair": {
      const channel = argv.shift();
      const userId = argv.shift();
      runUnpair(channel, userId);
      return;
    }

    case "plugins":
    case "plugin": {
      const sub = argv.shift() ?? "ls";
      const yes = hasFlag(argv, "--yes") || hasFlag(argv, "-y");
      switch (sub) {
        case "ls":
        case "list":
          await listPlugins();
          return;
        case "describe":
        case "info":
          await describePlugin(argv.shift());
          return;
        case "setup":
          await setupPlugin(argv.shift());
          return;
        case "install":
          await installPlugin(argv.shift(), yes ? { yes: true } : {});
          return;
        case "uninstall":
        case "remove":
        case "rm":
          await uninstallPlugin(argv.shift());
          return;
        case "enable":
        case "on":
          await enablePlugin(argv.shift());
          return;
        case "disable":
        case "off":
          await disablePlugin(argv.shift());
          return;
        default:
          throw new Error(`unknown: plugins ${sub}`);
      }
    }

    case "key": {
      const sub = argv.shift() ?? "wizard";
      const label = popFlag(argv, "--label");
      switch (sub) {
        case "wizard":
          await runKeyWizard();
          return;
        case "new": {
          const type = popFlag(argv, "--type");
          const comment = popFlag(argv, "--comment");
          const force = hasFlag(argv, "--force");
          await generateKey({ label, type, comment, force });
          return;
        }
        case "show": {
          const showPath = hasFlag(argv, "--path");
          await showKey({ label, path: showPath });
          return;
        }
        case "list":
        case "ls":
          await listKeys();
          return;
        case "test":
          await testKey(label);
          return;
        case "rm":
        case "remove":
        case "delete":
          await removeKey(label);
          return;
        default:
          throw new Error(`unknown: key ${sub}`);
      }
    }

    default:
      render.renderError(`unknown command: ${cmd}`);
      process.stderr.write(helpText());
      process.exitCode = 2;
  }
}

/**
 * Detect "the gateway isn't running / is unreachable" and rewrite the error
 * into something actionable. Raw ws/fetch errors are cryptic.
 */
function humanizeConnectError(msg: string): string | null {
  const hay = msg.toLowerCase();
  const looksOffline =
    hay.includes("econnrefused") ||
    hay.includes("unexpected server response") ||
    hay.includes("socket hang up") ||
    hay.includes("enotfound") ||
    hay.includes("etimedout") ||
    hay.includes("not connected");
  if (!looksOffline) return null;
  return (
    `can't reach the gateway (${msg}).\n` +
    `  • is it running?   squad status\n` +
    `  • start it:        squad start\n` +
    `  • wrong url/token? set SQUAD_URL / SQUAD_TOKEN, or re-run squad onboard`
  );
}

main().catch((err) => {
  const raw = err instanceof Error ? err.message : String(err);
  render.renderError(humanizeConnectError(raw) ?? raw);
  process.exitCode = 1;
});
