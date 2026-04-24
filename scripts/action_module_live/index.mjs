import fs from "node:fs";
import path from "node:path";
import { getActionModule, listActionModules, normalizeActionModuleId } from "../action_modules/index.mjs";

const DEFAULT_SCENARIO_KEYS = Object.freeze([
  "valid_producer_visible_output",
  "expected_consumer_handoff",
  "invalid_producer_suppressed",
  "runtime_state_effect_matches_contract",
]);

const COMMON_CONTRACT_FIELDS = Object.freeze([
  "action_id",
  "title",
  "intent",
  "semantic_meaning",
  "allowed_producer_roles",
  "expected_consumer_roles",
  "producer_roles",
  "consumer_roles",
  "preconditions",
  "completion_conditions",
  "routing_rules",
  "required_context_mount",
  "required_input_fields",
  "output_shape",
  "body_visibility_requirements",
  "body_visibility",
  "runtime_state_effects",
  "runtime_effects",
  "artifact_effects",
  "invalid_cases",
  "suppression_behavior",
  "observability_requirements",
  "idempotency_rules",
  "scenario_keys",
]);

function trimString(value) {
  return String(value ?? "").trim();
}

function boolOption(value) {
  const normalized = trimString(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function toList(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => toList(item));
  }
  const normalized = trimString(value);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(/[\n,]/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(values) {
  return [...new Set((values || []).map((item) => trimString(item)).filter(Boolean))];
}

function slugify(value) {
  const base = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "action";
}

function fileTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function relPath(...parts) {
  return parts.filter(Boolean).join("/");
}

function ensureDir(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
}

function writeJson(target, value) {
  ensureDir(target);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(target, value = "") {
  ensureDir(target);
  fs.writeFileSync(target, value);
}

function resolvePath(root, targetPath) {
  const normalized = trimString(targetPath);
  if (!normalized) {
    return "";
  }
  return path.isAbsolute(normalized) ? normalized : path.resolve(root, normalized);
}

function slot(slotId, evidenceClass, relativePath, options = {}) {
  return {
    slot_id: slotId,
    evidence_class: evidenceClass,
    relative_path: relativePath,
    required: options.required !== false,
    capture_stage: options.captureStage || null,
  };
}

function consumerScenarioApplies(action) {
  return action.consumer_roles.length > 0;
}

function runtimeExpectation(action) {
  if (action.runtime_effects.length > 0) {
    return "declared runtime effects are observable and attributable to this action";
  }
  return "runtime state remains unchanged except for allowed audit metadata";
}

const SCENARIO_TEMPLATES = Object.freeze({
  valid_producer_visible_output: {
    description: "Contract-valid producer emits body-visible output with structured payload and routing metadata.",
    applies: () => true,
    build(action, paths) {
      return {
        expectations: [
          "producer role matches the action contract",
          action.body_visibility === "optional"
            ? "body-visible content is captured when the action emits visible output"
            : "body-visible content is present for downstream readers",
          "structured payload matches the declared output shape",
          "routing metadata matches the action contract",
        ],
        checkpoints: [
          {
            checkpoint_id: "prepare_context",
            verifies: [
              "required context mount is present",
              "preconditions are captured before execution",
            ],
            evidence_slots: ["context_snapshot", "runtime_before"],
          },
          {
            checkpoint_id: "capture_output",
            verifies: [
              "producer output is body-visible",
              "payload and routing are captured",
            ],
            evidence_slots: ["producer_message", "visible_body", "payload", "routing_metadata"],
          },
        ],
        evidence_slots: [
          slot("context_snapshot", "context_snapshot", relPath(paths.evidenceRoot, "context", "request-context.json"), {
            captureStage: "prepare_context",
          }),
          slot("runtime_before", "runtime_snapshot", relPath(paths.evidenceRoot, "runtime", "before.json"), {
            captureStage: "prepare_context",
          }),
          slot("producer_message", "group_message", relPath(paths.evidenceRoot, "message", "producer-message.json"), {
            captureStage: "capture_output",
          }),
          slot("visible_body", "message_body", relPath(paths.evidenceRoot, "message", "body.txt"), {
            captureStage: "capture_output",
            required: action.body_visibility !== "optional",
          }),
          slot("payload", "structured_payload", relPath(paths.evidenceRoot, "message", "payload.json"), {
            captureStage: "capture_output",
          }),
          slot("routing_metadata", "routing_metadata", relPath(paths.evidenceRoot, "message", "routing.json"), {
            captureStage: "capture_output",
          }),
          slot("verdict", "scenario_verdict", relPath(paths.evidenceRoot, "verdict.json"), {
            captureStage: "evaluate",
          }),
        ],
      };
    },
  },
  expected_consumer_handoff: {
    description: "Expected consumer reads the action output and the handoff outcome is recorded.",
    applies: consumerScenarioApplies,
    build(action, paths) {
      return {
        expectations: [
          "consumer role matches the action contract",
          "consumer receives body-visible output from the producer",
          "consumer reaction or observation is captured without workflow-specific assumptions",
        ],
        checkpoints: [
          {
            checkpoint_id: "capture_handoff",
            verifies: [
              "consumer receipt is captured",
              "consumer response or observation is attributable to the action output",
            ],
            evidence_slots: [
              "producer_message",
              "visible_body",
              "consumer_receipt",
              "consumer_outcome",
            ],
          },
        ],
        evidence_slots: [
          slot("producer_message", "group_message", relPath(paths.evidenceRoot, "message", "producer-message.json"), {
            captureStage: "capture_handoff",
          }),
          slot("visible_body", "message_body", relPath(paths.evidenceRoot, "message", "body.txt"), {
            captureStage: "capture_handoff",
            required: action.body_visibility !== "optional",
          }),
          slot("consumer_receipt", "consumer_receipt", relPath(paths.evidenceRoot, "message", "consumer-receipt.json"), {
            captureStage: "capture_handoff",
          }),
          slot("consumer_outcome", "consumer_outcome", relPath(paths.evidenceRoot, "message", "consumer-outcome.json"), {
            captureStage: "capture_handoff",
          }),
          slot("verdict", "scenario_verdict", relPath(paths.evidenceRoot, "verdict.json"), {
            captureStage: "evaluate",
          }),
        ],
      };
    },
  },
  invalid_producer_suppressed: {
    description: "Non-contract producer attempt is recorded and suppressed without advancing the action.",
    applies: () => true,
    build(action, paths) {
      return {
        expectations: [
          "non-contract producer does not advance the action",
          "suppression reason is captured for auditability",
          "runtime state does not change beyond allowed audit metadata",
        ],
        checkpoints: [
          {
            checkpoint_id: "capture_invalid_attempt",
            verifies: [
              "invalid attempt input is preserved",
              "suppression output is recorded",
            ],
            evidence_slots: ["invalid_attempt", "suppression_result"],
          },
          {
            checkpoint_id: "verify_runtime_stability",
            verifies: [
              "runtime state stayed stable after suppression",
            ],
            evidence_slots: ["runtime_before", "runtime_after", "runtime_diff"],
          },
        ],
        evidence_slots: [
          slot("invalid_attempt", "invalid_attempt", relPath(paths.evidenceRoot, "attempts", "invalid-producer-request.json"), {
            captureStage: "capture_invalid_attempt",
          }),
          slot("suppression_result", "suppression_result", relPath(paths.evidenceRoot, "outcomes", "suppression.json"), {
            captureStage: "capture_invalid_attempt",
          }),
          slot("runtime_before", "runtime_snapshot", relPath(paths.evidenceRoot, "runtime", "before.json"), {
            captureStage: "verify_runtime_stability",
          }),
          slot("runtime_after", "runtime_snapshot", relPath(paths.evidenceRoot, "runtime", "after.json"), {
            captureStage: "verify_runtime_stability",
          }),
          slot("runtime_diff", "runtime_diff", relPath(paths.evidenceRoot, "runtime", "diff.json"), {
            captureStage: "verify_runtime_stability",
          }),
          slot("verdict", "scenario_verdict", relPath(paths.evidenceRoot, "verdict.json"), {
            captureStage: "evaluate",
          }),
        ],
      };
    },
  },
  runtime_state_effect_matches_contract: {
    description: "Runtime state delta is captured and checked against the action contract.",
    applies: () => true,
    build(action, paths) {
      return {
        expectations: [
          runtimeExpectation(action),
          "captured state delta is attributable to the action instance",
        ],
        checkpoints: [
          {
            checkpoint_id: "capture_runtime_delta",
            verifies: [
              "before and after runtime snapshots are captured",
              "delta summary is recorded for later evaluation",
            ],
            evidence_slots: ["runtime_before", "runtime_after", "runtime_diff", "state_effect_summary"],
          },
        ],
        evidence_slots: [
          slot("runtime_before", "runtime_snapshot", relPath(paths.evidenceRoot, "runtime", "before.json"), {
            captureStage: "capture_runtime_delta",
          }),
          slot("runtime_after", "runtime_snapshot", relPath(paths.evidenceRoot, "runtime", "after.json"), {
            captureStage: "capture_runtime_delta",
          }),
          slot("runtime_diff", "runtime_diff", relPath(paths.evidenceRoot, "runtime", "diff.json"), {
            captureStage: "capture_runtime_delta",
          }),
          slot("state_effect_summary", "state_effect_summary", relPath(paths.evidenceRoot, "outcomes", "state-effect.json"), {
            captureStage: "capture_runtime_delta",
          }),
          slot("verdict", "scenario_verdict", relPath(paths.evidenceRoot, "verdict.json"), {
            captureStage: "evaluate",
          }),
        ],
      };
    },
  },
});

function normalizeActionSpec(input, index = 0) {
  const actionId = normalizeActionModuleId(input.action_id || input.actionId);
  if (!actionId) {
    throw new Error(`action spec at index ${index} must reference a registered action_id`);
  }
  const scenarioKeys = uniqueList(
    toList(input.scenario_keys || input.scenarioKeys || input.scenarios),
  );
  return {
    action_id: actionId,
    title: trimString(input.title),
    intent: trimString(input.intent),
    semantic_meaning: trimString(input.semantic_meaning || input.semanticMeaning),
    allowed_producer_roles: uniqueList(
      toList(input.allowed_producer_roles || input.allowedProducerRoles),
    ),
    expected_consumer_roles: uniqueList(
      toList(input.expected_consumer_roles || input.expectedConsumerRoles),
    ),
    producer_roles: uniqueList(toList(input.producer_roles || input.producerRoles)),
    consumer_roles: uniqueList(toList(input.consumer_roles || input.consumerRoles)),
    preconditions: uniqueList(toList(input.preconditions)),
    completion_conditions: uniqueList(
      toList(input.completion_conditions || input.completionConditions),
    ),
    routing_rules: uniqueList(toList(input.routing_rules || input.routingRules)),
    required_context_mount: uniqueList(
      toList(input.required_context_mount || input.requiredContextMount || input.context_mount),
    ),
    required_input_fields: uniqueList(
      toList(input.required_input_fields || input.requiredInputFields),
    ),
    output_shape: uniqueList(toList(input.output_shape || input.outputShape || input.output_keys)),
    body_visibility_requirements: uniqueList(
      toList(input.body_visibility_requirements || input.bodyVisibilityRequirements),
    ),
    body_visibility: trimString(input.body_visibility || input.bodyVisibility || "required") || "required",
    runtime_state_effects: uniqueList(
      toList(input.runtime_state_effects || input.runtimeStateEffects),
    ),
    runtime_effects: uniqueList(toList(input.runtime_effects || input.runtimeEffects)),
    artifact_effects: uniqueList(toList(input.artifact_effects || input.artifactEffects)),
    invalid_cases: uniqueList(toList(input.invalid_cases || input.invalidCases)),
    suppression_behavior: uniqueList(
      toList(input.suppression_behavior || input.suppressionBehavior),
    ),
    observability_requirements: uniqueList(
      toList(input.observability_requirements || input.observabilityRequirements),
    ),
    idempotency_rules: uniqueList(toList(input.idempotency_rules || input.idempotencyRules)),
    scenario_keys: scenarioKeys,
  };
}

function applyRegistryDefaults(action) {
  const contract = getActionModule(action.action_id);
  if (!contract) {
    return action;
  }
  return {
    ...action,
    title: action.title || trimString(contract.title),
    intent: action.intent || trimString(contract.intent),
    semantic_meaning: action.semantic_meaning || trimString(contract.semantic_meaning),
    allowed_producer_roles:
      action.allowed_producer_roles.length > 0
        ? action.allowed_producer_roles
        : uniqueList(contract.allowed_producer_roles || []),
    expected_consumer_roles:
      action.expected_consumer_roles.length > 0
        ? action.expected_consumer_roles
        : uniqueList(contract.expected_consumer_roles || []),
    producer_roles:
      action.producer_roles.length > 0
        ? action.producer_roles
        : uniqueList(contract.allowed_producer_roles || []),
    consumer_roles:
      action.consumer_roles.length > 0
        ? action.consumer_roles
        : uniqueList(contract.expected_consumer_roles || []),
    completion_conditions:
      action.completion_conditions.length > 0
        ? action.completion_conditions
        : uniqueList(contract.completion_conditions || []),
    required_input_fields:
      action.required_input_fields.length > 0
        ? action.required_input_fields
        : uniqueList(contract.required_input_fields || []),
    body_visibility_requirements:
      action.body_visibility_requirements.length > 0
        ? action.body_visibility_requirements
        : uniqueList(contract.body_visibility_requirements || []),
    runtime_state_effects:
      action.runtime_state_effects.length > 0
        ? action.runtime_state_effects
        : uniqueList(contract.runtime_state_effects || []),
    artifact_effects:
      action.artifact_effects.length > 0
        ? action.artifact_effects
        : uniqueList(contract.artifact_effects || []),
    observability_requirements:
      action.observability_requirements.length > 0
        ? action.observability_requirements
        : uniqueList(contract.observability_requirements || []),
    idempotency_rules:
      action.idempotency_rules.length > 0
        ? action.idempotency_rules
        : uniqueList(contract.idempotency_rules || []),
    preconditions:
      action.preconditions.length > 0 ? action.preconditions : uniqueList(contract.preconditions || []),
    routing_rules:
      action.routing_rules.length > 0 ? action.routing_rules : uniqueList(contract.routing_rules || []),
    required_context_mount:
      action.required_context_mount.length > 0
        ? action.required_context_mount
        : uniqueList(contract.required_context_mount || []),
    output_shape:
      action.output_shape.length > 0 ? action.output_shape : uniqueList(contract.output_shape || []),
    invalid_cases:
      action.invalid_cases.length > 0 ? action.invalid_cases : uniqueList(contract.invalid_cases || []),
    suppression_behavior:
      action.suppression_behavior.length > 0
        ? action.suppression_behavior
        : uniqueList(contract.suppression_behavior || []),
  };
}

function loadSpecFile(specPath) {
  try {
    return JSON.parse(fs.readFileSync(specPath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read action live spec ${specPath}: ${error.message}`);
  }
}

function actionSpecFromOptions(options) {
  return applyRegistryDefaults(normalizeActionSpec(
    {
      action_id: options["action-id"],
      title: options.title,
      intent: options.intent,
      semantic_meaning: options["semantic-meaning"],
      allowed_producer_roles: options["allowed-producer-roles"],
      expected_consumer_roles: options["expected-consumer-roles"],
      producer_roles: options["producer-roles"],
      consumer_roles: options["consumer-roles"],
      preconditions: options.preconditions,
      completion_conditions: options["completion-conditions"],
      routing_rules: options["routing-rules"],
      required_context_mount: options["context-mount"],
      required_input_fields: options["required-input-fields"],
      output_shape: options["output-keys"],
      body_visibility_requirements: options["body-visibility-requirements"],
      body_visibility: options["body-visibility"],
      runtime_state_effects: options["runtime-state-effects"],
      runtime_effects: options["runtime-effects"],
      artifact_effects: options["artifact-effects"],
      invalid_cases: options["invalid-cases"],
      suppression_behavior: options["suppression-behavior"],
      observability_requirements: options["observability-requirements"],
      idempotency_rules: options["idempotency-rules"],
      scenario_keys: options["scenario-keys"],
    },
    0,
  ));
}

function resolveCommandSpec({ options, workspaceRoot }) {
  if (boolOption(options["all-default"])) {
    return {
      validation_id: trimString(options["validation-id"]),
      label: trimString(options.label || "minimal-action-module-live"),
      output_root: trimString(options["output-root"]),
      actions: listActionModules().map((action, index) =>
        applyRegistryDefaults(normalizeActionSpec({ action_id: action.action_id }, index)),
      ),
      spec_source: null,
    };
  }

  const specPath = resolvePath(workspaceRoot, options.spec);
  if (specPath) {
    const raw = loadSpecFile(specPath);
    const payload = Array.isArray(raw) ? { actions: raw } : raw || {};
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    if (actions.length === 0) {
      throw new Error(`action live spec ${specPath} does not define any actions`);
    }
    return {
      validation_id: trimString(payload.validation_id || payload.validationId || options["validation-id"]),
      label: trimString(payload.label || options.label),
      output_root: trimString(payload.output_root || payload.outputRoot || options["output-root"]),
      actions: actions.map((action, index) => applyRegistryDefaults(normalizeActionSpec(action, index))),
      spec_source: specPath,
    };
  }

  if (!trimString(options["action-id"])) {
    throw new Error("action-module-live requires --action-id, --spec, or --all-default true");
  }

  return {
    validation_id: trimString(options["validation-id"]),
    label: trimString(options.label),
    output_root: trimString(options["output-root"]),
    actions: [actionSpecFromOptions(options)],
    spec_source: null,
  };
}

function createScenario(action, scenarioKey, basePaths) {
  const template = SCENARIO_TEMPLATES[scenarioKey];
  if (!template) {
    throw new Error(`unknown scenario key: ${scenarioKey}`);
  }
  if (!template.applies(action)) {
    return null;
  }

  const actionSlug = slugify(action.action_id);
  const paths = {
    actionRoot: relPath("actions", actionSlug),
    scenarioPlan: relPath("actions", actionSlug, "scenarios", `${scenarioKey}.json`),
    evidenceRoot: relPath("actions", actionSlug, "evidence", scenarioKey),
    ...basePaths,
  };
  const built = template.build(action, paths);
  return {
    scenario_id: `${action.action_id}::${scenarioKey}`,
    scenario_key: scenarioKey,
    action_id: action.action_id,
    status: "planned",
    description: template.description,
    checkpoints: built.checkpoints,
    expectations: built.expectations,
    participants: {
      producer_roles: action.producer_roles,
      consumer_roles: action.consumer_roles,
    },
    evidence: {
      scenario_root: paths.evidenceRoot,
      required_slots: built.evidence_slots,
    },
    contract_focus: {
      preconditions: action.preconditions,
      routing_rules: action.routing_rules,
      required_context_mount: action.required_context_mount,
      output_shape: action.output_shape,
      runtime_effects: action.runtime_effects,
      invalid_cases: action.invalid_cases,
      suppression_behavior: action.suppression_behavior,
      body_visibility: action.body_visibility,
    },
    files: {
      scenario_plan: paths.scenarioPlan,
      evidence_index: relPath(paths.evidenceRoot, "index.json"),
    },
  };
}

function buildActionEntry(action) {
  const actionSlug = slugify(action.action_id);
  const requestedScenarioKeys = action.scenario_keys.length > 0 ? action.scenario_keys : DEFAULT_SCENARIO_KEYS;
  const scenarios = requestedScenarioKeys
    .map((scenarioKey) => createScenario(action, scenarioKey, {}))
    .filter(Boolean);
  return {
    action,
    actionSlug,
    actionRoot: relPath("actions", actionSlug),
    actionManifest: relPath("actions", actionSlug, "action.json"),
    scenarios,
  };
}

function defaultPlaceholder(slotDefinition, scenario) {
  return {
    action_id: scenario.action_id,
    scenario_id: scenario.scenario_id,
    slot_id: slotDefinition.slot_id,
    evidence_class: slotDefinition.evidence_class,
    status: "pending_capture",
    captured_at: null,
    value: null,
  };
}

function writeScenarioArtifacts(outputRoot, scenario) {
  const evidenceIndex = {
    action_id: scenario.action_id,
    scenario_id: scenario.scenario_id,
    status: "pending_capture",
    required_slots: scenario.evidence.required_slots,
  };
  writeJson(path.join(outputRoot, ...scenario.files.evidence_index.split("/")), evidenceIndex);
  for (const slotDefinition of scenario.evidence.required_slots) {
    const target = path.join(outputRoot, ...slotDefinition.relative_path.split("/"));
    if (slotDefinition.relative_path.endsWith(".json")) {
      writeJson(target, defaultPlaceholder(slotDefinition, scenario));
      continue;
    }
    writeText(target, "");
  }
}

function buildManifest({ validationId, label, outputRoot, workspaceRoot, specSource, actionEntries }) {
  return {
    version: 1,
    scaffold_id: validationId,
    label: label || null,
    generated_at: new Date().toISOString(),
    workspace_root: workspaceRoot,
    output_root: outputRoot,
    spec_source: specSource,
    actions: actionEntries.map((entry) => ({
      action_id: entry.action.action_id,
      action_root: entry.actionRoot,
      action_manifest: entry.actionManifest,
      evidence_root: relPath(entry.actionRoot, "evidence"),
      scenario_count: entry.scenarios.length,
      scenario_keys: entry.scenarios.map((scenario) => scenario.scenario_key),
    })),
  };
}

export async function runActionModuleLiveCommand({ options = {}, workspaceRoot }) {
  const spec = resolveCommandSpec({ options, workspaceRoot });
  const now = new Date();
  const validationId = spec.validation_id || `action-module-live-${fileTimestamp(now)}`;
  const defaultOutputRoot = path.join(
    workspaceRoot,
    ".openclaw",
    "action-module-live",
    slugify(validationId),
  );
  const outputRoot = resolvePath(workspaceRoot, spec.output_root) || defaultOutputRoot;
  const force = boolOption(options.force);

  if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length > 0 && !force) {
    throw new Error(`output root already exists and is not empty: ${outputRoot} (use --force true to reuse it)`);
  }

  fs.mkdirSync(outputRoot, { recursive: true });

  const actionEntries = spec.actions.map((action) => buildActionEntry(action));
  for (const entry of actionEntries) {
    writeJson(
      path.join(outputRoot, ...entry.actionManifest.split("/")),
      {
        version: 1,
        contract: entry.action,
        scenario_keys: entry.scenarios.map((scenario) => scenario.scenario_key),
        evidence_root: relPath(entry.actionRoot, "evidence"),
      },
    );
    for (const scenario of entry.scenarios) {
      writeJson(path.join(outputRoot, ...scenario.files.scenario_plan.split("/")), scenario);
      writeScenarioArtifacts(outputRoot, scenario);
    }
  }

  const manifest = buildManifest({
    validationId,
    label: spec.label,
    outputRoot,
    workspaceRoot,
    specSource: spec.spec_source,
    actionEntries,
  });
  const manifestPath = path.join(outputRoot, "manifest.json");
  writeJson(manifestPath, manifest);

  return {
    ok: true,
    mode: "scaffold",
    scaffold_id: validationId,
    output_root: outputRoot,
    manifest_path: manifestPath,
    spec_source: spec.spec_source,
    action_count: actionEntries.length,
    scenario_count: actionEntries.reduce((total, entry) => total + entry.scenarios.length, 0),
    actions: actionEntries.map((entry) => ({
      action_id: entry.action.action_id,
      action_manifest: path.join(outputRoot, ...entry.actionManifest.split("/")),
      evidence_root: path.join(outputRoot, ...relPath(entry.actionRoot, "evidence").split("/")),
      scenario_count: entry.scenarios.length,
    })),
  };
}

export const ACTION_MODULE_LIVE_FIELDS = COMMON_CONTRACT_FIELDS;
export const ACTION_MODULE_LIVE_SCENARIOS = Object.keys(SCENARIO_TEMPLATES);
