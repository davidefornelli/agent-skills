# agent-skills

Agent skills by Davide Fornelli, installable with [skills.sh](https://skills.sh).

## loop-engineering

For Claude Code. Runs a plan through a closed loop of subagents until a reviewer passes it: a
planner splits the work into packages and waves, implementers work in parallel in their own git
worktrees, a reviewer verifies in two stages (spec, then quality), the planner revises the plan
from the verdict, and the fixes run again. It costs 3 to 5 times a direct implementation: it is
meant for large changes with checkable acceptance criteria, not for small ones.

```bash
npx skills add davidefornelli/agent-skills --skill loop-engineering -a claude-code -g
```

Then install the subagents and hooks it relies on (once per machine), and restart Claude Code:

```bash
node ~/.claude/skills/loop-engineering/install.mjs    # --dry-run previews
```

| Installed | Where |
| --- | --- |
| `loop-planner`, `loop-implementer-sonnet`, `loop-implementer-opus`, `loop-reviewer` | `~/.claude/agents/` |
| `agent-guard` (PreToolUse on Agent), `subagent-verify`, `subagent-audit` (SubagentStop) | `~/.claude/hooks/loop-engineering/` + `settings.json` |

Options: `--force` overwrites agents you edited, `--with-permissions` also adds `permissions.ask`
for `git push`, `npm publish`, `git reset --hard`, `git branch -D` and `git clean -f`,
`--uninstall` removes the hooks, their entries in `settings.json` and the unedited agents.
Requires `node` and `git`.

### Waves without a task tracker

The plan is one Markdown file. Its packages sit in a fenced `json packages` block, and
`plan-waves.mjs` (no dependencies) turns them into the execution order:

````markdown
```json packages
[
  { "id": "P1", "title": "Add the parser", "touches": ["src/parser.ts"], "blocked_by": [] },
  { "id": "P2", "title": "Use the parser in the CLI", "touches": ["src/cli.ts"], "blocked_by": ["P1"], "implementer": "opus" },
  { "id": "P3", "title": "Docs", "touches": ["docs/**"], "priority": "low" }
]
```
````

```bash
node ~/.claude/skills/loop-engineering/plan-waves.mjs plans/my-plan.md            # all the waves
node ~/.claude/skills/loop-engineering/plan-waves.mjs plans/my-plan.md --done P1  # what is next
```

```text
plans/my-plan.md: 3 packages, 0 done, 3 to run in 2 waves
wave 1:
  P1  Add the parser  [loop-implementer-sonnet]
  P3  Docs  [loop-implementer-sonnet, low]
wave 2:
  P2  Use the parser in the CLI  [loop-implementer-opus]
```

A package waits for its `blocked_by`; two packages whose `touches` overlap (same file, a directory
and a file in it, matching globs) never share a wave; `priority` orders a wave; a package with
`fixes` repairs another one and runs before anything else. `--json` gives the same result to a
program, `--strict` refuses packages without `touches`.

### The implementers' fast check

When an implementer stops, a hook runs a fast check in its worktree and sends it back to fix a
failure. The check is, in order: the commands the plan names (passed as `VERIFY:` lines), the
commands in `<worktree>/.claude/verify-fast` (one per line), or `tsc` plus `vitest related` when
the project uses them.

The Datanotes integration (`references/datanotes.md`) is optional and used only when a Datanotes
MCP server is connected.
