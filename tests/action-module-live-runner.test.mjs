import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "action-module-live-runner-"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function installMockFetch(options = {}) {
  const state = {
    messages: [],
    session: {
      workflow_id: "workflow-1",
      current_mode: "test",
      current_stage: "sample_stage",
      protocol_version: "ACP-003",
      group_session_version: "group-session:1",
      gate_snapshot: {
        current_stage: "sample_stage",
        next_stage: "next_stage",
        next_stage_allowed: true,
        current_stage_complete: false,
        satisfied_gates: [],
        advanced_from: "previous_stage",
        advanced_to: "sample_stage",
      },
      state_json: {
        cycle_id: "cycle-1",
        cycle_number: 1,
        observed_statuses: [],
        latest_forced_proceed_stage_ids: [],
        latest_final_artifact_message_id: null,
        last_status_block: {
          step_id: "sample_stage",
          lifecycle_phase: "start",
          author_role: "manager",
          author_agent_id: "agent-manager",
          step_status: "manager_sample_stage_started",
        },
      },
    },
  };

  const originalFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? new URL(input) : new URL(input.url);
    const method = String(init.method || input?.method || "GET").toUpperCase();
    const respond = (payload, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    if (method === "GET" && url.pathname.endsWith("/protocol")) {
      return respond({
        success: true,
        data: {
          protocol: {
            version: "ACP-003",
            layers: {
              group: {
                members: {
                  manager_agent_id: "agent-manager",
                  worker_agent_ids: ["producer-agent", "consumer-agent"],
                  role_assignments: {
                    producer: {
                      agent_id: "producer-agent",
                      server_gate_role: "worker",
                      responsibility: "emit visible action output",
                    },
                    consumer: {
                      agent_id: "consumer-agent",
                      server_gate_role: "worker",
                      responsibility: "receive handoff evidence",
                    },
                  },
                },
                group_identity: {
                  group_type: "validation",
                  workflow_mode: "action-module-live",
                  group_objective: "exercise action module runner",
                },
                workflow: {
                  formal_workflow: {
                    goal: "validate reusable action module behavior",
                    stages: {
                      sample_stage: {
                        owner: "producer",
                        goal: "emit visible action output",
                        output: ["artifact"],
                        notes: ["keep it generic"],
                      },
                    },
                  },
                },
                execution_spec: {
                  execution_spec_id: "spec-1",
                  role_directory: {
                    manager_agent_ids: ["agent-manager"],
                    worker_agent_ids: ["producer-agent", "consumer-agent"],
                  },
                  stages: {
                    sample_stage: {
                      stage_id: "sample_stage",
                      next_stage: "next_stage",
                      semantic_description: "sample stage",
                      allowed_roles: ["producer", "consumer"],
                      accepted_status_blocks: [],
                    },
                  },
                },
                transition_rules: {
                  manager_is_single_formal_transition_authority: true,
                  worker_inputs_are_evidence_not_transition_gates: true,
                  plain_text_cannot_replace_manager_formal_signal: true,
                },
              },
            },
          },
        },
      });
    }

    if (method === "GET" && url.pathname.endsWith("/context")) {
      return respond({
        success: true,
        data: {
          group: {
            slug: "public-lobby",
            metadata_json: {
              community_v2: {
                group_context: {
                  group_id: "group-1",
                  cycle_id: "cycle-1",
                  cycle_number: 1,
                  task_goal: "exercise action module runner",
                  current_stage: "sample_stage",
                  next_stage: "next_stage",
                  workers_ready: ["producer-agent", "consumer-agent"],
                },
              },
            },
          },
        },
      });
    }

    if (method === "GET" && url.pathname.endsWith("/session")) {
      state.session.state_json.observed_statuses = state.messages.map((message, index) => ({
        id: index + 1,
        message_id: message.id,
        action_id: message.action_id,
      }));
      state.session.state_json.latest_final_artifact_message_id = state.messages.at(-1)?.id || null;
      return respond({ success: true, data: state.session });
    }

    if (method === "GET" && url.pathname.includes("/groups/") && url.pathname.endsWith("/messages")) {
      return respond({ success: false, message: "not found" }, 404);
    }

    if (method === "GET" && url.pathname.endsWith("/messages")) {
      const limit = Number(url.searchParams.get("limit") || 0);
      const offset = Number(url.searchParams.get("offset") || 0);
      if (!limit) {
        return respond({
          success: true,
          data: {
            messages: state.messages.slice(0, 1),
          },
        });
      }
      return respond({
        success: true,
        data: {
          items: state.messages.slice(offset, offset + limit),
          count: Math.max(0, Math.min(limit, state.messages.length - offset)),
          limit,
          offset,
          newest_first: false,
        },
      });
    }

    if (method === "POST" && url.pathname.endsWith("/messages")) {
      const body = init.body ? JSON.parse(init.body) : {};
      const message = {
        id: `msg-${state.messages.length + 1}`,
        group_id: body.group_id || "group-1",
        action_id: body.action_id || body.content?.payload?.action_id || null,
        message_type: body.message_type || null,
        flow_type: body.flow_type || null,
        content: {
          text: body.content?.text || "",
          payload: body.content?.payload || {},
        },
        author: {
          agent_id: body.author?.agent_id || null,
        },
        relations: body.relations || {},
        target_agent_id: body.routing?.target?.agent_id || null,
        extensions: body.extensions || {},
      };
      state.messages.push(message);
      if (typeof options.onPostMessage === "function") {
        options.onPostMessage({ body, message, state });
      }
      if (
        body.action_id === "assign_task" &&
        body.extensions?.custom?.participant_id === "producer-turn" &&
        body.routing?.target?.agent_id === "consumer-agent"
      ) {
        state.messages.push({
          id: `msg-${state.messages.length + 1}`,
          group_id: body.group_id || "group-1",
          action_id: "acknowledge_or_decline",
          message_type: "analysis",
          flow_type: "run",
          content: {
            text: "Auto consumer receipt",
            payload: {
              action_id: "acknowledge_or_decline",
              kind: "consumer_receipt",
            },
          },
          author: {
            agent_id: "consumer-agent",
          },
          relations: {
            parent_message_id: message.id,
          },
          target_agent_id: "producer-agent",
          extensions: {
            custom: {
              participant_id: "consumer-turn",
            },
          },
        });
      }
      state.session.state_json.last_status_block = {
        step_id: body.content?.payload?.scenario_key || body.action_id || "sample_stage",
        lifecycle_phase: "result",
        author_role: body.extensions?.custom?.scenario_key === "invalid_producer_suppressed" ? "observer" : "producer",
        author_agent_id: body.author?.agent_id || "producer-agent",
        step_status: `${body.action_id || "action"}_result`,
        related_message_id: message.id,
      };
      return respond({
        success: true,
        data: {
          id: message.id,
          group_id: message.group_id,
          status: "accepted",
          message,
        },
      });
    }

    return respond({ success: false, message: `unexpected endpoint: ${method} ${url.pathname}` }, 404);
  };

  return {
    state,
    restore() {
      global.fetch = originalFetch;
    },
  };
}

async function prepareModules(baseUrl, workspaceRoot) {
  process.env.WORKSPACE_ROOT = workspaceRoot;
  process.env.COMMUNITY_BASE_URL = baseUrl;
  process.env.COMMUNITY_TEMPLATE_HOME = path.join(workspaceRoot, ".openclaw", "community-agent-template");
  process.env.COMMUNITY_INGRESS_HOME = path.join(workspaceRoot, ".openclaw", "community-ingress");
  process.env.MESSAGE_PROTOCOL_V2 = "1";
  process.env.WEBHOOK_RECEIPT_V2 = "1";
  process.env.MODEL_BASE_URL = "http://model.example/v1";
  process.env.MODEL_API_KEY = "test-key";
  process.env.MODEL_ID = "test-model";

  const scaffold = await import(
    pathToFileURL(path.join(__dirname, "..", "scripts", "action_module_live", "index.mjs")).href +
      `?t=${Date.now()}`
  );
  const runner = await import(
    pathToFileURL(path.join(__dirname, "..", "scripts", "action_module_live", "runner.mjs")).href +
      `?t=${Date.now()}`
  );
  return { scaffold, runner };
}

function writeSavedState(workspaceRoot) {
  writeJson(
    path.join(
      workspaceRoot,
      ".openclaw",
      "community-agent-template",
      "state",
      "community-webhook-state.json",
    ),
    {
      token: "agent-token",
      agentId: "producer-agent",
      agentName: "producer-agent",
      groupId: "group-1",
      profile: {
        display_name: "Producer Agent",
        handle: "producer-agent",
      },
    },
  );
}

function buildParticipantSpec(specPath) {
  writeJson(specPath, {
    validation_id: "runner-smoke",
    label: "runner smoke",
    group_id: "group-1",
    scenarios: [
      {
        scenario_key: "valid_producer_visible_output",
        action_id: "assign_task",
        participants: [
          {
            participant_id: "producer-valid",
            role: "producer",
            agent_id: "producer-agent",
            action_id: "assign_task",
            state: {
              should_send: true,
              message_type: "analysis",
              flow_type: "run",
              text: "Producer body visible",
              content: {
                payload: {
                  kind: "candidate_material_pool",
                  items: [{ title: "item-1" }],
                },
              },
              routing: {
                target: {
                  agent_id: "consumer-agent",
                },
              },
            },
          },
        ],
      },
      {
        scenario_key: "expected_consumer_handoff",
        action_id: "assign_task",
        participants: [
          {
            participant_id: "producer-turn",
            role: "producer",
            agent_id: "producer-agent",
            action_id: "assign_task",
            state: {
              should_send: true,
              message_type: "analysis",
              text: "Please take this task and report back.",
              content: {
                payload: {
                  task_summary: "verify participant state routing",
                },
              },
              routing: {
                target: {
                  agent_id: "consumer-agent",
                },
              },
            },
          },
          {
            participant_id: "consumer-turn",
            role: "consumer",
            agent_id: "consumer-agent",
            action_id: "acknowledge_or_decline",
            should_send: false,
          },
        ],
      },
      {
        scenario_key: "invalid_producer_suppressed",
        action_id: "assign_task",
        participants: [
          {
            participant_id: "intruder",
            role: "producer",
            agent_id: "intruder-agent",
            action_id: "assign_task",
            state: {
              should_send: false,
              suppression_reason: "invalid producer",
              text: "Should not send",
              content: {
                payload: {
                  kind: "blocked_attempt",
                },
              },
            },
          },
        ],
      },
      {
        scenario_key: "runtime_state_effect_matches_contract",
        action_id: "assign_task",
        participants: [
          {
            participant_id: "runtime-producer",
            role: "producer",
            agent_id: "producer-agent",
            action_id: "assign_task",
            state: {
              should_send: true,
              message_type: "progress",
              text: "Runtime effect observation",
              content: {
                payload: {
                  kind: "runtime_state_effect",
                  update: "changed",
                },
              },
            },
          },
        ],
        runtime_assertions: {
          required_changed_paths: ["state_json.last_status_block.related_message_id"],
        },
      },
    ],
  });
}

test("action-module-live runner reads scaffold manifest and participant spec, captures evidence, and writes verdicts", async (t) => {
  const workspaceRoot = makeWorkspace();
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());

  const { scaffold, runner } = await prepareModules("http://community.example/api/v1", workspaceRoot);
  writeSavedState(workspaceRoot);

  const scaffoldResult = await scaffold.runActionModuleLiveCommand({
    workspaceRoot,
    options: {
      "validation-id": "runner-scaffold",
      "action-id": "assign_task",
      intent: "validate action runner",
      "producer-roles": "producer",
      "consumer-roles": "consumer",
      preconditions: "context mounted",
      "routing-rules": "threaded by action id",
      "context-mount": "group_context",
      "output-keys": "body,payload",
      "body-visibility": "required",
      "runtime-effects": "audit metadata only",
      "invalid-cases": "non-owner emission",
      "suppression-behavior": "record suppression without advancing state",
    },
  });

  const participantSpecPath = path.join(workspaceRoot, "specs", "runner-participants.json");
  buildParticipantSpec(participantSpecPath);

  const result = await runner.runActionModuleLiveRunnerCommand({
    workspaceRoot,
    options: {
      manifest: scaffoldResult.manifest_path,
      spec: participantSpecPath,
      "output-root": path.join(workspaceRoot, "artifacts", "live-run"),
      "group-id": "group-1",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "runner");
  assert.equal(result.group_id, "group-1");
  assert.equal(result.action_count, 1);
  assert.equal(result.scenario_count, 4);

  const manifest = readJson(result.manifest_path);
  assert.equal(manifest.run_id, "runner-smoke");
  assert.equal(manifest.scaffold_manifest, scaffoldResult.manifest_path);
  assert.equal(manifest.participant_spec, participantSpecPath);
  assert.equal(manifest.scenarios.length, 4);

  const visible = result.scenarios.find((entry) => entry.scenario_key === "valid_producer_visible_output");
  const handoff = result.scenarios.find((entry) => entry.scenario_key === "expected_consumer_handoff");
  const suppressed = result.scenarios.find((entry) => entry.scenario_key === "invalid_producer_suppressed");
  const runtime = result.scenarios.find((entry) => entry.scenario_key === "runtime_state_effect_matches_contract");

  assert.ok(visible);
  assert.ok(handoff);
  assert.ok(suppressed);
  assert.ok(runtime);

  const visibleVerdict = readJson(visible.verdict);
  const handoffVerdict = readJson(handoff.verdict);
  const suppressedVerdict = readJson(suppressed.verdict);
  const runtimeVerdict = readJson(runtime.verdict);

  assert.equal(visibleVerdict.status, "pass");
  assert.equal(handoffVerdict.status, "pass");
  assert.equal(suppressedVerdict.status, "pass");
  assert.equal(runtimeVerdict.status, "pass");
  assert.ok(fs.existsSync(path.join(handoff.evidence_root, "messages", "consumer-observed.json")));
  assert.equal(readJson(path.join(suppressed.evidence_root, "outcomes", "suppression.json")).suppressed_participants[0], "intruder");
  assert.ok(Object.keys(readJson(path.join(runtime.evidence_root, "runtime", "diff.json"))).length > 0);
});

test("action-module-live runner aggregates paged oldest-first message snapshots so earlier pages still drive before-after detection", async (t) => {
  const workspaceRoot = makeWorkspace();
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

  const fetchMock = installMockFetch({
    onPostMessage({ body, state }) {
      if (body.extensions?.custom?.participant_id !== "producer-valid") {
        return;
      }
      for (let index = 0; index < 205; index += 1) {
        state.messages.push({
          id: `tail-${index + 1}`,
          group_id: "group-1",
          action_id: "tail_action",
          message_type: "analysis",
          flow_type: "run",
          content: {
            text: `tail message ${index + 1}`,
            payload: {
              action_id: "tail_action",
            },
          },
          author: {
            agent_id: "tail-agent",
          },
          relations: {},
          target_agent_id: null,
          extensions: {},
        });
      }
    },
  });
  t.after(() => fetchMock.restore());

  for (let index = 0; index < 205; index += 1) {
    fetchMock.state.messages.push({
      id: `seed-${index + 1}`,
      group_id: "group-1",
      action_id: "seed_action",
      message_type: "analysis",
      flow_type: "run",
      content: {
        text: `seed message ${index + 1}`,
        payload: {
          action_id: "seed_action",
        },
      },
      author: {
        agent_id: "seed-agent",
      },
      relations: {},
      target_agent_id: null,
      extensions: {},
    });
  }

  const { scaffold, runner } = await prepareModules("http://community.example/api/v1", workspaceRoot);
  writeSavedState(workspaceRoot);

  const scaffoldResult = await scaffold.runActionModuleLiveCommand({
    workspaceRoot,
    options: {
      "validation-id": "runner-paged",
      "action-id": "assign_task",
      intent: "validate latest-page capture",
      "producer-roles": "producer",
      "consumer-roles": "consumer",
      preconditions: "context mounted",
      "routing-rules": "threaded by action id",
      "context-mount": "group_context",
      "output-keys": "body,payload",
      "body-visibility": "required",
      "runtime-effects": "audit metadata only",
      "invalid-cases": "non-owner emission",
      "suppression-behavior": "record suppression without advancing state",
    },
  });

  const participantSpecPath = path.join(workspaceRoot, "specs", "runner-participants-paged.json");
  buildParticipantSpec(participantSpecPath);

  const result = await runner.runActionModuleLiveRunnerCommand({
    workspaceRoot,
    options: {
      manifest: scaffoldResult.manifest_path,
      spec: participantSpecPath,
      "output-root": path.join(workspaceRoot, "artifacts", "live-run-paged"),
      "group-id": "group-1",
      "state-file": path.join(
        workspaceRoot,
        ".openclaw",
        "community-agent-template",
        "state",
        "community-webhook-state.json",
      ),
    },
  });

  const visible = result.scenarios.find((entry) => entry.scenario_key === "valid_producer_visible_output");
  const handoff = result.scenarios.find((entry) => entry.scenario_key === "expected_consumer_handoff");
  assert.ok(visible);
  assert.ok(handoff);
  assert.equal(readJson(visible.verdict).status, "pass");
  assert.equal(readJson(handoff.verdict).status, "pass");

  const visibleObserved = readJson(path.join(visible.evidence_root, "messages", "producer-observed.json"));
  assert.equal(visibleObserved.length, 1);
  assert.equal(visibleObserved[0].extensions.custom.participant_id, "producer-valid");

  const visibleAfter = readJson(path.join(visible.evidence_root, "messages", "after.json"));
  assert.ok(visibleAfter.messages.some((message) => message.extensions?.custom?.participant_id === "producer-valid"));

  const afterSnapshot = readJson(path.join(handoff.evidence_root, "messages", "after.json"));
  assert.match(String(afterSnapshot.source || ""), /offset=\d+/);
});

test("action-module-live runner waits for consumer handoff when the producer post times out after the message is accepted", async (t) => {
  const workspaceRoot = makeWorkspace();
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

  let producerTimeoutInjected = false;
  const fetchMock = installMockFetch({
    onPostMessage({ body, message, state }) {
      if (body.extensions?.custom?.participant_id === "producer-turn" && !producerTimeoutInjected) {
        producerTimeoutInjected = true;
        state.messages.push({
          id: `msg-${state.messages.length + 1}`,
          group_id: body.group_id || "group-1",
          action_id: "acknowledge_or_decline",
          message_type: "analysis",
          flow_type: "run",
          content: {
            text: "Auto consumer receipt after producer timeout",
            payload: {
              action_id: "acknowledge_or_decline",
              kind: "consumer_receipt",
            },
          },
          author: {
            agent_id: "consumer-agent",
          },
          relations: {
            parent_message_id: message.id,
          },
          target_agent_id: "producer-agent",
          extensions: {
            custom: {
              participant_id: "consumer-turn",
            },
          },
        });
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
    },
  });
  t.after(() => fetchMock.restore());

  const { scaffold, runner } = await prepareModules("http://community.example/api/v1", workspaceRoot);
  writeSavedState(workspaceRoot);

  const scaffoldResult = await scaffold.runActionModuleLiveCommand({
    workspaceRoot,
    options: {
      "validation-id": "runner-timeout-handoff",
      "action-id": "assign_task",
      intent: "validate consumer polling after producer timeout",
      "producer-roles": "producer",
      "consumer-roles": "consumer",
      preconditions: "context mounted",
      "routing-rules": "threaded by action id",
      "context-mount": "group_context",
      "output-keys": "body,payload",
      "body-visibility": "required",
      "runtime-effects": "audit metadata only",
      "invalid-cases": "non-owner emission",
      "suppression-behavior": "record suppression without advancing state",
    },
  });

  const participantSpecPath = path.join(workspaceRoot, "specs", "runner-timeout-participants.json");
  buildParticipantSpec(participantSpecPath);

  const result = await runner.runActionModuleLiveRunnerCommand({
    workspaceRoot,
    options: {
      manifest: scaffoldResult.manifest_path,
      spec: participantSpecPath,
      "output-root": path.join(workspaceRoot, "artifacts", "live-run-timeout"),
      "group-id": "group-1",
      "state-file": path.join(
        workspaceRoot,
        ".openclaw",
        "community-agent-template",
        "state",
        "community-webhook-state.json",
      ),
      "settle-timeout-ms": 5000,
      "poll-interval-ms": 50,
    },
  });

  const handoff = result.scenarios.find((entry) => entry.scenario_key === "expected_consumer_handoff");
  assert.ok(handoff);

  const handoffVerdict = readJson(handoff.verdict);
  assert.equal(handoffVerdict.status, "pass");
  assert.equal(handoffVerdict.checks.find((check) => check.check_id === "producer_handoff")?.passed, true);
  assert.equal(handoffVerdict.checks.find((check) => check.check_id === "consumer_receipt")?.passed, true);

  const consumerObserved = readJson(path.join(handoff.evidence_root, "messages", "consumer-observed.json"));
  assert.equal(consumerObserved.length >= 1, true);
  assert.equal(consumerObserved[0].action_id || consumerObserved[0].content?.payload?.action_id, "acknowledge_or_decline");
});
