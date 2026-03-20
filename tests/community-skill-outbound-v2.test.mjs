import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "community-skill-v2-"));
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspace");
process.env.COMMUNITY_TEMPLATE_HOME = path.join(process.env.WORKSPACE_ROOT, ".openclaw", "community-agent-template");
process.env.COMMUNITY_INGRESS_HOME = path.join(tempRoot, "ingress");
process.env.COMMUNITY_BASE_URL = "http://community.example/api/v1";
process.env.COMMUNITY_GROUP_SLUG = "public-lobby";
process.env.MESSAGE_PROTOCOL_V2 = "1";
process.env.WEBHOOK_RECEIPT_V2 = "1";

const integration = await import(pathToFileURL(path.join(process.cwd(), "community-skill", "scripts", "community_integration.mjs")).href + `?t=${Date.now()}`);
const runtime = await import(pathToFileURL(path.join(process.cwd(), "community-skill", "assets", "community-runtime-v0.mjs")).href + `?t=${Date.now()}`);

const state = {
  token: "agent-token",
  agentId: "agent-self",
  agentName: "Agent Self",
  groupId: "group-1",
  profile: { display_name: "Agent Self", handle: "agent-self" },
};

function cleanupFiles() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

test.after(() => {
  cleanupFiles();
});

test("buildCommunityMessage emits canonical V2 without duplicated semantic shadow fields", () => {
  const sendContext = {
    group_id: "group-1",
    thread_id: "thread-1",
    parent_message_id: "parent-1",
    task_id: "task-1",
    target_agent_id: "agent-target",
    target_agent: "Agent Target",
    assignees: ["agent-target"],
  };

  const message = integration.buildCommunityMessage(state, sendContext, {
    message_type: "analysis",
    content: {
      text: "Please take a look.",
      metadata: {
        intent: "request_action",
        topic: "review",
        target_agent_id: "agent-target",
        target_agent: "Agent Target",
        assignees: ["agent-target"],
        custom_flag: true,
      },
    },
  });

  assert.equal(message.container.group_id, "group-1");
  assert.equal(message.relations.thread_id, "thread-1");
  assert.equal(message.relations.parent_message_id, "parent-1");
  assert.equal(message.relations.task_id, "task-1");
  assert.equal(message.body.text, "Please take a look.");
  assert.equal(message.semantics.kind, "analysis");
  assert.equal(message.semantics.intent, "request_action");
  assert.equal(message.semantics.topic, "review");
  assert.equal(message.routing.target.agent_id, "agent-target");
  assert.equal(message.routing.target.agent_label, "Agent Target");
  assert.deepEqual(message.routing.assignees, ["agent-target"]);
  assert.equal(message.extensions.source, "CommunityIntegrationSkill");
  assert.ok(message.extensions.client_request_id);
  assert.ok(message.extensions.outbound_correlation_id);
  assert.equal(message.extensions.custom.custom_flag, true);
  assert.equal(message.extensions.custom.intent, undefined);
  assert.equal(message.extensions.custom.flow_type, undefined);
  assert.equal(message.extensions.custom.message_type, undefined);
});

test("sendCommunityMessage posts canonical V2 body to /messages", async () => {
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    sent.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ success: true, data: { id: "msg-1", container: { group_id: "group-1" } } });
      },
    };
  };

  try {
    const result = await integration.sendCommunityMessage(state, null, {
      group_id: "group-1",
      thread_id: "thread-1",
      parent_message_id: "parent-1",
      task_id: "task-1",
      target_agent_id: "agent-target",
      target_agent: "Agent Target",
      content: {
        text: "Please take a look.",
        metadata: {
          intent: "request_action",
          custom_flag: true,
        },
      },
      message_type: "analysis",
    });

    assert.equal(result.id, "msg-1");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "http://community.example/api/v1/messages");
    assert.equal(sent[0].body.container.group_id, "group-1");
    assert.equal(sent[0].body.relations.thread_id, "thread-1");
    assert.equal(sent[0].body.relations.parent_message_id, "parent-1");
    assert.equal(sent[0].body.body.text, "Please take a look.");
    assert.equal(sent[0].body.semantics.kind, "analysis");
    assert.equal(sent[0].body.semantics.intent, "request_action");
    assert.equal(sent[0].body.routing.target.agent_id, "agent-target");
    assert.equal(sent[0].body.extensions.custom.custom_flag, true);
    assert.equal(sent[0].body.extensions.custom.intent, undefined);
    assert.equal(sent[0].body.extensions.custom.message_type, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("runtime accepts skill outbound canonical V2 message through webhook intake", async () => {
  const outbound = integration.buildCommunityMessage(
    state,
    {
      group_id: "group-1",
      thread_id: "thread-1",
      parent_message_id: null,
      task_id: null,
      target_agent_id: null,
      target_agent: null,
      assignees: null,
    },
    {
      message_type: "analysis",
      content: {
        text: "Need thoughts on this proposal.",
        metadata: { intent: "inform" },
      },
    },
  );

  const adapter = {
    async fetchRuntimeContext() {
      return { channel_roles: [{ agent: "agent-self", role: "builder" }] };
    },
    async postCommunityMessage() {
      return { id: "reply-1" };
    },
    async executeTask() {
      return "task completed";
    },
    async decideResponse() {
      return { action: "brief_reply", reason: "test" };
    },
    async generateReply() {
      return "generated reply";
    },
    buildFallbackReplyText() {
      return "fallback";
    },
    async handleProtocolViolation() {
      return { ok: true };
    },
    async loadWorkflowContract() {
      return { ok: true };
    },
    async loadChannelContext() {
      return { ok: true };
    },
  };

  const projected = {
    ...outbound,
    author: {
      ...(outbound.author || {}),
      agent_id: "agent-other",
    },
  };

  const result = await runtime.handleRuntimeEvent(adapter, state, {
    event: { event_type: "message.posted", payload: { message: projected } },
    entity: { message: projected },
    group_id: "group-1",
  });

  assert.equal(result.message.container.group_id, "group-1");
  assert.equal(result.message.body.text, "Need thoughts on this proposal.");
  assert.equal(result.runtime.category, "discussion");
  assert.equal(result.runtime.mode, "discussion");
});

test("receiveCommunityEvent keeps receipt/debug events outside normal intake while reading V2 payload references", async () => {
  const receiptResult = await integration.receiveCommunityEvent(state, {
    event: {
      event_type: "message.accepted",
      payload: {
        receipt: {
          client_request_id: "req-1",
          community_message_id: "msg-1",
          thread_id: "thread-1",
          status: "accepted",
        },
      },
    },
    entity: {
      receipt: {
        client_request_id: "req-1",
        community_message_id: "msg-1",
        thread_id: "thread-1",
        status: "accepted",
      },
    },
    group_id: "group-1",
  });

  const debugMessage = integration.buildCommunityMessage(state, {
    group_id: "group-1",
    thread_id: "thread-1",
    parent_message_id: null,
    task_id: null,
    target_agent_id: null,
    target_agent: null,
    assignees: null,
  }, {
    message_type: "analysis",
    content: { text: "canonicalized body", metadata: { intent: "inform" } },
  });

  const debugResult = await integration.receiveCommunityEvent(state, {
    event: {
      event_type: "outbound.canonicalized",
      payload: {
        receipt: { client_request_id: "req-2", community_message_id: "msg-2" },
        canonicalized_message: debugMessage,
      },
    },
    entity: {
      receipt: { client_request_id: "req-2", community_message_id: "msg-2" },
      canonicalized_message: debugMessage,
    },
    group_id: "group-1",
  });

  assert.equal(receiptResult.category, "outbound_receipt");
  assert.equal(receiptResult.non_intake, true);
  assert.equal(receiptResult.client_request_id, "req-1");
  assert.equal(debugResult.category, "outbound_debug");
  assert.equal(debugResult.non_intake, true);
  assert.equal(debugResult.client_request_id, "req-2");
});
