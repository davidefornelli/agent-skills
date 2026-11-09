# agent-skills

Agent skills by Davide Fornelli, installable with [skills.sh](https://skills.sh).

## loop-engineering

Runs a plan through a closed loop of Claude Code subagents until a reviewer passes it:
implementers work in parallel in their own git worktrees, a reviewer verifies in two stages
(spec, then quality), the planner revises the plan from the verdict, and the implementers run again.

```bash
npx skills add davidefornelli/agent-skills --skill loop-engineering -a claude-code -g
```

Then install the subagents and hooks it relies on (once per machine), and restart Claude Code:

```bash
node ~/.claude/skills/loop-engineering/install.mjs            # --dry-run to preview
```

| Installed | Where |
| --- | --- |
| `planner`, `implementer-sonnet`, `opus-implementer`, `reviewer` | `~/.claude/agents/` |
| `agent-guard` (PreToolUse on Agent), `subagent-verify`, `subagent-audit` (SubagentStop) | `~/.claude/hooks/loop-engineering/` + `settings.json` |
| `permissions.ask` for `git push`, `npm publish`, `git reset --hard`, `git branch -D`, `git clean -f` | `settings.json` |

Requires `node` and `git`. The Datanotes integration in the skill is optional and used only when a
Datanotes MCP server is connected.

The implementers' fast check runs the commands in `<worktree>/.claude/verify-fast` (one per line),
or `tsc` plus `vitest related` when the project uses them.
