#!/usr/bin/env node
// Installs what the loop-engineering skill needs besides itself, for Claude Code:
// - the four subagents into ~/.claude/agents (planner, implementer-sonnet, opus-implementer, reviewer);
// - the three hooks into ~/.claude/hooks/loop-engineering and their entries in ~/.claude/settings.json;
// - `permissions.ask` for git push, npm publish, git reset --hard, git branch -D, git clean -f.
//
// Usage: node install.mjs [--force] [--dry-run]
//   --force    overwrite agents that already exist with different content
//   --dry-run  print what would change, write nothing
// Idempotent: running it again replaces its own hook entries instead of adding copies.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const DRY = args.has("--dry-run");

const here = dirname(fileURLToPath(import.meta.url));
const claude = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const agentsDir = join(claude, "agents");
const hooksDir = join(claude, "hooks", "loop-engineering");
const settingsPath = join(claude, "settings.json");

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

// 1. Agents
for (const f of readdirSync(join(here, "agents")).filter((f) => f.endsWith(".md"))) {
  copy(join(here, "agents", f), join(agentsDir, f), { overwrite: FORCE });
}

// 2. Hooks (always ours to overwrite: they live in their own folder)
const HOOKS = ["agent-guard.mjs", "subagent-verify.mjs", "subagent-audit.mjs"];
for (const f of HOOKS) copy(join(here, "hooks", f), join(hooksDir, f), { overwrite: true });

// 3. settings.json
let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    console.error(`Cannot parse ${settingsPath}: ${e.message}. Fix it and run again.`);
    process.exit(1);
  }
}

const mentions = (hook, name) => [hook.command, ...(hook.args ?? [])].some((s) => typeof s === "string" && s.includes(name));
const hookCmd = (file, timeout) => ({ type: "command", command: "node", args: [join(hooksDir, file)], timeout });

settings.hooks ??= {};
// Drop earlier entries of these hooks, wherever they were installed, then add ours.
for (const event of ["PreToolUse", "SubagentStop"]) {
  settings.hooks[event] = (settings.hooks[event] ?? [])
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !HOOKS.some((n) => mentions(h, n))) }))
    .filter((group) => group.hooks.length > 0);
}
settings.hooks.PreToolUse.push({ matcher: "Agent", hooks: [hookCmd("agent-guard.mjs", 10)] });
settings.hooks.SubagentStop.push({ hooks: [hookCmd("subagent-audit.mjs", 10)] });
settings.hooks.SubagentStop.push({ matcher: "implementer-sonnet|opus-implementer", hooks: [hookCmd("subagent-verify.mjs", 900)] });

const ASK = ["Bash(git push:*)", "Bash(npm publish:*)", "Bash(git reset --hard:*)", "Bash(git branch -D:*)", "Bash(git clean -f:*)"];
settings.permissions ??= {};
settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...ASK])];

say(`~ ${settingsPath} (hooks: agent-guard, subagent-audit, subagent-verify; permissions.ask)`);
if (!DRY) {
  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.bak-loop-engineering`);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

say("Done. Restart Claude Code so it loads the new agents and hooks.");
