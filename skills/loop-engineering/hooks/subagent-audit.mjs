#!/usr/bin/env node
// SubagentStop hook: one line per finished subagent in ~/.claude/hooks/logs/subagents.jsonl
// (type, id, model, start and end, seconds, tool calls, the first line of its last message,
// transcript). Observation only: it prints nothing and never keeps the subagent going.
//
// Ported from an equivalent Cursor hook. Claude Code's input has no duration or counts, so
// they are read from the subagent's own transcript (agent_transcript_path).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_FILE = join(homedir(), ".claude", "hooks", "logs", "subagents.jsonl");

/** Start, end, model and tool calls of a subagent, from its JSONL transcript. */
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

try {
  const input = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "") || "{}");
  const t = fromTranscript(input.agent_transcript_path);
  const seconds = t.started_at && t.ended_at ? Math.round((Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000) : undefined;
  const firstLine = String(input.last_assistant_message ?? "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  mkdirSync(dirname(LOG_FILE), { recursive: true });
  appendFileSync(
    LOG_FILE,
    JSON.stringify({
      at: new Date().toISOString(),
      event: "stop",
      type: input.agent_type,
      id: input.agent_id,
      session: input.session_id,
      model: t.model,
      started_at: t.started_at,
      ended_at: t.ended_at,
      seconds,
      tool_calls: t.tool_calls,
      continued: input.stop_hook_active === true,
      summary: firstLine.slice(0, 200),
      transcript: input.agent_transcript_path,
    }) + "\n",
  );
} catch {
  // observation only: never break the subagent
}
process.exit(0);
