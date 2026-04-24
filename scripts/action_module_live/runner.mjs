import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRuntimeContext, loadSavedCommunityState, sendCommunityMessage } from "../community_integration.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_SCENARIO_KEYS = Object.freeze([
  "valid_producer_visible_output",
  "expected_consumer_handoff",
  "invalid_producer_suppressed",
  "runtime_state_effect_matches_contract",
]);
const SCENARIO_EVIDENCE_LAYOUT = Object.freeze({
  valid_producer_visible_output: [
    ["context_snapshot", "context/request-context.json"],
    ["session_before", "session/before.json"],
    ["messages_before", "messages/before.json"],
    ["participant_message", "messages/participant-message.json"],
    ["session_after", "session/after.json"],
    ["messages_after", "messages/after.json"],
    ["verdict", "verdict.json"],
  ],
  expected_consumer_handoff: [
    ["context_snapshot", "context/request-context.json"],
    ["session_before", "session/before.json"],
    ["messages_before", "messages/before.json"],
    ["producer_message", "messages/producer-message.json"],
    ["consumer_message", "messages/consumer-message.json"],
    ["session_after", "session/after.json"],
    ["messages_after", "messages/after.json"],
    ["verdict", "verdict.json"],
  ],
  invalid_producer_suppressed: [
    ["context_snapshot", "context/request-context.json"],
    ["session_before", "session/before.json"],
    ["messages_before", "messages/before.json"],
    ["suppression_result", "outcomes/suppression.json"],
    ["session_after", "session/after.json"],
    ["messages_after", "messages/after.json"],
    ["verdict", "verdict.json"],
  ],
  runtime_state_effect_matches_contract: [
    ["context_snapshot", "context/request-context.json"],
    ["session_before", "session/before.json"],
    ["session_after", "session/after.json"],
    ["runtime_diff", "runtime/diff.json"],
    ["messages_before", "messages/before.json"],
    ["messages_after", "messages/after.json"],
    ["verdict", "verdict.json"],
  ],
});

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

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = trimString(value);
    if (normalized) {
      return normalized;
    }
  }
  return "";
}

function dictValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function listValue(value) {
  return Array.isArray(value) ? value : [];
}

function slugify(value) {
  const base = trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "run";
}

function timestampSlug(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function resolvePath(root, targetPath) {
  const normalized = trimString(targetPath);
  if (!normalized) {
    return "";
  }
  return path.isAbsolute(normalized) ? normalized : path.resolve(root, normalized);
}

function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function writeJson(targetPath, value) {
  ensureDir(targetPath);
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(targetPath, value = "") {
  ensureDir(targetPath);
  fs.writeFileSync(targetPath, value);
}

function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function serializeError(error) {
  if (!error) {
    return null;
  }
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || error),
  };
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (options.token) {
    headers["X-Agent-Token"] = options.token;
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body || undefined,
    signal: options.signal || AbortSignal.timeout(options.timeoutMs || 15000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${pathname}: ${text}`);
  }
  if (!response.ok || payload.success === false) {
    throw new Error(`Request failed for ${pathname}: ${payload.message || response.status}`);
  }
  return { url: `${baseUrl}${pathname}`, payload };
}

async function requestJsonCandidates(baseUrl, token, candidates) {
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await requestJson(baseUrl, candidate, { token });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("all request candidates failed");
}

async function safeFetchRuntimeContext(groupId, state) {
  try {
    return {
      source: "fetchRuntimeContext",
      value: await fetchRuntimeContext(groupId, state),
      error: null,
    };
  } catch (error) {
    return {
      source: "fetchRuntimeContext",
      value: {},
      error: serializeError(error),
    };
  }
}

async function safeRequestJsonCandidates(baseUrl, token, candidates) {
  try {
    const result = await requestJsonCandidates(baseUrl, token, candidates);
    return {
      ...result,
      error: null,
    };
  } catch (error) {
    return {
      url: null,
      payload: null,
      error: serializeError(error),
    };
  }
}

function normalizeGroupMessages(payload) {
  const source = dictValue(payload?.data || payload);
  const candidates = [
    source.messages,
    source.items,
    source.data,
    source.entries,
    payload?.messages,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
    if (candidate && typeof candidate === "object") {
      const nested = candidate.messages || candidate.items || candidate.data || candidate.entries;
      if (Array.isArray(nested)) {
        return nested;
      }
    }
  }
  return [];
}

function groupMessagePageInfo(payload) {
  const source = dictValue(payload?.data || payload);
  const messages = normalizeGroupMessages(payload);
  return {
    messages,
    offset: Number(source.offset || 0),
    limit: Number(source.limit || messages.length || 0),
    newest_first: Boolean(source.newest_first),
  };
}

function appendUniqueMessages(target, source) {
  const deduped = Array.isArray(target) ? [...target] : [];
  const seenIds = new Set(deduped.map((message) => messageId(message)).filter(Boolean));
  for (const message of listValue(source)) {
    const id = messageId(message);
    if (id && seenIds.has(id)) {
      continue;
    }
    deduped.push(message);
    if (id) {
      seenIds.add(id);
    }
  }
  return deduped;
}

function normalizeScaffoldManifest(manifest, manifestPath) {
  const source = dictValue(manifest);
  const actions = listValue(source.actions).map((entry) => ({
    action_id: trimString(entry.action_id),
    action_root: trimString(entry.action_root),
    action_manifest: trimString(entry.action_manifest),
    evidence_root: trimString(entry.evidence_root),
    scenario_count: Number(entry.scenario_count || 0),
    scenario_keys: uniqueList(entry.scenario_keys),
  }));
  return {
    version: Number(source.version || 1),
    scaffold_id: trimString(source.scaffold_id),
    label: source.label ?? null,
    generated_at: source.generated_at || null,
    workspace_root: source.workspace_root || null,
    output_root: source.output_root || null,
    spec_source: source.spec_source || null,
    manifest_path: manifestPath,
    actions,
  };
}

function normalizeParticipantSpec(raw) {
  const source = dictValue(raw);
  const scenarios = listValue(source.scenarios);
  const participants = listValue(source.participants);
  if (scenarios.length) {
    return {
      validation_id: trimString(source.validation_id || source.validationId),
      label: trimString(source.label),
      group_id: trimString(source.group_id || source.groupId),
      scenario_specs: scenarios.map((scenario, index) => normalizeScenarioSpec(scenario, index)),
      raw: source,
    };
  }

  const grouped = new Map();
  for (const [index, participant] of participants.entries()) {
    const normalized = normalizeParticipant(participant, index);
    const scenarioKey = firstNonEmpty(
      participant?.scenario_key,
      participant?.scenarioKey,
      normalized.scenario_key,
      DEFAULT_SCENARIO_KEYS[0],
    );
    if (!grouped.has(scenarioKey)) {
      grouped.set(scenarioKey, {
        scenario_key: scenarioKey,
        action_id: firstNonEmpty(participant?.action_id, participant?.actionId, normalized.action_id),
        participants: [],
      });
    }
    const scenario = grouped.get(scenarioKey);
    if (!scenario.action_id) {
      scenario.action_id = firstNonEmpty(participant?.action_id, participant?.actionId, normalized.action_id);
    }
    scenario.participants.push(normalized);
  }
  return {
    validation_id: trimString(source.validation_id || source.validationId),
    label: trimString(source.label),
    group_id: trimString(source.group_id || source.groupId),
    scenario_specs: [...grouped.values()].map((entry, index) => normalizeScenarioSpec(entry, index)),
    raw: source,
  };
}

function normalizeScenarioSpec(raw, index = 0) {
  const source = dictValue(raw);
  const participants = listValue(source.participants).map((participant, participantIndex) =>
    normalizeParticipant(participant, participantIndex),
  );
  return {
    scenario_key: firstNonEmpty(source.scenario_key, source.scenarioKey, DEFAULT_SCENARIO_KEYS[index]) || DEFAULT_SCENARIO_KEYS[0],
    action_id: trimString(source.action_id || source.actionId),
    runtime_assertions: dictValue(source.runtime_assertions || source.runtimeAssertions),
    participants,
  };
}

function normalizeParticipant(raw, index = 0) {
  const source = dictValue(raw);
  const state = dictValue(source.state);
  const content = dictValue(state.content || source.content);
  const payload = dictValue(content.payload || state.payload || source.payload);
  const routing = dictValue(state.routing || source.routing);
  const relations = dictValue(state.relations || source.relations);
  const extensions = dictValue(state.extensions || source.extensions);
  const actionId = firstNonEmpty(source.action_id, source.actionId, state.action_id, state.actionId);
  const shouldSend =
    source.should_send ?? source.shouldSend ?? state.should_send ?? state.shouldSend ?? state.send ?? source.send;
  const scenarioKey = firstNonEmpty(source.scenario_key, source.scenarioKey, state.scenario_key, state.scenarioKey);
  const messageText = firstNonEmpty(content.text, state.text, source.text, source.body);
  const messageType = firstNonEmpty(state.message_type, source.message_type, "analysis");
  const flowType = firstNonEmpty(state.flow_type, source.flow_type, "run");
  const targetAgentId = firstNonEmpty(
    state.target_agent_id,
    routing.target?.agent_id,
    source.target_agent_id,
    payload.target_agent_id,
  );
  const targetAgent = firstNonEmpty(
    state.target_agent,
    routing.target?.agent_label,
    source.target_agent,
    payload.target_agent,
  );
  return {
    participant_id: firstNonEmpty(source.participant_id, source.participantId, state.participant_id, state.participantId, `participant-${index + 1}`),
    role: firstNonEmpty(source.role, state.role),
    agent_id: firstNonEmpty(source.agent_id, source.agentId, state.agent_id, state.agentId),
    workspace_root: firstNonEmpty(source.workspace_root, source.workspaceRoot, state.workspace_root, state.workspaceRoot),
    state_file: firstNonEmpty(source.state_file, source.stateFile, state.state_file, state.stateFile),
    scenario_key: scenarioKey || null,
    action_id: actionId || null,
    should_send: shouldSend === undefined ? true : boolOption(shouldSend),
    suppression_reason: firstNonEmpty(
      source.suppression_reason,
      source.suppressionReason,
      state.suppression_reason,
      state.suppressionReason,
    ),
    message: {
      flow_type: flowType,
      message_type: messageType,
      content: {
        text: messageText,
        payload,
      },
      routing,
      relations,
      extensions,
      status_block: dictValue(state.status_block || source.status_block),
      context_block: dictValue(state.context_block || source.context_block),
    },
    target_agent_id: targetAgentId || null,
    target_agent: targetAgent || null,
    raw: source,
  };
}

function participantStatePath(participant, workspaceRoot) {
  const explicitStatePath = resolvePath(workspaceRoot, participant.state_file);
  if (explicitStatePath) {
    return explicitStatePath;
  }
  const participantWorkspace = resolvePath(workspaceRoot, participant.workspace_root);
  if (!participantWorkspace) {
    return "";
  }
  return path.join(
    participantWorkspace,
    ".openclaw",
    "community-agent-template",
    "state",
    "community-webhook-state.json",
  );
}

function resolveParticipantState(participant, workspaceRoot, fallbackState) {
  const loaded = loadJson(participantStatePath(participant, workspaceRoot), {}) || {};
  return {
    ...fallbackState,
    ...loaded,
    ...(participant.agent_id ? { agentId: participant.agent_id } : {}),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = stableValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function diffKeys(before, after, prefix = "") {
  const beforeValue = dictValue(before);
  const afterValue = dictValue(after);
  const keys = new Set([...Object.keys(beforeValue), ...Object.keys(afterValue)]);
  const added = [];
  const removed = [];
  const changed = [];
  for (const key of keys) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    const hasBefore = Object.prototype.hasOwnProperty.call(beforeValue, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(afterValue, key);
    if (!hasBefore && hasAfter) {
      added.push(pathKey);
      continue;
    }
    if (hasBefore && !hasAfter) {
      removed.push(pathKey);
      continue;
    }
    const beforeItem = beforeValue[key];
    const afterItem = afterValue[key];
    if (beforeItem && afterItem && typeof beforeItem === "object" && typeof afterItem === "object" && !Array.isArray(beforeItem) && !Array.isArray(afterItem)) {
      const nested = diffKeys(beforeItem, afterItem, pathKey);
      added.push(...nested.added);
      removed.push(...nested.removed);
      changed.push(...nested.changed);
      continue;
    }
    if (JSON.stringify(stableValue(beforeItem)) !== JSON.stringify(stableValue(afterItem))) {
      changed.push(pathKey);
    }
  }
  return { added, removed, changed };
}

function evaluateScenarioKey(scenarioKey, evidence) {
  const participants = listValue(evidence.participants);
  const sentParticipants = participants.filter((participant) => participant.sent);
  const suppressedParticipants = participants.filter((participant) => participant.suppressed);
  const producerMessages = listValue(evidence.producer_messages);
  const consumerMessages = listValue(evidence.consumer_messages);
  const hasBodyText = producerMessages.some((message) => trimString(dictValue(message.content).text || message.text));
  const hasActionIds = producerMessages.some((message) => trimString(messageActionId(message)));
  const runtimeDiff = dictValue(evidence.runtime_diff);
  const runtimeAssertions = dictValue(evidence.runtime_assertions);
  const changedRuntimePaths = uniqueList([
    ...listValue(runtimeDiff.added),
    ...listValue(runtimeDiff.removed),
    ...listValue(runtimeDiff.changed),
  ]);

  if (scenarioKey === "valid_producer_visible_output") {
    const passed = Boolean(producerMessages.length && hasBodyText && hasActionIds);
    return {
      status: passed ? "pass" : "fail",
      passed,
      checks: [
        {
          check_id: "producer_visible_output",
          passed,
          detail: passed
            ? "producer message was sent with visible body and action_id"
            : "producer message missing or body/action_id not visible",
        },
      ],
    };
  }

  if (scenarioKey === "expected_consumer_handoff") {
    const consumerBodyVisible = consumerMessages.some((message) => trimString(dictValue(message.content).text || message.text));
    const passed = Boolean(producerMessages.length && consumerMessages.length && consumerBodyVisible);
    return {
      status: passed ? "pass" : "fail",
      passed,
      checks: [
        {
          check_id: "producer_handoff",
          passed: Boolean(producerMessages.length),
          detail: producerMessages.length ? "producer message captured" : "missing producer message",
        },
        {
          check_id: "consumer_receipt",
          passed: Boolean(consumerMessages.length && consumerBodyVisible),
          detail:
            consumerMessages.length && consumerBodyVisible
              ? "consumer message captured with visible body"
              : "missing consumer handoff evidence or visible consumer body",
        },
      ],
    };
  }

  if (scenarioKey === "invalid_producer_suppressed") {
    const passed = Boolean(suppressedParticipants.length) && sentParticipants.length === 0 && producerMessages.length === 0;
    return {
      status: passed ? "pass" : "fail",
      passed,
      checks: [
        {
          check_id: "suppressed_before_send",
          passed,
          detail: passed ? "invalid producer was suppressed without sending" : "invalid producer was not suppressed cleanly",
        },
      ],
    };
  }

  if (scenarioKey === "runtime_state_effect_matches_contract") {
    const requiredChangedPaths = uniqueList(runtimeAssertions.required_changed_paths);
    const forbiddenChangedPaths = uniqueList(runtimeAssertions.forbidden_changed_paths);
    const missingRequired = requiredChangedPaths.filter((pathKey) => !changedRuntimePaths.includes(pathKey));
    const forbiddenHits = forbiddenChangedPaths.filter((pathKey) => changedRuntimePaths.includes(pathKey));
    const passed =
      requiredChangedPaths.length > 0
        ? missingRequired.length === 0 && forbiddenHits.length === 0
        : changedRuntimePaths.length > 0 && forbiddenHits.length === 0;
    return {
      status: passed ? "pass" : "fail",
      passed,
      checks: [
        {
          check_id: "runtime_snapshot_diff",
          passed,
          detail: passed
            ? "runtime snapshot diff matched the declared scenario assertions"
            : [
                changedRuntimePaths.length
                  ? `observed changed paths: ${changedRuntimePaths.join(", ")}`
                  : "no runtime state diff was observed",
                missingRequired.length ? `missing required paths: ${missingRequired.join(", ")}` : "",
                forbiddenHits.length ? `forbidden paths changed: ${forbiddenHits.join(", ")}` : "",
              ]
                .filter(Boolean)
                .join("; "),
        },
      ],
    };
  }

  return {
    status: "unknown",
    passed: null,
    checks: [
      {
        check_id: "unclassified_scenario",
        passed: null,
        detail: `no built-in evaluator for ${scenarioKey}`,
      },
    ],
  };
}

function scenarioEvidenceRoot(actionSlug, scenarioKey) {
  return path.posix.join("actions", actionSlug, "evidence", scenarioKey);
}

function actionOutputRoot(actionSlug) {
  return path.posix.join("actions", actionSlug);
}

function scenarioRunRoot(actionSlug, scenarioKey) {
  return path.posix.join("actions", actionSlug, "scenarios", scenarioKey);
}

function buildEvidenceIndex(actionId, scenarioKey, evidenceSlots, outputRoot) {
  const evidenceRoot = scenarioEvidenceRoot(slugify(actionId), scenarioKey);
  return {
    action_id: actionId,
    scenario_id: `${actionId}::${scenarioKey}`,
    scenario_key: scenarioKey,
    status: "captured",
    required_slots: evidenceSlots.map(([slotId, relativePath]) => ({
      slot_id: slotId,
      evidence_class: slotId,
      relative_path: path.posix.join(evidenceRoot, relativePath),
      required: true,
      capture_stage: null,
    })),
    output_root: outputRoot,
  };
}

function resolveManifestEntry(manifest, actionId) {
  return listValue(manifest.actions).find((entry) => trimString(entry.action_id) === trimString(actionId)) || null;
}

function inferScenarioSpecs(participantSpec, scaffoldManifest) {
  const normalized = normalizeParticipantSpec(participantSpec);
  if (normalized.scenario_specs.length) {
    return normalized;
  }

  const fallbackScenarioSpecs = listValue(scaffoldManifest.actions).flatMap((action) =>
    uniqueList(action.scenario_keys).map((scenarioKey) => ({
      scenario_key: scenarioKey,
      action_id: action.action_id,
      participants: [],
    })),
  );
  return {
    ...normalized,
    scenario_specs: fallbackScenarioSpecs.length ? fallbackScenarioSpecs : [
      {
        scenario_key: DEFAULT_SCENARIO_KEYS[0],
        action_id: listValue(scaffoldManifest.actions)[0]?.action_id || "",
        participants: [],
      },
    ],
  };
}

async function fetchGroupMessages(groupId, state) {
  const baseUrl = String(process.env.COMMUNITY_BASE_URL || "http://127.0.0.1:8000/api/v1").trim().replace(/\/$/, "");
  const token = trimString(state?.token);
  const pagedCandidates = [
    `/messages?group_id=${encodeURIComponent(groupId)}&limit=200`,
    `/messages?groupId=${encodeURIComponent(groupId)}&limit=200`,
  ];
  for (const candidate of pagedCandidates) {
    try {
      let offset = 0;
      let aggregated = null;
      for (let page = 0; page < 50; page += 1) {
        const separator = candidate.includes("?") ? "&" : "?";
        const result = await requestJson(baseUrl, `${candidate}${separator}offset=${offset}`, { token });
        const pageInfo = groupMessagePageInfo(result.payload);
        if (!pageInfo.messages.length) {
          break;
        }
        aggregated = {
          source: result.url,
          payload: result.payload,
          messages: appendUniqueMessages(aggregated?.messages, pageInfo.messages),
        };
        if (pageInfo.newest_first || pageInfo.messages.length < Math.max(1, pageInfo.limit)) {
          break;
        }
        offset += Math.max(1, pageInfo.limit || pageInfo.messages.length);
      }
      if (aggregated) {
        return aggregated;
      }
    } catch {
      // Try the next paged endpoint.
    }
  }
  const candidates = [
    `/groups/${encodeURIComponent(groupId)}/messages`,
    `/groups/${encodeURIComponent(groupId)}/messages?limit=200`,
  ];
  for (const candidate of candidates) {
    try {
      const result = await requestJson(baseUrl, candidate, { token });
      return {
        source: result.url,
        payload: result.payload,
        messages: normalizeGroupMessages(result.payload),
      };
    } catch {
      // Try the next endpoint.
    }
  }
  return {
    source: null,
    payload: null,
    messages: [],
  };
}

function messageId(message) {
  return trimString(message?.id || message?.message_id || message?.community_message_id);
}

function messageAuthorId(message) {
  return firstNonEmpty(
    message?.author?.agent_id,
    message?.author_agent_id,
    message?.agent_id,
  );
}

function messageActionId(message) {
  return firstNonEmpty(
    message?.action_id,
    dictValue(message?.content).payload?.action_id,
    dictValue(dictValue(message?.extensions).custom).action_id,
  );
}

function messageScenarioKey(message) {
  return firstNonEmpty(
    dictValue(dictValue(message?.extensions).custom).scenario_key,
    dictValue(dictValue(message?.content).payload).scenario_key,
  );
}

function messageParticipantId(message) {
  return firstNonEmpty(
    dictValue(dictValue(message?.extensions).custom).participant_id,
    dictValue(dictValue(message?.content).payload).participant_id,
  );
}

function newMessages(messagesBefore, messagesAfter) {
  const knownIds = new Set(listValue(messagesBefore).map((message) => messageId(message)).filter(Boolean));
  return listValue(messagesAfter).filter((message) => {
    const id = messageId(message);
    return !id || !knownIds.has(id);
  });
}

function matchScenarioMessages(messages, { actionId, actionIds = [], scenarioKey, participantIds = [], agentIds = [], allowMissingScenarioKey = false }) {
  const participantIdSet = new Set(uniqueList(participantIds));
  const agentIdSet = new Set(uniqueList(agentIds));
  const actionIdSet = new Set(uniqueList(actionIds.length ? actionIds : [actionId]));
  return listValue(messages).filter((message) => {
    if (actionIdSet.size && !actionIdSet.has(messageActionId(message))) {
      return false;
    }
    if (scenarioKey) {
      const messageScenario = messageScenarioKey(message);
      if (messageScenario) {
        if (messageScenario !== scenarioKey) {
          return false;
        }
      } else if (!allowMissingScenarioKey) {
        return false;
      }
    }
    const participantId = messageParticipantId(message);
    if (participantIdSet.size && participantIdSet.has(participantId)) {
      return true;
    }
    const authorId = messageAuthorId(message);
    return agentIdSet.size ? agentIdSet.has(authorId) : true;
  });
}

async function pollScenarioMessages({
  groupId,
  state,
  messagesBefore,
  actionId,
  actionIds,
  scenarioKey,
  participantIds,
  agentIds,
  allowMissingScenarioKey = false,
  minCount = 1,
  timeoutMs = 15000,
  pollIntervalMs = 1500,
}) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let lastMessages = [];
  let lastPayload = { source: null, payload: null, messages: [] };
  while (Date.now() <= deadline) {
    lastPayload = await fetchGroupMessages(groupId, state);
    lastMessages = matchScenarioMessages(
      newMessages(messagesBefore, lastPayload.messages),
      { actionId, actionIds, scenarioKey, participantIds, agentIds, allowMissingScenarioKey },
    );
    if (lastMessages.length >= minCount) {
      return { matched: lastMessages, snapshot: lastPayload };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return { matched: lastMessages, snapshot: lastPayload };
}

function scenarioPlanFor(actionId, scenarioKey, scaffoldManifest, actionManifestPath, evidenceRoot) {
  const actionEntry = resolveManifestEntry(scaffoldManifest, actionId);
  const scenarioPlanPath = path.join(path.dirname(actionManifestPath), "scenarios", `${scenarioKey}.json`);
  return {
    action_id: actionId,
    scenario_id: `${actionId}::${scenarioKey}`,
    scenario_key: scenarioKey,
    action_manifest: actionManifestPath,
    scenario_plan_source: scenarioPlanPath,
    evidence_root: evidenceRoot,
    scenario_count: actionEntry?.scenario_count || null,
    scenario_keys: actionEntry?.scenario_keys || [],
  };
}

function scenarioEvidenceLayoutFor(scenarioKey) {
  return SCENARIO_EVIDENCE_LAYOUT[scenarioKey] || [
    ["context_snapshot", "context/request-context.json"],
    ["session_before", "session/before.json"],
    ["session_after", "session/after.json"],
    ["messages_before", "messages/before.json"],
    ["messages_after", "messages/after.json"],
    ["verdict", "verdict.json"],
  ];
}

function makeMessageRequest(participant, scenarioKey, actionId, groupId) {
  const message = participant.message || {};
  const content = dictValue(message.content);
  const payload = {
    ...dictValue(content.payload),
    action_id: firstNonEmpty(participant.action_id, actionId, content.payload?.action_id),
    scenario_key: scenarioKey,
    participant_id: participant.participant_id,
  };
  const routing = dictValue(message.routing);
  const existingTarget = dictValue(routing.target);
  const targetAgentId = firstNonEmpty(participant.target_agent_id, existingTarget.agent_id);
  const targetAgent = firstNonEmpty(participant.target_agent, existingTarget.agent_label);
  return {
    group_id: groupId,
    flow_type: firstNonEmpty(message.flow_type, "run"),
    message_type: firstNonEmpty(message.message_type, "analysis"),
    action_id: firstNonEmpty(participant.action_id, actionId),
    content: {
      text: firstNonEmpty(content.text),
      payload,
    },
    routing: {
      ...routing,
      target: {
        ...existingTarget,
        ...(targetAgentId ? { agent_id: targetAgentId } : {}),
        ...(targetAgent ? { agent_label: targetAgent } : {}),
      },
    },
    relations: dictValue(message.relations),
    extensions: {
      ...dictValue(message.extensions),
      custom: {
        ...dictValue(dictValue(message.extensions).custom),
        scenario_key: scenarioKey,
        participant_id: participant.participant_id,
      },
    },
    status_block: dictValue(message.status_block),
    context_block: dictValue(message.context_block),
  };
}

function participantShouldEmit(participant, scenarioKey) {
  if (scenarioKey === "expected_consumer_handoff" && trimString(participant.role).toLowerCase() === "consumer") {
    return false;
  }
  return Boolean(participant.should_send);
}

async function executeParticipant(participant, scenarioKey, actionId, groupId, state, workspaceRoot) {
  if (!participantShouldEmit(participant, scenarioKey)) {
    return {
      participant,
      suppressed: true,
      sent: false,
      reason: participant.suppression_reason || "participant_not_emitted_by_scenario",
      request: null,
      result: null,
    };
  }
  const request = makeMessageRequest(participant, scenarioKey, actionId, groupId);
  const participantState = resolveParticipantState(participant, workspaceRoot, state);
  try {
    const result = await sendCommunityMessage(participantState, null, request);
    return {
      participant,
      suppressed: false,
      sent: true,
      reason: null,
      request,
      result,
      state: {
        agentId: participantState.agentId || null,
        groupId: participantState.groupId || null,
      },
      error: null,
    };
  } catch (error) {
    return {
      participant,
      suppressed: false,
      sent: false,
      reason: "participant_send_failed",
      request,
      result: null,
      state: {
        agentId: participantState.agentId || null,
        groupId: participantState.groupId || null,
      },
      error: serializeError(error),
    };
  }
}

function buildScenarioVerdict({
  actionId,
  scenarioKey,
  participants,
  producerMessages,
  consumerMessages,
  contextBefore,
  contextAfter,
  sessionBefore,
  sessionAfter,
  messagesBefore,
  messagesAfter,
  runtimeDiff,
  runtimeAssertions,
}) {
  const evidence = {
    participants,
    producer_messages: producerMessages,
    consumer_messages: consumerMessages,
    context_before: contextBefore,
    context_after: contextAfter,
    session_before: sessionBefore,
    session_after: sessionAfter,
    messages_before: messagesBefore,
    messages_after: messagesAfter,
    runtime_diff: runtimeDiff,
    runtime_assertions: runtimeAssertions,
  };
  const evaluator = evaluateScenarioKey(scenarioKey, evidence);
  return {
    version: 1,
    action_id: actionId,
    scenario_key: scenarioKey,
    scenario_id: `${actionId}::${scenarioKey}`,
    evaluated_at: new Date().toISOString(),
    ...evaluator,
    participants: participants.map((participant) => ({
      participant_id: participant.participant.participant_id,
      role: participant.participant.role || null,
      action_id: participant.participant.action_id || null,
      sent: participant.sent,
      suppressed: participant.suppressed,
      should_send: participant.participant.should_send,
      reason: participant.reason,
    })),
    evidence_refs: {
      context_before: "context/request-context.json",
      session_before: "session/before.json",
      session_after: "session/after.json",
      messages_before: "messages/before.json",
      messages_after: "messages/after.json",
      producer_messages: "messages/producer-observed.json",
      consumer_messages: "messages/consumer-observed.json",
      runtime_diff: "runtime/diff.json",
      verdict: "verdict.json",
    },
  };
}

function loadScaffoldActionManifest(actionManifestPath) {
  const manifest = loadJson(actionManifestPath, {});
  if (!manifest || typeof manifest !== "object") {
    return {};
  }
  return manifest;
}

export async function runActionModuleLiveRunnerCommand({ options = {}, workspaceRoot }) {
  const scaffoldManifestPath = resolvePath(workspaceRoot, options.manifest || options["scaffold-manifest"] || options["manifest-path"]);
  if (!scaffoldManifestPath || !fs.existsSync(scaffoldManifestPath)) {
    throw new Error("action-module-live-run requires --manifest <scaffold manifest path>");
  }
  const participantSpecPath = resolvePath(workspaceRoot, options.spec || options["participants-spec"] || options["participant-spec"]);
  if (!participantSpecPath || !fs.existsSync(participantSpecPath)) {
    throw new Error("action-module-live-run requires --spec <participant spec path>");
  }

  const scaffoldManifest = normalizeScaffoldManifest(
    loadJson(scaffoldManifestPath, {}),
    scaffoldManifestPath,
  );
  const participantSpec = inferScenarioSpecs(loadJson(participantSpecPath, {}), scaffoldManifest);
  const savedState = loadSavedCommunityState();
  const state = {
    ...savedState,
    ...(dictValue(loadJson(resolvePath(workspaceRoot, options["state-file"] || options.state_file), {}))),
  };
  const groupId = firstNonEmpty(options["group-id"], options.group_id, participantSpec.group_id, savedState.groupId, savedState.group_id);
  if (!groupId) {
    throw new Error("action-module-live-run requires a group id in --group-id, the spec, or saved community state");
  }
  if (!trimString(state.token)) {
    throw new Error("saved community state must include token before running live action validation");
  }

  const now = new Date();
  const baseUrl = String(process.env.COMMUNITY_BASE_URL || "http://127.0.0.1:8000/api/v1").trim().replace(/\/$/, "");
  const validationId = firstNonEmpty(options["run-id"], options.run_id, participantSpec.validation_id, participantSpec.validationId, `action-module-live-run-${timestampSlug(now)}`);
  const defaultOutputRoot = path.join(workspaceRoot, ".openclaw", "action-module-live", "runs", slugify(validationId));
  const outputRoot = resolvePath(workspaceRoot, options["output-root"] || options.output_root) || defaultOutputRoot;
  const force = boolOption(options.force);
  if (fs.existsSync(outputRoot) && fs.readdirSync(outputRoot).length > 0 && !force) {
    throw new Error(`output root already exists and is not empty: ${outputRoot} (use --force true to reuse it)`);
  }
  fs.mkdirSync(outputRoot, { recursive: true });

  const normalizedActions = listValue(scaffoldManifest.actions).map((actionEntry) => ({
    ...actionEntry,
    action_manifest_path: resolvePath(path.dirname(scaffoldManifestPath), actionEntry.action_manifest),
  }));
  const copiedScaffoldManifestPath = path.join(outputRoot, "input", "scaffold-manifest.json");
  const copiedParticipantSpecPath = path.join(outputRoot, "input", "participants-spec.json");
  writeJson(copiedScaffoldManifestPath, scaffoldManifest);
  writeJson(copiedParticipantSpecPath, participantSpec);

  const runtimeContextBefore = await safeFetchRuntimeContext(groupId, state);
  const scenarioResults = [];
  for (const scenarioSpec of listValue(participantSpec.scenario_specs)) {
    const scenarioKey = firstNonEmpty(scenarioSpec.scenario_key, DEFAULT_SCENARIO_KEYS[0]);
    const actionId = firstNonEmpty(scenarioSpec.action_id, listValue(scaffoldManifest.actions)[0]?.action_id, normalizedActions[0]?.action_id);
    if (!actionId) {
      throw new Error(`scenario ${scenarioKey} does not resolve to an action_id`);
    }
    const actionEntry = resolveManifestEntry(scaffoldManifest, actionId);
    if (!actionEntry) {
      throw new Error(`scenario ${scenarioKey} references unknown action_id ${actionId}`);
    }
    const actionManifestPath = resolvePath(path.dirname(scaffoldManifestPath), actionEntry.action_manifest);
    const actionManifest = loadScaffoldActionManifest(actionManifestPath);
    const actionSlug = slugify(actionId);
    const scenarioRoot = path.join(outputRoot, scenarioRunRoot(actionSlug, scenarioKey));
    const evidenceRoot = path.join(outputRoot, scenarioEvidenceRoot(actionSlug, scenarioKey));
    fs.mkdirSync(scenarioRoot, { recursive: true });
    fs.mkdirSync(evidenceRoot, { recursive: true });

    writeJson(path.join(outputRoot, actionOutputRoot(actionSlug), "action.json"), actionManifest);
    const scenarioPlanSource = path.join(path.dirname(actionManifestPath), "scenarios", `${scenarioKey}.json`);
    const scenarioPlan = loadJson(scenarioPlanSource, null);
    if (scenarioPlan) {
      writeJson(path.join(outputRoot, scenarioRunRoot(actionSlug, scenarioKey), "plan.json"), scenarioPlan);
    }

    const scenarioContextBefore = await safeFetchRuntimeContext(groupId, state);
    const rawContextBefore = await safeRequestJsonCandidates(
      baseUrl,
      state.token,
      [`/groups/${encodeURIComponent(groupId)}/context`],
    );
    const rawSessionBefore = await safeRequestJsonCandidates(
      baseUrl,
      state.token,
      [`/groups/${encodeURIComponent(groupId)}/session`],
    );
    const scenarioMessagesBefore = await fetchGroupMessages(groupId, state);
    const participantOutcomes = [];
    for (const participant of listValue(scenarioSpec.participants)) {
      const outcome = await executeParticipant(participant, scenarioKey, actionId, groupId, state, workspaceRoot);
      participantOutcomes.push(outcome);
      const participantFile = path.join(
        evidenceRoot,
        "messages",
        `${slugify(participant.participant_id)}.json`,
      );
      writeJson(participantFile, {
        participant_id: participant.participant_id,
        scenario_key: scenarioKey,
        action_id: actionId,
        request: outcome.request,
        result: outcome.result,
        suppressed: outcome.suppressed,
        sent: outcome.sent,
        reason: outcome.reason,
        error: outcome.error,
      });
      if (outcome.request?.content?.text) {
        writeText(path.join(evidenceRoot, "messages", `${slugify(participant.participant_id)}.body.txt`), outcome.request.content.text);
      }
    }
    const producerParticipants = listValue(scenarioSpec.participants).filter(
      (participant) => trimString(participant.role).toLowerCase() === "producer",
    );
    const consumerParticipants = listValue(scenarioSpec.participants).filter(
      (participant) => trimString(participant.role).toLowerCase() === "consumer",
    );
    const emittedProducerParticipants = participantOutcomes
      .filter((outcome) => outcome.sent && trimString(outcome.participant.role).toLowerCase() === "producer")
      .map((outcome) => outcome.participant);
    const observedProducer = await pollScenarioMessages({
      groupId,
      state,
      messagesBefore: scenarioMessagesBefore.messages,
      actionId,
      actionIds: producerParticipants.map((participant) => firstNonEmpty(participant.action_id, actionId)),
      scenarioKey,
      participantIds: producerParticipants.map((participant) => participant.participant_id),
      agentIds: producerParticipants.map((participant) => participant.agent_id),
      minCount: emittedProducerParticipants.length > 0 ? 1 : 0,
      timeoutMs: Number(options["settle-timeout-ms"] || options.settle_timeout_ms || 12000),
      pollIntervalMs: Number(options["poll-interval-ms"] || options.poll_interval_ms || 1500),
    });
    const observedConsumer = scenarioKey === "expected_consumer_handoff" && observedProducer.matched.length > 0
        ? await pollScenarioMessages({
          groupId,
          state,
          messagesBefore: scenarioMessagesBefore.messages,
          actionId,
          actionIds: consumerParticipants.map((participant) => firstNonEmpty(participant.action_id, actionId)),
          scenarioKey,
          participantIds: consumerParticipants.map((participant) => participant.participant_id),
          agentIds: consumerParticipants.map((participant) => participant.agent_id),
          minCount: consumerParticipants.length > 0 ? 1 : 0,
          allowMissingScenarioKey: true,
          timeoutMs: Number(options["settle-timeout-ms"] || options.settle_timeout_ms || 12000),
          pollIntervalMs: Number(options["poll-interval-ms"] || options.poll_interval_ms || 1500),
        })
      : { matched: [], snapshot: null };

    const runtimeContextAfter = await safeFetchRuntimeContext(groupId, state);
    const rawContextAfter = await safeRequestJsonCandidates(
      baseUrl,
      state.token,
      [`/groups/${encodeURIComponent(groupId)}/context`],
    );
    const rawSessionAfter = await safeRequestJsonCandidates(
      baseUrl,
      state.token,
      [`/groups/${encodeURIComponent(groupId)}/session`],
    );
    const messagesAfter = await fetchGroupMessages(groupId, state);
    const runtimeDiff = diffKeys(
      rawSessionBefore?.payload?.data || scenarioContextBefore?.value?.runtime_session_card || {},
      rawSessionAfter?.payload?.data || runtimeContextAfter?.value?.runtime_session_card || {},
    );
    const verdict = buildScenarioVerdict({
      actionId,
      scenarioKey,
      participants: participantOutcomes,
      producerMessages: observedProducer.matched,
      consumerMessages: observedConsumer.matched,
      contextBefore: rawContextBefore?.payload || null,
      contextAfter: rawContextAfter?.payload || null,
      sessionBefore: rawSessionBefore?.payload || null,
      sessionAfter: rawSessionAfter?.payload || null,
      messagesBefore: scenarioMessagesBefore.messages,
      messagesAfter: messagesAfter.messages,
      runtimeDiff,
      runtimeAssertions: scenarioSpec.runtime_assertions,
    });

    const evidenceSlots = scenarioEvidenceLayoutFor(scenarioKey);
    const evidenceIndex = buildEvidenceIndex(actionId, scenarioKey, evidenceSlots, outputRoot);
    writeJson(path.join(evidenceRoot, "index.json"), evidenceIndex);
    writeJson(path.join(evidenceRoot, "context", "request-context.json"), {
      source: scenarioContextBefore.source,
      value: scenarioContextBefore.value,
      raw_context: rawContextBefore?.payload || null,
      errors: {
        runtime_context: scenarioContextBefore.error,
        raw_context: rawContextBefore.error,
      },
    });
    writeJson(path.join(evidenceRoot, "session", "before.json"), {
      source: rawSessionBefore?.url || null,
      value: rawSessionBefore?.payload || null,
      runtime_context: scenarioContextBefore?.value?.runtime_session_card || null,
      error: rawSessionBefore.error,
    });
    writeJson(path.join(evidenceRoot, "session", "after.json"), {
      source: rawSessionAfter?.url || null,
      value: rawSessionAfter?.payload || null,
      runtime_context: runtimeContextAfter?.value?.runtime_session_card || null,
      error: rawSessionAfter.error,
    });
    writeJson(path.join(evidenceRoot, "messages", "before.json"), {
      source: scenarioMessagesBefore.source,
      messages: scenarioMessagesBefore.messages,
      raw: scenarioMessagesBefore.payload,
    });
    writeJson(path.join(evidenceRoot, "messages", "after.json"), {
      source: messagesAfter.source,
      messages: messagesAfter.messages,
      raw: messagesAfter.payload,
    });
    writeJson(path.join(evidenceRoot, "messages", "producer-observed.json"), observedProducer.matched);
    writeJson(path.join(evidenceRoot, "messages", "consumer-observed.json"), observedConsumer.matched);
    writeJson(path.join(evidenceRoot, "runtime", "diff.json"), runtimeDiff);
    writeJson(path.join(evidenceRoot, "verdict.json"), verdict);
    writeJson(path.join(evidenceRoot, "outcomes", "suppression.json"), {
      action_id: actionId,
      scenario_key: scenarioKey,
      suppressed_participants: participantOutcomes.filter((item) => item.suppressed).map((item) => item.participant.participant_id),
      sent_participants: participantOutcomes.filter((item) => item.sent).map((item) => item.participant.participant_id),
      verdict: verdict.status,
    });

    scenarioResults.push({
      action_id: actionId,
      scenario_key: scenarioKey,
      scenario_id: `${actionId}::${scenarioKey}`,
      action_manifest: path.join(outputRoot, actionOutputRoot(actionSlug), "action.json"),
      scenario_plan: scenarioPlanSource,
      scenario_root: scenarioRoot,
      evidence_root: evidenceRoot,
      evidence_index: path.join(evidenceRoot, "index.json"),
      verdict: path.join(evidenceRoot, "verdict.json"),
      participant_count: participantOutcomes.length,
      verdict_status: verdict.status,
    });
  }

  const manifest = {
    version: 1,
    run_id: validationId,
    label: participantSpec.label || null,
    generated_at: new Date().toISOString(),
    workspace_root: workspaceRoot,
    output_root: outputRoot,
    scaffold_manifest: scaffoldManifestPath,
    participant_spec: participantSpecPath,
    group_id: groupId,
    action_count: normalizedActions.length,
    scenario_count: scenarioResults.length,
    actions: normalizedActions.map((actionEntry) => ({
      action_id: actionEntry.action_id,
      action_root: actionOutputRoot(slugify(actionEntry.action_id)),
      action_manifest: path.join("actions", slugify(actionEntry.action_id), "action.json"),
      evidence_root: path.join("actions", slugify(actionEntry.action_id), "evidence"),
      scenario_count: uniqueList(actionEntry.scenario_keys).length,
      scenario_keys: uniqueList(actionEntry.scenario_keys),
    })),
    scenarios: scenarioResults.map((scenario) => ({
      action_id: scenario.action_id,
      scenario_id: scenario.scenario_id,
      scenario_key: scenario.scenario_key,
      verdict_status: scenario.verdict_status,
      evidence_root: path.relative(outputRoot, scenario.evidence_root),
      verdict: path.relative(outputRoot, scenario.verdict),
    })),
  };

  const manifestPath = path.join(outputRoot, "manifest.json");
  writeJson(manifestPath, manifest);

  return {
    ok: true,
    mode: "runner",
    run_id: validationId,
    output_root: outputRoot,
    manifest_path: manifestPath,
    scaffold_manifest: scaffoldManifestPath,
    participant_spec: participantSpecPath,
    group_id: groupId,
    action_count: normalizedActions.length,
    scenario_count: scenarioResults.length,
    scenarios: scenarioResults,
  };
}

export const ACTION_MODULE_LIVE_RUNNER_SCENARIOS = Object.freeze([...DEFAULT_SCENARIO_KEYS]);
