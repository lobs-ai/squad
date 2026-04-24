#!/usr/bin/env node
import * as render from "./render.js";
import { runRepl } from "./commands/repl.js";
import { runChat } from "./commands/chat.js";
import { listSessions, newSession, renameSession, sessionTree } from "./commands/sessions.js";
import { listTasks } from "./commands/tasks.js";
import { answerQuestion, listQuestions } from "./commands/ask.js";
import { showStatus } from "./commands/status.js";
import { startGateway, stopGateway, gatewayLogs, runOnboard } from "./commands/lifecycle.js";
import {
  generateKey,
  showKey,
  listKeys,
  removeKey,
  runWizard as runKeyWizard,
  testKey,
} from "./commands/key.js";
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
    `    ${K("onboard")} ${D("[--force|--yes]")}      ${D("step-by-step setup wizard (first run)")}`,
    `    ${K("start")}   ${D("[--docker|--local]")}   ${D("start the gateway in the background")}`,
    `    ${K("stop")}                        ${D("stop the gateway")}`,
    `    ${K("status")}                      ${D("gateway liveness + current session")}`,
    `    ${K("logs")}    ${D("[-f]")}                 ${D("tail gateway logs")}`,
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
    `    ${K("tasks")}       ${D("[--session <id>]")}  ${D("list tasks in current session")}`,
    `    ${K("questions")}   ${D("[--session <id>]")}  ${D("list open ask-user questions")}`,
    `    ${K("ask")} ${D("<questionId> <answer>")}     ${D("answer a pending question")}`,
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
    `    ${D("SQUAD_URL     ws://host:8080/ws      default ws://localhost:8080/ws")}`,
    `    ${D("SQUAD_TOKEN   bearer token           auto-loaded from docker/.env")}`,
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
    case "status":
      await showStatus();
      return;
    case "logs":
      await gatewayLogs(argv);
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
