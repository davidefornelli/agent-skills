#!/usr/bin/env node
// Guard on the launch of a loop subagent: Claude Code runs it as PreToolUse on the Agent tool
// (its SubagentStart cannot refuse a start), Cursor as subagentStart. It refuses:
// - an implementer without its `WORKTREE: <absolute path>` and `BASE: <ref>` lines (the check
//   after it reads them);
// - a loop agent launched on a model other than the one its agent file sets (`model:` in the
//   front matter; `inherit` or no line leaves the model free).
// Other agent types pass untouched. Every decision is logged. Fails open: a problem of the hook
// itself lets the launch go on.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR, IMPLEMENTER, frontmatter, log, pass, reply, start } from "./common.mjs";

const LOG = "subagents.jsonl";
const ROLE = /^loop-(planner|reviewer|implementer(-senior)?)$/;

const { input, harness } = start(LOG);

const allow = () => reply(harness === "cursor" ? { permission: "allow" } : {});
function deny(reason) {
  if (harness === "cursor") reply({ permission: "deny", user_message: reason, agent_message: reason });
  reply({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
}

/** The agent file the harness will load for this type: the project's before the user's. */
function agentFile(type) {
  const dirs = [];
  if (harness === "cursor") {
    for (const root of input.workspace_roots ?? []) for (const d of [".cursor", ".claude", ".codex"]) dirs.push(join(root, d, "agents"));
    dirs.push(join(CONFIG_DIR, "agents"), join(homedir(), ".claude", "agents"), join(homedir(), ".codex", "agents"));
  } else {
    for (let d = input.cwd; typeof d === "string" && d !== ""; d = dirname(d)) {
      dirs.push(join(d, ".claude", "agents"));
      if (dirname(d) === d) break;
    }
    dirs.push(join(CONFIG_DIR, "agents"));
  }
  return dirs.map((d) => join(d, `${type}.md`)).find((f) => existsSync(f));
}

// `opus` and `claude-opus-5-5`, `grok-4.7-xhigh` and `grok-4.7-xhigh-fast[context=1m]` name the
// same choice: a model contradicts the file only when neither name contains the other.
const bare = (model) => String(model).toLowerCase().replace(/\[.*$/, "").trim();
const sameModel = (a, b) => bare(a).includes(bare(b)) || bare(b).includes(bare(a));

try {
  const launch =
    harness === "cursor"
      ? { type: input.subagent_type, model: input.subagent_model, prompt: input.task, session: input.parent_conversation_id ?? input.conversation_id }
      : { type: input.tool_input?.subagent_type, model: input.tool_input?.model, prompt: input.tool_input?.prompt, session: input.session_id };
  const type = String(launch.type ?? "");
  if (!ROLE.test(type)) allow();

  const problems = [];
  const file = agentFile(type);
  const pinned = file ? frontmatter(file).model : undefined;
  if (typeof launch.model === "string" && launch.model !== "" && pinned && pinned !== "inherit" && !sameModel(launch.model, pinned)) {
    problems.push(
      `${type} runs on "${pinned}" (the model line of ${file}), not on "${launch.model}": launch it without a model. ` +
        "To change the model of a role, edit that line or run the skill's install.mjs with --model.",
    );
  }
  if (IMPLEMENTER.test(type)) {
    const prompt = String(launch.prompt ?? "");
    if (!/^\s*WORKTREE:\s*(\/|[A-Za-z]:[\\/])/m.test(prompt)) {
      problems.push(`${type} needs a line "WORKTREE: <absolute path of its git worktree>" in its prompt.`);
    }
    if (!/^\s*BASE:\s*\S/m.test(prompt)) {
      problems.push(`${type} needs a line "BASE: <commit its branch started from>" in its prompt: the check after it covers the changes since BASE.`);
    }
  }

  const entry = { event: "guard", harness, type, model: launch.model, pinned, session: launch.session };
  if (problems.length > 0) {
    log(LOG, { ...entry, decision: "deny", problems });
    deny(problems.join("\n"));
  }
  log(LOG, { ...entry, decision: "allow" });
  allow();
} catch (e) {
  log(LOG, { event: "guard", error: String(e) });
  pass();
}
