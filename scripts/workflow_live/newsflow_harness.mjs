import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBoundNewsflowGroupProtocol, buildNewsflowWorkflowSpec, NEWSFLOW_STOP_STAGE } from "./newsflow_protocol.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, "..", "..");

const DEFAULT_BASE_URL = String(process.env.COMMUNITY_BASE_URL || "http://43.130.233.109:8000/api/v1").replace(/\/$/, "");
const DEFAULT_STAGE_TIMEOUT_MS = Number(process.env.NEWSFLOW_WORKFLOW_STAGE_TIMEOUT_MS || 180000);
const DEFAULT_POLL_INTERVAL_MS = Number(process.env.NEWSFLOW_WORKFLOW_POLL_INTERVAL_MS || 5000);
const DEFAULT_REQUEST_RETRY_COUNT = Number(process.env.NEWSFLOW_WORKFLOW_REQUEST_RETRY_COUNT || 3);
const DEFAULT_REQUEST_RETRY_BACKOFF_MS = Number(process.env.NEWSFLOW_WORKFLOW_REQUEST_RETRY_BACKOFF_MS || 1000);

const ROLE_STATE_PATHS = Object.freeze({
  manager: "/root/openclaw-33/workspace/.openclaw/community-agent-template/state/community-webhook-state.json",
  editor: "/root/openclaw-33-editor/workspace/.openclaw/community-agent-template/state/community-webhook-state.json",
  tester: "/root/openclaw-33-tester/workspace/.openclaw/community-agent-template/state/community-webhook-state.json",
  worker_a: "/root/openclaw-33-worker-33/workspace/.openclaw/community-agent-template/state/community-webhook-state.json",
  worker_b: "/root/openclaw-33-worker-xhs/workspace/.openclaw/community-agent-template/state/community-webhook-state.json",
});

function trimString(value) {
  return String(value ?? "").trim();
}

function dictValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function listValue(value) {
  return Array.isArray(value) ? value : [];
}

function slugify(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
}

function writeJson(targetPath, value) {
  ensureDir(targetPath);
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function utcNow() {
  return new Date().toISOString();
}

function fileTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-").toLowerCase();
}

function normalizeActionId(message) {
  const content = dictValue(message?.content);
  const payload = dictValue(content.payload);
  const custom = dictValue(message?.extensions?.custom);
  return trimString(
    payload.action_id ||
      dictValue(payload.data).action_id ||
      custom.action_id ||
      dictValue(message?.metadata).action_id,
  );
}

function statusBlock(message) {
  return dictValue(message?.status_block || dictValue(message?.content).payload?.status_block);
}

function authorAgentId(message) {
  return trimString(dictValue(message?.author).agent_id || message?.author_agent_id);
}

function authorRole(message) {
  return trimString(statusBlock(message).author_role || message?.author_role);
}

function messageId(message) {
  return trimString(message?.id);
}

function appendUniqueMessages(target, source) {
  const next = Array.isArray(target) ? [...target] : [];
  const seen = new Set(next.map((message) => messageId(message)).filter(Boolean));
  for (const message of listValue(source)) {
    const id = messageId(message);
    if (id && seen.has(id)) {
      continue;
    }
    next.push(message);
    if (id) {
      seen.add(id);
    }
  }
  return next;
}

async function requestJson(baseUrl, pathname, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (options.token) {
    headers["X-Agent-Token"] = options.token;
  }
  if (options.bearer) {
    headers.Authorization = `Bearer ${options.bearer}`;
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs || 30000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`non-json response from ${pathname}: ${text}`);
  }
  if (!response.ok || payload?.success === false) {
    throw new Error(`${options.method || "GET"} ${pathname} failed: ${response.status} ${payload?.message || ""}`.trim());
  }
  return payload;
}

async function requestJsonWithRetry(baseUrl, pathname, options = {}) {
  const retryCount = Math.max(1, Number(options.retryCount || DEFAULT_REQUEST_RETRY_COUNT));
  const retryBackoffMs = Math.max(0, Number(options.retryBackoffMs || DEFAULT_REQUEST_RETRY_BACKOFF_MS));
  let lastError = null;
  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    try {
      return await requestJson(baseUrl, pathname, options);
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount - 1) {
        break;
      }
      if (retryBackoffMs > 0) {
        await sleep(retryBackoffMs * (attempt + 1));
      }
    }
  }
  throw lastError || new Error(`request failed for ${pathname}`);
}

function normalizeItems(payload) {
  const source = payload?.data ?? payload;
  if (Array.isArray(source)) {
    return source;
  }
  if (Array.isArray(source?.items)) {
    return source.items;
  }
  return [];
}

async function fetchAllMessages(baseUrl, groupId, token, limit = 100) {
  let offset = 0;
  let messages = [];
  while (true) {
    const payload = await requestJsonWithRetry(baseUrl, `/messages?group_id=${groupId}&limit=${limit}&offset=${offset}`, { token });
    const items = normalizeItems(payload);
    messages = appendUniqueMessages(messages, items);
    if (items.length < limit) {
      break;
    }
    offset += limit;
  }
  return messages;
}

export function summarizeStageWindow(stageSpec, beforeMessages, afterMessages) {
  const beforeIds = new Set(listValue(beforeMessages).map((message) => messageId(message)).filter(Boolean));
  const delta = listValue(afterMessages).filter((message) => {
    const id = messageId(message);
    return id && !beforeIds.has(id);
  });
  const observedActionIds = [...new Set(delta.map((message) => normalizeActionId(message)).filter(Boolean))];
  const unexpectedActionIds = observedActionIds.filter(
    (actionId) => !listValue(stageSpec?.expected_action_ids).includes(actionId),
  );
  const formalCloses = delta.filter((message) => {
    const block = statusBlock(message);
    return trimString(block.step_id) === trimString(stageSpec?.stage_id) && /_closed$/.test(trimString(block.step_status));
  });
  return {
    stage_id: stageSpec?.stage_id || null,
    message_count_delta: delta.length,
    observed_action_ids: observedActionIds,
    unexpected_action_ids: unexpectedActionIds,
    observed_roles: [...new Set(delta.map((message) => authorRole(message)).filter(Boolean))],
    observed_authors: [...new Set(delta.map((message) => authorAgentId(message)).filter(Boolean))],
    formal_close_message_ids: formalCloses.map((message) => message.id),
    messages: delta.map((message) => ({
      id: message.id,
      author_agent_id: authorAgentId(message),
      author_role: authorRole(message),
      flow_type: message.flow_type || null,
      message_type: message.message_type || null,
      action_id: normalizeActionId(message) || null,
      step_id: trimString(statusBlock(message).step_id) || null,
      step_status: trimString(statusBlock(message).step_status) || null,
      text: trimString(dictValue(message.content).text).slice(0, 280),
    })),
  };
}

function buildRunRoot(workspaceRoot, label) {
  return path.join(
    workspaceRoot,
    ".openclaw",
    "workflow-live",
    "runs",
    `${slugify(label)}-${fileTimestamp()}`,
  );
}

function loadRoleStates() {
  const roles = {};
  for (const [role, filePath] of Object.entries(ROLE_STATE_PATHS)) {
    const source = readJson(filePath);
    roles[role] = {
      role,
      agent_id: trimString(source.agentId),
      token: trimString(source.token),
      webhook_url: trimString(source.webhookUrl),
      state_path: filePath,
    };
  }
  return roles;
}

async function loginAdmin(baseUrl) {
  const payload = await requestJsonWithRetry(baseUrl, "/auth/admin/login", {
    method: "POST",
    timeoutMs: 60000,
    body: {
      username: trimString(process.env.COMMUNITY_ADMIN_USERNAME || "admin"),
      password: trimString(process.env.COMMUNITY_ADMIN_PASSWORD || "Admin123456!"),
    },
  });
  return trimString(dictValue(payload.data).access_token);
}

async function joinGroupBySlug(baseUrl, slug, token) {
  const payload = await requestJsonWithRetry(baseUrl, `/groups/by-slug/${slug}/join`, {
    method: "POST",
    token,
    timeoutMs: 60000,
    body: {},
  });
  return dictValue(dictValue(payload.data).group || payload.data);
}

export async function createProjectGroup(baseUrl, creatorAuth, slug, name, description, metadataJson = {}) {
  const auth = typeof creatorAuth === "string" ? { token: creatorAuth } : dictValue(creatorAuth);
  try {
    const payload = await requestJson(baseUrl, "/groups", {
      method: "POST",
      token: trimString(auth.token),
      bearer: trimString(auth.bearer),
      timeoutMs: 60000,
      body: {
        name,
        slug,
        description,
        group_type: "project",
        metadata_json: dictValue(metadataJson),
      },
    });
    return dictValue(payload.data);
  } catch (error) {
    const recoveryToken = trimString(auth.recoveryToken || auth.token);
    const recoveredGroup = recoveryToken
      ? await joinGroupBySlug(baseUrl, slug, recoveryToken).catch(() => ({}))
      : {};
    if (Object.keys(recoveredGroup).length) {
      return recoveredGroup;
    }
    throw error;
  }
}

async function joinGroup(baseUrl, groupId, token) {
  return requestJsonWithRetry(baseUrl, `/groups/${groupId}/join`, {
    method: "POST",
    token,
    timeoutMs: 60000,
    body: {},
  });
}

async function patchGroupProtocol(baseUrl, groupId, bearer, groupProtocol) {
  return requestJsonWithRetry(baseUrl, `/groups/${groupId}/protocol`, {
    method: "PATCH",
    bearer,
    timeoutMs: 60000,
    body: {
      group_protocol: groupProtocol,
    },
  });
}

function roleAgentIdMap(roles) {
  return Object.fromEntries(Object.entries(dictValue(roles)).map(([role, item]) => [role, trimString(item?.agent_id)]));
}

function buildSetupIdentity(label, runRoot, groupId, slug, roles) {
  return {
    label,
    run_root: runRoot || null,
    group_id: trimString(groupId) || null,
    slug: trimString(slug) || null,
    role_agent_ids: roleAgentIdMap(roles),
    created_at: utcNow(),
  };
}

export async function setupProjectGroupWithProtocol(options = {}) {
  const baseUrl = trimString(options.baseUrl || DEFAULT_BASE_URL);
  const roles = options.roles || loadRoleStates();
  const manager = dictValue(roles.manager);
  const adminBearer = trimString(options.adminBearer || (await loginAdmin(baseUrl)));
  const label = trimString(options.label || "newsflow-workflow-live");
  const slug = trimString(options.groupSlug || `${slugify(label)}-${Date.now().toString().slice(-8)}`);
  const boundProtocol =
    dictValue(options.boundProtocol) && Object.keys(dictValue(options.boundProtocol)).length
      ? dictValue(options.boundProtocol)
      : buildBoundNewsflowGroupProtocol(roleAgentIdMap(roles));
  const createdGroup = await createProjectGroup(
    baseUrl,
    {
      bearer: adminBearer,
      recoveryToken: trimString(manager.token),
    },
    slug,
    trimString(options.groupName || "Newsflow Workflow Live"),
    trimString(options.groupDescription || "Action-composed live workflow validation group"),
    dictValue(options.groupMetadata),
  );
  const groupId = trimString(createdGroup.id);
  const patchResponse = await patchGroupProtocol(baseUrl, groupId, adminBearer, boundProtocol);
  const joinResults = {};
  for (const role of ["editor", "tester", "worker_a", "worker_b", "manager"]) {
    joinResults[role] = await joinGroup(baseUrl, groupId, trimString(roles[role]?.token));
  }
  const effectiveSnapshot = await captureSnapshot(baseUrl, groupId, trimString(manager.token));
  return {
    admin_bearer: adminBearer,
    group_id: groupId,
    slug,
    roles,
    bound_protocol: boundProtocol,
    created_group: createdGroup,
    join_results: joinResults,
    patch_response: patchResponse,
    effective_snapshot: effectiveSnapshot,
    setup_identity: buildSetupIdentity(label, trimString(options.runRoot || ""), groupId, slug, roles),
  };
}

export async function captureSessionSnapshot(baseUrl, groupId, token) {
  const session = await requestJsonWithRetry(baseUrl, `/groups/${groupId}/session`, { token });
  return {
    captured_at: utcNow(),
    session,
  };
}

export async function captureSnapshot(baseUrl, groupId, token, fallback = {}) {
  const settled = await Promise.allSettled([
    requestJsonWithRetry(baseUrl, `/groups/${groupId}/protocol`, { token }),
    requestJsonWithRetry(baseUrl, `/groups/${groupId}/context`, { token }),
    requestJsonWithRetry(baseUrl, `/groups/${groupId}/session`, { token }),
    requestJsonWithRetry(baseUrl, `/groups/${groupId}/events?limit=200`, { token }),
    fetchAllMessages(baseUrl, groupId, token),
  ]);
  const [protocolResult, contextResult, sessionResult, eventsResult, messagesResult] = settled;
  const fallbackSnapshot = fallback && typeof fallback === "object" ? fallback : {};
  const session = sessionResult.status === "fulfilled" ? sessionResult.value : fallbackSnapshot.session;
  if (!session) {
    throw new Error(`failed to capture snapshot for ${groupId}: missing session`);
  }
  const partialFailures = [
    protocolResult.status === "rejected" ? "protocol" : null,
    contextResult.status === "rejected" ? "context" : null,
    sessionResult.status === "rejected" ? "session" : null,
    eventsResult.status === "rejected" ? "events" : null,
    messagesResult.status === "rejected" ? "messages" : null,
  ].filter(Boolean);
  return {
    captured_at: utcNow(),
    protocol: protocolResult.status === "fulfilled" ? protocolResult.value : fallbackSnapshot.protocol || {},
    context: contextResult.status === "fulfilled" ? contextResult.value : fallbackSnapshot.context || {},
    session,
    events: eventsResult.status === "fulfilled" ? eventsResult.value : fallbackSnapshot.events || {},
    messages: messagesResult.status === "fulfilled" ? messagesResult.value : fallbackSnapshot.messages || [],
    partial_failures: partialFailures,
  };
}

function stageFromSession(snapshot) {
  return trimString(dictValue(snapshot?.session?.data).current_stage);
}

function stageOrderIndex(stageOrder, stageId) {
  return Array.isArray(stageOrder) ? stageOrder.indexOf(trimString(stageId)) : -1;
}

function stageAtOrBeyond(stageOrder, observedStage, expectedStage) {
  const observed = trimString(observedStage);
  const expected = trimString(expectedStage);
  if (!observed || !expected) {
    return false;
  }
  const observedIndex = stageOrderIndex(stageOrder, observed);
  const expectedIndex = stageOrderIndex(stageOrder, expected);
  if (observedIndex < 0 || expectedIndex < 0) {
    return observed === expected;
  }
  return observedIndex >= expectedIndex;
}

export function resolveHarnessStartIndex(stageOrder, snapshot) {
  const currentStage = stageFromSession(snapshot);
  const currentIndex = stageOrderIndex(stageOrder, currentStage);
  return currentIndex >= 0 ? currentIndex : 0;
}

export async function waitForSessionStage(baseUrl, groupId, token, expectedStage, timeoutMs, pollIntervalMs, stageOrder = null) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastSnapshot = await captureSessionSnapshot(baseUrl, groupId, token);
      lastError = null;
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
      continue;
    }
    const observedStage = stageFromSession(lastSnapshot);
    const reached =
      Array.isArray(stageOrder) && stageOrder.length
        ? stageAtOrBeyond(stageOrder, observedStage, expectedStage)
        : observedStage === expectedStage;
    if (reached) {
      return {
        reached: true,
        snapshot: await captureSnapshot(baseUrl, groupId, token, lastSnapshot),
      };
    }
    await sleep(pollIntervalMs);
  }
  return {
    reached: false,
    snapshot: lastSnapshot
      ? await captureSnapshot(baseUrl, groupId, token, lastSnapshot)
      : (() => {
          if (lastError) {
            throw lastError;
          }
          return null;
        })(),
  };
}

export async function runNewsflowWorkflowLive(options = {}) {
  const workspaceRoot = trimString(options.workspaceRoot || path.resolve(SKILL_ROOT));
  const baseUrl = trimString(options.baseUrl || DEFAULT_BASE_URL);
  const stageTimeoutMs = Number(options.stageTimeoutMs || DEFAULT_STAGE_TIMEOUT_MS);
  const pollIntervalMs = Number(options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
  const spec = buildNewsflowWorkflowSpec();
  const stopStage = trimString(options.stopStage || spec.stop_stage || NEWSFLOW_STOP_STAGE);
  const label = trimString(options.label || "newsflow-workflow-live");
  const runRoot = buildRunRoot(workspaceRoot, label);
  fs.mkdirSync(runRoot, { recursive: true });

  const roles = loadRoleStates();
  const setup = await setupProjectGroupWithProtocol({
    baseUrl,
    roles,
    label,
    runRoot,
    groupSlug: options.groupSlug,
    groupName: options.groupName,
    groupDescription: options.groupDescription,
    groupMetadata: {
      purpose: `${label} live validation`,
      created_by: "community-skill-newsflow-harness",
      setup_identity: {
        label,
        run_root: runRoot,
      },
    },
  });
  const manager = roles.manager;
  const group = setup.created_group;
  const groupId = setup.group_id;
  const slug = setup.slug;
  const boundProtocol = setup.bound_protocol;

  writeJson(path.join(runRoot, "role-states.safe.json"), {
    base_url: baseUrl,
    created_at: utcNow(),
    roles: Object.fromEntries(
      Object.entries(roles).map(([role, item]) => [
        role,
        {
          agent_id: item.agent_id,
          webhook_url: item.webhook_url,
          state_path: item.state_path,
        },
      ]),
    ),
  });
  writeJson(path.join(runRoot, "group.safe.json"), group);
  writeJson(path.join(runRoot, "group.created.safe.json"), group);
  writeJson(
    path.join(runRoot, "group.effective.safe.json"),
    dictValue(dictValue(setup.effective_snapshot.protocol).data).group || {},
  );
  writeJson(path.join(runRoot, "protocol.bound.json"), boundProtocol);
  writeJson(path.join(runRoot, "workflow-spec.json"), spec);
  writeJson(path.join(runRoot, "join-results.safe.json"), setup.join_results);
  writeJson(path.join(runRoot, "patch-response.safe.json"), setup.patch_response);
  writeJson(path.join(runRoot, "setup.safe.json"), setup.setup_identity);

  const initialSnapshot = setup.effective_snapshot;
  writeJson(path.join(runRoot, "snapshots", "initial.json"), initialSnapshot);

  const stageSummaries = [];
  let previousSnapshot = initialSnapshot;
  const startIndex = resolveHarnessStartIndex(spec.stage_order, initialSnapshot);
  for (let stageCursor = startIndex; stageCursor < spec.stage_order.length; stageCursor += 1) {
    const stageId = spec.stage_order[stageCursor];
    const stageSpec = spec.stages.find((stage) => stage.stage_id === stageId);
    if (!stageSpec) {
      throw new Error(`missing stage spec for ${stageId}`);
    }
    const currentObservedStage = stageFromSession(previousSnapshot);
    if (
      currentObservedStage &&
      stageAtOrBeyond(spec.stage_order, currentObservedStage, stageId) &&
      currentObservedStage !== stageId
    ) {
      continue;
    }
    const waited = await waitForSessionStage(
      baseUrl,
      groupId,
      manager.token,
      stageId,
      stageTimeoutMs,
      pollIntervalMs,
      spec.stage_order,
    );
    const stageRoot = path.join(runRoot, "stages", stageId);
    writeJson(path.join(stageRoot, "reached.json"), waited.snapshot || {});
    if (!waited.reached) {
      const failure = {
        ok: false,
        failure_stage: stageId,
        expected_stop_stage: stopStage,
        reason: "stage_timeout",
        run_root: runRoot,
        group_id: groupId,
      };
      writeJson(path.join(runRoot, "result.json"), failure);
      return failure;
    }

    if (stageId === stopStage) {
      const stageSummary = summarizeStageWindow(stageSpec, previousSnapshot.messages, waited.snapshot.messages);
      stageSummaries.push({
        ...stageSummary,
        reached_stage: stageId,
        stop_stage: true,
      });
      writeJson(path.join(stageRoot, "summary.json"), stageSummaries.at(-1));
      const success = {
        ok: true,
        group_id: groupId,
        stop_stage: stageId,
        run_root: runRoot,
        stage_summaries: stageSummaries,
      };
      writeJson(path.join(runRoot, "result.json"), success);
      return success;
    }

    const nextStage = trimString(stageSpec.next_stage);
    if (!nextStage) {
      const success = {
        ok: true,
        group_id: groupId,
        stop_stage: stageId,
        run_root: runRoot,
        stage_summaries: stageSummaries,
      };
      writeJson(path.join(runRoot, "result.json"), success);
      return success;
    }
    const advanced = await waitForSessionStage(
      baseUrl,
      groupId,
      manager.token,
      nextStage,
      stageTimeoutMs,
      pollIntervalMs,
      spec.stage_order,
    );
    writeJson(path.join(stageRoot, "advanced.json"), advanced.snapshot || {});
    const advancedStage = stageFromSession(advanced.snapshot);
    const skippedBeyondNextStage =
      advanced.reached &&
      advancedStage &&
      advancedStage !== nextStage &&
      stageAtOrBeyond(spec.stage_order, advancedStage, nextStage);
    const summarySnapshot = skippedBeyondNextStage ? waited.snapshot : (advanced.snapshot || waited.snapshot);
    const summary = summarizeStageWindow(stageSpec, previousSnapshot.messages, summarySnapshot?.messages || waited.snapshot.messages);
    stageSummaries.push({
      ...summary,
      reached_stage: stageId,
      advanced_to: advancedStage,
      skipped_to_stage: skippedBeyondNextStage ? advancedStage : null,
      timed_out: !advanced.reached,
    });
    writeJson(path.join(stageRoot, "summary.json"), stageSummaries.at(-1));
    if (!advanced.reached) {
      const failure = {
        ok: false,
        failure_stage: stageId,
        expected_next_stage: nextStage,
        observed_stage: stageFromSession(advanced.snapshot),
        reason: "advance_timeout",
        run_root: runRoot,
        group_id: groupId,
        stage_summaries: stageSummaries,
      };
      writeJson(path.join(runRoot, "result.json"), failure);
      return failure;
    }
    previousSnapshot = advanced.snapshot;
    if (skippedBeyondNextStage) {
      const advancedIndex = stageOrderIndex(spec.stage_order, advancedStage);
      if (advancedIndex >= 0) {
        stageCursor = advancedIndex - 1;
      }
    }
  }

  const success = {
    ok: true,
    group_id: groupId,
    stop_stage,
    run_root: runRoot,
    stage_summaries: stageSummaries,
  };
  writeJson(path.join(runRoot, "result.json"), success);
  return success;
}

async function main() {
  const result = await runNewsflowWorkflowLive({
    workspaceRoot: path.resolve(SKILL_ROOT),
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  });
}
