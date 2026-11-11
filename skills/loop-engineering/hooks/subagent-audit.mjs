#!/usr/bin/env node
// SubagentStop hook (Claude Code) / subagentStop hook (Cursor): one line per finished subagent in
// <config>/hooks/logs/subagents.jsonl (harness, type, session, model, seconds, tool calls, the
// first line of its last message, transcript). Observation only: it never keeps the subagent going.
//
// Cursor passes duration and counts. Claude Code does not: they are read from the subagent's own
// transcript (agent_transcript_path).
import { existsSync, readFileSync } from "node:fs";
import { log, pass, start } from "./common.mjs";

const LOG = "subagents.jsonl";

/** Start, end, model and tool calls of a Claude Code subagent, from its JSONL transcript. */
function fromTranscript(path) {
  const out = { started_at: undefined, ended_at: undefined, model: undefined, tool_calls: 0 };
  if (!path || !existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.timestamp === "string") {
      out.started_at ??= rec.timestamp;
      out.ended_at = rec.timestamp;
    }
    const msg = rec.message;
    if (msg?.role === "assistant") {
      if (typeof msg.model === "string") out.model = msg.model;
      if (Array.isArray(msg.content)) out.tool_calls += msg.content.filter((b) => b?.type === "tool_use").length;
    }
  }
  return out;
}

const firstLine = (text) => (String(text ?? "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "").slice(0, 200);

const { input, harness } = start(LOG);
try {
  if (harness === "cursor") {
    log(LOG, {
      event: "stop",
      harness,
      type: input.subagent_type,
      session: input.parent_conversation_id ?? input.conversation_id,
      model: input.subagent_model ?? input.model,
      status: input.status,
      description: input.description,
      seconds: typeof input.duration_ms === "number" ? Math.round(input.duration_ms / 1000) : undefined,
      tool_calls: input.tool_call_count,
      messages: input.message_count,
      loop_count: input.loop_count,
      modified_files: Array.isArray(input.modified_files) ? input.modified_files.length : undefined,
      summary: firstLine(input.summary),
      transcript: input.agent_transcript_path,
    });
  } else {
    const t = fromTranscript(input.agent_transcript_path);
    log(LOG, {
      event: "stop",
      harness,
      type: input.agent_type,
      id: input.agent_id,
      session: input.session_id,
      model: t.model,
      started_at: t.started_at,
      ended_at: t.ended_at,
      seconds: t.started_at && t.ended_at ? Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000) : undefined,
      tool_calls: t.tool_calls,
      continued: input.stop_hook_active === true,
      summary: firstLine(input.last_assistant_message),
      transcript: input.agent_transcript_path,
    });
  }
} catch {
  // observation only: never break the subagent
}
pass();
