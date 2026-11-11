---
name: loop-engineering-setup
description: Sets up, checks and repairs what the loop-engineering skill needs on a machine - its subagents and hooks in Claude Code and Cursor, and the model of each role. Use when the user asks to install or configure loop engineering, to change the model of the planner, an implementer or the reviewer, to update or uninstall it, or when the loop reports it is not ready.
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
(`<file>.bak-loop-engineering`), and keeps the model of every agent already installed.

## Set up

1. **Check.** `node install.mjs --check`. Read which harness is installed, each role's model, and
   the `FAIL` and `warn` lines. Exit 0 and nothing the user wants changed: report and stop.
2. **Ask the user**, in one round, only what the check leaves open:
   - the harness: Claude Code, Cursor or both (default: each one found on the machine);
   - the model of each role (table below), or the defaults;
   - Cursor CLI (`cursor-agent`): the projects where they run loops from it;
   - Claude Code: whether to add the confirmation rules (`--with-permissions`).
3. **Preview.** Run the install command with `--dry-run` and show the lines that are not `=`.
   Lines: `+` new, `~` changed, `=` unchanged, `-` removed, `!` needs a decision (below).
4. **Install.** The same command without `--dry-run`, once per harness when models are given:
   `node install.mjs --target <claude|cursor> [--model <role>=<model> ...]`.
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
  with the models of the user's copies. Hooks stay in `~/.cursor`. Ask before adding files to a
  repository other people share.
- **Cursor sees two loop-engineering skills** (a `warn` of the check): Cursor reads
  `~/.cursor/skills`, `~/.claude/skills` and `~/.agents/skills`. Keep one copy; ask the user before
  deleting the other.
- **Confirmation rules.** `--with-permissions` adds `permissions.ask` in Claude Code for `git
  push`, `npm publish`, `git reset --hard`, `git branch -D` and `git clean -f`. Cursor has no
  equivalent here: there the loop's own rule (push and release belong to the user) is the only
  guard.
- **Uninstall.** `node install.mjs --uninstall [--target <harness>]` removes the hook entries, the
  hooks folder and the unedited agents; edited agents and `permissions.ask` stay.
- **The loop's agents do not appear after a restart.** `--check` again; in Claude Code look at
  `/agents`, in Cursor at the subagent list of a new chat. A project copy of an agent
  (`<project>/.claude/agents`, `<project>/.cursor/agents`) wins over the user's.
