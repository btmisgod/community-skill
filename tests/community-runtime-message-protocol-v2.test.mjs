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
    async loadWorkflowContract() {
      return { ok: true };
    },
    async loadGroupContext() {
      return { ok: true };
    },
    async handleProtocolViolation() {
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

test("targeted run message becomes required judgment", async () => {
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
  assert.equal(result.recommendation.mode, "needs_agent_judgment");
  assert.equal(result.posted, undefined);
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
  assert.equal(result.recommendation.mode, "agent_discretion");
});

test("non-targeted collaboration question stays optional judgment", async () => {
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
  assert.equal(result.recommendation.mode, "agent_discretion");
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
  assert.equal(result.recommendation.mode, "observe_only");
});

test("group context update is observed without forced ack", async () => {
  const result = await runtime.handleRuntimeEvent(baseAdapter(), state, {
    event: { event_type: "group_context", payload: { group_id: "group-1" } },
    entity: { group_id: "group-1" },
    group_id: "group-1",
  });

  assert.equal(result.category, "group_context");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.recommendation.mode, "observe_only");
});

test("group session update mounts session context and remains observe-only by default", async () => {
  const calls = [];
  const adapter = {
    ...baseAdapter(),
    async loadGroupSession(runtimeState, groupId, payload) {
      calls.push({ runtimeState, groupId, payload });
      return { ok: true };
    },
  };

  const result = await runtime.handleRuntimeEvent(adapter, state, {
    event: {
      event_type: "group_session.updated",
      payload: {
        group_session: {
          group_id: "group-1",
          current_stage: "step1",
          current_mode: "bootstrap_plus_content_output",
        },
        group_context: {
          group_id: "group-1",
        },
      },
    },
    entity: {
      group_session: {
        group_id: "group-1",
        current_stage: "step1",
      },
    },
    group_id: "group-1",
  });

  assert.equal(result.category, "group_session");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.recommendation.mode, "observe_only");
  assert.equal(result.context_group_id, "group-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].groupId, "group-1");
  assert.equal(calls[0].runtimeState.agentId, "agent-self");
  assert.equal(calls[0].payload.group_session.current_stage, "step1");
});

test("group session update falls back to canonical group context refresh when no session loader exists", async () => {
  const calls = [];
  const adapter = {
    ...baseAdapter(),
    async loadGroupContext(runtimeState, groupId, payload) {
      calls.push({ runtimeState, groupId, payload });
      return { ok: true };
    },
  };

  const result = await runtime.handleRuntimeEvent(adapter, state, {
    event: {
      event_type: "group_session.updated",
      payload: {
        group_session: {
          group_id: "group-1",
          current_stage: "step2",
          current_mode: "bootstrap_plus_content_output",
        },
        group_context: {
          group_id: "group-1",
          group_context_version: "ctx:v1",
          group_context: { scope: "partial-sync-view" },
        },
      },
    },
    entity: {
      group_session: {
        group_id: "group-1",
        current_stage: "step2",
      },
    },
    group_id: "group-1",
  });

  assert.equal(result.category, "group_session");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.recommendation.mode, "observe_only");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].groupId, "group-1");
  assert.equal(calls[0].runtimeState.agentId, "agent-self");
  assert.equal(calls[0].payload, null);
});

test("group session update can opt into manager control-turn through adapter hook", async () => {
  const adapter = {
    ...baseAdapter(),
    async loadGroupSession() {
      return { ok: true };
    },
    async resolveGroupSessionObligation(runtimeState, groupId, payload, signals) {
      assert.equal(runtimeState.agentId, "agent-self");
      assert.equal(groupId, "group-1");
      assert.equal(payload.group_session.current_stage, "step2");
      assert.equal(signals.group_scope, true);
      return { obligation: "required", reason: "server_manager_control_turn" };
    },
  };

  const result = await runtime.handleRuntimeEvent(adapter, state, {
    event: {
      event_type: "group_session.updated",
      payload: {
        group_session: {
          group_id: "group-1",
          current_stage: "step2",
          current_mode: "bootstrap_plus_content_output",
        },
      },
    },
    entity: {
      group_session: {
        group_id: "group-1",
        current_stage: "step2",
      },
    },
    group_id: "group-1",
  });

  assert.equal(result.category, "group_session");
  assert.equal(result.obligation.obligation, "required");
  assert.equal(result.obligation.reason, "server_manager_control_turn");
  assert.equal(result.recommendation.mode, "needs_agent_judgment");
  assert.equal(result.context_group_id, "group-1");
});

test("built-in manager control-turn marks manager as required without peer scripting", async () => {
  const runtimeState = {
    ...state,
    agentId: "manager-1",
  };
  const result = await runtime.handleRuntimeEvent(baseAdapter(), runtimeState, {
    event: {
      event_type: "group_session.updated",
      payload: {
        group_session: {
          group_id: "group-1",
          group_session_version: "group-session:v1",
          current_stage: "cycle.start",
          manager_agent_ids: ["manager-1"],
          manager_control_turn: {
            turn_id: "cycle.start:manager_done:group-session:v1",
            turn_type: "server_manager_control_turn",
            current_stage: "cycle.start",
            required_agent_ids: ["manager-1"],
            reason: "server_manager_control_turn",
            activation_version: "group-session:v1",
          },
        },
      },
    },
    entity: {
      group_session: {
        group_id: "group-1",
        current_stage: "cycle.start",
      },
    },
    group_id: "group-1",
  });

  assert.equal(result.category, "group_session");
  assert.equal(result.obligation.obligation, "required");
  assert.equal(result.obligation.reason, "server_manager_control_turn");
  assert.equal(result.recommendation.mode, "needs_agent_judgment");
  assert.equal(result.manager_control_turn.turn_type, "server_manager_control_turn");
});

test("built-in manager control-turn is deduped for the same turn id", async () => {
  const runtimeState = {
    ...state,
    agentId: "manager-1",
  };
  const event = {
    event: {
      event_type: "group_session.updated",
      payload: {
        group_session: {
          group_id: "group-1",
          group_session_version: "group-session:v2",
          current_stage: "cycle.start",
          manager_control_turn: {
            turn_id: "cycle.start:manager_done:group-session:v2",
            turn_type: "server_manager_control_turn",
            current_stage: "cycle.start",
            required_agent_ids: ["manager-1"],
            reason: "server_manager_control_turn",
            activation_version: "group-session:v2",
          },
        },
      },
    },
    entity: {
      group_session: {
        group_id: "group-1",
        current_stage: "cycle.start",
      },
    },
    group_id: "group-1",
  };

  const first = await runtime.handleRuntimeEvent(baseAdapter(), runtimeState, event);
  const second = await runtime.handleRuntimeEvent(baseAdapter(), runtimeState, event);

  assert.equal(first.obligation.obligation, "required");
  assert.equal(second.obligation.obligation, "observe_only");
  assert.equal(second.obligation.reason, "duplicate_server_manager_control_turn");
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
