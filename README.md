# agent-skills

Agent skills by Davide Fornelli, installable with [skills.sh](https://skills.sh).

## loop-engineering

For Claude Code and Cursor. Runs a plan through a closed loop of subagents until a reviewer passes
it: a planner splits the work into packages and waves, implementers work in parallel in their own
git worktrees, a reviewer verifies in two stages (spec, then quality), the planner revises the plan
from the verdict, and the fixes run again. It costs 3 to 5 times a direct implementation: it is
meant for large changes with checkable acceptance criteria, not for small ones.

```bash
# Claude Code (use -a cursor for Cursor)
npx skills add davidefornelli/agent-skills --skill loop-engineering --skill loop-engineering-setup -a claude-code -g
```

Cursor also reads `~/.claude/skills`: with both harnesses on one machine, install the skills once.

Then install the subagents and hooks the loop relies on (once per machine), and restart the
harness. Either ask the agent ("set up loop engineering": the `loop-engineering-setup` skill asks
which harness and which models, and verifies the result), or run the installer yourself:

```bash
cd ~/.claude/skills/loop-engineering    # installed with -a cursor: ~/.agents/skills/loop-engineering
node install.mjs --dry-run              # preview
node install.mjs                        # every harness found on the machine
node install.mjs --check                # what is installed, exit 0 when ready
```

| Installed | Claude Code | Cursor |
| --- | --- | --- |
| `loop-planner`, `loop-implementer`, `loop-implementer-senior`, `loop-reviewer` | `~/.claude/agents/` | `~/.cursor/agents/` |
| hooks `agent-guard`, `subagent-verify`, `subagent-audit` | `~/.claude/hooks/loop-engineering/` | `~/.cursor/hooks/loop-engineering/` |
| hook entries | `settings.json`: PreToolUse on Agent, SubagentStop | `hooks.json`: subagentStart, subagentStop |
| your specialists (`--adopt`): `loop-implementer-<name>`, `loop-reviewer-<name>` | `~/.claude/agents/` | `~/.cursor/agents/` |

### Choosing the models

The agents are named after their role, not after a model. Each role runs on the `model:` line of
its agent file, which you set with the installer or by hand; a later install keeps it.

| Role | Agent | Claude Code default | Cursor default |
| --- | --- | --- | --- |
| `planner` | `loop-planner` | `opus` | `inherit` |
| `implementer` | `loop-implementer` (most packages) | `sonnet` | `inherit` |
| `senior` | `loop-implementer-senior` (risky packages, second fixes) | `opus` | `inherit` |
| `reviewer` | `loop-reviewer` | `opus` | `inherit` |

```bash
node install.mjs --target claude --model implementer=haiku --model senior=sonnet
node install.mjs --target cursor --model planner=<id> --model implementer=<id>   # ids: cursor-agent --list-models
```

`inherit` follows the model of the conversation that launches the agent.

### Your own agents as specialists

An agent you already have (a frontend developer, a security auditor, a CI expert) can join the
loop next to the bundled ones, as an implementer the plan gives packages to or as an extra review
stage after quality:

```bash
node install.mjs --target claude --adopt frontend-dev=implementer:frontend
node install.mjs --target claude --adopt security-auditor=reviewer:security
```

Each `--adopt <agent>=<role>[:<name>]` writes a generated copy, `loop-implementer-frontend` or
`loop-reviewer-security`, next to your agent, which stays as it is. The copy is the role's rules
from the skill (worktree, commits, report, verdict format) followed by your agent's text, with its
model and tools; where the two disagree, the loop's rules win. Your agent stays the source: edit
it, run the installer again, and the copy follows (`--check` warns when it is out of date). The
planner sees the specialists and assigns them in the plan; the planner itself and the spec,
quality and final reviews stay the bundled agents. To drop a specialist, delete its file.

Before anything is launched, the loop shows you the waves with each package's implementer and the
extra review stages, and waits for your ok. A plan that names a specialist the harness does not
have still runs: the standard implementer takes the package, or the review stage is skipped. The
loop says so with a `fallback:` line, both when it asks for your ok and in its final report.

To compare a specialist with the bundled agents, read the final report: it gives the time and the
tool calls per agent type. The numbers come from `hooks/logs/subagents.jsonl` in `~/.claude` or
`~/.cursor`, one line per finished subagent (type, model, seconds, tool calls).

The `loop-engineering-setup` skill does the same and first reads the agent for instructions that
fight the loop (pushing, asking the user for confirmation, its own worktree isolation).

Other options: `--project <dir>` copies only the agents, specialists included, into a project (`<dir>/.cursor/agents` or
`<dir>/.claude/agents`; the Cursor CLI loads subagents only from its workspace), `--force` replaces
agents you edited (keeping their model) and deletes those of older versions, `--with-permissions`
adds `permissions.ask` in Claude Code for `git push`, `npm publish`, `git reset --hard`, `git
branch -D` and `git clean -f`, `--uninstall` removes the hooks, their entries, the unedited
agents and the adopted copies. The installer touches only its own hook entries and backs the hook file up first. Requires
`node` and `git`.

### Waves without a task tracker

The plan is one Markdown file. Its packages sit in a fenced `json packages` block, and
`plan-waves.mjs` (no dependencies) turns them into the execution order:

````markdown
```json packages
[
  { "id": "P1", "title": "Add the parser", "touches": ["src/parser.ts"], "blocked_by": [] },
  { "id": "P2", "title": "Use the parser in the CLI", "touches": ["src/cli.ts"], "blocked_by": ["P1"], "implementer": "senior" },
  { "id": "P3", "title": "Docs", "touches": ["docs/**"], "priority": "low" },
  { "id": "P4", "title": "Login form", "touches": ["web/login/**"], "implementer": "frontend", "review": ["security"] }
]
```
````

```bash
node ~/.claude/skills/loop-engineering/plan-waves.mjs plans/my-plan.md            # all the waves
node ~/.claude/skills/loop-engineering/plan-waves.mjs plans/my-plan.md --done P1  # what is next
```

```text
plans/my-plan.md: 4 packages, 0 done, 4 to run in 2 waves
wave 1:
  P1  Add the parser  [loop-implementer]
  P4  Login form  [loop-implementer-frontend]
  P3  Docs  [loop-implementer, low]
  review after quality: loop-reviewer-security on P4
wave 2:
  P2  Use the parser in the CLI  [loop-implementer-senior]
```

A package waits for its `blocked_by`; two packages whose `touches` overlap (same file, a directory
and a file in it, matching globs) never share a wave; `priority` orders a wave; a package with
`fixes` repairs another one and runs before anything else; `"implementer": "senior"` sends a
package to the senior implementer, and so does the second fix of the same package;
`"implementer": "<name>"` sends it to a specialist and `"review": ["<name>"]` adds a specialist's
review stage, which the package's fixes inherit. `--agents <types|none>` says which specialists
the harness has: a missing one becomes a `fallback:` line (the standard implementer runs the
package, the stage is skipped). `--json` gives the same result to a program, `--strict` refuses
packages without `touches`.

### The implementers' fast check

When an implementer stops, a hook runs a fast check in its worktree and sends it back to fix a
failure. The check is, in order: the commands the plan names (passed as `VERIFY:` lines), the
commands in `<worktree>/.claude/verify-fast` or `<worktree>/.cursor/verify-fast` (one per line), or
`tsc` plus `vitest related` when the project uses them. After two failed attempts the implementer
stops and the reviewer sees the result.
