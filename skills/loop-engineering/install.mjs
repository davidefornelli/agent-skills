#!/usr/bin/env node
// Installs what the loop-engineering skill needs besides itself, for Claude Code and Cursor:
// - the four subagents (loop-planner, loop-implementer, loop-implementer-senior, loop-reviewer)
//   into <config>/agents, each with the model of its role;
// - the specialists: agents of the user adopted into the loop as `loop-implementer-<name>` or
//   `loop-reviewer-<name>` (--adopt). An adopted copy is generated: the role's rules from this
//   skill, then the original agent's text, with the original's model and tools. Every run writes
//   the copies again from their originals;
// - the hooks into <config>/hooks/loop-engineering and their entries in the harness's hook file
//   (Claude Code: settings.json, PreToolUse on Agent and SubagentStop; Cursor: hooks.json,
//   subagentStart and subagentStop).
// <config> is ~/.claude or ~/.cursor (CLAUDE_CONFIG_DIR and CURSOR_CONFIG_DIR are honoured).
//
// Idempotent. A new run keeps the model (and effort) of each installed agent, touches only the
// hook entries that point into hooks/loop-engineering, and writes a hook file (after a backup in
// <file>.bak-loop-engineering) only when it changes.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node install.mjs [options]

  --target claude|cursor|all  the harness to set up (default: each one whose config folder exists)
  --model <role>=<model>      the model of a role: planner, implementer, senior, reviewer.
                              Repeatable; needs one target. Claude Code takes opus, sonnet, haiku,
                              inherit or a full model id; Cursor takes inherit or an id from
                              \`cursor-agent --list-models\`.
  --adopt <agent>=<role>[:<name>]
                              adopt one of your own agents as a specialist of the loop: role is
                              implementer or reviewer, name (default: the agent's) is what a plan
                              says to get it. Writes loop-<role>-<name> next to the original, which
                              stays; every later run writes the copy again from the original.
                              Repeatable; needs one target. To drop a specialist, delete its file.
  --project <dir>             install only the agents, into <dir>/.claude/agents or
                              <dir>/.cursor/agents (needs --target claude|cursor), with the
                              specialists of the user's folder. The Cursor CLI loads subagents only
                              from the workspace.
  --check                     change nothing: report what is installed (exit 0 ready, 1 not)
  --force                     replace agents whose text differs from the bundled one (their model
                              is kept) and delete the agents of older versions
  --dry-run                   print what would change, write nothing
  --with-permissions          Claude Code: also add permissions.ask for git push, npm publish,
                              git reset --hard, git branch -D and git clean -f
  --uninstall                 remove the hook entries, the hooks folder, the unedited agents and
                              the adopted copies (permissions.ask stays: remove those lines by
                              hand)`;

function usage(problem) {
  console.error(`${problem}\n\n${USAGE}`);
  process.exit(2);
}

// ---------------------------------------------------------------- what is installed
// Default front matter per role. Cursor agents carry only the model: `inherit` follows the model
// of the conversation that launches them.
const ROLES = {
  planner: { agent: "loop-planner", claude: { model: "opus", effort: "high", tools: "Read, Grep, Glob, Bash, WebFetch, WebSearch, Write" } },
  implementer: { agent: "loop-implementer", claude: { model: "sonnet", effort: "medium" } },
  senior: { agent: "loop-implementer-senior", claude: { model: "opus", effort: "medium" } },
  reviewer: { agent: "loop-reviewer", claude: { model: "opus", effort: "high", tools: "Read, Grep, Glob, Bash, Write" } },
};
for (const role of Object.values(ROLES)) role.cursor = { model: "inherit" };

const HARNESSES = {
  claude: { label: "Claude Code", dir: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), projectDir: ".claude", hookFile: "settings.json" },
  cursor: { label: "Cursor", dir: process.env.CURSOR_CONFIG_DIR ?? join(homedir(), ".cursor"), projectDir: ".cursor", hookFile: "hooks.json" },
};

const HOOKS = ["agent-guard.mjs", "subagent-audit.mjs", "subagent-verify.mjs"];
const HOOK_FILES = ["common.mjs", ...HOOKS];
const LEGACY_AGENTS = ["loop-implementer-sonnet.md", "loop-implementer-opus.md"];
// Hook matchers, as regular expressions: the bundled agents and the adopted specialists.
const ANY_ROLE = "^loop-(planner|(implementer|reviewer)(-[a-z0-9-]+)?)$";
const ANY_IMPLEMENTER = "^loop-implementer(-[a-z0-9-]+)?$";
// A specialist's name, and the names a plan already uses for something else.
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const RESERVED = { implementer: ["standard", "senior", "sonnet", "opus"], reviewer: ["spec", "quality", "final"] };
const ASK = ["Bash(git push:*)", "Bash(npm publish:*)", "Bash(git reset --hard:*)", "Bash(git branch -D:*)", "Bash(git clean -f:*)"];

// ---------------------------------------------------------------- options
const SWITCHES = ["--check", "--force", "--dry-run", "--with-permissions", "--uninstall"];
const VALUED = ["--target", "--model", "--project", "--adopt"];
const on = new Set();
const MODELS = {};
const ADOPT = [];
let target = null;
let project = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  let name = argv[i];
  let value;
  if (name === "--help" || name === "-h") {
    console.log(USAGE);
    process.exit(0);
  }
  if (SWITCHES.includes(name)) {
    on.add(name);
    continue;
  }
  const eq = name.indexOf("=");
  if (eq !== -1 && VALUED.includes(name.slice(0, eq))) [name, value] = [name.slice(0, eq), name.slice(eq + 1)];
  if (!VALUED.includes(name)) usage(`Unknown option ${name}.`);
  value ??= argv[++i];
  if (value === undefined || value === "") usage(`${name} needs a value.`);
  if (name === "--target") {
    if (!["claude", "cursor", "all"].includes(value)) usage(`--target is claude, cursor or all, not "${value}".`);
    target = value;
  } else if (name === "--project") {
    project = resolve(value);
  } else if (name === "--adopt") {
    const m = /^(.+)=(implementer|reviewer)(?::(.+))?$/.exec(value);
    if (!m) usage(`--adopt takes <agent>=<role>[:<name>] with role implementer or reviewer, not "${value}".`);
    const [, agent, role, specialty = agent] = m;
    if (!NAME.test(specialty)) {
      usage(`--adopt ${value}: "${specialty}" cannot name a specialist (lowercase letters, digits and dashes). Give one: --adopt "${agent}=${role}:<name>".`);
    }
    if (RESERVED[role].includes(specialty)) {
      usage(`--adopt ${value}: the loop already uses "${specialty}" for ${role === "implementer" ? "an implementer" : "a review stage"}. Give another name: --adopt "${agent}=${role}:<name>".`);
    }
    ADOPT.push({ agent, role, name: specialty });
  } else {
    const [role, model] = [value.slice(0, value.indexOf("=")), value.slice(value.indexOf("=") + 1)];
    if (!value.includes("=") || !ROLES[role] || !/^\S+$/.test(model)) {
      usage(`--model takes <role>=<model> with role one of ${Object.keys(ROLES).join(", ")}, not "${value}".`);
    }
    MODELS[role] = model;
  }
}
const CHECK = on.has("--check");
const FORCE = on.has("--force");
const DRY = on.has("--dry-run");
const PERMISSIONS = on.has("--with-permissions");
const UNINSTALL = on.has("--uninstall");

const targets = target === "all" ? Object.keys(HARNESSES) : target ? [target] : Object.keys(HARNESSES).filter((h) => existsSync(HARNESSES[h].dir));
if (targets.length === 0) usage(`Neither ${HARNESSES.claude.dir} nor ${HARNESSES.cursor.dir} exists: name the harness with --target.`);
if (Object.keys(MODELS).length > 0 && targets.length !== 1) usage("Model names differ between harnesses: with --model, name one with --target claude or --target cursor.");
if (ADOPT.length > 0 && targets.length !== 1) usage("Agents differ between harnesses: with --adopt, name one with --target claude or --target cursor.");
if (project && (target === null || target === "all")) usage("--project needs --target claude or --target cursor.");
if (project && !existsSync(project)) usage(`--project: ${project} does not exist.`);
if (CHECK && (FORCE || UNINSTALL || PERMISSIONS || DRY || Object.keys(MODELS).length > 0 || ADOPT.length > 0)) usage("--check changes nothing: use it alone, with --target or --project.");
if (UNINSTALL && (Object.keys(MODELS).length > 0 || ADOPT.length > 0)) usage("--uninstall takes no --model and no --adopt.");

const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(file, "utf8");
const say = (m) => console.log((DRY ? "[dry-run] " : "") + m);

function write(file, text, message) {
  say(message);
  if (DRY) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function remove(path, message) {
  say(message);
  if (!DRY) rmSync(path, { recursive: true });
}

// ---------------------------------------------------------------- agents
/** A Markdown file as its front matter (verbatim, and as key → value) and the text after it. */
function parse(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { head: null, fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { head: m[1], fm, body: text.slice(m[0].length) };
}

/** The bundled agent (front matter: name and description) with the harness's lines added. */
function render(source, harness, role, { model, effort }) {
  const extra = harness === "claude" ? { model, effort, tools: ROLES[role].claude.tools } : { model };
  const lines = Object.entries(extra).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${v}`);
  return `---\n${[source.head, ...lines].join("\n")}\n---\n${source.body}`;
}

/** The text with one front matter line set, the rest untouched. */
function withLine(text, key, value) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  lines.splice(at === -1 ? lines.length : at, at === -1 ? 0 : 1, `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---${text.slice(m[0].length)}`;
}

const bundled = (role) => parse(read(join(here, "agents", `${ROLES[role].agent}.md`)));
const agentsDir = (harness) => (project ? join(project, HARNESSES[harness].projectDir, "agents") : join(HARNESSES[harness].dir, "agents"));

/**
 * An installed agent against the bundle: `unedited` when only its model and effort differ from
 * what this installer writes.
 */
function installed(harness, role, file) {
  if (!existsSync(file)) return null;
  const text = read(file);
  const { fm } = parse(text);
  const effort = harness === "claude" ? fm.effort : undefined;
  return { text, fm, unedited: text === render(bundled(role), harness, role, { model: fm.model, effort }) };
}

function installAgent(harness, role) {
  const file = join(agentsDir(harness), `${ROLES[role].agent}.md`);
  const now = installed(harness, role, file);
  // A project copy starts from the model of the user's copy: one choice per role and harness.
  const user = project ? installed(harness, role, join(HARNESSES[harness].dir, "agents", `${ROLES[role].agent}.md`)) : null;
  const defaults = ROLES[role][harness];
  const model = MODELS[role] ?? now?.fm.model ?? user?.fm.model ?? defaults.model;
  const effort = defaults.effort && (now?.fm.effort ?? user?.fm.effort ?? defaults.effort);
  const fresh = render(bundled(role), harness, role, { model, effort });
  if (!now) return write(file, fresh, `+ ${file} (model: ${model})`);
  if (now.text === fresh) return say(`= ${file} (model: ${model})`);
  const change = now.fm.model === model ? `model: ${model}` : `model: ${now.fm.model ?? "none"} → ${model}`;
  if (now.unedited) return write(file, fresh, `~ ${file} (${change})`);
  if (FORCE) return write(file, fresh, `~ ${file} (replaced with the bundled text; ${change})`);
  if (now.fm.model !== model && withLine(now.text, "model", model)) {
    return write(file, withLine(now.text, "model", model), `~ ${file} (${change}; its text differs from the bundle and stays: --force replaces it)`);
  }
  say(`! ${file} differs from the bundle: kept (--force replaces it and keeps model: ${model})`);
}

function uninstallAgent(harness, role) {
  const file = join(agentsDir(harness), `${ROLES[role].agent}.md`);
  const now = installed(harness, role, file);
  if (!now) return;
  if (now.unedited || FORCE) remove(file, `- ${file}`);
  else say(`! ${file} was edited: kept (--force removes it)`);
}

function legacyAgents(harness) {
  for (const name of LEGACY_AGENTS) {
    const file = join(agentsDir(harness), name);
    if (!existsSync(file)) continue;
    if (FORCE || UNINSTALL) remove(file, `- ${file} (agent of an older version)`);
    else say(`! ${file} is the agent of an older version and no longer used: delete it, or run again with --force`);
  }
}

// ---------------------------------------------------------------- specialists
// An adopted copy is `loop-<role>-<name>.md` with an `adopted_from: <original's file name>` line.
// It is generated: the role's body from the bundle, a paragraph that ties the two together, the
// original's body. Front matter: the original's, with the loop's name and description.
const GLUE = {
  implementer: (name, origin) => `## Your specialty

You are the loop's \`${name}\` specialist: the plan gives you the packages that need this
expertise. The brief below is the one of the agent \`${origin}\`, which you are adopted from: it says
how you work inside a package. Where it disagrees with the rules above (the package's scope, the
commits, \`git push\`, what belongs to the user, the report and its status line), the rules above
win: a question for the user is a \`NEEDS_CONTEXT\` report.`,
  reviewer: (name, origin) => `## Your specialty

Your stage is \`${name}\` (the prompt says \`STAGE: ${name}\`), in place of the three above. It comes
after spec and quality, on the packages the plan sends to it. Judge the RANGE through this
specialty alone: what spec and quality cover is theirs. Finding ids: \`R<round>-${name}-<n>\`
(\`R2-${name}-1\`). The brief below is the one of the agent \`${origin}\`, which you are adopted from:
it says what to look for. Where it disagrees with the rules above (one file written, the findings,
the verdict file, the reply), the rules above win.`,
};

/** Front matter as entries: key, the value on its line, the lines that continue it. */
function entries(head) {
  const out = [];
  for (const line of head.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (kv) out.push({ key: kv[1], value: kv[2].trim(), lines: [line], more: [] });
    else if (out.length > 0) {
      out.at(-1).lines.push(line);
      out.at(-1).more.push(line.trim());
    }
  }
  return out;
}

function unquote(value) {
  if (/^".*"$/.test(value)) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return /^'.*'$/.test(value) ? value.slice(1, -1).replaceAll("''", "'") : value;
}

/** A scalar as one line of text: plain, quoted, or a block (`>-`, `|`) folded. */
const scalar = (e) => (!e ? "" : /^[>|]/.test(e.value) ? e.more.filter(Boolean).join(" ") : [unquote(e.value), ...e.more].filter(Boolean).join(" "));

/** A list written inline (`a, b`, `[a, b]`) or as `- a` lines; null without the key. */
function list(e) {
  if (!e) return null;
  const items = e.value ? e.value.replace(/^\[|\]$/g, "").split(/,(?![^(]*\))/) : e.more.map((l) => l.replace(/^-\s*/, ""));
  return items.map((t) => unquote(t.trim())).filter(Boolean);
}

/** The user's agent `agent` (a file name without `.md`, or a `name:`): project folder first. */
function findOrigin(harness, agent) {
  const dirs = [...new Set([agentsDir(harness), join(HARNESSES[harness].dir, "agents")])].filter((d) => existsSync(d));
  for (const dir of dirs) {
    if (existsSync(join(dir, `${agent}.md`))) return { file: join(dir, `${agent}.md`), base: agent };
  }
  for (const dir of dirs) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      if (parse(read(join(dir, f))).fm.name === agent) return { file: join(dir, f), base: basename(f, ".md") };
    }
  }
  return null;
}

/** The adopted copy's text, or why this agent cannot take the role; `notes` say what was adapted. */
function compose(harness, role, name, origin) {
  const source = parse(read(origin.file));
  if (source.head === null) return { refusal: `${origin.file} has no front matter` };
  const fm = entries(source.head);
  const get = (key) => fm.find((e) => e.key === key);
  if (get("adopted_from") || /^loop-/.test(origin.base)) return { refusal: `${origin.base} is an agent of the loop already` };
  const called = scalar(get("name")) || origin.base;
  const notes = [];
  const lines = [];
  const drop = new Set(["name", "description", "model", "adopted_from"]);
  if (harness === "claude") {
    const tools = list(get("tools"));
    const denied = list(get("disallowedTools")) ?? [];
    const has = (tool) => (tools === null || tools.some((t) => t.replace(/\(.*$/, "") === tool)) && !denied.includes(tool);
    if (role === "implementer" && !(has("Bash") && (has("Edit") || has("Write")))) {
      return { refusal: `${called} cannot both edit files and run commands (its tools): adopt it as a reviewer` };
    }
    const need = role === "reviewer" ? ["Bash", "Write"].filter((t) => !has(t)) : [];
    if (need.length > 0) {
      if (tools !== null) {
        drop.add("tools");
        lines.push(`tools: ${[...tools, ...need.filter((t) => !tools.some((x) => x.replace(/\(.*$/, "") === t))].join(", ")}`);
      }
      if (denied.some((t) => need.includes(t))) {
        drop.add("disallowedTools");
        const left = denied.filter((t) => !need.includes(t));
        if (left.length > 0) lines.push(`disallowedTools: ${left.join(", ")}`);
      }
      notes.push(`${need.join(" and ")} added: a reviewer runs the checks and writes its verdict file`);
    }
  } else if (/^true$/i.test(scalar(get("readonly")))) {
    if (role === "implementer") return { refusal: `${called} is read-only (readonly: true): adopt it as a reviewer` };
    drop.add("readonly");
    notes.push("readonly dropped: a reviewer writes its verdict file");
  }
  const model = scalar(get("model")) || "inherit";
  const does = role === "implementer" ? `implements the packages the plan gives to \`${name}\`` : `the \`${name}\` review stage, after spec and quality`;
  const description = `Specialist ${role} of the loop-engineering skill: ${does}. Launched by the loop's orchestrator. Adopted from \`${called}\`: ${scalar(get("description"))}`;
  const head = [
    `name: loop-${role}-${name}`,
    `description: ${JSON.stringify(description)}`,
    `adopted_from: ${origin.base}`,
    `model: ${model}`,
    ...lines,
    ...fm.filter((e) => !drop.has(e.key)).flatMap((e) => e.lines),
  ];
  const text = `---\n${head.join("\n")}\n---\n${bundled(role).body.trimEnd()}\n\n${GLUE[role](name, called)}\n\n${source.body.trim()}\n`;
  return { text, notes, model, called };
}

/** The adopted copies in a folder. */
function adoptedIn(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^loop-(implementer|reviewer)-([a-z0-9][a-z0-9-]*)\.md$/.exec(f);
    const origin = m && parse(read(join(dir, f))).fm.adopted_from;
    if (origin) out.push({ role: m[1], name: m[2], agent: origin, file: join(dir, f) });
  }
  return out;
}

/** What to write in this run: the copies already here (a project also gets the user's), then --adopt. */
function adoptions(harness) {
  const wanted = new Map();
  const dirs = [...new Set([join(HARNESSES[harness].dir, "agents"), agentsDir(harness)])];
  for (const dir of dirs) for (const a of adoptedIn(dir)) wanted.set(`${a.role}-${a.name}`, { role: a.role, name: a.name, agent: a.agent });
  for (const a of ADOPT) wanted.set(`${a.role}-${a.name}`, { ...a, asked: true });
  return [...wanted.values()];
}

function installAdopted(harness, { role, name, agent, asked }) {
  const file = join(agentsDir(harness), `loop-${role}-${name}.md`);
  const origin = findOrigin(harness, agent);
  if (!origin) return say(`! ${file}: its original, ${agent}, is gone: kept as it is (delete the file to drop the specialist)`);
  const made = compose(harness, role, name, origin);
  if (made.refusal) return say(`! ${file}: ${made.refusal}: kept as it is`);
  const about = [`adopted from ${made.called}`, `model: ${made.model}`, ...made.notes].join("; ");
  if (!existsSync(file)) return write(file, made.text, `+ ${file} (${about})`);
  const now = read(file);
  if (now === made.text) return say(`= ${file} (${about})`);
  const was = parse(now).fm.adopted_from;
  if (!was && !FORCE) return say(`! ${file} exists and is not an adopted copy: kept (--force replaces it)`);
  if (was && was !== origin.base && !asked) return say(`! ${file} is adopted from ${was}, not ${origin.base}: kept`);
  write(file, made.text, `~ ${file} (${about}${was && was !== origin.base ? `; was adopted from ${was}` : ""})`);
}

// --adopt names agents: a wrong one stops the run before anything is written.
for (const a of ADOPT) {
  const harness = targets[0];
  const origin = findOrigin(harness, a.agent);
  const where = [...new Set([agentsDir(harness), join(HARNESSES[harness].dir, "agents")])].join(" or ");
  const refusal = origin ? compose(harness, a.role, a.name, origin).refusal : `no agent "${a.agent}" in ${where} (a file name without .md, or a name: line)`;
  if (refusal) {
    console.error(`--adopt ${a.agent}=${a.role}: ${refusal}.`);
    process.exit(1);
  }
  a.agent = origin.base;
}

// ---------------------------------------------------------------- hooks
// An entry is ours when it runs one of our hooks from a hooks/loop-engineering folder. Hooks with
// the same file names installed elsewhere belong to someone else and stay.
const OURS = new RegExp(`[\\\\/]hooks[\\\\/]loop-engineering[\\\\/](${HOOKS.map((h) => h.replace(".", "\\.")).join("|")})`);
const isOurs = (hook) => [hook?.command, ...(hook?.args ?? [])].some((s) => typeof s === "string" && OURS.test(s));
const hooksDir = (harness) => join(HARNESSES[harness].dir, "hooks", "loop-engineering");
const command = (harness, file) => `node "${join(hooksDir(harness), file)}" --harness ${harness}`;

function copyHook(harness, name) {
  const file = join(hooksDir(harness), name);
  const fresh = read(join(here, "hooks", name));
  // The hooks live in their own folder: always ours to overwrite.
  if (existsSync(file) && read(file) === fresh) return say(`= ${file}`);
  write(file, fresh, `${existsSync(file) ? "~" : "+"} ${file}`);
}

/** Claude Code: settings.json, groups of hooks per event. */
function claudeHooks(settings) {
  for (const event of Object.keys(settings.hooks ?? {})) {
    if (!Array.isArray(settings.hooks[event])) continue;
    settings.hooks[event] = settings.hooks[event]
      .map((group) => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter((h) => !isOurs(h)) } : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (UNINSTALL) {
    if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
    return;
  }
  const entry = (file, timeout) => ({ type: "command", command: command("claude", file), timeout });
  settings.hooks ??= {};
  (settings.hooks.PreToolUse ??= []).push({ matcher: "Agent", hooks: [entry("agent-guard.mjs", 10)] });
  (settings.hooks.SubagentStop ??= []).push({ hooks: [entry("subagent-audit.mjs", 10)] });
  settings.hooks.SubagentStop.push({ matcher: ANY_IMPLEMENTER, hooks: [entry("subagent-verify.mjs", 900)] });
  if (PERMISSIONS) {
    settings.permissions ??= {};
    settings.permissions.ask = [...new Set([...(settings.permissions.ask ?? []), ...ASK])];
  }
}

/** Cursor: hooks.json, a flat list of entries per event. */
function cursorHooks(config) {
  for (const event of Object.keys(config.hooks ?? {})) {
    if (!Array.isArray(config.hooks[event])) continue;
    config.hooks[event] = config.hooks[event].filter((entry) => !isOurs(entry));
    if (config.hooks[event].length === 0) delete config.hooks[event];
  }
  if (UNINSTALL) return;
  config.version ??= 1;
  config.hooks ??= {};
  (config.hooks.subagentStart ??= []).push({ command: command("cursor", "agent-guard.mjs"), timeout: 10, matcher: ANY_ROLE });
  (config.hooks.subagentStop ??= []).push({ command: command("cursor", "subagent-audit.mjs"), timeout: 10 });
  config.hooks.subagentStop.push({ command: command("cursor", "subagent-verify.mjs"), timeout: 900, matcher: ANY_IMPLEMENTER });
}

/** Our entries in a hook file's data, in a comparable form. */
function ourEntries(harness, data) {
  const out = [];
  for (const [event, list] of Object.entries(data?.hooks ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (harness === "cursor") {
        if (isOurs(item)) out.push(JSON.stringify({ event, ...item }));
      } else {
        for (const hook of Array.isArray(item?.hooks) ? item.hooks : []) {
          if (isOurs(hook)) out.push(JSON.stringify({ event, matcher: item.matcher ?? null, ...hook }));
        }
      }
    }
  }
  return out.sort();
}

function readJson(file) {
  if (!existsSync(file)) return { text: "", data: {} };
  const text = read(file);
  try {
    return { text, data: JSON.parse(text) };
  } catch (e) {
    console.error(`Cannot parse ${file}: ${e.message}. Fix it and run again.`);
    process.exit(1);
  }
}

function registerHooks(harness) {
  const file = join(HARNESSES[harness].dir, HARNESSES[harness].hookFile);
  const { text, data } = readJson(file);
  (harness === "claude" ? claudeHooks : cursorHooks)(data);
  const same = text !== "" && JSON.stringify(JSON.parse(text)) === JSON.stringify(data);
  if (same || (text === "" && UNINSTALL)) return say(`= ${file}`);
  const what = UNINSTALL ? "hook entries removed" : `hooks: agent-guard, subagent-audit, subagent-verify${PERMISSIONS && harness === "claude" ? "; permissions.ask" : ""}`;
  say(`~ ${file} (${what})`);
  if (DRY) return;
  if (text !== "") writeFileSync(`${file}.bak-loop-engineering`, text);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

// ---------------------------------------------------------------- --check
function check() {
  let problems = 0;
  const ok = (m) => console.log(`  ok    ${m}`);
  const warn = (m) => console.log(`  warn  ${m}`);
  const bad = (m) => {
    problems++;
    console.log(`  FAIL  ${m}`);
  };
  const again = (harness) => `node ${join(here, "install.mjs")} --target ${harness}${project ? ` --project ${project}` : ""}`;

  let found = 0;
  for (const harness of targets) {
    const { label, dir, hookFile } = HARNESSES[harness];
    const agents = Object.keys(ROLES).map((role) => ({ role, file: join(agentsDir(harness), `${ROLES[role].agent}.md`) }));
    const any = agents.some((a) => existsSync(a.file)) || (!project && existsSync(hooksDir(harness)));
    console.log(`${label} (${project ? agentsDir(harness) : dir})`);
    // Without --target, a harness that merely exists on the machine is not required.
    if (!any && target === null) {
      warn(`not installed. To install: ${again(harness)}`);
      continue;
    }
    found++;
    for (const { role, file } of agents) {
      const now = installed(harness, role, file);
      const name = ROLES[role].agent;
      if (!now) bad(`${name}: missing (${file})`);
      else if (now.fm.name !== name) bad(`${name}: ${file} declares name "${now.fm.name}"`);
      else {
        const model = now.fm.model ?? "none (follows the launching conversation)";
        ok(`${name}  model: ${model}${now.unedited ? "" : "  (text differs from the bundle: edited, or from another version)"}`);
      }
    }
    for (const name of LEGACY_AGENTS) {
      const file = join(agentsDir(harness), name);
      if (existsSync(file)) warn(`${file}: agent of an older version, no longer used. Delete it.`);
    }
    const copies = adoptedIn(agentsDir(harness));
    for (const { role, name, agent, file } of copies) {
      const type = `loop-${role}-${name}`;
      const origin = findOrigin(harness, agent);
      const made = origin && compose(harness, role, name, origin);
      if (!origin) warn(`${type}: its original, ${agent}, is gone. The copy still works; delete ${file} to drop the specialist.`);
      else if (made.refusal) warn(`${type}: ${made.refusal}. Delete ${file}, or change the original.`);
      else if (read(file) !== made.text) warn(`${type}: out of date with ${agent} or with the skill. To update: ${again(harness)}`);
      else ok(`${type}  model: ${made.model}  (adopted from ${made.called})`);
    }
    const taken = new Set(copies.map((c) => c.agent));
    const free = existsSync(agentsDir(harness))
      ? readdirSync(agentsDir(harness)).filter((f) => f.endsWith(".md") && !f.startsWith("loop-") && !taken.has(basename(f, ".md"))).map((f) => basename(f, ".md")).sort()
      : [];
    if (free.length > 0) console.log(`  note  your other agents here: ${free.join(", ")}. One can join the loop as a specialist: --adopt <agent>=<implementer|reviewer>[:<name>]`);
    if (project) continue;

    const stale = HOOK_FILES.filter((f) => !existsSync(join(hooksDir(harness), f)) || read(join(hooksDir(harness), f)) !== read(join(here, "hooks", f)));
    if (stale.length === 0) ok(`hooks: ${HOOK_FILES.length} files in ${hooksDir(harness)}`);
    else bad(`hooks: ${stale.join(", ")} missing or out of date in ${hooksDir(harness)}`);

    const file = join(dir, hookFile);
    const text = existsSync(file) ? read(file) : "";
    const missing = HOOKS.filter((h) => !text.includes(JSON.stringify(command(harness, h)).slice(1, -1)));
    const wanted = {};
    (harness === "claude" ? claudeHooks : cursorHooks)(wanted);
    if (missing.length > 0) bad(`${hookFile}: ${missing.map((h) => h.replace(".mjs", "")).join(", ")} not registered (${file})`);
    else if (ourEntries(harness, readJson(file).data).join("\n") !== ourEntries(harness, wanted).join("\n")) bad(`${hookFile}: the hook entries are out of date (${file})`);
    else ok(`${hookFile}: ${HOOKS.map((h) => h.replace(".mjs", "")).join(", ")} registered`);
    if (problems > 0) console.log(`  To repair: ${again(harness)}`);
  }
  console.log("Machine");
  if (found === 0 && target === null) bad("the agents and hooks are installed for no harness");
  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (git.status === 0) ok(git.stdout.trim());
  else bad("git: not found (the loop works in git worktrees)");
  // Cursor loads skills from all three folders: two different copies under one name collide.
  if (targets.includes("cursor")) {
    const copies = [".cursor", ".claude", ".agents"].map((d) => join(homedir(), d, "skills", "loop-engineering", "SKILL.md")).filter((f) => existsSync(f));
    const distinct = new Set(copies.map((f) => realpathSync(f)));
    const texts = new Set([...distinct].map((f) => read(f)));
    if (texts.size > 1) warn(`Cursor loads ${texts.size} different loop-engineering skills (${[...distinct].map((f) => dirname(f)).join(", ")}): keep one.`);
  }

  console.log(problems === 0 ? "Ready." : `Not ready: ${problems} problem${problems === 1 ? "" : "s"}.`);
  process.exit(problems === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- run
if (CHECK) check();

for (const harness of targets) {
  const { label } = HARNESSES[harness];
  say(`${label}${project ? ` (project ${project})` : ""}:`);
  for (const role of Object.keys(ROLES)) (UNINSTALL ? uninstallAgent : installAgent)(harness, role);
  legacyAgents(harness);
  if (UNINSTALL) for (const copy of adoptedIn(agentsDir(harness))) remove(copy.file, `- ${copy.file} (adopted from ${copy.agent})`);
  else for (const adoption of adoptions(harness)) installAdopted(harness, adoption);
  if (project) continue;
  if (UNINSTALL) {
    if (existsSync(hooksDir(harness))) remove(hooksDir(harness), `- ${hooksDir(harness)}`);
  } else {
    for (const name of HOOK_FILES) copyHook(harness, name);
  }
  registerHooks(harness);
  if (PERMISSIONS && harness === "cursor") say("! --with-permissions applies to Claude Code only");
}

const names = targets.map((h) => HARNESSES[h].label).join(" and ");
say(UNINSTALL ? `Done. Restart ${names}.` : `Done. Restart ${names} to load the new agents and hooks.`);
