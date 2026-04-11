import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_HOME = path.resolve(__dirname, "..");

const WORKSPACE = process.env.WORKSPACE_ROOT || "G:/community agnts/community agents";
const TEMPLATE_HOME = process.env.COMMUNITY_TEMPLATE_HOME || path.join(WORKSPACE, "community-skill");
const STATE_ROOT = path.join(TEMPLATE_HOME, "state");
const BASE_URL = process.env.COMMUNITY_BASE_URL || "http://127.0.0.1:8000/api/v1";
const GROUP_SLUG = process.env.COMMUNITY_GROUP_SLUG || "public-lobby";
const AGENT_NAME = process.env.COMMUNITY_AGENT_NAME || `community-agent-${os.hostname()}`;
const AGENT_DESCRIPTION = process.env.COMMUNITY_AGENT_DESCRIPTION || "Community protocol installed agent";
const AGENT_HANDLE = process.env.COMMUNITY_AGENT_HANDLE || AGENT_NAME;
const TRANSPORT_MODE = process.env.COMMUNITY_TRANSPORT || "webhook";
const LISTEN_HOST = process.env.COMMUNITY_WEBHOOK_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.COMMUNITY_WEBHOOK_PORT || "8848");
const SOCKET_PATH = process.env.COMMUNITY_AGENT_SOCKET_PATH || "";
const WEBHOOK_PATH = process.env.COMMUNITY_WEBHOOK_PATH || `/webhook/${slugifyHandle(AGENT_HANDLE)}`;
const SEND_PATH = process.env.COMMUNITY_SEND_PATH || `/send/${slugifyHandle(AGENT_HANDLE)}`;
const WEBHOOK_PUBLIC_URL = process.env.COMMUNITY_WEBHOOK_PUBLIC_URL || "";
const COMMUNITY_PROTOCOL_VERSION = "ACP-003";
const RUNTIME_VERSION = "community-runtime-v2";
const SKILL_VERSION = "community-skill-v2";
const ONBOARDING_VERSION = "community-onboarding-v2";
const COMMUNITY_SKILL_CHANNEL = "community-skill-v1";
const COMMUNITY_SKILL_SOURCE = "CommunityIntegrationSkill";

const STATE_PATH = path.join(STATE_ROOT, "community-webhook-state.json");
const GROUP_SESSIONS_PATH = path.join(STATE_ROOT, "community-group-sessions.json");
const GROUP_CONTEXTS_PATH = path.join(STATE_ROOT, "community-group-contexts.json");
const BUNDLED_RUNTIME_PATH = path.join(SKILL_HOME, "assets", "community-runtime-v0.mjs");
const WORKSPACE_RUNTIME_PATH = path.join(WORKSPACE, "community-skill", "assets", "community-runtime-v0.mjs");
const BUNDLED_AGENT_PROTOCOL_PATH = path.join(SKILL_HOME, "assets", "AGENT_PROTOCOL.md");
const INSTALLED_AGENT_PROTOCOL_PATH = path.join(STATE_ROOT, "AGENT_PROTOCOL.md");

let runtimeModulePromise = null;
let runtimeModuleLoadedFrom = null;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function loadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function dictOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function textOf(value) {
  return String(value || "").trim();
}

function firstText(...values) {
  for (const value of values) {
    const text = textOf(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function slugifyHandle(value) {
  const base = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `agent-${Date.now().toString().slice(-6)}`;
}

function cleanupStaleSocket(socketPath) {
  const normalizedPath = textOf(socketPath);
  if (!normalizedPath || normalizedPath.startsWith("\\\\")) {
    return normalizedPath;
  }
  ensureDir(normalizedPath);
  if (!fs.existsSync(normalizedPath)) {
    return normalizedPath;
  }
  try {
    fs.rmSync(normalizedPath, { force: true });
  } catch (error) {
    throw new Error(`failed to remove stale socket at ${normalizedPath}: ${error.message}`);
  }
  return normalizedPath;
}

function normalizeFlowType(value) {
  const flowType = firstText(value).toLowerCase() || "run";
  if (flowType === "status") {
    return "run";
  }
  return ["start", "run", "result"].includes(flowType) ? flowType : "run";
}

const CANONICAL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function parseCanonicalUuid(value) {
  const text = firstText(value);
  return CANONICAL_UUID_RE.test(text) ? text : null;
}

function firstCanonicalUuid(...values) {
  for (const value of values) {
    const uuid = parseCanonicalUuid(value);
    if (uuid) {
      return uuid;
    }
  }
  return null;
}

function isAuthFailure(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("unauthorized") || message.includes("invalid token") || message.includes("not authenticated") || message.includes("token");
}

function buildProfile() {
  return {
    display_name: AGENT_NAME,
    handle: slugifyHandle(AGENT_HANDLE),
    identity: "Community Agent",
    tagline: AGENT_DESCRIPTION,
    bio: AGENT_DESCRIPTION,
    avatar_text: AGENT_NAME.slice(0, 2).toUpperCase(),
    expertise: [],
  };
}

function buildWebhookUrl() {
  return textOf(WEBHOOK_PUBLIC_URL) || `http://${LISTEN_HOST}:${LISTEN_PORT}${WEBHOOK_PATH}`;
}

export async function updateCommunityProfile(state, profileOverrides = null) {
  const baseProfile = buildProfile();
  const profile =
    profileOverrides && typeof profileOverrides === "object"
      ? {
          ...baseProfile,
          ...profileOverrides,
        }
      : baseProfile;
  const updated = await request("/agents/me/profile", {
    method: "PATCH",
    token: state.token,
    body: JSON.stringify({ profile }),
  });
  const nextState = {
    ...state,
    profile,
    agentId: updated.id || state.agentId || null,
    agentName: updated.name || state.agentName || AGENT_NAME,
  };
  saveCommunityState(nextState);
  return nextState;
}

async function request(pathname, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (options.token) {
    headers["X-Agent-Token"] = options.token;
  }
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers,
    body: options.body,
  });
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${pathname}: ${text}`);
    }
  }
  if (!response.ok || payload.success === false) {
    throw new Error(`Request failed for ${pathname}: ${payload.message || response.status}`);
  }
  return payload.data;
}

function persistGroupSessions(declarations) {
  const current = loadJson(GROUP_SESSIONS_PATH, {}) || {};
  for (const item of listOf(declarations)) {
    if (!item?.group_id) {
      continue;
    }
    current[item.group_id] = item;
  }
  saveJson(GROUP_SESSIONS_PATH, current);
  return current;
}

function persistGroupContexts(updates) {
  const current = loadJson(GROUP_CONTEXTS_PATH, {}) || {};
  for (const item of listOf(updates)) {
    if (!item?.group_id) {
      continue;
    }
    current[item.group_id] = item;
  }
  saveJson(GROUP_CONTEXTS_PATH, current);
  return current;
}

function removeGroupCacheEntries(groupIds) {
  const removedIds = new Set(listOf(groupIds).map((item) => textOf(item)).filter(Boolean));
  if (!removedIds.size) {
    return;
  }

  const sessions = loadJson(GROUP_SESSIONS_PATH, {}) || {};
  const contexts = loadJson(GROUP_CONTEXTS_PATH, {}) || {};
  const nextSessions = Object.fromEntries(Object.entries(sessions).filter(([groupId]) => !removedIds.has(textOf(groupId))));
  const nextContexts = Object.fromEntries(Object.entries(contexts).filter(([groupId]) => !removedIds.has(textOf(groupId))));
  saveJson(GROUP_SESSIONS_PATH, nextSessions);
  saveJson(GROUP_CONTEXTS_PATH, nextContexts);
}

function currentVersionMap(storePath, versionKey) {
  const current = loadJson(storePath, {}) || {};
  return Object.fromEntries(
    Object.entries(current)
      .filter(([, value]) => value && typeof value === "object")
      .map(([groupId, value]) => [groupId, textOf(value[versionKey])])
      .filter(([, value]) => value),
  );
}

export function loadSavedCommunityState() {
  return loadJson(STATE_PATH, {}) || {};
}

export function saveCommunityState(state) {
  saveJson(STATE_PATH, state || {});
  return state || {};
}

export function installRuntime() {
  const targetPath = fs.existsSync(WORKSPACE_RUNTIME_PATH) ? WORKSPACE_RUNTIME_PATH : BUNDLED_RUNTIME_PATH;
  ensureDir(targetPath);
  const source = fs.readFileSync(BUNDLED_RUNTIME_PATH, "utf8");
  fs.writeFileSync(targetPath, source);
  return targetPath;
}

export function installAgentProtocol() {
  ensureDir(INSTALLED_AGENT_PROTOCOL_PATH);
  fs.writeFileSync(INSTALLED_AGENT_PROTOCOL_PATH, fs.readFileSync(BUNDLED_AGENT_PROTOCOL_PATH, "utf8"));
  return INSTALLED_AGENT_PROTOCOL_PATH;
}

async function ensureAgent(state) {
  if (state?.token) {
    try {
      const me = await request("/agents/me", { token: state.token, method: "GET" });
      return { ...state, agentId: me.id, agentName: me.name };
    } catch (error) {
      if (!isAuthFailure(error)) {
        throw error;
      }
      console.warn(
        JSON.stringify(
          { ok: false, warning: "stale_agent_token_detected", message: String(error.message) },
          null,
          2,
        ),
      );
    }
  }

  const payload = {
    name: AGENT_NAME,
    description: AGENT_DESCRIPTION,
    metadata_json: {
      profile: buildProfile(),
    },
  };
  const result = await request("/agents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return {
    ...state,
    token: result.token,
    agentId: result.agent.id,
    agentName: result.agent.name,
    profile: result.agent.metadata_json?.profile || buildProfile(),
  };
}

async function ensureGroup(state) {
  try {
    const group = await request(`/groups/by-slug/${GROUP_SLUG}`, { token: state.token });
    await request(`/groups/by-slug/${GROUP_SLUG}/join`, {
      method: "POST",
      token: state.token,
      body: JSON.stringify({}),
    });
    return {
      ...state,
      groupId: group.id,
      groupSlug: group.slug,
      groupName: group.name,
    };
  } catch {
    const created = await request("/groups", {
      method: "POST",
      token: state.token,
      body: JSON.stringify({
        name: "Public Lobby",
        slug: GROUP_SLUG,
        description: "Community default lobby",
        group_type: "public_lobby",
        metadata_json: {},
      }),
    });
    return {
      ...state,
      groupId: created.id,
      groupSlug: created.slug,
      groupName: created.name,
    };
  }
}

async function ensureAgentWebhook(state) {
  const webhookSecret = state.webhookSecret || crypto.randomBytes(24).toString("hex");
  if (TRANSPORT_MODE !== "webhook") {
    return {
      ...state,
      webhookSecret,
    };
  }
  const webhookUrl = buildWebhookUrl();
  if (!webhookUrl) {
    return {
      ...state,
      webhookSecret,
    };
  }
  await request("/agents/me/webhook", {
    method: "POST",
    token: state.token,
    body: JSON.stringify({
      target_url: webhookUrl,
      secret: webhookSecret,
      description: "community-skill-v2 session/sync webhook",
    }),
  });
  return {
    ...state,
    webhookUrl,
    webhookSecret,
  };
}

export async function syncCommunitySession(state, options = {}) {
  const payload = {
    agent_id: state.agentId || null,
    agent_session_id: state.agentSessionId || null,
    community_protocol_version: COMMUNITY_PROTOCOL_VERSION,
    runtime_version: RUNTIME_VERSION,
    skill_version: SKILL_VERSION,
    onboarding_version: ONBOARDING_VERSION,
    group_session_versions: currentVersionMap(GROUP_SESSIONS_PATH, "group_session_version"),
    group_context_versions: currentVersionMap(GROUP_CONTEXTS_PATH, "group_context_version"),
    full_sync_requested: Boolean(options.fullSyncRequested || !state.agentSessionId),
  };
  const result = await request("/agents/me/session/sync", {
    method: "POST",
    token: state.token,
    body: JSON.stringify(payload),
  });
  persistGroupSessions(result.group_session_declarations || []);
  persistGroupContexts(result.group_context_updates || []);
  const removedGroupIds = listOf(result.removed_groups)
    .map((item) => (typeof item === "string" ? item : firstText(item.group_id, item.id)))
    .filter(Boolean);
  removeGroupCacheEntries(removedGroupIds);
  const nextState = {
    ...state,
    communityProtocolVersion: result.community_protocol_version,
    agentSessionId: result.agent_session?.agent_session_id || state.agentSessionId || null,
    runtimeVersion: result.agent_session?.runtime_version || RUNTIME_VERSION,
    skillVersion: result.agent_session?.skill_version || SKILL_VERSION,
    onboardingVersion: result.agent_session?.onboarding_version || ONBOARDING_VERSION,
    onboardingRequired: Boolean(result.onboarding_required),
    removedGroups: removedGroupIds,
    lastSyncAt: result.agent_session?.last_sync_at || null,
  };
  saveCommunityState(nextState);
  return { state: nextState, sync: result, onboardingRequired: Boolean(result.onboarding_required), removedGroups: removedGroupIds };
}

export async function connectToCommunity(savedState = {}) {
  installRuntime();
  installAgentProtocol();
  let state = { ...loadSavedCommunityState(), ...savedState };
  state = await ensureAgent(state);
  state = await ensureGroup(state);
  state = await ensureAgentWebhook(state);
  const synced = await syncCommunitySession(state, { fullSyncRequested: !state.agentSessionId });
  saveCommunityState(synced.state);
  return synced.state;
}

function normalizeManualPayload(payload) {
  const source = dictOf(payload);
  const content = dictOf(source.content);
  const body = dictOf(source.body);
  const routing = dictOf(source.routing);
  const relations = dictOf(source.relations);
  return {
    group_id: source.group_id,
    author_kind: source.author_kind,
    flow_type: normalizeFlowType(source.flow_type),
    message_type: firstText(source.message_type) || "analysis",
    content: {
      text: firstText(content.text, body.text),
      payload: dictOf(content.payload),
      blocks: listOf(content.blocks).length ? listOf(content.blocks) : listOf(body.blocks),
      attachments: listOf(content.attachments).length ? listOf(content.attachments) : listOf(body.attachments),
    },
    status_block: dictOf(source.status_block),
    context_block: dictOf(source.context_block),
    routing: {
      target: dictOf(routing.target),
      mentions: listOf(routing.mentions),
    },
    relations: {
      thread_id: firstCanonicalUuid(relations.thread_id, source.thread_id, null),
      parent_message_id: firstCanonicalUuid(relations.parent_message_id, source.parent_message_id, null),
    },
    extensions: dictOf(source.extensions),
  };
}

function inheritCanonicalRelations(requestBody, incomingMessage) {
  const incoming = dictOf(incomingMessage);
  const incomingRelations = dictOf(incoming.relations);
  const currentRelations = dictOf(requestBody.relations);
  return {
    ...requestBody,
    group_id: firstText(requestBody.group_id, incoming.group_id),
    relations: {
      thread_id: firstCanonicalUuid(
        currentRelations.thread_id,
        incomingRelations.thread_id,
        incoming.thread_id,
        incoming.id,
        null,
      ),
      parent_message_id: firstCanonicalUuid(
        currentRelations.parent_message_id,
        incoming.id,
        incomingRelations.parent_message_id,
        incoming.parent_message_id,
        incoming.thread_id,
        null,
      ),
    },
  };
}

function buildAutoReplyText(judgment, state) {
  const message = dictOf(judgment?.message);
  const signals = dictOf(judgment?.signals);
  const displayName = firstText(state?.profile?.display_name, state?.agentName, "Codex");
  if (signals.question) {
    return `${displayName} received your message and is processing it.`;
  }
  const sourceText = firstText(message.text);
  if (sourceText) {
    return `${displayName} received your community message.`;
  }
  return `${displayName} received the community event.`;
}

function shouldAutoReply(judgment) {
  const signals = dictOf(judgment?.signals);
  const obligation = firstText(judgment?.obligation?.obligation);
  if (signals.self_message) {
    return false;
  }
  if (!signals.group_scope) {
    return false;
  }
  if (obligation === "observe_only") {
    return false;
  }
  return Boolean(signals.targeted || signals.mentioned || signals.question || obligation === "required");
}

function buildAutoReplyPayload(judgment, state) {
  const message = dictOf(judgment?.message);
  return {
    group_id: message.group_id || state.groupId || null,
    flow_type: "run",
    message_type: "analysis",
    content: {
      text: buildAutoReplyText(judgment, state),
      payload: {},
      blocks: [],
      attachments: [],
    },
  };
}

export async function sendCommunityMessage(state, incomingMessage, payload) {
  const requestBody = inheritCanonicalRelations(normalizeManualPayload(payload), incomingMessage);
  if (!requestBody.group_id) {
    throw new Error("sendCommunityMessage requires group_id");
  }
  if (!textOf(requestBody.content.text) && !Object.keys(requestBody.context_block).length && !Object.keys(requestBody.status_block).length) {
    throw new Error("sendCommunityMessage requires content.text, context_block, or status_block");
  }
  requestBody.extensions = {
    ...dictOf(requestBody.extensions),
    source: COMMUNITY_SKILL_SOURCE,
  };
  console.log(JSON.stringify({ ok: true, outbound_structured_message: true, body: requestBody }, null, 2));
  return request("/messages", {
    method: "POST",
    token: state.token,
    headers: {
      "X-Community-Skill-Channel": COMMUNITY_SKILL_CHANNEL,
    },
    body: JSON.stringify(requestBody),
  });
}

function persistDeliverableArtifacts(event) {
  const source = dictOf(event);
  const eventEnvelope = dictOf(source.event);
  const payload = dictOf(eventEnvelope.payload);
  const declaration = source.entity?.group_session_declaration || payload.group_session_declaration;
  const contextUpdate = source.entity?.group_context || payload.group_context;
  if (declaration) {
    persistGroupSessions([declaration]);
  }
  if (contextUpdate) {
    persistGroupContexts([contextUpdate]);
  }
  if (source.message?.group_id && source.message?.context_block?.group_context) {
    persistGroupContexts([
      {
        group_id: source.message.group_id,
        group_context_version: firstText(source.message.context_block.group_context_version, new Date().toISOString()),
        group_context: source.message.context_block.group_context,
      },
    ]);
  }
}

function runtimeContextFor(groupId) {
  const sessions = loadJson(GROUP_SESSIONS_PATH, {}) || {};
  const contexts = loadJson(GROUP_CONTEXTS_PATH, {}) || {};
  return {
    group_session: sessions[groupId] || null,
    group_context: contexts[groupId]?.group_context || null,
    group_context_version: contexts[groupId]?.group_context_version || null,
  };
}

async function loadRuntimeModule() {
  const runtimePath = fs.existsSync(WORKSPACE_RUNTIME_PATH) ? WORKSPACE_RUNTIME_PATH : BUNDLED_RUNTIME_PATH;
  if (!runtimeModulePromise || runtimeModuleLoadedFrom !== runtimePath) {
    runtimeModuleLoadedFrom = runtimePath;
    runtimeModulePromise = import(`${pathToFileURL(runtimePath).href}?ts=${Date.now()}`);
  }
  return runtimeModulePromise;
}

function isInternalNonIntake(eventType) {
  return ["message.accepted", "message.rejected", "message.delivery_failed", "outbound.canonicalized", "sender.acknowledged"].includes(String(eventType || "").trim());
}

export async function receiveCommunityEvent(state, event) {
  const eventType = textOf(event?.event?.event_type || event?.event_type);
  if (isInternalNonIntake(eventType)) {
    return {
      ignored: true,
      non_intake: true,
      event_type: eventType,
    };
  }
  persistDeliverableArtifacts(event);
  const runtimeModule = await loadRuntimeModule();
  const groupId = firstText(event?.group_id, event?.event?.group_id, event?.message?.group_id, event?.entity?.message?.group_id);
  const judgment = await runtimeModule.handleRuntimeEvent({}, state, event, runtimeContextFor(groupId));
  let outbound = null;
  if (shouldAutoReply(judgment)) {
    const result = await sendCommunityMessage(state, judgment.message, buildAutoReplyPayload(judgment, state));
    outbound = {
      sent: true,
      message_id: result?.id || null,
      group_id: result?.group_id || null,
    };
  }
  return {
    handled: true,
    hot_path_role: "judgment_only",
    judgment,
    outbound,
  };
}

function verifySignature(secret, rawBody, signature) {
  const normalizedSecret = textOf(secret);
  const normalizedSignature = textOf(signature).replace(/^sha256=/i, "");
  if (!normalizedSecret || !normalizedSignature) {
    return false;
  }
  const expected = crypto.createHmac("sha256", normalizedSecret).update(rawBody).digest("hex");
  if (expected.length !== normalizedSignature.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(normalizedSignature, "hex"));
  } catch {
    return false;
  }
}

async function handleManualSend(state, payload) {
  return sendCommunityMessage(state, null, payload);
}

export async function startCommunityIntegration() {
  const state = await connectToCommunity(loadSavedCommunityState());
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        agentId: state.agentId || null,
        agentName: state.agentName || AGENT_NAME,
        groupId: state.groupId || null,
        communityProtocolVersion: state.communityProtocolVersion || COMMUNITY_PROTOCOL_VERSION,
        runtimeRole: "judgment_only",
        skillRole: "onboarding_sync_transport",
      }));
      return;
    }

    if (req.method === "POST" && req.url === SEND_PATH) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const result = await handleManualSend(state, payload);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });
      return;
    }

    if (req.method !== "POST" || req.url !== WEBHOOK_PATH) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const rawBody = Buffer.concat(chunks);
        const signature = req.headers["x-community-webhook-signature"];
        if (typeof signature !== "string" || !verifySignature(state.webhookSecret, rawBody, signature)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid signature" }));
          return;
        }
        const payload = JSON.parse(rawBody.toString("utf8"));
        const result = await receiveCommunityEvent(state, payload);
        console.log(JSON.stringify({ ok: true, webhook: true, event_type: payload?.event?.event_type || payload?.event_type || "", result }, null, 2));
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
  });

  if (TRANSPORT_MODE === "unix_socket") {
    const socketPath = cleanupStaleSocket(SOCKET_PATH);
    if (!socketPath) {
      throw new Error("COMMUNITY_AGENT_SOCKET_PATH is required when COMMUNITY_TRANSPORT=unix_socket");
    }
    server.listen(socketPath, () => {
      console.log(JSON.stringify({
        ok: true,
        listening: true,
        transportMode: TRANSPORT_MODE,
        socketPath,
        webhookPath: WEBHOOK_PATH,
        sendPath: SEND_PATH,
        runtimeRole: "judgment_only",
        skillRole: "onboarding_sync_transport",
      }, null, 2));
    });
    return;
  }

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(JSON.stringify({
      ok: true,
      listening: true,
      transportMode: TRANSPORT_MODE,
      listenHost: LISTEN_HOST,
      listenPort: LISTEN_PORT,
      webhookPath: WEBHOOK_PATH,
      sendPath: SEND_PATH,
      runtimeRole: "judgment_only",
      skillRole: "onboarding_sync_transport",
    }, null, 2));
  });
}

export const loadGroupContext = (state, groupId, payload) => {
  persistGroupContexts([{ group_id: groupId, group_context_version: new Date().toISOString(), group_context: dictOf(payload) }]);
  return { state, groupId };
};

export const loadChannelContext = loadGroupContext;
