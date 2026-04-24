import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "community-action-modules-"));
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
const actionModules = await import(pathToFileURL(path.join(__dirname, "..", "scripts", "action_modules", "index.mjs")).href + `?t=${Date.now()}`);

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

function assertNonEmptyArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function assertCompleteActionModuleContract(module) {
  for (const field of actionModules.ACTION_MODULE_CONTRACT_FIELDS) {
    assert.ok(Object.hasOwn(module, field), `missing contract field ${field} for ${module.action_id}`);
  }

  for (const field of ["action_id", "title", "intent", "semantic_meaning"]) {
    assert.ok(String(module[field] || "").trim(), `${module.action_id} must define ${field}`);
  }

  assertNonEmptyArray(module.allowed_producer_roles, `${module.action_id}.allowed_producer_roles`);
  assertNonEmptyArray(module.expected_consumer_roles, `${module.action_id}.expected_consumer_roles`);
  assertNonEmptyArray(module.preconditions, `${module.action_id}.preconditions`);
  assertNonEmptyArray(module.completion_conditions, `${module.action_id}.completion_conditions`);
  assertNonEmptyArray(module.routing_rules, `${module.action_id}.routing_rules`);
  assertNonEmptyArray(module.required_context_mount, `${module.action_id}.required_context_mount`);
  assertNonEmptyArray(module.required_input_fields, `${module.action_id}.required_input_fields`);
  assertNonEmptyArray(module.output_shape, `${module.action_id}.output_shape`);
  assertNonEmptyArray(module.body_visibility_requirements, `${module.action_id}.body_visibility_requirements`);
  assertNonEmptyArray(module.runtime_state_effects, `${module.action_id}.runtime_state_effects`);
  assertNonEmptyArray(module.artifact_effects, `${module.action_id}.artifact_effects`);
  assertNonEmptyArray(module.invalid_cases, `${module.action_id}.invalid_cases`);
  assertNonEmptyArray(module.suppression_behavior, `${module.action_id}.suppression_behavior`);
  assertNonEmptyArray(module.observability_requirements, `${module.action_id}.observability_requirements`);
  assertNonEmptyArray(module.idempotency_rules, `${module.action_id}.idempotency_rules`);

  assert.match(
    module.body_visibility_requirements.join(" "),
    /body|visible/i,
    `${module.action_id} must describe body visibility`,
  );
}

test("action module registry exposes the minimal reusable set and card shape", () => {
  const ids = actionModules.actionModuleIds();
  assert.deepEqual(ids, [
    "assign_task",
    "acknowledge_or_decline",
    "ask_question",
    "answer_question",
    "submit_artifact",
    "review_artifact",
    "request_rework",
    "resubmit_artifact",
    "escalate_blocker",
    "request_decision",
    "close_or_handoff",
  ]);

  const registryCard = actionModules.buildActionModuleRegistryCard();
  const listedModules = actionModules.listActionModules();

  assert.ok(actionModules.ACTION_MODULE_CONTRACT_FIELDS.includes("action_id"));
  assert.ok(actionModules.ACTION_MODULE_CONTRACT_FIELDS.includes("body_visibility_requirements"));
  assert.ok(actionModules.ACTION_MODULE_CONTRACT_FIELDS.includes("consumer_follow_up_action_id"));
  assert.deepEqual(registryCard.contract_fields, actionModules.ACTION_MODULE_CONTRACT_FIELDS);
  assert.deepEqual(registryCard.modules, listedModules);
  for (const module of registryCard.modules) {
    assertCompleteActionModuleContract(module);
  }
  assert.equal(
    listedModules.find((item) => item.action_id === "assign_task")?.consumer_follow_up_action_id,
    "acknowledge_or_decline",
  );
  assert.equal(
    listedModules.find((item) => item.action_id === "request_decision")?.consumer_follow_up_action_id,
    "close_or_handoff",
  );
});

test("buildExecutionPrompt includes action-module guidance and registry card", () => {
  const prompt = integration.buildExecutionPrompt(
    {
      group_id: "group-1",
      message_type: "analysis",
      content: { text: "Please take this task." },
      routing: { target: { agent_id: "worker-a" }, mentions: [] },
    },
    state,
    {
      role_card: { current_agent_role: "manager", current_agent_id: "agent-self" },
      workflow_stage_card: { stage_id: "generic.stage", owner: "manager" },
      execution_stage_card: { stage_id: "generic.stage", accepted_status_rules: [] },
      runtime_session_card: { current_stage: "generic.stage", workflow_id: "workflow-1" },
      pending_formal_signal_card: {},
      assignment_resolution_card: {},
      bootstrap_control_turn_card: {},
      transition_rules_card: {},
    },
    {
      obligation: { obligation: "required", reason: "targeted" },
      recommendation: { mode: "needs_agent_judgment", reason: "required_collaboration" },
    },
  );

  assert.match(prompt[0].content, /Reusable action modules are the stable workflow primitive/i);
  assert.match(prompt[0].content, /Action-module registry card/i);
  assert.match(prompt[0].content, /set action_id to that module id/i);
  assert.match(prompt[0].content, /If one registered action module clearly matches your reply/i);
  assert.match(prompt[0].content, /Consumer follow-up rule/i);
  assert.match(prompt[0].content, /must emit that follow-up action_id/i);
});

test("buildCommunityMessage preserves explicit action_id even when inference could differ", () => {
  const body = integration.buildCommunityMessage(
    state,
    {
      group_id: "group-1",
      thread_id: "thread-1",
      parent_message_id: "parent-1",
      target_agent_id: "worker-a",
      target_agent: "worker-a",
    },
    {
      group_id: "group-1",
      flow_type: "run",
      message_type: "analysis",
      action_id: "acknowledge_or_decline",
      content: {
        text: "Here is the current artifact preview.",
        payload: {
          kind: "candidate_material_pool",
          sections: [
            {
              section: "technology",
              items: [{ title: "Example item", source: "https://example.com" }],
            },
          ],
        },
      },
    },
  );

  assert.equal(body.action_id, "acknowledge_or_decline");
  assert.equal(body.content.payload.action_id, "acknowledge_or_decline");
  assert.equal(body.extensions.custom.action_id, "acknowledge_or_decline");
});

test("buildCommunityMessage infers submit_artifact from artifact-shaped payload", () => {
  const body = integration.buildCommunityMessage(
    state,
    {
      group_id: "group-1",
      thread_id: "thread-2",
      parent_message_id: "parent-2",
      target_agent_id: null,
      target_agent: null,
    },
    {
      group_id: "group-1",
      flow_type: "run",
      message_type: "analysis",
      content: {
        text: "Here is the current artifact preview.",
        payload: {
          kind: "candidate_material_pool",
          sections: [
            {
              section: "technology",
              items: [{ title: "Example item", source: "https://example.com" }],
            },
          ],
        },
      },
    },
  );

  assert.equal(body.action_id, "submit_artifact");
  assert.equal(body.content.payload.action_id, "submit_artifact");
  assert.equal(body.extensions.custom.action_id, "submit_artifact");
});

test("resolveActionModuleReference infers close_or_handoff from manager result status", () => {
  const resolution = actionModules.resolveActionModuleReference({
    flow_type: "result",
    message_type: "summary",
    content: { text: "Stage closed with final decision.", payload: {} },
    status_block: {
      lifecycle_phase: "result",
      step_status: "manager_generic_stage_closed",
      author_role: "manager",
    },
    extensions: {},
  });

  assert.equal(resolution.action_id, "close_or_handoff");
  assert.equal(resolution.contract.action_id, "close_or_handoff");
  assertCompleteActionModuleContract(resolution.contract);
});

test("resolveActionModuleReference keeps action_id empty when inference is not justified", () => {
  const resolution = actionModules.resolveActionModuleReference({
    flow_type: "run",
    message_type: "analysis",
    content: { text: "A plain status update with no module signal.", payload: {} },
    extensions: {},
  });

  assert.equal(resolution.action_id, null);
  assert.deepEqual(resolution.content.payload, {});
  assert.deepEqual(resolution.extensions.custom, {});
});
