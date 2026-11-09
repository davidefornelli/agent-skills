---
name: loop-engineering
description: Runs a plan through a closed loop of subagents until a reviewer passes it - implementers (Sonnet 5.5, effort medium) work in parallel in their own worktrees, a reviewer (Opus) verifies in two stages, the planner (Opus) revises the plan from the verdict, and the implementers run again. Use when the user asks to execute a plan "in loop", with loop engineering, or with planner, implementers and reviewer.
---

# Loop engineering (Claude Code)

The main session is the orchestrator and runs on Opus, effort high. It never implements and never judges: it launches the
subagents, merges branches, runs the full verification once per wave and keeps the loop's state.

## Setup (once per machine)

The loop needs four subagents and three hooks that a skill installer does not place. If
`~/.claude/agents/planner.md`, `implementer-sonnet.md`, `opus-implementer.md` or `reviewer.md` is
missing, tell the user and, with their ok, run from this skill's folder:

```bash
node <this skill's folder>/install.mjs   # --dry-run to preview, --force to overwrite agents
```

It copies the agents to `~/.claude/agents`, the hooks to `~/.claude/hooks/loop-engineering`, adds
them to `~/.claude/settings.json` (backup in `settings.json.bak-loop-engineering`) and adds
`permissions.ask` for push, publish and destructive git commands. Claude Code must be restarted
afterwards. Requires `node` and `git`.

| Role | Subagent type (`~/.claude/agents`) | Model pinned in the frontmatter | Writes |
| --- | --- | --- | --- |
| Orchestrator | the main session | Opus, effort high | only the loop state |
| Planner | `planner` | Opus, effort high | only the plan file |
| Implementer | `implementer-sonnet` (default) or `opus-implementer` when the user asks | Sonnet / Opus, effort medium | its worktree and branch |
| Reviewer | `reviewer` | Opus, effort high | only the verdict file |

Never pass `model` to the Agent tool for these types: the frontmatter pins it, and the
`agent-guard` hook refuses a contradicting one. Never use built-in agents for these roles.

## Inputs

- The plan file (absolute path). Without one, run the planner first on the user's request.
- Optional: the packages or waves to run (default: all not done), the round limit (default 3).

## Optional: the plan in Datanotes

Only when a Datanotes MCP server is connected (tools `create_task`, `plan_execution`, `start_task`,
`end_run`); otherwise skip this section, the state file below is enough. With Datanotes, the
plan's structure lives in its task table, not only in the Markdown file; the file stays the
detailed document for the implementers.

1. After the planner writes the file, create the **plan task**: `kind: plan`, `repo` (the repository
   name, e.g. `my-app`), title = the goal, body = the path of the plan file and the
   integration branch; link the project if there is one.
2. One **sub-task per package**, `parent` = the plan task, title `P<n>: <what it does>` (verb in the
   infinitive), `touches` = the files it owns (paths relative to the repo, exactly the plan's owned
   files), `blocked_by` = the packages it depends on, body = objective and acceptance criteria.
3. Run **`plan_execution`** on the plan task: its waves are the execution order. Compare them with the
   planner's proposal; a difference (a conflict on `touches`, a missing `blocked_by`) is a `plan`
   question for the planner, not something to bypass. `unknown_scope` items must get `touches`.
4. Bind the session to the plan task (`bind-task` skill, if installed) and open the orchestrator's run with
   `start_task` (`agent_session` = `$CLAUDE_CODE_SESSION_ID`).
5. Each implementer prompt carries `TASK: <sub-task path>` and the instruction: `start_task` on it at
   the start (declare `model` and `harness`, `parent_run` = the orchestrator's run) and `end_run` at the
   end (outcome, branch, one-line summary). If an implementer cannot reach Datanotes, the orchestrator
   records the run for it (declared model and harness).
6. After the review: PASS → `complete_task` on the package's sub-task; FAIL → the planner's fix packages
   become new sub-tasks (`P<n>` continuing the numbering, `blocked_by` as needed) and `plan_execution`
   gives the next wave. When every package is done, `complete_task` on the plan task and `end_run`.

The state file below stays: it holds the lock, the rounds and the verdict paths.

## The state file and the lock

Next to the plan: `<plan>.loop/state.md`. Create it at the start, update it after every step, read
it first when you resume. It holds:
- `Orchestrator: claude-code, session <id>, since <time>` (the lock) and the round and its limit;
- per package: status (`todo`, `running`, `done`, `failed`), branch, worktree, base, agent id,
  last commit;
- the verdict files of each round (`<plan>.loop/verdict-<round>-spec.md`,
  `<plan>.loop/verdict-<round>-quality.md`) and the plan revisions.

**One orchestrator at a time.** Before launching anything, look for another state file of the same
plan, including one written by another tool (e.g. Cursor's `~/.cursor/plans/*.loop/state.md` whose
`Source` or `Plan` names this plan). If one shows packages `running` or another orchestrator's lock, stop and ask the user: two
orchestrators on the same worktrees destroy each other's work. When you stop, set the lock to
`released` and running packages back to `todo` (or `failed`).

## The loop

1. **Contract.** Read the plan. On the first run of a plan, show the user the first wave
   (packages, worktrees, branches, bases) and wait for an ok. Every package needs an observable
   acceptance criterion (a command and its expected result); if one has none, ask the planner to
   add it: a loop is only as good as its check.
2. **Execute a wave.** For each package, prepare its worktree and branch from the integration
   branch as the plan says (`git worktree add -b <branch> <path> <base>`, then the install step).
   Launch one implementer per package, all in one message, in the background. Each prompt gives:
   the plan path (and the source specification it builds on, if any), the package ids, a line
   `WORKTREE: <absolute path>`, a line `BASE: <commit the branch started from>`, the branch, the
   round, the commit trailer, "commit when the acceptance criteria pass", and in rounds above 1
   the verdict findings to fix. The `WORKTREE:` and `BASE:` lines are required: the
   `agent-guard` hook refuses the launch without them, and the SubagentStop hook on the implementers
   (`~/.claude/hooks/loop-engineering/subagent-verify.mjs`; the fast check is
   `<worktree>/.claude/verify-fast`, one command per line, or tsc + `vitest related` when detected) uses them to run the fast check on the changes since
   BASE and to send the implementer back to fix a failure (at most twice).
3. **Handle the status line** of each implementer:
   - `DONE`: go on.
   - `DONE_WITH_CONCERNS`: correctness or scope concerns go into the reviewer's prompt.
   - `NEEDS_CONTEXT`: answer from the plan or the code and resume the same agent (`SendMessage`).
     If only the user can answer, ask the user.
   - `BLOCKED`: the package is `failed` for this round; the reviewer and the planner deal with it.
   Never fix code yourself.
4. **Integrate.** Merge the wave's branches into the integration branch in the plan's order. Run
   the project's full verification once, on the merged result, with nothing else running (in the
   background when it is long). A conflict or a red check is recorded for the reviewer, not fixed
   by hand. A failure that passes when its files run alone is recorded as `environment`.
5. **Review, in two stages.** Launch one `reviewer` with: `stage: spec`, the plan path, the wave's
   packages, the integration branch and worktree, the round, the verdict path
   `<plan>.loop/verdict-<round>-spec.md`, and these rules: judge outcomes, not the implementers'
   reports; `spec` = does the code do what the plan asked, no less and no more (criteria with own
   evidence, steps, owned files only); each finding has an id `R<round>-<n>`, package, severity
   (blocker, major, minor), cause (`execution`, `plan` quoting the passage, or `environment`) and
   evidence; only blocker and major findings fail a package.
   - Spec FAIL: go to step 6 with that verdict; the quality stage does not run.
   - Spec PASS: launch a new `reviewer` with `stage: quality` (regressions, compatibility,
     performance, security, project rules, weak or skipped tests, dead code, names, error
     messages; no reopening what the plan decided) and the path
     `<plan>.loop/verdict-<round>-quality.md`. Its verdict decides step 6.
6. **Decide.**
   - Overall PASS: mark the packages `done`. Next wave (step 2), or finish when none is left.
   - FAIL and round < limit: launch the `planner` in revision mode (plan path, verdict path,
     round: it revises the plan and writes fix packages). Run them from step 2, round + 1.
   - Stop and ask the user when: the round limit is reached; a finding came back twice or needs a
     user decision; two rounds in a row end with the same failed findings; a step would be
     irreversible (push, release, deploy, live data).

## Guards

- No push, no release, no deploy, no write to live data or services inside the loop.
- The reviewer never edits code; an implementer never approves its own work.
- One implementer per package; two parallel packages never share a file (a merge conflict is a
  `plan` finding).
- Keep your own context small: read reports and verdicts, not whole diffs.
- Hooks back these rules up:
  - `agent-guard` (PreToolUse on Agent): refuses an implementer without `WORKTREE:`, or a role on
    the wrong model. Fix the cause it names; never route the work to a built-in agent.
  - `subagent-verify` (SubagentStop on the implementer types, in settings): the fast check after each
    implementer. Its log is `~/.claude/hooks/logs/subagent-verify.jsonl`.
  - `permissions.ask` in `~/.claude/settings.json`: asks the user before `git push`,
    `npm publish`, `git reset --hard`, `git branch -D` and `git clean -f`.
  - `subagent-audit` (SubagentStop): one line per subagent in
    `~/.claude/hooks/logs/subagents.jsonl` (type, model, start, end, seconds, tool calls): read it
    for the final report.

## Final report to the user

Per package: done or not, round in which it passed, commits. The open findings. Rounds used, time
and tool calls per role (from the audit log). What waits for the user (merges to main, release,
data migrations).
