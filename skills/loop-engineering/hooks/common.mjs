// Shared by the loop-engineering hooks (agent-guard, subagent-verify, subagent-audit).
//
// The same scripts serve Claude Code and Cursor. The installer registers each one with
// `--harness claude` (settings.json) or `--harness cursor` (hooks.json). Cursor also runs the
// hooks of ~/.claude/settings.json: a script called by the harness it was not registered for does
// nothing, so one event is handled once.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** <config>/hooks/loop-engineering/<this file> → <config> (~/.claude or ~/.cursor). */
export const CONFIG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOG_DIR = join(CONFIG_DIR, "hooks", "logs");

const flag = process.argv.indexOf("--harness");
const REGISTERED = flag === -1 ? null : process.argv[flag + 1];

// The loop's agent types: the planner, the two bundled implementers, the reviewer, and the
// specialists the user adopted (`loop-implementer-<name>`, `loop-reviewer-<name>`).
export const IMPLEMENTER = /^loop-implementer(-[a-z0-9][a-z0-9-]*)?$/;
export const ROLE = /^loop-(planner|(implementer|reviewer)(-[a-z0-9][a-z0-9-]*)?)$/;

/** One JSON line in <config>/hooks/logs/<file>. Logging never breaks a hook. */
export function log(file, entry) {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, file), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // ignored on purpose
  }
}

/** Ends the hook with an answer. Cursor needs valid JSON on stdout from every hook. */
export function reply(answer) {
  process.stdout.write(JSON.stringify(answer));
  process.exit(0);
}

/** Ends the hook without acting: `{}` is a neutral answer for both harnesses. */
export function pass() {
  reply({});
}

/**
 * The hook's input and the harness that called it. Ends the hook, without acting, on unreadable
 * input or when the caller is not the harness this entry was registered for.
 */
export function start(logFile) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, "") || "{}");
  } catch (e) {
    log(logFile, { event: "bad_input", error: String(e) });
    pass();
  }
  // Cursor's input carries its version and camelCase event names (subagentStop); Claude Code's
  // event names are PascalCase (SubagentStop).
  const cursor = input.cursor_version !== undefined || /^[a-z]/.test(String(input.hook_event_name ?? ""));
  const harness = cursor ? "cursor" : "claude";
  if (REGISTERED && REGISTERED !== harness) pass();
  return { input, harness };
}

/** The `key: value` lines of a Markdown file's front matter. */
export function frontmatter(file) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  const out = {};
  for (const line of head.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
