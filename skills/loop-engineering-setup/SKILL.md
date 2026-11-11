---
name: loop-engineering-setup
description: Sets up, checks and repairs what the loop-engineering skill needs on a machine - its subagents and hooks in Claude Code and Cursor, the model of each role, and the user's own agents adopted as specialists. Use when the user asks to install or configure loop engineering, to change the model of the planner, an implementer or the reviewer, to bring one of their agents into the loop as a specialist, to update or uninstall it, or when the loop reports it is not ready.
---

# Loop engineering: setup

Everything goes through one script, `install.mjs`, in the `loop-engineering` skill's folder (the
sibling of this skill's folder: `<this skill's folder>/../loop-engineering/install.mjs`). Without
that folder, the skill itself is missing: `npx skills add davidefornelli/agent-skills --skill
loop-engineering -g`, with `-a claude-code` or `-a cursor`. `node install.mjs --help` lists every
option; it needs `node` and `git`.

The script installs, per harness, four agents (`loop-planner`, `loop-implementer`,
`loop-implementer-senior`, `loop-reviewer`) into `<config>/agents` and three hooks into
`<config>/hooks/loop-engineering`, registered in `settings.json` (Claude Code, `~/.claude`) or
`hooks.json` (Cursor, `~/.cursor`). It touches only its own hook entries, backs the hook file up
(`<file>.bak-loop-engineering`), and keeps the model of every agent already installed. It also
writes the specialists: the user's own agents adopted into the loop (section Specialists).

## Set up

1. **Check.** `node install.mjs --check`. Read which harness is installed, each role's model, and
   the `FAIL` and `warn` lines. Exit 0 and nothing the user wants changed: report and stop.
2. **Ask the user**, in one round, only what the check leaves open:
   - the harness: Claude Code, Cursor or both (default: each one found on the machine);
   - the model of each role (table below), or the defaults;
   - Cursor CLI (`cursor-agent`): the projects where they run loops from it;
   - Claude Code: whether to add the confirmation rules (`--with-permissions`);
   - on a first install, the user's other agents (the check's `note` line): whether one joins the
     loop as a specialist.
3. **Preview.** Run the install command with `--dry-run` and show the lines that are not `=`.
   Lines: `+` new, `~` changed, `=` unchanged, `-` removed, `!` needs a decision (below).
4. **Install.** The same command without `--dry-run`, once per harness when models are given:
   `node install.mjs --target <claude|cursor> [--model <role>=<model> ...] [--adopt ...]`.
5. **Verify.** `node install.mjs --check --target <each harness set up>` exits 0 and prints the
   models the user chose. Then tell the user to restart the harness: agents and hooks load at
   start.

## Models

| Role | Agent | Wants | Claude Code default | Cursor default |
| --- | --- | --- | --- | --- |
| `planner` | `loop-planner` | the strongest model, high effort | `opus` | `inherit` |
| `implementer` | `loop-implementer` | a fast, cheaper model: most packages | `sonnet` | `inherit` |
| `senior` | `loop-implementer-senior` | a strong model: risky packages, second fixes | `opus` | `inherit` |
| `reviewer` | `loop-reviewer` | the strongest model, high effort | `opus` | `inherit` |

- Claude Code takes `opus`, `sonnet`, `haiku`, `inherit` or a full model id.
- Cursor takes `inherit` (the model of the conversation that launches the agent) or an id from
  `cursor-agent --list-models`. With `inherit` everywhere, `loop-implementer` and
  `loop-implementer-senior` run on the same model: offer the user two different ones.
- The choice is the `model:` line of `<config>/agents/<agent>.md`. Change one role later with
  `node install.mjs --target <harness> --model <role>=<model>`, or edit that line; in Claude Code
  the `effort:` line works the same way. A later install keeps both.
- A specialist runs on the `model:` of the agent it is adopted from: change it there.

## Specialists

A specialist is one of the user's own agents (a file in `<config>/agents`) adopted into the loop,
so a plan can give it packages (`"implementer": "frontend"`) or an extra review stage after
quality (`"review": ["security"]`). `--adopt <agent>=<implementer|reviewer>[:<name>]` writes
`loop-<role>-<name>.md` next to the original, which stays. The copy is generated: the role's rules
from the skill, then the original's text, model and tools. The original is the source: edits go
there, and every install run writes the copy again.

1. **Choose the role and the name.** Implementer: an agent that writes code in one area (frontend,
   migrations, CI). Reviewer: an agent that judges one aspect (security, accessibility,
   performance). The planner and the spec, quality and final stages stay the bundled agents'. The
   name is the word a plan will say: short, lowercase, the same in every harness. Taken:
   `standard`, `senior`, `sonnet`, `opus` for implementers; `spec`, `quality`, `final` for
   reviewers.
2. **Read the original and report conflicts** before adopting. In the copy the loop's rules win
   over the original's text, but the user should know what gets overruled, and front matter is
   copied as it is. Look for:
   - text that pushes, releases, deploys or writes to live services; that asks the user to
     confirm; that works on the main branch or picks its own folder; that launches subagents;
   - front matter that changes where or how the agent runs (`isolation`, `permissionMode`,
     `background`, `hooks`): the loop gives each implementer its worktree. The user removes the
     line from the original, or the agent stays out;
   - a description that does not say what the agent is for: the planner assigns work from it.
3. **Preview** with `--dry-run`. The installer refuses an implementer that cannot both edit files
   and run commands (adopt it as a reviewer), and says what it changes for a reviewer (`Bash` and
   `Write` added in Claude Code, `readonly` dropped in Cursor: it writes a verdict file). Show
   these lines to the user.
4. **Adopt** once per harness, then `--check`: `ok loop-<role>-<name>  model: …  (adopted from …)`.
   Restart the harness.

Later:
- **`warn` out of date**: the original or the skill changed. Run the install again.
- **`warn` its original is gone**: the copy still works. Restore the original, or delete the copy.
- **Drop a specialist**: delete `loop-<role>-<name>.md`. A plan that still names it falls back to
  the standard implementer, or skips the stage, and the loop tells the user.
- **Compare** a specialist with the bundled agents: `<config>/hooks/logs/subagents.jsonl` has one
  line per finished subagent (type, model, seconds, tool calls).

## Cases

- **`!` an agent differs from the bundled one.** The user edited it, or it comes from an older
  version. Show the difference (`diff <installed> <skill>/agents/<name>.md`, below the front
  matter). Edited on purpose: leave it. Otherwise add `--force`: it replaces the text and keeps the
  model.
- **`!` agents of an older version** (`loop-implementer-sonnet`, `loop-implementer-opus`): no
  longer used; `--force` deletes them. Plans that say `"implementer": "sonnet"` or `"opus"` still
  run, with a warning: the new values are `standard` and `senior`.
- **Update.** After updating the skill (`npx skills update`), run the set-up steps again: the check
  shows hooks out of date, the install refreshes them.
- **Cursor CLI.** `cursor-agent` loads subagents only from its workspace. Per project:
  `node install.mjs --target cursor --project <dir>` copies the agents to `<dir>/.cursor/agents`
  with the models of the user's copies, specialists included. Hooks stay in `~/.cursor`. Ask
  before adding files to a repository other people share.
- **Cursor sees two loop-engineering skills** (a `warn` of the check): Cursor reads
  `~/.cursor/skills`, `~/.claude/skills` and `~/.agents/skills`. Keep one copy; ask the user before
  deleting the other.
- **Confirmation rules.** `--with-permissions` adds `permissions.ask` in Claude Code for `git
  push`, `npm publish`, `git reset --hard`, `git branch -D` and `git clean -f`. Cursor has no
  equivalent here: there the loop's own rule (push and release belong to the user) is the only
  guard.
- **Uninstall.** `node install.mjs --uninstall [--target <harness>]` removes the hook entries, the
  hooks folder, the unedited agents and the adopted copies; edited agents, the user's own agents
  and `permissions.ask` stay.
- **The loop's agents do not appear after a restart.** `--check` again; in Claude Code look at
  `/agents`, in Cursor at the subagent list of a new chat. A project copy of an agent
  (`<project>/.claude/agents`, `<project>/.cursor/agents`) wins over the user's.
