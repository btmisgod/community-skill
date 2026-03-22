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

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("buildCommunityMessage emits current canonical community message shape", () => {
  const message = integration.buildCommunityMessage(state, {
    group_id: "group-1",
    thread_id: "thread-1",
    parent_message_id: "parent-1",
    target_agent_id: "agent-target",
    target_agent: "Agent Target",
  }, {
    flow_type: "run",
    message_type: "analysis",
    content: {
      text: "Please take a look.",
      metadata: {
        intent: "request_action",
        custom_flag: true,
      },
    },
  });

  assert.equal(message.group_id, "group-1");
  assert.equal(message.author.agent_id, "agent-self");
  assert.equal(message.flow_type, "run");
  assert.equal(message.message_type, "analysis");
  assert.equal(message.content.text, "Please take a look.");
  assert.equal(message.relations.thread_id, "thread-1");
  assert.equal(message.relations.parent_message_id, "parent-1");
  assert.equal(message.routing.target.agent_id, "agent-target");
  assert.ok(Array.isArray(message.routing.mentions));
  assert.equal(message.extensions.source, "CommunityIntegrationSkill");
  assert.ok(message.extensions.client_request_id);
  assert.ok(message.extensions.outbound_correlation_id);
  assert.equal(message.extensions.custom.custom_flag, true);
});

test("sendCommunityMessage posts current canonical body to /messages", async () => {
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ success: true, data: { id: "msg-1", group_id: "group-1" } });
      },
    };
  };

  try {
    const result = await integration.sendCommunityMessage(state, null, {
      group_id: "group-1",
      thread_id: "thread-1",
      parent_message_id: "parent-1",
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
    assert.equal(sent[0].body.group_id, "group-1");
    assert.equal(sent[0].body.relations.thread_id, "thread-1");
    assert.equal(sent[0].body.relations.parent_message_id, "parent-1");
    assert.equal(sent[0].body.content.text, "Please take a look.");
    assert.equal(sent[0].body.routing.target.agent_id, "agent-target");
    assert.equal(sent[0].body.extensions.custom.custom_flag, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("runtime accepts canonical run message and replies when explicitly targeted", async () => {
  const outbound = integration.buildCommunityMessage(
    state,
    {
      group_id: "group-1",
      thread_id: "thread-1",
      parent_message_id: null,
      target_agent_id: "agent-self",
      target_agent: "Agent Self",
    },
    {
      flow_type: "run",
      message_type: "analysis",
      content: {
        text: "Please review this and reply.",
        metadata: { intent: "request_action" },
      },
    },
  );

  const adapter = {
    async fetchRuntimeContext() {
      return { group_roles: [{ agent: "agent-self", role: "builder" }] };
    },
    async postCommunityMessage() {
      return { id: "reply-1" };
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
    async loadGroupContext() {
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

  assert.equal(result.category, "run");
  assert.equal(result.obligation.obligation, "required");
  assert.equal(result.signals.targeted, true);
  assert.equal(result.posted, true);
});

test("receiveCommunityEvent keeps receipt/debug events outside normal intake", async () => {
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
    target_agent_id: null,
    target_agent: null,
  }, {
    flow_type: "run",
    message_type: "analysis",
    content: { text: "canonicalized body" },
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
  assert.equal(debugResult.category, "outbound_debug");
  assert.equal(debugResult.non_intake, true);
});
