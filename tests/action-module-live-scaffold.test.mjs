import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const scaffold = await import(
  pathToFileURL(path.join(__dirname, "..", "scripts", "action_module_live", "index.mjs")).href +
    `?t=${Date.now()}`
);

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "action-module-live-scaffold-"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function expectEvidenceLayout(outputRoot, scenarioPlan, evidenceIndex) {
  assert.equal(evidenceIndex.action_id, scenarioPlan.action_id);
  assert.equal(evidenceIndex.scenario_id, scenarioPlan.scenario_id);
  assert.equal(evidenceIndex.status, "pending_capture");
  assert.deepEqual(
    evidenceIndex.required_slots.map((slot) => slot.slot_id),
    scenarioPlan.evidence.required_slots.map((slot) => slot.slot_id),
  );

  for (const slot of scenarioPlan.evidence.required_slots) {
    const absolute = path.join(outputRoot, ...slot.relative_path.split("/"));
    assert.ok(fs.existsSync(absolute), `missing evidence artifact: ${slot.relative_path}`);
    if (slot.relative_path.endsWith(".json")) {
      const payload = readJson(absolute);
      assert.equal(payload.action_id, scenarioPlan.action_id);
      assert.equal(payload.scenario_id, scenarioPlan.scenario_id);
      assert.equal(payload.slot_id, slot.slot_id);
      assert.equal(payload.evidence_class, slot.evidence_class);
      assert.equal(payload.status, "pending_capture");
      assert.equal(payload.captured_at, null);
      assert.equal(payload.value, null);
      continue;
    }

    assert.equal(fs.readFileSync(absolute, "utf8"), "");
  }
}

test("default scaffold generation writes the default four scenarios and manifest shape", async (t) => {
  const workspaceRoot = makeWorkspace();
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

  const result = await scaffold.runActionModuleLiveCommand({
    workspaceRoot,
    options: {
      "validation-id": "default-scaffold",
      "action-id": "assign_task",
      intent: "publish a generic action scaffold",
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

  const expectedOutputRoot = path.join(
    workspaceRoot,
    ".openclaw",
    "action-module-live",
    "default-scaffold",
  );
  const manifest = readJson(result.manifest_path);
  const actionManifestPath = path.join(expectedOutputRoot, "actions", "assign_task", "action.json");
  const actionManifest = readJson(actionManifestPath);
  const scenarioPlanPath = path.join(
    expectedOutputRoot,
    "actions",
    "assign_task",
    "scenarios",
    "valid_producer_visible_output.json",
  );
  const scenarioPlan = readJson(scenarioPlanPath);
  const evidenceIndex = readJson(
    path.join(
      expectedOutputRoot,
      "actions",
      "assign_task",
      "evidence",
      "valid_producer_visible_output",
      "index.json",
    ),
  );

  assert.equal(result.ok, true);
  assert.equal(result.mode, "scaffold");
  assert.equal(result.scaffold_id, "default-scaffold");
  assert.equal(result.output_root, expectedOutputRoot);
  assert.equal(result.spec_source, null);
  assert.equal(result.action_count, 1);
  assert.equal(result.scenario_count, 4);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.scaffold_id, "default-scaffold");
  assert.equal(manifest.label, null);
  assert.equal(manifest.output_root, expectedOutputRoot);
  assert.equal(manifest.spec_source, null);
  assert.equal(manifest.actions.length, 1);
  assert.deepEqual(manifest.actions[0], {
    action_id: "assign_task",
    action_root: "actions/assign_task",
    action_manifest: "actions/assign_task/action.json",
    evidence_root: "actions/assign_task/evidence",
    scenario_count: 4,
    scenario_keys: scaffold.ACTION_MODULE_LIVE_SCENARIOS,
  });
  assert.deepEqual(actionManifest.scenario_keys, scaffold.ACTION_MODULE_LIVE_SCENARIOS);
  assert.equal(actionManifest.evidence_root, "actions/assign_task/evidence");
  assert.equal(actionManifest.contract.action_id, "assign_task");
  assert.equal(actionManifest.contract.title, "Assign Task");
  assert.equal(actionManifest.contract.semantic_meaning, "requests execution of scoped work inside the current protocol context");
  assert.deepEqual(actionManifest.contract.allowed_producer_roles, [
    "supervisory_role",
    "authorized_stage_owner",
    "authorized_peer",
  ]);
  assert.deepEqual(actionManifest.contract.expected_consumer_roles, [
    "assigned_role",
    "assigned_peer",
    "supervisory_role",
  ]);
  assert.equal(actionManifest.contract.body_visibility, "required");
  assert.equal(scenarioPlan.scenario_id, "assign_task::valid_producer_visible_output");
  assert.equal(scenarioPlan.evidence.scenario_root, "actions/assign_task/evidence/valid_producer_visible_output");
  assert.equal(scenarioPlan.files.evidence_index, "actions/assign_task/evidence/valid_producer_visible_output/index.json");
  expectEvidenceLayout(expectedOutputRoot, scenarioPlan, evidenceIndex);
});

test("manifest and evidence layout are written per action and per scenario", async (t) => {
  const workspaceRoot = makeWorkspace();
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

  const result = await scaffold.runActionModuleLiveCommand({
    workspaceRoot,
    options: {
      "validation-id": "layout-check",
      "action-id": "submit_artifact",
      intent: "exercise action and evidence layout",
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

  const outputRoot = result.output_root;
  const manifest = readJson(result.manifest_path);
  const scenarioPlanPath = path.join(
    outputRoot,
    "actions",
    "submit_artifact",
    "scenarios",
    "expected_consumer_handoff.json",
  );
  const scenarioPlan = readJson(scenarioPlanPath);
  const evidenceIndex = readJson(
    path.join(
      outputRoot,
      "actions",
      "submit_artifact",
      "evidence",
      "expected_consumer_handoff",
      "index.json",
    ),
  );

  assert.equal(manifest.actions[0].action_root, "actions/submit_artifact");
  assert.equal(manifest.actions[0].action_manifest, "actions/submit_artifact/action.json");
  assert.equal(manifest.actions[0].evidence_root, "actions/submit_artifact/evidence");
  assert.equal(scenarioPlan.checkpoints.length, 1);
  assert.deepEqual(scenarioPlan.checkpoints[0].evidence_slots, [
    "producer_message",
    "visible_body",
    "consumer_receipt",
    "consumer_outcome",
  ]);
  assert.deepEqual(
    scenarioPlan.evidence.required_slots.map((slot) => slot.slot_id),
    ["producer_message", "visible_body", "consumer_receipt", "consumer_outcome", "verdict"],
  );
  assert.deepEqual(
    scenarioPlan.evidence.required_slots.map((slot) => slot.relative_path),
    [
      "actions/submit_artifact/evidence/expected_consumer_handoff/message/producer-message.json",
      "actions/submit_artifact/evidence/expected_consumer_handoff/message/body.txt",
      "actions/submit_artifact/evidence/expected_consumer_handoff/message/consumer-receipt.json",
      "actions/submit_artifact/evidence/expected_consumer_handoff/message/consumer-outcome.json",
      "actions/submit_artifact/evidence/expected_consumer_handoff/verdict.json",
    ],
  );
  expectEvidenceLayout(outputRoot, scenarioPlan, evidenceIndex);
});

test("spec-driven multi-action scaffolds honor explicit scenario subsets", async (t) => {
  const workspaceRoot = makeWorkspace();
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

  const specPath = path.join(workspaceRoot, "specs", "multi-action.json");
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(
    specPath,
    JSON.stringify(
      {
        validation_id: "multi-action-spec",
        label: "multi action scaffold",
        output_root: "./artifacts/live-scaffold",
        actions: [
          {
            action_id: "submit_artifact",
            intent: "publish a generic artifact",
            producer_roles: ["producer"],
            consumer_roles: ["reviewer"],
            preconditions: ["context mounted"],
            routing_rules: ["threaded by action id"],
            required_context_mount: ["group_context"],
            output_shape: ["body", "payload"],
            body_visibility: "required",
            runtime_effects: ["audit metadata only"],
            invalid_cases: ["non-owner emission"],
            suppression_behavior: ["record suppression without advancing state"],
            scenario_keys: [
              "valid_producer_visible_output",
              "expected_consumer_handoff",
            ],
          },
          {
            action_id: "request_decision",
            intent: "capture a runtime update",
            producer_roles: ["operator"],
            preconditions: ["runtime snapshot available"],
            routing_rules: ["broadcast to observers"],
            required_context_mount: ["runtime_state"],
            output_shape: ["state summary"],
            body_visibility: "optional",
            runtime_effects: ["runtime snapshot updated"],
            invalid_cases: ["duplicate stale update"],
            suppression_behavior: ["keep runtime stable and audit"],
            scenario_keys: [
              "invalid_producer_suppressed",
              "runtime_state_effect_matches_contract",
            ],
          },
        ],
      },
      null,
      2,
    ),
  );

  const result = await scaffold.runActionModuleLiveCommand({
    workspaceRoot,
    options: {
      spec: path.relative(workspaceRoot, specPath),
    },
  });

  const manifest = readJson(result.manifest_path);
  const alphaManifest = readJson(
    path.join(result.output_root, "actions", "submit_artifact", "action.json"),
  );
  const betaManifest = readJson(
    path.join(result.output_root, "actions", "request_decision", "action.json"),
  );
  const alphaHandoffPlan = readJson(
    path.join(
      result.output_root,
      "actions",
      "submit_artifact",
      "scenarios",
      "expected_consumer_handoff.json",
    ),
  );
  const betaRuntimePlan = readJson(
    path.join(
      result.output_root,
      "actions",
      "request_decision",
      "scenarios",
      "runtime_state_effect_matches_contract.json",
    ),
  );

  assert.equal(result.spec_source, specPath);
  assert.equal(result.output_root, path.join(workspaceRoot, "artifacts", "live-scaffold"));
  assert.equal(result.action_count, 2);
  assert.equal(result.scenario_count, 4);
  assert.deepEqual(
    manifest.actions.map((entry) => entry.action_id),
    ["submit_artifact", "request_decision"],
  );
  assert.deepEqual(
    manifest.actions.map((entry) => entry.scenario_count),
    [2, 2],
  );
  assert.deepEqual(alphaManifest.scenario_keys, [
    "valid_producer_visible_output",
    "expected_consumer_handoff",
  ]);
  assert.deepEqual(betaManifest.scenario_keys, [
    "invalid_producer_suppressed",
    "runtime_state_effect_matches_contract",
  ]);
  assert.equal(alphaManifest.evidence_root, "actions/submit_artifact/evidence");
  assert.equal(betaManifest.evidence_root, "actions/request_decision/evidence");
  assert.equal(alphaHandoffPlan.scenario_id, "submit_artifact::expected_consumer_handoff");
  assert.deepEqual(alphaHandoffPlan.evidence.required_slots.map((slot) => slot.slot_id), [
    "producer_message",
    "visible_body",
    "consumer_receipt",
    "consumer_outcome",
    "verdict",
  ]);
  assert.equal(betaRuntimePlan.scenario_id, "request_decision::runtime_state_effect_matches_contract");
  assert.deepEqual(betaRuntimePlan.evidence.required_slots.map((slot) => slot.slot_id), [
    "runtime_before",
    "runtime_after",
    "runtime_diff",
    "state_effect_summary",
    "verdict",
  ]);
});

test("scaffold rejects unregistered action ids so workflows cannot smuggle new semantics", async (t) => {
  const workspaceRoot = makeWorkspace();
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      scaffold.runActionModuleLiveCommand({
        workspaceRoot,
        options: {
          "validation-id": "invalid-action",
          "action-id": "collect_input",
        },
      }),
    /registered action_id/i,
  );
});
