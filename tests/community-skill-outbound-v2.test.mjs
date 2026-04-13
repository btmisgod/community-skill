import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "community-skill-v2-"));
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspace");
process.env.COMMUNITY_STATE_HOME = path.join(process.env.WORKSPACE_ROOT, ".openclaw", "community-skill");
process.env.COMMUNITY_BASE_URL = "http://community.example/api/v1";
process.env.COMMUNITY_GROUP_SLUG = "public-lobby";
process.env.COMMUNITY_TRANSPORT = "unix_socket";
process.env.COMMUNITY_WEBHOOK_PUBLIC_URL = "http://agent.example/webhook/agent-self";

const integration = await import(
  `${pathToFileURL(path.join(process.cwd(), "scripts", "community_integration.mjs")).href}?t=${Date.now()}`
);

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const SELF_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_ID = "44444444-4444-4444-8444-444444444444";
const THREAD_ID = "55555555-5555-4555-8555-555555555555";
const PARENT_ID = "66666666-6666-4666-8666-666666666666";

const state = {
  token: "agent-token",
  agentId: SELF_ID,
  agentName: "Agent Self",
  groupId: GROUP_ID,
  groupSlug: "public-lobby",
  profile: { display_name: "Agent Self", handle: "agent-self" },
};

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("buildCommunityMessage emits canonical message shape and preserves skill-side envelope packaging", () => {
  const message = integration.buildCommunityMessage(
    state,
    {
      id: PARENT_ID,
      group_id: GROUP_ID,
      relations: {
        thread_id: THREAD_ID,
      },
    },
    {
      group_id: GROUP_ID,
      target_agent_id: TARGET_ID,
      message_type: "analysis",
      content: {
        text: "Please take a look.",
        metadata: {
          intent: "request_action",
          custom_flag: true,
        },
      },
      context_block: {
        group_context: {
          group_slug: "public-lobby",
        },
      },
    },
  );

  assert.equal(message.group_id, GROUP_ID);
  assert.equal(message.author.agent_id, SELF_ID);
  assert.equal(message.flow_type, "run");
  assert.equal(message.message_type, "analysis");
  assert.equal(message.content.text, "Please take a look.");
  assert.equal(message.relations.thread_id, THREAD_ID);
  assert.equal(message.relations.parent_message_id, PARENT_ID);
  assert.equal(message.routing.target.agent_id, TARGET_ID);
  assert.equal(message.extensions.source, "CommunityIntegrationSkill");
  assert.ok(message.extensions.client_request_id);
  assert.ok(message.extensions.outbound_correlation_id);
  assert.equal(message.extensions.custom.custom_flag, true);
  assert.deepEqual(message.extensions.custom.message_envelope.context_block.group_context, { group_slug: "public-lobby" });
});

test("sendCommunityMessage posts canonical body to /messages", async () => {
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ success: true, data: { id: PARENT_ID, group_id: GROUP_ID } });
      },
    };
  };

  try {
    const result = await integration.sendCommunityMessage(state, null, {
      group_id: GROUP_ID,
      thread_id: THREAD_ID,
      parent_message_id: PARENT_ID,
      target_agent_id: TARGET_ID,
      content: {
        text: "Please take a look.",
        metadata: {
          custom_flag: true,
        },
      },
      message_type: "analysis",
    });

    assert.equal(result.id, PARENT_ID);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "http://community.example/api/v1/messages");
    assert.equal(sent[0].headers["X-Community-Skill-Channel"], "community-skill-v1");
    assert.equal(sent[0].body.group_id, GROUP_ID);
    assert.equal(sent[0].body.relations.thread_id, THREAD_ID);
    assert.equal(sent[0].body.relations.parent_message_id, PARENT_ID);
    assert.equal(sent[0].body.content.text, "Please take a look.");
    assert.equal(sent[0].body.routing.target.agent_id, TARGET_ID);
    assert.equal(sent[0].body.extensions.custom.custom_flag, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("connectToCommunity syncs session state and registers webhook even for unix_socket ingress", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    calls.push({ pathname, method: String(options.method || "GET").toUpperCase() });
    if (pathname === "/api/v1/agents") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              token: "agent-token",
              agent: {
                id: SELF_ID,
                name: "Agent Self",
                metadata_json: { profile: state.profile },
              },
            },
          });
        },
      };
    }
    if (pathname === "/api/v1/groups/by-slug/public-lobby") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: GROUP_ID, slug: "public-lobby", name: "Public Lobby" } });
        },
      };
    }
    if (pathname === "/api/v1/groups/by-slug/public-lobby/join") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { group: { id: GROUP_ID }, membership: { group_id: GROUP_ID } } });
        },
      };
    }
    if (pathname === "/api/v1/agents/me/webhook") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { target_url: "http://agent.example/webhook" } });
        },
      };
    }
    if (pathname === "/api/v1/agents/me/session/sync") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              community_protocol_version: "ACP-003",
              onboarding_required: false,
              agent_session: {
                agent_session_id: TARGET_ID,
                runtime_version: "community-runtime-v2",
                skill_version: "community-skill-v2",
                onboarding_version: "community-onboarding-v2",
                last_sync_at: "2026-04-13T00:00:00+00:00",
              },
              group_session_declarations: [
                {
                  group_id: GROUP_ID,
                  group_session_version: "session-v1",
                  group: { id: GROUP_ID, slug: "public-lobby", name: "Public Lobby" },
                  group_protocol: { version: "ACP-003" },
                },
              ],
              group_context_updates: [
                {
                  group_id: GROUP_ID,
                  group_context_version: "context-v1",
                  group_context: { group_id: GROUP_ID, group_slug: "public-lobby" },
                },
              ],
              removed_groups: [],
            },
          });
        },
      };
    }
    if (pathname === "/api/v1/protocol/context") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol_version: "ACP-003",
              applicable_rule_ids: ["profile.self_declare.required"],
            },
          });
        },
      };
    }
    if (pathname === `/api/v1/groups/${GROUP_ID}/protocol`) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: { id: GROUP_ID, slug: "public-lobby" },
              protocol: { version: "ACP-003", layers: { group: { name: "Public Lobby Group Protocol" } } },
            },
          });
        },
      };
    }
    if (pathname === `/api/v1/groups/${GROUP_ID}/context`) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group_id: GROUP_ID,
              group_slug: "public-lobby",
              group_protocol: { name: "Public Lobby Group Protocol" },
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${pathname}`);
  };

  try {
    const connected = await integration.connectToCommunity({});
    assert.equal(connected.agentId, SELF_ID);
    assert.equal(connected.groupId, GROUP_ID);
    assert.equal(connected.agentSessionId, TARGET_ID);
    assert.ok(calls.some((item) => item.pathname === "/api/v1/protocol/context"));
    assert.ok(calls.some((item) => item.pathname === `/api/v1/groups/${GROUP_ID}/protocol`));
    assert.ok(calls.some((item) => item.pathname === `/api/v1/groups/${GROUP_ID}/context`));
    assert.equal(calls.some((item) => item.pathname === "/api/v1/agents/me/session/sync"), true);
    assert.equal(calls.some((item) => item.pathname === "/api/v1/agents/me/webhook"), true);
    assert.equal(calls.some((item) => item.pathname === "/api/v1/groups" && item.method === "POST"), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("connectToCommunity persists token and group state before session sync completes", async () => {
  fs.rmSync(path.join(process.env.COMMUNITY_STATE_HOME, "state"), { recursive: true, force: true });
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    calls.push({ pathname, method: String(options.method || "GET").toUpperCase() });
    if (pathname === "/api/v1/agents") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              token: "agent-token",
              agent: {
                id: SELF_ID,
                name: "Agent Self",
                metadata_json: { profile: state.profile },
              },
            },
          });
        },
      };
    }
    if (pathname === "/api/v1/groups/by-slug/public-lobby") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: GROUP_ID, slug: "public-lobby", name: "Public Lobby" } });
        },
      };
    }
    if (pathname === "/api/v1/groups/by-slug/public-lobby/join") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { group: { id: GROUP_ID }, membership: { group_id: GROUP_ID } } });
        },
      };
    }
    if (pathname === "/api/v1/agents/me/webhook") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { target_url: "http://agent.example/webhook" } });
        },
      };
    }
    if (pathname === "/api/v1/agents/me/session/sync") {
      return {
        ok: false,
        status: 404,
        async text() {
          return JSON.stringify({ success: false, message: "404" });
        },
      };
    }
    throw new Error(`unexpected fetch: ${pathname}`);
  };

  try {
    await assert.rejects(
      () => integration.connectToCommunity({}),
      /Request failed for \/agents\/me\/session\/sync: 404/,
    );
    const persisted = JSON.parse(
      fs.readFileSync(
        path.join(process.env.COMMUNITY_STATE_HOME, "state", "community-webhook-state.json"),
        "utf8",
      ),
    );
    assert.equal(persisted.token, "agent-token");
    assert.equal(persisted.agentId, SELF_ID);
    assert.equal(persisted.groupId, GROUP_ID);
    assert.equal(persisted.webhookUrl, "http://agent.example/webhook/agent-self");
    assert.equal(calls.some((item) => item.pathname === "/api/v1/agents/me/session/sync"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("verifyCanonicalMessageVisible requires persisted message materialization", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/api/v1/messages") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              items: [
                {
                  id: PARENT_ID,
                  group_id: GROUP_ID,
                  content: { text: "Please take a look." },
                  extensions: {
                    client_request_id: "idem-1",
                    outbound_correlation_id: "idem-1",
                    custom: { idempotency_key: "idem-1" },
                  },
                },
              ],
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${pathname}`);
  };

  try {
    const result = await integration.verifyCanonicalMessageVisible(state, {
      groupId: GROUP_ID,
      messageId: PARENT_ID,
      idempotencyKey: "idem-1",
      text: "Please take a look.",
      attempts: 1,
      delayMs: 1,
    });

    assert.equal(result.ok, true);
    assert.equal(result.message.id, PARENT_ID);
  } finally {
    global.fetch = originalFetch;
  }
});

test("receiveCommunityEvent mounts protocol context and does not auto-send replies", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (pathname === "/api/v1/protocol/context") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol_version: "ACP-003",
              applicable_rule_ids: ["profile.self_declare.required"],
            },
          });
        },
      };
    }
    if (pathname === `/api/v1/groups/${GROUP_ID}/protocol`) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: { id: GROUP_ID, slug: "public-lobby" },
              protocol: { version: "ACP-003", layers: { group: { name: "Public Lobby Group Protocol" } } },
            },
          });
        },
      };
    }
    if (pathname === `/api/v1/groups/${GROUP_ID}/context`) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group_id: GROUP_ID,
              group_slug: "public-lobby",
              group_protocol: { name: "Public Lobby Group Protocol" },
            },
          });
        },
      };
    }
    if (pathname === "/api/v1/messages") {
      throw new Error("receiveCommunityEvent must not auto-post outbound replies");
    }
    throw new Error(`unexpected fetch: ${pathname}`);
  };

  try {
    const result = await integration.receiveCommunityEvent(state, {
      event: {
        event_type: "message.posted",
        payload: {
          message: {
            id: PARENT_ID,
            group_id: GROUP_ID,
            author: { agent_id: OTHER_ID },
            flow_type: "run",
            message_type: "analysis",
            content: { text: "Please review this and reply." },
            relations: { thread_id: THREAD_ID, parent_message_id: null },
            routing: { target: { agent_id: SELF_ID }, mentions: [] },
            extensions: {},
          },
        },
      },
      entity: {
        message: {
          id: PARENT_ID,
          group_id: GROUP_ID,
          author: { agent_id: OTHER_ID },
          flow_type: "run",
          message_type: "analysis",
          content: { text: "Please review this and reply." },
          relations: { thread_id: THREAD_ID, parent_message_id: null },
          routing: { target: { agent_id: SELF_ID }, mentions: [] },
          extensions: {},
        },
      },
      group_id: GROUP_ID,
    });

    assert.equal(result.handled, true);
    assert.equal(result.hot_path_role, "judgment_only");
    assert.equal(result.judgment.category, "run");
    assert.equal(result.judgment.obligation.obligation, "required");
    assert.equal(result.outbound, null);
    assert.equal(result.protocol_mount.agent_protocol.protocol_version, "ACP-003");
    assert.ok(calls.includes("/api/v1/protocol/context"));
    assert.ok(calls.includes(`/api/v1/groups/${GROUP_ID}/protocol`));
    assert.ok(calls.includes(`/api/v1/groups/${GROUP_ID}/context`));
  } finally {
    global.fetch = originalFetch;
  }
});

test("receipt and debug events stay outside normal intake", async () => {
  const receiptResult = await integration.receiveCommunityEvent(state, {
    event: {
      event_type: "message.accepted",
      payload: {
        receipt: {
          client_request_id: "req-1",
          community_message_id: PARENT_ID,
          thread_id: THREAD_ID,
          status: "accepted",
        },
      },
    },
    entity: {
      receipt: {
        client_request_id: "req-1",
        community_message_id: PARENT_ID,
        thread_id: THREAD_ID,
        status: "accepted",
      },
    },
    group_id: GROUP_ID,
  });

  const debugResult = await integration.receiveCommunityEvent(state, {
    event: {
      event_type: "outbound.canonicalized",
      payload: {
        receipt: { client_request_id: "req-2", community_message_id: TARGET_ID },
      },
    },
    entity: {
      receipt: { client_request_id: "req-2", community_message_id: TARGET_ID },
    },
    group_id: GROUP_ID,
  });

  assert.equal(receiptResult.non_intake, true);
  assert.equal(debugResult.non_intake, true);
});
