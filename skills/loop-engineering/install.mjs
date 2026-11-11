#!/usr/bin/env node
// Installs what the loop-engineering skill needs besides itself, for Claude Code:
// - the four subagents into ~/.claude/agents (loop-planner, loop-implementer-sonnet,
//   loop-implementer-opus, loop-reviewer);
// - the three hooks into ~/.claude/hooks/loop-engineering and their entries in
//   ~/.claude/settings.json (PreToolUse on Agent, SubagentStop).
//
// Usage: node install.mjs [--force] [--dry-run] [--with-permissions] [--uninstall]
//   --force             overwrite agents that already exist with different content
//   --dry-run           print what would change, write nothing
//   --with-permissions  also add `permissions.ask` for git push, npm publish, git reset --hard,
//                       git branch -D and git clean -f
//   --uninstall         remove the hook entries, the hooks folder and the agents that still match
//                       the bundled ones (`permissions.ask` stays: remove those lines by hand)
// Idempotent: it touches only the hook entries that point into hooks/loop-engineering, and writes
// settings.json (after a backup in settings.json.bak-loop-engineering) only when it changes.
// CLAUDE_CONFIG_DIR is honoured.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FLAGS = ["--force", "--dry-run", "--with-permissions", "--uninstall"];
const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => !FLAGS.includes(a));
if (unknown.length > 0) {
  console.error(`Unknown option ${unknown.join(", ")}. Usage: node install.mjs ${FLAGS.map((f) => `[${f}]`).join(" ")}`);
  process.exit(2);
}
const FORCE = args.has("--force");
const DRY = args.has("--dry-run");
const PERMISSIONS = args.has("--with-permissions");
const UNINSTALL = args.has("--uninstall");

const here = dirname(fileURLToPath(import.meta.url));
const claude = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const agentsDir = join(claude, "agents");
const hooksDir = join(claude, "hooks", "loop-engineering");
const settingsPath = join(claude, "settings.json");

const HOOKS = ["agent-guard.mjs", "subagent-verify.mjs", "subagent-audit.mjs"];
const IMPLEMENTERS = "loop-implementer-sonnet|loop-implementer-opus";
const ASK = ["Bash(git push:*)", "Bash(npm publish:*)", "Bash(git reset --hard:*)", "Bash(git branch -D:*)", "Bash(git clean -f:*)"];
const agentFiles = readdirSync(join(here, "agents")).filter((f) => f.endsWith(".md"));

const say = (m) => console.log((DRY ? "[dry-run] " : "") + m);

function copy(src, dst, { overwrite }) {
  const fresh = readFileSync(src, "utf8");
  if (existsSync(dst)) {
    if (readFileSync(dst, "utf8") === fresh) return say(`= ${dst} (already up to date)`);
    if (!overwrite) return say(`! ${dst} exists and differs: kept (use --force to overwrite)`);
  }
  say(`+ ${dst}`);
  if (!DRY) {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

// ---------------------------------------------------------------- files
if (UNINSTALL) {
  for (const f of agentFiles) {
    const dst = join(agentsDir, f);
    if (!existsSync(dst)) continue;
    if (readFileSync(dst, "utf8") !== readFileSync(join(here, "agents", f), "utf8")) {
      say(`! ${dst} was edited: kept`);
      continue;
    }
    say(`- ${dst}`);
    if (!DRY) rmSync(dst);
  }
  if (existsSync(hooksDir)) {
    say(`- ${hooksDir}`);
    if (!DRY) rmSync(hooksDir, { recursive: true });
  }
} else {
  for (const f of agentFiles) copy(join(here, "agents", f), join(agentsDir, f), { overwrite: FORCE });
  // The hooks live in their own folder: always ours to overwrite.
  for (const f of HOOKS) copy(join(here, "hooks", f), join(hooksDir, f), { overwrite: true });
}

// ---------------------------------------------------------------- settings.json
let before = "";
let settings = {};
if (existsSync(settingsPath)) {
  before = readFileSync(settingsPath, "utf8");
  try {
    settings = JSON.parse(before);
  } catch (e) {
    console.error(`Cannot parse ${settingsPath}: ${e.message}. Fix it and run again.`);
    process.exit(1);
  }
}

// An entry is ours when it runs one of our hooks from a hooks/loop-engineering folder. Hooks with
// the same file names installed elsewhere belong to someone else and stay.
const OURS = new RegExp(`[\\\\/]hooks[\\\\/]loop-engineering[\\\\/](${HOOKS.map((h) => h.replace(".", "\\.")).join("|")})`);
const isOurs = (hook) => [hook?.command, ...(hook?.args ?? [])].some((s) => typeof s === "string" && OURS.test(s));
const hookCmd = (file, timeout) => ({ type: "command", command: `node "${join(hooksDir, file)}"`, timeout });

if (settings.hooks) {
  for (const event of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event]
      .map((group) => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter((h) => !isOurs(h)) } : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
}
if (!UNINSTALL) {
  settings.hooks ??= {};
  (settings.hooks.PreToolUse ??= []).push({ matcher: "Agent", hooks: [hookCmd("agent-guard.mjs", 10)] });
  (settings.hooks.SubagentStop ??= []).push({ hooks: [hookCmd("subagent-audit.mjs", 10)] });
  settings.hooks.SubagentStop.push({ matcher: IMPLEMENTERS, hooks: [hookCmd("subagent-verify.mjs", 900)] });
  if (PERMISSIONS) {
    settings.permissions ??= {};
    settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...ASK])];
  }
} else if (settings.hooks && Object.keys(settings.hooks).length === 0) {
  delete settings.hooks;
}

const after = JSON.stringify(settings, null, 2) + "\n";
const same = before !== "" && JSON.stringify(JSON.parse(before)) === JSON.stringify(settings);
if (same || (before === "" && UNINSTALL)) {
  say(`= ${settingsPath} (already up to date)`);
} else {
  const what = UNINSTALL ? "hook entries removed" : `hooks: agent-guard, subagent-audit, subagent-verify${PERMISSIONS ? "; permissions.ask" : ""}`;
  say(`~ ${settingsPath} (${what})`);
  if (!DRY) {
    if (before !== "") writeFileSync(`${settingsPath}.bak-loop-engineering`, before);
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, after);
  }
}

say(UNINSTALL ? "Done. Restart Claude Code." : "Done. Restart Claude Code so it loads the new agents and hooks.");
