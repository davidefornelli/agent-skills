---
name: loop-engineering
description: Claude Code only. Runs a plan through a closed loop of subagents until a reviewer passes it - a planner splits the work into packages and waves, implementers work in parallel in their own git worktrees, a reviewer verifies in two stages, the planner revises the plan from the verdict, and the fixes run again. Use when the user asks to execute a plan "in loop", with loop engineering, or with planner, implementers and reviewer. Not for small changes.
---

# Loop engineering (Claude Code)

The main session is the **orchestrator**: it launches the subagents, merges their branches, runs
the full verification once per wave and keeps the loop's state. Implementing and judging belong to
the subagents. The loop is tuned for an orchestrator on Opus, effort high: on a smaller model, tell
the user once and go on.

## When not to use it

A loop costs 3 to 5 times a direct implementation. Do the work directly, and say why, when:
- the change is small (one package, a few files);
- no acceptance criterion can be a command with an expected result;
- the work is exploratory (the design is still open) or the folder is not a git repository.

## Roles

| Role | Subagent type | Model (pinned in its frontmatter) | Writes |
| --- | --- | --- | --- |
| Orchestrator | the main session | Opus, effort high | the loop state, merges |
| Planner | `loop-planner` | Opus, effort high | the plan file |
| Implementer | `loop-implementer-sonnet`; `loop-implementer-opus` where the wave calculator says so | Sonnet / Opus, effort medium | its worktree and branch |
| Reviewer | `loop-reviewer` | Opus, effort high | the verdict file |

Launch these types without a `model` argument. Each agent's own file holds its role's rules: your
prompts carry the inputs listed below.

## Setup (once per machine)

When `~/.claude/agents/loop-planner.md` is missing, tell the user and, with their ok, run:

```bash
node <this skill's folder>/install.mjs    # --dry-run previews, --force overwrites changed agents,
                                          # --with-permissions, --uninstall
```

It copies the four agents to `~/.claude/agents` and three hooks to
`~/.claude/hooks/loop-engineering`, and registers the hooks in `~/.claude/settings.json` (backup:
`settings.json.bak-loop-engineering`). `--with-permissions` also adds `permissions.ask` for
`git push`, `npm publish`, `git reset --hard`, `git branch -D` and `git clean -f`. Claude Code must
be restarted afterwards. Requires `node` and `git`.

## Files

- **Plan**: the path the user gives, else `<repository>/plans/<slug>.md`. Its `json packages` block
  is the source of the waves.
- **State**: `<plan>.loop/state.md`. Create it at the start, update it after every step, read it
  first when you resume. It holds:
  - the lock: `Orchestrator: session <id>, since <time>, updated <time>`;
  - the plan's Execution setup as you use it (integration branch and worktree, start commit);
  - the round counter and, per wave, the rounds used and the limit;
  - per package: status (`todo`, `running`, `merged`, `passed`, `failed`), branch, worktree, base,
    agent id, last commit;
  - per wave: the commit each review stage has judged up to;
  - the verdict files, your own findings, and **Deferred findings** (the minor ones).
- **Verdicts**: `<plan>.loop/verdict-<round>-<stage>.md`.
- **Waves**: `node <this skill's folder>/plan-waves.mjs <plan> --done <merged and passed ids>`.
  Run it before every wave and execute its first wave, with the implementer it prints per package.
  `deferred` lines are informative; `error`, `blocked` or `unknown_scope` go back to the planner.

With a Datanotes MCP server connected (tools `plan_execution`, `start_task`), also follow
[references/datanotes.md](references/datanotes.md).

## One orchestrator at a time

Before launching anything, read the state file of the plan, and look for one written by another
tool for the same plan (e.g. Cursor's `~/.cursor/plans/*.loop/state.md`). A lock of another session
or a package `running`: ask the user, giving the lock's `updated` age. Two orchestrators on the
same worktrees destroy each other's work. When you take a loop over, run `git worktree list` and
`git status` in each package worktree first, and report uncommitted work before touching it. When
you stop, set the lock to `released` and running packages to `todo`.

## The loop

1. **Plan.** Without a plan file, launch `loop-planner` with the user's request, `PLAN: <absolute
   path>` and `WAVES: node <this skill's folder>/plan-waves.mjs`. Done when the wave calculator
   exits 0 on the plan with `--strict`.
2. **Contract.** On the first run of a plan, show the user the waves (packages, implementers), the
   Execution setup and the round limit (default 3 per wave), and wait for their ok. Then create the
   integration branch and its worktree from the start commit, and the state file.
3. **Execute the wave.** Per package: `git worktree add -b <branch> <path> <integration head>`,
   then the install step. A `failed` package that runs again keeps its worktree and branch. Launch
   one implementer per package, all in one message, in the background. Each prompt gives: the plan
   path, the package id, `WORKTREE: <absolute path>`, `BASE: <commit the branch started from>`,
   one `VERIFY: <command>` line per command of the plan's fast check (none when it is `auto` or
   `none`), the branch, the round, the commit trailer (the attribution lines your harness or the
   project asks for, else `none`) and, for a fix or a rerun, the findings to close with their ids.
4. **Read each status line.**
   - `DONE`: go on. `DONE_WITH_CONCERNS`: the concerns go into the reviewer's prompt.
   - `NEEDS_CONTEXT`: answer from the plan or the code and resume the same agent (`SendMessage`);
     ask the user what only they can answer.
   - `BLOCKED`: the package is `failed`; record your own finding (below) quoting the report.
5. **Integrate.** In the integration worktree, merge the wave's branches in the calculator's order
   (`git merge --no-ff <branch>`), marking each package `merged`. On a conflict: `git merge
   --abort`, the package is `failed`, record your finding. Then run the full verification once,
   with nothing else running (in the background when it is long). A red check goes to the reviewer
   as it is; one that passes when its files run alone is recorded as `environment`.
   Your own findings get the id `R<round>-C<n>`, severity blocker, cause `plan`, and the evidence
   (the conflicting files, the implementer's words).
6. **Review, two stages.** Launch `loop-reviewer` with `STAGE: spec`, `ROUND`, `PLAN`,
   `PACKAGES: <the wave's merged packages and their fixes>`, `WORKTREE: <integration worktree>`,
   `RANGE: <from>..<to>`, `VERDICT: <path>`, your notes (concerns, the verification's result) and,
   when earlier verdicts of the same stage and wave have open findings, `PREVIOUS: <their paths>`.
   RANGE is what that stage has not judged yet: the whole wave the first time, then the fix commits.
   - Spec FAIL: step 7 with that verdict.
   - Spec PASS: a new `loop-reviewer` with `STAGE: quality` and its own RANGE, VERDICT and
     PREVIOUS. Its verdict decides step 7.
7. **Decide.** Copy the verdicts' minor findings to Deferred findings, then:
   - PASS and no `failed` package: the wave's packages are `passed`. Next wave (step 3), or step 8
     when the calculator has none left.
   - Otherwise, with rounds left for this wave: launch `loop-planner` in revision mode (`PLAN`,
     `WAVES`, `ROUND`, `VERDICT: <each failing verdict>`, `MERGED: <merged and passed ids>`, your
     own findings). Rerun the calculator: fix packages come first, alone. Run them from step 3 with
     the round counter + 1. Rounds count across the whole loop, so finding ids stay unique; a wave
     and its fixes share one limit.
   - Stop and ask the user when: the wave's limit is reached; a finding is NOT ADDRESSED in two
     rounds in a row; a finding needs a decision only they can take.
8. **Final review.** One `loop-reviewer` with `STAGE: final`, `RANGE: <start commit>..<integration
   head>`, every package, and the Deferred findings. On FAIL: one revision by the planner, one fix
   wave through steps 3 to 6, then the report, with what is still open.
9. **Clean up.** For every `passed` package: `git worktree remove <path>` and `git branch -d
   <branch>`, both without force; whatever they refuse stays and goes into the report, like the
   `failed` packages. The integration branch and its worktree stay for the user. Release the lock.

## Guards

- Push, release, deploy and writes to live data or services belong to the user: the loop ends on
  the integration branch.
- Code changes come from implementers, verdicts from the reviewer, plan changes from the planner.
  A check you cannot get green goes back through the loop.
- One implementer per package; a merge conflict between two packages of a wave is a `plan` finding.
- Keep your own context small: read reports and verdicts, leave the diffs to the reviewer.
- The hooks back this up:
  - `agent-guard` (PreToolUse on Agent) refuses an implementer without `WORKTREE:` and `BASE:`, or
    a loop agent with a `model` that contradicts its role. Fix the cause it names and launch the
    same type again.
  - `subagent-verify` (SubagentStop on the implementers) runs the fast check on the changes since
    BASE (the `VERIFY:` lines, else `<worktree>/.claude/verify-fast`, else type check and `vitest
    related`) and sends the implementer back to fix a failure, at most twice. Log:
    `~/.claude/hooks/logs/subagent-verify.jsonl`.
  - `subagent-audit` (SubagentStop) writes one line per subagent to
    `~/.claude/hooks/logs/subagents.jsonl` (type, model, seconds, tool calls, `session`).

## Final report to the user

Per package: passed or not, the round it passed in, its commits. The open findings and the
deferred ones left. Rounds used; time and tool calls per role (the audit log's lines whose
`session` is yours). Worktrees and branches left behind. What waits for the user: the merge of the
integration branch, release, data migrations.
