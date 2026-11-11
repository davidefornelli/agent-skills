#!/usr/bin/env node
// PreToolUse hook on the Agent tool: refuses to launch a loop implementer without its
// `WORKTREE: <absolute path>` and `BASE: <ref>` lines (the SubagentStop check reads them) or any
// loop agent with a `model` override that contradicts the role's pinned model. Other agent types
// pass untouched. Every decision is logged. Fails open: a problem of the hook itself prints
// nothing and the launch goes on.
//
// Ported from an equivalent Cursor hook. Claude Code's SubagentStart cannot block a start,
// so the guard runs before the Agent tool call instead.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const LOG_FILE = join(CONFIG_DIR, "hooks", "logs", "subagents.jsonl");

/** subagent type → the model family it must run on, and whether it needs a WORKTREE line. */
const POLICY = {
  "loop-implementer-sonnet": { model: /sonnet/i, label: "Sonnet", worktree: true },
  "loop-implementer-opus": { model: /opus/i, label: "Opus", worktree: true },
  "loop-reviewer": { model: /opus/i, label: "Opus" },
  "loop-planner": { model: /opus/i, label: "Opus" },
};

function log(entry) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // logging must never break the hook
  }
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "") || "{}");
} catch (e) {
  log({ event: "guard", error: `bad input: ${e}` });
  process.exit(0);
}

const tool = input.tool_input ?? {};
const type = tool.subagent_type;
const policy = POLICY[type];
const base = { event: "guard", type, model: tool.model, description: tool.description, session: input.session_id };

if (!policy) process.exit(0);

const problems = [];
if (typeof tool.model === "string" && tool.model !== "" && !policy.model.test(tool.model)) {
  problems.push(`${type} must run on ${policy.label}; do not pass model "${tool.model}" (the agent's frontmatter pins it).`);
}
if (policy.worktree) {
  const prompt = tool.prompt ?? "";
  if (!/^\s*WORKTREE:\s*(\/|[A-Za-z]:[\\/])/m.test(prompt)) {
    problems.push(`${type} needs a line "WORKTREE: <absolute path of its git worktree>" in its prompt.`);
  }
  if (!/^\s*BASE:\s*\S/m.test(prompt)) {
    problems.push(`${type} needs a line "BASE: <commit its branch started from>" in its prompt: the check after it covers the changes since BASE.`);
  }
}

if (problems.length > 0) {
  log({ ...base, decision: "deny", problems });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: problems.join("\n"),
      },
    }),
  );
  process.exit(0);
}
log({ ...base, decision: "allow" });
process.exit(0);
