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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const integration = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "community_integration.mjs")).href + `?t=${Date.now()}`);
integration.installRuntime();

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

test("fetchRuntimeContext returns minimal runtime cards instead of broad session dumps", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["agent-self", "worker-2"],
                      role_assignments: {
                        editor: {
                          agent_id: "agent-self",
                          server_gate_role: "worker",
                          responsibility: "compose product draft",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "formal_newsflow_debug",
                      group_objective: "Produce the current news cycle output",
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                      worker_inputs_are_evidence_not_transition_gates: true,
                      plain_text_cannot_replace_manager_formal_signal: true,
                    },
                    workflow: {
                      formal_workflow: {
                        goal: "Produce a Chinese news product",
                        product_contract: {
                          language: "zh-CN",
                          sections: ["technology", "sports"],
                          target_items_per_section: 10,
                          news_time_window: "24h",
                          final_delivery_shape: "one final message",
                        },
                        stages: {
                          "draft.revise": {
                            owner: "editor",
                            goal: "Revise current product draft",
                            input: ["proofread_feedback"],
                            output: ["revised_product_draft"],
                            notes: ["stay in draft lane"],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      stages: {
                        "draft.revise": {
                          stage_id: "draft.revise",
                          next_stage: "draft.recheck",
                          semantic_description: "close revision after sufficient evidence",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              step_statuses: ["manager_draft_revise_closed"],
                              allowed_roles: ["manager"],
                            },
                          ],
                        },
                      },
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["agent-self", "worker-2"],
                      },
                    },
                    group: {
                      group_slug: "public-lobby",
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                slug: "public-lobby",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-1",
                      cycle_number: 1,
                      task_goal: "produce a real cycle output",
                      next_stage: "draft.recheck",
                      workers_ready: ["editor"],
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "draft.revise",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "draft.revise",
                next_stage: "draft.recheck",
                next_stage_allowed: false,
                current_stage_complete: false,
                satisfied_gates: ["manager_start"],
                advanced_from: "draft.proofread",
                advanced_to: "draft.revise",
                stage_snapshots: { noisy: true },
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
                observed_statuses: [{ id: 1 }, { id: 2 }],
                latest_forced_proceed_stage_ids: ["material.review"],
                latest_final_artifact_message_id: "msg-final",
                last_status_block: { noisy: true },
              },
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const runtimeContext = await integration.fetchRuntimeContext("group-1", state);
    assert.equal(runtimeContext.protocol_version, "ACP-003");
    assert.equal(runtimeContext.role_card.current_agent_role, "editor");
    assert.equal(runtimeContext.workflow_stage_card.goal, "Revise current product draft");
    assert.equal(runtimeContext.execution_stage_card.execution_spec_id, "spec-1");
    assert.equal(runtimeContext.runtime_session_card.current_stage, "draft.revise");
    assert.equal(runtimeContext.runtime_session_card.observed_status_count, 2);
    assert.equal("gate_snapshot" in runtimeContext, false);
    assert.equal("state_json" in runtimeContext, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("group context and workflow contract caches store slim cards only", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                id: "group-1",
                name: "Public Lobby",
                slug: "public-lobby",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-2",
                      cycle_number: 2,
                      task_goal: "reduce token usage",
                      next_stage: "draft.compose",
                      stage_owner: "manager",
                      workers_ready: ["worker-a", "worker-b"],
                      protocol_note: "manager only advances stage",
                      observation: "workers ready",
                      giant_blob: { should_not: "persist" },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.loadGroupContext(state, "group-1");
    integration.loadWorkflowContract("group-1", {
      workflow_id: "wf-1",
      current_stage: "draft.compose",
      owner: "editor",
      goal: "compose draft",
      output: ["product_draft"],
      acceptance: ["complete structure"],
      notes: ["no giant raw blob"],
      giant_blob: { should_not: "persist" },
    }, "event");

    const storedContext = JSON.parse(fs.readFileSync(path.join(process.env.COMMUNITY_TEMPLATE_HOME, "state", "community-channel-contexts.json"), "utf8"));
    const storedWorkflow = JSON.parse(fs.readFileSync(path.join(process.env.COMMUNITY_TEMPLATE_HOME, "state", "community-workflow-contracts.json"), "utf8"));

    assert.equal("task_goal" in storedContext["group-1"].payload.card, true);
    assert.equal("giant_blob" in storedContext["group-1"].payload.card, false);
    assert.equal(storedWorkflow["group-1"].payload.card.goal, "compose draft");
    assert.equal("giant_blob" in storedWorkflow["group-1"].payload.card, false);
  } finally {
    global.fetch = originalFetch;
  }
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

test("sendCommunityMessage preserves top-level status_block and context_block", async () => {
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-formal-1", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(state, null, {
      group_id: "group-1",
      flow_type: "result",
      message_type: "analysis",
      content: {
        text: "manager formal close",
        payload: {
          kind: "cycle_task_plan",
          task_plan: "decompose the cycle into four sections and collect real materials before drafting",
        },
      },
      status_block: {
        workflow_id: "newsflow-workflow-debug-v1",
        step_id: "cycle.start",
        lifecycle_phase: "result",
        author_role: "manager",
        author_agent_id: "agent-self",
        step_status: "manager_cycle_start_closed",
        related_message_id: "incoming-1",
      },
      context_block: {
        context_scope: "group",
        context_type: "group_context",
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].flow_type, "result");
    assert.equal(sent[0].status_block.workflow_id, "newsflow-workflow-debug-v1");
    assert.equal(sent[0].status_block.step_status, "manager_cycle_start_closed");
    assert.equal(sent[0].content.payload.kind, "cycle_task_plan");
    assert.equal(sent[0].context_block.context_type, "group_context");
  } finally {
    global.fetch = originalFetch;
  }
});

test("receiveCommunityEvent executes required judgment and posts reply", async () => {
  const sent = [];
  const modelRequests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["agent-self"],
                      role_assignments: {
                        editor: {
                          agent_id: "agent-self",
                          server_gate_role: "worker",
                          responsibility: "compose product draft",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "formal_newsflow_debug",
                      group_objective: "Produce a Chinese news product",
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                      worker_inputs_are_evidence_not_transition_gates: true,
                      plain_text_cannot_replace_manager_formal_signal: true,
                    },
                    workflow: {
                      formal_workflow: {
                        product_contract: {
                          language: "zh-CN",
                          sections: ["technology"],
                          target_items_per_section: 10,
                          news_time_window: "24h",
                          final_delivery_shape: "one final message",
                        },
                        stages: {
                          "draft.revise": {
                            owner: "editor",
                            goal: "Revise current product draft",
                            input: ["proofread_feedback"],
                            output: ["revised_product_draft"],
                            notes: ["stay in draft lane"],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["agent-self"],
                      },
                      stages: {
                        "draft.revise": {
                          stage_id: "draft.revise",
                          next_stage: "draft.recheck",
                          semantic_description: "close revision after sufficient evidence",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              step_statuses: ["manager_draft_revise_closed"],
                              allowed_roles: ["manager"],
                            },
                          ],
                        },
                      },
                    },
                    group: { group_slug: "public-lobby" },
                  },
                },
              },
              applicable_rule_ids: [],
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                slug: "public-lobby",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-1",
                      cycle_number: 1,
                      task_goal: "ship the product draft",
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "draft.revise",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "draft.revise",
                next_stage: "draft.recheck",
                next_stage_allowed: false,
                current_stage_complete: false,
                satisfied_gates: ["manager_start"],
                giant_blob: { should_not: "mount" },
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
                observed_statuses: [{ id: 1 }],
                giant_blob: { should_not: "mount" },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/chat/completions")) {
      modelRequests.push(JSON.parse(options.body));
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    should_send: true,
                    flow_type: "run",
                    message_type: "analysis",
                    text: "generated reply",
                    payload: { kind: "agent_execution_reply", summary: "ok" },
                    reason: "required_collaboration",
                  }),
                },
              },
            ],
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
    assert.equal(result.decision.action, "full_reply");
    assert.equal(result.posted, true);
    assert.equal(modelRequests.length, 1);
    const systemPrompt = modelRequests[0].messages[0].content;
    assert.equal(systemPrompt.includes('"gate_snapshot"'), false);
    assert.equal(systemPrompt.includes('"state_json"'), false);
    assert.equal(systemPrompt.includes("Current workflow stage card"), true);
    assert.equal(systemPrompt.includes("Current execution stage card"), true);
    assert.equal(systemPrompt.includes('"current_stage": "draft.revise"'), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.text, "generated reply");
    assert.equal(sent[0].content.payload.kind, "agent_execution_reply");
    assert.equal(sent[0].routing.target.agent_id, "agent-other");
    assert.equal(sent[0].relations.parent_message_id, "msg-in-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("receiveCommunityEvent retries model call without response_format when model rejects json_object", async () => {
  const sent = [];
  const modelRequests = [];
  let modelAttempt = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["agent-self"],
                      role_assignments: {
                        editor: {
                          agent_id: "agent-self",
                          server_gate_role: "worker",
                          responsibility: "compose product draft",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "formal_newsflow_debug",
                      group_objective: "Produce a Chinese news product",
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                      worker_inputs_are_evidence_not_transition_gates: true,
                      plain_text_cannot_replace_manager_formal_signal: true,
                    },
                    workflow: {
                      formal_workflow: {
                        product_contract: {
                          language: "zh-CN",
                          sections: ["technology"],
                          target_items_per_section: 10,
                          news_time_window: "24h",
                          final_delivery_shape: "one final message",
                        },
                        stages: {
                          "draft.revise": {
                            owner: "editor",
                            goal: "Revise current product draft",
                            input: ["proofread_feedback"],
                            output: ["revised_product_draft"],
                            notes: ["stay in draft lane"],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["agent-self"],
                      },
                      stages: {
                        "draft.revise": {
                          stage_id: "draft.revise",
                          next_stage: "draft.recheck",
                          semantic_description: "close revision after sufficient evidence",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              step_statuses: ["manager_draft_revise_closed"],
                              allowed_roles: ["manager"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                slug: "public-lobby",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-1",
                      cycle_number: 1,
                      task_goal: "produce a real cycle output",
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "draft.revise",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "draft.revise",
                next_stage: "draft.recheck",
                next_stage_allowed: false,
                current_stage_complete: false,
                satisfied_gates: ["manager_start"],
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
                observed_statuses: [{ id: 1 }],
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/chat/completions")) {
      modelAttempt += 1;
      modelRequests.push(JSON.parse(options.body));
      if (modelAttempt === 1) {
        return {
          ok: false,
          async json() {
            return {
              error: {
                code: "InvalidParameter",
                param: "response_format.type",
                message: "json_object is not supported by this model",
              },
            };
          },
        };
      }
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    should_send: true,
                    flow_type: "run",
                    message_type: "analysis",
                    text: "generated reply after fallback",
                    payload: { kind: "agent_execution_reply", summary: "ok" },
                    reason: "required_collaboration",
                  }),
                },
              },
            ],
          };
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-fallback-1", group_id: "group-1" } });
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
            id: "msg-in-fallback-1",
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
          id: "msg-in-fallback-1",
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

    assert.equal(result.decision.action, "full_reply");
    assert.equal(modelRequests.length, 2);
    assert.equal(modelRequests[0].response_format.type, "json_object");
    assert.equal("response_format" in modelRequests[1], false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.text, "generated reply after fallback");
  } finally {
    global.fetch = originalFetch;
  }
});

test("receiveCommunityEvent enriches formal status_block with workflow and role fields before send", async () => {
  const sent = [];
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager Self",
    profile: { display_name: "Manager Self", handle: "manager-self" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["worker-a", "worker-b"],
                      role_assignments: {},
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "formal_newsflow_debug",
                      group_objective: "Produce a Chinese news product",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "draft.revise": {
                            owner: "manager",
                            goal: "Close draft revise with a manager formal signal",
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
                      },
                      stages: {
                        "draft.revise": {
                          stage_id: "draft.revise",
                          next_stage: "draft.recheck",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              step_statuses: ["manager_draft_revise_closed"],
                              allowed_roles: ["manager"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                slug: "public-lobby",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-1",
                      cycle_number: 1,
                      task_goal: "close current stage",
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "draft.revise",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "draft.revise",
                next_stage: "draft.recheck",
                next_stage_allowed: false,
                current_stage_complete: false,
                satisfied_gates: [],
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
                observed_statuses: [],
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/chat/completions")) {
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    should_send: true,
                    flow_type: "result",
                    message_type: "summary",
                    text: "manager formal close",
                    payload: {
                      kind: "draft_revision_record",
                      final_summary: "manager verified the revised draft against the requested changes",
                      evidence_refs: ["msg-manager-formal-1"],
                    },
                    status_block: {
                      lifecycle_phase: "result",
                      step_status: "manager_draft_revise_closed",
                    },
                    reason: "required_manager_close",
                  }),
                },
              },
            ],
          };
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-formal-2", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.receiveCommunityEvent(managerState, {
      event: {
        event_type: "message.posted",
        payload: {
          message: {
            id: "msg-manager-formal-1",
            group_id: "group-1",
            author: { agent_id: "agent-other" },
            flow_type: "run",
            message_type: "analysis",
            content: { text: "Please close draft.revise now." },
            relations: { thread_id: "thread-1", parent_message_id: null },
            routing: { target: { agent_id: "manager-1" }, mentions: [] },
            extensions: {},
          },
        },
      },
      entity: {
        message: {
          id: "msg-manager-formal-1",
          group_id: "group-1",
          author: { agent_id: "agent-other" },
          flow_type: "run",
          message_type: "analysis",
          content: { text: "Please close draft.revise now." },
          relations: { thread_id: "thread-1", parent_message_id: null },
          routing: { target: { agent_id: "manager-1" }, mentions: [] },
          extensions: {},
        },
      },
      group_id: "group-1",
    });

    assert.equal(result.decision.action, "full_reply");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.workflow_id, "newsflow-workflow-debug-v1");
    assert.equal(sent[0].status_block.step_id, "draft.revise");
    assert.equal(sent[0].status_block.author_role, "manager");
    assert.equal(sent[0].status_block.author_agent_id, "manager-1");
    assert.equal(sent[0].status_block.related_message_id, "msg-manager-formal-1");
    assert.equal(sent[0].status_block.step_status, "manager_draft_revise_closed");
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage enriches partial formal status_block on the common outbound path", async () => {
  const sent = [];
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager Self",
    profile: { display_name: "Manager Self", handle: "manager-self" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["worker-a"],
                      role_assignments: {},
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "formal_newsflow_debug",
                      group_objective: "Produce a Chinese news product",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "draft.revise": {
                            owner: "manager",
                            goal: "Close draft revise",
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                      stages: {
                        "draft.revise": {
                          stage_id: "draft.revise",
                          next_stage: "draft.recheck",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                slug: "public-lobby",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-1",
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "draft.revise",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "draft.revise",
                next_stage: "draft.recheck",
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
                observed_statuses: [],
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-formal-common-1", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-common-1",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager close via common send path",
          payload: { kind: "manager_stage_close" },
        },
        status_block: {
          lifecycle_phase: "result",
          step_status: "manager_draft_revise_closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.workflow_id, "newsflow-workflow-debug-v1");
    assert.equal(sent[0].status_block.step_id, "draft.revise");
    assert.equal(sent[0].status_block.author_role, "manager");
    assert.equal(sent[0].status_block.author_agent_id, "manager-1");
    assert.equal(sent[0].status_block.step_status, "manager_draft_revise_closed");
    assert.equal(sent[0].status_block.related_message_id, "msg-parent-common-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage canonicalizes generic manager close status to stage-specific formal status", async () => {
  const sent = [];
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager Self",
    profile: { display_name: "Manager Self", handle: "manager-self" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["worker-a"],
                      role_assignments: {},
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "formal_newsflow_debug",
                      group_objective: "Produce a Chinese news product",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "retrospective.discussion": {
                            owner: "manager",
                            goal: "Close retrospective discussion",
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                      stages: {
                        "retrospective.discussion": {
                          stage_id: "retrospective.discussion",
                          next_stage: "retrospective.summary",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_retrospective_discussion_closed"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                slug: "public-lobby",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-1",
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "retrospective.discussion",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "retrospective.discussion",
                next_stage: "retrospective.summary",
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
                observed_statuses: [],
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-formal-common-2", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-common-2",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager closes retrospective discussion",
          payload: {
            kind: "discussion_record",
            evidence_refs: ["msg-parent-common-2"],
            final_summary: "discussion completed with actionable findings and explicit next-step references",
          },
        },
        status_block: {
          lifecycle_phase: "result",
          step_status: "closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.workflow_id, "newsflow-workflow-debug-v1");
    assert.equal(sent[0].status_block.step_id, "retrospective.discussion");
    assert.equal(sent[0].status_block.author_role, "manager");
    assert.equal(sent[0].status_block.author_agent_id, "manager-1");
    assert.equal(sent[0].status_block.step_status, "manager_retrospective_discussion_closed");
    assert.equal(sent[0].status_block.related_message_id, "msg-parent-common-2");
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage mirrors step_statuses[0] into step_status when the model leaves step_status empty", async () => {
  const sent = [];
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager Self",
    profile: { display_name: "Manager Self", handle: "manager-self" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["worker-a"],
                      role_assignments: {},
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                      stages: {
                        "retrospective.discussion": {
                          stage_id: "retrospective.discussion",
                          next_stage: "retrospective.summary",
                          allowed_roles: ["manager"],
                          accepted_status_rules: [
                            {
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_retrospective_discussion_closed"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: { group: { slug: "public-lobby", metadata_json: {} } },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "retrospective.discussion",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "retrospective.discussion",
                next_stage: "retrospective.summary",
              },
              state_json: { cycle_id: "cycle-1", cycle_number: 1, observed_statuses: [] },
            },
          });
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-formal-common-2", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-common-2",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager close via step_statuses fallback",
          payload: {
            kind: "discussion_record",
            evidence_refs: ["msg-parent-common-2"],
            final_summary: "discussion closed after collecting the required evidence references",
          },
        },
        status_block: {
          stage_id: "retrospective.discussion",
          lifecycle_phase: "result",
          allowed_roles: ["manager"],
          step_statuses: ["manager_retrospective_discussion_closed"],
          step_status: "",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, "retrospective.discussion");
    assert.equal(sent[0].status_block.author_role, "manager");
    assert.equal(sent[0].status_block.step_status, "manager_retrospective_discussion_closed");
    assert.deepEqual(sent[0].status_block.step_statuses, ["manager_retrospective_discussion_closed"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage remaps stale step_id to the next stage when the formal status belongs there", async () => {
  const sent = [];
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager Self",
    profile: { display_name: "Manager Self", handle: "manager-self" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["worker-a"],
                      role_assignments: {},
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                      stages: {
                        "agent.optimization": {
                          stage_id: "agent.optimization",
                          next_stage: "agent.self_optimize",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_agent_optimization_closed"],
                            },
                          ],
                        },
                        "agent.self_optimize": {
                          stage_id: "agent.self_optimize",
                          next_stage: "optimization.rule.apply",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_agent_self_optimize_closed"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: { group: { slug: "public-lobby", metadata_json: {} } },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "agent.optimization",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "agent.optimization",
                next_stage: "agent.self_optimize",
              },
              state_json: { cycle_id: "cycle-1", cycle_number: 1, observed_statuses: [] },
            },
          });
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-formal-common-3", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-common-3",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager closes self optimization",
          payload: {
            kind: "per_agent_self_optimization_notes",
            artifact_refs: ["note-1"],
            final_summary: "all non-manager self-optimization notes were collected for the next stage",
          },
        },
        status_block: {
          step_id: "agent.optimization",
          lifecycle_phase: "result",
          step_status: "manager_agent_self_optimize_closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, "agent.self_optimize");
    assert.equal(sent[0].status_block.step_status, "manager_agent_self_optimize_closed");
    assert.equal(sent[0].status_block.author_role, "manager");
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage suppresses manager formal close when no stage artifact or evidence is present", async () => {
  const sent = [];
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager Self",
    profile: { display_name: "Manager Self", handle: "manager-self" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["worker-a"],
                      role_assignments: {},
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "retrospective.discussion": {
                            owner: "manager",
                            goal: "Close retrospective discussion",
                            input: ["retrospective_plan"],
                            output: ["discussion_record"],
                          },
                        },
                      },
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                      stages: {
                        "retrospective.discussion": {
                          stage_id: "retrospective.discussion",
                          next_stage: "retrospective.summary",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_retrospective_discussion_closed"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: { group: { slug: "public-lobby", metadata_json: {} } },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "retrospective.discussion",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "retrospective.discussion",
                next_stage: "retrospective.summary",
              },
              state_json: { cycle_id: "cycle-1", cycle_number: 1, observed_statuses: [] },
            },
          });
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-formal-suppressed", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-suppressed",
        group_id: "group-1",
        thread_id: "thread-1",
        content: { text: "plain worker ack", payload: {} },
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager tries to close without evidence",
          payload: { kind: "manager_stage_close" },
        },
        status_block: {
          lifecycle_phase: "result",
          step_status: "closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.ok(!sent[0].status_block || !sent[0].status_block.step_status);
    assert.equal(sent[0].extensions.custom.formal_signal_suppressed_reason, "missing_stage_artifact_evidence");
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage suppresses manager formal close when the payload kind does not match the current stage output", async () => {
  const sent = [];
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager Self",
    profile: { display_name: "Manager Self", handle: "manager-self" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["worker-a"],
                      role_assignments: {},
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "material.collect": {
                            owner: "worker_a_and_worker_b_under_manager_dispatch",
                            goal: "Collect real materials",
                            input: ["cycle_task_plan"],
                            output: ["candidate_material_pool"],
                          },
                        },
                      },
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                      stages: {
                        "material.collect": {
                          stage_id: "material.collect",
                          next_stage: "material.review",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_material_collect_closed"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: { group: { slug: "public-lobby", metadata_json: {} } },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "material.collect",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "material.collect",
                next_stage: "material.review",
              },
              state_json: { cycle_id: "cycle-1", cycle_number: 1, observed_statuses: [] },
            },
          });
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-formal-mismatch", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-material-generic",
        group_id: "group-1",
        thread_id: "thread-1",
        content: { text: "plain trigger", payload: {} },
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager tries to close material.collect with a generic summary",
          payload: {
            kind: "manager_stage_close",
            evidence_refs: ["msg-worker-raw-materials"],
            final_summary: "collected enough materials",
          },
        },
        status_block: {
          lifecycle_phase: "result",
          step_status: "manager_material_collect_closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.ok(!sent[0].status_block || !sent[0].status_block.step_status);
    assert.equal(sent[0].extensions.custom.formal_signal_suppressed_reason, "missing_stage_artifact_evidence");
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage preserves manager formal close when the payload carries the current stage artifact kind and body", async () => {
  const sent = [];
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager Self",
    profile: { display_name: "Manager Self", handle: "manager-self" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["worker-a"],
                      role_assignments: {},
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "material.collect": {
                            owner: "worker_a_and_worker_b_under_manager_dispatch",
                            goal: "Collect real materials",
                            input: ["cycle_task_plan"],
                            output: ["candidate_material_pool"],
                          },
                        },
                      },
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                      stages: {
                        "material.collect": {
                          stage_id: "material.collect",
                          next_stage: "material.review",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_material_collect_closed"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: { group: { slug: "public-lobby", metadata_json: {} } },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "material.collect",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "material.collect",
                next_stage: "material.review",
              },
              state_json: { cycle_id: "cycle-1", cycle_number: 1, observed_statuses: [] },
            },
          });
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-formal-material-pass", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-material-artifact",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager closes material.collect with a real candidate pool",
          payload: {
            kind: "candidate_material_pool",
            sections: [
              {
                section: "politics_economy",
                items: [
                  {
                    title: "sample item",
                    source: "https://example.com/news-1",
                    published_at: "2026-04-17T06:00:00Z",
                  },
                ],
              },
            ],
            final_summary: "materials collected for all sections",
          },
        },
        status_block: {
          lifecycle_phase: "result",
          step_status: "manager_material_collect_closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_status, "manager_material_collect_closed");
    assert.equal(sent[0].status_block.step_id, "material.collect");
    assert.equal(sent[0].content.payload.kind, "candidate_material_pool");
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage suppresses non-manager impersonation of manager formal close", async () => {
  const sent = [];
  const workerState = {
    ...state,
    agentId: "worker-a",
    agentName: "Worker A",
    profile: { display_name: "Worker A", handle: "worker-a" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              protocol: {
                version: "ACP-003",
                layers: {
                  group: {
                    members: {
                      manager_agent_id: "manager-1",
                      worker_agent_ids: ["worker-a"],
                      role_assignments: {
                        worker_a: {
                          agent_id: "worker-a",
                          server_gate_role: "worker",
                        },
                      },
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "publish.decision": {
                            owner: "manager",
                            goal: "Close publish decision",
                            output: ["publish_decision"],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                      stages: {
                        "publish.decision": {
                          stage_id: "publish.decision",
                          next_stage: "report.publish",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_publish_decision_closed"],
                            },
                          ],
                        },
                      },
                    },
                  },
                },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: { group: { slug: "public-lobby", metadata_json: {} } },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "publish.decision",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "publish.decision",
                next_stage: "report.publish",
              },
              state_json: { cycle_id: "cycle-1", cycle_number: 1, observed_statuses: [] },
            },
          });
        },
      };
    }
    if (String(url).includes("/messages")) {
      sent.push(JSON.parse(options.body));
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "reply-worker-suppressed", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      workerState,
      {
        id: "msg-parent-worker",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "worker tries to emit manager close",
          payload: {
            kind: "publish_decision",
            final_summary: "this should not be counted as manager close from a worker",
          },
        },
        status_block: {
          workflow_id: "newsflow-workflow-debug-v1",
          step_id: "publish.decision",
          lifecycle_phase: "result",
          author_role: "manager",
          author_agent_id: "worker-a",
          step_status: "manager_publish_decision_closed",
          related_message_id: "msg-parent-worker",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.ok(!sent[0].status_block || !sent[0].status_block.step_status);
  } finally {
    global.fetch = originalFetch;
  }
});

test("non-targeted collaboration remains observed only at integration layer", async () => {
  const originalFetch = global.fetch;
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
          return JSON.stringify({
            success: true,
            data: {
              group: {
                slug: "public-lobby",
                metadata_json: { community_v2: { group_context: { cycle_id: "cycle-1", task_goal: "context" } } },
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-workflow-debug-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "draft.revise",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: { current_stage: "draft.revise" },
              state_json: { cycle_id: "cycle-1" },
            },
          });
        },
      };
    }
    if (String(url).includes("/chat/completions")) {
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    should_send: false,
                    reason: "optional_observe_only",
                  }),
                },
              },
            ],
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
