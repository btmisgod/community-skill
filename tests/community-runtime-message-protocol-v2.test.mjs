import assert from "node:assert/strict";
import test from "node:test";

process.env.MESSAGE_PROTOCOL_V2 = "1";
process.env.WEBHOOK_RECEIPT_V2 = "1";

const runtime = await import("../assets/community-runtime-v0.mjs");

const state = {
  agentId: "agent-self",
  agentName: "Agent Self",
  groupId: "group-1",
  profile: {
    display_name: "Agent Self",
    handle: "agent-self",
  },
};

function baseAdapter() {
  return {
    async fetchRuntimeContext() {
      return { group_roles: [{ agent: "agent-self", role: "builder" }] };
    },
    async postCommunityMessage() {
      return { id: "reply-1" };
    },
    async loadWorkflowContract() {
      return { ok: true };
    },
    async loadGroupContext() {
      return { ok: true };
    },
    async handleProtocolViolation() {
      return { ok: true };
    },
    async generateReply() {
      return "generated reply";
    },
    buildFallbackReplyText() {
      return "fallback reply";
    },
  };
}

function eventFor(message, eventType = "message.posted") {
  return {
    event: { event_type: eventType, payload: { message } },
    entity: { message },
    group_id: message.group_id,
  };
}

test("targeted run message becomes required", async () => {
  const result = await runtime.handleRuntimeEvent(baseAdapter(), state, eventFor({
    id: "msg-1",
    group_id: "group-1",
    author: { agent_id: "agent-other" },
    flow_type: "run",
    message_type: "analysis",
    content: { text: "Please review this?" },
    relations: { thread_id: "thread-1", parent_message_id: null },
    routing: { target: { agent_id: "agent-self" }, mentions: [] },
    extensions: {},
  }));

  assert.equal(result.category, "run");
  assert.equal(result.obligation.obligation, "required");
  assert.equal(result.signals.targeted, true);
  assert.equal(result.posted, true);
});

test("visible non-targeted collaboration remains optional", async () => {
  const result = await runtime.handleRuntimeEvent(baseAdapter(), state, eventFor({
    id: "msg-2",
    group_id: "group-1",
    author: { agent_id: "agent-other" },
    flow_type: "start",
    message_type: "proposal",
    content: { text: "We should start a new round." },
    relations: {},
    routing: { target: null, mentions: [] },
    extensions: {},
  }));

  assert.equal(result.category, "start");
  assert.equal(result.obligation.obligation, "optional");
  assert.equal(result.signals.targeted, false);
});

test("non-targeted collaboration question is still observed only", async () => {
  const result = await runtime.handleRuntimeEvent(baseAdapter(), state, eventFor({
    id: "msg-2b",
    group_id: "group-1",
    author: { agent_id: "agent-other" },
    flow_type: "run",
    message_type: "analysis",
    content: { text: "Can anyone review this?" },
    relations: {},
    routing: { target: null, mentions: [] },
    extensions: {},
  }));

  assert.equal(result.category, "run");
  assert.equal(result.obligation.obligation, "optional");
  assert.equal(result.decision.action, "observe_only");
  assert.equal(result.posted, undefined);
});

test("status is treated as community facility semantics", async () => {
  const result = await runtime.handleRuntimeEvent(baseAdapter(), state, eventFor({
    id: "msg-3",
    group_id: "group-1",
    author: { agent_id: "agent-other" },
    flow_type: "status",
    message_type: "progress",
    content: { text: "I am online and syncing." },
    relations: {},
    routing: { target: null, mentions: [] },
    extensions: {},
  }));

  assert.equal(result.category, "status");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.signals.status, true);
});

test("group context update is observed without forced ack", async () => {
  const result = await runtime.handleRuntimeEvent(baseAdapter(), state, {
    event: { event_type: "group_context", payload: { group_id: "group-1" } },
    entity: { group_id: "group-1" },
    group_id: "group-1",
  });

  assert.equal(result.category, "group_context");
  assert.equal(result.obligation.obligation, "observe_only");
});

test("self message is observed only", async () => {
  const result = await runtime.handleRuntimeEvent(baseAdapter(), state, eventFor({
    id: "msg-4",
    group_id: "group-1",
    author: { agent_id: "agent-self" },
    flow_type: "run",
    message_type: "analysis",
    content: { text: "This is my own message." },
    relations: {},
    routing: { target: null, mentions: [] },
    extensions: {},
  }));

  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.signals.self_message, true);
});
