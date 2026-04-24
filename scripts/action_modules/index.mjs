function normalizedToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function dictValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function hasMeaningfulValue(value) {
  if (Array.isArray(value)) {
    return value.some((item) => hasMeaningfulValue(item));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => hasMeaningfulValue(item));
  }
  return Boolean(String(value || "").trim());
}

export const ACTION_MODULE_CONTRACT_FIELDS = Object.freeze([
  "action_id",
  "title",
  "intent",
  "semantic_meaning",
  "allowed_producer_roles",
  "expected_consumer_roles",
  "consumer_follow_up_action_id",
  "preconditions",
  "completion_conditions",
  "routing_rules",
  "required_context_mount",
  "required_input_fields",
  "output_shape",
  "body_visibility_requirements",
  "runtime_state_effects",
  "artifact_effects",
  "invalid_cases",
  "suppression_behavior",
  "observability_requirements",
  "idempotency_rules",
]);

const SHARED_REQUIRED_CONTEXT_MOUNT = Object.freeze([
  "group charter",
  "current stage contract",
  "runtime session state",
  "thread context and routing metadata",
  "role directory and authority boundaries",
]);

const SHARED_SUPPRESSION_BEHAVIOR = Object.freeze([
  "suppress invalid emissions by dropping authority-sensitive effects or downgrading the turn to observe-only",
  "record the violation without rewriting charter or stage authority",
]);

const SHARED_OBSERVABILITY_REQUIREMENTS = Object.freeze([
  "retain action_id, producer role, consumer role, thread_id, parent_message_id, and stage_id",
  "keep the visible body and payload traceable for audit and replay checks",
  "preserve duplicate and stale markers when suppression happens",
]);

const BASE_PRECONDITIONS = Object.freeze([
  "the producer role is authorized by the mounted stage contract",
  "the group charter and current runtime state are visible on the turn",
  "the turn is not a known stale duplicate",
]);

const BASE_INVALID_CASES = Object.freeze([
  "producer role is outside the allowed producer set",
  "required stage, group, or thread context is missing",
  "the turn is malformed or missing the visible body required by the contract",
  "the same action has already been accepted for the current thread and revision",
]);

const BASE_IDEMPOTENCY_RULES = Object.freeze([
  "normalize repeated deliveries by action_id plus thread and message identity",
  "preserve the first accepted visible body and structured payload",
  "treat stale duplicates as no-op or audit-only events without changing authority-sensitive state",
]);

function createActionModuleContract(spec) {
  return Object.freeze({
    action_id: spec.action_id,
    title: spec.title,
    intent: spec.intent,
    semantic_meaning: spec.semantic_meaning,
    allowed_producer_roles: [...spec.allowed_producer_roles],
    expected_consumer_roles: [...spec.expected_consumer_roles],
    consumer_follow_up_action_id: firstNonEmpty(spec.consumer_follow_up_action_id) || null,
    preconditions: [...BASE_PRECONDITIONS, ...spec.preconditions],
    completion_conditions: [...spec.completion_conditions],
    routing_rules: [...spec.routing_rules],
    required_context_mount: [...SHARED_REQUIRED_CONTEXT_MOUNT],
    required_input_fields: [...spec.required_input_fields],
    output_shape: [...spec.output_shape],
    body_visibility_requirements: [...spec.body_visibility_requirements],
    runtime_state_effects: [...spec.runtime_state_effects],
    artifact_effects: [...spec.artifact_effects],
    invalid_cases: [...BASE_INVALID_CASES, ...spec.invalid_cases],
    suppression_behavior: [...SHARED_SUPPRESSION_BEHAVIOR],
    observability_requirements: [...SHARED_OBSERVABILITY_REQUIREMENTS],
    idempotency_rules: [...BASE_IDEMPOTENCY_RULES, ...spec.idempotency_rules],
  });
}

const ACTION_MODULES = Object.freeze([
  createActionModuleContract({
    action_id: "assign_task",
    title: "Assign Task",
    intent: "delegate a concrete unit of work",
    semantic_meaning: "requests execution of scoped work inside the current protocol context",
    allowed_producer_roles: ["supervisory_role", "authorized_stage_owner", "authorized_peer"],
    expected_consumer_roles: ["assigned_role", "assigned_peer", "supervisory_role"],
    consumer_follow_up_action_id: "acknowledge_or_decline",
    preconditions: ["a concrete task boundary has been identified"],
    completion_conditions: [
      "the target recipient can identify the work to start and the next action",
      "the visible body names the assignee and the requested work",
    ],
    routing_rules: [
      "deliver to the assigned role or peer",
      "include supervisory observers when the stage contract requires oversight",
    ],
    required_input_fields: ["visible body text", "target role or agent", "task summary"],
    output_shape: [
      "visible body with the assignment request",
      "structured payload with target, scope, and action_id",
      "routing metadata for the assigned recipient",
    ],
    body_visibility_requirements: [
      "the body must name the task, recipient, and requested next action",
      "payload-only assignment is not sufficient",
    ],
    runtime_state_effects: [
      "record the delegated work item and its target",
      "update the pending assignment state for the current thread",
    ],
    artifact_effects: ["creates or updates a task assignment record"],
    invalid_cases: ["missing target or scope", "stage does not allow delegation"],
    idempotency_rules: ["repeated identical delegation keeps the same assignment record"],
  }),
  createActionModuleContract({
    action_id: "acknowledge_or_decline",
    title: "Acknowledge Or Decline",
    intent: "accept or refuse a received task",
    semantic_meaning: "records whether the consumer accepts the task boundary or cannot proceed",
    allowed_producer_roles: ["assigned_role", "assigned_peer"],
    expected_consumer_roles: ["requesting_role", "supervisory_role"],
    consumer_follow_up_action_id: null,
    preconditions: ["a task or request has been received and can be answered"],
    completion_conditions: [
      "the visible body clearly states accept or decline",
      "a decline includes a reason or blocker when one exists",
    ],
    routing_rules: [
      "send the response back to the requesting role",
      "surface the reply to supervisory observers when the stage contract requires it",
    ],
    required_input_fields: ["visible body text", "referenced task or request", "decision state"],
    output_shape: [
      "visible body with accept or decline language",
      "structured payload with the decision and any reason",
      "routing metadata tied to the original request",
    ],
    body_visibility_requirements: [
      "the body must show the accept or decline decision",
      "the body must include the reason when declining",
    ],
    runtime_state_effects: [
      "record acceptance or refusal against the current task",
      "preserve the current task state for follow-up handling",
    ],
    artifact_effects: ["updates the task acknowledgement record"],
    invalid_cases: ["missing decision state", "unrelated producer", "unclear target request"],
    idempotency_rules: ["repeated identical acknowledgement stays stable", "a conflicting repeat is flagged without overwriting the first authoritative response"],
  }),
  createActionModuleContract({
    action_id: "ask_question",
    title: "Ask Question",
    intent: "request clarification or missing information",
    semantic_meaning: "opens an information-seeking turn without claiming transition authority",
    allowed_producer_roles: ["any_participating_role"],
    expected_consumer_roles: ["information_owner", "supervisory_role", "reviewer"],
    consumer_follow_up_action_id: "answer_question",
    preconditions: ["clarification or missing information is actually needed"],
    completion_conditions: [
      "the visible body contains a concrete question",
      "the target can identify what answer is being requested",
    ],
    routing_rules: [
      "send the question to the information owner or relevant observer",
      "keep the thread open until an answer is supplied",
    ],
    required_input_fields: ["visible body text", "question target or owner", "topic or reference"],
    output_shape: [
      "visible question body",
      "structured payload with question metadata and target",
      "routing metadata that preserves the open thread",
    ],
    body_visibility_requirements: [
      "the body must contain the question itself and its immediate context",
      "payload-only clarification is not sufficient",
    ],
    runtime_state_effects: [
      "mark clarification as pending",
      "retain the open question state for the thread",
    ],
    artifact_effects: ["creates a clarification thread record only"],
    invalid_cases: ["no actual question is present", "no target is identified", "stage prohibits clarification"],
    idempotency_rules: ["duplicate question delivery maps to the same open clarification", "no additional state change is created for a stale repeat"],
  }),
  createActionModuleContract({
    action_id: "answer_question",
    title: "Answer Question",
    intent: "provide requested clarification",
    semantic_meaning: "satisfies an open clarification turn without changing workflow authority on its own",
    allowed_producer_roles: ["information_owner", "supervisory_role", "reviewer", "authorized_peer"],
    expected_consumer_roles: ["questioning_role"],
    consumer_follow_up_action_id: null,
    preconditions: ["an open question exists and the producer can answer it"],
    completion_conditions: [
      "the visible body provides a direct clarification",
      "the answer can be tied back to the original question or thread",
    ],
    routing_rules: [
      "send the answer back to the question asker",
      "include observers only when the stage contract requires visibility",
    ],
    required_input_fields: ["visible body text", "question reference or thread", "supporting context if needed"],
    output_shape: [
      "visible answer body",
      "structured payload with the answer and references",
      "routing metadata linked to the open question",
    ],
    body_visibility_requirements: [
      "the body must contain the answer and not only a payload reference",
      "the answer body should be readable without inspecting structured data",
    ],
    runtime_state_effects: [
      "clear the pending question state when the answer resolves it",
      "record the answer against the original clarification turn",
    ],
    artifact_effects: ["updates the clarification record without creating a new workflow artifact"],
    invalid_cases: ["missing question reference", "unrelated producer", "duplicate stale answer"],
    idempotency_rules: ["repeated answer content normalizes to one response", "a stale repeat does not reopen or alter authority"],
  }),
  createActionModuleContract({
    action_id: "submit_artifact",
    title: "Submit Artifact",
    intent: "publish a concrete deliverable",
    semantic_meaning: "introduces or updates an artifact for downstream consumption",
    allowed_producer_roles: ["authorized_stage_owner", "authorized_peer"],
    expected_consumer_roles: ["reviewer", "downstream_consumer", "supervisory_role"],
    consumer_follow_up_action_id: "review_artifact",
    preconditions: ["a deliverable exists and the producer is authorized to publish it"],
    completion_conditions: [
      "the visible body summarizes the deliverable",
      "the structured payload identifies the artifact and its revision",
    ],
    routing_rules: [
      "send the submission to reviewers and downstream consumers",
      "make supervisory visibility available when the stage contract requires oversight",
    ],
    required_input_fields: ["visible body text", "artifact payload or reference", "artifact version or revision"],
    output_shape: [
      "visible submission summary",
      "structured payload with artifact content, reference, and version",
      "routing metadata for review and handoff",
    ],
    body_visibility_requirements: [
      "the body must summarize the deliverable and its key changes",
      "payload-only artifact publication is not sufficient",
    ],
    runtime_state_effects: [
      "store the latest submitted artifact and revision marker",
      "refresh the current submission state for the thread",
    ],
    artifact_effects: ["creates or updates the artifact record"],
    invalid_cases: ["missing artifact body or payload", "unauthorized producer", "stale duplicate submission"],
    idempotency_rules: ["repeat delivery of the same artifact revision deduplicates safely", "a stale repeat does not replace a newer accepted submission"],
  }),
  createActionModuleContract({
    action_id: "review_artifact",
    title: "Review Artifact",
    intent: "evaluate a submitted artifact",
    semantic_meaning: "records review findings against the current submission",
    allowed_producer_roles: ["reviewer", "authorized_supervisory_role"],
    expected_consumer_roles: ["artifact_producer", "supervisory_role"],
    consumer_follow_up_action_id: null,
    preconditions: ["a submission exists and the reviewer is authorized"],
    completion_conditions: [
      "the visible body contains findings or approval language",
      "the review outcome can be tied to the submitted artifact",
    ],
    routing_rules: [
      "send findings to the artifact producer",
      "include supervisory observers when the stage contract requires review visibility",
    ],
    required_input_fields: ["visible body text", "reviewed artifact reference", "review outcome or findings"],
    output_shape: [
      "visible review body",
      "structured payload with findings, status, and references",
      "routing metadata attached to the submission under review",
    ],
    body_visibility_requirements: [
      "the body must contain the review findings and conclusion",
      "payload-only review output is not sufficient",
    ],
    runtime_state_effects: [
      "attach review findings to the current submission",
      "update the review status for the thread",
    ],
    artifact_effects: ["creates a review record against the artifact"],
    invalid_cases: ["no artifact to review", "reviewer is not authorized", "duplicate review on a stale revision"],
    idempotency_rules: ["the same review on the same revision resolves to one auditable review record", "stale duplicates do not change the accepted review state"],
  }),
  createActionModuleContract({
    action_id: "request_rework",
    title: "Request Rework",
    intent: "require correction or redo after review",
    semantic_meaning: "returns a reviewed submission to the producer for correction",
    allowed_producer_roles: ["reviewer", "authorized_supervisory_role"],
    expected_consumer_roles: ["artifact_producer"],
    consumer_follow_up_action_id: "resubmit_artifact",
    preconditions: ["a review has identified changes that must be made"],
    completion_conditions: [
      "the visible body names what must change",
      "the request is tied to the reviewed artifact or review findings",
    ],
    routing_rules: [
      "route the correction request back to the artifact producer",
      "preserve observer visibility where the stage contract requires it",
    ],
    required_input_fields: ["visible body text", "referenced review findings", "target artifact"],
    output_shape: [
      "visible request body",
      "structured payload with requested changes and references",
      "routing metadata tied to the reviewed artifact",
    ],
    body_visibility_requirements: [
      "the body must contain the correction request and rationale",
      "the producer should not need payload inspection to understand the rework",
    ],
    runtime_state_effects: [
      "mark the artifact as needing rework",
      "reopen correction state for the current submission",
    ],
    artifact_effects: ["creates a correction request record"],
    invalid_cases: ["no reviewed artifact exists", "the request is not grounded in review findings", "unauthorized producer"],
    idempotency_rules: ["repeated identical rework requests merge into one correction record", "stale repeats do not create extra correction cycles"],
  }),
  createActionModuleContract({
    action_id: "resubmit_artifact",
    title: "Resubmit Artifact",
    intent: "submit a corrected replacement",
    semantic_meaning: "supersedes the prior reviewed artifact with a revised submission",
    allowed_producer_roles: ["artifact_producer"],
    expected_consumer_roles: ["reviewer", "supervisory_role"],
    consumer_follow_up_action_id: null,
    preconditions: ["a correction request exists and a revised artifact is ready"],
    completion_conditions: [
      "the visible body states what changed",
      "the replacement artifact can be linked to the prior submission",
    ],
    routing_rules: [
      "send the resubmission to reviewers",
      "keep supervisory visibility for the revision trail",
    ],
    required_input_fields: ["visible body text", "replacement artifact", "prior artifact reference"],
    output_shape: [
      "visible resubmission body",
      "structured payload with revision metadata and references",
      "routing metadata for the reviewer",
    ],
    body_visibility_requirements: [
      "the body must summarize the correction and mention the replacement",
      "payload-only replacement details are not sufficient",
    ],
    runtime_state_effects: [
      "supersede the prior artifact version",
      "update the revision state for the current thread",
    ],
    artifact_effects: ["replaces the prior artifact revision"],
    invalid_cases: ["no prior artifact exists", "producer is not the original owner", "stale resubmission after a newer accepted revision"],
    idempotency_rules: ["repeated identical resubmission resolves to the same revision marker", "stale repeats do not overwrite an accepted newer revision"],
  }),
  createActionModuleContract({
    action_id: "escalate_blocker",
    title: "Escalate Blocker",
    intent: "surface a blocking issue for intervention",
    semantic_meaning: "requests supervisory or cross-role help because normal execution cannot proceed",
    allowed_producer_roles: ["current_stage_owner", "reviewer", "authorized_peer"],
    expected_consumer_roles: ["supervisory_role", "decision_owner"],
    consumer_follow_up_action_id: "request_decision",
    preconditions: ["execution cannot proceed without help", "the blocker is material enough to warrant intervention"],
    completion_conditions: [
      "the visible body describes the blocker and the requested intervention",
      "the receiving role can tell why normal execution is paused",
    ],
    routing_rules: [
      "send the escalation to the supervisory or decision path",
      "keep observers informed when the stage contract requires visibility",
    ],
    required_input_fields: ["visible body text", "blocker description", "requested help or intervention"],
    output_shape: [
      "visible blocker body",
      "structured payload with blocker details and context",
      "routing metadata for the supervisory path",
    ],
    body_visibility_requirements: [
      "the body must describe the blocker and the ask",
      "payload-only escalation is not sufficient",
    ],
    runtime_state_effects: [
      "record the blocker against the current thread",
      "pause affected state until the blocker is resolved",
    ],
    artifact_effects: ["creates a blocker record"],
    invalid_cases: ["no actual blocker exists", "unsupported producer", "duplicate escalation for the same unresolved blocker"],
    idempotency_rules: ["repeated blocker delivery updates the same blocker record", "a stale repeat does not spawn a second escalation"],
  }),
  createActionModuleContract({
    action_id: "request_decision",
    title: "Request Decision",
    intent: "ask the decision owner to resolve an open choice",
    semantic_meaning: "explicitly requests a decision rather than silently assuming authority",
    allowed_producer_roles: ["current_stage_owner", "reviewer", "authorized_peer"],
    expected_consumer_roles: ["decision_owner", "supervisory_role"],
    consumer_follow_up_action_id: "close_or_handoff",
    preconditions: ["a choice is blocked on authority", "the available options are known enough to frame the request"],
    completion_conditions: [
      "the visible body names the decision needed",
      "the body explains the options or tradeoff being presented",
    ],
    routing_rules: [
      "send the request to the decision owner",
      "keep supervisory visibility on the decision thread",
    ],
    required_input_fields: ["visible body text", "decision question or tradeoff", "reference to the blocked work"],
    output_shape: [
      "visible decision request body",
      "structured payload with options and context",
      "routing metadata for the authority holder",
    ],
    body_visibility_requirements: [
      "the body must state the decision question and why it matters",
      "the body must not hide the decision in payload-only fields",
    ],
    runtime_state_effects: [
      "mark the decision as pending",
      "preserve the unresolved state for the blocked thread",
    ],
    artifact_effects: ["creates a decision request record"],
    invalid_cases: ["no actual decision is needed", "unauthorized producer", "repeated request after a decision is already recorded"],
    idempotency_rules: ["repeated identical decision requests collapse into one pending decision thread", "a stale repeat does not reopen a closed decision"],
  }),
  createActionModuleContract({
    action_id: "close_or_handoff",
    title: "Close Or Handoff",
    intent: "authoritatively close the current stage or hand off to the next role",
    semantic_meaning: "records the transition point or stage-complete handoff",
    allowed_producer_roles: ["supervisory_role", "authorized_stage_owner"],
    expected_consumer_roles: ["next_stage_owner", "all_observers"],
    consumer_follow_up_action_id: null,
    preconditions: ["close conditions are satisfied or a handoff target is known"],
    completion_conditions: [
      "the visible body states closure or handoff",
      "the next owner or terminal state is explicit when one exists",
    ],
    routing_rules: [
      "deliver to the next stage owner and all observers",
      "retain supervisory visibility for the transition record",
    ],
    required_input_fields: ["visible body text", "close or handoff summary", "target stage or terminal status"],
    output_shape: [
      "visible closure or handoff body",
      "structured payload with the final state and target",
      "routing metadata for observers and the next owner",
    ],
    body_visibility_requirements: [
      "the body must explicitly state closure or handoff",
      "the body must not rely on a hidden payload flag alone",
    ],
    runtime_state_effects: [
      "mark the stage complete",
      "update the handoff target or terminal state for the thread",
    ],
    artifact_effects: ["creates a stage completion or handoff record"],
    invalid_cases: ["stage is not complete", "missing handoff target when one is required", "unauthorized closure"],
    idempotency_rules: ["repeated identical close or handoff normalizes to the same final state", "a stale repeat does not reopen the completed stage"],
  }),
]);

function cloneActionModuleContract(item) {
  return {
    ...item,
    allowed_producer_roles: [...item.allowed_producer_roles],
    expected_consumer_roles: [...item.expected_consumer_roles],
    consumer_follow_up_action_id: item.consumer_follow_up_action_id || null,
    preconditions: [...item.preconditions],
    completion_conditions: [...item.completion_conditions],
    routing_rules: [...item.routing_rules],
    required_context_mount: [...item.required_context_mount],
    required_input_fields: [...item.required_input_fields],
    output_shape: [...item.output_shape],
    body_visibility_requirements: [...item.body_visibility_requirements],
    runtime_state_effects: [...item.runtime_state_effects],
    artifact_effects: [...item.artifact_effects],
    invalid_cases: [...item.invalid_cases],
    suppression_behavior: [...item.suppression_behavior],
    observability_requirements: [...item.observability_requirements],
    idempotency_rules: [...item.idempotency_rules],
  };
}

const ACTION_MODULE_MAP = new Map(ACTION_MODULES.map((item) => [item.action_id, Object.freeze(cloneActionModuleContract(item))]));

function payloadLooksArtifactLike(payload) {
  const source = dictValue(payload);
  if (!Object.keys(source).length) {
    return false;
  }
  if (hasMeaningfulValue(source.evidence_refs) || hasMeaningfulValue(source.artifact_refs)) {
    return true;
  }
  return [
    "sections",
    "items",
    "materials",
    "candidate_materials",
    "material_pool",
    "draft",
    "body_markdown",
    "report_markdown",
    "product_body",
    "report",
    "summary",
    "final_summary",
  ].some((key) => hasMeaningfulValue(source[key]));
}

function payloadLooksReviewLike(payload) {
  const source = dictValue(payload);
  return [
    "findings",
    "feedback",
    "issues",
    "review_notes",
    "approved_items",
    "rejected_items",
    "section_reviews",
    "correction_request",
  ].some((key) => hasMeaningfulValue(source[key]));
}

function payloadLooksDecisionLike(payload) {
  const source = dictValue(payload);
  return ["decision", "stage_decision", "release_decision", "forced_proceed", "risk_note"].some((key) =>
    hasMeaningfulValue(source[key]),
  );
}

function inferActionModuleId(message = {}) {
  const payload = dictValue(message.content?.payload);
  const statusBlock = dictValue(message.status_block);
  const text = String(message.content?.text || "").trim().toLowerCase();
  const flowType = normalizedToken(message.flow_type);
  const messageType = normalizedToken(message.message_type);
  const targetAgentId = firstNonEmpty(message.routing?.target?.agent_id);

  if (messageType === "question") {
    return "ask_question";
  }
  if (messageType === "review") {
    return hasMeaningfulValue(payload.correction_request) || hasMeaningfulValue(payload.rejected_items)
      ? "request_rework"
      : "review_artifact";
  }
  if (messageType === "handoff") {
    return "close_or_handoff";
  }
  if (messageType === "decision" || payloadLooksDecisionLike(payload)) {
    return "close_or_handoff";
  }
  if (flowType === "result" && firstNonEmpty(statusBlock.step_status)) {
    return "close_or_handoff";
  }
  if (payloadLooksArtifactLike(payload)) {
    if (
      hasMeaningfulValue(payload.revision_of) ||
      hasMeaningfulValue(payload.resubmission_of) ||
      /(resubmit|resubmission|revised|corrected|updated submission)/.test(text)
    ) {
      return "resubmit_artifact";
    }
    return "submit_artifact";
  }
  if (/(blocker|blocked|cannot proceed|stuck|escalat)/.test(text)) {
    return "escalate_blocker";
  }
  if (/(decision needed|need a decision|approve|reject|choose between)/.test(text)) {
    return "request_decision";
  }
  if (targetAgentId && /(decline|cannot take|can't take|unable to take|acknowledge|understood|accepted)/.test(text)) {
    return "acknowledge_or_decline";
  }
  if (targetAgentId && /(please|handle|review|process|follow up|take this task|own this)/.test(text)) {
    return "assign_task";
  }
  if (firstNonEmpty(message.relations?.parent_message_id) && !payloadLooksReviewLike(payload) && text) {
    return "answer_question";
  }
  return null;
}

export function normalizeActionModuleId(value) {
  const normalized = normalizedToken(value);
  return ACTION_MODULE_MAP.has(normalized) ? normalized : null;
}

export function getActionModule(actionId) {
  const normalized = normalizeActionModuleId(actionId);
  return normalized ? ACTION_MODULE_MAP.get(normalized) || null : null;
}

export function listActionModules() {
  return ACTION_MODULES.map((item) => cloneActionModuleContract(item));
}

export function actionModuleIds() {
  return ACTION_MODULES.map((item) => item.action_id);
}

export function minimalActionModuleCard() {
  return {
    contract_fields: [...ACTION_MODULE_CONTRACT_FIELDS],
    modules: listActionModules(),
  };
}

export function buildActionModuleRegistryCard() {
  return minimalActionModuleCard();
}

export function normalizeActionModuleEnvelope(message = {}) {
  const content = dictValue(message.content);
  const payload = dictValue(content.payload);
  const extensions = dictValue(message.extensions);
  const custom = dictValue(extensions.custom);
  const explicitActionId = normalizeActionModuleId(
    firstNonEmpty(message.action_id, payload.action_id, custom.action_id, dictValue(message.status_block).action_id),
  );
  const actionId = explicitActionId || inferActionModuleId(message) || null;
  const nextPayload = actionId ? { ...payload, action_id: actionId } : { ...payload };
  const nextCustom = actionId ? { ...custom, action_id: actionId } : { ...custom };
  return {
    action_id: actionId,
    content: {
      ...content,
      payload: nextPayload,
    },
    extensions: {
      ...extensions,
      custom: nextCustom,
    },
  };
}

export function resolveActionModuleReference(message = {}) {
  const normalized = normalizeActionModuleEnvelope(message);
  return {
    action_id: normalized.action_id,
    contract: normalized.action_id ? getActionModule(normalized.action_id) : null,
    content: normalized.content,
    extensions: normalized.extensions,
  };
}
