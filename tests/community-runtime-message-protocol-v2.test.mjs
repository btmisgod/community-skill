import assert from "node:assert/strict";
import test from "node:test";

const runtime = await import("../assets/community-runtime-v0.mjs");

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const SELF_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const THREAD_ID = "44444444-4444-4444-8444-444444444444";
const PARENT_ID = "55555555-5555-4555-8555-555555555555";

const state = {
  agentId: SELF_ID,
  agentName: "Agent Self",
  groupId: GROUP_ID,
  profile: {
    display_name: "Agent Self",
    handle: "agent-self",
  },
};

function runtimeContext() {
  return {
    agent_protocol: {
      protocol_version: "ACP-003",
      applicable_rule_ids: ["profile.self_declare.required"],
    },
    group_protocol: {
      version: "ACP-003",
      layers: {
        group: {
          name: "Public Lobby Group Protocol",
        },
      },
    },
    group_context: {
      group_id: GROUP_ID,
      group_slug: "public-lobby",
    },
    mounted_at: "2026-04-13T00:00:00.000Z",
  };
}

function baseAdapter(spy = {}) {
  return {
    async loadGroupContext(...args) {
      spy.groupContext = args;
      return { ok: true };
    },
    async loadGroupProtocol(...args) {
      spy.groupProtocol = args;
      return { ok: true };
    },
    async handleProtocolViolation(...args) {
      spy.protocolViolation = args;
      return { ok: true };
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

test("targeted run message becomes required judgment and carries mounted protocol context", async () => {
  const result = await runtime.handleRuntimeEvent(
    baseAdapter(),
    state,
    eventFor({
      id: PARENT_ID,
      group_id: GROUP_ID,
      author: { agent_id: OTHER_ID },
      flow_type: "run",
      message_type: "analysis",
      content: { text: "Please review this?" },
      relations: { thread_id: THREAD_ID, parent_message_id: null },
      routing: { target: { agent_id: SELF_ID }, mentions: [] },
      extensions: {},
    }),
    runtimeContext(),
  );

  assert.equal(result.category, "run");
  assert.equal(result.obligation.obligation, "required");
  assert.equal(result.signals.targeted, true);
  assert.equal(result.recommendation.mode, "needs_agent_judgment");
  assert.equal(result.protocol_mount.agent_protocol.protocol_version, "ACP-003");
  assert.equal(result.protocol_mount.group_context.group_id, GROUP_ID);
});

test("visible non-targeted collaboration remains optional", async () => {
  const result = await runtime.handleRuntimeEvent(
    baseAdapter(),
    state,
    eventFor({
      id: PARENT_ID,
      group_id: GROUP_ID,
      author: { agent_id: OTHER_ID },
      flow_type: "start",
      message_type: "proposal",
      content: { text: "We should start a new round." },
      relations: {},
      routing: { target: null, mentions: [] },
      extensions: {},
    }),
    runtimeContext(),
  );

  assert.equal(result.category, "start");
  assert.equal(result.obligation.obligation, "optional");
  assert.equal(result.signals.targeted, false);
  assert.equal(result.recommendation.mode, "agent_discretion");
});

test("status is treated as community facility semantics", async () => {
  const result = await runtime.handleRuntimeEvent(
    baseAdapter(),
    state,
    eventFor({
      id: PARENT_ID,
      group_id: GROUP_ID,
      author: { agent_id: OTHER_ID },
      flow_type: "status",
      message_type: "progress",
      content: { text: "I am online and syncing." },
      relations: {},
      routing: { target: null, mentions: [] },
      extensions: {},
    }),
    runtimeContext(),
  );

  assert.equal(result.category, "status");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.signals.status, true);
  assert.equal(result.recommendation.mode, "observe_only");
});

test("group context update is observed and delegated to the adapter", async () => {
  const spy = {};
  const result = await runtime.handleRuntimeEvent(
    baseAdapter(spy),
    state,
    {
      event: { event_type: "group_context", payload: { message: { group_id: GROUP_ID } } },
      entity: { message: { group_id: GROUP_ID } },
      group_id: GROUP_ID,
    },
    runtimeContext(),
  );

  assert.equal(result.category, "group_context");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.ok(Array.isArray(spy.groupContext));
  assert.equal(spy.groupContext[1], GROUP_ID);
});

test("group protocol update is observed and delegated to the adapter", async () => {
  const spy = {};
  const result = await runtime.handleRuntimeEvent(
    baseAdapter(spy),
    state,
    {
      event: { event_type: "group_protocol", payload: { message: { group_id: GROUP_ID } } },
      entity: { message: { group_id: GROUP_ID } },
      group_id: GROUP_ID,
    },
    runtimeContext(),
  );

  assert.equal(result.category, "group_protocol");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.ok(Array.isArray(spy.groupProtocol));
  assert.equal(spy.groupProtocol[1], GROUP_ID);
});

test("protocol violation stays observe-only and calls the adapter hook", async () => {
  const spy = {};
  const result = await runtime.handleRuntimeEvent(
    baseAdapter(spy),
    state,
    {
      event: { event_type: "protocol_violation", payload: { group_id: GROUP_ID, violation_type: "missing_target" } },
      entity: { group_id: GROUP_ID },
      group_id: GROUP_ID,
    },
    runtimeContext(),
  );

  assert.equal(result.category, "protocol_violation");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.ok(Array.isArray(spy.protocolViolation));
  assert.equal(spy.protocolViolation[0].agentId, SELF_ID);
});

test("self message is observed only", async () => {
  const result = await runtime.handleRuntimeEvent(
    baseAdapter(),
    state,
    eventFor({
      id: PARENT_ID,
      group_id: GROUP_ID,
      author: { agent_id: SELF_ID },
      flow_type: "run",
      message_type: "analysis",
      content: { text: "This is my own message." },
      relations: { thread_id: THREAD_ID, parent_message_id: PARENT_ID },
      routing: { target: null, mentions: [] },
      extensions: {},
    }),
    runtimeContext(),
  );

  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.signals.self_message, true);
});
