import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const integrationPath = path.join(thisDir, "..", "scripts", "community_integration.mjs");
const integration = await import(pathToFileURL(integrationPath).href + `?t=${Date.now()}`);

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
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  should_reply: true,
                  flow_type: "run",
                  message_type: "analysis",
                  reply_text: "generated reply",
                  reason: "reply_required",
                }),
              },
            }],
          };
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
    assert.equal(result.agent_deliberation.should_reply, true);
    assert.equal(result.agent_deliberation.flow_type, "run");
    assert.equal(result.posted, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].flow_type, "run");
    assert.equal(sent[0].content.text, "generated reply");
    assert.equal(sent[0].routing.target.agent_id, "agent-other");
    assert.equal(sent[0].relations.parent_message_id, "msg-in-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("non-targeted collaboration still reaches deliberation before no_action", async () => {
  const originalFetch = global.fetch;
  let modelCalls = 0;
  global.fetch = async (url) => {
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
      modelCalls += 1;
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  should_reply: false,
                  flow_type: "run",
                  message_type: "analysis",
                  reply_text: "",
                  reason: "optional_no_public_reply",
                }),
              },
            }],
          };
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
    assert.equal(modelCalls, 1);
    assert.equal(result.agent_deliberation.should_reply, false);
    assert.equal(result.no_action, true);
    assert.equal(result.posted, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("status webhook can deliberate into a public status flow", async () => {
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
          return JSON.stringify({ success: true, data: { workflow: { id: "bootstrap" }, group_slug: "public-lobby" } });
        },
      };
    }
    if (String(url).includes("/chat/completions")) {
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  should_reply: true,
                  flow_type: "status",
                  message_type: "progress",
                  reply_text: "已完成 step1 对齐",
                  payload: {
                    workflow_id: "bootstrap",
                    step_id: "step1",
                    step_status: "completed",
                  },
                  reason: "bootstrap_progress_update",
                }),
              },
            }],
          };
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "status-1", group_id: "group-1" } });
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
            id: "msg-status-1",
            group_id: "group-1",
            author: { agent_id: "agent-manager" },
            flow_type: "status",
            message_type: "progress",
            content: { text: "bootstrap startup signal emitted" },
            relations: { thread_id: "thread-bootstrap", parent_message_id: null },
            routing: { target: null, mentions: [] },
            extensions: { custom: { workflow_id: "bootstrap", step_id: "step1" } },
          },
        },
      },
      entity: {
        message: {
          id: "msg-status-1",
          group_id: "group-1",
          author: { agent_id: "agent-manager" },
          flow_type: "status",
          message_type: "progress",
          content: { text: "bootstrap startup signal emitted" },
          relations: { thread_id: "thread-bootstrap", parent_message_id: null },
          routing: { target: null, mentions: [] },
          extensions: { custom: { workflow_id: "bootstrap", step_id: "step1" } },
        },
      },
      group_id: "group-1",
    });

    assert.equal(result.category, "status");
    assert.equal(result.agent_deliberation.should_reply, true);
    assert.equal(result.agent_deliberation.flow_type, "status");
    assert.equal(result.posted, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].flow_type, "status");
    assert.equal(sent[0].message_type, "progress");
    assert.equal(sent[0].content.payload.step_status, "completed");
    assert.equal(sent[0].routing.target?.agent_id ?? null, null);
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
  assert.equal(receiptResult.workflow_sync?.last_ack_status, "accepted");
  assert.equal(receiptResult.workflow_sync?.last_ack?.client_request_id, "req-1");
  assert.equal(receiptResult.workflow_sync?.source, "outbound_receipt");
  assert.equal(debugResult.category, "outbound_debug");
  assert.equal(debugResult.non_intake, true);
});

test("workflow_contract and group_context bypass deliberation before normal reply path", async () => {
  const originalFetch = global.fetch;
  let modelCalls = 0;

  global.fetch = async (url) => {
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
      modelCalls += 1;
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: JSON.stringify({ should_reply: true, flow_type: "run", message_type: "analysis", reply_text: "should not happen", reason: "unexpected" }) } }] };
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const workflowResult = await integration.receiveCommunityEvent(state, {
      event: {
        event_type: "workflow_contract",
        payload: {
          group_id: "group-1",
          contract: { step_id: "step-1", owner: "服务器测试" },
        },
      },
      entity: {
        group_id: "group-1",
        contract: { step_id: "step-1", owner: "服务器测试" },
      },
      group_id: "group-1",
    });
    const contextResult = await integration.receiveCommunityEvent(state, {
      event: {
        event_type: "group_broadcast",
        payload: {
          group_id: "group-1",
          summary: "sync context",
        },
      },
      entity: {
        group_id: "group-1",
        summary: "sync context",
      },
      group_id: "group-1",
    });

    assert.equal(modelCalls, 0);
    assert.equal(workflowResult.bypassed_before_deliberation, true);
    assert.equal(workflowResult.no_action, true);
    assert.equal(workflowResult.posted, undefined);
    assert.equal(contextResult.category, "group_context");
    assert.equal(contextResult.bypassed_before_deliberation, true);
    assert.equal(contextResult.no_action, true);
    assert.equal(contextResult.posted, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("local JSONC bootstrap draft becomes the active workflow source", async () => {
  const draftDir = path.join(tempRoot, "draft-source");
  const draftPath = path.join(draftDir, "当前测试群组协议_初稿.jsonc");
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(
    draftPath,
    String.raw`{
      // local round-specific draft
      "protocol_meta": {
        "protocol_id": "bootstrap-draft-activation-v1",
        "protocol_name": "bootstrap draft activation test",
        "protocol_version": "draft-1",
        "status": "debug_draft",
        "purpose": "activate the new draft as the only semantic source for this round"
      },
      "group_identity": {
        "group_name": "Draft Activation Group",
        "group_slug": "group-boot-workflow-33-neko-xhs",
        "group_type": "bootstrap_test_group",
        "workflow_mode": "bootstrap_before_formal_workflow"
      },
      "members": {
        "manager_agent_id": "neko",
        "worker_agent_ids": ["33", "xhs"],
        "all_agent_ids": ["neko", "33", "xhs"]
      },
      "protocol_scope": {
        "rules_source": "group_protocol_only",
        "applies_to": ["group.enter", "message.post", "workflow.bootstrap", "workflow.formal_start"]
      },
      "workflow": {
        "bootstrap_workflow": {
          "workflow_id": "bootstrap-workflow-v1",
          "step_order": ["step0", "step1", "step2", "step3", "task_start"],
          "step0": { "title": "backend preparation / protocol and task-contract design" },
          "step1": {
            "title": "manager publishes task goal and formal workflow",
            "lifecycle": {
              "start": { "status_emit": "step1_start", "must_emit_status_flow": true }
            }
          },
          "step2": {
            "title": "manager checks capability",
            "lifecycle": {
              "start": { "status_emit": "step2_start", "must_emit_status_flow": true }
            }
          },
          "step3": {
            "title": "manager distributes task contract and confirms ready",
            "lifecycle": {
              "start": { "status_emit": "step3_start", "must_emit_status_flow": true }
            }
          },
          "task_start": {
            "title": "manager publishes task start",
            "status_emit": "task_start"
          }
        }
      },
      "state_board_rules": {
        "progress_must_be_visible_as_status": true,
        "every_community_participation_must_emit_status": true
      },
      "transition_rules": {
        "step_transition_must_be_explicit": true,
        "manager_must_confirm_before_next_step": true
      },
      "reply_rules": {
        "every_workflow_participation_requires_status_flow": true,
        "must_reply_when": ["assigned_manager_action"]
      },
      "activation_rules": {
        "require_member_confirmation": true,
        "require_contract_installation": true,
        "require_manager_done_signal_for_step_transition": true
      },
      "task_contract_rules": {
        "task_contract_is_required_for_formal_work_execution": true,
        "task_contract_is_required_for_ready_confirmation": true
      },
      "monitoring_rules": {
        "codex_role": "observer_only"
      }
    }`,
    "utf8",
  );

  const originalDraftPath = process.env.COMMUNITY_PROTOCOL_DRAFT_PATH;
  process.env.COMMUNITY_PROTOCOL_DRAFT_PATH = draftPath;
  const draftIntegration = await import(pathToFileURL(integrationPath).href + `?draft=${Date.now()}`);

  const originalFetch = global.fetch;
  let promptSnapshot = "";
  let protocolFetches = 0;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      protocolFetches += 1;
      throw new Error("protocol fetch should be bypassed when the JSONC draft is present");
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
      promptSnapshot = JSON.parse(options.body).messages[0].content;
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  should_reply: false,
                  flow_type: "run",
                  message_type: "analysis",
                  reply_text: "",
                  reason: "monitor_only",
                }),
              },
            }],
          };
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await draftIntegration.receiveCommunityEvent(state, {
      event: {
        event_type: "message.posted",
        payload: {
          message: {
            id: "msg-draft-1",
            group_id: "group-1",
            author: { agent_id: "agent-manager" },
            flow_type: "run",
            message_type: "analysis",
            content: { text: "step0 kickoff: activate the new bootstrap draft." },
            relations: { thread_id: "thread-draft", parent_message_id: null },
            routing: { target: { agent_id: "agent-self" }, mentions: [] },
            extensions: {},
          },
        },
      },
      entity: {
        message: {
          id: "msg-draft-1",
          group_id: "group-1",
          author: { agent_id: "agent-manager" },
          flow_type: "run",
          message_type: "analysis",
          content: { text: "step0 kickoff: activate the new bootstrap draft." },
          relations: { thread_id: "thread-draft", parent_message_id: null },
          routing: { target: { agent_id: "agent-self" }, mentions: [] },
          extensions: {},
        },
      },
      group_id: "group-1",
    });

    const templateStateRoot = path.join(process.env.COMMUNITY_TEMPLATE_HOME, "state");
    const storedProtocol = JSON.parse(fs.readFileSync(path.join(templateStateRoot, "community-group-protocols.json"), "utf8"));
    const storedContract = JSON.parse(fs.readFileSync(path.join(templateStateRoot, "community-workflow-contracts.json"), "utf8"));
    const storedSync = JSON.parse(fs.readFileSync(path.join(templateStateRoot, "community-workflow-sync.json"), "utf8"));
    const storedProtocolPayload = storedProtocol["group-1"]?.payload;
    const storedContractPayload = storedContract["group-1"]?.payload;
    const storedSyncPayload = storedSync["group-1"]?.payload;

    assert.equal(protocolFetches, 0);
    assert.ok(promptSnapshot.includes("bootstrap-draft-activation-v1"));
    assert.ok(promptSnapshot.includes("draft-1"));
    assert.ok(promptSnapshot.includes("manager publishes task goal and formal workflow"));
    assert.ok(promptSnapshot.includes("explicit step1_done status flow"));
    assert.ok(promptSnapshot.includes("step1_done"));
    assert.equal(storedProtocolPayload?.protocol?.protocol_meta?.protocol_id, "bootstrap-draft-activation-v1");
    assert.equal(storedProtocolPayload?.source, "local_protocol_draft");
    assert.equal(storedContractPayload?.source, "local_protocol_draft");
    assert.equal(storedContractPayload?.contract?.protocol_version, "draft-1");
    assert.ok(storedContractPayload?.contract?.workflow?.bootstrap_workflow?.step_order.includes("step1"));
    assert.equal(storedSyncPayload?.source, "local_protocol_draft");
    assert.equal(storedSyncPayload?.protocol_version, "draft-1");
    assert.equal(storedSyncPayload?.workflow_version, "draft-1");
    assert.equal(result.category, "run");
    assert.equal(result.obligation.obligation, "required");
  } finally {
    global.fetch = originalFetch;
    if (originalDraftPath === undefined) {
      delete process.env.COMMUNITY_PROTOCOL_DRAFT_PATH;
    } else {
      process.env.COMMUNITY_PROTOCOL_DRAFT_PATH = originalDraftPath;
    }
  }
});

test("manager step1 confirmation is emitted as an explicit step1_done status flow", async () => {
  const originalFetch = global.fetch;
  const sentBodies = [];
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                protocol_meta: {
                  protocol_id: "bootstrap-draft-activation-v1",
                  protocol_name: "bootstrap draft activation test",
                  protocol_version: "draft-1",
                  status: "debug_draft",
                },
                workflow: {
                  bootstrap_workflow: {
                    workflow_id: "bootstrap-workflow-v1",
                    step1: {
                      title: "manager publishes task goal and formal workflow",
                      lifecycle: {
                        start: { owner: "manager", must_emit_status_flow: true, status_emit: "step1_start" },
                        run: { owner: "workers", must_emit_status_flow: true, status_emit: "step1_submitted" },
                        result: { owner: "manager", must_emit_status_flow: true, status_emit: "step1_confirmed" },
                        done: { owner: "manager", must_emit_status_flow: true, status_emit: "step1_done" },
                      },
                    },
                  },
                },
                monitoring_rules: { codex_role: "observer_only" },
              },
              applicable_rule_ids: ["CC-04"],
            },
          });
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
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  should_reply: true,
                  flow_type: "run",
                  message_type: "analysis",
                  reply_text: "已确认 step1 对齐。",
                  reason: "manager_alignment",
                }),
              },
            }],
          };
        },
      };
    }
    if (String(url).includes("/messages")) {
      sentBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "msg-step1-done", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const managerState = {
    token: "agent-token",
    agentId: "neko",
    agentName: "neko",
    groupId: "group-1",
    profile: { display_name: "neko", handle: "neko" },
    profileFingerprint: "stable",
  };

  try {
    const result = await integration.receiveCommunityEvent(managerState, {
      event: {
        event_type: "message.posted",
        payload: {
          message: {
            id: "msg-step1-confirm",
            group_id: "group-1",
            author: { agent_id: "neko" },
            flow_type: "run",
            message_type: "analysis",
            content: { text: "step1 已完成，确认对齐。" },
            relations: { thread_id: "thread-step1", parent_message_id: null },
            routing: { target: null, mentions: [] },
            extensions: {},
          },
        },
      },
      entity: {
        message: {
          id: "msg-step1-confirm",
          group_id: "group-1",
          author: { agent_id: "neko" },
          flow_type: "run",
          message_type: "analysis",
          content: { text: "step1 已完成，确认对齐。" },
          relations: { thread_id: "thread-step1", parent_message_id: null },
          routing: { target: null, mentions: [] },
          extensions: {},
        },
      },
      group_id: "group-1",
    });

    assert.equal(result.obligation.reason, "step1_done_requires_manager_step2_activation");
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0].flow_type, "status");
    assert.equal(sentBodies[0].message_type, "progress");
    assert.equal(sentBodies[0].content.payload.step, "step1");
    assert.equal(sentBodies[0].content.payload.step_status, "done");
    assert.equal(sentBodies[0].content.payload.manager_step1_done, true);
    assert.equal(sentBodies[0].content.payload.bootstrap_workflow.status, "done");
    assert.equal(sentBodies[0].routing.target?.agent_id || null, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test("group protocol workflow is injected into deliberation context", async () => {
  const originalFetch = global.fetch;
  let promptSnapshot = "";

  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "v17",
                workflow: {
                  bootstrap_workflow: {
                    step0: { title: "后端准备 / protocol 与 task contract 设计" },
                    step1: { title: "manager 发布任务目标与正式 workflow" },
                    step2: { title: "manager 检查能力边界" },
                    step3: { title: "manager 分发 task contract 并确认 ready" },
                    step4: { title: "manager 发布 task start" },
                  },
                  monitoring_rules: {
                    codex_role: "observer_only",
                  },
                },
              },
              applicable_rule_ids: ["CC-04"],
            },
          });
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
      promptSnapshot = JSON.parse(options.body).messages[0].content;
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  should_reply: false,
                  flow_type: "run",
                  message_type: "analysis",
                  reply_text: "",
                  reason: "monitor_only",
                }),
              },
            }],
          };
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
            id: "msg-protocol-1",
            group_id: "group-1",
            author: { agent_id: "agent-manager" },
            flow_type: "run",
            message_type: "analysis",
            content: { text: "bootstrap workflow kickoff already landed." },
            relations: { thread_id: "thread-protocol", parent_message_id: null },
            routing: { target: null, mentions: [] },
            extensions: {},
          },
        },
      },
      entity: {
        message: {
          id: "msg-protocol-1",
          group_id: "group-1",
          author: { agent_id: "agent-manager" },
          flow_type: "run",
          message_type: "analysis",
          content: { text: "bootstrap workflow kickoff already landed." },
          relations: { thread_id: "thread-protocol", parent_message_id: null },
          routing: { target: null, mentions: [] },
          extensions: {},
        },
      },
      group_id: "group-1",
    });

    assert.equal(result.category, "run");
    assert.ok(promptSnapshot.includes("The following is the current group protocol"));
    assert.ok(promptSnapshot.includes("step0"));
    assert.ok(promptSnapshot.includes("manager 发布任务目标与正式 workflow"));
    assert.ok(promptSnapshot.includes("observer_only"));
    assert.ok(promptSnapshot.includes("workflow-bound kickoff"));
    assert.ok(promptSnapshot.includes("step1 start as an active responsibility trigger"));
    assert.ok(promptSnapshot.includes("workflow_sync"));
    assert.ok(promptSnapshot.includes("\"workflow_version\": \"v17\""));
    assert.equal(result.observed, true);
  } finally {
    global.fetch = originalFetch;
  }
});
