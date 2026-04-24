import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.join(__dirname, "..", "scripts", "community-agent-cli.mjs");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runActionModuleLive(args, workspaceRoot) {
  const result = spawnSync(process.execPath, [CLI_PATH, "action-module-live", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.equal(
    result.status,
    0,
    `action-module-live failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const stdout = result.stdout.trim();
  assert.ok(stdout, "action-module-live did not return JSON output");

  return {
    stdout: JSON.parse(stdout),
    stderr: result.stderr,
  };
}

test("community-agent CLI scaffolds a single action from flags", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "community-action-module-cli-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const outputRoot = path.join(tempRoot, "output");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  try {
    const { stdout } = runActionModuleLive(
      [
        "--validation-id",
        "cli-flag-scaffold",
        "--label",
        "CLI flag scaffold",
        "--output-root",
        outputRoot,
        "--action-id",
        "assign_task",
        "--intent",
        "Assign a task",
        "--producer-roles",
        "manager",
        "--consumer-roles",
        "worker",
        "--preconditions",
        "ready",
        "--routing-rules",
        "direct",
        "--context-mount",
        "/context",
        "--output-keys",
        "task_id",
        "--body-visibility",
        "required",
        "--runtime-effects",
        "audit",
        "--invalid-cases",
        "invalid",
        "--suppression-behavior",
        "suppressed",
        "--scenario-keys",
        "valid_producer_visible_output,runtime_state_effect_matches_contract",
      ],
      workspaceRoot,
    );

    assert.equal(stdout.ok, true);
    assert.equal(stdout.command, "action-module-live");
    assert.equal(stdout.mode, "scaffold");
    assert.equal(stdout.scaffold_id, "cli-flag-scaffold");
    assert.equal(stdout.output_root, outputRoot);
    assert.equal(stdout.manifest_path, path.join(outputRoot, "manifest.json"));
    assert.equal(stdout.spec_source, null);
    assert.equal(stdout.action_count, 1);
    assert.equal(stdout.scenario_count, 2);
    assert.deepEqual(stdout.actions, [
      {
        action_id: "assign_task",
        action_manifest: path.join(outputRoot, "actions", "assign_task", "action.json"),
        evidence_root: path.join(outputRoot, "actions", "assign_task", "evidence"),
        scenario_count: 2,
      },
    ]);

    const manifest = readJson(stdout.manifest_path);
    assert.equal(manifest.scaffold_id, "cli-flag-scaffold");
    assert.equal(manifest.label, "CLI flag scaffold");
    assert.equal(manifest.workspace_root, workspaceRoot);
    assert.equal(manifest.output_root, outputRoot);
    assert.equal(manifest.actions.length, 1);
    assert.deepEqual(manifest.actions[0], {
      action_id: "assign_task",
      action_root: "actions/assign_task",
      action_manifest: "actions/assign_task/action.json",
      evidence_root: "actions/assign_task/evidence",
      scenario_count: 2,
      scenario_keys: [
        "valid_producer_visible_output",
        "runtime_state_effect_matches_contract",
      ],
    });

    const actionManifest = readJson(stdout.actions[0].action_manifest);
    assert.equal(actionManifest.version, 1);
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
    assert.deepEqual(actionManifest.scenario_keys, [
      "valid_producer_visible_output",
      "runtime_state_effect_matches_contract",
    ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("community-agent CLI scaffolds multiple actions from a spec file", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "community-action-module-cli-spec-"));
  const workspaceRoot = path.join(tempRoot, "workspace");
  const outputRoot = path.join(tempRoot, "scaffold");
  const specPath = path.join(tempRoot, "action-live-spec.json");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const spec = {
    validation_id: "workflow-agnostic-spec",
    label: "Workflow-agnostic scaffold",
    actions: [
      {
        action_id: "ask_question",
        intent: "Collect input from the workflow",
        producer_roles: ["user"],
        output_shape: ["response"],
        scenario_keys: ["valid_producer_visible_output"],
      },
      {
        action_id: "request_decision",
        intent: "Route a decision to the next step",
        producer_roles: ["manager"],
        consumer_roles: ["worker"],
        body_visibility: "required",
        runtime_effects: ["audit"],
        scenario_keys: [
          "expected_consumer_handoff",
          "runtime_state_effect_matches_contract",
        ],
      },
    ],
  };
  fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);

  try {
    const { stdout } = runActionModuleLive(
      [
        "--spec",
        specPath,
        "--output-root",
        outputRoot,
      ],
      workspaceRoot,
    );

    assert.equal(stdout.ok, true);
    assert.equal(stdout.command, "action-module-live");
    assert.equal(stdout.mode, "scaffold");
    assert.equal(stdout.scaffold_id, "workflow-agnostic-spec");
    assert.equal(stdout.output_root, outputRoot);
    assert.equal(stdout.manifest_path, path.join(outputRoot, "manifest.json"));
    assert.equal(stdout.spec_source, specPath);
    assert.equal(stdout.action_count, 2);
    assert.equal(stdout.scenario_count, 3);
    assert.deepEqual(
      stdout.actions.map((entry) => ({
        action_id: entry.action_id,
        scenario_count: entry.scenario_count,
      })),
      [
        { action_id: "ask_question", scenario_count: 1 },
        { action_id: "request_decision", scenario_count: 2 },
      ],
    );

    const manifest = readJson(stdout.manifest_path);
    assert.equal(manifest.scaffold_id, "workflow-agnostic-spec");
    assert.equal(manifest.label, "Workflow-agnostic scaffold");
    assert.equal(manifest.spec_source, specPath);
    assert.equal(manifest.actions.length, 2);
    assert.deepEqual(
      manifest.actions.map((entry) => ({
        action_id: entry.action_id,
        scenario_count: entry.scenario_count,
        scenario_keys: entry.scenario_keys,
      })),
      [
        {
          action_id: "ask_question",
          scenario_count: 1,
          scenario_keys: ["valid_producer_visible_output"],
        },
        {
          action_id: "request_decision",
          scenario_count: 2,
          scenario_keys: [
            "expected_consumer_handoff",
            "runtime_state_effect_matches_contract",
          ],
        },
      ],
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
