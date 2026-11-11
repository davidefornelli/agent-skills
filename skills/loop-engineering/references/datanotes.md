# The plan in Datanotes (optional)

Only with a Datanotes MCP server connected (tools `create_task`, `plan_execution`, `start_task`,
`end_run`). Datanotes then mirrors the plan in its task table and records who ran what. The plan
file stays the source: its `json packages` block decides the waves, as in the skill.

1. After the planner writes the file, create the **plan task**: `kind: plan`, `repo` (the
   repository name), title = the goal, body = the path of the plan file and the integration branch;
   link the project if there is one.
2. One **sub-task per package**, `parent` = the plan task, title `P<n>: <what it does>`, `touches`
   and `blocked_by` copied from the `json packages` block, body = objective and acceptance criteria.
3. Run `plan_execution` on the plan task and compare its waves with `plan-waves.mjs`. They read the
   same data: a difference means the sub-tasks drifted from the block. Correct the sub-tasks.
4. Open the orchestrator's run with `start_task` on the plan task (`agent_session` =
   `$CLAUDE_CODE_SESSION_ID`), after binding the session to it when a `bind-task` skill exists.
5. Each implementer prompt also carries `TASK: <sub-task path>` and the instruction to call
   `start_task` on it at the start (declaring `model` and `harness`, `parent_run` = the
   orchestrator's run) and `end_run` at the end (outcome, branch, one-line summary). When an
   implementer cannot reach Datanotes, record the run for it.
6. When a wave passes: `complete_task` on its packages' sub-tasks. The planner's fix packages
   become new sub-tasks (same fields, `blocked_by` as in the block). When every package has passed:
   `complete_task` on the plan task and `end_run`.
