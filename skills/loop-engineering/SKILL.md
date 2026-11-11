---
name: loop-engineering
description: Runs a plan through a closed loop of subagents until a reviewer passes it - a planner splits the work into packages and waves, implementers work in parallel in their own git worktrees, a reviewer verifies in two stages, the planner revises the plan from the verdict, and the fixes run again. For Claude Code and Cursor. Use when the user asks to execute a plan "in loop", with loop engineering, or with planner, implementers and reviewer. Not for small changes.
---

# Loop engineering

The main session is the **orchestrator**: it launches the subagents, merges their branches, runs
the full verification once per wave and keeps the loop's state. Implementing and judging belong to
the subagents. The orchestrator needs a strong model at high effort: on a smaller one, tell the
user once and go on.

## When not to use it

A loop costs 3 to 5 times a direct implementation. Do the work directly, and say why, when:
- the change is small (one package, a few files);
- no acceptance criterion can be a command with an expected result;
- the work is exploratory (the design is still open) or the folder is not a git repository.

## Roles

| Role | Subagent type | Writes |
| --- | --- | --- |
| Orchestrator | the main session | the loop state, merges |
| Planner | `loop-planner` | the plan file |
| Implementer | the type the wave calculator prints per package: `loop-implementer`, `loop-implementer-senior` or a specialist `loop-implementer-<name>` | its worktree and branch |
| Reviewer | `loop-reviewer`; a specialist `loop-reviewer-<name>` per extra stage the calculator prints | the verdict file |

Each role's model is the `model:` line of its agent file: launch these types without a model
argument. Each agent's own file holds its role's rules: your prompts carry the inputs listed below.

**Specialists** are the user's own agents adopted into the loop (the `loop-engineering-setup`
skill does it): the `loop-implementer-<name>` and `loop-reviewer-<name>` types your subagent tool
offers. The plan assigns packages and extra review stages to them.

## Your harness

The loop is the same in Claude Code and Cursor. Where the steps below say *launch*, *resume*,
*session id* or `<config>`, use your harness's column:

| | Claude Code | Cursor |
| --- | --- | --- |
| Launch a subagent | `Agent` tool, `subagent_type` | `Task` tool, `subagent_type` |
| In the background | `run_in_background: true` | `run_in_background: true` |
| Resume the same agent | `SendMessage` to its agent id | `Task` with `resume` = its agent id |
| Session id | `$CLAUDE_CODE_SESSION_ID` | `$CURSOR_CONVERSATION_ID` |
| `<config>` | `~/.claude` | `~/.cursor` |
| Harness name in the lock | `claude-code` | `cursor` |

## Setup (once per machine and harness)

Before the first launch of a session, run `node <this skill's folder>/install.mjs --check`. Exit 0:
go on. Otherwise show the user its output and set the machine up with the `loop-engineering-setup`
skill (without it: the repair command the check prints, with the user's ok), then ask the user to
restart the harness. When your subagent tool does not offer the `loop-*` types after that, release
the lock and stop: the roles run on these agents only.

## Files

- **Plan**: the path the user gives, else `<repository>/plans/<slug>.md`. Its `json packages` block
  is the source of the waves.
- **State**: `<plan>.loop/state.md`. Create it at the start, update it after every step, read it
  first when you resume. It holds:
  - the lock: `Orchestrator: <harness name>, session <id>, since <time>, updated <time>`;
  - the plan's Execution setup as you use it (integration branch and worktree, start commit);
  - the round counter and, per wave, the rounds used and the limit;
  - per package: status (`todo`, `running`, `merged`, `passed`, `failed`), branch, worktree, base,
    agent id, last commit;
  - per wave: its extra review stages (agent, packages) and the commit each review stage has
    judged up to;
  - the verdict files, your own findings, and **Deferred findings** (the minor ones).
- **Verdicts**: `<plan>.loop/verdict-<round>-<stage>.md`.
- **Waves**: `node <this skill's folder>/plan-waves.mjs <plan> --done <merged and passed ids>
  --agents <the specialist types your subagent tool offers, comma-separated, or none>`.
  Run it before every wave and execute its first wave, with the implementer it prints per package;
  a `review after quality:` line is an extra review stage of that wave (step 6).
  `deferred` lines are informative; `error`, `blocked` or `unknown_scope` go back to the planner.
  A `fallback:` line is a specialist the plan names and this harness lacks: the package runs on
  `loop-implementer`, the stage is skipped. Tell the user, in the contract and in the final report.

## One orchestrator at a time

A Claude Code session and a Cursor session can hand a loop over to each other through the state
file. Before launching anything, read the state file of the plan, and look for another one of the
same plan (`~/.claude/plans/*.loop/state.md`, `~/.cursor/plans/*.loop/state.md`). A lock of another
session or a package `running`: ask the user, giving the lock's `updated` age. Two orchestrators on
the same worktrees destroy each other's work. When you take a loop over, run `git worktree list`
and `git status` in each package worktree first, and report uncommitted work before touching it.
When you stop, set the lock to `released` and running packages to `todo`.

## The loop

1. **Plan.** Without a plan file, launch `loop-planner` with the user's request, `PLAN: <absolute
   path>`, `WAVES: node <this skill's folder>/plan-waves.mjs` and `SPECIALISTS:` followed by one
   line per specialist type, with its description (`SPECIALISTS: none` without any). Done when the
   wave calculator exits 0 on the plan with `--strict`.
2. **Contract.** On the first run of a plan, show the user the waves (packages, implementers,
   extra review stages, `fallback:` lines), the Execution setup and the round limit (default 3 per
   wave), and wait for their ok. Then create the integration branch and its worktree from the
   start commit, and the state file.
3. **Execute the wave.** Per package: `git worktree add -b <branch> <path> <integration head>`,
   then the install step. A `failed` package that runs again keeps its worktree and branch. Launch
   one implementer per package, all in one message, in the background. Each prompt gives: the plan
   path, the package id, `WORKTREE: <absolute path>`, `BASE: <commit the branch started from>`,
   one `VERIFY: <command>` line per command of the plan's fast check (none when it is `auto` or
   `none`), the branch, the round, the commit trailer (the attribution lines your harness or the
   project asks for, else `none`) and, for a fix or a rerun, the findings to close with their ids.
4. **Read each status line.**
   - `DONE`: go on. `DONE_WITH_CONCERNS`: the concerns go into the reviewer's prompt.
   - `NEEDS_CONTEXT`: answer from the plan or the code and resume the same agent; ask the user
     what only they can answer.
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
     PREVIOUS. On FAIL: step 7 with that verdict.
   - Quality PASS: the wave's extra stages, one after the other. A stage runs when it has not
     passed yet, or when the calculator printed it for the fix wave just merged. Launch the
     stage's agent (`loop-reviewer-<stage>`) with `STAGE: <stage>`, `PACKAGES: <the stage's
     packages and their fixes>` and its own RANGE, VERDICT and PREVIOUS. Every stage runs; step 7
     gets all their verdicts.
7. **Decide.** Copy the verdicts' minor findings to Deferred findings, then:
   - Every verdict PASS and no `failed` package: the wave's packages are `passed`. Next wave
     (step 3), or step 8 when the calculator has none left.
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
- The hooks back this up (logs in `<config>/hooks/logs/`):
  - `agent-guard`, at the launch of a loop agent, refuses an implementer (specialists included)
    without `WORKTREE:` and `BASE:`, and a model argument that contradicts the agent file. Fix
    the cause it names and launch the same type again.
  - `subagent-verify`, when an implementer stops, runs the fast check on the changes since BASE
    (the `VERIFY:` lines, else `<worktree>/.claude/verify-fast` or `.cursor/verify-fast`, else type
    check and `vitest related`) and sends the implementer back to fix a failure, at most twice.
    Log: `subagent-verify.jsonl`.
  - `subagent-audit` writes one line per finished subagent to `subagents.jsonl` (harness, type,
    model, seconds, tool calls, `session`).

## Final report to the user

Per package: passed or not, the round it passed in, its commits. The open findings and the
deferred ones left. Rounds used; time and tool calls per agent type (the audit log's lines whose
`session` is yours): with specialists, that is their comparison with the bundled agents. The
`fallback:` lines. Worktrees and branches left behind. What waits for the user: the merge of the
integration branch, release, data migrations.
