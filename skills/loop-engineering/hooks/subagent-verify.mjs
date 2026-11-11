#!/usr/bin/env node
// SubagentStop hook for the loop implementers (registered in settings.json with a matcher on
// their agent types): runs a fast check in the implementer's worktree and, when it fails, keeps the implementer going
// with the failure as its next instruction ({"decision":"block","reason":...}). At most
// MAX_FOLLOWUPS times per subagent, then it lets it stop and logs it. Fails open: any problem of
// the hook itself lets the subagent stop.
//
// Ported from an equivalent Cursor hook, with one change: the check covers the changes since
// the package's base ref (committed and not), not only the uncommitted ones, because implementers
// commit before they stop.
//
// The worktree and base come from the `WORKTREE: <absolute path>` and `BASE: <ref>` lines of the
// subagent's prompt (its first message in the transcript; Claude Code does not pass the prompt).
// The check, first match wins:
// 1. the `VERIFY: <command>` lines of the prompt, one command per line (the plan's fast check);
// 2. the commands in `<worktree>/.claude/verify-fast` or `<worktree>/.cursor/verify-fast`
//    (one per line, `#` comments);
// 3. the project's type check (`npm run typecheck`, or `npx tsc --noEmit` with a tsconfig.json)
//    and `npx vitest related --run <changed files>` (with vitest), on the files changed since
//    BASE (default: the merge-base with main or master).
// All the commands together get BUDGET_MS, less than the hook's timeout in settings.json (900 s):
// a check that runs out of time is logged and the subagent stops.
// The subagent's report starting with `STATUS: BLOCKED` or `STATUS: NEEDS_CONTEXT` is not checked.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const LOG_FILE = join(CONFIG_DIR, "hooks", "logs", "subagent-verify.jsonl");
const STATE_DIR = join(CONFIG_DIR, "hooks", "state");
const MAX_FOLLOWUPS = 2;
const BUDGET_MS = 14 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 8 * 60 * 1000;
const started = Date.now();
const TAIL_CHARS = 4000;
const SLOW_TESTS = ["**/e2e*.test.*", "**/*.e2e.test.*", "**/node_modules/**"];

function log(entry) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // logging must never break the hook
  }
}

function letStop() {
  process.exit(0);
}

function keepGoing(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

/** The text of the subagent's first user message: the prompt it was launched with. */
function firstPrompt(transcript) {
  if (!transcript || !existsSync(transcript)) return "";
  for (const line of readFileSync(transcript, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec.message;
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) return msg.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
  }
  return "";
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function declaredChecks(root) {
  for (const rel of [".claude/verify-fast", ".cursor/verify-fast"]) {
    const file = join(root, rel);
    if (existsSync(file)) {
      return readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
    }
  }
  return null;
}

/** Files changed since base, committed, uncommitted and untracked, that still exist. */
function changedFiles(root, base) {
  const ref = base ?? git(["merge-base", "HEAD", "main"], root) ?? git(["merge-base", "HEAD", "master"], root) ?? "HEAD";
  const lists = [
    git(["diff", "--name-only", `${ref}...HEAD`], root),
    git(["diff", "--name-only", "HEAD"], root),
    git(["ls-files", "--others", "--exclude-standard"], root),
  ];
  const files = new Set(lists.filter(Boolean).flatMap((l) => l.split(/\r?\n/)).filter(Boolean));
  return [...files].map((f) => join(root, f)).filter((f) => existsSync(f));
}

function checksFor(root, base, prompt) {
  const fromPlan = [...prompt.matchAll(/^[ \t]*VERIFY:[ \t]*(\S.*?)[ \t]*$/gm)].map((m) => m[1]);
  if (fromPlan.length > 0) return fromPlan;
  const declared = declaredChecks(root);
  if (declared) return declared;
  if (!existsSync(join(root, "package.json"))) return [];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  // The project's own type check when it declares one, else tsc on the project's code only
  // (library declarations in node_modules are not the package's concern).
  const typeScript = ["typecheck", "check:types", "types"].find((s) => pkg.scripts?.[s]);
  const checks = typeScript ? [`npm run ${typeScript}`] : existsSync(join(root, "tsconfig.json")) ? ["npx tsc --noEmit --skipLibCheck"] : [];
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const code = changedFiles(root, base).filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  // End-to-end suites (build a bundle, start an engine) time out under the load of parallel
  // implementers: they belong to the orchestrator's full verification after the merge.
  if (deps.vitest && code.length > 0) {
    checks.push(`npx vitest related --run ${SLOW_TESTS.map((g) => `--exclude "${g}"`).join(" ")} ${code.map((f) => `"${f}"`).join(" ")}`);
  }
  return checks;
}

function run(command, cwd, timeout) {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { ok: r.status === 0, exit: r.status ?? (r.error ? String(r.error.code ?? r.error.message) : "killed"), tail: output.slice(-TAIL_CHARS) };
}

function followups(id) {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, `verify-${id}.json`), "utf8")).count ?? 0;
  } catch {
    return 0;
  }
}

function countFollowup(id, count) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(join(STATE_DIR, `verify-${id}.json`), JSON.stringify({ count }));
  } catch {
    // a lost counter only means one more follow-up; Claude Code also caps consecutive blocks
  }
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "") || "{}");
} catch (e) {
  log({ event: "bad_input", error: String(e) });
  letStop();
}

try {
  const id = input.agent_id ?? "unknown";
  const status = /^\s*STATUS:\s*(\w+)/m.exec(input.last_assistant_message ?? "")?.[1];
  if (status === "BLOCKED" || status === "NEEDS_CONTEXT") {
    log({ event: "skipped", id, reason: `status ${status}` });
    letStop();
  }
  const prompt = firstPrompt(input.agent_transcript_path);
  const declared = /^\s*WORKTREE:\s*(.+?)\s*$/m.exec(prompt)?.[1];
  const base = /^\s*BASE:\s*(\S+)\s*$/m.exec(prompt)?.[1];
  if (!declared || !existsSync(declared)) {
    log({ event: "skipped", id, reason: "no WORKTREE line or missing folder", declared });
    letStop();
  }
  const root = git(["rev-parse", "--show-toplevel"], declared) ?? resolve(declared);
  const done = followups(id);
  const checks = checksFor(root, base, prompt);
  if (checks.length === 0) log({ event: "skipped", id, reason: "no check declared or detected", root });
  for (const command of checks) {
    const left = BUDGET_MS - (Date.now() - started);
    if (left < 10_000) {
      log({ event: "out_of_time", id, root, command });
      letStop();
    }
    const timeout = Math.min(COMMAND_TIMEOUT_MS, left);
    const result = run(command, root, timeout);
    log({ event: "check", id, type: input.agent_type, root, command, ok: result.ok, exit: result.exit, followups: done });
    if (result.ok) continue;
    if (result.exit === "ETIMEDOUT" && timeout < COMMAND_TIMEOUT_MS) {
      // Cut short by the budget, not by its own limit: that says nothing about the package.
      log({ event: "out_of_time", id, root, command, timeout_ms: timeout });
      letStop();
    }
    if (done >= MAX_FOLLOWUPS) {
      log({ event: "gave_up", id, root, command });
      letStop();
    }
    countFollowup(id, done + 1);
    keepGoing(
      [
        `The automatic check after your work failed in ${root}.`,
        `Command: ${command} (exit ${result.exit})`,
        "Last output:",
        result.tail,
        "",
        "Fix the cause inside the files your package owns, run the check again, commit, then report again starting with the STATUS line.",
        "If the failure is outside your package or not caused by your change, change nothing else: report STATUS: BLOCKED with this output.",
      ].join("\n"),
    );
  }
  letStop();
} catch (e) {
  log({ event: "hook_error", error: String(e) });
  letStop();
}
