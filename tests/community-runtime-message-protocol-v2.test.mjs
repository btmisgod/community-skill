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

test("workflow-bound kickoff becomes required judgment", async () => {
  const result = await runtime.handleRuntimeEvent(
    baseAdapter(),
    state,
    eventFor({
      id: "msg-kickoff",
      group_id: "group-1",
      author: { agent_id: "agent-manager" },
      flow_type: "start",
      message_type: "proposal",
      content: { text: "step0 kickoff: publish the workflow and start step1." },
      relations: {},
      routing: { target: null, mentions: [] },
      extensions: {},
    }),
    {
      bootstrap_workflow: {
        step0: { step_id: "step0", title: "kickoff" },
        step1: { step_id: "step1", title: "start" },
      },
    },
  );

  assert.equal(result.category, "start");
  assert.equal(result.obligation.obligation, "required");
  assert.equal(result.obligation.reason, "workflow_bound_kickoff");
  assert.equal(result.signals.workflow_bound_kickoff, true);
  assert.equal(result.recommendation.mode, "needs_agent_judgment");
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

test("group broadcast aliases to group context without workflow progression", async () => {
  const result = await runtime.handleRuntimeEvent(baseAdapter(), state, {
    event: { event_type: "group_broadcast", payload: { group_id: "group-1", summary: "group broadcast" } },
    entity: { group_id: "group-1", summary: "group broadcast" },
    group_id: "group-1",
  });

  assert.equal(result.category, "group_context");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.recommendation.mode, "observe_only");
});

test("protocol violation event is observed only", async () => {
  let violations = 0;
  const adapter = {
    ...baseAdapter(),
    async handleProtocolViolation(localState, event) {
      violations += 1;
      assert.equal(localState.agentId, "agent-self");
      assert.ok(event);
      return { ok: true };
    },
  };

  const result = await runtime.handleRuntimeEvent(adapter, state, {
    event: {
      event_type: "protocol_violation",
      payload: {
        message: {
          id: "msg-protocol",
          group_id: "group-1",
          author: { agent_id: "agent-other" },
          flow_type: "run",
          message_type: "analysis",
          content: {
            text: "This violates the protocol.",
            metadata: {
              protocol_violation: {
                violation_type: "malformed_route",
                action_required: "resend_corrected_message",
              },
            },
          },
          relations: { thread_id: "thread-protocol", parent_message_id: null },
          routing: { target: null, mentions: [] },
          extensions: {},
        },
      },
    },
    entity: {
      message: {
        id: "msg-protocol",
        group_id: "group-1",
        author: { agent_id: "agent-other" },
        flow_type: "run",
        message_type: "analysis",
        content: {
          text: "This violates the protocol.",
          metadata: {
            protocol_violation: {
              violation_type: "malformed_route",
              action_required: "resend_corrected_message",
            },
          },
        },
        relations: { thread_id: "thread-protocol", parent_message_id: null },
        routing: { target: null, mentions: [] },
        extensions: {},
      },
    },
    group_id: "group-1",
  });

  assert.equal(result.category, "protocol_violation");
  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.recommendation.mode, "observe_only");
  assert.equal(violations, 1);
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

test("messages without a group scope stay out_of_group_scope and observe only", async () => {
  const result = await runtime.handleRuntimeEvent(baseAdapter(), state, {
    event: {
      event_type: "message.posted",
      payload: {
        message: {
          id: "msg-5",
          author: { agent_id: "agent-other" },
          flow_type: "run",
          message_type: "analysis",
          content: { text: "This message has no group scope." },
          relations: { thread_id: "thread-2", parent_message_id: null },
          routing: { target: null, mentions: [] },
          extensions: {},
        },
      },
    },
    entity: {
      message: {
        id: "msg-5",
        author: { agent_id: "agent-other" },
        flow_type: "run",
        message_type: "analysis",
        content: { text: "This message has no group scope." },
        relations: { thread_id: "thread-2", parent_message_id: null },
        routing: { target: null, mentions: [] },
        extensions: {},
      },
    },
  });

  assert.equal(result.obligation.obligation, "observe_only");
  assert.equal(result.obligation.reason, "out_of_group_scope");
  assert.equal(result.recommendation.mode, "observe_only");
});
