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
process.env.MODEL_BASE_URL = "http://model.example/v1";
process.env.MODEL_API_KEY = "test-key";
process.env.MODEL_ID = "test-model";

const integration = await import(pathToFileURL(path.join(process.cwd(), "community-skill", "scripts", "community_integration.mjs")).href + `?t=${Date.now()}`);

const state = {
  token: "agent-token",
  agentId: "agent-self",
  agentName: "Agent Self",
  groupId: "group-1",
  profile: { display_name: "Agent Self", handle: "agent-self" },
  profileFingerprint: "stable",
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

test("receiveCommunityEvent executes required judgment and posts reply", async () => {
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { protocol: { version: "v1" }, applicable_rule_ids: [] } });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { group_slug: "public-lobby", summary: "context" } });
        },
      };
    }
    if (String(url).includes("/chat/completions")) {
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: "generated reply" } }] };
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-1", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.receiveCommunityEvent(state, {
      event: {
        event_type: "message.posted",
        payload: {
          message: {
            id: "msg-in-1",
            group_id: "group-1",
            author: { agent_id: "agent-other" },
            flow_type: "run",
            message_type: "analysis",
            content: { text: "Please review this and reply." },
            relations: { thread_id: "thread-1", parent_message_id: null },
            routing: { target: { agent_id: "agent-self" }, mentions: [] },
            extensions: {},
          },
        },
      },
      entity: {
        message: {
          id: "msg-in-1",
          group_id: "group-1",
          author: { agent_id: "agent-other" },
          flow_type: "run",
          message_type: "analysis",
          content: { text: "Please review this and reply." },
          relations: { thread_id: "thread-1", parent_message_id: null },
          routing: { target: { agent_id: "agent-self" }, mentions: [] },
          extensions: {},
        },
      },
      group_id: "group-1",
    });

    assert.equal(result.category, "run");
    assert.equal(result.obligation.obligation, "required");
    assert.equal(result.decision.action, "full_reply");
    assert.equal(result.posted, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].routing.target.agent_id, "agent-other");
    assert.equal(sent[0].relations.parent_message_id, "msg-in-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("non-targeted collaboration remains observed only at integration layer", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("fetch should not be called for optional observed message");
  };

  try {
    const result = await integration.receiveCommunityEvent(state, {
      event: {
        event_type: "message.posted",
        payload: {
          message: {
            id: "msg-in-2",
            group_id: "group-1",
            author: { agent_id: "agent-other" },
            flow_type: "run",
            message_type: "analysis",
            content: { text: "General collaboration update." },
            relations: { thread_id: "thread-1", parent_message_id: null },
            routing: { target: null, mentions: [] },
            extensions: {},
          },
        },
      },
      entity: {
        message: {
          id: "msg-in-2",
          group_id: "group-1",
          author: { agent_id: "agent-other" },
          flow_type: "run",
          message_type: "analysis",
          content: { text: "General collaboration update." },
          relations: { thread_id: "thread-1", parent_message_id: null },
          routing: { target: null, mentions: [] },
          extensions: {},
        },
      },
      group_id: "group-1",
    });

    assert.equal(result.category, "run");
    assert.equal(result.obligation.obligation, "optional");
    assert.equal(result.decision.action, "observe_only");
    assert.equal(result.posted, undefined);
  } finally {
    global.fetch = originalFetch;
  }
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
