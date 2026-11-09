#!/usr/bin/env node
// PreToolUse hook on the Agent tool: refuses to launch a loop implementer without its
// `WORKTREE: <absolute path>` line (the SubagentStop check reads it) or with a `model` override
// that contradicts the role's pinned model. Every decision is logged. Fails open: a problem of the
// hook itself prints nothing and the launch goes on.
//
// Ported from an equivalent Cursor hook. Claude Code's SubagentStart cannot block a start,
// so the guard runs before the Agent tool call instead.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_FILE = join(homedir(), ".claude", "hooks", "logs", "subagents.jsonl");

/** subagent type → the model family it must run on, and whether it needs a WORKTREE line. */
const POLICY = {
  "implementer-sonnet": { model: /sonnet/i, label: "Sonnet", worktree: true },
  implementer: { model: /opus/i, label: "Opus", worktree: true },
  "opus-implementer": { model: /opus/i, label: "Opus", worktree: true },
  reviewer: { model: /opus/i, label: "Opus" },
  planner: { model: /opus/i, label: "Opus" },
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
if (policy.worktree && !/^\s*WORKTREE:\s*\S/m.test(tool.prompt ?? "")) {
  problems.push(`${type} needs a line "WORKTREE: <absolute path>" in its prompt (and "BASE: <ref>" for the check after it; the loop-engineering skill adds both).`);
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
