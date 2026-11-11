#!/usr/bin/env node
// Computes the execution waves of a plan from its package list. No dependencies.
//
// The plan (Markdown) holds exactly one fenced block whose info string is `json packages`:
//
//   ```json packages
//   [
//     { "id": "P1", "title": "Add the parser", "touches": ["src/parser.ts"], "blocked_by": [] },
//     { "id": "P2", "title": "Use the parser", "touches": ["src/cli.ts"], "blocked_by": ["P1"],
//       "implementer": "senior", "priority": "high" },
//     { "id": "P3", "title": "Fix R1-2", "touches": ["src/parser.ts"], "fixes": "P1" }
//   ]
//   ```
//
// Fields: id and title (required); blocked_by (ids that must be done first); touches (the files
// the package owns: paths relative to the repository, a directory, or a glob); implementer
// (`standard`, the default, or `senior`: which of the two implementer agents runs it; the model of
// each agent is set where the agents are installed); priority (`urgent`, `high`, `medium`, `low`);
// fixes (the id of the package this one repairs).
//
// Rules:
// - a wave holds packages that can run in parallel; a package waits for its blocked_by;
// - two packages whose touches overlap never share a wave: the later one moves to the next wave
//   (reported under `deferred`);
// - inside a wave: priority first (urgent, high, medium, low; none counts as medium), then id;
// - whatever waits for a package also waits for the packages that fix it, and while fix packages
//   are ready the wave holds only them;
// - the second fix of the same package runs on the senior implementer (`escalated`).
//
// Usage: node plan-waves.mjs <plan.md> [--done P1,P2] [--json] [--strict]
//   --done    packages already merged into the integration branch: they are left out and count
//             as satisfied dependencies. The first wave printed is the next one to run.
//   --json    machine-readable output
//   --strict  a package without touches is an error (the planner validates with this)
// Exit code: 0 the plan is runnable, 1 the plan has errors, 2 wrong usage or unreadable file.
import { readFileSync } from "node:fs";

const PRIORITIES = ["urgent", "high", "medium", "low"];
const IMPLEMENTERS = ["standard", "senior"];
// Plans written before the implementers were named after their role, not their model.
const OLD_IMPLEMENTERS = { sonnet: "standard", opus: "senior" };
const FIELDS = new Set(["id", "title", "blocked_by", "touches", "implementer", "priority", "fixes"]);

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node plan-waves.mjs <plan.md> [--done P1,P2] [--json] [--strict]");
  process.exit(2);
}

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
let planPath;
let asJson = false;
let strict = false;
const done = new Set();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") asJson = true;
  else if (a === "--strict") strict = true;
  else if (a === "--done") {
    const value = argv[++i];
    if (value === undefined) usage("--done needs a list of ids, e.g. --done P1,P2");
    for (const id of value.split(/[\s,]+/).filter(Boolean)) done.add(id);
  } else if (a.startsWith("--done=")) {
    for (const id of a.slice(7).split(/[\s,]+/).filter(Boolean)) done.add(id);
  } else if (a === "-h" || a === "--help") usage();
  else if (a.startsWith("-")) usage(`Unknown option ${a}`);
  else if (planPath === undefined) planPath = a;
  else usage(`Unexpected argument ${a}`);
}
if (!planPath) usage("Give the plan file.");

let text;
try {
  text = readFileSync(planPath, "utf8");
} catch (e) {
  usage(`Cannot read ${planPath}: ${e.message}`);
}

// ---------------------------------------------------------------- the block
const errors = [];
const warnings = [];

function readPackages() {
  const blocks = [...text.matchAll(/^[ \t]*(`{3,}|~{3,})[ \t]*json[ \t]+packages[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*$/gm)];
  if (blocks.length === 0) {
    errors.push("No package list: the plan needs one fenced block that opens with ```json packages");
    return [];
  }
  if (blocks.length > 1) {
    errors.push(`${blocks.length} \`json packages\` blocks: keep one list (add new packages to it)`);
    return [];
  }
  let list;
  try {
    list = JSON.parse(blocks[0][2]);
  } catch (e) {
    errors.push(`The \`json packages\` block is not valid JSON: ${e.message}`);
    return [];
  }
  if (!Array.isArray(list)) {
    errors.push("The `json packages` block must be an array of packages");
    return [];
  }
  return list;
}

const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim() !== "");

/** One touches entry, comparable: forward slashes, no leading `./`, no trailing `/`. */
function normalize(path) {
  let p = path.trim().replaceAll("\\", "/").replace(/^(\.\/)+/, "").replace(/\/+/g, "/");
  if (p.length > 1) p = p.replace(/\/$/, "");
  return p;
}

const packages = [];
const byId = new Map();
readPackages().forEach((raw, index) => {
  const where = `package ${index + 1}`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return errors.push(`${where}: must be an object`);
  if (typeof raw.id !== "string" || raw.id.trim() === "") return errors.push(`${where}: needs a string "id"`);
  const id = raw.id.trim();
  if (/[\s,]/.test(id)) return errors.push(`${id}: an id cannot contain spaces or commas`);
  if (byId.has(id)) return errors.push(`${id}: duplicate id`);
  if (typeof raw.title !== "string" || raw.title.trim() === "") errors.push(`${id}: needs a "title"`);
  for (const key of Object.keys(raw)) if (!FIELDS.has(key)) warnings.push(`${id}: unknown field "${key}" ignored`);
  for (const key of ["blocked_by", "touches"]) {
    if (raw[key] !== undefined && !strings(raw[key])) errors.push(`${id}: "${key}" must be an array of non-empty strings`);
  }
  let implementer = raw.implementer;
  if (Object.hasOwn(OLD_IMPLEMENTERS, implementer)) {
    warnings.push(`${id}: "implementer": "${implementer}" is the old name of "${OLD_IMPLEMENTERS[implementer]}": write that`);
    implementer = OLD_IMPLEMENTERS[implementer];
  }
  if (implementer !== undefined && !IMPLEMENTERS.includes(implementer)) {
    errors.push(`${id}: "implementer" must be ${IMPLEMENTERS.join(" or ")}`);
  }
  if (raw.priority !== undefined && !PRIORITIES.includes(raw.priority)) {
    errors.push(`${id}: "priority" must be one of ${PRIORITIES.join(", ")}`);
  }
  if (raw.fixes !== undefined && (typeof raw.fixes !== "string" || raw.fixes.trim() === "")) {
    errors.push(`${id}: "fixes" must be the id of one package`);
  }
  const pkg = {
    id,
    title: typeof raw.title === "string" ? raw.title.trim() : "",
    blocked_by: strings(raw.blocked_by) ? [...new Set(raw.blocked_by.map((s) => s.trim()))] : [],
    touches: strings(raw.touches) ? [...new Set(raw.touches.map(normalize))] : [],
    implementer: IMPLEMENTERS.includes(implementer) ? implementer : "standard",
    priority: PRIORITIES.includes(raw.priority) ? raw.priority : null,
    fixes: typeof raw.fixes === "string" && raw.fixes.trim() !== "" ? raw.fixes.trim() : null,
    index,
  };
  byId.set(id, pkg);
  packages.push(pkg);
});

for (const p of packages) {
  for (const b of p.blocked_by) {
    if (b === p.id) errors.push(`${p.id}: is blocked by itself`);
    else if (!byId.has(b)) errors.push(`${p.id}: blocked_by names "${b}", which is not a package of this plan`);
  }
  if (p.fixes !== null) {
    if (p.fixes === p.id) errors.push(`${p.id}: fixes itself`);
    else if (!byId.has(p.fixes)) errors.push(`${p.id}: fixes names "${p.fixes}", which is not a package of this plan`);
  }
}
for (const id of done) if (!byId.has(id)) errors.push(`--done names "${id}", which is not a package of this plan`);

// ---------------------------------------------------------------- fixes
// The packages a fix repairs, nearest first (P9 fixes P4, P4 fixes P1 → [P4, P1]); null on a cycle.
function repaired(p) {
  const chain = [];
  let at = p;
  while (at.fixes !== null && byId.has(at.fixes)) {
    if (at.fixes === p.id || chain.includes(at.fixes)) return null;
    chain.push(at.fixes);
    at = byId.get(at.fixes);
  }
  return chain;
}
const fixersOf = new Map(); // id → the packages that fix it, directly or through another fix
for (const p of packages) {
  p.repairs = repaired(p);
  if (p.repairs === null) {
    if (p.fixes !== p.id) errors.push(`${p.id}: its "fixes" chain is a cycle`);
    p.repairs = [];
  }
  for (const id of p.repairs) {
    if (!fixersOf.has(id)) fixersOf.set(id, []);
    fixersOf.get(id).push(p);
  }
}
for (const p of packages) {
  // Whatever waits for a package also waits for its fixes. A fix does not wait for the other
  // fixes of what it repairs, unless it names them.
  const waits = new Set(p.blocked_by.filter((b) => byId.has(b) && b !== p.id));
  for (const b of [...waits]) {
    if (p.repairs.includes(b)) continue;
    for (const f of fixersOf.get(b) ?? []) if (f.id !== p.id) waits.add(f.id);
  }
  p.waits = waits;
  // The second fix of the same package goes to the stronger implementer.
  const origin = p.repairs.at(-1);
  p.escalated = origin !== undefined && fixersOf.get(origin).some((f) => f.id !== p.id && done.has(f.id));
  if (p.escalated) p.implementer = "senior";
}

// ---------------------------------------------------------------- overlap of touches
const isGlob = (s) => /[*?[\]{}]/.test(s);
const insideOrSame = (path, dir) => path === dir || path.startsWith(dir + "/") || dir === "." || dir === "";

// The directory part of a glob before its first wildcard: src/a/**/*.ts → src/a
function fixedPrefix(glob) {
  const parts = glob.split("/");
  const fixed = [];
  for (const part of parts) {
    if (isGlob(part)) break;
    fixed.push(part);
  }
  return fixed.join("/");
}

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|\\[\]]/g, "\\$&")).join("|")})`;
        i = end;
      }
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end === -1) re += "\\[";
      else {
        re += glob.slice(i, end + 1);
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\\]}]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

// The literal extension a glob ends with (src/**/*.ts → .ts), or null.
const extension = (glob) => /\.[A-Za-z0-9]+$/.exec(glob)?.[0] ?? null;
const looksLikeDirectory = (path) => !/\.[^/.]+$/.test(path.split("/").pop());

/**
 * Do two touches entries name a common file? Errs on the side of yes: a wrong yes costs one wave,
 * a wrong no lets two implementers edit the same file.
 */
function overlap(a, b) {
  const ga = isGlob(a);
  const gb = isGlob(b);
  if (!ga && !gb) return insideOrSame(a, b) || insideOrSame(b, a);
  if (ga && gb) {
    const pa = fixedPrefix(a);
    const pb = fixedPrefix(b);
    if (!insideOrSame(pa, pb) && !insideOrSame(pb, pa)) return false;
    const ea = extension(a);
    const eb = extension(b);
    return !(ea && eb && ea !== eb);
  }
  const [glob, path] = ga ? [a, b] : [b, a];
  if (globToRegExp(glob).test(path)) return true;
  const prefix = fixedPrefix(glob);
  if (insideOrSame(prefix, path)) return true; // the path is a directory above the glob
  return looksLikeDirectory(path) && insideOrSame(path, prefix); // a directory the glob may reach into
}

function sharedTouches(p, q) {
  const shared = [];
  for (const a of p.touches) for (const b of q.touches) if (overlap(a, b)) shared.push(a === b ? a : `${a} ~ ${b}`);
  return shared;
}

// ---------------------------------------------------------------- waves
const natural = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const rank = (p) => PRIORITIES.indexOf(p.priority ?? "medium");
const order = (a, b) => rank(a) - rank(b) || natural.compare(a.id, b.id) || a.index - b.index;

const waves = [];
const deferred = [];
const blocked = [];
const cycles = [];
let remaining = packages.filter((p) => !done.has(p.id));
const unknownScope = remaining.filter((p) => p.touches.length === 0).map((p) => p.id);

if (errors.length === 0) {
  const satisfied = new Set(done);
  while (remaining.length > 0) {
    let ready = remaining.filter((p) => [...p.waits].every((w) => satisfied.has(w))).sort(order);
    if (ready.length === 0) break;
    if (ready.some((p) => p.fixes !== null)) ready = ready.filter((p) => p.fixes !== null);
    const wave = [];
    for (const p of ready) {
      const clash = wave.map((q) => ({ q, on: sharedTouches(p, q) })).find((c) => c.on.length > 0);
      if (clash) deferred.push({ id: p.id, from_wave: waves.length + 1, with: clash.q.id, on: clash.on });
      else wave.push(p);
    }
    waves.push(wave);
    for (const p of wave) satisfied.add(p.id);
    remaining = remaining.filter((p) => !satisfied.has(p.id));
  }
  if (remaining.length > 0) {
    // What is left waits on a cycle: name the cycles, then who waits behind them.
    const left = new Map(remaining.map((p) => [p.id, p]));
    const state = new Map();
    const inCycle = new Set();
    const stack = [];
    const visit = (id) => {
      state.set(id, 1);
      stack.push(id);
      for (const w of left.get(id).waits) {
        if (!left.has(w)) continue;
        if (state.get(w) === 1) {
          const loop = stack.slice(stack.indexOf(w));
          if (!loop.every((x) => inCycle.has(x))) cycles.push([...loop, w]);
          for (const x of loop) inCycle.add(x);
        } else if (!state.has(w)) visit(w);
      }
      stack.pop();
      state.set(id, 2);
    };
    for (const id of left.keys()) if (!state.has(id)) visit(id);
    for (const p of remaining) {
      blocked.push({ id: p.id, waits_for: [...p.waits].filter((w) => left.has(w)), in_cycle: inCycle.has(p.id) });
    }
    for (const loop of cycles) errors.push(`Cycle: ${loop.join(" → ")}`);
  }
  // A deferral is only worth reporting with the wave the package landed in.
  for (const d of deferred) d.to_wave = waves.findIndex((w) => w.some((p) => p.id === d.id)) + 1;
}
if (strict && unknownScope.length > 0) {
  errors.push(`Without touches (cannot be checked for parallel work): ${unknownScope.join(", ")}`);
}

// ---------------------------------------------------------------- output
const agentOf = (p) => (p.implementer === "senior" ? "loop-implementer-senior" : "loop-implementer");
const result = {
  plan: planPath,
  packages: packages.length,
  done: [...done].filter((id) => byId.has(id)),
  waves: waves.map((wave, i) => ({
    wave: i + 1,
    packages: wave.map((p) => ({
      id: p.id,
      title: p.title,
      agent: agentOf(p),
      ...(p.escalated ? { escalated: true } : {}),
      ...(p.fixes ? { fixes: p.fixes } : {}),
      ...(p.priority ? { priority: p.priority } : {}),
      touches: p.touches,
    })),
  })),
  deferred,
  blocked,
  cycles,
  unknown_scope: unknownScope,
  warnings,
  errors,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const toRun = waves.reduce((n, w) => n + w.length, 0);
  console.log(`${planPath}: ${packages.length} packages, ${result.done.length} done, ${toRun} to run in ${waves.length} wave${waves.length === 1 ? "" : "s"}`);
  for (const [i, wave] of waves.entries()) {
    console.log(`wave ${i + 1}:`);
    for (const p of wave) {
      const notes = [agentOf(p), p.escalated ? "escalated" : null, p.fixes ? `fixes ${p.fixes}` : null, p.priority].filter(Boolean);
      console.log(`  ${p.id}  ${p.title}  [${notes.join(", ")}]`);
    }
  }
  for (const d of deferred) console.log(`deferred: ${d.id} from wave ${d.from_wave} to wave ${d.to_wave}, overlaps ${d.with} on ${d.on.join(", ")}`);
  for (const b of blocked) console.log(`blocked: ${b.id}${b.in_cycle ? " (in a cycle)" : ""} waits for ${b.waits_for.join(", ")}`);
  if (unknownScope.length > 0) console.log(`unknown_scope: ${unknownScope.join(", ")} (no touches: give each the files it owns)`);
  for (const w of warnings) console.log(`warning: ${w}`);
  for (const e of errors) console.log(`error: ${e}`);
}
process.exit(errors.length > 0 ? 1 : 0);
