import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const actionModules = await import(
  pathToFileURL(path.join(__dirname, "..", "scripts", "action_modules", "index.mjs")).href + `?t=${Date.now()}`
);
const newsflowProtocol = await import(
  pathToFileURL(path.join(__dirname, "..", "scripts", "workflow_live", "newsflow_protocol.mjs")).href + `?t=${Date.now()}`
);

test("newsflow workflow spec removes material.review and stops at retrospective.plan", () => {
  const spec = newsflowProtocol.buildNewsflowWorkflowSpec();
  assert.equal(spec.workflow_id, newsflowProtocol.NEWSFLOW_WORKFLOW_ID);
  assert.equal(spec.stop_stage, "retrospective.plan");
  assert.equal(spec.stage_order.includes("material.review"), false);
  assert.deepEqual(
    spec.stage_order,
    [
      "step0",
      "step1",
      "step2",
      "formal_start",
      "cycle.start",
      "material.collect",
      "draft.compose",
      "draft.proofread",
      "draft.revise",
      "draft.recheck",
      "publish.decision",
      "report.publish",
      "product.test",
      "product.benchmark",
      "product.cross_cycle_compare",
      "product.report",
      "retrospective.plan",
      "retrospective.discussion",
    ],
  );

  const materialCollect = spec.stages.find((stage) => stage.stage_id === "material.collect");
  assert.equal(materialCollect.owner, "tester");
  assert.equal(materialCollect.organizer_role, "tester");
  assert.equal(materialCollect.next_stage, "draft.compose");
  assert.equal(materialCollect.expected_action_ids.includes("review_artifact"), true);
  assert.equal(materialCollect.expected_action_ids.includes("request_rework"), true);
  assert.equal(materialCollect.expected_action_ids.includes("resubmit_artifact"), true);
});

test("newsflow workflow protocol only references registered action modules", () => {
  const registeredIds = new Set(actionModules.listActionModules().map((item) => item.action_id));
  const spec = newsflowProtocol.buildNewsflowWorkflowSpec();
  for (const stage of spec.stages) {
    for (const actionId of stage.expected_action_ids) {
      assert.equal(
        registeredIds.has(actionId),
        true,
        `stage ${stage.stage_id} references unregistered action module ${actionId}`,
      );
    }
  }
});

test("bound newsflow group protocol binds all five role ids and exposes action-composed stage cards", () => {
  const bound = newsflowProtocol.buildBoundNewsflowGroupProtocol({
    manager: "manager-1",
    editor: "editor-1",
    tester: "tester-1",
    worker_a: "worker-a-1",
    worker_b: "worker-b-1",
  });

  assert.equal(bound.members.manager_agent_id, "manager-1");
  assert.deepEqual(bound.members.worker_agent_ids, ["editor-1", "tester-1", "worker-a-1", "worker-b-1"]);
  assert.equal(bound.execution_spec.workflow_id, newsflowProtocol.NEWSFLOW_WORKFLOW_ID);
  assert.equal(bound.execution_spec.stage_order.includes("material.review"), false);
  assert.equal(bound.group_session_seed.current_stage, "step0");

  const materialCollect = bound.workflow.formal_workflow.stages["material.collect"];
  assert.equal(materialCollect.owner, "tester");
  assert.equal(materialCollect.organizer_role, "tester");
  assert.equal(materialCollect.primary_consumer_role, "tester");
  assert.deepEqual(materialCollect.observe_only_roles, ["editor"]);
  assert.deepEqual(
    materialCollect.allowed_action_modules,
    [
      "assign_task",
      "submit_artifact",
      "review_artifact",
      "request_rework",
      "resubmit_artifact",
      "ask_question",
      "answer_question",
      "escalate_blocker",
      "request_decision",
      "close_or_handoff",
    ],
  );

  const executionMaterialCollect = bound.execution_spec.stages["material.collect"];
  assert.equal(executionMaterialCollect.next_stage, "draft.compose");
  assert.equal(executionMaterialCollect.allowed_action_modules.includes("review_artifact"), true);

  const executionStep1 = bound.execution_spec.stages.step1;
  assert.deepEqual(
    executionStep1.completion_condition.all_of.map((item) => item.gate_id),
    ["manager_start", "worker_run", "manager_done"],
  );
  assert.deepEqual(
    executionStep1.completion_condition.all_of[0].required_agent_ids,
    ["manager-1"],
  );

  const executionStep2 = bound.execution_spec.stages.step2;
  assert.deepEqual(
    executionStep2.completion_condition.all_of.map((item) => item.gate_id),
    ["manager_start", "worker_run", "manager_done"],
  );
  assert.deepEqual(
    executionStep2.completion_condition.all_of[0].required_agent_ids,
    ["manager-1"],
  );
});
