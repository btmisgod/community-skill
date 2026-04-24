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
                            organizer_role: "editor",
                            primary_consumer_role: "tester",
                            observe_only_roles: ["worker_a", "worker_b"],
                            goal: "Revise current product draft",
                            input: ["proofread_feedback"],
                            output: ["revised_product_draft"],
                            allowed_action_modules: ["resubmit_artifact", "close_or_handoff"],
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
    assert.deepEqual(runtimeContext.workflow_stage_card.allowed_action_modules, ["resubmit_artifact", "close_or_handoff"]);
    assert.equal(runtimeContext.workflow_stage_card.organizer_role, "editor");
    assert.equal(runtimeContext.workflow_stage_card.primary_consumer_role, "tester");
    assert.deepEqual(runtimeContext.workflow_stage_card.observe_only_roles, ["worker_a", "worker_b"]);
    assert.equal(runtimeContext.execution_stage_card.execution_spec_id, "spec-1");
    assert.equal(runtimeContext.runtime_session_card.current_stage, "draft.revise");
    assert.equal(runtimeContext.runtime_session_card.observed_status_count, 2);
    assert.equal("gate_snapshot" in runtimeContext, false);
    assert.equal("state_json" in runtimeContext, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchRuntimeContext falls back to live metadata_json.community_protocols.channel when protocol layers are absent", async () => {
  const originalFetch = global.fetch;
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager One",
    profile: { display_name: "Manager One", handle: "manager-1" },
  };
  global.fetch = async (url) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                metadata_json: {
                  community_protocols: {
                    channel: {
                      members: {
                        manager_agent_id: "manager-1",
                        worker_agent_ids: ["worker-a", "worker-b"],
                        role_assignments: {
                          manager: {
                            agent_id: "manager-1",
                            server_gate_role: "manager",
                            responsibility: "publish the cycle task plan",
                          },
                        },
                      },
                      group_identity: {
                        group_type: "project",
                        workflow_mode: "formal_newsflow_debug",
                        group_objective: "Publish the cycle task plan before material collection",
                      },
                      workflow: {
                        formal_workflow: {
                          stages: {
                            "cycle.start": {
                              owner: "manager",
                              goal: "Define the cycle task plan, acceptance focus, and dispatch targets for the current cycle.",
                              output: ["cycle_task_plan"],
                              notes: ["manager closes only with a real cycle_task_plan artifact"],
                            },
                          },
                        },
                      },
                      execution_spec: {
                        execution_spec_id: "spec-cycle-start-live",
                        stages: {
                          "cycle.start": {
                            stage_id: "cycle.start",
                            next_stage: "material.collect",
                            semantic_description: "manager publishes the cycle task plan",
                            allowed_roles: ["manager"],
                            accepted_status_blocks: [
                              {
                                gate_id: "manager_done",
                                lifecycle_phase: "result",
                                step_statuses: ["manager_cycle_start_closed"],
                                allowed_roles: ["manager"],
                              },
                            ],
                          },
                        },
                        role_directory: {
                          manager_agent_ids: ["manager-1"],
                          worker_agent_ids: ["worker-a", "worker-b"],
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
                slug: "cycle-start-live",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-7",
                      cycle_number: 7,
                      task_goal: "publish the cycle task plan before material.collect",
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
              workflow_id: "newsflow-action-composed-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "cycle.start",
              protocol_version: "ACP-003",
              group_session_version: "group-session:cycle-start-1",
              gate_snapshot: {
                current_stage: "cycle.start",
                next_stage: "material.collect",
                next_required_formal_signal: {
                  gate_id: "manager_done",
                  producer_role: "manager",
                  lifecycle_phase: "result",
                  step_id: "cycle.start",
                  step_status: "manager_cycle_start_closed",
                  required_agent_ids: ["manager-1"],
                },
              },
              state_json: {
                observed_statuses: [],
              },
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const runtimeContext = await integration.fetchRuntimeContext("group-1", managerState);
    assert.equal(runtimeContext.workflow_stage_card.stage_id, "cycle.start");
    assert.equal(runtimeContext.workflow_stage_card.goal, "Define the cycle task plan, acceptance focus, and dispatch targets for the current cycle.");
    assert.deepEqual(runtimeContext.workflow_stage_card.output, ["cycle_task_plan"]);
    assert.equal(runtimeContext.execution_stage_card.next_stage, "material.collect");
    assert.equal(runtimeContext.pending_formal_signal_card.step_status, "manager_cycle_start_closed");
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchRuntimeContext falls back to context metadata when the protocol endpoint is unavailable", async () => {
  const originalFetch = global.fetch;
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager One",
    profile: { display_name: "Manager One", handle: "manager-1" },
  };
  global.fetch = async (url) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      throw new Error("temporary protocol timeout");
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                slug: "cycle-start-live",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-9",
                      cycle_number: 9,
                      task_goal: "publish the cycle task plan before material.collect",
                    },
                  },
                  community_protocols: {
                    channel: {
                      members: {
                        manager_agent_id: "manager-1",
                        worker_agent_ids: ["worker-a", "worker-b"],
                        role_assignments: {
                          manager: {
                            agent_id: "manager-1",
                            server_gate_role: "manager",
                            responsibility: "publish the cycle task plan",
                          },
                        },
                      },
                      group_identity: {
                        group_type: "project",
                        workflow_mode: "formal_newsflow_debug",
                        group_objective: "Publish the cycle task plan before material collection",
                      },
                      workflow: {
                        formal_workflow: {
                          stages: {
                            "cycle.start": {
                              owner: "manager",
                              goal: "Define the cycle task plan, acceptance focus, and dispatch targets for the current cycle.",
                              output: ["cycle_task_plan"],
                              notes: ["manager closes only with a real cycle_task_plan artifact"],
                            },
                          },
                        },
                      },
                      execution_spec: {
                        execution_spec_id: "spec-cycle-start-context-fallback",
                        stages: {
                          "cycle.start": {
                            stage_id: "cycle.start",
                            next_stage: "material.collect",
                            semantic_description: "manager publishes the cycle task plan",
                            allowed_roles: ["manager"],
                            accepted_status_blocks: [
                              {
                                gate_id: "manager_done",
                                lifecycle_phase: "result",
                                step_statuses: ["manager_cycle_start_closed"],
                                allowed_roles: ["manager"],
                              },
                            ],
                          },
                        },
                        role_directory: {
                          manager_agent_ids: ["manager-1"],
                          worker_agent_ids: ["worker-a", "worker-b"],
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
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-action-composed-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "cycle.start",
              protocol_version: "ACP-003",
              group_session_version: "group-session:cycle-start-context-fallback",
              gate_snapshot: {
                current_stage: "cycle.start",
                next_stage: "material.collect",
              },
              next_required_formal_signal: {
                gate_id: "manager_done",
                producer_role: "manager",
                lifecycle_phase: "result",
                step_id: "cycle.start",
                step_status: "manager_cycle_start_closed",
                required_agent_ids: ["manager-1"],
              },
              state_json: {
                observed_statuses: [],
              },
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const runtimeContext = await integration.fetchRuntimeContext("group-1", managerState);
    assert.equal(runtimeContext.workflow_stage_card.stage_id, "cycle.start");
    assert.deepEqual(runtimeContext.workflow_stage_card.output, ["cycle_task_plan"]);
    assert.equal(runtimeContext.execution_stage_card.next_stage, "material.collect");
    assert.equal(runtimeContext.role_card.current_agent_role, "manager");
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchRuntimeContext exposes manager bootstrap control-turn as slim cards", async () => {
  const originalFetch = global.fetch;
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager One",
    profile: { display_name: "Manager One", handle: "manager-1" },
  };
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
                      worker_agent_ids: ["worker-a", "worker-b"],
                      role_assignments: {
                        manager: {
                          agent_id: "manager-1",
                          server_gate_role: "manager",
                          responsibility: "bootstrap kickoff and formal control",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "bootstrap",
                      group_objective: "Establish the startup surface",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step0: {
                            owner: "manager",
                            goal: "Establish the startup surface",
                            notes: ["publish the startup brief"],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      stages: {
                        step0: {
                          stage_id: "step0",
                          next_stage: "step1",
                          semantic_description: "Manager bootstrap kickoff",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "done",
                              step_statuses: ["step0_done"],
                              allowed_roles: ["manager"],
                            },
                          ],
                        },
                      },
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
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
                      task_goal: "start the group cleanly",
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
              current_mode: "bootstrap",
              current_stage: "step0",
              protocol_version: "ACP-003",
              group_session_version: "group-session:bootstrap-1",
              gate_snapshot: {
                current_stage: "step0",
                next_stage: "step1",
                next_stage_allowed: false,
                current_stage_complete: false,
                gates: {
                  manager_done: {
                    required_agent_ids: ["manager-1"],
                  },
                },
              },
              next_required_formal_signal: {
                gate_id: "manager_done",
                step_id: "step0",
                step_status: "step0_done",
                producer_role: "manager",
                lifecycle_phase: "done",
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
              },
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const runtimeContext = await integration.fetchRuntimeContext("group-1", managerState);
    assert.equal(runtimeContext.role_card.current_agent_role, "manager");
    assert.equal(runtimeContext.pending_formal_signal_card.step_status, "step0_done");
    assert.equal(runtimeContext.pending_formal_signal_card.producer_role, "manager");
    assert.deepEqual(runtimeContext.pending_formal_signal_card.required_agent_ids, ["manager-1"]);
    assert.equal(runtimeContext.bootstrap_control_turn_card.current_stage, "step0");
    assert.equal(runtimeContext.bootstrap_control_turn_card.text_first_control_message_allowed, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("buildExecutionPrompt tells manager bootstrap control-turn to emit text-first formal signal", () => {
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager One",
    profile: { display_name: "Manager One", handle: "manager-1" },
  };
  const prompt = integration.buildExecutionPrompt(
    {
      group_id: "group-1",
      message_type: null,
      content: {},
    },
    managerState,
    {
      role_card: { current_agent_role: "manager" },
      workflow_stage_card: { goal: "Establish the startup surface" },
      execution_stage_card: {
        stage_id: "step0",
        allowed_roles: ["manager"],
        accepted_status_rules: [
          {
            gate_id: "manager_done",
            lifecycle_phase: "done",
            step_statuses: ["step0_done"],
            allowed_roles: ["manager"],
          },
        ],
      },
      runtime_session_card: {
        current_mode: "bootstrap",
        current_stage: "step0",
      },
      pending_formal_signal_card: {
        gate_id: "manager_done",
        step_id: "step0",
        step_status: "step0_done",
        producer_role: "manager",
        lifecycle_phase: "done",
      },
      bootstrap_control_turn_card: {
        current_mode: "bootstrap",
        current_stage: "step0",
        step_id: "step0",
        step_status: "step0_done",
        lifecycle_phase: "done",
        text_first_control_message_allowed: true,
      },
      transition_rules_card: {},
    },
    {
      obligation: { obligation: "required", reason: "server_manager_control_turn" },
      recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
    },
  );

  assert.match(prompt[0].content, /Bootstrap control-turn card/);
  assert.match(prompt[0].content, /text_first_control_message_allowed/);
  assert.match(prompt[0].content, /send the required public coordination message now with the exact top-level status_block/i);
  assert.match(prompt[1].content, /If message_content is empty because this is a group_session control turn/i);
});

test("buildExecutionPrompt tells matching role to emit the exact pending formal signal", () => {
  const prompt = integration.buildExecutionPrompt(
    {
      group_id: "group-1",
      message_type: "analysis",
      content: { text: "worker confirmations are in" },
    },
    {
      ...state,
      agentId: "manager-1",
      agentName: "Manager One",
      profile: { display_name: "Manager One", handle: "manager-1" },
    },
    {
      role_card: { current_agent_role: "manager", server_gate_role: "manager" },
      workflow_stage_card: {
        stage_id: "step1",
        goal: "Align task understanding",
        output: [],
      },
      execution_stage_card: {
        stage_id: "step1",
        accepted_status_rules: [
          {
            gate_id: "manager_done",
            lifecycle_phase: "done",
            step_statuses: ["step1_done"],
            allowed_roles: ["manager"],
          },
        ],
      },
      runtime_session_card: {
        current_mode: "bootstrap",
        current_stage: "step1",
        workflow_id: "newsflow-workflow-debug-v1",
      },
      pending_formal_signal_card: {
        gate_id: "manager_done",
        step_id: "step1",
        step_status: "step1_done",
        producer_role: "manager",
        lifecycle_phase: "done",
      },
      bootstrap_control_turn_card: {
        current_mode: "bootstrap",
        current_stage: "step1",
        step_id: "step1",
        step_status: "step1_done",
        lifecycle_phase: "done",
        text_first_control_message_allowed: true,
      },
      transition_rules_card: {},
    },
    {
      obligation: { obligation: "required", reason: "server_manager_control_turn" },
    },
  );

  assert.match(prompt[0].content, /Pending formal signal card identifies your role/i);
  assert.match(prompt[0].content, /step_status=step1_done/i);
});

test("executeRuntimeJudgment emits deterministic bootstrap manager start with the exact pending signal", async () => {
  const sent = [];
  let modelCalled = false;
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager One",
    profile: { display_name: "Manager One", handle: "manager-1" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/chat/completions")) {
      modelCalled = true;
      throw new Error("bootstrap manager start should not call the model");
    }
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
                      worker_agent_ids: ["editor-1", "tester-1", "worker-a", "worker-b"],
                      role_assignments: {
                        manager: {
                          agent_id: "manager-1",
                          server_gate_role: "manager",
                          responsibility: "publish startup and cycle plans",
                        },
                        editor: {
                          agent_id: "editor-1",
                          server_gate_role: "worker",
                        },
                        tester: {
                          agent_id: "tester-1",
                          server_gate_role: "worker",
                        },
                        worker_a: {
                          agent_id: "worker-a",
                          server_gate_role: "worker",
                        },
                        worker_b: {
                          agent_id: "worker-b",
                          server_gate_role: "worker",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "newsflow_action_composed_live",
                      group_objective: "Complete startup and then run the action-composed workflow.",
                    },
                    workflow: {
                      formal_workflow: {
                        workflow_id: "newsflow-workflow-debug-v1",
                        product_contract: {
                          language: "zh-CN",
                          sections: ["politics_economy", "technology", "sports", "entertainment"],
                          target_items_per_section: 10,
                          final_delivery_shape: "one final product message plus a report",
                        },
                        stages: {
                          step1: {
                            owner: "non_manager_alignment_under_manager_closure",
                            goal: "Let every non-manager agent confirm task understanding and role boundaries.",
                            output: ["alignment_confirmations"],
                            notes: [],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      workflow_id: "newsflow-workflow-debug-v1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["editor-1", "tester-1", "worker-a", "worker-b"],
                      },
                      stages: {
                        step1: {
                          stage_id: "step1",
                          next_stage: "step2",
                          allowed_roles: ["manager", "editor", "tester", "worker_a", "worker_b"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_start",
                              lifecycle_phase: "start",
                              allowed_roles: ["manager"],
                              step_statuses: ["step1_start"],
                            },
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["step1_submitted"],
                            },
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "done",
                              allowed_roles: ["manager"],
                              step_statuses: ["step1_done"],
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
                slug: "project-group",
                metadata_json: {},
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
              current_mode: "bootstrap",
              current_stage: "step1",
              protocol_version: "ACP-003",
              group_session_version: "group-session:step1",
              next_required_formal_signal: {
                gate_id: "manager_start",
                producer_role: "manager",
                lifecycle_phase: "start",
                step_id: "step1",
                step_status: "step1_start",
                required_agent_ids: ["manager-1"],
              },
              gate_snapshot: {
                current_stage: "step1",
                next_stage: "step2",
                next_required_formal_signal: {
                  gate_id: "manager_start",
                  producer_role: "manager",
                  lifecycle_phase: "start",
                  step_id: "step1",
                  step_status: "step1_start",
                  required_agent_ids: ["manager-1"],
                },
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
          return JSON.stringify({ success: true, data: { id: "reply-step1-start", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(managerState, {
      message: {
        id: "msg-group-session-step1",
        group_id: "group-1",
        flow_type: "start",
        message_type: null,
        text: "",
        payload: {},
        thread_id: null,
        parent_message_id: null,
        mentions: [],
        extensions: {},
      },
      context_group_id: "group-1",
      obligation: {
        obligation: "required",
        reason: "server_manager_control_turn",
      },
      recommendation: {
        mode: "needs_agent_judgment",
        reason: "required_collaboration",
      },
    });

    assert.equal(modelCalled, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, "step1");
    assert.equal(sent[0].status_block.lifecycle_phase, "start");
    assert.equal(sent[0].status_block.step_status, "step1_start");
    assert.equal(sent[0].status_block.author_role, "manager");
    assert.match(sent[0].content.text, /step1（理解对齐阶段）|step1/);
    assert.equal(sent[0].content.payload.action_id, "close_or_handoff");
    assert.equal(result.posted, true);
    assert.equal(result.agent_execution.reason, "deterministic_bootstrap_control_turn");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment emits deterministic bootstrap formal_start with the exact pending signal", async () => {
  const sent = [];
  let modelCalled = false;
  const managerState = {
    ...state,
    agentId: "manager-1",
    agentName: "Manager One",
    profile: { display_name: "Manager One", handle: "manager-1" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/chat/completions")) {
      modelCalled = true;
      throw new Error("bootstrap formal_start should not call the model");
    }
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
                      worker_agent_ids: ["editor-1", "tester-1", "worker-a", "worker-b"],
                      role_assignments: {
                        manager: {
                          agent_id: "manager-1",
                          server_gate_role: "manager",
                          responsibility: "publish startup and cycle plans",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "newsflow_action_composed_live",
                      group_objective: "Complete startup and then run the action-composed workflow.",
                    },
                    workflow: {
                      formal_workflow: {
                        workflow_id: "newsflow-workflow-debug-v1",
                        stages: {
                          formal_start: {
                            owner: "manager",
                            goal: "Close bootstrap and hand the group into the business workflow.",
                            output: ["bootstrap_handoff_record"],
                            notes: [],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      workflow_id: "newsflow-workflow-debug-v1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["editor-1", "tester-1", "worker-a", "worker-b"],
                      },
                      stages: {
                        formal_start: {
                          stage_id: "formal_start",
                          next_stage: "cycle.start",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_formal_start",
                              lifecycle_phase: "start",
                              allowed_roles: ["manager"],
                              step_statuses: ["formal_start"],
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
                slug: "project-group",
                metadata_json: {},
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
              current_mode: "bootstrap",
              current_stage: "formal_start",
              protocol_version: "ACP-003",
              group_session_version: "group-session:formal-start",
              next_required_formal_signal: {
                gate_id: "manager_formal_start",
                producer_role: "manager",
                lifecycle_phase: "start",
                step_id: "formal_start",
                step_status: "formal_start",
                required_agent_ids: ["manager-1"],
              },
              gate_snapshot: {
                current_stage: "formal_start",
                next_stage: "cycle.start",
                next_required_formal_signal: {
                  gate_id: "manager_formal_start",
                  producer_role: "manager",
                  lifecycle_phase: "start",
                  step_id: "formal_start",
                  step_status: "formal_start",
                  required_agent_ids: ["manager-1"],
                },
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
          return JSON.stringify({ success: true, data: { id: "reply-formal-start", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(managerState, {
      message: {
        id: "msg-group-session-formal-start",
        group_id: "group-1",
        flow_type: "start",
        message_type: null,
        text: "",
        payload: {},
        thread_id: null,
        parent_message_id: null,
        mentions: [],
        extensions: {},
      },
      context_group_id: "group-1",
      obligation: {
        obligation: "required",
        reason: "server_manager_control_turn",
      },
      recommendation: {
        mode: "needs_agent_judgment",
        reason: "required_collaboration",
      },
    });

    assert.equal(modelCalled, false);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, "formal_start");
    assert.equal(sent[0].status_block.lifecycle_phase, "start");
    assert.equal(sent[0].status_block.step_status, "formal_start");
    assert.equal(sent[0].status_block.author_role, "manager");
    assert.match(sent[0].content.text, /formal_start/);
    assert.equal(sent[0].content.payload.action_id, "close_or_handoff");
    assert.equal(result.posted, true);
    assert.equal(result.agent_execution.reason, "deterministic_bootstrap_control_turn");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment preserves top-level action-module semantics in the execution prompt", async () => {
  const originalFetch = global.fetch;
  let systemPrompt = "";

  global.fetch = async (url, options) => {
    if (String(url).includes("/chat/completions")) {
      const requestBody = JSON.parse(options.body);
      systemPrompt = String(requestBody.messages?.[0]?.content || "");
      return {
        ok: true,
        async json() {
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    should_send: false,
                    flow_type: "run",
                    message_type: "analysis",
                    text: "",
                    payload: {},
                    reason: "noop",
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
    const result = await integration.executeRuntimeJudgment(state, {
      obligation: { obligation: "required", reason: "targeted" },
      recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
      message: {
        id: "incoming-1",
        flow_type: "result",
        message_type: "summary",
        text: "Stage closed with final decision.",
        status_block: {
          lifecycle_phase: "result",
          step_status: "manager_custom_stage_closed",
          author_role: "manager",
        },
      },
    });

    assert.equal(result.no_action, true);
    assert.match(systemPrompt, /Resolved current action-module card/i);
    assert.match(systemPrompt, /manager_custom_stage_closed/);
    assert.match(systemPrompt, /close_or_handoff/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment normalizes consumer follow-up action_id when the model mirrors the incoming producer action", async () => {
  const originalFetch = global.fetch;
  const sent = [];

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
                      workflow_mode: "action-module-live",
                      group_objective: "Validate reusable action modules",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          action_loop: {
                            owner: "manager",
                            goal: "Validate consumer handoff semantics",
                            output: ["public_body_visible_action_output"],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      stages: {
                        action_loop: {
                          stage_id: "action_loop",
                          accepted_status_blocks: [],
                        },
                      },
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
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
                slug: "action-module-live",
                metadata_json: {},
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
              workflow_id: "action-module-live-v1",
              current_mode: "action_module_validation",
              current_stage: "action_loop",
              protocol_version: "ACP-003",
              gate_snapshot: {
                current_stage: "action_loop",
                next_stage: null,
              },
              state_json: {
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
                    flow_type: "run",
                    message_type: "analysis",
                    text: "The next public artifact should include a visible body and the concrete output shape.",
                    payload: {
                      action_id: "ask_question",
                      kind: "clarification_answer",
                    },
                    reason: "mirrored_wrong_action_id",
                  }),
                },
              },
            ],
          };
        },
      };
    }
    if (String(url).includes("/messages")) {
      const body = JSON.parse(options.body);
      sent.push(body);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              id: "reply-ask-answer-1",
              group_id: "group-1",
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(
      {
        ...state,
        agentId: "manager-1",
        agentName: "Manager One",
        profile: { display_name: "Manager One", handle: "manager-1" },
      },
      {
        obligation: { obligation: "required", reason: "targeted_to_self" },
        recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
        message: {
          id: "ask-msg-1",
          group_id: "group-1",
          flow_type: "run",
          message_type: "analysis",
          action_id: "ask_question",
          text: "Manager, what exact output shape should the next public artifact use?",
          payload: {
            action_id: "ask_question",
            kind: "clarification_request",
            question_topic: "expected output shape",
          },
          target_agent_id: "manager-1",
          mentions: [
            {
              mention_type: "agent",
              mention_id: "manager-1",
              display_text: "@manager-1",
            },
          ],
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].action_id, "answer_question");
    assert.equal(sent[0].content.payload.action_id, "answer_question");
    assert.equal(sent[0].extensions.custom.action_id, "answer_question");
    assert.equal(sent[0].extensions.custom.consumer_follow_up_normalized, true);
    assert.equal(result?.result?.action_id || sent[0].action_id, "answer_question");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment posts generic consumer follow-up fallback for required request_rework turns with no model text", async () => {
  const originalFetch = global.fetch;
  const sent = [];

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
                          server_gate_role: "artifact_producer",
                        },
                      },
                    },
                    group_identity: {
                      workflow_mode: "action-module-live",
                      group_objective: "Validate required consumer follow-up fallback",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          review_loop: {
                            owner: "editor",
                            goal: "Handle artifact rework handoff",
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-rework",
                      stages: {
                        review_loop: {
                          stage_id: "review_loop",
                          accepted_status_blocks: [],
                        },
                      },
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["agent-self"],
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
                slug: "action-module-live",
                metadata_json: {},
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
              workflow_id: "action-module-live-v1",
              current_mode: "action_module_validation",
              current_stage: "review_loop",
              protocol_version: "ACP-003",
              gate_snapshot: {
                current_stage: "review_loop",
              },
              state_json: {
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
                    should_send: false,
                    flow_type: "run",
                    message_type: "analysis",
                    text: "",
                    payload: {},
                    reason: "model_silent_on_required_consumer_follow_up",
                  }),
                },
              },
            ],
          };
        },
      };
    }
    if (String(url).includes("/messages")) {
      const body = JSON.parse(options.body);
      sent.push(body);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              id: "reply-rework-1",
              group_id: "group-1",
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(
      {
        ...state,
        agentId: "agent-self",
        agentName: "Editor One",
        profile: { display_name: "Editor One", handle: "agent-self" },
      },
      {
        obligation: { obligation: "required", reason: "targeted_to_self" },
        recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
        message: {
          id: "rework-msg-1",
          group_id: "group-1",
          flow_type: "run",
          message_type: "analysis",
          action_id: "request_rework",
          text: "Please revise the artifact to fix the unsupported claims and resubmit it for review.",
          payload: {
            action_id: "request_rework",
            target_artifact: "artifact-7",
          },
          target_agent_id: "agent-self",
          mentions: [
            {
              mention_type: "agent",
              mention_id: "agent-self",
              display_text: "@agent-self",
            },
          ],
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].action_id, "resubmit_artifact");
    assert.equal(sent[0].content.payload.action_id, "resubmit_artifact");
    assert.equal(sent[0].content.payload.consumer_follow_up_to_action_id, "request_rework");
    assert.equal(sent[0].content.payload.consumer_follow_up_to_message_id, "rework-msg-1");
    assert.equal(sent[0].extensions.custom.consumer_follow_up_fallback, true);
    assert.match(sent[0].content.text, /resubmit_artifact/);
    assert.match(sent[0].content.text, /Request Rework/);
    assert.equal(result.posted, true);
    assert.equal(result?.result?.action_id || sent[0].action_id, "resubmit_artifact");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment posts generic consumer follow-up fallback for required request_decision turns with no model text", async () => {
  const originalFetch = global.fetch;
  const sent = [];

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
                      workflow_mode: "action-module-live",
                      group_objective: "Validate decision handoff fallback",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          decision_loop: {
                            owner: "manager",
                            goal: "Close or hand off after a decision request",
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-decision",
                      stages: {
                        decision_loop: {
                          stage_id: "decision_loop",
                          accepted_status_blocks: [],
                        },
                      },
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
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
                slug: "action-module-live",
                metadata_json: {},
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
              workflow_id: "action-module-live-v1",
              current_mode: "action_module_validation",
              current_stage: "decision_loop",
              protocol_version: "ACP-003",
              gate_snapshot: {
                current_stage: "decision_loop",
              },
              state_json: {
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
                    should_send: false,
                    flow_type: "run",
                    message_type: "analysis",
                    text: "",
                    payload: {},
                    reason: "model_silent_on_required_decision_handoff",
                  }),
                },
              },
            ],
          };
        },
      };
    }
    if (String(url).includes("/messages")) {
      const body = JSON.parse(options.body);
      sent.push(body);
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              id: "reply-decision-1",
              group_id: "group-1",
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(
      {
        ...state,
        agentId: "manager-1",
        agentName: "Manager One",
        profile: { display_name: "Manager One", handle: "manager-1" },
      },
      {
        obligation: { obligation: "required", reason: "targeted_to_self" },
        recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
        message: {
          id: "decision-msg-1",
          group_id: "group-1",
          flow_type: "run",
          message_type: "analysis",
          action_id: "request_decision",
          text: "A final choice is required between immediate closure and handoff to the next owner.",
          payload: {
            action_id: "request_decision",
            options: ["close", "handoff"],
          },
          target_agent_id: "manager-1",
          mentions: [
            {
              mention_type: "agent",
              mention_id: "manager-1",
              display_text: "@manager-1",
            },
          ],
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].action_id, "close_or_handoff");
    assert.equal(sent[0].content.payload.action_id, "close_or_handoff");
    assert.equal(sent[0].content.payload.consumer_follow_up_to_action_id, "request_decision");
    assert.equal(sent[0].content.payload.consumer_follow_up_to_message_id, "decision-msg-1");
    assert.equal(sent[0].extensions.custom.consumer_follow_up_fallback, true);
    assert.match(sent[0].content.text, /close_or_handoff/);
    assert.match(sent[0].content.text, /Request Decision/);
    assert.equal(result.posted, true);
    assert.equal(result?.result?.action_id || sent[0].action_id, "close_or_handoff");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment does not fabricate a business-stage artifact when request_decision fallback would need manager close", async () => {
  const originalFetch = global.fetch;
  const sent = [];

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
                      workflow_mode: "action-module-live",
                      group_objective: "Publish the cycle task plan before material collection",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "cycle.start": {
                            owner: "manager",
                            goal: "Define the cycle task plan, acceptance focus, and dispatch targets for the current cycle.",
                            output: ["cycle_task_plan"],
                            notes: [
                              "Manager must publish the cycle task plan in visible text plus structured artifact support.",
                              "Manager should dispatch only the roles that need to act in material.collect.",
                            ],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-cycle-start",
                      stages: {
                        "cycle.start": {
                          stage_id: "cycle.start",
                          next_stage: "material.collect",
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_cycle_start_closed"],
                            },
                          ],
                        },
                      },
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                    },
                    product_contract: {
                      language: "zh-CN",
                      sections: ["politics_economy", "technology"],
                      target_items_per_section: 10,
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
                slug: "cycle-start-live",
                metadata_json: {},
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
              workflow_id: "newsflow-action-composed-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "cycle.start",
              protocol_version: "ACP-003",
              gate_snapshot: {
                current_stage: "cycle.start",
                next_stage: "material.collect",
                next_required_formal_signal: {
                  gate_id: "manager_done",
                  producer_role: "manager",
                  lifecycle_phase: "result",
                  step_id: "cycle.start",
                  step_status: "manager_cycle_start_closed",
                  required_agent_ids: ["manager-1"],
                },
              },
              next_required_formal_signal: {
                gate_id: "manager_done",
                producer_role: "manager",
                lifecycle_phase: "result",
                step_id: "cycle.start",
                step_status: "manager_cycle_start_closed",
                required_agent_ids: ["manager-1"],
              },
              state_json: {
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
                    should_send: false,
                    flow_type: "run",
                    message_type: "analysis",
                    text: "",
                    payload: {},
                    reason: "model_silent_on_required_decision_handoff",
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
          return JSON.stringify({
            success: true,
            data: {
              id: "reply-cycle-start-close-1",
              group_id: "group-1",
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(
      {
        ...state,
        agentId: "manager-1",
        agentName: "Manager One",
        profile: { display_name: "Manager One", handle: "manager-1" },
      },
      {
        obligation: { obligation: "required", reason: "targeted_to_self" },
        recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
        message: {
          id: "decision-msg-cycle-start-1",
          group_id: "group-1",
          flow_type: "run",
          message_type: "analysis",
          action_id: "request_decision",
          text: "Please decide whether the cycle task plan is ready for material.collect.",
          payload: {
            action_id: "request_decision",
            options: ["publish_cycle_task_plan", "hold_stage_open"],
          },
          target_agent_id: "manager-1",
          mentions: [
            {
              mention_type: "agent",
              mention_id: "manager-1",
              display_text: "@manager-1",
            },
          ],
        },
      },
    );

    assert.equal(sent.length, 0);
    assert.equal(result.no_action, true);
    assert.equal(result.decision.action, "observe_only");
    assert.equal(result.decision.reason, "model_silent_on_required_decision_handoff");
    assert.equal(result.agent_execution.reason, "model_silent_on_required_decision_handoff");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment does not emit deterministic manager close on an authoritative artifact-required stage", async () => {
  const originalFetch = global.fetch;
  const sent = [];

  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/groups/group-1/protocol")) {
      throw new Error("temporary protocol timeout");
    }
    if (String(url).includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                slug: "cycle-start-live",
                metadata_json: {
                  community_protocols: {
                    channel: {
                      members: {
                        manager_agent_id: "manager-1",
                        worker_agent_ids: ["worker-a", "worker-b"],
                        role_assignments: {
                          manager: {
                            agent_id: "manager-1",
                            server_gate_role: "manager",
                            responsibility: "publish the cycle task plan",
                          },
                        },
                      },
                      group_identity: {
                        workflow_mode: "formal_newsflow_debug",
                        group_objective: "Publish the cycle task plan before material collection",
                      },
                      workflow: {
                        formal_workflow: {
                          stages: {
                            "cycle.start": {
                              owner: "manager",
                              goal: "Define the cycle task plan, acceptance focus, and dispatch targets for the current cycle.",
                              output: ["cycle_task_plan"],
                              notes: [
                                "Manager must publish the cycle task plan in visible text plus structured artifact support.",
                                "Manager should dispatch only the roles that need to act in material.collect.",
                              ],
                            },
                          },
                        },
                      },
                      execution_spec: {
                        execution_spec_id: "spec-cycle-start-context-fallback",
                        stages: {
                          "cycle.start": {
                            stage_id: "cycle.start",
                            next_stage: "material.collect",
                            semantic_description: "manager publishes the cycle task plan",
                            allowed_roles: ["manager"],
                            accepted_status_blocks: [
                              {
                                gate_id: "manager_done",
                                lifecycle_phase: "result",
                                step_statuses: ["manager_cycle_start_closed"],
                                allowed_roles: ["manager"],
                              },
                            ],
                          },
                        },
                        role_directory: {
                          manager_agent_ids: ["manager-1"],
                          worker_agent_ids: ["worker-a", "worker-b"],
                        },
                      },
                      product_contract: {
                        language: "zh-CN",
                        sections: ["politics_economy", "technology"],
                        target_items_per_section: 10,
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
    if (String(url).includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              workflow_id: "newsflow-action-composed-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "cycle.start",
              protocol_version: "ACP-003",
              gate_snapshot: {
                current_stage: "cycle.start",
                next_stage: "material.collect",
              },
              next_required_formal_signal: {
                gate_id: "manager_done",
                producer_role: "manager",
                lifecycle_phase: "result",
                step_id: "cycle.start",
                step_status: "manager_cycle_start_closed",
                required_agent_ids: ["manager-1"],
              },
              state_json: {
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
                    should_send: false,
                    flow_type: "result",
                    message_type: "analysis",
                    text: "",
                    payload: {},
                    reason: "model_silent_on_authoritative_cycle_start_close",
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
          return JSON.stringify({
            success: true,
            data: {
              id: "reply-cycle-start-control-turn-1",
              group_id: "group-1",
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(
      {
        ...state,
        agentId: "manager-1",
        agentName: "Manager One",
        profile: { display_name: "Manager One", handle: "manager-1" },
      },
      {
        obligation: { obligation: "required", reason: "server_manager_control_turn" },
        recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
        message: {
          id: "msg-group-session-cycle-start",
          group_id: "group-1",
          flow_type: "status",
          message_type: "group_session",
          text: "",
          payload: {
            group_session: {
              current_stage: "cycle.start",
            },
          },
        },
      },
    );

    assert.equal(sent.length, 0);
    assert.equal(result.no_action, true);
    assert.equal(result.decision.action, "observe_only");
    assert.equal(result.decision.reason, "model_silent_on_authoritative_cycle_start_close");
    assert.equal(result.agent_execution.reason, "model_silent_on_authoritative_cycle_start_close");
  } finally {
    global.fetch = originalFetch;
  }
});

test("buildExecutionPrompt keeps generic action-loop prompts free of workflow-specific choreography", () => {
  const prompt = integration.buildExecutionPrompt(
    {
      group_id: "group-1",
      message_type: "analysis",
      content: { text: "action loop validation is in progress" },
    },
    {
      ...state,
      agentId: "tester-1",
      agentName: "Tester One",
      profile: { display_name: "Tester One", handle: "tester-1" },
    },
    {
      role_card: { current_agent_role: "tester", server_gate_role: "worker" },
      workflow_stage_card: {
        stage_id: "action_loop",
        goal: "Validate reusable action modules in a workflow-agnostic group.",
        output: ["public_body_visible_action_output"],
      },
      execution_stage_card: {
        stage_id: "action_loop",
        accepted_status_rules: [],
      },
      runtime_session_card: {
        current_mode: "bootstrap",
        current_stage: "action_loop",
        workflow_id: "action-module-live-v1",
      },
      pending_formal_signal_card: {},
      assignment_resolution_card: {
        manager_agent_id: "manager-1",
        worker_alias_to_agent_id: {},
        current_agent_worker_alias: null,
        named_role_agent_ids: {
          tester: "tester-1",
          editor: "editor-1",
        },
      },
      bootstrap_control_turn_card: {},
      transition_rules_card: {},
    },
    {
      obligation: { obligation: "optional", reason: "visible_collaboration" },
      recommendation: { mode: "agent_discretion", reason: "optional_collaboration" },
    },
  );

  assert.match(prompt[0].content, /Role identity is exclusive/i);
  assert.match(prompt[0].content, /Group-protocol rule: treat the current group charter and action-module contract as the only reusable workflow truth source/i);
  assert.match(prompt[0].content, /Protocol-driven reply rule: if Current workflow stage card owner\/notes make another role the in-stage organizer/i);
  assert.match(prompt[0].content, /Stage-owner rule: if Current workflow stage card owner matches your role/i);
  assert.match(prompt[0].content, /If the current stage card is generic or action-module based/i);
  assert.match(prompt[0].content, /evidence_refs\/artifact_refs/i);
  assert.doesNotMatch(prompt[0].content, /material\.collect truth source/i);
  assert.doesNotMatch(prompt[0].content, /target_items_per_section/i);
});

test("executeRuntimeJudgment does not emit deterministic cycle.start close when the session mode remains bootstrap", async () => {
  const sent = [];
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
                      role_assignments: {
                        manager: {
                          agent_id: "manager-1",
                          server_gate_role: "manager",
                          responsibility: "publish cycle task plans",
                        },
                        worker_a: {
                          agent_id: "worker-a",
                          server_gate_role: "worker",
                          responsibility: "collect materials",
                        },
                        worker_b: {
                          agent_id: "worker-b",
                          server_gate_role: "worker",
                          responsibility: "collect materials",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "bootstrap",
                      group_objective: "Produce a Chinese news product",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "cycle.start": {
                            owner: "manager",
                            goal: "Define the cycle task plan, acceptance focus, and dispatch targets for the current cycle.",
                            output: ["cycle_task_plan"],
                            notes: [
                              "Manager must publish the cycle task plan in visible text plus structured artifact support.",
                            ],
                          },
                        },
                        product_contract: {
                          language: "zh-CN",
                          sections: ["politics_economy", "technology"],
                          target_items_per_section: 10,
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-cycle-start-bootstrap-mode",
                      stages: {
                        "cycle.start": {
                          stage_id: "cycle.start",
                          next_stage: "material.collect",
                          semantic_description: "Manager publishes the cycle task plan, dispatches work, and closes the stage.",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_cycle_start_closed"],
                            },
                          ],
                        },
                      },
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
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
                slug: "cycle-start-bootstrap-mode-live",
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
              workflow_id: "newsflow-action-composed-v1",
              current_mode: "bootstrap",
              current_stage: "cycle.start",
              protocol_version: "ACP-003",
              gate_snapshot: {
                current_stage: "cycle.start",
                next_stage: "material.collect",
              },
              next_required_formal_signal: {
                gate_id: "manager_done",
                producer_role: "manager",
                lifecycle_phase: "result",
                step_id: "cycle.start",
                step_status: "manager_cycle_start_closed",
                required_agent_ids: ["manager-1"],
              },
              state_json: {
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
                    should_send: false,
                    flow_type: "result",
                    message_type: "analysis",
                    text: "",
                    payload: {},
                    reason: "model_silent_on_bootstrap_cycle_start_close",
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
          return JSON.stringify({
            success: true,
            data: {
              id: "reply-cycle-start-bootstrap-mode-1",
              group_id: "group-1",
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(
      {
        ...state,
        agentId: "manager-1",
        agentName: "Manager One",
        profile: { display_name: "Manager One", handle: "manager-1" },
      },
      {
        obligation: { obligation: "required", reason: "server_manager_control_turn" },
        recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
        message: {
          id: "msg-group-session-cycle-start-bootstrap-mode",
          group_id: "group-1",
          flow_type: "status",
          message_type: "group_session",
          text: "",
          payload: {
            group_session: {
              current_stage: "cycle.start",
            },
          },
        },
      },
    );

    assert.equal(sent.length, 0);
    assert.equal(result.no_action, true);
    assert.equal(result.decision.action, "observe_only");
    assert.equal(result.decision.reason, "model_silent_on_bootstrap_cycle_start_close");
    assert.equal(result.agent_execution.reason, "model_silent_on_bootstrap_cycle_start_close");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment does not auto-submit a business-stage owner artifact when the model stays silent", async () => {
  const sent = [];
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
                      worker_agent_ids: ["worker-a", "worker-b", "tester-1"],
                      role_assignments: {
                        tester: {
                          agent_id: "tester-1",
                          server_gate_role: "worker",
                          responsibility: "review collected materials inside material.collect",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "formal_newsflow_debug",
                      group_objective: "Collect and review materials before drafting",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "material.collect": {
                            owner: "tester",
                            organizer_role: "tester",
                            goal: "Tester organizes collection and reviews incoming candidate materials.",
                            output: ["material_review_feedback"],
                            allowed_action_modules: ["review_artifact", "close_or_handoff"],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-material-collect-owner",
                      stages: {
                        "material.collect": {
                          stage_id: "material.collect",
                          next_stage: "draft.compose",
                          semantic_description: "tester reviews submitted candidate materials",
                          allowed_roles: ["tester"],
                          accepted_status_blocks: [],
                        },
                      },
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b", "tester-1"],
                      },
                    },
                    product_contract: {
                      language: "zh-CN",
                      sections: ["politics_economy", "technology"],
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
                slug: "material-collect-live",
                metadata_json: {},
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
              workflow_id: "newsflow-action-composed-v1",
              current_mode: "formal_newsflow_debug",
              current_stage: "material.collect",
              protocol_version: "ACP-003",
              gate_snapshot: {
                current_stage: "material.collect",
                next_stage: "draft.compose",
              },
              state_json: {
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
                    should_send: false,
                    flow_type: "run",
                    message_type: "analysis",
                    text: "",
                    payload: {},
                    reason: "model_silent_on_material_collect_review",
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
          return JSON.stringify({
            success: true,
            data: {
              id: "reply-material-collect-owner-1",
              group_id: "group-1",
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(
      {
        ...state,
        agentId: "tester-1",
        agentName: "Tester One",
        profile: { display_name: "Tester One", handle: "tester-1" },
      },
      {
        obligation: { obligation: "required", reason: "server_manager_control_turn" },
        recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
        message: {
          id: "msg-group-session-material-collect",
          group_id: "group-1",
          flow_type: "status",
          message_type: "group_session",
          text: "",
          payload: {
            group_session: {
              current_stage: "material.collect",
            },
          },
        },
      },
    );

    assert.equal(sent.length, 0);
    assert.equal(result.no_action, true);
    assert.equal(result.decision.action, "observe_only");
    assert.equal(result.decision.reason, "model_silent_on_material_collect_review");
    assert.equal(result.agent_execution.reason, "model_silent_on_material_collect_review");
  } finally {
    global.fetch = originalFetch;
  }
});

test("protocolTurnOwnershipDecision suppresses non-owned optional visible collaboration", () => {
  const decision = integration.protocolTurnOwnershipDecision(
    {
      ...state,
      agentId: "editor-1",
    },
    {
      group_id: "group-1",
      author_agent_id: "manager-1",
      flow_type: "run",
      message_type: "analysis",
      target_agent_id: "worker-a",
      mentions: [],
    },
    {
      role_card: {
        current_agent_role: "editor",
        server_gate_role: "worker",
      },
      workflow_stage_card: {
        stage_id: "action_loop",
        owner: null,
      },
      pending_formal_signal_card: {},
    },
    {
      obligation: { obligation: "optional", reason: "visible_collaboration" },
      recommendation: { mode: "agent_discretion", reason: "optional_collaboration" },
    },
  );

  assert.equal(decision.owned, false);
  assert.equal(decision.reason, "protocol_turn_not_owned");
  assert.deepEqual(decision.current_roles, ["editor", "worker"]);
});

test("protocolTurnOwnershipDecision allows optional visible collaboration for stage owner roles", () => {
  const decision = integration.protocolTurnOwnershipDecision(
    {
      ...state,
      agentId: "tester-1",
    },
    {
      group_id: "group-1",
      author_agent_id: "worker-a",
      flow_type: "run",
      message_type: "analysis",
      mentions: [],
    },
    {
      role_card: {
        current_agent_role: "tester",
        server_gate_role: "worker",
      },
      workflow_stage_card: {
        stage_id: "material.collect",
        owner: "tester_led_collect_and_review_under_manager_open_close",
      },
      pending_formal_signal_card: {},
    },
    {
      obligation: { obligation: "optional", reason: "visible_collaboration" },
      recommendation: { mode: "agent_discretion", reason: "optional_collaboration" },
    },
  );

  assert.equal(decision.owned, true);
  assert.equal(decision.reason, "stage_owner");
});

test("protocolTurnOwnershipDecision does not treat collective non_manager owner tokens as owned without direct activation", () => {
  const decision = integration.protocolTurnOwnershipDecision(
    {
      ...state,
      agentId: "editor-1",
    },
    {
      group_id: "group-1",
      author_agent_id: "manager-1",
      flow_type: "start",
      message_type: "analysis",
      mentions: [],
    },
    {
      role_card: {
        current_agent_role: "editor",
        server_gate_role: "worker",
      },
      workflow_stage_card: {
        stage_id: "step1",
        owner: "non_manager_alignment_under_manager_closure",
      },
      pending_formal_signal_card: {},
    },
    {
      obligation: { obligation: "optional", reason: "visible_collaboration" },
      recommendation: { mode: "agent_discretion", reason: "optional_collaboration" },
    },
  );

  assert.equal(decision.owned, false);
  assert.equal(decision.reason, "protocol_turn_not_owned");
});

test("protocolTurnOwnershipDecision allows optional visible collaboration for pending formal producers", () => {
  const decision = integration.protocolTurnOwnershipDecision(
    {
      ...state,
      agentId: "tester-1",
    },
    {
      group_id: "group-1",
      author_agent_id: "manager-1",
      flow_type: "run",
      message_type: "analysis",
      mentions: [],
    },
    {
      role_card: {
        current_agent_role: "tester",
        server_gate_role: "worker",
      },
      workflow_stage_card: {
        stage_id: "step1",
        owner: "non_manager_agents_under_manager_alignment",
      },
      pending_formal_signal_card: {
        producer_role: "worker",
        required_agent_ids: ["tester-1"],
      },
    },
    {
      obligation: { obligation: "optional", reason: "visible_collaboration" },
      recommendation: { mode: "agent_discretion", reason: "optional_collaboration" },
    },
  );

  assert.equal(decision.owned, true);
  assert.equal(decision.reason, "pending_formal_signal");
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

test("buildCommunityMessage normalizes invalid flow_type aliases to protocol-supported values", () => {
  const message = integration.buildCommunityMessage(state, {
    group_id: "group-1",
    thread_id: "thread-1",
    parent_message_id: "parent-1",
    target_agent_id: null,
    target_agent: null,
  }, {
    flow_type: "done",
    message_type: "analysis",
    content: {
      text: "manager closes a stage",
      payload: {
        action_id: "close_or_handoff",
      },
    },
  });

  assert.equal(message.flow_type, "result");
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

test("sendCommunityMessage requires real visible text and rejects payload-only submissions", async () => {
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      async text() {
        return JSON.stringify({ success: true, data: { id: "msg-visible-1", group_id: "group-1" } });
      },
    };
  };

  try {
    await assert.rejects(
      integration.sendCommunityMessage(state, null, {
        group_id: "group-1",
        flow_type: "run",
        message_type: "analysis",
        content: {
          payload: {
            kind: "candidate_material_pool",
          },
        },
      }),
    );

    const result = await integration.sendCommunityMessage(state, null, {
      group_id: "group-1",
      flow_type: "run",
      message_type: "analysis",
      content: {
        text: "worker visible material submission",
        payload: {
          kind: "candidate_material_pool",
        },
      },
    });

    assert.equal(result.id, "msg-visible-1");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.content.text, "worker visible material submission");
    assert.equal(sent[0].body.content.payload.kind, "candidate_material_pool");
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

test("receiveCommunityEvent falls back to the next configured model after a primary timeout", async () => {
  const sent = [];
  const modelRequests = [];
  const originalFetch = global.fetch;
  const originalEnv = {
    COMMUNITY_MODEL_PRIMARY_BASE_URL: process.env.COMMUNITY_MODEL_PRIMARY_BASE_URL,
    COMMUNITY_MODEL_PRIMARY_API_KEY: process.env.COMMUNITY_MODEL_PRIMARY_API_KEY,
    COMMUNITY_MODEL_PRIMARY_MODEL_ID: process.env.COMMUNITY_MODEL_PRIMARY_MODEL_ID,
    MODEL_BASE_URL: process.env.MODEL_BASE_URL,
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    MODEL_ID: process.env.MODEL_ID,
    COMMUNITY_MODEL_FALLBACK_1_BASE_URL: process.env.COMMUNITY_MODEL_FALLBACK_1_BASE_URL,
    COMMUNITY_MODEL_FALLBACK_1_API_KEY: process.env.COMMUNITY_MODEL_FALLBACK_1_API_KEY,
    COMMUNITY_MODEL_FALLBACK_1_MODEL_ID: process.env.COMMUNITY_MODEL_FALLBACK_1_MODEL_ID,
    COMMUNITY_MODEL_TIMEOUT_MS: process.env.COMMUNITY_MODEL_TIMEOUT_MS,
  };
  process.env.COMMUNITY_MODEL_PRIMARY_BASE_URL = "https://primary.example/v1";
  process.env.COMMUNITY_MODEL_PRIMARY_API_KEY = "primary-key";
  process.env.COMMUNITY_MODEL_PRIMARY_MODEL_ID = "primary-model";
  process.env.MODEL_BASE_URL = "";
  process.env.MODEL_API_KEY = "";
  process.env.MODEL_ID = "";
  process.env.COMMUNITY_MODEL_FALLBACK_1_BASE_URL = "https://fallback.example/v1";
  process.env.COMMUNITY_MODEL_FALLBACK_1_API_KEY = "fallback-key";
  process.env.COMMUNITY_MODEL_FALLBACK_1_MODEL_ID = "fallback-model";
  process.env.COMMUNITY_MODEL_TIMEOUT_MS = "240000";
  integration.resetModelCandidateFailureCache();

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
      modelRequests.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).startsWith("https://primary.example/v1/")) {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "AbortError";
        throw error;
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
                    text: "generated reply from fallback",
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
          return JSON.stringify({ success: true, data: { id: "reply-primary-fallback-1", group_id: "group-1" } });
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
            id: "msg-in-primary-fallback-1",
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
          id: "msg-in-primary-fallback-1",
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
    assert.match(modelRequests[0].url, /^https:\/\/primary\.example\/v1\/chat\/completions$/);
    assert.match(modelRequests[1].url, /^https:\/\/fallback\.example\/v1\/chat\/completions$/);
    assert.equal(modelRequests[0].body.model, "primary-model");
    assert.equal(modelRequests[1].body.model, "fallback-model");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.text, "generated reply from fallback");
  } finally {
    integration.resetModelCandidateFailureCache();
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("receiveCommunityEvent suppresses recently failed unsupported primary models on subsequent requests", async () => {
  const sent = [];
  const modelRequests = [];
  const originalFetch = global.fetch;
  const originalEnv = {
    COMMUNITY_MODEL_PRIMARY_BASE_URL: process.env.COMMUNITY_MODEL_PRIMARY_BASE_URL,
    COMMUNITY_MODEL_PRIMARY_API_KEY: process.env.COMMUNITY_MODEL_PRIMARY_API_KEY,
    COMMUNITY_MODEL_PRIMARY_MODEL_ID: process.env.COMMUNITY_MODEL_PRIMARY_MODEL_ID,
    MODEL_BASE_URL: process.env.MODEL_BASE_URL,
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    MODEL_ID: process.env.MODEL_ID,
    COMMUNITY_MODEL_FALLBACK_1_BASE_URL: process.env.COMMUNITY_MODEL_FALLBACK_1_BASE_URL,
    COMMUNITY_MODEL_FALLBACK_1_API_KEY: process.env.COMMUNITY_MODEL_FALLBACK_1_API_KEY,
    COMMUNITY_MODEL_FALLBACK_1_MODEL_ID: process.env.COMMUNITY_MODEL_FALLBACK_1_MODEL_ID,
    COMMUNITY_MODEL_TIMEOUT_MS: process.env.COMMUNITY_MODEL_TIMEOUT_MS,
  };
  process.env.COMMUNITY_MODEL_PRIMARY_BASE_URL = "https://primary.example/v1";
  process.env.COMMUNITY_MODEL_PRIMARY_API_KEY = "primary-key";
  process.env.COMMUNITY_MODEL_PRIMARY_MODEL_ID = "primary-unsupported-model";
  process.env.MODEL_BASE_URL = "";
  process.env.MODEL_API_KEY = "";
  process.env.MODEL_ID = "";
  process.env.COMMUNITY_MODEL_FALLBACK_1_BASE_URL = "https://fallback.example/v1";
  process.env.COMMUNITY_MODEL_FALLBACK_1_API_KEY = "fallback-key";
  process.env.COMMUNITY_MODEL_FALLBACK_1_MODEL_ID = "fallback-healthy-model";
  process.env.COMMUNITY_MODEL_TIMEOUT_MS = "240000";
  integration.resetModelCandidateFailureCache();

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
                        stages: {
                          "draft.revise": {
                            owner: "editor",
                            goal: "Revise current product draft",
                            output: ["revised_product_draft"],
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
      modelRequests.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).startsWith("https://primary.example/v1/")) {
        return {
          ok: false,
          async json() {
            return {
              error: {
                code: "UnsupportedModel",
                message: "The primary-unsupported-model model does not support the coding plan feature.",
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
                    text: "generated reply from healthy fallback",
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
          return JSON.stringify({ success: true, data: { id: `reply-${sent.length}`, group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const makeEvent = (messageId) => ({
    event: {
      event_type: "message.posted",
      payload: {
        message: {
          id: messageId,
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
        id: messageId,
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

  try {
    const first = await integration.receiveCommunityEvent(state, makeEvent("msg-in-unsupported-1"));
    const afterFirst = modelRequests.length;
    const second = await integration.receiveCommunityEvent(state, makeEvent("msg-in-unsupported-2"));

    assert.equal(first.decision.action, "full_reply");
    assert.equal(second.decision.action, "full_reply");
    assert.equal(afterFirst, 2);
    assert.equal(modelRequests.length, 3);
    assert.match(modelRequests[0].url, /^https:\/\/primary\.example\/v1\/chat\/completions$/);
    assert.match(modelRequests[1].url, /^https:\/\/fallback\.example\/v1\/chat\/completions$/);
    assert.match(modelRequests[2].url, /^https:\/\/fallback\.example\/v1\/chat\/completions$/);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].content.text, "generated reply from healthy fallback");
    assert.equal(sent[1].content.text, "generated reply from healthy fallback");
  } finally {
    integration.resetModelCandidateFailureCache();
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("receiveCommunityEvent prioritizes the most recently successful model candidate on subsequent requests", async () => {
  const originalEnv = {
    COMMUNITY_MODEL_PRIMARY_BASE_URL: process.env.COMMUNITY_MODEL_PRIMARY_BASE_URL,
    COMMUNITY_MODEL_PRIMARY_API_KEY: process.env.COMMUNITY_MODEL_PRIMARY_API_KEY,
    COMMUNITY_MODEL_PRIMARY_MODEL_ID: process.env.COMMUNITY_MODEL_PRIMARY_MODEL_ID,
    MODEL_BASE_URL: process.env.MODEL_BASE_URL,
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    MODEL_ID: process.env.MODEL_ID,
    COMMUNITY_MODEL_FALLBACK_1_BASE_URL: process.env.COMMUNITY_MODEL_FALLBACK_1_BASE_URL,
    COMMUNITY_MODEL_FALLBACK_1_API_KEY: process.env.COMMUNITY_MODEL_FALLBACK_1_API_KEY,
    COMMUNITY_MODEL_FALLBACK_1_MODEL_ID: process.env.COMMUNITY_MODEL_FALLBACK_1_MODEL_ID,
    COMMUNITY_MODEL_FALLBACK_2_BASE_URL: process.env.COMMUNITY_MODEL_FALLBACK_2_BASE_URL,
    COMMUNITY_MODEL_FALLBACK_2_API_KEY: process.env.COMMUNITY_MODEL_FALLBACK_2_API_KEY,
    COMMUNITY_MODEL_FALLBACK_2_MODEL_ID: process.env.COMMUNITY_MODEL_FALLBACK_2_MODEL_ID,
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
  };

  process.env.COMMUNITY_MODEL_PRIMARY_BASE_URL = "https://primary.example/v1";
  process.env.COMMUNITY_MODEL_PRIMARY_API_KEY = "primary-key";
  process.env.COMMUNITY_MODEL_PRIMARY_MODEL_ID = "primary-model";
  process.env.MODEL_BASE_URL = "https://secondary.example/v1";
  process.env.MODEL_API_KEY = "secondary-key";
  process.env.MODEL_ID = "secondary-model";
  process.env.COMMUNITY_MODEL_FALLBACK_1_BASE_URL = "https://healthy.example/v1";
  process.env.COMMUNITY_MODEL_FALLBACK_1_API_KEY = "healthy-key";
  process.env.COMMUNITY_MODEL_FALLBACK_1_MODEL_ID = "healthy-model";
  delete process.env.COMMUNITY_MODEL_FALLBACK_2_BASE_URL;
  delete process.env.COMMUNITY_MODEL_FALLBACK_2_API_KEY;
  delete process.env.COMMUNITY_MODEL_FALLBACK_2_MODEL_ID;
  delete process.env.OPENCLAW_HOME;

  integration.resetModelCandidateFailureCache();
  const originalFetch = global.fetch;
  const modelRequests = [];
  const sent = [];

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
                      workflow_mode: "formal_newsflow_debug",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "draft.revise": {
                            owner: "editor",
                            goal: "Revise current product draft",
                            output: ["revised_product_draft"],
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
              },
              state_json: {
                cycle_id: "cycle-1",
                observed_statuses: [{ id: 1 }],
              },
            },
          });
        },
      };
    }
    if (String(url).includes("/chat/completions")) {
      modelRequests.push({ url: String(url), body: JSON.parse(options.body) });
      if (String(url).startsWith("https://primary.example/v1/")) {
        return {
          ok: false,
          async json() {
            return { error: { message: "Primary transient upstream failure" } };
          },
        };
      }
      if (String(url).startsWith("https://secondary.example/v1/")) {
        return {
          ok: false,
          async json() {
            return { error: { message: "Secondary transient upstream failure" } };
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
                    text: "generated reply from prioritized healthy candidate",
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
          return JSON.stringify({ success: true, data: { id: `reply-${sent.length}`, group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const makeEvent = (messageId) => ({
    event: {
      event_type: "message.posted",
      payload: {
        message: {
          id: messageId,
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
        id: messageId,
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

  try {
    const first = await integration.receiveCommunityEvent(state, makeEvent("msg-priority-1"));
    const afterFirst = modelRequests.length;
    const second = await integration.receiveCommunityEvent(state, makeEvent("msg-priority-2"));

    assert.equal(first.decision.action, "full_reply");
    assert.equal(second.decision.action, "full_reply");
    assert.equal(afterFirst, 3);
    assert.equal(modelRequests.length, 4);
    assert.match(modelRequests[0].url, /^https:\/\/primary\.example\/v1\/chat\/completions$/);
    assert.match(modelRequests[1].url, /^https:\/\/secondary\.example\/v1\/chat\/completions$/);
    assert.match(modelRequests[2].url, /^https:\/\/healthy\.example\/v1\/chat\/completions$/);
    assert.match(modelRequests[3].url, /^https:\/\/healthy\.example\/v1\/chat\/completions$/);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].content.text, "generated reply from prioritized healthy candidate");
    assert.equal(sent[1].content.text, "generated reply from prioritized healthy candidate");
  } finally {
    integration.resetModelCandidateFailureCache();
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("loadModelConfig appends truth-source API candidates after explicit env entries and removes duplicates", () => {
  const originalEnv = {
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    COMMUNITY_MODEL_PRIMARY_BASE_URL: process.env.COMMUNITY_MODEL_PRIMARY_BASE_URL,
    COMMUNITY_MODEL_PRIMARY_API_KEY: process.env.COMMUNITY_MODEL_PRIMARY_API_KEY,
    COMMUNITY_MODEL_PRIMARY_MODEL_ID: process.env.COMMUNITY_MODEL_PRIMARY_MODEL_ID,
    MODEL_BASE_URL: process.env.MODEL_BASE_URL,
    MODEL_API_KEY: process.env.MODEL_API_KEY,
    MODEL_ID: process.env.MODEL_ID,
    COMMUNITY_MODEL_FALLBACK_1_BASE_URL: process.env.COMMUNITY_MODEL_FALLBACK_1_BASE_URL,
    COMMUNITY_MODEL_FALLBACK_1_API_KEY: process.env.COMMUNITY_MODEL_FALLBACK_1_API_KEY,
    COMMUNITY_MODEL_FALLBACK_1_MODEL_ID: process.env.COMMUNITY_MODEL_FALLBACK_1_MODEL_ID,
    COMMUNITY_MODEL_FALLBACK_2_BASE_URL: process.env.COMMUNITY_MODEL_FALLBACK_2_BASE_URL,
    COMMUNITY_MODEL_FALLBACK_2_API_KEY: process.env.COMMUNITY_MODEL_FALLBACK_2_API_KEY,
    COMMUNITY_MODEL_FALLBACK_2_MODEL_ID: process.env.COMMUNITY_MODEL_FALLBACK_2_MODEL_ID,
  };

  const openclawHome = tempRoot;
  const openclawPath = path.join(openclawHome, "openclaw.json");
  const modelsPath = path.join(openclawHome, "agents", "main", "agent", "models.json");
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  fs.writeFileSync(
    openclawPath,
    JSON.stringify(
      {
        agents: {
          defaults: {
            model: {
              primary: "siliconflow/Qwen/Qwen3-8B",
            },
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    modelsPath,
    JSON.stringify(
      {
        providers: {
          siliconflow: {
            baseUrl: "https://silicon.example/v1",
            apiKey: "silicon-key",
            api: "openai-completions",
            models: [
              {
                id: "Qwen/Qwen3-8B",
              },
            ],
          },
          qwencode: {
            baseUrl: "https://ark.example/v1",
            apiKey: "ark-key",
            api: "openai-completions",
            models: [
              {
                id: "qwen3.5-plus",
              },
            ],
          },
          deepseek: {
            baseUrl: "https://deepseek.example/v1",
            apiKey: "deepseek-key",
            api: "openai-completions",
            models: [
              {
                id: "deepseek-chat",
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );

  process.env.OPENCLAW_HOME = openclawHome;
  process.env.COMMUNITY_MODEL_PRIMARY_BASE_URL = "https://primary.example/v1";
  process.env.COMMUNITY_MODEL_PRIMARY_API_KEY = "primary-key";
  process.env.COMMUNITY_MODEL_PRIMARY_MODEL_ID = "primary-model";
  process.env.MODEL_BASE_URL = "https://silicon.example/v1";
  process.env.MODEL_API_KEY = "silicon-key";
  process.env.MODEL_ID = "Qwen/Qwen3-8B";
  delete process.env.COMMUNITY_MODEL_FALLBACK_1_BASE_URL;
  delete process.env.COMMUNITY_MODEL_FALLBACK_1_API_KEY;
  delete process.env.COMMUNITY_MODEL_FALLBACK_1_MODEL_ID;
  delete process.env.COMMUNITY_MODEL_FALLBACK_2_BASE_URL;
  delete process.env.COMMUNITY_MODEL_FALLBACK_2_API_KEY;
  delete process.env.COMMUNITY_MODEL_FALLBACK_2_MODEL_ID;

  try {
    const candidates = integration.loadModelConfig();
    assert.deepEqual(
      candidates.map((candidate) => ({
        baseUrl: candidate.baseUrl,
        apiKey: candidate.apiKey,
        modelId: candidate.modelId,
        provider: candidate.provider || "",
      })),
      [
        {
          baseUrl: "https://primary.example/v1",
          apiKey: "primary-key",
          modelId: "primary-model",
          provider: "",
        },
        {
          baseUrl: "https://silicon.example/v1",
          apiKey: "silicon-key",
          modelId: "Qwen/Qwen3-8B",
          provider: "",
        },
        {
          baseUrl: "https://ark.example/v1",
          apiKey: "ark-key",
          modelId: "qwen3.5-plus",
          provider: "qwencode",
        },
        {
          baseUrl: "https://deepseek.example/v1",
          apiKey: "deepseek-key",
          modelId: "deepseek-chat",
          provider: "deepseek",
        },
      ],
    );
    assert.equal(candidates.filter((candidate) => candidate.modelId === "Qwen/Qwen3-8B").length, 1);
    assert.match(candidates[2].source || "", /models\.json/);
    assert.match(candidates[3].source || "", /models\.json/);
  } finally {
    fs.rmSync(openclawPath, { force: true });
    fs.rmSync(path.join(openclawHome, "agents"), { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("receiveCommunityEvent sends manager bootstrap control-turn to the session group instead of the home group", async () => {
  const sent = [];
  const managerState = {
    ...state,
    groupId: "home-group",
    agentId: "manager-1",
    agentName: "Manager One",
    profile: { display_name: "Manager One", handle: "manager-1" },
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
                      role_assignments: {
                        manager: {
                          agent_id: "manager-1",
                          server_gate_role: "manager",
                          responsibility: "bootstrap kickoff and formal control",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "bootstrap",
                      group_objective: "Establish the startup surface",
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step0: {
                            owner: "manager",
                            goal: "Establish the startup surface",
                            notes: ["publish the startup brief"],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
                      },
                      stages: {
                        step0: {
                          stage_id: "step0",
                          next_stage: "step1",
                          semantic_description: "Manager bootstrap kickoff",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "done",
                              step_statuses: ["step0_done"],
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
                slug: "project-room",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-1",
                      cycle_number: 1,
                      task_goal: "start the group cleanly",
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
              current_mode: "bootstrap",
              current_stage: "step0",
              protocol_version: "ACP-003",
              group_session_version: "group-session:bootstrap-1",
              gate_snapshot: {
                current_stage: "step0",
                next_stage: "step1",
                next_stage_allowed: false,
                current_stage_complete: false,
                gates: {
                  manager_done: {
                    required_agent_ids: ["manager-1"],
                  },
                },
              },
              next_required_formal_signal: {
                gate_id: "manager_done",
                step_id: "step0",
                step_status: "step0_done",
                producer_role: "manager",
                lifecycle_phase: "done",
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
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
                    flow_type: "start",
                    message_type: "analysis",
                    text: "bootstrap kickoff for the session group",
                    payload: {},
                    status_block: {
                      lifecycle_phase: "done",
                      step_id: "step0",
                      step_status: "step0_done",
                    },
                    reason: "server_manager_control_turn",
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
          return JSON.stringify({ success: true, data: { id: "bootstrap-step0-done-1", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.receiveCommunityEvent(managerState, {
      event: {
        event_type: "group_session.updated",
        payload: {
          group_session: {
            group_id: "group-1",
            current_mode: "bootstrap",
            current_stage: "step0",
            gate_snapshot: {
              gates: {
                manager_done: {
                  required_agent_ids: ["manager-1"],
                },
              },
              next_required_formal_signal: {
                gate_id: "manager_done",
                step_id: "step0",
                step_status: "step0_done",
                producer_role: "manager",
                lifecycle_phase: "done",
              },
            },
          },
          group_context: {
            group_id: "group-1",
          },
        },
      },
      entity: {
        group_session: {
          group_id: "group-1",
          current_mode: "bootstrap",
          current_stage: "step0",
        },
      },
      group_id: "group-1",
    });

    assert.equal(result.decision.action, "full_reply");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].group_id, "group-1");
    assert.match(sent[0].content.text, /启动本轮群组协作|bootstrap kickoff/i);
    assert.equal(sent[0].status_block.step_status, "step0_done");
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

test("sendCommunityMessage suppresses manager formal close while a non-manager bootstrap gate is still pending", async () => {
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
                      worker_agent_ids: ["editor-1", "tester-1", "worker-a", "worker-b"],
                      role_assignments: {
                        editor: { agent_id: "editor-1", server_gate_role: "worker" },
                        tester: { agent_id: "tester-1", server_gate_role: "worker" },
                        worker_a: { agent_id: "worker-a", server_gate_role: "worker" },
                        worker_b: { agent_id: "worker-b", server_gate_role: "worker" },
                      },
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step1: {
                            owner: "non_manager_alignment_under_manager_closure",
                            goal: "Collect alignment confirmations before bootstrap handoff.",
                            notes: [],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["editor-1", "tester-1", "worker-a", "worker-b"],
                      },
                      stages: {
                        step1: {
                          stage_id: "step1",
                          next_stage: "step2",
                          allowed_roles: ["manager", "editor", "tester", "worker_a", "worker_b"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_start",
                              lifecycle_phase: "start",
                              allowed_roles: ["manager"],
                              step_statuses: ["step1_start"],
                            },
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["step1_submitted"],
                            },
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "done",
                              allowed_roles: ["manager"],
                              step_statuses: ["step1_done"],
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
              current_mode: "bootstrap",
              current_stage: "step1",
              protocol_version: "ACP-003",
              group_session_version: "group-session:step1",
              next_required_formal_signal: {
                gate_id: "worker_run",
                producer_role: "worker",
                lifecycle_phase: "run",
                step_id: "step1",
                step_status: "step1_submitted",
                required_agent_ids: ["editor-1", "tester-1", "worker-a", "worker-b"],
              },
              gate_snapshot: {
                current_stage: "step1",
                next_stage: "step2",
                next_required_formal_signal: {
                  gate_id: "worker_run",
                  producer_role: "worker",
                  lifecycle_phase: "run",
                  step_id: "step1",
                  step_status: "step1_submitted",
                  required_agent_ids: ["editor-1", "tester-1", "worker-a", "worker-b"],
                },
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
          return JSON.stringify({ success: true, data: { id: "reply-step1-manager", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-step1-checkpoint",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager tries to close step1 before all required non-manager confirmations are in",
          payload: {},
        },
        status_block: {
          lifecycle_phase: "done",
          step_status: "step1_done",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].status_block, {});
    assert.equal(sent[0].extensions?.custom?.formal_signal_suppressed_reason, "pending_non_manager_gate");
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

test("sendCommunityMessage preserves manager formal close when explicit evidence refs are present for a business-stage close", async () => {
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
    assert.equal(sent[0].status_block.step_id, undefined);
    assert.equal(sent[0].status_block.step_status, undefined);
    assert.equal(sent[0].extensions.custom.formal_signal_suppressed_reason, "missing_stage_artifact_evidence");
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage canonicalizes manager business-stage close aliases to the pending formal signal when the stage artifact is present", async () => {
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
                next_required_formal_signal: {
                  gate_id: "manager_done",
                  step_id: "material.collect",
                  step_status: "manager_material_collect_closed",
                  producer_role: "manager",
                  lifecycle_phase: "result",
                  required_agent_ids: ["manager-1"],
                },
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
          return JSON.stringify({ success: true, data: { id: "reply-formal-alias-normalized", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-material-alias",
        group_id: "group-1",
        thread_id: "thread-1",
        content: {
          text: "tester confirms evidence coverage",
          payload: {
            evidence_refs: ["msg-review-1"],
            artifact_refs: ["msg-worker-raw-materials"],
          },
        },
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager closes material.collect with alias tokens",
          payload: {
            kind: "candidate_material_pool",
            evidence_refs: ["msg-review-1"],
            sections: [
              {
                section: "sports",
                items: ["candidate-1"],
              },
            ],
          },
        },
        status_block: {
          lifecycle_phase: "material.collect_closed",
          step_status: "material.collect_done",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.workflow_id, "newsflow-workflow-debug-v1");
    assert.equal(sent[0].status_block.step_id, "material.collect");
    assert.equal(sent[0].status_block.lifecycle_phase, "result");
    assert.equal(sent[0].status_block.author_role, "manager");
    assert.equal(sent[0].status_block.author_agent_id, "manager-1");
    assert.equal(sent[0].status_block.step_status, "manager_material_collect_closed");
    assert.match(sent[0].content.text, /sports:/);
    assert.match(sent[0].content.text, /candidate-1/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage suppresses duplicate manager stage-start when the same start already owns the live session", async () => {
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
                      execution_spec_id: "spec-dup-start",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
                      },
                      stages: {
                        "material.collect": {
                          stage_id: "material.collect",
                          next_stage: "material.review",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_start",
                              lifecycle_phase: "start",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_material_collect_started"],
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
              current_mode: "bootstrap",
              current_stage: "material.collect",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "material.collect",
                next_stage: "material.review",
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
                observed_statuses: [],
                last_status_block: {
                  step_id: "material.collect",
                  lifecycle_phase: "start",
                  author_role: "manager",
                  author_agent_id: "manager-1",
                  step_status: "manager_material_collect_started",
                  related_message_id: "msg-start-1",
                },
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
          return JSON.stringify({ success: true, data: { id: "reply-duplicate-start", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-duplicate-start",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "start",
        message_type: "summary",
        content: {
          text: "tester is ready for first submissions",
          payload: {
            coordination_note: "tester_ready_for_first_batch",
          },
        },
        status_block: {
          lifecycle_phase: "start",
          step_status: "manager_material_collect_started",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.ok(!sent[0].status_block || !sent[0].status_block.step_status);
    assert.equal(sent[0].extensions.custom.formal_signal_suppressed_reason, "duplicate_manager_stage_start");
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

test("sendCommunityMessage suppresses manager product.report close when the payload only carries a previous-stage artifact kind", async () => {
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
                          "product.report": {
                            owner: "manager",
                            goal: "Publish the product evaluation report",
                            output: ["product_evaluation_report"],
                          },
                        },
                      },
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                    },
                    execution_spec: {
                      execution_spec_id: "spec-product-report",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a"],
                      },
                      stages: {
                        "product.report": {
                          stage_id: "product.report",
                          next_stage: "retrospective.plan",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_product_report_closed"],
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
              current_stage: "product.report",
              protocol_version: "ACP-003",
              group_session_version: "group-session:product-report",
              gate_snapshot: {
                current_stage: "product.report",
                next_stage: "retrospective.plan",
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
          return JSON.stringify({ success: true, data: { id: "reply-product-report-suppressed", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-product-report",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "manager says the product report is already covered elsewhere",
          payload: {
            kind: "cross_cycle_report",
            report: "cycle-001 remains the earliest anchor for comparison",
            comparisons: ["cycle-001"],
          },
        },
        status_block: {
          lifecycle_phase: "result",
          step_status: "manager_product_report_closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_status, undefined);
    assert.equal(sent[0].extensions.custom.formal_signal_suppressed_reason, "missing_stage_artifact_evidence");
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage preserves manager cycle.start close when the expected artifact is nested under its protocol key", async () => {
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
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "cycle.start": {
                            owner: "manager",
                            goal: "Publish cycle task plan and close cycle.start",
                            input: ["formal_start"],
                            output: ["cycle_task_plan"],
                          },
                        },
                      },
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                    },
                    execution_spec: {
                      execution_spec_id: "spec-cycle-start",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
                      },
                      stages: {
                        "cycle.start": {
                          stage_id: "cycle.start",
                          next_stage: "material.collect",
                          allowed_roles: ["manager"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_start",
                              lifecycle_phase: "start",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_cycle_start_started"],
                            },
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "result",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_cycle_start_closed"],
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
              current_stage: "cycle.start",
              protocol_version: "ACP-003",
              group_session_version: "group-session:cycle-start",
              gate_snapshot: {
                current_stage: "cycle.start",
                next_stage: "material.collect",
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
          return JSON.stringify({ success: true, data: { id: "reply-cycle-start-close", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-cycle-start-close",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "analysis",
        content: {
          text: "manager closes cycle.start with a nested cycle task plan artifact",
          payload: {
            cycle_task_plan: {
              cycle_id: "cycle-1",
              cycle_number: 1,
              cycle_goal: "publish the first cycle plan",
              stage_decomposition: ["material.collect", "material.review", "draft.compose"],
              worker_assignments: {
                politics_economy: "worker-a",
                sports: "worker-b",
              },
            },
          },
        },
        status_block: {
          lifecycle_phase: "result",
          step_status: "manager_cycle_start_closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, "cycle.start");
    assert.equal(sent[0].status_block.step_status, "manager_cycle_start_closed");
    assert.equal(sent[0].status_block.author_role, "manager");
    assert.equal(sent[0].extensions?.custom?.formal_signal_suppressed_reason, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage canonicalizes no-output pending manager signal to the exact step token", async () => {
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
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step1: {
                            owner: "non_manager_agents_under_manager_alignment",
                            goal: "Align task understanding",
                            input: ["bootstrap_task_brief"],
                            notes: ["This stage exists to establish shared understanding, not to produce business artifacts."],
                          },
                        },
                      },
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
                      },
                      stages: {
                        step1: {
                          stage_id: "step1",
                          next_stage: "step2",
                          allowed_roles: ["manager", "worker_a", "worker_b"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_start",
                              lifecycle_phase: "start",
                              allowed_roles: ["manager"],
                              step_statuses: ["step1_start"],
                            },
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["step1_submitted"],
                            },
                            {
                              gate_id: "manager_done",
                              lifecycle_phase: "done",
                              allowed_roles: ["manager"],
                              step_statuses: ["step1_done"],
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
              current_mode: "bootstrap",
              current_stage: "step1",
              protocol_version: "ACP-003",
              group_session_version: "group-session:step1",
              next_required_formal_signal: {
                gate_id: "manager_done",
                producer_role: "manager",
                lifecycle_phase: "done",
                step_id: "step1",
                step_status: "step1_done",
                required_agent_ids: ["manager-1"],
              },
              gate_snapshot: {
                current_stage: "step1",
                next_stage: "step2",
                next_required_formal_signal: {
                  gate_id: "manager_done",
                  producer_role: "manager",
                  lifecycle_phase: "done",
                  step_id: "step1",
                  step_status: "step1_done",
                  required_agent_ids: ["manager-1"],
                },
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
          return JSON.stringify({ success: true, data: { id: "reply-step1-done", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-step1-worker",
        group_id: "group-1",
        thread_id: "thread-1",
        content: {
          text: "worker confirmations collected",
          payload: { kind: "agent_execution_reply", summary: "ready" },
        },
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "group alignment confirmed",
          payload: {},
        },
        status_block: {
          lifecycle_phase: "result",
          step_status: "step1_result_aligned",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, "step1");
    assert.equal(sent[0].status_block.lifecycle_phase, "done");
    assert.equal(sent[0].status_block.step_status, "step1_done");
    assert.equal(sent[0].status_block.author_role, "manager");
    assert.equal(sent[0].extensions?.custom?.formal_signal_suppressed_reason, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage resolves generic worker assignments to concrete ids on manager material.collect start", async () => {
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
                      execution_spec_id: "spec-material-collect",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
                      },
                      stages: {
                        "material.collect": {
                          stage_id: "material.collect",
                          next_stage: "material.review",
                          allowed_roles: ["manager", "worker_a", "worker_b"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_start",
                              lifecycle_phase: "start",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_material_collect_started"],
                            },
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
              group_session_version: "group-session:material-collect",
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
          return JSON.stringify({ success: true, data: { id: "reply-material-collect-start", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      managerState,
      {
        id: "msg-parent-material-collect-start",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "start",
        message_type: "analysis",
        content: {
          text: "manager starts material.collect with generic worker aliases",
          payload: {
            cycle_id: "cycle-1",
            worker_assignments: {
              worker_a: ["politics_economy", "technology"],
              worker_b: ["sports", "entertainment"],
            },
          },
        },
        status_block: {
          lifecycle_phase: "start",
          step_status: "manager_material_collect_started",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.text, "manager starts material.collect with generic worker aliases");
    assert.equal(sent[0].content.payload.worker_assignment_aliases.worker_a, "worker-a");
    assert.equal(sent[0].content.payload.worker_assignment_aliases.worker_b, "worker-b");
    assert.deepEqual(sent[0].content.payload.resolved_worker_assignments["worker-a"], ["politics_economy", "technology"]);
    assert.deepEqual(sent[0].content.payload.resolved_worker_assignments["worker-b"], ["sports", "entertainment"]);
    assert.deepEqual(
      sent[0].routing.mentions.map((item) => item.mention_id).sort(),
      ["worker-a", "worker-b"],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("sendCommunityMessage preserves worker bootstrap submission via server gate role", async () => {
  const sent = [];
  const editorState = {
    ...state,
    agentId: "editor-1",
    agentName: "Editor One",
    profile: { display_name: "Editor One", handle: "editor-1" },
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
                      worker_agent_ids: ["editor-1", "worker-a"],
                      role_assignments: {
                        editor: {
                          agent_id: "editor-1",
                          server_gate_role: "worker",
                        },
                      },
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step1: {
                            owner: "non_manager_agents_under_manager_alignment",
                            goal: "Align task understanding",
                            input: ["bootstrap_task_brief"],
                            notes: [],
                          },
                        },
                      },
                    },
                    transition_rules: {
                      manager_is_single_formal_transition_authority: true,
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["editor-1", "worker-a"],
                      },
                      stages: {
                        step1: {
                          stage_id: "step1",
                          next_stage: "step2",
                          allowed_roles: ["manager", "editor", "worker_a"],
                          accepted_status_blocks: [
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["step1_submitted"],
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
              current_mode: "bootstrap",
              current_stage: "step1",
              protocol_version: "ACP-003",
              group_session_version: "group-session:step1",
              next_required_formal_signal: {
                gate_id: "worker_run",
                producer_role: "worker",
                lifecycle_phase: "run",
                step_id: "step1",
                step_status: "step1_submitted",
                required_agent_ids: ["editor-1", "worker-a"],
              },
              gate_snapshot: {
                current_stage: "step1",
                next_stage: "step2",
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
          return JSON.stringify({ success: true, data: { id: "reply-step1-worker", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      editorState,
      {
        id: "msg-parent-step1-editor",
        group_id: "group-1",
        thread_id: "thread-1",
        content: { text: "manager kickoff", payload: {} },
      },
      {
        group_id: "group-1",
        flow_type: "run",
        message_type: "analysis",
        content: {
          text: "I understand the step1 alignment requirements and submit my confirmation.",
          payload: {},
        },
        status_block: {
          lifecycle_phase: "run",
          step_status: "step1_submitted",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, "step1");
    assert.equal(sent[0].status_block.lifecycle_phase, "run");
    assert.equal(sent[0].status_block.step_status, "step1_submitted");
    assert.equal(sent[0].status_block.author_role, "worker");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment falls back to pending worker signal when model execution fails on a no-output bootstrap stage", async () => {
  const sent = [];
  const testerState = {
    ...state,
    agentId: "tester-1",
    agentName: "Tester One",
    profile: { display_name: "Tester One", handle: "tester-1" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/chat/completions")) {
      throw new Error("The operation was aborted due to timeout");
    }
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
                      worker_agent_ids: ["tester-1", "worker-a"],
                      role_assignments: {
                        tester: {
                          agent_id: "tester-1",
                          server_gate_role: "worker",
                          responsibility: "confirm alignment and review worker outputs",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "bootstrap",
                      group_objective: "Align the newsflow debug team",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step1: {
                            owner: "non_manager_agents_under_manager_alignment",
                            goal: "Confirm task understanding before step2",
                            input: ["bootstrap_task_brief"],
                            output: ["alignment_confirmations"],
                            notes: [],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["tester-1", "worker-a"],
                      },
                      stages: {
                        step1: {
                          stage_id: "step1",
                          next_stage: "step2",
                          allowed_roles: ["manager", "tester", "worker_a"],
                          accepted_status_blocks: [
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["step1_submitted"],
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
                      task_goal: "Align the team before execution",
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
              current_mode: "bootstrap",
              current_stage: "step1",
              protocol_version: "ACP-003",
              group_session_version: "group-session:step1",
              next_required_formal_signal: {
                gate_id: "worker_run",
                producer_role: "worker",
                lifecycle_phase: "run",
                step_id: "step1",
                step_status: "step1_submitted",
                required_agent_ids: ["tester-1", "worker-a"],
              },
              gate_snapshot: {
                current_stage: "step1",
                next_stage: "step2",
                next_required_formal_signal: {
                  gate_id: "worker_run",
                  producer_role: "worker",
                  lifecycle_phase: "run",
                  step_id: "step1",
                  step_status: "step1_submitted",
                  required_agent_ids: ["tester-1", "worker-a"],
                },
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
          return JSON.stringify({ success: true, data: { id: "reply-step1-submitted", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(testerState, {
      message: {
        id: "msg-step0",
        group_id: "group-1",
        author_agent_id: "manager-1",
        flow_type: "run",
        message_type: "analysis",
        text: "step0 kickoff",
        payload: {},
        thread_id: "msg-step0",
        parent_message_id: null,
        mentions: [],
        extensions: {},
      },
      context_group_id: "group-1",
      obligation: {
        obligation: "optional",
        reason: "visible_collaboration",
      },
      recommendation: {
        mode: "agent_discretion",
        reason: "optional_collaboration",
      },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].group_id, "group-1");
    assert.equal(sent[0].status_block.step_id, "step1");
    assert.equal(sent[0].status_block.lifecycle_phase, "run");
    assert.equal(sent[0].status_block.step_status, "step1_submitted");
    assert.equal(sent[0].status_block.author_role, "worker");
    assert.equal(sent[0].status_block.author_agent_id, "tester-1");
    assert.match(sent[0].content.text, /已理解当前阶段目标与分工/);
    assert.equal(result.posted, true);
    assert.equal(result.agent_execution.reason, "deterministic_pending_formal_signal_bootstrap");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment uses deterministic pending worker signal before model execution on a no-output bootstrap stage", async () => {
  const sent = [];
  const testerState = {
    ...state,
    agentId: "tester-1",
    agentName: "Tester One",
    profile: { display_name: "Tester One", handle: "tester-1" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/chat/completions")) {
      throw new Error("model should not be called for deterministic bootstrap pending signals");
    }
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
                      worker_agent_ids: ["tester-1", "worker-a"],
                      role_assignments: {
                        tester: {
                          agent_id: "tester-1",
                          server_gate_role: "worker",
                          responsibility: "confirm alignment and review worker outputs",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "bootstrap",
                      group_objective: "Align the newsflow debug team",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step1: {
                            owner: "non_manager_agents_under_manager_alignment",
                            goal: "Confirm task understanding before step2",
                            input: ["bootstrap_task_brief"],
                            output: ["alignment_confirmations"],
                            notes: [],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["tester-1", "worker-a"],
                      },
                      stages: {
                        step1: {
                          stage_id: "step1",
                          next_stage: "step2",
                          allowed_roles: ["manager", "tester", "worker_a"],
                          accepted_status_blocks: [
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["step1_submitted"],
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
                      task_goal: "Align the team before execution",
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
              current_mode: "bootstrap",
              current_stage: "step1",
              protocol_version: "ACP-003",
              group_session_version: "group-session:step1",
              next_required_formal_signal: {
                gate_id: "worker_run",
                producer_role: "worker",
                lifecycle_phase: "run",
                step_id: "step1",
                step_status: "step1_submitted",
                required_agent_ids: ["tester-1", "worker-a"],
              },
              gate_snapshot: {
                current_stage: "step1",
                next_stage: "step2",
                next_required_formal_signal: {
                  gate_id: "worker_run",
                  producer_role: "worker",
                  lifecycle_phase: "run",
                  step_id: "step1",
                  step_status: "step1_submitted",
                  required_agent_ids: ["tester-1", "worker-a"],
                },
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
          return JSON.stringify({ success: true, data: { id: "reply-step1-submitted-now", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(testerState, {
      message: {
        id: "msg-step1-manager-start",
        group_id: "group-1",
        author_agent_id: "manager-1",
        flow_type: "start",
        message_type: "analysis",
        text: "现在进入 step1（理解对齐阶段）。",
        payload: {
          action_id: "close_or_handoff",
          intent: "bootstrap_control_turn",
          step_status: "step1_start",
        },
        thread_id: "msg-step1-manager-start",
        parent_message_id: null,
        mentions: [],
        extensions: {},
      },
      context_group_id: "group-1",
      obligation: {
        obligation: "optional",
        reason: "visible_collaboration",
      },
      recommendation: {
        mode: "agent_discretion",
        reason: "optional_collaboration",
      },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, "step1");
    assert.equal(sent[0].status_block.step_status, "step1_submitted");
    assert.equal(result.posted, true);
    assert.equal(result.agent_execution.reason, "deterministic_pending_formal_signal_bootstrap");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment suppresses duplicate no-output bootstrap pending signals already observed for the current agent", async () => {
  const sent = [];
  const testerState = {
    ...state,
    agentId: "tester-1",
    agentName: "Tester One",
    profile: { display_name: "Tester One", handle: "tester-1" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    if (String(url).includes("/chat/completions")) {
      throw new Error("model should not be called once the pending signal is already observed");
    }
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
                      worker_agent_ids: ["tester-1", "worker-a"],
                      role_assignments: {
                        tester: {
                          agent_id: "tester-1",
                          server_gate_role: "worker",
                          responsibility: "confirm alignment and review worker outputs",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "bootstrap",
                      group_objective: "Align the newsflow debug team",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step1: {
                            owner: "non_manager_agents_under_manager_alignment",
                            goal: "Confirm task understanding before step2",
                            input: ["bootstrap_task_brief"],
                            output: ["alignment_confirmations"],
                            notes: [],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["tester-1", "worker-a"],
                      },
                      stages: {
                        step1: {
                          stage_id: "step1",
                          next_stage: "step2",
                          allowed_roles: ["manager", "tester", "worker_a"],
                          accepted_status_blocks: [
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["step1_submitted"],
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
                      task_goal: "Align the team before execution",
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
              current_mode: "bootstrap",
              current_stage: "step1",
              protocol_version: "ACP-003",
              group_session_version: "group-session:step1",
              next_required_formal_signal: {
                gate_id: "worker_run",
                producer_role: "worker",
                lifecycle_phase: "run",
                step_id: "step1",
                step_status: "step1_submitted",
                required_agent_ids: ["tester-1", "worker-a"],
              },
              gate_snapshot: {
                current_stage: "step1",
                next_stage: "step2",
                next_required_formal_signal: {
                  gate_id: "worker_run",
                  producer_role: "worker",
                  lifecycle_phase: "run",
                  step_id: "step1",
                  step_status: "step1_submitted",
                  required_agent_ids: ["tester-1", "worker-a"],
                },
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
                observed_statuses: [
                  {
                    step_id: "step1",
                    lifecycle_phase: "run",
                    step_status: "step1_submitted",
                    author_agent_id: "tester-1",
                    author_role: "worker",
                  },
                ],
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
          return JSON.stringify({ success: true, data: { id: "duplicate-should-not-send", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(testerState, {
      message: {
        id: "msg-step1-manager-start",
        group_id: "group-1",
        author_agent_id: "manager-1",
        flow_type: "start",
        message_type: "analysis",
        text: "现在进入 step1（理解对齐阶段）。",
        payload: {
          action_id: "close_or_handoff",
          intent: "bootstrap_control_turn",
          step_status: "step1_start",
        },
        thread_id: "msg-step1-manager-start",
        parent_message_id: null,
        mentions: [],
        extensions: {},
      },
      context_group_id: "group-1",
      obligation: {
        obligation: "required",
        reason: "server_required_formal_signal",
      },
      recommendation: {
        mode: "agent_discretion",
        reason: "optional_collaboration",
      },
    });

    assert.equal(sent.length, 0);
    assert.equal(result.posted, undefined);
    assert.equal(result.decision.action, "observe_only");
    assert.equal(result.decision.reason, "pending_formal_signal_already_observed");
  } finally {
    global.fetch = originalFetch;
  }
});

test("executeRuntimeJudgment overrides mirrored no-output bootstrap replies with the exact pending worker signal", async () => {
  const sent = [];
  const workerState = {
    ...state,
    agentId: "worker-a",
    agentName: "Worker A",
    profile: { display_name: "Worker A", handle: "worker-a" },
  };
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
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
                    flow_type: "run",
                    message_type: "analysis",
                    text: "现在进入 step1（理解对齐阶段）。请所有非管理角色各自发送一条明确的理解对齐消息，并携带正式信号 step1_submitted。",
                    payload: {
                      action_id: "close_or_handoff",
                      intent: "bootstrap_control_turn",
                      step_status: "step1_start",
                    },
                  }),
                },
              },
            ],
          };
        },
      };
    }
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
                      role_assignments: {
                        worker_a: {
                          agent_id: "worker-a",
                          server_gate_role: "worker",
                          responsibility: "confirm bootstrap alignment and collect assigned materials",
                        },
                        worker_b: {
                          agent_id: "worker-b",
                          server_gate_role: "worker",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "bootstrap",
                      group_objective: "Align the team before content production",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step1: {
                            owner: "non_manager_agents_under_manager_alignment",
                            goal: "Confirm task understanding before step2",
                            input: ["bootstrap_task_brief"],
                            output: ["alignment_confirmations"],
                            notes: [],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b"],
                      },
                      stages: {
                        step1: {
                          stage_id: "step1",
                          next_stage: "step2",
                          allowed_roles: ["manager", "worker_a", "worker_b"],
                          accepted_status_blocks: [
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["step1_submitted"],
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
                      task_goal: "Align the team before execution",
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
              current_mode: "bootstrap",
              current_stage: "step1",
              protocol_version: "ACP-003",
              group_session_version: "group-session:step1",
              next_required_formal_signal: {
                gate_id: "worker_run",
                producer_role: "worker",
                lifecycle_phase: "run",
                step_id: "step1",
                step_status: "step1_submitted",
                required_agent_ids: ["worker-a", "worker-b"],
              },
              gate_snapshot: {
                current_stage: "step1",
                next_stage: "step2",
                next_required_formal_signal: {
                  gate_id: "worker_run",
                  producer_role: "worker",
                  lifecycle_phase: "run",
                  step_id: "step1",
                  step_status: "step1_submitted",
                  required_agent_ids: ["worker-a", "worker-b"],
                },
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
          return JSON.stringify({ success: true, data: { id: "reply-step1-worker-exact", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.executeRuntimeJudgment(workerState, {
      message: {
        id: "msg-step1-manager-start",
        group_id: "group-1",
        author_agent_id: "manager-1",
        flow_type: "start",
        message_type: "analysis",
        text: "现在进入 step1（理解对齐阶段）。",
        payload: {
          action_id: "close_or_handoff",
          intent: "bootstrap_control_turn",
          step_status: "step1_start",
        },
        thread_id: "msg-step1-manager-start",
        parent_message_id: null,
        mentions: [],
        extensions: {},
      },
      context_group_id: "group-1",
      obligation: {
        obligation: "optional",
        reason: "visible_collaboration",
      },
      recommendation: {
        mode: "agent_discretion",
        reason: "optional_collaboration",
      },
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, "step1");
    assert.equal(sent[0].status_block.lifecycle_phase, "run");
    assert.equal(sent[0].status_block.step_status, "step1_submitted");
    assert.equal(sent[0].status_block.author_role, "worker");
    assert.notEqual(sent[0].content.payload.action_id, "close_or_handoff");
    assert.match(sent[0].content.text, /已理解当前阶段目标与分工/);
    assert.equal(result.posted, true);
    assert.equal(result.agent_execution.reason, "deterministic_pending_formal_signal_bootstrap");
  } finally {
    global.fetch = originalFetch;
  }
});

test("worker material.collect submission keeps real visible text intact", async () => {
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
                          allowed_roles: ["worker"],
                          accepted_status_blocks: [
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["worker_material_collect_submitted"],
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
                      task_goal: "collect real materials",
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
              current_stage: "material.collect",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "material.collect",
                next_stage: "material.review",
                next_stage_allowed: false,
                current_stage_complete: false,
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
          return JSON.stringify({ success: true, data: { id: "worker-material-1", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      workerState,
      {
        id: "msg-parent-worker-material",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "run",
        message_type: "analysis",
        content: {
          text: "Worker visible collection note: found a concrete material source.",
          payload: {
            kind: "candidate_material_pool",
            sections: [
              {
                section: "politics_economy",
                items: [
                  {
                    title: "real visible item",
                    source: "https://example.com/news-collect",
                    published_at: "2026-04-17T06:00:00Z",
                  },
                ],
              },
            ],
            final_summary: "worker submitted a visible collection note",
          },
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].author.agent_id, "worker-a");
    assert.equal(sent[0].content.text, "Worker visible collection note: found a concrete material source.");
    assert.equal(sent[0].content.payload.kind, "candidate_material_pool");
    assert.equal(sent[0].content.payload.sections[0].items[0].title, "real visible item");
  } finally {
    global.fetch = originalFetch;
  }
});

test("tester first consumption of material.collect submission is required judgment", async () => {
  const sent = [];
  const modelRequests = [];
  const testerState = {
    ...state,
    agentId: "tester-1",
    agentName: "Tester One",
    profile: { display_name: "Tester One", handle: "tester-1" },
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
                      worker_agent_ids: ["worker-a", "tester-1"],
                      role_assignments: {
                        worker_a: {
                          agent_id: "worker-a",
                          server_gate_role: "worker",
                        },
                        tester: {
                          agent_id: "tester-1",
                          server_gate_role: "worker",
                          responsibility: "first consume worker materials",
                        },
                      },
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
                        worker_agent_ids: ["worker-a", "tester-1"],
                      },
                      stages: {
                        "material.collect": {
                          stage_id: "material.collect",
                          next_stage: "material.review",
                          allowed_roles: ["tester", "manager", "worker"],
                          accepted_status_blocks: [
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["worker_material_collect_submitted"],
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
                      task_goal: "collect real materials",
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
              current_stage: "material.collect",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "material.collect",
                next_stage: "material.review",
                next_stage_allowed: false,
                current_stage_complete: false,
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
                    text: "tester first consumption",
                    payload: { kind: "agent_execution_reply", summary: "ok" },
                    reason: "required_material_collect_consumption",
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
          return JSON.stringify({ success: true, data: { id: "tester-reply-1", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const result = await integration.receiveCommunityEvent(testerState, {
      event: {
        event_type: "message.posted",
        payload: {
          message: {
            id: "msg-worker-material-1",
            group_id: "group-1",
            author: { agent_id: "worker-a" },
            flow_type: "run",
            message_type: "analysis",
            content: {
              text: "Worker visible collection note: found a concrete material source.",
              payload: {
                kind: "candidate_material_pool",
                sections: [
                  {
                    section: "politics_economy",
                    items: [
                      {
                        title: "real visible item",
                        source: "https://example.com/news-collect",
                        published_at: "2026-04-17T06:00:00Z",
                      },
                    ],
                  },
                ],
                final_summary: "worker submitted a visible collection note",
              },
            },
            relations: { thread_id: "thread-1", parent_message_id: null },
            routing: { target: { agent_id: "tester-1" }, mentions: [] },
            extensions: {},
          },
        },
      },
      entity: {
        message: {
          id: "msg-worker-material-1",
          group_id: "group-1",
          author: { agent_id: "worker-a" },
          flow_type: "run",
          message_type: "analysis",
          content: {
            text: "Worker visible collection note: found a concrete material source.",
            payload: {
              kind: "candidate_material_pool",
              sections: [
                {
                  section: "politics_economy",
                  items: [
                    {
                      title: "real visible item",
                      source: "https://example.com/news-collect",
                      published_at: "2026-04-17T06:00:00Z",
                    },
                  ],
                },
              ],
              final_summary: "worker submitted a visible collection note",
            },
          },
          relations: { thread_id: "thread-1", parent_message_id: null },
          routing: { target: { agent_id: "tester-1" }, mentions: [] },
          extensions: {},
        },
      },
      group_id: "group-1",
    });

    assert.equal(result.category, "run");
    assert.equal(result.obligation.obligation, "required");
    assert.equal(result.decision.action, "full_reply");
    assert.equal(modelRequests.length, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content.text, "tester first consumption");
    assert.equal(sent[0].routing.target.agent_id, "worker-a");
    assert.equal(sent[0].relations.parent_message_id, "msg-worker-material-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("worker cannot impersonate manager close for material.collect", async () => {
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
            data: {
              group: {
                slug: "public-lobby",
                metadata_json: {
                  community_v2: {
                    group_context: {
                      cycle_id: "cycle-1",
                      cycle_number: 1,
                      task_goal: "collect real materials",
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
              current_stage: "material.collect",
              protocol_version: "ACP-003",
              group_session_version: "group-session:1",
              gate_snapshot: {
                current_stage: "material.collect",
                next_stage: "material.review",
                next_stage_allowed: false,
                current_stage_complete: false,
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
          return JSON.stringify({ success: true, data: { id: "worker-impersonation-1", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      workerState,
      {
        id: "msg-parent-worker-impersonation",
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
            kind: "manager_stage_close",
            final_summary: "this should not be counted as manager close from a worker",
          },
        },
        status_block: {
          lifecycle_phase: "result",
          step_id: "material.collect",
          author_role: "manager",
          author_agent_id: "worker-a",
          step_status: "manager_material_collect_closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.ok(!sent[0].status_block || !sent[0].status_block.step_status);
  } finally {
    global.fetch = originalFetch;
  }
});

test("editor cannot impersonate manager close for material.collect even with a real candidate material payload", async () => {
  const sent = [];
  const editorState = {
    ...state,
    agentId: "editor-1",
    agentName: "Editor One",
    profile: { display_name: "Editor One", handle: "editor-1" },
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
                      worker_agent_ids: ["worker-a", "worker-b", "tester-1"],
                      role_assignments: {
                        editor: {
                          agent_id: "editor-1",
                          server_gate_role: "worker",
                        },
                        tester: {
                          agent_id: "tester-1",
                          server_gate_role: "worker",
                        },
                        worker_a: {
                          agent_id: "worker-a",
                          server_gate_role: "worker",
                        },
                        worker_b: {
                          agent_id: "worker-b",
                          server_gate_role: "worker",
                        },
                      },
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "material.collect": {
                            owner: "tester_led_collect_and_review_under_manager_open_close",
                            goal: "Collect real materials with in-stage tester review",
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
                      execution_spec_id: "spec-editor-impersonation",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b", "tester-1"],
                      },
                      stages: {
                        "material.collect": {
                          stage_id: "material.collect",
                          next_stage: "draft.compose",
                          allowed_roles: ["manager", "tester", "worker_a", "worker_b"],
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
              group_session_version: "group-session:editor-impersonation",
              gate_snapshot: {
                current_stage: "material.collect",
                next_stage: "draft.compose",
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
          return JSON.stringify({ success: true, data: { id: "editor-impersonation-1", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      editorState,
      {
        id: "msg-parent-editor-impersonation",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "summary",
        content: {
          text: "editor narrates partial progress but must not close the stage",
          payload: {
            kind: "candidate_material_pool",
            sections: [
              {
                section: "sports",
                items: [
                  {
                    title: "sports candidate",
                    source: "https://example.com/sports-1",
                  },
                ],
              },
            ],
          },
        },
        status_block: {
          lifecycle_phase: "result",
          step_id: "material.collect",
          author_role: "manager",
          author_agent_id: "editor-1",
          step_status: "manager_material_collect_closed",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_status, undefined);
    assert.equal(sent[0].extensions.custom.formal_signal_suppressed_reason, "non_manager_manager_signal");
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

test("sendCommunityMessage still suppresses editor manager-close when group context fetch fails", async () => {
  const sent = [];
  const editorState = {
    ...state,
    agentId: "editor-1",
    agentName: "Editor One",
    profile: { display_name: "Editor One", handle: "editor-1" },
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
                      worker_agent_ids: ["worker-a", "worker-b", "tester-1"],
                      role_assignments: {
                        editor: {
                          agent_id: "editor-1",
                          server_gate_role: "worker",
                        },
                        tester: {
                          agent_id: "tester-1",
                          server_gate_role: "worker",
                        },
                        worker_a: {
                          agent_id: "worker-a",
                          server_gate_role: "worker",
                        },
                        worker_b: {
                          agent_id: "worker-b",
                          server_gate_role: "worker",
                        },
                      },
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          "material.collect": {
                            owner: "worker_a_and_worker_b_under_manager_dispatch",
                            goal: "Collect materials for all sections",
                            output: ["candidate_material_pool"],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-1",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["worker-a", "worker-b", "tester-1"],
                      },
                      stages: {
                        "material.collect": {
                          stage_id: "material.collect",
                          next_stage: "material.review",
                          allowed_roles: ["manager", "tester", "worker_a", "worker_b"],
                          accepted_status_blocks: [
                            {
                              gate_id: "manager_start",
                              lifecycle_phase: "start",
                              allowed_roles: ["manager"],
                              step_statuses: ["manager_material_collect_started"],
                            },
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
        ok: false,
        async text() {
          return JSON.stringify({ success: false, message: "500" });
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
          return JSON.stringify({ success: true, data: { id: "reply-editor-context-fail", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      editorState,
      {
        id: "msg-parent-editor-context-fail",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "result",
        message_type: "analysis",
        content: {
          text: "editor narrates progress but should not close the stage",
          payload: {
            observed_partial_materials: ["sports", "entertainment"],
          },
        },
        status_block: {
          workflow_id: "newsflow-workflow-debug-v1",
          step_id: "material.collect",
          lifecycle_phase: "result",
          author_role: "editor",
          author_agent_id: "editor-1",
          step_status: "manager_material_collect_closed",
          related_message_id: "msg-parent-editor-context-fail",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, undefined);
    assert.equal(sent[0].status_block.author_role, undefined);
    assert.ok(!sent[0].status_block.step_status);
    assert.equal(sent[0].extensions.custom.formal_signal_suppressed_reason, "non_manager_manager_signal");
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

test("resolveGroupSessionObligation activates manager from authoritative session signal", async () => {
  const result = await integration.resolveGroupSessionObligation(
    {
      agentId: "manager-1",
    },
    "group-1",
    {
      group_session: {
        group_id: "group-1",
        current_mode: "bootstrap",
        current_stage: "step0",
        gate_snapshot: {
          gates: {
            manager_done: {
              required_agent_ids: ["manager-1"],
            },
          },
          next_required_formal_signal: {
            gate_id: "manager_done",
            producer_role: "manager",
            lifecycle_phase: "done",
            step_id: "step0",
            step_status: "step0_done",
          },
        },
      },
    },
    { group_scope: true },
  );

  assert.equal(result?.obligation, "required");
  assert.equal(result?.reason, "server_manager_control_turn");
  assert.equal(result?.group_id, "group-1");
  assert.equal(result?.agent_id, "manager-1");
});

test("resolveGroupSessionObligation activates non-manager roles from authoritative worker-run signal", async () => {
  const result = await integration.resolveGroupSessionObligation(
    {
      agentId: "tester-1",
    },
    "group-1",
    {
      group_session: {
        group_id: "group-1",
        current_mode: "bootstrap",
        current_stage: "step1",
        gate_snapshot: {
          gates: {
            worker_run: {
              required_agent_ids: ["tester-1", "worker-a"],
            },
          },
          next_required_formal_signal: {
            gate_id: "worker_run",
            producer_role: "worker",
            lifecycle_phase: "run",
            step_id: "step1",
            step_status: "step1_submitted",
          },
        },
      },
    },
    { group_scope: true },
  );

  assert.equal(result?.obligation, "required");
  assert.equal(result?.reason, "server_required_formal_signal");
  assert.equal(result?.group_id, "group-1");
  assert.equal(result?.agent_id, "tester-1");
});

test("resolveGroupSessionObligation does not reactivate an agent after the same pending formal signal is already observed", async () => {
  const result = await integration.resolveGroupSessionObligation(
    {
      agentId: "tester-1",
    },
    "group-1",
    {
      group_session: {
        group_id: "group-1",
        current_mode: "bootstrap",
        current_stage: "step1",
        state_json: {
          observed_statuses: [
            {
              step_id: "step1",
              lifecycle_phase: "run",
              step_status: "step1_submitted",
              author_agent_id: "tester-1",
              author_role: "worker",
            },
          ],
        },
        gate_snapshot: {
          gates: {
            worker_run: {
              required_agent_ids: ["tester-1", "worker-a"],
            },
          },
          next_required_formal_signal: {
            gate_id: "worker_run",
            producer_role: "worker",
            lifecycle_phase: "run",
            step_id: "step1",
            step_status: "step1_submitted",
          },
        },
      },
    },
    { group_scope: true },
  );

  assert.equal(result, null);
});

test("resolveGroupSessionObligation does not activate worker from authoritative manager signal", async () => {
  const result = await integration.resolveGroupSessionObligation(
    {
      agentId: "worker-a",
    },
    "group-1",
    {
      group_session: {
        group_id: "group-1",
        current_mode: "bootstrap",
        current_stage: "step0",
        gate_snapshot: {
          gates: {
            manager_done: {
              required_agent_ids: ["manager-1"],
            },
          },
          next_required_formal_signal: {
            gate_id: "manager_done",
            producer_role: "manager",
            lifecycle_phase: "done",
            step_id: "step0",
            step_status: "step0_done",
          },
        },
      },
    },
    { group_scope: true },
  );

  assert.equal(result, null);
});

test("sendCommunityMessage suppresses duplicate current-agent no-output formal signals already observed in session", async () => {
  const sent = [];
  const testerState = {
    ...state,
    agentId: "tester-1",
    agentName: "Tester One",
    profile: { display_name: "Tester One", handle: "tester-1" },
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
                      worker_agent_ids: ["tester-1", "worker-a"],
                      role_assignments: {
                        tester: {
                          agent_id: "tester-1",
                          server_gate_role: "worker",
                        },
                      },
                    },
                    group_identity: {
                      group_type: "project",
                      workflow_mode: "bootstrap",
                      group_objective: "Align the team before execution",
                    },
                    workflow: {
                      formal_workflow: {
                        stages: {
                          step1: {
                            owner: "non_manager_agents_under_manager_alignment",
                            goal: "Confirm task understanding before step2",
                            input: ["bootstrap_task_brief"],
                            output: ["alignment_confirmations"],
                            notes: [],
                          },
                        },
                      },
                    },
                    execution_spec: {
                      execution_spec_id: "spec-bootstrap",
                      role_directory: {
                        manager_agent_ids: ["manager-1"],
                        worker_agent_ids: ["tester-1", "worker-a"],
                      },
                      stages: {
                        step1: {
                          stage_id: "step1",
                          next_stage: "step2",
                          allowed_roles: ["manager", "tester", "worker_a"],
                          accepted_status_blocks: [
                            {
                              gate_id: "worker_run",
                              lifecycle_phase: "run",
                              allowed_roles: ["worker"],
                              step_statuses: ["step1_submitted"],
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
                      task_goal: "Align the team before execution",
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
              current_mode: "bootstrap",
              current_stage: "step1",
              protocol_version: "ACP-003",
              group_session_version: "group-session:step1",
              gate_snapshot: {
                current_stage: "step1",
                next_stage: "step2",
              },
              state_json: {
                cycle_id: "cycle-1",
                cycle_number: 1,
                observed_statuses: [
                  {
                    step_id: "step1",
                    lifecycle_phase: "run",
                    step_status: "step1_submitted",
                    author_agent_id: "tester-1",
                    author_role: "worker",
                  },
                ],
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
          return JSON.stringify({ success: true, data: { id: "should-not-send-duplicate-formal", group_id: "group-1" } });
        },
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await integration.sendCommunityMessage(
      testerState,
      {
        id: "msg-parent-step1",
        group_id: "group-1",
        thread_id: "thread-1",
      },
      {
        group_id: "group-1",
        flow_type: "run",
        message_type: "analysis",
        content: {
          text: "我已理解当前阶段目标与分工，将按要求继续推进。",
          payload: {
            action_id: "answer_question",
          },
        },
        status_block: {
          workflow_id: "newsflow-workflow-debug-v1",
          step_id: "step1",
          lifecycle_phase: "run",
          author_role: "worker",
          author_agent_id: "tester-1",
          step_status: "step1_submitted",
          related_message_id: "msg-parent-step1",
        },
      },
    );

    assert.equal(sent.length, 1);
    assert.equal(sent[0].status_block.step_id, undefined);
    assert.equal(sent[0].status_block.step_status, undefined);
    assert.equal(sent[0].extensions.custom.formal_signal_suppressed_reason, "duplicate_current_agent_formal_status");
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
