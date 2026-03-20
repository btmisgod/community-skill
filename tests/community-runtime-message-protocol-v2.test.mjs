import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

process.env.MESSAGE_PROTOCOL_V2 = "1";
process.env.WEBHOOK_RECEIPT_V2 = "1";

const runtime = await import("../assets/community-runtime-v0.mjs");
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const state = {
  agentId: "agent-self",
  agentName: "Agent Self",
  profile: {
    display_name: "Agent Self",
    handle: "agent-self",
  },
};

const runtimeContext = {
  channel_roles: [{ agent: "agent-self", role: "builder" }],
};

function baseAdapter() {
  return {
    async fetchRuntimeContext() {
      return runtimeContext;
    },
    async postCommunityMessage() {
      return { id: "reply-1" };
    },
    async executeTask() {
      return "task completed";
    },
    async loadWorkflowContract() {
      return { ok: true };
    },
    async loadChannelContext() {
      return { ok: true };
    },
    async handleProtocolViolation() {
      return { ok: true };
    },
    async decideResponse(obligation, mode) {
      if (mode === "self_message") {
        return { action: "observe_only", reason: "self_message_no_reply" };
      }
      if (obligation === "required") {
        return { action: mode === "task" ? "task_execution" : "brief_reply", reason: "required_obligation" };
      }
      if (obligation === "required_ack") {
        return { action: "ack", reason: "required_ack_obligation" };
      }
      if (obligation === "optional") {
        return {
          action: ["discussion", "decision", "chat"].includes(mode) ? "brief_reply" : "observe_only",
          reason: "optional_default",
        };
      }
      return { action: "observe_only", reason: "observe_only_default" };
    },
    async generateReply() {
      return "generated reply";
    },
    buildFallbackReplyText() {
      return "fallback reply";
    },
  };
}

function legacyEvent(message) {
  return {
    event: { event_type: "message.posted", payload: { message } },
    entity: { message },
    group_id: message.group_id,
  };
}

function v2MessageFromLegacy(message) {
  const metadata = message.content?.metadata || {};
  return {
    id: message.id,
    container: { group_id: message.group_id },
    author: { agent_id: message.agent_id },
    relations: {
      thread_id: message.thread_id || null,
      parent_message_id: message.parent_message_id || null,
      task_id: message.task_id || metadata.task_id || null,
    },
    body: { text: message.content?.text || null, blocks: [], attachments: [] },
    semantics: {
      kind: message.message_type || null,
      intent: message.content?.intent || metadata.intent || null,
      topic: metadata.topic || null,
    },
    routing: {
      target: {
        scope: metadata.target_agent_id ? "agent" : null,
        agent_id: metadata.target_agent_id || null,
        agent_label: metadata.target_agent || null,
      },
      mentions: Array.isArray(message.content?.mentions) ? message.content.mentions : [],
      assignees: Array.isArray(metadata.assignees) ? metadata.assignees : [],
    },
    extensions: {
      client_request_id: metadata.client_request_id || null,
      outbound_correlation_id: metadata.outbound_correlation_id || null,
      source: metadata.source || null,
      custom: metadata,
    },
  };
}

function v2Event(message) {
  return {
    event: { event_type: "message.posted", payload: { message } },
    entity: { message },
    group_id: message.container.group_id,
  };
}

async function evaluate(event) {
  return runtime.handleRuntimeEvent(baseAdapter(), state, event);
}

function summarize(result) {
  return {
    event: result.event,
    context: result.context,
    message: result.message,
    runtime: result.runtime,
  };
}

const fixtures = {
  discussion: {
    id: "msg-discussion",
    group_id: "group-1",
    agent_id: "agent-other",
    thread_id: "thread-1",
    message_type: "analysis",
    content: {
      text: "Need thoughts on this proposal.",
      metadata: { intent: "inform" },
    },
  },
  task: {
    id: "msg-task",
    group_id: "group-1",
    agent_id: "agent-other",
    task_id: "task-1",
    message_type: "proposal",
    content: {
      text: "@Agent Self please execute this task.",
      metadata: {
        intent: "request_action",
        target_agent_id: "agent-self",
        target_agent: "Agent Self",
        assignees: ["agent-self"],
      },
      mentions: [{ mention_type: "agent", mention_id: "agent-self", display_text: "@Agent Self" }],
    },
  },
  status: {
    id: "msg-status",
    group_id: "group-1",
    agent_id: "agent-other",
    message_type: "progress",
    content: { text: "Progress update." },
  },
  decision: {
    id: "msg-decision",
    group_id: "group-1",
    agent_id: "agent-other",
    message_type: "decision",
    content: { text: "We approve the proposal." },
  },
  self_echo: {
    id: "msg-self",
    group_id: "group-1",
    agent_id: "agent-self",
    message_type: "analysis",
    content: { text: "This is my own message." },
  },
  admin_message: {
    id: "msg-admin",
    group_id: "group-1",
    agent_id: "admin-user",
    message_type: "meta",
    content: { text: "Admin maintenance notice.", metadata: { system_event: true } },
  },
};

const snapshotPath = path.join(__dirname, "fixtures", "webhook-output-v2.snapshots.json");
const snapshots = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));

for (const [name, legacyMessage] of Object.entries(fixtures)) {
  test(`${name} legacy and v2 payloads produce the same Webhook Output V2 snapshot`, async () => {
    const legacyResult = summarize(await evaluate(legacyEvent(legacyMessage)));
    const v2Result = summarize(await evaluate(v2Event(v2MessageFromLegacy(legacyMessage))));

    assert.deepEqual(legacyResult, v2Result);
    assert.deepEqual(v2Result, snapshots[name]);
  });
}
