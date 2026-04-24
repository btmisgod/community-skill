import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildActionModuleRegistryCard, getActionModule, resolveActionModuleReference } from "./action_modules/index.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_HOME = path.resolve(__dirname, "..");

function slugifyHandle(value) {
  const base = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `agent-${Date.now().toString().slice(-6)}`;
}

function normalizedSectionToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function shortSocketPath(ingressHome, agentSlug) {
  const normalizedSlug = slugifyHandle(agentSlug);
  const slugPrefix = normalizedSlug.slice(0, 24) || "agent";
  const hash = crypto.createHash("sha256").update(normalizedSlug).digest("hex").slice(0, 12);
  return path.join(ingressHome, "sockets", `${slugPrefix}-${hash}.sock`);
}

const WORKSPACE = process.env.WORKSPACE_ROOT || "/root/.openclaw/workspace";
const TEMPLATE_HOME =
  process.env.COMMUNITY_TEMPLATE_HOME || path.join(WORKSPACE, ".openclaw", "community-agent-template");
const INGRESS_HOME = process.env.COMMUNITY_INGRESS_HOME || "/root/.openclaw/community-ingress";
const BASE_URL = process.env.COMMUNITY_BASE_URL || "http://127.0.0.1:8000/api/v1";
const GROUP_SLUG = process.env.COMMUNITY_GROUP_SLUG || "public-lobby";
const AGENT_NAME = process.env.COMMUNITY_AGENT_NAME || `openclaw-agent-${os.hostname()}`;
const AGENT_SLUG = slugifyHandle(process.env.COMMUNITY_AGENT_HANDLE || AGENT_NAME);
const AGENT_DESCRIPTION = process.env.COMMUNITY_AGENT_DESCRIPTION || "OpenClaw community-enabled agent";
const TRANSPORT_MODE = process.env.COMMUNITY_TRANSPORT || "unix_socket";
const LISTEN_HOST = process.env.COMMUNITY_WEBHOOK_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.COMMUNITY_WEBHOOK_PORT || "8848");
const WEBHOOK_PATH = process.env.COMMUNITY_WEBHOOK_PATH || `/webhook/${AGENT_SLUG}`;
const SEND_PATH = process.env.COMMUNITY_SEND_PATH || `/send/${AGENT_SLUG}`;
const AGENT_SOCKET_PATH =
  process.env.COMMUNITY_AGENT_SOCKET_PATH || shortSocketPath(INGRESS_HOME, AGENT_SLUG);
const WEBHOOK_PUBLIC_HOST = process.env.COMMUNITY_WEBHOOK_PUBLIC_HOST || "";
const WEBHOOK_PUBLIC_URL = process.env.COMMUNITY_WEBHOOK_PUBLIC_URL || "";
const ALLOW_PRIVATE_WEBHOOK_URL = process.env.COMMUNITY_WEBHOOK_ALLOW_PRIVATE === "1";
const WEBHOOK_IP_DISCOVERY_URLS = String(process.env.COMMUNITY_WEBHOOK_IP_DISCOVERY_URLS || "https://api.ipify.org,https://ifconfig.me/ip,https://api.ip.sb/ip").split(",").map((item) => item.trim()).filter(Boolean);
const RESET_STATE_ON_START = process.env.COMMUNITY_RESET_STATE_ON_START === "1";

const STATE_DIR = path.join(WORKSPACE, ".openclaw");
const ENV_FILE_PATH = path.join(STATE_DIR, "community-agent.env");
const STATE_PATH = path.join(TEMPLATE_HOME, "state", "community-webhook-state.json");
const CHANNEL_CONTEXT_PATH = path.join(TEMPLATE_HOME, "state", "community-channel-contexts.json");
const WORKFLOW_CONTRACT_PATH = path.join(TEMPLATE_HOME, "state", "community-workflow-contracts.json");
const GROUP_SESSION_PATH = path.join(TEMPLATE_HOME, "state", "community-group-sessions.json");
const PROTOCOL_VIOLATION_PATH = path.join(TEMPLATE_HOME, "state", "community-protocol-violations.json");
const OUTBOUND_RECEIPTS_PATH = path.join(TEMPLATE_HOME, "state", "community-outbound-receipts.json");
const OUTBOUND_DEBUG_PATH = path.join(TEMPLATE_HOME, "state", "community-outbound-debug.json");
const OUTBOUND_GUARD_PATH = path.join(TEMPLATE_HOME, "state", "community-outbound-guard.json");
const INVALID_OUTBOUND_WINDOW_MS = Number(process.env.COMMUNITY_INVALID_OUTBOUND_WINDOW_MS || "60000");
const INVALID_OUTBOUND_THRESHOLD = Number(process.env.COMMUNITY_INVALID_OUTBOUND_THRESHOLD || "3");
const INVALID_OUTBOUND_PAUSE_MS = Number(process.env.COMMUNITY_INVALID_OUTBOUND_PAUSE_MS || "120000");
const ASSETS_DIR = path.join(TEMPLATE_HOME, "assets");
const BUNDLED_RUNTIME_PATH = path.join(SKILL_HOME, "assets", "community-runtime-v0.mjs");
const WORKSPACE_RUNTIME_PATH = path.join(WORKSPACE, "scripts", "community-runtime-v0.mjs");
const BUNDLED_AGENT_PROTOCOL_PATH = path.join(SKILL_HOME, "assets", "AGENT_PROTOCOL.md");
const INSTALLED_AGENT_PROTOCOL_PATH = path.join(ASSETS_DIR, "AGENT_PROTOCOL.md");
const WORKSPACE_ASSETS_DIR = path.join(WORKSPACE, "assets");

function preferredAssetPath(name) {
  const workspaceAsset = path.join(WORKSPACE_ASSETS_DIR, name);
  if (fs.existsSync(workspaceAsset)) {
    return workspaceAsset;
  }
  return path.join(ASSETS_DIR, name);
}
let runtimeModulePromise = null;

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
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}
`);
}

function appendJsonArray(filePath, entry, limit = 100) {
  const current = loadJson(filePath, []);
  const list = Array.isArray(current) ? current : [];
  list.push(entry);
  saveJson(filePath, list.slice(-limit));
  return entry;
}

function loadGroupSessionStore() {
  return loadJson(GROUP_SESSION_PATH, {}) || {};
}

function saveGroupSessionStore(store) {
  saveJson(GROUP_SESSION_PATH, store || {});
  return store || {};
}

function compactObservedFormalStatus(entry) {
  const source = dictValue(entry);
  const stepId = firstNonEmpty(source.step_id, source.stage_id);
  const lifecyclePhase = firstNonEmpty(source.lifecycle_phase);
  const stepStatus = firstFormalStepStatus(source);
  const authorAgentId = firstNonEmpty(source.author_agent_id, source.declared_author_agent_id);
  if (!stepId || !lifecyclePhase || !stepStatus || !authorAgentId) {
    return {};
  }
  return pruneNullish({
    step_id: stepId,
    lifecycle_phase: lifecyclePhase,
    step_status: stepStatus,
    author_role: firstNonEmpty(source.author_role, source.declared_author_role) || null,
    author_agent_id: authorAgentId,
    message_id: firstNonEmpty(source.message_id) || null,
    related_message_id: firstNonEmpty(source.related_message_id) || null,
  }) || {};
}

function compactObservedFormalStatuses(entries, agentId = "") {
  const normalizedAgentId = String(agentId || "").trim();
  return listValue(entries)
    .map((entry) => compactObservedFormalStatus(entry))
    .filter((entry) => Object.keys(entry).length)
    .filter((entry) => !normalizedAgentId || firstNonEmpty(entry.author_agent_id) === normalizedAgentId);
}

function hasObservedFormalStatus(entries, expected = {}, agentId = "") {
  const normalizedExpected = dictValue(expected);
  const expectedStepId = firstNonEmpty(normalizedExpected.step_id, normalizedExpected.stage_id);
  const expectedLifecyclePhase = firstNonEmpty(normalizedExpected.lifecycle_phase);
  const expectedStepStatus = firstFormalStepStatus(normalizedExpected);
  const expectedAuthorAgentId = firstNonEmpty(normalizedExpected.author_agent_id, agentId);
  if (!expectedStepId || !expectedLifecyclePhase || !expectedStepStatus || !expectedAuthorAgentId) {
    return false;
  }
  return compactObservedFormalStatuses(entries, expectedAuthorAgentId).some((entry) => (
    firstNonEmpty(entry.step_id) === expectedStepId &&
    firstNonEmpty(entry.lifecycle_phase) === expectedLifecyclePhase &&
    firstNonEmpty(entry.step_status) === expectedStepStatus
  ));
}

export async function loadGroupSession(state, groupId, payload = null) {
  const normalizedGroupId = String(groupId || "").trim();
  if (!normalizedGroupId) {
    return null;
  }

  const current = loadGroupSessionStore();
  const entry = {
    updated_at: new Date().toISOString(),
    group_id: normalizedGroupId,
    agent_id: state?.agentId || null,
    payload: payload || null,
  };

  current[normalizedGroupId] = entry;
  saveGroupSessionStore(current);
  return entry;
}

export async function resolveGroupSessionObligation(state, groupId, payload, signals) {
  const normalizedGroupId = String(groupId || "").trim();
  if (!normalizedGroupId) {
    return null;
  }

  const groupSession = payload?.group_session && typeof payload.group_session === "object" ? payload.group_session : {};
  const gateSnapshot = groupSession.gate_snapshot && typeof groupSession.gate_snapshot === "object" ? groupSession.gate_snapshot : {};
  const nextRequiredFormalSignal =
    groupSession.next_required_formal_signal && typeof groupSession.next_required_formal_signal === "object"
      ? groupSession.next_required_formal_signal
      : gateSnapshot.next_required_formal_signal && typeof gateSnapshot.next_required_formal_signal === "object"
        ? gateSnapshot.next_required_formal_signal
        : {};
  const pendingGateId = String(nextRequiredFormalSignal.gate_id || "").trim();
  const pendingGate =
    pendingGateId && gateSnapshot.gates && typeof gateSnapshot.gates === "object"
      ? gateSnapshot.gates[pendingGateId] && typeof gateSnapshot.gates[pendingGateId] === "object"
        ? gateSnapshot.gates[pendingGateId]
        : {}
      : {};
  const pendingProducerRole = String(
    firstNonEmpty(nextRequiredFormalSignal.producer_role, nextRequiredFormalSignal.author_role),
  )
    .trim()
    .toLowerCase();
  const selfId = String(state?.agentId || "").trim();
  const requiredAgentIds = listValue(
    listValue(nextRequiredFormalSignal.required_agent_ids).length
      ? nextRequiredFormalSignal.required_agent_ids
      : pendingGate.required_agent_ids,
  )
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const alreadyObservedByCurrentAgent = hasObservedFormalStatus(
    dictValue(groupSession.state_json).observed_statuses,
    {
      step_id: firstNonEmpty(nextRequiredFormalSignal.step_id, nextRequiredFormalSignal.stage_id),
      lifecycle_phase: firstNonEmpty(nextRequiredFormalSignal.lifecycle_phase),
      step_status: firstNonEmpty(nextRequiredFormalSignal.step_status),
      author_agent_id: selfId,
    },
    selfId,
  );
  if (alreadyObservedByCurrentAgent) {
    return null;
  }
  const managerRequiredByAuthoritativeSession = Boolean(
    pendingProducerRole === "manager" &&
      selfId &&
      requiredAgentIds.includes(selfId) &&
      firstNonEmpty(
        nextRequiredFormalSignal.step_id,
        nextRequiredFormalSignal.stage_id,
        nextRequiredFormalSignal.step_status,
        nextRequiredFormalSignal.lifecycle_phase,
      ),
  );
  const currentAgentRequiredByAuthoritativeSession = Boolean(
    selfId &&
      requiredAgentIds.includes(selfId) &&
      firstNonEmpty(
        nextRequiredFormalSignal.step_id,
        nextRequiredFormalSignal.stage_id,
        nextRequiredFormalSignal.step_status,
        nextRequiredFormalSignal.lifecycle_phase,
      ),
  );
  const controlTurnOptIn = Boolean(
    groupSession.server_to_manager ||
      groupSession.control_turn ||
      groupSession.manager_control_turn ||
      groupSession.opt_in,
  );
  if (!controlTurnOptIn && !currentAgentRequiredByAuthoritativeSession) {
    return null;
  }

  return {
    obligation: "required",
    reason:
      controlTurnOptIn
        ? "server_to_manager_control_turn_opt_in"
        : managerRequiredByAuthoritativeSession
          ? "server_manager_control_turn"
          : "server_required_formal_signal",
    group_id: normalizedGroupId,
    agent_id: state?.agentId || null,
    signals: signals || null,
  };
}

function outboundRequestId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString("hex");
}

function verifySignature(secret, rawBody, signature) {
  const normalizedSecret = String(secret || "").trim();
  const normalizedSignature = String(signature || "").trim();
  if (!normalizedSecret || !normalizedSignature) {
    return false;
  }

  const expected = crypto.createHmac("sha256", normalizedSecret).update(rawBody).digest("hex");
  const provided = normalizedSignature.replace(/^sha256=/i, "").trim();
  if (!provided || provided.length !== expected.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}

function loadOutboundGuard() {
  return (
    loadJson(OUTBOUND_GUARD_PATH, {
      invalid_attempts: [],
      paused_until: null,
      last_error: null,
      updated_at: null,
    }) || {}
  );
}

function saveOutboundGuard(state) {
  saveJson(OUTBOUND_GUARD_PATH, state || {});
  return state || {};
}

function assertOutboundSendAllowed() {
  const guard = loadOutboundGuard();
  const pausedUntil = String(guard?.paused_until || "").trim();
  if (pausedUntil) {
    const pausedAt = Date.parse(pausedUntil);
    if (Number.isFinite(pausedAt) && pausedAt > Date.now()) {
      throw new Error(`automatic outbound sending paused until ${pausedUntil}`);
    }
  }
}

function recordInvalidOutbound(reason, details = {}) {
  const now = Date.now();
  const cutoff = now - INVALID_OUTBOUND_WINDOW_MS;
  const guard = loadOutboundGuard();
  const attempts = Array.isArray(guard?.invalid_attempts)
    ? guard.invalid_attempts.filter((item) => Date.parse(item?.timestamp || "") >= cutoff)
    : [];
  const entry = {
    timestamp: new Date(now).toISOString(),
    reason,
    details,
  };
  attempts.push(entry);
  const next = {
    invalid_attempts: attempts,
    paused_until:
      attempts.length >= INVALID_OUTBOUND_THRESHOLD ? new Date(now + INVALID_OUTBOUND_PAUSE_MS).toISOString() : null,
    last_error: entry,
    updated_at: new Date(now).toISOString(),
  };
  saveOutboundGuard(next);
  console.error(
    JSON.stringify(
      { ok: false, outbound_guard: "invalid_outbound", reason, details, pausedUntil: next.paused_until },
      null,
      2,
    ),
  );
  return next;
}

function resetOutboundGuard() {
  const guard = loadOutboundGuard();
  saveOutboundGuard({
    invalid_attempts: Array.isArray(guard?.invalid_attempts) ? guard.invalid_attempts.slice(-10) : [],
    paused_until: null,
    last_error: null,
    updated_at: new Date().toISOString(),
  });
}

function isOutboundReceiptEventType(eventType) {
  return ["message.accepted", "message.rejected", "message.projected", "message.delivery_failed"].includes(
    String(eventType || "").trim(),
  );
}

function isOutboundDebugEventType(eventType) {
  return String(eventType || "").trim() === "outbound.canonicalized";
}

function receiptPayloadOf(event) {
  return event?.entity?.receipt || event?.event?.payload?.receipt || {};
}

function handleOutboundReceiptEvent(state, event) {
  const eventType = String(event?.event?.event_type || "").trim();
  const receipt = receiptPayloadOf(event);
  appendJsonArray(
    OUTBOUND_RECEIPTS_PATH,
    {
      received_at: new Date().toISOString(),
      event_type: eventType,
      receipt,
      group_id: event?.group_id || event?.event?.group_id || null,
      agent_id: state?.agentId || null,
    },
    200,
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        outbound_receipt: true,
        event_type: eventType,
        status: receipt?.status || null,
        clientRequestId: receipt?.client_request_id || null,
        communityMessageId: receipt?.community_message_id || null,
      },
      null,
      2,
    ),
  );
  return {
    ignored: false,
    handled: true,
    category: "outbound_receipt",
    non_intake: true,
    event_type: eventType,
    status: receipt?.status || null,
    client_request_id: receipt?.client_request_id || null,
    community_message_id: receipt?.community_message_id || null,
  };
}

function handleOutboundCanonicalizedEvent(state, event) {
  const receipt = receiptPayloadOf(event);
  const canonicalizedMessage = event?.entity?.canonicalized_message || event?.event?.payload?.canonicalized_message || null;
  appendJsonArray(
    OUTBOUND_DEBUG_PATH,
    {
      received_at: new Date().toISOString(),
      event_type: "outbound.canonicalized",
      receipt,
      canonicalized_message: canonicalizedMessage,
      group_id: event?.group_id || event?.event?.group_id || null,
      agent_id: state?.agentId || null,
    },
    100,
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        outbound_debug: true,
        event_type: "outbound.canonicalized",
        clientRequestId: receipt?.client_request_id || null,
        communityMessageId: receipt?.community_message_id || null,
      },
      null,
      2,
    ),
  );
  return {
    ignored: false,
    handled: true,
    category: "outbound_debug",
    non_intake: true,
    event_type: "outbound.canonicalized",
    client_request_id: receipt?.client_request_id || null,
    community_message_id: receipt?.community_message_id || null,
  };
}

function persistCommunityState(state, stage) {
  try {
    console.log(
      JSON.stringify(
        {
          ok: true,
          community_state: "writing",
          stage,
          statePath: STATE_PATH,
          hasToken: Boolean(state?.token),
          agentId: state?.agentId || null,
          groupId: state?.groupId || null,
        },
        null,
        2,
      ),
    );
    saveJson(STATE_PATH, state || {});
    console.log(
      JSON.stringify(
        {
          ok: true,
          community_state: "write_success",
          stage,
          statePath: STATE_PATH,
          hasToken: Boolean(state?.token),
          agentId: state?.agentId || null,
          groupId: state?.groupId || null,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          community_state: "write_failure",
          stage,
          statePath: STATE_PATH,
          error: error.message,
        },
        null,
        2,
      ),
    );
    throw error;
  }
  return state || {};
}

function loadText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function randomSecret() {
  return crypto.randomBytes(24).toString("hex");
}

function deleteFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function signalWithTimeout(ms = 30000) {
  return AbortSignal.timeout(ms);
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function request(pathname, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (options.token) {
    headers["X-Agent-Token"] = options.token;
  }
  if (pathname === "/messages" && options.token) {
    headers["X-Community-Skill-Channel"] = "community-skill-v1";
  }
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers,
    signal: options.signal || signalWithTimeout(),
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
  return payload.data;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }
  return "";
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

function profileFingerprint(profile) {
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(profile || {}))).digest("hex");
}

function buildProfile() {
  const identityDoc = loadText(preferredAssetPath("IDENTITY.md"));
  const soulDoc = loadText(preferredAssetPath("SOUL.md"));
  const displayName = firstNonEmpty(process.env.COMMUNITY_AGENT_DISPLAY_NAME, AGENT_NAME);
  const handle = slugifyHandle(firstNonEmpty(process.env.COMMUNITY_AGENT_HANDLE, displayName));
  const identity = firstNonEmpty(process.env.COMMUNITY_AGENT_IDENTITY, "OpenClaw community agent");
  const tagline = firstNonEmpty(process.env.COMMUNITY_AGENT_TAGLINE, AGENT_DESCRIPTION, "Connected to the shared community ingress");
  const bio = firstNonEmpty(
    process.env.COMMUNITY_AGENT_BIO,
    identityDoc.slice(0, 280),
    soulDoc.slice(0, 280),
    AGENT_DESCRIPTION,
  );
  const avatarText = firstNonEmpty(process.env.COMMUNITY_AGENT_AVATAR_TEXT, displayName.slice(0, 2).toUpperCase());
  const accentColor = firstNonEmpty(process.env.COMMUNITY_AGENT_ACCENT_COLOR, "");
  const expertise = String(process.env.COMMUNITY_AGENT_EXPERTISE || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    display_name: displayName,
    handle,
    identity,
    tagline,
    bio,
    avatar_text: avatarText,
    accent_color: accentColor || undefined,
    expertise,
  };
}

async function patchCommunityProfile(state, profile) {
  const updated = await request("/agents/me/profile", {
    method: "PATCH",
    token: state.token,
    body: JSON.stringify({ profile }),
  });
  return {
    ...state,
    profileCompleted: true,
    profileStatus: "synced",
    profileLastError: null,
    profile,
    profileFingerprint: profileFingerprint(profile),
    agentId: updated.id,
    agentName: updated.name,
  };
}

export function loadSavedCommunityState() {
  return loadJson(STATE_PATH, {}) || {};
}

export function saveCommunityState(state) {
  saveJson(STATE_PATH, state || {});
  return state || {};
}

function buildWebhookUrl(hostname = "") {
  const host = String(hostname || "").trim();
  if (WEBHOOK_PUBLIC_URL.trim()) {
    return WEBHOOK_PUBLIC_URL.trim();
  }
  if (!host) {
    return "";
  }
  return `http://${host}:${LISTEN_PORT}${WEBHOOK_PATH}`;
}

function isPublicIpv4Host(hostname) {
  return Boolean(hostname) && !isPrivateIpv4Host(hostname);
}

async function detectPublicIpv4() {
  for (const url of WEBHOOK_IP_DISCOVERY_URLS) {
    try {
      const response = await fetch(url, { method: "GET" });
      if (!response?.ok) {
        continue;
      }
      const candidate = String(await response.text()).trim();
      if (isPublicIpv4Host(candidate)) {
        return candidate;
      }
    } catch {
      // Try the next discovery endpoint.
    }
  }
  return "";
}

async function resolveWebhookUrl() {
  if (WEBHOOK_PUBLIC_URL.trim()) {
    return WEBHOOK_PUBLIC_URL.trim();
  }
  const configuredHost = String(WEBHOOK_PUBLIC_HOST || "").trim();
  if (isPublicIpv4Host(configuredHost)) {
    return buildWebhookUrl(configuredHost);
  }
  const detectedIp = await detectPublicIpv4();
  if (detectedIp) {
    return buildWebhookUrl(detectedIp);
  }
  throw new Error(
    "unable to determine a publicly reachable webhook address automatically; set COMMUNITY_WEBHOOK_PUBLIC_URL or COMMUNITY_WEBHOOK_PUBLIC_HOST explicitly",
  );
}

function isPrivateIpv4Host(hostname) {
  const source = String(hostname || "").trim();
  if (!source) {
    return false;
  }
  const match = source.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map((value) => Number(value));
  if (octets.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
    return false;
  }
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

export function validateWebhookUrl(url) {
  if (!url) {
    throw new Error("webhook public url is empty");
  }
  const parsed = new URL(url);
  const hostname = String(parsed.hostname || "").trim().toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const isPrivate = isPrivateIpv4Host(hostname);
  if ((isLoopback || isPrivate) && !ALLOW_PRIVATE_WEBHOOK_URL) {
    throw new Error(
      `webhook public url is not publicly reachable: ${url}. Set COMMUNITY_WEBHOOK_PUBLIC_URL to a reachable address or set COMMUNITY_WEBHOOK_ALLOW_PRIVATE=1 if the community server can route to this private address.`,
    );
  }
  if (isLoopback || isPrivate) {
    console.warn(
      JSON.stringify(
        {
          ok: false,
          warning: isLoopback ? "webhook_public_url_is_loopback" : "webhook_public_url_is_private",
          webhookUrl: url,
          note: "Private or loopback webhook URLs only work when the community server can route to that address.",
        },
        null,
        2,
      ),
    );
  }
}

export function installRuntime() {
  if (!fs.existsSync(BUNDLED_RUNTIME_PATH)) {
    throw new Error(`Bundled runtime asset missing: ${BUNDLED_RUNTIME_PATH}`);
  }
  ensureDir(WORKSPACE_RUNTIME_PATH);
  if (fs.existsSync(WORKSPACE_RUNTIME_PATH)) {
    const current = fs.readFileSync(WORKSPACE_RUNTIME_PATH, "utf8");
    const bundled = fs.readFileSync(BUNDLED_RUNTIME_PATH, "utf8");
    if (current !== bundled) {
      fs.copyFileSync(WORKSPACE_RUNTIME_PATH, WORKSPACE_RUNTIME_PATH + ".bak");
      fs.copyFileSync(BUNDLED_RUNTIME_PATH, WORKSPACE_RUNTIME_PATH);
      runtimeModulePromise = null;
      return {
        installed: true,
        refreshed: true,
        runtimePath: WORKSPACE_RUNTIME_PATH,
        backupPath: WORKSPACE_RUNTIME_PATH + ".bak",
        source: "skill_asset",
      };
    }
    runtimeModulePromise = null;
    return { installed: true, refreshed: false, runtimePath: WORKSPACE_RUNTIME_PATH, source: "workspace" };
  }
  fs.copyFileSync(BUNDLED_RUNTIME_PATH, WORKSPACE_RUNTIME_PATH);
  runtimeModulePromise = null;
  return { installed: true, refreshed: true, runtimePath: WORKSPACE_RUNTIME_PATH, source: "skill_asset" };
}

export function installAgentProtocol() {
  if (!fs.existsSync(BUNDLED_AGENT_PROTOCOL_PATH)) {
    throw new Error(`Bundled agent protocol asset missing: ${BUNDLED_AGENT_PROTOCOL_PATH}`);
  }
  ensureDir(INSTALLED_AGENT_PROTOCOL_PATH);
  fs.copyFileSync(BUNDLED_AGENT_PROTOCOL_PATH, INSTALLED_AGENT_PROTOCOL_PATH);
  return { installed: true, protocolPath: INSTALLED_AGENT_PROTOCOL_PATH, source: "skill_asset" };
}

function isAuthFailure(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("invalid bearer token") ||
    message.includes("invalid_token") ||
    message.includes("invalid agent token") ||
    message.includes("stale agent token") ||
    message.includes("request failed for /agents/me: 401") ||
    message.includes("request failed for /agents/me: unauthorized")
  );
}

async function ensureRegisteredAgent(state) {
  if (state.token) {
    try {
      const me = await request("/agents/me", { method: "GET", token: state.token });
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

  let requestedName = AGENT_NAME;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const registration = await request("/agents", {
        method: "POST",
        body: JSON.stringify({
          name: requestedName,
          description: AGENT_DESCRIPTION,
          metadata_json: {
            source: "community-integration-skill",
            workspace: WORKSPACE,
            bridge: "CommunityIntegrationSkill",
          },
          is_moderator: false,
        }),
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            token_received: true,
            agentId: registration.agent.id,
            agentName: registration.agent.name,
            statePath: STATE_PATH,
          },
          null,
          2,
        ),
      );
      return {
        ...state,
        token: registration.token,
        agentId: registration.agent.id,
        agentName: registration.agent.name,
      };
    } catch (error) {
      if (!String(error.message).includes("agent name already exists")) {
        throw error;
      }
      requestedName = `${AGENT_NAME}-${Date.now()}`;
    }
  }
  throw new Error("Unable to register agent after repeated name conflicts");
}

async function ensureProfile(state) {
  const profile = buildProfile();
  try {
    return await patchCommunityProfile(state, profile);
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          community_profile: "sync_failed",
          agentId: state?.agentId || null,
          error: error?.message || String(error),
        },
        null,
        2,
      ),
    );
    return {
      ...state,
      profileCompleted: false,
      profileStatus: "failed",
      profileLastError: error?.message || String(error),
      profile,
    };
  }
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
  return patchCommunityProfile(state, profile);
}

async function ensureProfileFresh(state, stage = "runtime_profile_check") {
  const profile = buildProfile();
  const nextFingerprint = profileFingerprint(profile);
  const currentFingerprint =
    String(state?.profileFingerprint || "").trim() || profileFingerprint(state?.profile || {});

  if (currentFingerprint === nextFingerprint) {
    return state;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        community_profile: "drift_detected",
        stage,
        agentId: state?.agentId || null,
      },
      null,
      2,
    ),
  );

  try {
    const nextState = await patchCommunityProfile(state, profile);
    persistCommunityState(nextState, stage);
    return nextState;
  } catch (error) {
    const failedState = {
      ...state,
      profileCompleted: false,
      profileStatus: "failed",
      profileLastError: error?.message || String(error),
    };
    persistCommunityState(failedState, `${stage}_failed`);
    return failedState;
  }
}

async function ensureGroupMembership(state) {
  const result = await request(`/groups/by-slug/${GROUP_SLUG}/join`, {
    method: "POST",
    token: state.token,
    body: JSON.stringify({}),
  });
  return { ...state, groupId: result.group.id, groupSlug: result.group.slug };
}

async function ensurePresence(state) {
  try {
    await request("/presence", {
      method: "POST",
      token: state.token,
      body: JSON.stringify({
        group_id: state.groupId,
        state: "online",
        note: "Community Integration Skill active",
      }),
    });
    return {
      ...state,
      presenceStatus: "synced",
      presenceLastError: null,
    };
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          community_presence: "sync_failed",
          groupId: state?.groupId || null,
          error: error?.message || String(error),
        },
        null,
        2,
      ),
    );
    return {
      ...state,
      presenceStatus: "failed",
      presenceLastError: error?.message || String(error),
    };
  }
}

async function ensureAgentWebhook(state) {
  const webhookSecret = state.webhookSecret || randomSecret();
  const webhookUrl = await resolveWebhookUrl();
  validateWebhookUrl(webhookUrl);
  await request("/agents/me/webhook", {
    method: "POST",
    token: state.token,
    body: JSON.stringify({
      target_url: webhookUrl,
      secret: webhookSecret,
      description: `CommunityIntegrationSkill webhook for ${AGENT_NAME}`,
    }),
  });
  return { ...state, webhookSecret, webhookUrl };
}

export async function connectToCommunity(state) {
  let nextState = { ...(state || {}) };
  nextState = await ensureRegisteredAgent(nextState);
  persistCommunityState(nextState, "registered");
  nextState = await ensureProfile(nextState);
  persistCommunityState(nextState, nextState.profileStatus === "failed" ? "profile_failed" : "profile_synced");
  nextState = await ensureGroupMembership(nextState);
  persistCommunityState(nextState, "group_joined");
  nextState = await ensurePresence(nextState);
  persistCommunityState(nextState, nextState.presenceStatus === "failed" ? "presence_failed" : "presence_synced");
  nextState = await ensureAgentWebhook(nextState);
  persistCommunityState(nextState, "webhook_registered");
  return nextState;
}

function storeByGroup(filePath, groupId, payload) {
  const state = loadJson(filePath, {}) || {};
  state[groupId] = {
    updated_at: new Date().toISOString(),
    payload,
  };
  saveJson(filePath, state);
  return state[groupId];
}

function storedPayloadForGroup(filePath, groupId) {
  const state = loadJson(filePath, {}) || {};
  return state[String(groupId || "").trim()]?.payload || null;
}

export async function loadGroupContext(state, groupId, payload = null) {
  const effectiveGroupId = String(groupId || "").trim();
  if (!effectiveGroupId) {
    return null;
  }
  let data = payload;
  if (!data) {
    data = await request(`/groups/${effectiveGroupId}/context`, { method: "GET", token: state.token });
  }
  return storeByGroup(CHANNEL_CONTEXT_PATH, effectiveGroupId, { card: buildStoredGroupContextCard(data) });
}

export function loadWorkflowContract(groupId, contract, source = "event") {
  const effectiveGroupId = String(groupId || "").trim();
  if (!effectiveGroupId || !contract || typeof contract !== "object") {
    return null;
  }
  return storeByGroup(WORKFLOW_CONTRACT_PATH, effectiveGroupId, {
    source,
    contract,
    card: buildStoredWorkflowContractCard(contract, source),
  });
}

export function handleProtocolViolation(state, event) {
  const payload = event?.entity?.message?.content?.metadata?.protocol_violation || event?.entity?.protocol_violation || null;
  if (!payload || typeof payload !== "object") {
    return { ignored: true, category: "protocol_violation", reason: "missing_payload" };
  }
  const history = loadJson(PROTOCOL_VIOLATION_PATH, []) || [];
  history.push({
    agent_id: state.agentId,
    received_at: new Date().toISOString(),
    payload,
  });
  saveJson(PROTOCOL_VIOLATION_PATH, history.slice(-50));
  return {
    ignored: false,
    handled: true,
    category: "protocol_violation",
    reason: payload.violation_type || "protocol_violation",
    requires_resend: payload.action_required === "resend_corrected_message",
  };
}

function parseSimpleEnvFile(filePath) {
  const values = {};
  if (!filePath || !fs.existsSync(filePath)) {
    return values;
  }
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = String(rawLine || "").trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function refreshModelEnvFromFiles() {
  const candidates = [ENV_FILE_PATH];
  const extra = String(process.env.COMMUNITY_MODEL_CONFIG_FILES || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const filePath of [...candidates, ...extra]) {
    const values = parseSimpleEnvFile(filePath);
    for (const [key, value] of Object.entries(values)) {
      if (["MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_ID", "OPENAI_BASE_URL", "OPENAI_API_BASE", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_MODEL_ID", "LLM_BASE_URL", "LLM_API_KEY", "DEFAULT_MODEL", "MODEL"].includes(key)) {
        process.env[key] = String(value || "");
      }
    }
  }
}

function resolveConfiguredSecret(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }
  const braceMatch = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (braceMatch) {
    return String(process.env[braceMatch[1]] || "").trim();
  }
  const envMatch = value.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/i);
  if (envMatch) {
    return String(process.env[envMatch[1]] || "").trim();
  }
  return value;
}

function resolveModelSetting(primaryKey, aliases = []) {
  const keys = [primaryKey, ...aliases];
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function truncateText(value, limit = 240) {
  const text = String(value || "").trim();
  if (!text || text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
}

function pickObject(source, keys = []) {
  const input = dictValue(source);
  const result = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined) {
      result[key] = input[key];
    }
  }
  return result;
}

function safeListSummary(values, limit = 6) {
  return listValue(values)
    .map((item) => (typeof item === "string" ? truncateText(item, 120) : item))
    .slice(0, limit);
}

function renderCard(title, card) {
  const value = dictValue(card);
  if (!Object.keys(value).length) {
    return "";
  }
  return `${title}:\n${JSON.stringify(value, null, 2)}`;
}

function resolvedActionModuleCard(message, runtimeContext) {
  const source = dictValue(message);
  const content = dictValue(source.content);
  const payload = dictValue(content.payload);
  const pendingFormalSignal = dictValue(runtimeContext?.pending_formal_signal_card);
  const combinedStatusBlock = {
    ...pendingFormalSignal,
    ...dictValue(source.status_block),
    ...dictValue(payload.status_block || payload.statusBlock),
  };
  const resolution = resolveActionModuleReference({
    message_type: firstNonEmpty(
      source.message_type,
      firstNonEmpty(pendingFormalSignal.lifecycle_phase) === "result" ? "decision" : "",
    ),
    flow_type: firstNonEmpty(source.flow_type, pendingFormalSignal.lifecycle_phase),
    text: firstNonEmpty(content.text),
    payload: {
      ...payload,
      ...(Object.keys(combinedStatusBlock).length ? { status_block: combinedStatusBlock } : {}),
    },
    status_block: combinedStatusBlock,
    extensions: source.extensions,
  });
  return resolution?.contract || {};
}

function actionModuleInstructions(message, runtimeContext) {
  return [
    "Reusable action modules are the stable workflow primitive for execution. Use a registered module when your reply clearly matches one.",
    renderCard("Action-module registry card", buildActionModuleRegistryCard()),
    renderCard("Resolved current action-module card", resolvedActionModuleCard(message, runtimeContext)),
    "If one registered action module clearly matches your reply, set action_id to that module id.",
    "Consumer follow-up rule: if Resolved current action-module card declares consumer_follow_up_action_id and this turn is yours as the consumer, you must emit that follow-up action_id instead of mirroring the incoming action_id.",
    "Consumer follow-up rule: when you are the consumer of the current action, do not copy or quote the producer body as your reply. Write the consumer-side body that completes the next handoff.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function roleAssignmentsOf(groupLayer) {
  return dictValue(dictValue(groupLayer?.members).role_assignments);
}

function normalizedRoleToken(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function formalWorkflowOf(groupLayer) {
  return dictValue(dictValue(groupLayer?.workflow).formal_workflow);
}

function executionSpecOf(groupLayer) {
  return dictValue(groupLayer?.execution_spec);
}

function productContractCard(groupLayer) {
  const contract = dictValue(formalWorkflowOf(groupLayer).product_contract);
  if (!Object.keys(contract).length) {
    return {};
  }
  return {
    language: contract.language || null,
    sections: safeListSummary(contract.sections, 10),
    target_items_per_section: contract.target_items_per_section ?? null,
    news_time_window: contract.news_time_window || null,
    final_delivery_shape: contract.final_delivery_shape || null,
    push_requirements: {
      main: contract.main_push_requirement || null,
      secondary: contract.secondary_push_requirement || null,
      general: contract.general_push_requirement || null,
    },
  };
}

function transitionRulesCard(groupLayer) {
  const rules = dictValue(groupLayer?.transition_rules);
  if (!Object.keys(rules).length) {
    return {};
  }
  return pickObject(rules, [
    "manager_is_single_formal_transition_authority",
    "worker_inputs_are_evidence_not_transition_gates",
    "plain_text_cannot_replace_manager_formal_signal",
    "cycle_start_must_consume_raw_human_plain_text_not_server_summary",
  ]);
}

function roleCardForAgent(groupLayer, executionSpec, state, currentAgentRole, workerAgentIds) {
  const assignments = roleAssignmentsOf(groupLayer);
  const roleConfig = dictValue(assignments[currentAgentRole]);
  const roleDirectory = dictValue(executionSpec?.role_directory);
  return {
    current_agent_id: state.agentId || null,
    current_agent_role: currentAgentRole || null,
    responsibility: roleConfig.responsibility || null,
    server_gate_role: roleConfig.server_gate_role || null,
    manager_agent_ids: safeListSummary(roleDirectory.manager_agent_ids || [], 8),
    worker_agent_ids: safeListSummary(workerAgentIds || roleDirectory.worker_agent_ids || [], 10),
  };
}

function assignmentResolutionCard(groupLayer, state, workerAgentIds) {
  const members = dictValue(groupLayer?.members);
  const roleAssignments = dictValue(members.role_assignments);
  const aliasLabels = ["worker_a", "worker_b", "worker_c", "worker_d", "worker_e"];
  const workerAliasToAgentId = {};
  const namedRoleAgentIds = {};

  for (const [role, config] of Object.entries(roleAssignments)) {
    const agentId = firstNonEmpty(dictValue(config).agent_id);
    if (agentId) {
      namedRoleAgentIds[role] = agentId;
    }
  }

  listValue(workerAgentIds).forEach((agentId, index) => {
    const alias = aliasLabels[index];
    if (alias && agentId) {
      workerAliasToAgentId[alias] = agentId;
    }
  });

  return {
    manager_agent_id: firstNonEmpty(members.manager_agent_id),
    worker_agent_ids: safeListSummary(workerAgentIds, 10),
    worker_alias_to_agent_id: workerAliasToAgentId,
    current_agent_worker_alias:
      Object.entries(workerAliasToAgentId).find(([, agentId]) => agentId === state.agentId)?.[0] || null,
    named_role_agent_ids: namedRoleAgentIds,
  };
}

function stageCardsFor(groupLayer, executionSpec, currentStage) {
  const workflowStages = dictValue(formalWorkflowOf(groupLayer).stages);
  const workflowStage = dictValue(workflowStages[currentStage]);
  const executionStages = dictValue(executionSpec?.stages);
  const executionStage = dictValue(executionStages[currentStage]);
  const nextStageId = firstNonEmpty(executionStage.next_stage);
  const nextExecutionStage = dictValue(executionStages[nextStageId]);
  return {
    workflow_stage_card: {
      stage_id: currentStage || null,
      owner: workflowStage.owner || null,
      organizer_role: workflowStage.organizer_role || null,
      primary_consumer_role: workflowStage.primary_consumer_role || null,
      observe_only_roles: safeListSummary(workflowStage.observe_only_roles, 8),
      goal: workflowStage.goal || null,
      input: safeListSummary(workflowStage.input, 12),
      output: safeListSummary(workflowStage.output, 12),
      allowed_action_modules: safeListSummary(workflowStage.allowed_action_modules, 16),
      notes: safeListSummary(workflowStage.notes, 8),
    },
    execution_stage_card: {
      stage_id: executionStage.stage_id || currentStage || null,
      next_stage: executionStage.next_stage || null,
      semantic_description: executionStage.semantic_description || null,
      allowed_roles: safeListSummary(executionStage.allowed_roles, 8),
      accepted_status_rules: listValue(executionStage.accepted_status_blocks).slice(0, 8).map((item) => {
        const rule = dictValue(item);
        return {
          gate_id: rule.gate_id || null,
          lifecycle_phase: rule.lifecycle_phase || null,
          step_statuses: safeListSummary(rule.step_statuses, 8),
          allowed_roles: safeListSummary(rule.allowed_roles, 8),
        };
      }),
    },
    next_execution_stage_card: {
      stage_id: nextExecutionStage.stage_id || nextStageId || null,
      next_stage: nextExecutionStage.next_stage || null,
      semantic_description: nextExecutionStage.semantic_description || null,
      allowed_roles: safeListSummary(nextExecutionStage.allowed_roles, 8),
      accepted_status_rules: listValue(nextExecutionStage.accepted_status_blocks).slice(0, 8).map((item) => {
        const rule = dictValue(item);
        return {
          gate_id: rule.gate_id || null,
          lifecycle_phase: rule.lifecycle_phase || null,
          step_statuses: safeListSummary(rule.step_statuses, 8),
          allowed_roles: safeListSummary(rule.allowed_roles, 8),
        };
      }),
    },
  };
}

function runtimeSessionCard(session) {
  const gateSnapshot = dictValue(session?.gate_snapshot);
  const stateJson = dictValue(session?.state_json);
  const lastStatusBlock = dictValue(stateJson.last_status_block);
  return {
    workflow_id: session?.workflow_id || null,
    current_mode: session?.current_mode || null,
    current_stage: session?.current_stage || null,
    group_session_version: session?.group_session_version || null,
    protocol_version: session?.protocol_version || null,
    cycle_id: stateJson.cycle_id || null,
    cycle_number: stateJson.cycle_number ?? null,
    observed_status_count: listValue(stateJson.observed_statuses).length,
    latest_forced_proceed_stage_ids: safeListSummary(stateJson.latest_forced_proceed_stage_ids, 8),
    latest_final_artifact_message_id: stateJson.latest_final_artifact_message_id || null,
    last_status_block: Object.keys(lastStatusBlock).length
      ? pruneNullish({
          step_id: firstNonEmpty(lastStatusBlock.step_id, lastStatusBlock.stage_id) || null,
          lifecycle_phase: firstNonEmpty(lastStatusBlock.lifecycle_phase) || null,
          author_role: firstNonEmpty(lastStatusBlock.author_role) || null,
          author_agent_id: firstNonEmpty(lastStatusBlock.author_agent_id) || null,
          step_status: firstFormalStepStatus(lastStatusBlock) || null,
          related_message_id: firstNonEmpty(lastStatusBlock.related_message_id) || null,
        }) || undefined
      : undefined,
    gate: {
      current_stage: gateSnapshot.current_stage || null,
      next_stage: gateSnapshot.next_stage || null,
      next_stage_allowed: gateSnapshot.next_stage_allowed ?? null,
      current_stage_complete: gateSnapshot.current_stage_complete ?? null,
      satisfied_gates: safeListSummary(gateSnapshot.satisfied_gates, 10),
      advanced_from: gateSnapshot.advanced_from || null,
      advanced_to: gateSnapshot.advanced_to || null,
    },
  };
}

function resolveProtocolGroupLayer(protocolData = {}) {
  const source = dictValue(protocolData);
  const data = dictValue(source.data);
  const dataGroupMetadata = dictValue(dictValue(data.group).metadata_json);
  const sourceGroupMetadata = dictValue(dictValue(source.group).metadata_json);
  const dataCommunityProtocols = dictValue(dataGroupMetadata.community_protocols);
  const sourceCommunityProtocols = dictValue(sourceGroupMetadata.community_protocols);
  const dataCommunityV2 = dictValue(dataGroupMetadata.community_v2);
  const sourceCommunityV2 = dictValue(sourceGroupMetadata.community_v2);
  const candidates = [
    dictValue(dataCommunityProtocols.channel),
    dictValue(sourceCommunityProtocols.channel),
    dictValue(dataCommunityV2.group_protocol),
    dictValue(sourceCommunityV2.group_protocol),
    dictValue(source.group_protocol),
  ];
  return candidates.find((candidate) => Object.keys(candidate).length) || {};
}

function pendingFormalSignalAlreadyObservedByCurrentAgent(state, runtimeContext) {
  const pendingFormalSignal = dictValue(runtimeContext?.pending_formal_signal_card);
  const observedStatuses = listValue(runtimeContext?.__current_agent_observed_statuses);
  if (!Object.keys(pendingFormalSignal).length || !observedStatuses.length) {
    return false;
  }
  const expectedKinds = expectedBusinessArtifactKinds(runtimeContext);
  if (expectedKinds.length) {
    return false;
  }
  return hasObservedFormalStatus(observedStatuses, {
    step_id: firstNonEmpty(
      pendingFormalSignal.step_id,
      pendingFormalSignal.stage_id,
      dictValue(runtimeContext?.execution_stage_card).stage_id,
      dictValue(runtimeContext?.runtime_session_card).current_stage,
    ),
    lifecycle_phase: firstNonEmpty(pendingFormalSignal.lifecycle_phase),
    step_status: firstNonEmpty(pendingFormalSignal.step_status),
    author_agent_id: firstNonEmpty(state?.agentId),
  }, firstNonEmpty(state?.agentId));
}

function currentRoleCandidates(runtimeContext) {
  const roleCard = dictValue(runtimeContext?.role_card);
  return uniqueNonEmpty([
    normalizedRoleToken(firstNonEmpty(roleCard.current_agent_role)),
    normalizedRoleToken(firstNonEmpty(roleCard.server_gate_role)),
  ]);
}

function ownerTokenMatchesCurrentRole(ownerToken, runtimeContext) {
  const owner = normalizedRoleToken(ownerToken);
  const roleCandidates = currentRoleCandidates(runtimeContext);
  if (!owner || !roleCandidates.length) {
    return false;
  }
  if (roleCandidates.includes(owner)) {
    return true;
  }
  for (const role of roleCandidates) {
    if (!role) {
      continue;
    }
    if (
      owner.startsWith(`${role}_`) ||
      owner.startsWith(`${role}_and_`) ||
      owner.includes(`_and_${role}_`) ||
      owner.endsWith(`_and_${role}`)
    ) {
      return true;
    }
  }
  return false;
}

function pendingFormalSignalOwnsCurrentAgent(state, runtimeContext) {
  const pending = dictValue(runtimeContext?.pending_formal_signal_card);
  const currentRoles = currentRoleCandidates(runtimeContext);
  const requiredAgentIds = listValue(pending.required_agent_ids).filter(Boolean);
  if (state?.agentId && requiredAgentIds.includes(state.agentId)) {
    return true;
  }
  const producerRole = normalizedRoleToken(firstNonEmpty(pending.producer_role, pending.author_role));
  if (producerRole && currentRoles.includes(producerRole)) {
    return true;
  }
  return false;
}

export function protocolTurnOwnershipDecision(state, message = {}, runtimeContext = {}, judgment = {}) {
  const obligationReason = firstNonEmpty(judgment?.obligation?.reason);
  const recommendationMode = firstNonEmpty(judgment?.recommendation?.mode);
  if (obligationReason !== "visible_collaboration" || recommendationMode !== "agent_discretion") {
    return {
      owned: true,
      reason: "not_optional_visible_collaboration",
    };
  }

  const selfId = firstNonEmpty(state?.agentId);
  const targetAgentId = firstNonEmpty(message?.target_agent_id);
  const mentionIds = listValue(message?.mentions)
    .map((item) => dictValue(item))
    .map((item) => firstNonEmpty(item.mention_id, item.agent_id))
    .filter(Boolean);
  if (selfId && targetAgentId && targetAgentId === selfId) {
    return {
      owned: true,
      reason: "targeted_to_self",
    };
  }
  if (selfId && mentionIds.includes(selfId)) {
    return {
      owned: true,
      reason: "mentioned_to_self",
    };
  }
  if (pendingFormalSignalOwnsCurrentAgent(state, runtimeContext)) {
    return {
      owned: true,
      reason: "pending_formal_signal",
    };
  }

  const stageOwner = firstNonEmpty(
    dictValue(runtimeContext?.workflow_stage_card).owner,
    dictValue(runtimeContext?.group_objective_card).stage_owner,
  );
  if (ownerTokenMatchesCurrentRole(stageOwner, runtimeContext)) {
    return {
      owned: true,
      reason: "stage_owner",
    };
  }

  return {
    owned: false,
    reason: "protocol_turn_not_owned",
    stage_owner: stageOwner || null,
    current_roles: currentRoleCandidates(runtimeContext),
  };
}

function pendingFormalSignalCard(session) {
  const gateSnapshot = dictValue(session?.gate_snapshot);
  const gates = dictValue(gateSnapshot.gates);
  const nextRequiredFormalSignal = Object.keys(dictValue(session?.next_required_formal_signal)).length
    ? dictValue(session?.next_required_formal_signal)
    : dictValue(gateSnapshot.next_required_formal_signal);
  if (!Object.keys(nextRequiredFormalSignal).length) {
    return {};
  }
  const pendingGate = dictValue(gates[firstNonEmpty(nextRequiredFormalSignal.gate_id)]);
  return {
    gate_id: firstNonEmpty(nextRequiredFormalSignal.gate_id),
    step_id: firstNonEmpty(nextRequiredFormalSignal.step_id, nextRequiredFormalSignal.stage_id),
    step_status: firstNonEmpty(nextRequiredFormalSignal.step_status),
    producer_role: firstNonEmpty(nextRequiredFormalSignal.producer_role, nextRequiredFormalSignal.author_role),
    lifecycle_phase: firstNonEmpty(nextRequiredFormalSignal.lifecycle_phase),
    reason: firstNonEmpty(nextRequiredFormalSignal.reason),
    required_agent_ids: safeListSummary(
      listValue(nextRequiredFormalSignal.required_agent_ids).length
        ? nextRequiredFormalSignal.required_agent_ids
        : pendingGate.required_agent_ids,
      10,
    ),
  };
}

function bootstrapControlTurnCard(runtimeContext) {
  const roleCard = dictValue(runtimeContext?.role_card);
  const runtimeSession = dictValue(runtimeContext?.runtime_session_card);
  const executionStage = dictValue(runtimeContext?.execution_stage_card);
  const pendingFormalSignal = dictValue(runtimeContext?.pending_formal_signal_card);
  const currentStage = firstNonEmpty(executionStage.stage_id, runtimeSession.current_stage);
  const currentMode = firstNonEmpty(runtimeSession.current_mode);
  const businessArtifactKinds = expectedBusinessArtifactKinds(runtimeContext);
  if (
    firstNonEmpty(roleCard.current_agent_role) !== "manager" ||
    currentMode !== "bootstrap" ||
    !["step0", "step1", "step2", "formal_start"].includes(currentStage) ||
    firstNonEmpty(pendingFormalSignal.producer_role) !== "manager" ||
    !firstNonEmpty(pendingFormalSignal.step_status)
  ) {
    return {};
  }
  return {
    current_mode: currentMode,
    current_stage: currentStage,
    step_id: firstNonEmpty(pendingFormalSignal.step_id, currentStage),
    step_status: firstNonEmpty(pendingFormalSignal.step_status),
    lifecycle_phase: firstNonEmpty(pendingFormalSignal.lifecycle_phase),
    expected_business_artifact_kinds: safeListSummary(businessArtifactKinds, 8),
    text_first_control_message_allowed: businessArtifactKinds.length === 0,
  };
}

function buildStoredGroupContextCard(payload) {
  const source = dictValue(payload?.data || payload);
  const group = dictValue(source.group);
  const metadata = dictValue(group.metadata_json);
  const community = dictValue(metadata.community_v2);
  const groupContext = dictValue(community.group_context);
  const context = Object.keys(groupContext).length ? groupContext : dictValue(source.group_context);
  return {
    group_id: firstNonEmpty(group.id, source.group_id),
    group_name: firstNonEmpty(group.name, source.group_name),
    group_slug: firstNonEmpty(group.slug, source.group_slug),
    current_stage: firstNonEmpty(context.current_stage, context.ready_for),
    next_stage: firstNonEmpty(context.next_stage),
    cycle_id: firstNonEmpty(context.cycle_id),
    cycle_number: context.cycle_number ?? null,
    task_goal: firstNonEmpty(context.task_goal),
    stage_owner: firstNonEmpty(context.stage_owner),
    workers_ready: safeListSummary(context.workers_ready, 8),
    protocol_note: firstNonEmpty(context.protocol_note),
    observation: firstNonEmpty(context.observation),
  };
}

function buildStoredWorkflowContractCard(payload, source = "event") {
  const contract = dictValue(payload?.contract || payload);
  return {
    source,
    workflow_id: firstNonEmpty(contract.workflow_id),
    current_stage: firstNonEmpty(contract.current_stage, contract.stage_id),
    owner: firstNonEmpty(contract.owner),
    goal: firstNonEmpty(contract.goal),
    output: safeListSummary(contract.output, 12),
    acceptance: safeListSummary(contract.acceptance, 12),
    notes: safeListSummary(contract.notes, 8),
  };
}

function resolveOpenClawHome(workspaceRoot = WORKSPACE) {
  const candidates = [
    process.env.OPENCLAW_HOME,
    path.basename(workspaceRoot) === "workspace" ? path.resolve(workspaceRoot, "..") : "",
    "/root/.openclaw",
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (!normalized) {
      continue;
    }
    if (fs.existsSync(path.join(normalized, "openclaw.json"))) {
      return normalized;
    }
  }
  return "";
}

function parseProviderModelRef(value) {
  const text = String(value || "").trim();
  if (!text) {
    return { providerName: "", modelId: "" };
  }
  const slash = text.indexOf("/");
  if (slash <= 0 || slash >= text.length - 1) {
    return { providerName: "", modelId: "" };
  }
  return {
    providerName: text.slice(0, slash).trim(),
    modelId: text.slice(slash + 1).trim(),
  };
}

function orderedModelProviders(openclawConfig, modelsConfig) {
  const ordered = [];
  const seen = new Set();
  for (const source of [modelsConfig?.providers, openclawConfig?.models?.providers]) {
    for (const [providerName, providerConfig] of Object.entries(dictValue(source))) {
      if (seen.has(providerName)) {
        continue;
      }
      seen.add(providerName);
      ordered.push([providerName, dictValue(providerConfig)]);
    }
  }
  return ordered;
}

function buildModelCandidate(baseUrl, apiKey, modelId, timeoutMs, metadata = {}) {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/$/, "");
  const normalizedApiKey = String(apiKey || "").trim();
  const normalizedModelId = String(modelId || "").trim();
  if (!normalizedBaseUrl || !normalizedApiKey || !normalizedModelId) {
    return null;
  }
  return {
    baseUrl: normalizedBaseUrl,
    apiKey: normalizedApiKey,
    modelId: normalizedModelId,
    timeoutMs,
    provider: String(metadata.provider || "").trim() || undefined,
    source: String(metadata.source || "").trim() || undefined,
    priorityTier: Number.isFinite(Number(metadata.priorityTier)) ? Number(metadata.priorityTier) : 0,
    priorityIndex: Number.isFinite(Number(metadata.priorityIndex)) ? Number(metadata.priorityIndex) : 0,
  };
}

function loadSourceOfTruthModelCandidates(timeoutMs, workspaceRoot = WORKSPACE) {
  const openclawHome = resolveOpenClawHome(workspaceRoot);
  if (!openclawHome) {
    return [];
  }

  const openclawPath = path.join(openclawHome, "openclaw.json");
  const modelsPath = path.join(openclawHome, "agents", "main", "agent", "models.json");
  const openclawConfig = loadJson(openclawPath, {}) || {};
  const modelsConfig = loadJson(modelsPath, {}) || {};
  const providers = orderedModelProviders(openclawConfig, modelsConfig);
  if (!providers.length) {
    return [];
  }

  const providerMap = new Map(providers);
  const candidates = [];
  let priorityIndex = 0;
  const addCandidate = (providerName, modelId, sourceLabel) => {
    const provider = dictValue(providerMap.get(providerName));
    if (!Object.keys(provider).length) {
      return;
    }
    const providerApi = String(provider.api || "").trim();
    if (providerApi && providerApi !== "openai-completions") {
      return;
    }
    const baseUrl = resolveConfiguredSecret(provider.baseUrl);
    const apiKey = resolveConfiguredSecret(provider.apiKey);
    const candidate = buildModelCandidate(baseUrl, apiKey, modelId, timeoutMs, {
      provider: providerName,
      source: sourceLabel,
      priorityTier: 1,
      priorityIndex: priorityIndex++,
    });
    if (candidate) {
      candidates.push(candidate);
    }
  };

  const primaryRef = parseProviderModelRef(openclawConfig?.agents?.defaults?.model?.primary);
  if (primaryRef.providerName && primaryRef.modelId) {
    addCandidate(primaryRef.providerName, primaryRef.modelId, `${openclawPath}:agents.defaults.model.primary`);
  }

  for (const [providerName, provider] of providers) {
    const models = Array.isArray(provider.models) ? provider.models : [];
    for (const model of models) {
      const modelId = firstNonEmpty(model?.id, model?.name);
      if (!modelId) {
        continue;
      }
      addCandidate(providerName, modelId, `${modelsPath}:providers.${providerName}.models`);
    }
  }

  return candidates;
}

function dedupeModelCandidates(candidates) {
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const signature = `${candidate.baseUrl}::${candidate.modelId}::${candidate.apiKey}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(candidate);
  }
  return deduped;
}

const MODEL_CANDIDATE_FAILURE_CACHE = new Map();
const MODEL_CANDIDATE_SUCCESS_CACHE = new Map();

function modelCandidateFailureKey(candidate) {
  return `${candidate.baseUrl}::${candidate.modelId}::${candidate.apiKey}`;
}

function pruneModelCandidateFailureCache(now = Date.now()) {
  for (const [key, entry] of MODEL_CANDIDATE_FAILURE_CACHE.entries()) {
    if (!entry || Number(entry.suppressed_until || 0) <= now) {
      MODEL_CANDIDATE_FAILURE_CACHE.delete(key);
    }
  }
}

function pruneModelCandidateSuccessCache() {
  if (MODEL_CANDIDATE_SUCCESS_CACHE.size <= 8) {
    return;
  }
  const ordered = [...MODEL_CANDIDATE_SUCCESS_CACHE.entries()].sort(
    (left, right) => Number(right[1] || 0) - Number(left[1] || 0),
  );
  MODEL_CANDIDATE_SUCCESS_CACHE.clear();
  for (const [key, value] of ordered.slice(0, 8)) {
    MODEL_CANDIDATE_SUCCESS_CACHE.set(key, value);
  }
}

function modelCandidateFailureCooldownMs(error) {
  const text = String(error?.message || error || "").trim();
  if (!text) {
    return 0;
  }
  if (/UnsupportedModel|does not support the coding plan feature/i.test(text)) {
    return 6 * 60 * 60 * 1000;
  }
  if (/AccountQuotaExceeded|Insufficient Balance/i.test(text)) {
    return 30 * 60 * 1000;
  }
  if (/AccountRateLimitExceeded|TPM limit reached|TooManyRequests|rate limit/i.test(text)) {
    return 5 * 60 * 1000;
  }
  if (/aborted due to timeout|timeout/i.test(text)) {
    return 2 * 60 * 1000;
  }
  return 0;
}

function suppressFailedModelCandidate(candidate, error) {
  const cooldownMs = modelCandidateFailureCooldownMs(error);
  if (cooldownMs <= 0) {
    return;
  }
  MODEL_CANDIDATE_FAILURE_CACHE.set(modelCandidateFailureKey(candidate), {
    suppressed_until: Date.now() + cooldownMs,
    reason: String(error?.message || error || "model request failed"),
  });
}

function markSuccessfulModelCandidate(candidate) {
  MODEL_CANDIDATE_SUCCESS_CACHE.set(modelCandidateFailureKey(candidate), Date.now());
  pruneModelCandidateSuccessCache();
}

function prioritizeSuccessfulModelCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    const leftTier = Number(left.priorityTier || 0);
    const rightTier = Number(right.priorityTier || 0);
    if (leftTier !== rightTier) {
      return leftTier - rightTier;
    }
    const leftTs = Number(MODEL_CANDIDATE_SUCCESS_CACHE.get(modelCandidateFailureKey(left)) || 0);
    const rightTs = Number(MODEL_CANDIDATE_SUCCESS_CACHE.get(modelCandidateFailureKey(right)) || 0);
    if (leftTs !== rightTs) {
      return rightTs - leftTs;
    }
    return Number(left.priorityIndex || 0) - Number(right.priorityIndex || 0);
  });
}

function activeModelCandidates(candidates) {
  pruneModelCandidateFailureCache();
  const active = candidates.filter((candidate) => {
    const entry = MODEL_CANDIDATE_FAILURE_CACHE.get(modelCandidateFailureKey(candidate));
    return !entry;
  });
  return prioritizeSuccessfulModelCandidates(active);
}

export function resetModelCandidateFailureCache() {
  MODEL_CANDIDATE_FAILURE_CACHE.clear();
  MODEL_CANDIDATE_SUCCESS_CACHE.clear();
}

export function loadModelConfig() {
  refreshModelEnvFromFiles();
  const timeoutMs = parsePositiveInteger(
    resolveModelSetting("COMMUNITY_MODEL_TIMEOUT_MS", ["MODEL_TIMEOUT_MS", "OPENAI_TIMEOUT_MS", "LLM_TIMEOUT_MS"]),
    120000,
  );
  let explicitPriorityIndex = 0;
  const buildEnvCandidate = (baseKey, apiKeyKey, modelIdKey, aliases = {}) =>
    buildModelCandidate(
      resolveModelSetting(baseKey, aliases.baseUrl || []),
      resolveModelSetting(apiKeyKey, aliases.apiKey || []),
      resolveModelSetting(modelIdKey, aliases.modelId || []),
      timeoutMs,
      {
        source: `environment:${baseKey}/${apiKeyKey}/${modelIdKey}`,
        priorityTier: 0,
        priorityIndex: explicitPriorityIndex++,
      },
    );
  const explicitCandidates = [
    buildEnvCandidate("COMMUNITY_MODEL_PRIMARY_BASE_URL", "COMMUNITY_MODEL_PRIMARY_API_KEY", "COMMUNITY_MODEL_PRIMARY_MODEL_ID"),
    buildEnvCandidate("MODEL_BASE_URL", "MODEL_API_KEY", "MODEL_ID", {
      baseUrl: ["OPENAI_BASE_URL", "OPENAI_API_BASE", "LLM_BASE_URL"],
      apiKey: ["OPENAI_API_KEY", "LLM_API_KEY"],
      modelId: ["OPENAI_MODEL", "OPENAI_MODEL_ID", "DEFAULT_MODEL", "MODEL"],
    }),
    buildEnvCandidate("COMMUNITY_MODEL_FALLBACK_1_BASE_URL", "COMMUNITY_MODEL_FALLBACK_1_API_KEY", "COMMUNITY_MODEL_FALLBACK_1_MODEL_ID"),
    buildEnvCandidate("COMMUNITY_MODEL_FALLBACK_2_BASE_URL", "COMMUNITY_MODEL_FALLBACK_2_API_KEY", "COMMUNITY_MODEL_FALLBACK_2_MODEL_ID"),
  ].filter(Boolean);
  const truthSourceCandidates = loadSourceOfTruthModelCandidates(timeoutMs);
  const deduped = dedupeModelCandidates([...explicitCandidates, ...truthSourceCandidates]);
  if (!deduped.length) {
    throw new Error("MODEL_BASE_URL, MODEL_API_KEY, and MODEL_ID must be set or inherited from current agent model config");
  }
  return deduped;
}

async function requestModelCompletion(endpoint, headers, requestBody, timeoutMs) {
  let response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: signalWithTimeout(timeoutMs),
  });
  let payload = await response.json();
  const responseFormatUnsupported =
    !response.ok &&
    String(payload?.error?.code || "").trim() === "InvalidParameter" &&
    String(payload?.error?.param || "").trim() === "response_format.type";
  if (responseFormatUnsupported) {
    const fallbackBody = { ...requestBody };
    delete fallbackBody.response_format;
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(fallbackBody),
      signal: signalWithTimeout(timeoutMs),
    });
    payload = await response.json();
  }
  return { response, payload };
}

async function requestModelJson(requestBody) {
  const candidates = activeModelCandidates(loadModelConfig());
  if (!candidates.length) {
    throw new Error("All configured model candidates are temporarily suppressed");
  }
  let lastError = null;
  for (const candidate of candidates) {
    const endpoint = `${candidate.baseUrl}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${candidate.apiKey}`,
    };
    try {
      const { response, payload } = await requestModelCompletion(
        endpoint,
        headers,
        {
          ...requestBody,
          model: candidate.modelId,
        },
        candidate.timeoutMs,
      );
      if (!response.ok) {
        throw new Error(`Model request failed: ${JSON.stringify(payload)}`);
      }
      MODEL_CANDIDATE_FAILURE_CACHE.delete(modelCandidateFailureKey(candidate));
      markSuccessfulModelCandidate(candidate);
      return payload;
    } catch (error) {
      lastError = error;
      suppressFailedModelCandidate(candidate, error);
      console.error(
        JSON.stringify(
          {
            ok: false,
            model_request_failed: true,
            modelId: candidate.modelId,
            baseUrl: candidate.baseUrl,
            provider: candidate.provider || null,
            source: candidate.source || null,
            error: String(error?.message || error || "unknown model error"),
          },
          null,
          2,
        ),
      );
    }
  }
  throw lastError || new Error("All configured model candidates failed");
}

function runtimeInstructions(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== "object") {
    return "Unable to load runtime context from Community. Respond using only the explicit message, keep the output concise, public, and suitable for sending back into the community.";
  }
  return [
    "Community returned the following minimal runtime cards. Use only these cards to complete the current action and do not restate the protocol itself.",
    renderCard("Role card", runtimeContext.role_card),
    renderCard("Group objective card", runtimeContext.group_objective_card),
    renderCard("Product contract card", runtimeContext.product_contract_card),
    renderCard("Current workflow stage card", runtimeContext.workflow_stage_card),
    renderCard("Current execution stage card", runtimeContext.execution_stage_card),
    renderCard("Runtime session card", runtimeContext.runtime_session_card),
    renderCard("Pending formal signal card", runtimeContext.pending_formal_signal_card),
    renderCard("Assignment resolution card", runtimeContext.assignment_resolution_card),
    renderCard("Bootstrap control-turn card", runtimeContext.bootstrap_control_turn_card),
    renderCard("Transition rules card", runtimeContext.transition_rules_card),
    "If Pending formal signal card names a producer_role that matches your current role, treat that card as the exact formal token to emit now unless runtime rules explicitly require correction instead.",
    "Do not invent neighboring formal statuses. If Pending formal signal card says step_status=step1_done, do not emit step1_result_aligned, closed, or other aliases.",
    "If runtime context says the current agent role is manager and the current stage is manager-owned, do not describe what the manager should do in third person. You are that manager and must emit the formal manager signal directly.",
    "Stage-owner rule: if Current workflow stage card owner matches your role and this turn is the stage kickoff/control-turn or otherwise lacks an incoming business artifact, you must create the current stage artifact from the mounted runtime cards and current thread context instead of asking another agent to do your assigned work.",
    "Stage-owner rule: do not treat the absence of a prior artifact in the incoming message as a blocker when the stage contract makes you the producer of that artifact. Produce it now in visible body text plus the required structured payload.",
    "Manager-specific rule: if the current stage declares expected business artifact kinds, never close it mechanically. Verify that the current stage artifact or evidence actually exists first.",
    "Manager-specific rule: if the current stage is a bootstrap control turn and Bootstrap control-turn card says text_first_control_message_allowed=true, a public text-first coordination message plus the exact top-level status_block is valid. Do not invent a business payload.",
    "Manager-specific rule: bootstrap control turns stay coordination-only. Do not fake evidence_refs, artifact_refs, or business deliverables just to satisfy the formal signal.",
    "Manager-specific rule: if you are not the producer of the required artifact and the business-stage message does not contain the expected deliverable/evidence, do not emit a formal close signal. Ask for the missing artifact or request correction instead.",
    "Manager-specific rule: for business stages with expected artifact kinds, every manager close must carry a structured payload with real content or explicit evidence_refs/artifact_refs. Plain text plus a status_block is invalid there.",
    "Role identity is exclusive. If Role card says tester, editor, worker_a, or worker_b, do not describe yourself as also being another peer role and do not claim a peer's assignment as your own.",
    "Group-protocol rule: treat the current group charter and action-module contract as the only reusable workflow truth source. Do not import product- or workflow-specific rules that are not present in the mounted cards.",
    "Protocol-driven reply rule: if Current workflow stage card owner/notes make another role the in-stage organizer, first consumer, or acting producer, and you are neither directly targeted nor named by Pending formal signal card, do not send a routine public acknowledgement.",
    "Protocol-driven reply rule: if you are manager but Current workflow stage card is not manager-owned and Pending formal signal card does not name manager, do not reply to ordinary in-stage progress unless a direct escalation or explicit question targets you.",
    "Protocol-driven reply rule: if Current workflow stage card notes say your role is observe-only for the current stage, stay silent unless you are directly targeted or the Pending formal signal card names your role.",
    "Assignment resolution rule: use Assignment resolution card only to map explicit aliases or role labels to concrete agent ids. Do not invent additional aliases or claim an assignment that resolves to another agent id.",
    "If the current stage card is generic or action-module based, rely on role boundary, routing, pending formal signal, and the resolved action-module card instead of importing older stage choreography.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function installedAgentProtocolText() {
  return loadText(INSTALLED_AGENT_PROTOCOL_PATH) || loadText(BUNDLED_AGENT_PROTOCOL_PATH);
}

function workflowContractInstructions(groupId) {
  const stored = storedPayloadForGroup(WORKFLOW_CONTRACT_PATH, groupId);
  const contractCard =
    dictValue(stored?.card).goal || dictValue(stored?.card).workflow_id
      ? dictValue(stored.card)
      : buildStoredWorkflowContractCard(stored?.contract || stored, stored?.source || "cache");
  if (!Object.keys(contractCard).length) {
    return "";
  }
  return [
    "The following is the temporary workflow contract card for the current execution stage. It only applies to this task-local execution context and is not a permanent identity definition.",
    JSON.stringify(contractCard, null, 2),
  ].join("\n\n");
}

function channelContextInstructions(groupId) {
  const stored = storedPayloadForGroup(CHANNEL_CONTEXT_PATH, groupId);
  if (!stored) {
    return "";
  }
  const contextCard =
    dictValue(stored?.card).group_id || dictValue(stored?.card).group_slug
      ? dictValue(stored.card)
      : buildStoredGroupContextCard(stored);
  return [
    "The following is the locally cached group context card for the current group. Use it only as execution-time reference.",
    JSON.stringify(contextCard, null, 2),
  ].join("\n\n");
}

export function buildExecutionPrompt(message, state, runtimeContext, judgment = null) {
  const identity = loadText(preferredAssetPath("IDENTITY.md"));
  const soul = loadText(preferredAssetPath("SOUL.md"));
  const user = loadText(preferredAssetPath("USER.md"));
  const agentProtocol = installedAgentProtocolText();

  return [
    {
      role: "system",
      content: [
        `You are the OpenClaw community collaboration agent ${state.profile?.display_name || state.agentName}.`,
        "You are responding because Agent Community delivered a webhook event and Runtime marked it for agent judgment.",
        "You are the agent execution layer, not a generic acknowledgement layer.",
        "Return JSON only.",
        "Required JSON fields: should_send (boolean), flow_type (start|run|result), message_type, text, payload (object), reason.",
        "Optional JSON fields: routing, relations, extensions, intent, status_block (object), context_block (object).",
        "If a workflow or stage requires a formal signal, produce it through the correct flow_type/message_type and structured payload.",
        "When producing a formal workflow signal, place the formal fields in top-level status_block instead of only nesting them inside payload.",
        "Do not emit a generic acknowledgement when substantive agent action or a formal signal is required.",
        "Do not say 'manager should...' when runtime context identifies you as the manager. In that case emit the manager-owned artifact or formal signal now.",
        "If Pending formal signal card identifies your role and provides a step_status/lifecycle_phase, emit that exact top-level status_block instead of inventing adjacent statuses.",
        "If you are the manager and runtime context declares expected business artifact kinds for the current stage, you must not advance that stage unless your response includes the stage-appropriate artifact or evidence-backed decision payload.",
        "If Current workflow stage card owner matches your role and this turn is a kickoff/control-turn or the incoming message lacks the business artifact you are supposed to produce, create that artifact now from runtime cards and current thread context. Do not answer with a meta reminder about what your own role should do.",
        "If runtime context declares a manager-owned bootstrap control turn with no expected business artifact kinds, send the required public coordination message now with the exact top-level status_block. Do not invent a business payload.",
        "If runtime context declares a business-stage artifact requirement and you are not the producer of that artifact and cannot verify it from the current message/thread context, do not emit a formal close status_block. Return a correction/review style message instead.",
        "Do not invent message sources. The current source is Agent Community webhook delivery.",
        "Do not expose internal chain-of-thought.",
        agentProtocol,
        runtimeInstructions(runtimeContext),
        actionModuleInstructions(message, runtimeContext),
        channelContextInstructions(message?.group_id),
        workflowContractInstructions(message?.group_id),
        judgment ? `Current runtime judgment:\n\n${JSON.stringify(judgment, null, 2)}` : "",
        "Identity and working context:",
        identity,
        soul,
        user,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    {
      role: "user",
      content: [
        "Based on the following community message, decide whether to send a public group message now.",
        "Return JSON only.",
        `message_type: ${message.message_type}`,
        `message_content: ${JSON.stringify(message.content, null, 2)}`,
        "If message_content is empty because this is a group_session control turn, rely on the runtime cards and current runtime judgment to produce the required public control message.",
      ].join("\n\n"),
    },
  ];
}

function normalizeExecutionDecision(parsed, raw) {
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const text = firstNonEmpty(source.text, source.reply_text);
  const payload = dictValue(source.payload);
  const statusBlock = dictValue(
    source.status_block ||
    source.statusBlock ||
    payload.status_block ||
    payload.statusBlock,
  );
  const contextBlock = dictValue(
    source.context_block ||
    source.contextBlock ||
    payload.context_block ||
    payload.contextBlock,
  );
  const routing = dictValue(source.routing);
  const relations = dictValue(source.relations);
  const extensions = dictValue(source.extensions);
  const intent = firstNonEmpty(source.intent, dictValue(extensions.custom).intent, inferIntentFromText(text));
  const messageType = normalizeOutboundMessageType(source.message_type || source.messageType || "analysis");
  const flowType = normalizeOutboundFlowType(
    firstNonEmpty(source.flow_type, source.flowType),
    messageType,
    intent,
  );
  const shouldSend = Boolean(
    source.should_send ?? source.shouldReply ?? source.should_reply ?? text,
  );
  return {
    should_send: shouldSend && Boolean(text),
    flow_type: flowType,
    message_type: messageType,
    text,
    payload,
    status_block: statusBlock,
    context_block: contextBlock,
    routing,
    relations,
    extensions: {
      ...extensions,
      custom: {
        ...dictValue(extensions.custom),
        ...(intent ? { intent } : {}),
      },
    },
    reason: firstNonEmpty(source.reason, source.decision_reason),
    raw,
  };
}

function decisionActionModuleId(decision) {
  const source = dictValue(decision);
  const payload = dictValue(source.payload);
  const extensions = dictValue(source.extensions);
  const custom = dictValue(extensions.custom);
  return firstNonEmpty(source.action_id, payload.action_id, custom.action_id);
}

function normalizeConsumerFollowUpDecision(decision, state, message, runtimeContext) {
  const source = dictValue(decision);
  if (!source.should_send || !firstNonEmpty(source.text)) {
    return decision;
  }

  const incomingActionRef = resolveActionModuleReference(message);
  const followUpActionId = firstNonEmpty(dictValue(incomingActionRef.contract).consumer_follow_up_action_id);
  if (!followUpActionId) {
    return decision;
  }

  const incomingActionId = firstNonEmpty(incomingActionRef.action_id);
  const outgoingActionId = firstNonEmpty(decisionActionModuleId(source));
  if (outgoingActionId && outgoingActionId !== incomingActionId) {
    return decision;
  }

  return {
    ...source,
    payload: {
      ...dictValue(source.payload),
      action_id: followUpActionId,
    },
    extensions: {
      ...dictValue(source.extensions),
      custom: {
        ...dictValue(dictValue(source.extensions).custom),
        action_id: followUpActionId,
        consumer_follow_up_normalized: true,
      },
    },
  };
}

function deterministicStageArtifactScaffold(runtimeContext) {
  if (!allowsDeterministicArtifactFallback(runtimeContext)) {
    return {};
  }
  const expectedKinds = expectedStageArtifactKinds(runtimeContext);
  if (expectedKinds.length !== 1) {
    return {};
  }
  const kind = firstNonEmpty(expectedKinds[0]);
  const workflowStageCard = dictValue(runtimeContext?.workflow_stage_card);
  const executionStageCard = dictValue(runtimeContext?.execution_stage_card);
  const productContractCard = dictValue(runtimeContext?.product_contract_card);
  const roleCard = dictValue(runtimeContext?.role_card);
  const groupObjective = firstNonEmpty(dictValue(runtimeContext?.group_objective_card).group_objective);
  const stageGoal = firstNonEmpty(workflowStageCard.goal, executionStageCard.stage_id);
  const nextStage = firstNonEmpty(executionStageCard.next_stage);
  const currentStage = firstNonEmpty(executionStageCard.stage_id);
  const currentRole = firstNonEmpty(roleCard.current_agent_role, roleCard.server_gate_role, "agent");
  const allSections = listValue(productContractCard.sections).filter(Boolean);
  const fallbackSections = allSections.length ? allSections : ["general"];
  const scopedSections =
    currentRole === "worker_a" && fallbackSections.length > 1
      ? fallbackSections.slice(0, Math.ceil(fallbackSections.length / 2))
      : currentRole === "worker_b" && fallbackSections.length > 1
        ? fallbackSections.slice(Math.ceil(fallbackSections.length / 2))
        : fallbackSections;
  const buildItem = (section, index, extra = {}) => ({
    section,
    title: `${section.replace(/_/g, " ")} item ${index + 1}`,
    summary: `${stageGoal || currentStage || "current stage"} by ${currentRole}`,
    source: `deterministic_${currentStage || "stage"}_${currentRole}`,
    ...extra,
  });
  const sectionEntries = scopedSections.map((section, sectionIndex) => ({
    section,
    items: [buildItem(section, sectionIndex)],
  }));
  const flatItems = sectionEntries.flatMap((entry) => listValue(entry.items));
  const markdownSections = sectionEntries
    .map((entry) => {
      const items = listValue(entry.items)
        .map((item) => `- ${firstNonEmpty(item.title)}: ${firstNonEmpty(item.summary)}`)
        .join("\n");
      return `## ${entry.section}\n${items}`;
    })
    .join("\n\n");

  if (kind === "cycle_task_plan") {
    const sections = listValue(productContractCard.sections)
      .filter(Boolean)
      .map((section) => ({
        section,
        target_items: productContractCard.target_items_per_section || null,
      }));
    const cycleTaskPlan = pruneNullish({
      task_plan: stageGoal
        ? `Publish the cycle task plan for ${executionStageCard.stage_id || "the current stage"} and dispatch the next work into ${nextStage || "the next stage"}.`
        : `Publish the cycle task plan and dispatch the next work into ${nextStage || "the next stage"}.`,
      cycle_goal: firstNonEmpty(groupObjective, stageGoal),
      current_stage_goal: stageGoal,
      current_stage_acceptance: listValue(workflowStageCard.notes).filter(Boolean).slice(0, 3),
      handoff_expectations: nextStage ? [`next_stage=${nextStage}`] : [],
      sections,
    });
    return {
      kind,
      ...cycleTaskPlan,
      cycle_task_plan: cycleTaskPlan,
    };
  }

  if (kind === "candidate_material_pool") {
    return {
      kind,
      summary: `Tester-reviewed candidate material pool for ${currentStage || "the current stage"}.`,
      sections: sectionEntries,
      items: flatItems,
      material_pool: flatItems,
      candidate_materials: flatItems,
    };
  }

  if (["product_draft", "revised_product_draft", "final_product_message"].includes(kind)) {
    return {
      kind,
      summary: `${kind.replace(/_/g, " ")} for ${currentStage || "the current stage"}.`,
      sections: sectionEntries,
      items: flatItems,
      draft: markdownSections,
      body_markdown: markdownSections,
      report_markdown: markdownSections,
      product_body: markdownSections,
    };
  }

  if (["material_review_feedback", "proofread_feedback", "recheck_feedback"].includes(kind)) {
    return {
      kind,
      summary: `${kind.replace(/_/g, " ")} for ${currentStage || "the current stage"}.`,
      findings: flatItems.map((item) => ({
        section: item.section,
        finding: `${firstNonEmpty(item.title)} is acceptable for the current stage.`,
      })),
      approved_items: flatItems,
      feedback: flatItems.map((item) => ({
        section: item.section,
        note: `${firstNonEmpty(item.title)} passed deterministic review.`,
      })),
    };
  }

  if (kind === "publish_decision") {
    return {
      kind,
      decision: "proceed_to_publish",
      stage_decision: "approved_for_publication",
      release_decision: "approved",
      risk_note: "Deterministic publish decision generated from current stage completion.",
    };
  }

  if (kind === "product_test_report") {
    return {
      kind,
      summary: `Product test report for ${currentStage || "the current stage"}.`,
      findings: flatItems.map((item) => ({
        section: item.section,
        finding: `${firstNonEmpty(item.title)} is readable and present in the published output.`,
      })),
      recommendations: ["Proceed with benchmark and comparison stages."],
    };
  }

  if (["benchmark_report", "cross_cycle_report", "product_evaluation_report"].includes(kind)) {
    return {
      kind,
      summary: `${kind.replace(/_/g, " ")} for ${currentStage || "the current stage"}.`,
      report: markdownSections,
      report_markdown: markdownSections,
      findings: flatItems.map((item) => ({
        section: item.section,
        finding: `${firstNonEmpty(item.title)} remains within expected quality bounds.`,
      })),
      recommendations: ["Carry these findings into the final product report."],
    };
  }

  if (kind === "retrospective_plan") {
    return {
      kind,
      summary: `Retrospective plan for ${currentStage || "the current stage"}.`,
      discussion_points: flatItems.map((item) => `${firstNonEmpty(item.section)}: review ${firstNonEmpty(item.title)}`),
      action_items: ["Capture validated lessons before retrospective discussion starts."],
      next_cycle_requirements: ["Preserve the current action-module composition and evidence trail."],
    };
  }

  return {};
}

function stageTransitionIntoCurrentStage(runtimeContext, message = {}) {
  const currentStage = firstNonEmpty(
    dictValue(runtimeContext?.execution_stage_card).stage_id,
    dictValue(runtimeContext?.runtime_session_card).current_stage,
  );
  const payload = dictValue(dictValue(message).content?.payload);
  const messageStatusBlock = {
    ...dictValue(message.status_block),
    ...dictValue(payload.status_block || payload.statusBlock),
  };
  const incomingStage = firstNonEmpty(messageStatusBlock.step_id, messageStatusBlock.stage_id);
  if (normalizedSectionToken(firstNonEmpty(message.message_type)) === "group_session") {
    return true;
  }
  return Boolean(currentStage && incomingStage && incomingStage !== currentStage);
}

function stageParticipantAgentIds(runtimeContext) {
  const executionStageCard = dictValue(runtimeContext?.execution_stage_card);
  const workflowStageCard = dictValue(runtimeContext?.workflow_stage_card);
  const assignmentResolution = dictValue(runtimeContext?.assignment_resolution_card);
  const currentRole = normalizedSectionToken(
    firstNonEmpty(dictValue(runtimeContext?.role_card).current_agent_role, dictValue(runtimeContext?.role_card).server_gate_role),
  );
  const observeOnly = new Set(listValue(workflowStageCard.observe_only_roles).map((role) => normalizedSectionToken(role)));
  return listValue(executionStageCard.allowed_roles)
    .map((role) => normalizedSectionToken(role))
    .filter((role) => role && role !== currentRole && role !== "manager" && !observeOnly.has(role))
    .map((role) => firstNonEmpty(assignmentResolution.named_role_agent_ids?.[role]))
    .filter(Boolean);
}

function fallbackConsumerFollowUpActionId(incomingActionId, runtimeContext, state) {
  const expectedKinds = expectedBusinessArtifactKinds(runtimeContext);
  const currentRole = normalizedSectionToken(
    firstNonEmpty(dictValue(runtimeContext?.role_card).current_agent_role, dictValue(runtimeContext?.role_card).server_gate_role),
  );
  if (
    incomingActionId === "assign_task" &&
    expectedKinds.length &&
    currentRole &&
    currentRole !== "manager"
  ) {
    return "submit_artifact";
  }
  return "";
}

function deterministicOrganizerKickoffExecution(state, runtimeContext, message = {}) {
  const workflowStageCard = dictValue(runtimeContext?.workflow_stage_card);
  const organizerRole = normalizedSectionToken(firstNonEmpty(workflowStageCard.organizer_role));
  const currentRole = normalizedSectionToken(
    firstNonEmpty(dictValue(runtimeContext?.role_card).current_agent_role, dictValue(runtimeContext?.role_card).server_gate_role),
  );
  if (!organizerRole || organizerRole !== currentRole || !stageTransitionIntoCurrentStage(runtimeContext, message)) {
    return null;
  }
  const participantAgentIds = stageParticipantAgentIds(runtimeContext);
  if (!participantAgentIds.length) {
    return null;
  }
  const currentStage = firstNonEmpty(
    dictValue(runtimeContext?.execution_stage_card).stage_id,
    dictValue(runtimeContext?.runtime_session_card).current_stage,
  );
  const stageGoal = firstNonEmpty(workflowStageCard.goal, currentStage);
  const expectedKinds = expectedBusinessArtifactKinds(runtimeContext);
  return {
    should_send: true,
    flow_type: "run",
    message_type: "analysis",
    text: [
      `现在进入 ${currentStage || "current stage"}。`,
      stageGoal ? `阶段目标：${stageGoal}` : "",
      `请 ${participantAgentIds.map((id) => `@${id}`).join(" ")} 直接在本线程提交当前阶段所需产物${expectedKinds.length ? `（${expectedKinds.join(", ")}）` : ""}，我会在本阶段内完成审核与打回。`,
    ]
      .filter(Boolean)
      .join("\n"),
    payload: {
      action_id: "assign_task",
      stage_id: currentStage || null,
      organizer_role: organizerRole,
      expected_output_kinds: expectedKinds,
      participant_agent_ids: participantAgentIds,
      task_summary: stageGoal || currentStage || "current stage handoff",
    },
    routing: {
      target: {
        agent_id: participantAgentIds[0] || null,
      },
      mentions: participantAgentIds.map((agentId) => ({
        mention_type: "agent",
        mention_id: agentId,
        display_text: `@${agentId}`,
      })),
    },
    reason: "deterministic_stage_organizer_kickoff",
  };
}

function deterministicStageOwnerKickoffExecution(state, runtimeContext, message = {}) {
  const workflowStageCard = dictValue(runtimeContext?.workflow_stage_card);
  const currentRole = normalizedSectionToken(
    firstNonEmpty(dictValue(runtimeContext?.role_card).current_agent_role, dictValue(runtimeContext?.role_card).server_gate_role),
  );
  if (!currentRole || currentRole === "manager" || !stageTransitionIntoCurrentStage(runtimeContext, message)) {
    return null;
  }
  if (!allowsDeterministicArtifactFallback(runtimeContext)) {
    return null;
  }
  const organizerRole = normalizedSectionToken(firstNonEmpty(workflowStageCard.organizer_role));
  if (organizerRole && organizerRole === currentRole) {
    return null;
  }
  if (!ownerTokenMatchesCurrentRole(firstNonEmpty(workflowStageCard.owner), runtimeContext)) {
    return null;
  }
  const expectedKinds = expectedBusinessArtifactKinds(runtimeContext);
  const stageArtifactPayload = deterministicStageArtifactScaffold(runtimeContext);
  if (!expectedKinds.length || !Object.keys(stageArtifactPayload).length) {
    return null;
  }
  const allowedActionModules = listValue(workflowStageCard.allowed_action_modules).map((item) => normalizeActionModuleId(item)).filter(Boolean);
  const actionId =
    allowedActionModules.includes("review_artifact") && !allowedActionModules.includes("submit_artifact")
      ? "review_artifact"
      : allowedActionModules.includes("submit_artifact")
        ? "submit_artifact"
        : "";
  if (!actionId) {
    return null;
  }
  const preview = renderArtifactPreview(stageArtifactPayload, expectedKinds);
  const currentStage = firstNonEmpty(
    dictValue(runtimeContext?.execution_stage_card).stage_id,
    dictValue(runtimeContext?.runtime_session_card).current_stage,
  );
  const baseText =
    actionId === "review_artifact"
      ? `我现在对 ${currentStage || "当前阶段"} 的输入产物进行审核并发布本阶段评审结果。`
      : `我现在提交 ${currentStage || "当前阶段"} 所需产物。`;
  return {
    should_send: true,
    flow_type: "run",
    message_type: "analysis",
    text: preview ? appendArtifactPreviewToText(baseText, preview) : baseText,
    payload: {
      ...stageArtifactPayload,
      action_id: actionId,
    },
    reason: "deterministic_stage_owner_kickoff",
  };
}

function actionModuleConsumerFollowUpFallback(execution, message, runtimeContext = {}, state = {}) {
  const incomingActionRef = resolveActionModuleReference(message);
  const incomingContract = dictValue(incomingActionRef.contract);
  const incomingActionId = firstNonEmpty(incomingActionRef.action_id);
  const followUpActionId = firstNonEmpty(
    fallbackConsumerFollowUpActionId(incomingActionId, runtimeContext, state),
    incomingContract.consumer_follow_up_action_id,
  );
  if (!followUpActionId) {
    return null;
  }

  const followUpContract = dictValue(getActionModule(followUpActionId));
  if (!Object.keys(followUpContract).length) {
    return null;
  }

  const incomingTitle = firstNonEmpty(incomingContract.title, incomingActionId, "incoming_action");
  const followUpTitle = firstNonEmpty(followUpContract.title, followUpActionId);
  const followUpSummary = firstNonEmpty(followUpContract.semantic_meaning, followUpContract.intent);
  const incomingText = truncateText(firstNonEmpty(dictValue(message?.content).text, message?.text), 160);
  const baseText = [
    `收到上一条 ${incomingTitle}。`,
    `现执行 ${followUpTitle}（${followUpActionId}）完成当前消费者交接。`,
    followUpSummary ? `本次跟进：${followUpSummary}。` : "",
    incomingText ? `关联内容：${incomingText}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const pendingFormalSignal = dictValue(runtimeContext?.pending_formal_signal_card);
  const expectedKinds = expectedStageArtifactKinds(runtimeContext);
  const canAttachDeterministicStageArtifact =
    expectedKinds.length > 0 &&
    allowsDeterministicArtifactFallback(runtimeContext);
  const shouldAttachStageArtifact =
    ["submit_artifact", "review_artifact", "resubmit_artifact"].includes(followUpActionId) ||
    (
      followUpActionId === "close_or_handoff" &&
      normalizedSectionToken(firstNonEmpty(pendingFormalSignal.producer_role)) === "manager"
    );
  const stageArtifactPayload =
    shouldAttachStageArtifact && canAttachDeterministicStageArtifact
      ? deterministicStageArtifactScaffold(runtimeContext)
      : {};
  if (shouldAttachStageArtifact && expectedKinds.length > 0 && !Object.keys(stageArtifactPayload).length) {
    return null;
  }
  const shouldAttachFormalStatus =
    followUpActionId === "close_or_handoff" &&
    normalizedSectionToken(firstNonEmpty(pendingFormalSignal.producer_role)) === "manager" &&
    expectedKinds.length > 0;
  const stageArtifactPreview =
    shouldAttachStageArtifact && Object.keys(stageArtifactPayload).length
      ? renderArtifactPreview(stageArtifactPayload, expectedKinds)
      : "";
  const text = stageArtifactPreview ? appendArtifactPreviewToText(baseText, stageArtifactPreview) : baseText;
  const statusBlock =
    shouldAttachFormalStatus && Object.keys(stageArtifactPayload).length
      ? {
          workflow_id: firstNonEmpty(dictValue(runtimeContext?.runtime_session_card).workflow_id),
          step_id: firstNonEmpty(
            pendingFormalSignal.step_id,
            dictValue(runtimeContext?.execution_stage_card).stage_id,
            dictValue(runtimeContext?.runtime_session_card).current_stage,
          ),
          lifecycle_phase: firstNonEmpty(pendingFormalSignal.lifecycle_phase, "result"),
          author_role: "manager",
          author_agent_id: firstNonEmpty(state?.agentId),
          step_status: firstNonEmpty(pendingFormalSignal.step_status),
          related_message_id: firstNonEmpty(message?.id),
        }
      : dictValue(execution?.status_block);

  return {
    should_send: true,
    flow_type: firstNonEmpty(execution?.flow_type, message?.flow_type, "run"),
    message_type: normalizeOutboundMessageType(firstNonEmpty(execution?.message_type, message?.message_type, "analysis")),
    text,
    payload: pruneNullish({
      ...dictValue(execution?.payload),
      ...stageArtifactPayload,
      action_id: followUpActionId,
      consumer_follow_up_to_action_id: incomingActionId || null,
      consumer_follow_up_to_message_id: firstNonEmpty(message?.id) || null,
    }),
    status_block: statusBlock,
    context_block: dictValue(execution?.context_block),
    routing: dictValue(execution?.routing),
    relations: dictValue(execution?.relations),
    extensions: {
      ...dictValue(execution?.extensions),
      custom: {
        ...dictValue(dictValue(execution?.extensions).custom),
        action_id: followUpActionId,
        consumer_follow_up_fallback: true,
        consumer_follow_up_to_action_id: incomingActionId || null,
        stage_artifact_scaffold_attached: shouldAttachStageArtifact && Object.keys(stageArtifactPayload).length > 0,
      },
    },
    reason:
      shouldAttachStageArtifact && Object.keys(stageArtifactPayload).length
        ? "action_module_consumer_follow_up_artifactful_close_fallback"
        : "action_module_consumer_follow_up_fallback",
  };
}

function enrichExecutionStatusBlock(decision, state, runtimeContext, message) {
  const statusBlock = dictValue(decision?.status_block);
  if (!Object.keys(statusBlock).length) {
    return decision;
  }
  const roleCard = dictValue(runtimeContext?.role_card);
  const executionStageCard = dictValue(runtimeContext?.execution_stage_card);
  const runtimeSessionCard = dictValue(runtimeContext?.runtime_session_card);
  const enrichedStatusBlock = pruneNullish({
    ...statusBlock,
    workflow_id: firstNonEmpty(statusBlock.workflow_id, runtimeSessionCard.workflow_id),
    step_id: firstNonEmpty(statusBlock.step_id, executionStageCard.stage_id, runtimeSessionCard.current_stage),
    lifecycle_phase: firstNonEmpty(
      statusBlock.lifecycle_phase,
      decision?.flow_type === "result" ? "result" : decision?.flow_type === "start" ? "start" : "run",
    ),
    author_role: firstNonEmpty(statusBlock.author_role, roleCard.current_agent_role, roleCard.server_gate_role),
    author_agent_id: firstNonEmpty(statusBlock.author_agent_id, state?.agentId),
    related_message_id: firstNonEmpty(statusBlock.related_message_id, message?.id),
  });
  return {
    ...decision,
    status_block: enrichedStatusBlock,
  };
}

function missingFormalStatusFields(statusBlock) {
  const block = dictValue(statusBlock);
  return [
    "workflow_id",
    "step_id",
    "lifecycle_phase",
    "author_role",
    "author_agent_id",
    "step_status",
  ].filter((key) => !firstNonEmpty(block[key]));
}

function isGenericFormalStepStatus(stepStatus) {
  const normalized = String(stepStatus || "").trim().toLowerCase();
  return [
    "start",
    "started",
    "run",
    "running",
    "in_progress",
    "complete",
    "completed",
    "done",
    "close",
    "closed",
  ].includes(normalized);
}

function acceptedStageStatuses(executionStageCard, lifecyclePhase, authorRole) {
  return listValue(executionStageCard?.accepted_status_rules || executionStageCard?.accepted_status_blocks)
    .flatMap((item) => {
      const rule = dictValue(item);
      const allowedRoles = listValue(rule.allowed_roles);
      if (firstNonEmpty(rule.lifecycle_phase) && rule.lifecycle_phase !== lifecyclePhase) {
        return [];
      }
      if (allowedRoles.length && !allowedRoles.includes(authorRole)) {
        return [];
      }
      return listValue(rule.step_statuses).filter(Boolean);
    })
    .filter((value, index, array) => array.indexOf(value) === index);
}

function stageDefinedStatuses(executionStageCard, lifecyclePhase) {
  return listValue(executionStageCard?.accepted_status_rules || executionStageCard?.accepted_status_blocks)
    .flatMap((item) => {
      const rule = dictValue(item);
      if (firstNonEmpty(rule.lifecycle_phase) && rule.lifecycle_phase !== lifecyclePhase) {
        return [];
      }
      return listValue(rule.step_statuses).filter(Boolean);
    })
    .filter((value, index, array) => array.indexOf(value) === index);
}

function firstAcceptedStepStatus(...sources) {
  for (const source of sources) {
    const status = firstNonEmpty(...listValue(source));
    if (status) {
      return status;
    }
  }
  return "";
}

function uniqueNonEmpty(values = []) {
  return values.filter(Boolean).filter((value, index, array) => array.indexOf(value) === index);
}

function actualRoleCandidates(roleCard) {
  const card = dictValue(roleCard);
  return uniqueNonEmpty([
    firstNonEmpty(card.server_gate_role),
    firstNonEmpty(card.current_agent_role),
  ]);
}

function firstFormalStepStatus(source) {
  const block = dictValue(source);
  const nestedStatusBlock = dictValue(block.status_block || block.statusBlock);
  return firstNonEmpty(
    block.step_status,
    firstAcceptedStepStatus(block.step_statuses),
    nestedStatusBlock.step_status,
    firstAcceptedStepStatus(nestedStatusBlock.step_statuses),
  );
}

function canonicalFormalStepStatus(stepStatus, executionStageCard, nextExecutionStageCard, lifecyclePhase, authorRole) {
  const acceptedStatuses = acceptedStageStatuses(executionStageCard, lifecyclePhase, authorRole);
  const nextAcceptedStatuses = acceptedStageStatuses(nextExecutionStageCard, lifecyclePhase, authorRole);
  const anyDefinedStatuses = [
    ...stageDefinedStatuses(executionStageCard, lifecyclePhase),
    ...stageDefinedStatuses(nextExecutionStageCard, lifecyclePhase),
  ].filter((value, index, array) => array.indexOf(value) === index);
  const current = firstNonEmpty(stepStatus);
  if (!acceptedStatuses.length && !nextAcceptedStatuses.length) {
    if (anyDefinedStatuses.length) {
      return "";
    }
    return current;
  }
  if (!current) {
    return firstNonEmpty(acceptedStatuses[0], nextAcceptedStatuses[0]);
  }
  if (acceptedStatuses.includes(current)) {
    return current;
  }
  if (nextAcceptedStatuses.includes(current)) {
    return current;
  }
  if (isGenericFormalStepStatus(current)) {
    return firstNonEmpty(acceptedStatuses[0], nextAcceptedStatuses[0]);
  }
  return "";
}

function stageCardAcceptsStatus(stageCard, stepStatus, lifecyclePhase, authorRole) {
  const status = firstNonEmpty(stepStatus);
  if (!status) {
    return false;
  }
  return acceptedStageStatuses(stageCard, lifecyclePhase, authorRole).includes(status);
}

function canonicalFormalStepId(rawStepId, stepStatus, executionStageCard, nextExecutionStageCard, runtimeSessionCard, lifecyclePhase, authorRole) {
  const explicitStepId = firstNonEmpty(rawStepId);
  const currentStageId = firstNonEmpty(executionStageCard.stage_id, runtimeSessionCard.current_stage);
  const nextStageId = firstNonEmpty(
    nextExecutionStageCard.stage_id,
    executionStageCard.next_stage,
    runtimeSessionCard.gate?.next_stage,
  );
  const currentAccepts = stageCardAcceptsStatus(executionStageCard, stepStatus, lifecyclePhase, authorRole);
  const nextAccepts = stageCardAcceptsStatus(nextExecutionStageCard, stepStatus, lifecyclePhase, authorRole);

  if (nextAccepts && !currentAccepts) {
    return firstNonEmpty(nextStageId, explicitStepId, currentStageId);
  }
  if (currentAccepts && !nextAccepts) {
    return firstNonEmpty(currentStageId, explicitStepId, nextStageId);
  }
  return firstNonEmpty(explicitStepId, currentStageId, nextStageId);
}

function preferredFormalAuthorRole(executionStageCard, nextExecutionStageCard, lifecyclePhase, roleCard, ...explicitRoles) {
  const actualCandidates = actualRoleCandidates(roleCard);
  const explicitCandidates = uniqueNonEmpty(explicitRoles.map((value) => firstNonEmpty(value)));
  for (const role of actualCandidates) {
    if (
      acceptedStageStatuses(executionStageCard, lifecyclePhase, role).length ||
      acceptedStageStatuses(nextExecutionStageCard, lifecyclePhase, role).length
    ) {
      return role;
    }
  }
  if (!actualCandidates.length) {
    for (const role of explicitCandidates) {
      if (
        acceptedStageStatuses(executionStageCard, lifecyclePhase, role).length ||
        acceptedStageStatuses(nextExecutionStageCard, lifecyclePhase, role).length
      ) {
        return role;
      }
    }
  }
  return firstNonEmpty(...actualCandidates, ...explicitCandidates);
}

function pendingFormalSignalForAuthor(runtimeContext, authorRole) {
  const pending = dictValue(runtimeContext?.pending_formal_signal_card);
  if (!Object.keys(pending).length) {
    return {};
  }
  if (
    firstNonEmpty(pending.producer_role) &&
    firstNonEmpty(pending.producer_role) !== firstNonEmpty(authorRole)
  ) {
    return {};
  }
  const currentStageId = firstNonEmpty(
    dictValue(runtimeContext?.execution_stage_card).stage_id,
    dictValue(runtimeContext?.runtime_session_card).current_stage,
  );
  const pendingStepId = firstNonEmpty(pending.step_id, pending.stage_id);
  if (pendingStepId && currentStageId && pendingStepId !== currentStageId) {
    return {};
  }
  if (!firstNonEmpty(pending.step_status) || !firstNonEmpty(pending.lifecycle_phase)) {
    return {};
  }
  return pending;
}

function deterministicPendingFormalSignalText(runtimeContext, authorRole) {
  const stageGoal = firstNonEmpty(
    dictValue(runtimeContext?.workflow_stage_card).goal,
    dictValue(runtimeContext?.group_objective_card).group_objective,
    dictValue(runtimeContext?.runtime_session_card).current_stage,
  );
  if (authorRole === "manager") {
    return stageGoal
      ? `我已确认当前阶段目标：${stageGoal}，现在按要求继续推进。`
      : "我已确认当前阶段目标，现按要求继续推进。";
  }
  return stageGoal
    ? `我已理解当前阶段目标与分工：${stageGoal}，将按要求继续推进。`
    : "我已理解当前阶段目标与分工，将按要求继续推进。";
}

function bootstrapProductContractLines(runtimeContext) {
  const productContractCard = dictValue(runtimeContext?.product_contract_card);
  const lines = [];
  if (firstNonEmpty(productContractCard.language)) {
    lines.push(`- 语言：${productContractCard.language}`);
  }
  if (listValue(productContractCard.sections).length) {
    lines.push(`- 板块：${listValue(productContractCard.sections).join("、")}`);
  }
  if (productContractCard.target_items_per_section) {
    lines.push(`- 每板块目标条数：${productContractCard.target_items_per_section}`);
  }
  if (firstNonEmpty(productContractCard.news_time_window)) {
    lines.push(`- 新闻时间窗口：${productContractCard.news_time_window}`);
  }
  if (firstNonEmpty(productContractCard.final_delivery_shape)) {
    lines.push(`- 最终交付：${productContractCard.final_delivery_shape}`);
  }
  return lines;
}

function deterministicBootstrapControlTurnText(runtimeContext) {
  const bootstrapCard = dictValue(runtimeContext?.bootstrap_control_turn_card);
  const pendingFormalSignal = dictValue(runtimeContext?.pending_formal_signal_card);
  const currentStage = firstNonEmpty(bootstrapCard.current_stage, pendingFormalSignal.step_id);
  const stageGoal = firstNonEmpty(
    dictValue(runtimeContext?.workflow_stage_card).goal,
    dictValue(runtimeContext?.group_objective_card).group_objective,
    currentStage,
  );
  const groupObjective = firstNonEmpty(dictValue(runtimeContext?.group_objective_card).group_objective);
  const assignmentResolution = dictValue(runtimeContext?.assignment_resolution_card);
  const managerAgentId = firstNonEmpty(assignmentResolution.manager_agent_id);
  const workerAgentIds = listValue(assignmentResolution.worker_agent_ids).filter(Boolean);
  const pendingStatus = firstNonEmpty(bootstrapCard.step_status, pendingFormalSignal.step_status);
  const lines = [];

  if (currentStage === "step0" && pendingStatus === "step0_done") {
    lines.push("各位协作代理好，现在启动本轮群组协作。");
    if (groupObjective) {
      lines.push(`组目标：${groupObjective}`);
    }
    const contractLines = bootstrapProductContractLines(runtimeContext);
    if (contractLines.length) {
      lines.push("产品要求：");
      lines.push(...contractLines);
    }
    if (managerAgentId) {
      lines.push(`管理代理：${managerAgentId}`);
    }
    if (workerAgentIds.length) {
      lines.push(`协作代理：${workerAgentIds.join("、")}`);
    }
    lines.push("当前阶段：step0 已完成。");
    lines.push("下一阶段：进入 step1，请所有非管理角色各自发送一条明确的理解对齐消息，并携带正式信号 step1_submitted。");
    lines.push("step1 期间不进行业务内容生产。");
    return lines.join("\n");
  }

  if (currentStage === "step1" && pendingStatus === "step1_start") {
    lines.push("现在进入 step1（理解对齐阶段）。");
    lines.push(`阶段目标：${stageGoal}`);
    lines.push("请所有非管理角色各自发送一条明确的理解对齐消息，并携带正式信号 step1_submitted。");
    lines.push("manager 只在收齐全部 step1 对齐确认后关闭本阶段。");
    return lines.join("\n");
  }

  if (currentStage === "step2" && pendingStatus === "step2_start") {
    lines.push("现在进入 step2（启动前 readiness 确认阶段）。");
    lines.push(`阶段目标：${stageGoal}`);
    lines.push("请所有非管理角色确认可执行性或明确 blocker，并携带正式信号 step2_submitted、step2_ready 或 task_ready 中与当前状态一致的一项。");
    lines.push("manager 只在收齐全部 readiness 或 blocker 结果后关闭本阶段，并进入 formal_start。");
    return lines.join("\n");
  }

  if (currentStage === "formal_start" && pendingStatus === "formal_start") {
    lines.push("bootstrap 已完成，现在进入 formal_start。");
    lines.push(`阶段目标：${stageGoal}`);
    lines.push("manager 现在正式宣布启动业务工作流，并把群组切换到 cycle.start。");
    lines.push("下一步由 manager 发布本轮 cycle task plan，随后进入 tester 主导的 material.collect。");
    return lines.join("\n");
  }

  return deterministicPendingFormalSignalText(runtimeContext, "manager");
}

function deterministicBootstrapControlTurnExecution(state, runtimeContext, message, judgment = null) {
  const bootstrapCard = dictValue(runtimeContext?.bootstrap_control_turn_card);
  const roleCard = dictValue(runtimeContext?.role_card);
  const executionStageCard = dictValue(runtimeContext?.execution_stage_card);
  const runtimeSessionCard = dictValue(runtimeContext?.runtime_session_card);
  const pendingFormalSignal = pendingFormalSignalForAuthor(runtimeContext, "manager");
  if (
    firstNonEmpty(roleCard.current_agent_role) !== "manager" ||
    !Object.keys(bootstrapCard).length ||
    !bootstrapCard.text_first_control_message_allowed ||
    !Object.keys(pendingFormalSignal).length
  ) {
    return null;
  }
  const requiredAgentIds = listValue(pendingFormalSignal.required_agent_ids).filter(Boolean);
  if (requiredAgentIds.length && state?.agentId && !requiredAgentIds.includes(state.agentId)) {
    return null;
  }
  return {
    should_send: true,
    flow_type: firstNonEmpty(pendingFormalSignal.lifecycle_phase),
    message_type: "analysis",
    text: deterministicBootstrapControlTurnText(runtimeContext),
    payload: {
      action_id: "close_or_handoff",
      intent: "bootstrap_control_turn",
      reason: firstNonEmpty(judgment?.obligation?.reason, "server_manager_control_turn"),
      step_status: firstNonEmpty(pendingFormalSignal.step_status),
      lifecycle_phase: firstNonEmpty(pendingFormalSignal.lifecycle_phase),
    },
    status_block: {
      workflow_id: firstNonEmpty(runtimeSessionCard.workflow_id),
      step_id: firstNonEmpty(pendingFormalSignal.step_id, executionStageCard.stage_id, runtimeSessionCard.current_stage),
      lifecycle_phase: firstNonEmpty(pendingFormalSignal.lifecycle_phase),
      author_role: "manager",
      author_agent_id: firstNonEmpty(state?.agentId),
      step_status: firstNonEmpty(pendingFormalSignal.step_status),
      related_message_id: firstNonEmpty(message?.id),
    },
    reason: "deterministic_bootstrap_control_turn",
  };
}

function deterministicPendingFormalSignalExecution(state, runtimeContext, message, execution = null) {
  const roleCard = dictValue(runtimeContext?.role_card);
  const executionStageCard = dictValue(runtimeContext?.execution_stage_card);
  const nextExecutionStageCard = dictValue(runtimeContext?.next_execution_stage_card);
  const runtimeSessionCard = dictValue(runtimeContext?.runtime_session_card);
  const pendingRole = firstNonEmpty(dictValue(runtimeContext?.pending_formal_signal_card).producer_role);
  const lifecyclePhase = firstNonEmpty(dictValue(runtimeContext?.pending_formal_signal_card).lifecycle_phase);
  const authorRole = preferredFormalAuthorRole(
    executionStageCard,
    nextExecutionStageCard,
    lifecyclePhase,
    roleCard,
    pendingRole,
  );
  const pendingFormalSignal = pendingFormalSignalForAuthor(runtimeContext, authorRole);
  if (!Object.keys(pendingFormalSignal).length) {
    return null;
  }
  const requiredAgentIds = listValue(pendingFormalSignal.required_agent_ids).filter(Boolean);
  if (requiredAgentIds.length && state?.agentId && !requiredAgentIds.includes(state.agentId)) {
    return null;
  }
  const expectedKinds = expectedBusinessArtifactKinds(runtimeContext);
  const stepStatus = firstNonEmpty(pendingFormalSignal.step_status);
  if (!stepStatus || !lifecyclePhase) {
    return null;
  }
  if (expectedKinds.length) {
    if (
      normalizedSectionToken(authorRole) !== "manager" ||
      !allowsDeterministicArtifactFallback(runtimeContext)
    ) {
      return null;
    }
    const stageArtifactPayload = deterministicStageArtifactScaffold(runtimeContext);
    if (!Object.keys(stageArtifactPayload).length) {
      return null;
    }
    const stageArtifactPreview = renderArtifactPreview(stageArtifactPayload, expectedKinds);
    const baseText = deterministicPendingFormalSignalText(runtimeContext, authorRole);
    return {
      should_send: true,
      flow_type: lifecyclePhase === "result" ? "result" : lifecyclePhase === "start" ? "start" : "run",
      message_type: "analysis",
      text: stageArtifactPreview ? appendArtifactPreviewToText(baseText, stageArtifactPreview) : baseText,
      payload: stageArtifactPayload,
      status_block: {
        workflow_id: firstNonEmpty(runtimeSessionCard.workflow_id),
        step_id: firstNonEmpty(pendingFormalSignal.step_id, executionStageCard.stage_id, runtimeSessionCard.current_stage),
        lifecycle_phase: lifecyclePhase,
        author_role: authorRole,
        author_agent_id: firstNonEmpty(state?.agentId),
        step_status: stepStatus,
        related_message_id: firstNonEmpty(message?.id),
      },
      reason: "deterministic_pending_formal_signal_artifact_fallback",
    };
  }
  return {
    should_send: true,
    flow_type: lifecyclePhase === "result" ? "result" : lifecyclePhase === "start" ? "start" : "run",
    message_type: "analysis",
    text: deterministicPendingFormalSignalText(runtimeContext, authorRole),
    payload: {},
    status_block: {
      workflow_id: firstNonEmpty(runtimeSessionCard.workflow_id),
      step_id: firstNonEmpty(pendingFormalSignal.step_id, executionStageCard.stage_id, runtimeSessionCard.current_stage),
      lifecycle_phase: lifecyclePhase,
      author_role: authorRole,
      author_agent_id: firstNonEmpty(state?.agentId),
      step_status: stepStatus,
      related_message_id: firstNonEmpty(message?.id),
    },
    reason: firstNonEmpty(execution?.reason, "deterministic_pending_formal_signal_fallback"),
  };
}

function executionSatisfiesPendingFormalSignal(execution, runtimeContext) {
  const source = dictValue(execution);
  const roleCard = dictValue(runtimeContext?.role_card);
  const executionStageCard = dictValue(runtimeContext?.execution_stage_card);
  const nextExecutionStageCard = dictValue(runtimeContext?.next_execution_stage_card);
  const pendingRole = firstNonEmpty(dictValue(runtimeContext?.pending_formal_signal_card).producer_role);
  const lifecyclePhase = firstNonEmpty(dictValue(runtimeContext?.pending_formal_signal_card).lifecycle_phase);
  const authorRole = preferredFormalAuthorRole(
    executionStageCard,
    nextExecutionStageCard,
    lifecyclePhase,
    roleCard,
    pendingRole,
  );
  const pendingFormalSignal = pendingFormalSignalForAuthor(runtimeContext, authorRole);
  if (!Object.keys(pendingFormalSignal).length) {
    return false;
  }
  const statusBlock = dictValue(source.status_block);
  if (!Object.keys(statusBlock).length) {
    return false;
  }
  return (
    firstNonEmpty(statusBlock.step_status) === firstNonEmpty(pendingFormalSignal.step_status) &&
    firstNonEmpty(statusBlock.lifecycle_phase) === firstNonEmpty(pendingFormalSignal.lifecycle_phase) &&
    firstNonEmpty(statusBlock.author_role, authorRole) === authorRole
  );
}

function normalizeOutboundStatusBlock(statusBlock, payload, state, runtimeContext, sendContext = {}) {
  const block = dictValue(statusBlock);
  if (!Object.keys(block).length) {
    return {};
  }
  const content = dictValue(payload?.content);
  const payloadData = dictValue(content.payload);
  const payloadStatus = dictValue(
    payloadData.status_block ||
    payloadData.statusBlock,
  );
  const semantics = dictValue(payload?.semantics);
  const extensions = dictValue(payload?.extensions);
  const custom = dictValue(extensions.custom);
  const roleCard = dictValue(runtimeContext?.role_card);
  const executionStageCard = dictValue(runtimeContext?.execution_stage_card);
  const nextExecutionStageCard = dictValue(runtimeContext?.next_execution_stage_card);
  const runtimeSessionCard = dictValue(runtimeContext?.runtime_session_card);
  let lifecyclePhase = firstNonEmpty(
    block.lifecycle_phase,
    payloadStatus.lifecycle_phase,
    payloadData.lifecycle_phase,
    semantics.lifecycle_phase,
    payload?.flow_type === "result" ? "result" : payload?.flow_type === "start" ? "start" : "run",
  );
  const authorRole = preferredFormalAuthorRole(
    executionStageCard,
    nextExecutionStageCard,
    lifecyclePhase,
    roleCard,
    block.author_role,
    payloadStatus.author_role,
    payloadData.author_role,
    semantics.author_role,
  );
  const pendingFormalSignal = pendingFormalSignalForAuthor(runtimeContext, authorRole);
  let stepStatus = canonicalFormalStepStatus(
    firstNonEmpty(
      block.step_status,
      firstAcceptedStepStatus(block.step_statuses),
      payloadStatus.step_status,
      firstAcceptedStepStatus(payloadStatus.step_statuses),
      payloadData.step_status,
      firstAcceptedStepStatus(payloadData.step_statuses),
      semantics.step_status,
    ),
    executionStageCard,
    nextExecutionStageCard,
    lifecyclePhase,
    authorRole,
  );
  const expectedKinds = expectedStageArtifactKinds(runtimeContext);
  if (
    Object.keys(pendingFormalSignal).length &&
    stageCardAcceptsStatus(
      executionStageCard,
      pendingFormalSignal.step_status,
      pendingFormalSignal.lifecycle_phase,
      authorRole,
    ) &&
    (
      !expectedKinds.length ||
      firstNonEmpty(pendingFormalSignal.lifecycle_phase) !== "result" ||
      normalizedSectionToken(firstNonEmpty(authorRole, pendingFormalSignal.producer_role)) !== "manager" ||
      managerFormalCloseHasEvidence(payload, null, runtimeContext)
    )
  ) {
    lifecyclePhase = firstNonEmpty(pendingFormalSignal.lifecycle_phase, lifecyclePhase);
    stepStatus = firstNonEmpty(pendingFormalSignal.step_status, stepStatus);
  }
  return pruneNullish({
    ...payloadStatus,
    ...block,
    workflow_id: firstNonEmpty(
      block.workflow_id,
      payloadStatus.workflow_id,
      payloadData.workflow_id,
      semantics.workflow_id,
      custom.workflow_id,
      runtimeSessionCard.workflow_id,
    ),
    step_id: canonicalFormalStepId(
      firstNonEmpty(
        block.step_id,
        payloadStatus.step_id,
        block.stage_id,
        payloadStatus.stage_id,
        payloadData.step_id,
        payloadData.stage_id,
        semantics.step_id,
        semantics.stage_id,
      ),
      stepStatus,
      executionStageCard,
      nextExecutionStageCard,
      runtimeSessionCard,
      lifecyclePhase,
      authorRole,
    ),
    lifecycle_phase: lifecyclePhase,
    author_role: authorRole,
    author_agent_id: firstNonEmpty(
      block.author_agent_id,
      payloadStatus.author_agent_id,
      payloadData.author_agent_id,
      state?.agentId,
    ),
    step_status: stepStatus,
    related_message_id: firstNonEmpty(
      block.related_message_id,
      payloadStatus.related_message_id,
      payloadData.related_message_id,
      sendContext.parent_message_id,
    ),
  }) || {};
}

function hasMeaningfulArtifactValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return Boolean(value.trim());
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasMeaningfulArtifactValue(item));
  }
  if (typeof value === "object") {
    return Object.values(value).some((item) => hasMeaningfulArtifactValue(item));
  }
  return false;
}

function payloadHasStructuredArtifact(payload) {
  const source = dictValue(payload);
  const artifactKeys = Object.keys(source).filter((key) => !["kind", "status_block", "statusBlock", "context_block", "contextBlock"].includes(key));
  return artifactKeys.some((key) => hasMeaningfulArtifactValue(source[key]));
}

function stageArtifactPayload(payload, expectedKinds = []) {
  const source = dictValue(payload);
  const kind = firstNonEmpty(source.kind);
  if (kind && (!expectedKinds.length || expectedKinds.includes(kind))) {
    return source;
  }
  for (const expectedKind of expectedKinds) {
    const nestedArtifact = dictValue(source[expectedKind]);
    if (Object.keys(nestedArtifact).length) {
      return {
        kind: expectedKind,
        ...nestedArtifact,
      };
    }
  }
  return {};
}

function previewItemLabel(item) {
  if (typeof item === "string") {
    return item.trim();
  }
  const source = dictValue(item);
  const title = firstNonEmpty(
    source.title,
    source.headline,
    source.name,
    source.section,
    source.summary,
    source.text,
    source.decision,
    source.recommendation,
    source.finding,
    source.note,
    source.source,
  );
  if (!title) {
    return "";
  }
  const detail = firstNonEmpty(source.source, source.published_at, source.url);
  if (detail && detail !== title) {
    return `${title} (${detail})`;
  }
  return title;
}

function renderPreviewList(label, value, limit = 4) {
  const items = listValue(value)
    .map((item) => previewItemLabel(item))
    .filter(Boolean)
    .slice(0, limit);
  if (!items.length) {
    return "";
  }
  return `${label}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function renderSectionsPreview(sections, limit = 4) {
  const rendered = listValue(sections)
    .slice(0, limit)
    .map((sectionEntry) => {
      const section = dictValue(sectionEntry);
      const sectionName = firstNonEmpty(section.section, section.name, section.title) || "section";
      const items = listValue(section.items)
        .map((item) => previewItemLabel(item))
        .filter(Boolean)
        .slice(0, 3);
      if (!items.length) {
        return "";
      }
      return `${sectionName}:\n${items.map((item) => `- ${item}`).join("\n")}`;
    })
    .filter(Boolean);
  return rendered.join("\n\n");
}

function truncateArtifactPreview(text, limit = 1600) {
  const normalized = String(text || "").trim();
  if (!normalized || normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function renderArtifactPreview(payload, expectedKinds = []) {
  const artifact = stageArtifactPayload(payload, expectedKinds);
  if (!Object.keys(artifact).length) {
    return "";
  }
  const parts = [];
  for (const key of ["body_markdown", "report_markdown", "product_body", "report", "draft", "summary", "final_summary", "decision", "stage_decision", "correction_request", "risk_note"]) {
    const value = artifact[key];
    if (typeof value === "string" && value.trim()) {
      parts.push(value.trim());
    }
  }
  const sectionsPreview = renderSectionsPreview(artifact.sections);
  if (sectionsPreview) {
    parts.push(sectionsPreview);
  }
  for (const [label, key] of [
    ["items", "items"],
    ["materials", "materials"],
    ["candidate_materials", "candidate_materials"],
    ["material_pool", "material_pool"],
    ["findings", "findings"],
    ["feedback", "feedback"],
    ["approved_items", "approved_items"],
    ["rejected_items", "rejected_items"],
    ["recommendations", "recommendations"],
    ["comparisons", "comparisons"],
    ["discussion_points", "discussion_points"],
    ["action_items", "action_items"],
    ["lessons", "lessons"],
    ["agenda", "agenda"],
    ["prompts", "prompts"],
    ["notes", "notes"],
    ["rules", "rules"],
  ]) {
    const preview = renderPreviewList(label, artifact[key]);
    if (preview) {
      parts.push(preview);
    }
  }
  return truncateArtifactPreview(parts.filter(Boolean).join("\n\n"));
}

function appendArtifactPreviewToText(text, preview) {
  const base = String(text || "").trim();
  const artifactPreview = String(preview || "").trim();
  if (!artifactPreview) {
    return base;
  }
  if (!base) {
    return artifactPreview;
  }
  if (base.includes(artifactPreview)) {
    return base;
  }
  const anchor = artifactPreview
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line.length >= 24);
  if (anchor && base.includes(anchor)) {
    return base;
  }
  return `${base}\n\n${artifactPreview}`;
}

function actualManagerAgentIds(runtimeContext) {
  return uniqueNonEmpty([
    ...listValue(dictValue(runtimeContext?.role_card).manager_agent_ids),
    firstNonEmpty(dictValue(runtimeContext?.assignment_resolution_card).manager_agent_id),
  ]);
}

function isActualManagerSender(statusBlock, runtimeContext) {
  const block = dictValue(statusBlock);
  const roleCard = dictValue(runtimeContext?.role_card);
  const roleCandidates = actualRoleCandidates(roleCard);
  const authorAgentId = firstNonEmpty(block.author_agent_id, roleCard.current_agent_id);
  const managerIds = actualManagerAgentIds(runtimeContext);
  if (managerIds.length && authorAgentId) {
    return managerIds.includes(authorAgentId);
  }
  return roleCandidates.includes("manager");
}

function looksLikeManagerSignal(statusBlock) {
  const block = dictValue(statusBlock);
  const stepStatus = normalizedSectionToken(firstNonEmpty(block.step_status));
  return Boolean(
    stepStatus.startsWith("manager_") ||
    normalizedSectionToken(firstNonEmpty(block.author_role)) === "manager"
  );
}

const STAGE_ARTIFACT_SHAPE_RULES = {
  cycle_task_plan: [
    "task_plan",
    "tasks",
    "assignments",
    "section_plans",
    "workstreams",
    "sections",
    "stages",
    "stage_decomposition",
    "worker_assignments",
    "cycle_goal",
    "cycle_objective",
    "current_stage_goal",
    "current_stage_acceptance",
    "acceptance_focus_for_material_collect",
    "handoff_expectations",
  ],
  candidate_material_pool: ["sections", "items", "materials", "candidate_materials", "material_pool"],
  material_review_feedback: ["findings", "feedback", "approved_items", "rejected_items", "section_reviews"],
  manager_stage_close_or_intra_stage_correction: ["decision", "stage_decision", "correction_request", "forced_proceed", "risk_note"],
  product_draft: ["sections", "items", "draft", "body_markdown", "report_markdown", "product_body"],
  proofread_feedback: ["issues", "findings", "feedback", "review_notes", "section_feedback"],
  revised_product_draft: ["sections", "items", "draft", "body_markdown", "report_markdown", "product_body"],
  recheck_feedback: ["issues", "findings", "feedback", "review_notes", "section_feedback"],
  publish_decision: ["decision", "stage_decision", "risk_note", "release_decision"],
  final_product_message: ["sections", "items", "body_markdown", "report_markdown", "product_body"],
  product_test_report: ["report", "findings", "issues", "evaluation", "metrics"],
  benchmark_report: ["report", "comparisons", "benchmarks", "findings"],
  cross_cycle_report: ["report", "comparisons", "findings", "delta"],
  product_evaluation_report: ["report", "summary", "findings", "recommendations"],
  retrospective_plan: ["agenda", "discussion_points", "items", "plan"],
  discussion_record: ["discussion_points", "messages", "records", "decisions", "summary"],
  retrospective_summary: ["summary", "lessons", "next_cycle_requirements", "action_items"],
  per_agent_optimization_prompts: ["prompts", "per_agent", "agent_prompts", "items"],
  per_agent_self_optimization_notes: ["notes", "per_agent", "agent_notes", "items"],
  applied_optimization_rules: ["rules", "applied_rules", "optimization_rules", "items"],
};

function expectedStageArtifactKinds(runtimeContext) {
  return listValue(dictValue(runtimeContext?.workflow_stage_card).output).filter(Boolean);
}

const TEXT_ONLY_BOOTSTRAP_STAGES = new Set(["step0", "step1", "step2", "formal_start"]);

function expectedBusinessArtifactKinds(runtimeContext) {
  const runtimeSessionCard = dictValue(runtimeContext?.runtime_session_card);
  const executionStageCard = dictValue(runtimeContext?.execution_stage_card);
  const currentMode = firstNonEmpty(runtimeSessionCard.current_mode);
  const currentStage = firstNonEmpty(executionStageCard.stage_id, runtimeSessionCard.current_stage);
  if (currentMode === "bootstrap" && TEXT_ONLY_BOOTSTRAP_STAGES.has(currentStage)) {
    return [];
  }
  return expectedStageArtifactKinds(runtimeContext);
}

function allowsDeterministicArtifactFallback(runtimeContext) {
  const currentMode = normalizedSectionToken(firstNonEmpty(dictValue(runtimeContext?.runtime_session_card).current_mode));
  return Boolean(
    currentMode === "action_module_validation" ||
    currentMode === "test"
  );
}

function payloadMatchesExpectedArtifactKind(payload, expectedKinds) {
  if (!expectedKinds.length) {
    return true;
  }
  return expectedKinds.includes(firstNonEmpty(dictValue(payload).kind));
}

function payloadHasExpectedArtifactShape(payload, expectedKinds) {
  const source = dictValue(payload);
  if (!Object.keys(source).length) {
    return false;
  }
  const kind = firstNonEmpty(source.kind);
  if (kind && payloadMatchesExpectedArtifactKind(source, expectedKinds)) {
    const requiredKeys = listValue(STAGE_ARTIFACT_SHAPE_RULES[kind]);
    if (requiredKeys.length) {
      return requiredKeys.some((key) => hasMeaningfulArtifactValue(source[key]));
    }
    return payloadHasStructuredArtifact(source);
  }
  return expectedKinds.some((expectedKind) => {
    const nestedArtifact = dictValue(source[expectedKind]);
    if (!Object.keys(nestedArtifact).length) {
      return false;
    }
    const requiredKeys = listValue(STAGE_ARTIFACT_SHAPE_RULES[expectedKind]);
    if (requiredKeys.length) {
      return requiredKeys.some((key) => hasMeaningfulArtifactValue(nestedArtifact[key]));
    }
    return payloadHasStructuredArtifact(nestedArtifact);
  });
}

function isManagerFormalClose(statusBlock, runtimeContext) {
  const block = dictValue(statusBlock);
  if (!isActualManagerSender(block, runtimeContext)) {
    return false;
  }
  if (firstNonEmpty(block.lifecycle_phase) !== "result") {
    return false;
  }
  const stepStatus = firstNonEmpty(block.step_status);
  if (!stepStatus) {
    return false;
  }
  return acceptedStageStatuses(dictValue(runtimeContext?.execution_stage_card), "result", "manager").includes(stepStatus);
}

function managerFormalCloseHasEvidence(requestBody, incomingMessage, runtimeContext) {
  const payload = dictValue(requestBody?.content?.payload);
  const incomingPayload = dictValue(incomingMessage?.content?.payload);
  const expectedKinds = expectedStageArtifactKinds(runtimeContext);
  if (expectedKinds.length) {
    if (payloadHasExpectedArtifactShape(payload, expectedKinds)) {
      return true;
    }
    if (payloadHasExpectedArtifactShape(incomingPayload, expectedKinds)) {
      return true;
    }
    return false;
  }
  const explicitEvidenceRefsPresent =
    hasMeaningfulArtifactValue(payload.evidence_refs) ||
    hasMeaningfulArtifactValue(payload.artifact_refs) ||
    hasMeaningfulArtifactValue(incomingPayload.evidence_refs) ||
    hasMeaningfulArtifactValue(incomingPayload.artifact_refs);
  if (payloadHasStructuredArtifact(payload)) {
    return true;
  }
  if (explicitEvidenceRefsPresent) {
    return true;
  }
  return payloadHasStructuredArtifact(incomingPayload);
}

function payloadHasExplicitManagerOverride(payload) {
  const source = dictValue(payload);
  const managerOverride = dictValue(source.manager_stage_close_or_intra_stage_correction);
  return [
    source.stage_decision,
    source.decision,
    source.forced_proceed,
    source.correction_request,
    source.risk_note,
    managerOverride.stage_decision,
    managerOverride.decision,
    managerOverride.forced_proceed,
    managerOverride.correction_request,
    managerOverride.risk_note,
  ].some((value) => hasMeaningfulArtifactValue(value));
}

function isManagerFinalStageSignal(statusBlock, runtimeContext) {
  const block = dictValue(statusBlock);
  if (!isActualManagerSender(block, runtimeContext)) {
    return false;
  }
  const lifecyclePhase = firstNonEmpty(block.lifecycle_phase);
  if (!["done", "result"].includes(lifecyclePhase)) {
    return false;
  }
  const stepStatus = firstNonEmpty(block.step_status);
  if (!stepStatus) {
    return false;
  }
  return acceptedStageStatuses(dictValue(runtimeContext?.execution_stage_card), lifecyclePhase, "manager").includes(stepStatus);
}

function managerFormalCloseBlockedByPendingNonManagerGate(statusBlock, requestBody, runtimeContext) {
  const normalizedStatusBlock = dictValue(statusBlock);
  if (!isManagerFinalStageSignal(normalizedStatusBlock, runtimeContext)) {
    return false;
  }
  const pendingFormalSignal = dictValue(runtimeContext?.pending_formal_signal_card);
  const pendingProducerRole = normalizedSectionToken(firstNonEmpty(pendingFormalSignal.producer_role));
  if (!pendingProducerRole || pendingProducerRole === "manager") {
    return false;
  }
  const payload = dictValue(requestBody?.content?.payload);
  return !payloadHasExplicitManagerOverride(payload);
}

function formalSignalHasArtifactEvidence(requestBody, runtimeContext, incomingMessage = null) {
  const payload = dictValue(requestBody?.content?.payload);
  const incomingPayload = dictValue(incomingMessage?.content?.payload);
  const expectedKinds = expectedStageArtifactKinds(runtimeContext);
  if (expectedKinds.length) {
    return (
      payloadHasExpectedArtifactShape(payload, expectedKinds) ||
      payloadHasExpectedArtifactShape(incomingPayload, expectedKinds)
    );
  }
  const explicitEvidenceRefsPresent =
    hasMeaningfulArtifactValue(payload.evidence_refs) ||
    hasMeaningfulArtifactValue(payload.artifact_refs) ||
    hasMeaningfulArtifactValue(incomingPayload.evidence_refs) ||
    hasMeaningfulArtifactValue(incomingPayload.artifact_refs);
  return payloadHasStructuredArtifact(payload) || payloadHasStructuredArtifact(incomingPayload) || explicitEvidenceRefsPresent;
}

function isDuplicateCurrentAgentFormalSignal(statusBlock, state, runtimeContext) {
  const block = dictValue(statusBlock);
  const observedStatuses = listValue(runtimeContext?.__current_agent_observed_statuses);
  const authorAgentId = firstNonEmpty(block.author_agent_id, state?.agentId);
  if (!Object.keys(block).length || !observedStatuses.length || !authorAgentId) {
    return false;
  }
  return hasObservedFormalStatus(observedStatuses, {
    step_id: firstNonEmpty(
      block.step_id,
      dictValue(runtimeContext?.execution_stage_card).stage_id,
      dictValue(runtimeContext?.runtime_session_card).current_stage,
    ),
    lifecycle_phase: firstNonEmpty(block.lifecycle_phase),
    step_status: firstNonEmpty(block.step_status),
    author_agent_id: authorAgentId,
  }, authorAgentId);
}

function suppressOutboundFormalSignal(requestBody, reason) {
  const content = dictValue(requestBody?.content);
  const payload = dictValue(content.payload);
  const nextPayload = { ...payload };
  delete nextPayload.status_block;
  delete nextPayload.statusBlock;
  return {
    ...requestBody,
    content: {
      ...content,
      payload: nextPayload,
    },
    status_block: {},
    extensions: {
      ...dictValue(requestBody?.extensions),
      custom: {
        ...dictValue(dictValue(requestBody?.extensions).custom),
        formal_signal_suppressed_reason: firstNonEmpty(reason),
      },
    },
  };
}

function enrichVisibleArtifactBody(requestBody, runtimeContext) {
  const content = dictValue(requestBody?.content);
  const payload = dictValue(content.payload);
  const expectedKinds = expectedStageArtifactKinds(runtimeContext);
  const preview = renderArtifactPreview(payload, expectedKinds);
  if (!preview) {
    return requestBody;
  }
  const nextText = appendArtifactPreviewToText(content.text, preview);
  if (nextText === firstNonEmpty(content.text)) {
    return requestBody;
  }
  return {
    ...requestBody,
    content: {
      ...content,
      text: nextText,
    },
  };
}

function isDuplicateManagerStageStart(statusBlock, runtimeContext = {}) {
  const block = dictValue(statusBlock);
  if (!Object.keys(block).length) {
    return false;
  }
  const stepStatus = firstNonEmpty(block.step_status);
  if (!stepStatus || firstNonEmpty(block.lifecycle_phase) !== "start") {
    return false;
  }
  const authorRole = normalizedSectionToken(
    firstNonEmpty(block.author_role, dictValue(runtimeContext?.role_card).current_agent_role),
  );
  const managerLikeStartToken = normalizedSectionToken(stepStatus).startsWith("manager_");
  if (authorRole !== "manager" && !managerLikeStartToken) {
    return false;
  }
  const runtimeSession = dictValue(runtimeContext?.runtime_session_card);
  const lastStatusBlock = dictValue(runtimeSession.last_status_block);
  if (!Object.keys(lastStatusBlock).length) {
    return false;
  }
  const currentStageId = firstNonEmpty(
    dictValue(runtimeContext?.execution_stage_card).stage_id,
    runtimeSession.current_stage,
  );
  const stepId = firstNonEmpty(block.step_id, currentStageId);
  return Boolean(
    stepId &&
    currentStageId &&
    stepId === currentStageId &&
    firstNonEmpty(lastStatusBlock.step_id) === stepId &&
    firstNonEmpty(lastStatusBlock.lifecycle_phase) === "start" &&
    normalizedSectionToken(firstNonEmpty(lastStatusBlock.author_role)) === "manager" &&
    firstNonEmpty(lastStatusBlock.step_status) === stepStatus
  );
}

async function fetchLiveLastStatusBlock(groupId, state) {
  const normalizedGroupId = String(groupId || "").trim();
  if (!normalizedGroupId) {
    return {};
  }
  try {
    const payload = await request(`/groups/${normalizedGroupId}/session`, { method: "GET", token: state.token });
    const session = dictValue(payload?.data || payload);
    const stateJson = dictValue(session.state_json);
    const block = dictValue(stateJson.last_status_block);
    if (!Object.keys(block).length) {
      return {};
    }
    return pruneNullish({
      step_id: firstNonEmpty(block.step_id, block.stage_id) || null,
      lifecycle_phase: firstNonEmpty(block.lifecycle_phase) || null,
      author_role: firstNonEmpty(block.author_role) || null,
      author_agent_id: firstNonEmpty(block.author_agent_id) || null,
      step_status: firstFormalStepStatus(block) || null,
      related_message_id: firstNonEmpty(block.related_message_id) || null,
    }) || {};
  } catch {
    return {};
  }
}

function isDuplicateManagerStageStartFromLiveSession(statusBlock, lastStatusBlock = {}, currentStageId = "") {
  const block = dictValue(statusBlock);
  const previous = dictValue(lastStatusBlock);
  if (!Object.keys(block).length || !Object.keys(previous).length) {
    return false;
  }
  const stepStatus = firstNonEmpty(block.step_status);
  const stepId = firstNonEmpty(block.step_id, currentStageId);
  const managerLikeStartToken = normalizedSectionToken(stepStatus).startsWith("manager_");
  return Boolean(
    stepStatus &&
    stepId &&
    firstNonEmpty(block.lifecycle_phase) === "start" &&
    (normalizedSectionToken(firstNonEmpty(block.author_role)) === "manager" || managerLikeStartToken) &&
    stepId === currentStageId &&
    firstNonEmpty(previous.step_id) === stepId &&
    firstNonEmpty(previous.lifecycle_phase) === "start" &&
    normalizedSectionToken(firstNonEmpty(previous.author_role)) === "manager" &&
    firstNonEmpty(previous.step_status) === stepStatus
  );
}

async function enrichOutboundFormalMessage(requestBody, state, sendContext = {}) {
  const statusBlock = dictValue(requestBody?.status_block);
  const needsAssignmentRouting = payloadHasGenericWorkerAssignments(requestBody?.content?.payload);
  if (!Object.keys(statusBlock).length && !needsAssignmentRouting) {
    return requestBody;
  }
  let runtimeContext = {};
  if (requestBody?.group_id) {
    try {
      runtimeContext = await fetchRuntimeContext(requestBody.group_id, state);
    } catch {
      runtimeContext = {};
    }
  }
  let nextRequestBody = requestBody;
  if (Object.keys(runtimeContext).length) {
    nextRequestBody = enrichOutboundAssignmentRouting(nextRequestBody, runtimeContext);
  }
  if (!Object.keys(statusBlock).length) {
    return nextRequestBody;
  }
  if (!Object.keys(runtimeContext).length) {
    if (!missingFormalStatusFields(statusBlock).length && !isGenericFormalStepStatus(statusBlock.step_status)) {
      return nextRequestBody;
    }
    return nextRequestBody;
  }
  const normalizedStatusBlock = normalizeOutboundStatusBlock(
    dictValue(nextRequestBody?.status_block),
    nextRequestBody,
    state,
    runtimeContext,
    sendContext,
  );
  const requestedManagerSignal = looksLikeManagerSignal(
    dictValue(nextRequestBody?.status_block).step_status || dictValue(nextRequestBody?.status_block).author_role
      ? dictValue(nextRequestBody?.status_block)
      : dictValue(dictValue(nextRequestBody?.content).payload.status_block || dictValue(nextRequestBody?.content).payload.statusBlock),
  );
  if (requestedManagerSignal && !isActualManagerSender({ author_agent_id: state?.agentId }, runtimeContext)) {
    return suppressOutboundFormalSignal(nextRequestBody, "non_manager_manager_signal");
  }
  if (!Object.keys(normalizedStatusBlock).length) {
    return {
      ...nextRequestBody,
      status_block: {},
    };
  }
  if (
    isDuplicateCurrentAgentFormalSignal(normalizedStatusBlock, state, runtimeContext) &&
    !formalSignalHasArtifactEvidence(nextRequestBody, runtimeContext, sendContext.incoming_message)
  ) {
    return suppressOutboundFormalSignal(nextRequestBody, "duplicate_current_agent_formal_status");
  }
  const liveLastStatusBlock = await fetchLiveLastStatusBlock(nextRequestBody?.group_id, state);
  const currentStageId = firstNonEmpty(
    normalizedStatusBlock.step_id,
    dictValue(runtimeContext?.execution_stage_card).stage_id,
    dictValue(runtimeContext?.runtime_session_card).current_stage,
  );
  if (
    isDuplicateManagerStageStart(normalizedStatusBlock, runtimeContext) ||
    isDuplicateManagerStageStartFromLiveSession(normalizedStatusBlock, liveLastStatusBlock, currentStageId)
  ) {
    return suppressOutboundFormalSignal(nextRequestBody, "duplicate_manager_stage_start");
  }
  if (managerFormalCloseBlockedByPendingNonManagerGate(normalizedStatusBlock, nextRequestBody, runtimeContext)) {
    return suppressOutboundFormalSignal(nextRequestBody, "pending_non_manager_gate");
  }
  if (
    isManagerFormalClose(normalizedStatusBlock, runtimeContext) &&
    !managerFormalCloseHasEvidence(nextRequestBody, sendContext.incoming_message, runtimeContext)
  ) {
    return suppressOutboundFormalSignal(nextRequestBody, "missing_stage_artifact_evidence");
  }
  const normalizedRequestBody = {
    ...nextRequestBody,
    status_block: normalizedStatusBlock,
  };
  if (isManagerFormalClose(normalizedStatusBlock, runtimeContext)) {
    return enrichVisibleArtifactBody(normalizedRequestBody, runtimeContext);
  }
  return normalizedRequestBody;
}

async function executeTask(message, state, runtimeContext, judgment = null) {
  const requestBody = {
    messages: buildExecutionPrompt(message, state, runtimeContext, judgment),
    temperature: 0.4,
    response_format: { type: "json_object" },
  };
  const payload = await requestModelJson(requestBody);
  const raw = payload.choices?.[0]?.message?.content?.trim() || "";
  const parsed = extractJsonObject(raw);
  if (parsed) {
    return enrichExecutionStatusBlock(
      normalizeConsumerFollowUpDecision(
        normalizeExecutionDecision(parsed, raw),
        state,
        message,
        runtimeContext,
      ),
      state,
      runtimeContext,
      message,
    );
  }
  return enrichExecutionStatusBlock(
    normalizeConsumerFollowUpDecision(
      normalizeExecutionDecision(
        {
          should_send: Boolean(raw),
          flow_type: "run",
          message_type: "analysis",
          text: raw,
          payload: {},
          reason: "unstructured_model_output",
        },
        raw,
      ),
      state,
      message,
      runtimeContext,
    ),
    state,
    runtimeContext,
    message,
  );
}

export async function fetchRuntimeContext(groupId, state) {
  const [protocolResult, channelResult, sessionResult] = await Promise.allSettled([
    request(`/groups/${groupId}/protocol`, { method: "GET", token: state.token }),
    request(`/groups/${groupId}/context`, { method: "GET", token: state.token }),
    request(`/groups/${groupId}/session`, { method: "GET", token: state.token }),
  ]);
  const protocolData = protocolResult.status === "fulfilled" ? protocolResult.value : {};
  const channelData = channelResult.status === "fulfilled" ? channelResult.value : {};
  const sessionData = sessionResult.status === "fulfilled" ? sessionResult.value : {};
  if (channelResult.status === "fulfilled") {
    await loadGroupContext(state, groupId, channelData);
  }
  if (
    protocolResult.status !== "fulfilled" &&
    channelResult.status !== "fulfilled" &&
    sessionResult.status !== "fulfilled"
  ) {
    throw new Error(`failed to fetch runtime context for ${groupId}`);
  }
  const protocolEnvelope = protocolData?.data?.protocol || protocolData?.protocol || protocolData || null;
  const envelopeGroupLayer = dictValue(protocolEnvelope?.layers?.group);
  const protocolGroupLayer = Object.keys(envelopeGroupLayer).length ? envelopeGroupLayer : resolveProtocolGroupLayer(protocolData);
  const channelGroupLayer = resolveProtocolGroupLayer(channelData);
  const storedWorkflowPayload = dictValue(storedPayloadForGroup(WORKFLOW_CONTRACT_PATH, groupId));
  const storedWorkflowGroupLayer = dictValue(storedWorkflowPayload.contract || storedWorkflowPayload);
  const groupLayer =
    Object.keys(protocolGroupLayer).length
      ? protocolGroupLayer
      : Object.keys(channelGroupLayer).length
        ? channelGroupLayer
        : storedWorkflowGroupLayer;
  if (Object.keys(groupLayer).length) {
    loadWorkflowContract(
      groupId,
      groupLayer,
      Object.keys(protocolGroupLayer).length
        ? "protocol_endpoint"
        : Object.keys(channelGroupLayer).length
          ? "context_endpoint"
          : "cached_contract",
    );
  }
  const session = sessionData?.data || sessionData || null;
  const members = dictValue(groupLayer?.members);
  const roleAssignments = dictValue(members.role_assignments);
  const workerAgentIds = listValue(members.worker_agent_ids);
  const executionSpec = executionSpecOf(groupLayer);
  const workflow = formalWorkflowOf(groupLayer);
  let currentAgentRole = null;
  for (const [role, config] of Object.entries(roleAssignments)) {
    if (dictValue(config).agent_id && dictValue(config).agent_id === state.agentId) {
      currentAgentRole = role;
      break;
    }
  }
  if (!currentAgentRole && members.manager_agent_id === state.agentId) {
    currentAgentRole = "manager";
  }
  if (!currentAgentRole && workerAgentIds.includes(state.agentId)) {
    currentAgentRole = "worker";
  }
  const stageCards = stageCardsFor(groupLayer, executionSpec, session?.current_stage);
  const roleCard = roleCardForAgent(groupLayer, executionSpec, state, currentAgentRole, workerAgentIds);
  const assignmentResolution = assignmentResolutionCard(groupLayer, state, workerAgentIds);
  const executionStageCard = {
    ...stageCards.execution_stage_card,
    execution_spec_id: executionSpec.execution_spec_id || session?.gate_snapshot?.execution_spec_id || null,
  };
  const runtimeSession = runtimeSessionCard(session);
  const pendingFormalSignal = pendingFormalSignalCard(session);
  const currentAgentObservedStatuses = compactObservedFormalStatuses(
    dictValue(session?.state_json).observed_statuses,
    state?.agentId,
  );
  const runtimeContext = {
    protocol_version: protocolEnvelope?.version || groupLayer?.protocol_meta?.protocol_version || session?.protocol_version || "unknown",
    group_slug:
      channelData?.data?.group?.slug ||
      channelData?.group_slug ||
      groupLayer?.group?.group_slug ||
      "",
    role_card: roleCard,
    group_objective_card: {
      group_type: groupLayer?.group_identity?.group_type || null,
      workflow_mode: groupLayer?.group_identity?.workflow_mode || null,
      group_objective: groupLayer?.group_identity?.group_objective || workflow?.goal || null,
    },
    product_contract_card: productContractCard(groupLayer),
    workflow_stage_card: stageCards.workflow_stage_card,
    execution_stage_card: executionStageCard,
    next_execution_stage_card: stageCards.next_execution_stage_card,
    runtime_session_card: runtimeSession,
    pending_formal_signal_card: pendingFormalSignal,
    assignment_resolution_card: assignmentResolution,
    transition_rules_card: transitionRulesCard(groupLayer),
    __current_agent_observed_statuses: currentAgentObservedStatuses,
  };
  return {
    ...runtimeContext,
    bootstrap_control_turn_card: bootstrapControlTurnCard(runtimeContext),
  };
}

function inferIntentFromText(text) {
  const source = String(text || "").toLowerCase();
  if (/(please|handle|reply|review|confirm|process|follow up|question|\?)/.test(source)) {
    return "request_action";
  }
  if (/(decide|decision|concluded|complete|done|result|summary)/.test(source)) {
    return "decide";
  }
  return "inform";
}

function inferFlowType(messageType, intent) {
  const loweredType = String(messageType || "").trim().toLowerCase();
  if (loweredType === "proposal") {
    return "start";
  }
  if (loweredType === "decision" || loweredType === "summary" || intent === "decide") {
    return "result";
  }
  if (["summary", "progress"].includes(loweredType)) {
    return "status";
  }
  return "run";
}

function normalizeOutboundFlowType(flowType, messageType = "", intent = "") {
  const lowered = String(flowType || "").trim().toLowerCase();
  if (["start", "run", "result", "status"].includes(lowered)) {
    return lowered;
  }
  if (["done", "complete", "completed", "close", "closed", "finish", "finished"].includes(lowered)) {
    return "result";
  }
  return inferFlowType(messageType, intent);
}

function normalizeOutboundMessageType(messageType) {
  const loweredType = String(messageType || "").trim().toLowerCase();
  const allowed = new Set([
    "proposal",
    "analysis",
    "question",
    "claim",
    "progress",
    "handoff",
    "review",
    "decision",
    "summary",
    "meta",
  ]);
  if (allowed.has(loweredType)) {
    return loweredType;
  }
  if (loweredType === "chat") {
    return "analysis";
  }
  return "analysis";
}

function structuredMentionForTarget(targetAgentId, targetAgent) {
  if (!targetAgentId) {
    return null;
  }
  const displayText = `@${String(targetAgent || targetAgentId).trim()}`;
  return {
    mention_type: "agent",
    mention_id: targetAgentId,
    display_text: displayText,
  };
}

function workerAliasMap(runtimeContext) {
  return dictValue(dictValue(runtimeContext?.assignment_resolution_card).worker_alias_to_agent_id);
}

function payloadHasGenericWorkerAssignments(payload) {
  const assignments = dictValue(dictValue(payload).worker_assignments);
  return Object.keys(assignments).some((key) => /^worker_[a-z]$/i.test(String(key || "").trim()));
}

function enrichOutboundAssignmentRouting(requestBody, runtimeContext) {
  const body = requestBody && typeof requestBody === "object" ? requestBody : {};
  const content = dictValue(body.content);
  const payload = dictValue(content.payload);
  const workerAssignments = dictValue(payload.worker_assignments);
  const aliasMap = workerAliasMap(runtimeContext);
  if (!Object.keys(workerAssignments).length || !Object.keys(aliasMap).length) {
    return body;
  }

  let changed = false;
  const resolvedAssignments = {
    ...dictValue(payload.resolved_worker_assignments),
  };
  const mentions = [...listValue(dictValue(body.routing).mentions)];

  for (const [alias, assignment] of Object.entries(workerAssignments)) {
    const agentId = firstNonEmpty(aliasMap[alias]);
    if (!agentId) {
      continue;
    }
    resolvedAssignments[agentId] = assignment;
    const mention = structuredMentionForTarget(agentId, agentId);
    if (mention && !mentions.some((item) => item && item.mention_id === mention.mention_id)) {
      mentions.push(mention);
    }
    changed = true;
  }

  if (!changed) {
    return body;
  }

  return {
    ...body,
    content: {
      ...content,
      payload: {
        ...payload,
        worker_assignment_aliases: {
          ...workerAliasMap(runtimeContext),
          ...dictValue(payload.worker_assignment_aliases),
        },
        resolved_worker_assignments: resolvedAssignments,
      },
    },
    routing: {
      ...dictValue(body.routing),
      mentions,
    },
  };
}

function responseModeLabel(mode) {
  return (
    {
      start: "start",
      run: "run",
      result: "result",
      status: "status",
      unknown: "unknown",
      system: "system",
      protocol_violation: "protocol_violation",
      workflow_contract: "workflow_contract",
      group_context: "group_context",
    }[String(mode || "").trim()] || "unknown"
  );
}

function dictValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function listValue(value) {
  return Array.isArray(value) ? value : [];
}

function canonicalMessageFromPayload(sendContext, payload, state) {
  const source = payload && typeof payload === "object" ? payload : {};
  const body = dictValue(source.body);
  const semantics = dictValue(source.semantics);
  const routing = dictValue(source.routing);
  const target = dictValue(routing.target);
  const extensions = dictValue(source.extensions);
  const custom = dictValue(extensions.custom);

  const legacyContent = dictValue(source.content);
  const legacyMetadata = dictValue(legacyContent.metadata);
  const legacyCustom = { ...legacyMetadata };
  const legacyPayload = dictValue(legacyContent.payload);
  const normalizedStatusBlock = dictValue(
    source.status_block ||
    source.statusBlock ||
    body.status_block ||
    body.statusBlock ||
    legacyPayload.status_block ||
    legacyPayload.statusBlock,
  );
  const normalizedContextBlock = dictValue(
    source.context_block ||
    source.contextBlock ||
    body.context_block ||
    body.contextBlock ||
    legacyPayload.context_block ||
    legacyPayload.contextBlock,
  );
  delete legacyCustom.target_agent_id;
  delete legacyCustom.target_agent;
  delete legacyCustom.assignees;
  delete legacyCustom.assignment;
  delete legacyCustom.targets;
  delete legacyCustom.intent;
  delete legacyCustom.flow_type;
  delete legacyCustom.message_type;
  delete legacyCustom.client_request_id;
  delete legacyCustom.outbound_correlation_id;
  delete legacyCustom.idempotency_key;
  delete legacyCustom.source;
  delete legacyCustom.mentions;
  delete legacyCustom.topic;
  delete legacyCustom.reply_to;

  const normalizedText = firstNonEmpty(body.text, legacyContent.text);
  const normalizedIntent = firstNonEmpty(semantics.intent, legacyContent.intent, legacyMetadata.intent, inferIntentFromText(normalizedText));
  const normalizedMessageType = normalizeOutboundMessageType(
    source.message_type || semantics.message_type || legacyMetadata.message_type || "analysis",
  );
  const normalizedFlowType = normalizeOutboundFlowType(
    firstNonEmpty(source.flow_type, semantics.flow_type, legacyMetadata.flow_type),
    normalizedMessageType,
    normalizedIntent,
  );
  const outboundCorrelationId = firstNonEmpty(
    extensions.outbound_correlation_id,
    extensions.client_request_id,
    custom.idempotency_key,
    legacyMetadata.outbound_correlation_id,
    legacyMetadata.client_request_id,
    legacyMetadata.idempotency_key,
    outboundRequestId(),
  );

  const targetAgentId =
    firstNonEmpty(target.agent_id, source.target_agent_id, legacyMetadata.target_agent_id, sendContext?.target_agent_id) || null;
  const targetAgentLabel =
    firstNonEmpty(target.agent_label, source.target_agent, legacyMetadata.target_agent, sendContext?.target_agent) || null;

  const mentions = listValue(routing.mentions).length ? [...listValue(routing.mentions)] : [...listValue(legacyContent.mentions)];
  const mention = structuredMentionForTarget(targetAgentId, targetAgentLabel);
  if (mention && !mentions.some((item) => item && item.mention_id === mention.mention_id)) {
    mentions.push(mention);
  }

  const canonicalMessage = pruneNullish({
    group_id: sendContext.group_id,
    author: {
      agent_id: state?.agentId || null,
    },
    flow_type: normalizedFlowType,
    message_type: normalizedMessageType,
    content: {
      text: normalizedText,
      payload: legacyPayload,
      blocks: listValue(body.blocks),
      attachments: listValue(body.attachments),
    },
    status_block: normalizedStatusBlock,
    context_block: normalizedContextBlock,
    relations: {
      thread_id: sendContext.thread_id,
      parent_message_id: sendContext.parent_message_id,
    },
    routing: {
      target: {
        agent_id: targetAgentId,
      },
      mentions,
    },
    extensions: {
      client_request_id: firstNonEmpty(extensions.client_request_id, legacyMetadata.client_request_id, outboundCorrelationId),
      outbound_correlation_id: outboundCorrelationId,
      source: firstNonEmpty(extensions.source, legacyContent.source, legacyMetadata.source, "CommunityIntegrationSkill"),
      custom: {
        ...legacyCustom,
        ...(normalizedIntent ? { intent: normalizedIntent } : {}),
        ...(targetAgentLabel ? { target_agent_label: targetAgentLabel } : {}),
        ...custom,
        ...(firstNonEmpty(legacyMetadata.reply_to, sendContext.parent_message_id)
          ? { reply_to: firstNonEmpty(legacyMetadata.reply_to, sendContext.parent_message_id) }
          : {}),
      },
    },
  });
  const resolution = resolveActionModuleReference({
    ...canonicalMessage,
    action_id: firstNonEmpty(source.action_id, legacyPayload.action_id, custom.action_id),
  });
  return {
    ...canonicalMessage,
    ...(resolution.action_id ? { action_id: resolution.action_id } : {}),
    content: resolution.content,
    extensions: resolution.extensions,
  };
}

function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) {
    return null;
  }
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function pruneNullish(value) {

  if (Array.isArray(value)) {
    return value
      .map((item) => pruneNullish(item))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, pruneNullish(item)])
      .filter(([, item]) => item !== undefined);
    if (!entries.length) {
      return undefined;
    }
    return Object.fromEntries(entries);
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  return value;
}

function buildSendContext(state, incomingMessage, payload) {
  const metadata = payload?.content?.metadata && typeof payload.content.metadata === "object" ? payload.content.metadata : {};
  const relations = dictValue(payload?.relations);
  const routing = dictValue(payload?.routing);
  const target = dictValue(routing.target);
  return {
    group_id: payload?.group_id || incomingMessage?.group_id || state.groupId,
    thread_id: payload?.thread_id || relations.thread_id || incomingMessage?.thread_id || incomingMessage?.id || null,
    parent_message_id: payload?.parent_message_id || relations.parent_message_id || incomingMessage?.id || null,
    incoming_message: incomingMessage || null,
    target_agent_id: payload?.target_agent_id || target.agent_id || metadata.target_agent_id || incomingMessage?.agent_id || null,
    target_agent:
      payload?.target_agent ||
      target.agent_label ||
      metadata.target_agent ||
      incomingMessage?.agent_name ||
      incomingMessage?.source_agent_name ||
      null,
  };
}

export function buildCommunityMessage(state, sendContext, payload) {
  return canonicalMessageFromPayload(sendContext, payload, state);
}

export function buildDirectedCollaborationMessage(state, sendContext, payload) {
  const normalizedPayload = {
    ...(payload && typeof payload === "object" ? payload : {}),
    flow_type: firstNonEmpty(payload?.flow_type, "run"),
    message_type: normalizeOutboundMessageType(payload?.message_type || payload?.semantics?.kind || "analysis"),
    routing: {
      ...(dictValue(payload?.routing)),
      target: {
        ...(dictValue(payload?.routing?.target)),
        agent_id: firstNonEmpty(payload?.target_agent_id, payload?.routing?.target?.agent_id) || null,
        agent_label: firstNonEmpty(payload?.target_agent, payload?.routing?.target?.agent_label) || null,
      },
    },
    extensions: {
      ...(dictValue(payload?.extensions)),
      custom: {
        ...(dictValue(payload?.extensions?.custom)),
        intent: firstNonEmpty(payload?.semantics?.intent, payload?.content?.metadata?.intent, "request_action"),
      },
    },
  };
  return buildCommunityMessage(state, sendContext, normalizedPayload);
}

export async function sendCommunityMessage(state, incomingMessage, payload) {
  assertOutboundSendAllowed();
  const sendContext = buildSendContext(state, incomingMessage, payload);
  let requestBody = buildCommunityMessage(state, sendContext, payload);
  requestBody = await enrichOutboundFormalMessage(requestBody, state, sendContext);
  const outboundStatusBlock = dictValue(requestBody?.status_block);
  if (Object.keys(outboundStatusBlock).length && requestBody?.group_id) {
    try {
      const liveLastStatusBlock = await fetchLiveLastStatusBlock(requestBody.group_id, state);
      const duplicateLiveManagerStart = Boolean(
        firstNonEmpty(outboundStatusBlock.lifecycle_phase) === "start" &&
        normalizedSectionToken(firstNonEmpty(outboundStatusBlock.step_status)).startsWith("manager_") &&
        firstNonEmpty(liveLastStatusBlock.lifecycle_phase) === "start" &&
        firstNonEmpty(liveLastStatusBlock.step_status) === firstNonEmpty(outboundStatusBlock.step_status) &&
        (
          !firstNonEmpty(outboundStatusBlock.step_id) ||
          firstNonEmpty(liveLastStatusBlock.step_id) === firstNonEmpty(outboundStatusBlock.step_id)
        )
      );
      if (duplicateLiveManagerStart) {
        requestBody = suppressOutboundFormalSignal(requestBody, "duplicate_manager_stage_start");
      }
    } catch {
      // Keep outbound hot path resilient if live session refresh fails.
    }
  }
  const outboundText = String(requestBody?.content?.text || "").trim();
  if (!requestBody?.group_id || !outboundText) {
    recordInvalidOutbound("invalid_outbound_payload", {
      group_id: requestBody?.group_id || null,
      has_text: Boolean(outboundText),
      message_type: requestBody?.message_type || null,
      client_request_id: requestBody?.extensions?.client_request_id || null,
    });
    throw new Error("invalid outbound community message payload");
  }
  console.log(JSON.stringify({ ok: true, outbound_structured_message: true, body: requestBody }, null, 2));
  const result = await request("/messages", {
    method: "POST",
    token: state.token,
    body: JSON.stringify(requestBody),
  });
  resetOutboundGuard();
  return result;
}

function canonicalMessageForExecution(runtimeMessage) {
  const payload = dictValue(runtimeMessage?.payload);
  const statusBlock = dictValue(runtimeMessage?.status_block);
  const contextBlock = dictValue(runtimeMessage?.context_block);
  const actionId = firstNonEmpty(runtimeMessage?.action_id, payload.action_id);
  const nextPayload = {
    ...payload,
    ...(actionId ? { action_id: actionId } : {}),
    ...(Object.keys(statusBlock).length ? { status_block: statusBlock } : {}),
    ...(Object.keys(contextBlock).length ? { context_block: contextBlock } : {}),
  };
  return {
    id: runtimeMessage?.id || null,
    group_id: runtimeMessage?.group_id || null,
    flow_type: runtimeMessage?.flow_type || "run",
    message_type: runtimeMessage?.message_type || "analysis",
    action_id: actionId || null,
    status_block: Object.keys(statusBlock).length ? statusBlock : undefined,
    context_block: Object.keys(contextBlock).length ? contextBlock : undefined,
    content: {
      text: runtimeMessage?.text || "",
      payload: nextPayload,
    },
    relations: {
      thread_id: runtimeMessage?.thread_id || null,
      parent_message_id: runtimeMessage?.parent_message_id || null,
    },
    routing: {
      target: {
        agent_id: runtimeMessage?.target_agent_id || null,
      },
      mentions: Array.isArray(runtimeMessage?.mentions) ? runtimeMessage.mentions : [],
    },
    extensions: runtimeMessage?.extensions || {},
  };
}

function incomingMessageForRuntime(runtimeMessage) {
  return {
    id: runtimeMessage?.id || null,
    group_id: runtimeMessage?.group_id || null,
    thread_id: runtimeMessage?.thread_id || null,
    parent_message_id: runtimeMessage?.parent_message_id || null,
    agent_id: runtimeMessage?.author_agent_id || null,
    agent_name: null,
    source_agent_name: null,
  };
}

async function deliberateCommunityResponse(message, state, runtimeContext, judgment) {
  const identity = loadText(preferredAssetPath("IDENTITY.md"));
  const soul = loadText(preferredAssetPath("SOUL.md"));
  const user = loadText(preferredAssetPath("USER.md"));
  const agentProtocol = installedAgentProtocolText();
  const payload = await requestModelJson({
    messages: [
      {
        role: "system",
        content: [
          `You are the OpenClaw community collaboration agent ${state.profile?.display_name || state.agentName}.`,
          "You are now in the agent deliberation layer.",
          "Runtime already judged minimum obligation. You must decide whether to publicly reply in the same group.",
          "Return JSON only with fields: should_reply (boolean), reply_text (string), message_type (string), reason (string).",
          "If obligation is required, should_reply must be true unless the message is malformed or impossible to answer.",
          "If obligation is optional, you may choose not to reply.",
          "reply_text must be concise Chinese suitable for public community posting.",
          "Do not expose chain-of-thought. Do not restate the whole protocol.",
          agentProtocol,
          runtimeInstructions(runtimeContext),
          channelContextInstructions(message?.group_id),
          workflowContractInstructions(message?.group_id),
          "Current runtime judgment:",
          JSON.stringify(judgment, null, 2),
          "Identity and working context:",
          identity,
          soul,
          user,
        ].filter(Boolean).join("\n\n"),
      },
      {
        role: "user",
        content: [
          "Decide whether to reply to the following community message.",
          `message_type: ${message.message_type}`,
          `message_content: ${JSON.stringify(message.content, null, 2)}`,
        ].join("\n\n"),
      },
    ],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });
  const raw = payload.choices?.[0]?.message?.content?.trim() || "";
  const parsed = extractJsonObject(raw) || {};
  return {
    should_reply: Boolean(parsed.should_reply),
    reply_text: String(parsed.reply_text || "").trim(),
    message_type: normalizeOutboundMessageType(parsed.message_type || "analysis"),
    reason: String(parsed.reason || "").trim() || "agent_deliberation",
    raw,
  };
}

export async function executeRuntimeJudgment(state, judgment) {
  const obligation = String(judgment?.obligation?.obligation || "observe_only").trim().toLowerCase();
  const runtimeMessage = judgment?.message || {};
  const effectiveGroupId = firstNonEmpty(runtimeMessage?.group_id, judgment?.context_group_id) || null;
  const scopedRuntimeMessage = effectiveGroupId ? { ...runtimeMessage, group_id: effectiveGroupId } : runtimeMessage;
  const recommendationMode = String(judgment?.recommendation?.mode || "observe_only").trim().toLowerCase();

  if (recommendationMode === "observe_only" || obligation === "observe_only") {
    return {
      ...judgment,
      observed: true,
      no_action: true,
      decision: {
        action: "observe_only",
        reason: recommendationMode === "observe_only" ? "runtime_observe_only" : "obligation_observe_only",
      },
    };
  }

  const executionMessage = canonicalMessageForExecution(scopedRuntimeMessage);
  let runtimeContext = {};
  if (effectiveGroupId) {
    try {
      runtimeContext = await fetchRuntimeContext(effectiveGroupId, state);
    } catch {
      runtimeContext = {};
    }
  }

  const ownershipDecision = protocolTurnOwnershipDecision(
    state,
    executionMessage,
    runtimeContext,
    judgment,
  );
  if (!ownershipDecision.owned) {
    return {
      ...judgment,
      observed: true,
      no_action: true,
      protocol_turn_ownership: ownershipDecision,
      decision: {
        action: "observe_only",
        reason: ownershipDecision.reason,
      },
    };
  }
  if (pendingFormalSignalAlreadyObservedByCurrentAgent(state, runtimeContext)) {
    return {
      ...judgment,
      observed: true,
      no_action: true,
      protocol_turn_ownership: ownershipDecision,
      decision: {
        action: "observe_only",
        reason: "pending_formal_signal_already_observed",
      },
    };
  }

  let execution;
  const deterministicBootstrapExecution = deterministicBootstrapControlTurnExecution(
    state,
    runtimeContext,
    executionMessage,
    judgment,
  );
  const deterministicOrganizerKickoff = deterministicOrganizerKickoffExecution(
    state,
    runtimeContext,
    executionMessage,
  );
  const deterministicStageOwnerKickoff = deterministicStageOwnerKickoffExecution(
    state,
    runtimeContext,
    executionMessage,
  );
  const eagerDeterministicPendingExecution =
    firstNonEmpty(dictValue(runtimeContext?.runtime_session_card).current_mode) === "bootstrap"
      ? deterministicPendingFormalSignalExecution(
          state,
          runtimeContext,
          executionMessage,
          {
            reason: "deterministic_pending_formal_signal_bootstrap",
          },
        )
      : null;
  if (deterministicBootstrapExecution) {
    execution = deterministicBootstrapExecution;
  } else if (deterministicOrganizerKickoff) {
    execution = deterministicOrganizerKickoff;
  } else if (deterministicStageOwnerKickoff) {
    execution = deterministicStageOwnerKickoff;
  } else if (eagerDeterministicPendingExecution) {
    execution = eagerDeterministicPendingExecution;
  } else {
    try {
      execution = await executeTask(executionMessage, state, runtimeContext, judgment);
    } catch (error) {
      console.error(JSON.stringify({ ok: false, execution_error: String(error?.message || error || "unknown execution error") }, null, 2));
      execution = {
        should_send: false,
        flow_type: "run",
        message_type: "analysis",
        text: "",
        payload: {},
        reason: "execution_failed",
      };
    }
  }

  const consumerFollowUpFallback =
    obligation === "required" &&
    (!execution?.should_send || !String(execution?.text || "").trim())
      ? actionModuleConsumerFollowUpFallback(execution, executionMessage, runtimeContext, state)
      : null;
  if (consumerFollowUpFallback) {
    execution = consumerFollowUpFallback;
  }

  const deterministicFallback =
    consumerFollowUpFallback
      ? null
      : deterministicPendingFormalSignalExecution(
          state,
          runtimeContext,
          executionMessage,
          execution,
        );
  if (
    deterministicFallback &&
    (
      !execution?.should_send ||
      !String(execution?.text || "").trim() ||
      !executionSatisfiesPendingFormalSignal(execution, runtimeContext)
    )
  ) {
    execution = deterministicFallback;
  }

  if (!execution?.should_send || !String(execution?.text || "").trim()) {
    return {
      ...judgment,
      agent_execution: execution,
      observed: true,
      no_action: true,
      decision: {
        action: "observe_only",
        reason: execution?.reason || "agent_declined_to_send",
      },
    };
  }

  const result = await sendCommunityMessage(state, incomingMessageForRuntime(scopedRuntimeMessage), {
    group_id: effectiveGroupId,
    flow_type: execution.flow_type || "run",
    message_type: execution.message_type || "analysis",
    content: {
      text: execution.text,
      payload: execution.payload || {},
    },
    status_block: execution.status_block || {},
    context_block: execution.context_block || {},
    relations: {
      thread_id: firstNonEmpty(execution.relations?.thread_id, scopedRuntimeMessage.thread_id, scopedRuntimeMessage.id) || null,
      parent_message_id: firstNonEmpty(execution.relations?.parent_message_id, scopedRuntimeMessage.id) || null,
    },
    routing: {
      target: {
        agent_id: firstNonEmpty(execution.routing?.target?.agent_id, scopedRuntimeMessage.author_agent_id) || null,
      },
      mentions: listValue(execution.routing?.mentions),
    },
    extensions: {
      ...dictValue(execution.extensions),
      custom: {
        ...dictValue(execution.extensions?.custom),
        responsibility_reason: judgment?.obligation?.reason || null,
      },
    },
  });

  return {
    ...judgment,
    agent_execution: execution,
    posted: true,
    result,
    decision: {
      action: "full_reply",
      reason: execution?.reason || "agent_execution",
    },
  };
}

function parseActiveSendPayload(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const content = payload.content && typeof payload.content === "object" ? { ...payload.content } : {};
  const contentPayload = dictValue(content.payload);
  if (payload.action_id && !contentPayload.action_id) {
    content.payload = {
      ...contentPayload,
      action_id: payload.action_id,
    };
  }
  return {
    group_id: payload.group_id || null,
    thread_id: payload.thread_id || payload.relations?.thread_id || null,
    parent_message_id: payload.parent_message_id || payload.relations?.parent_message_id || null,
    target_agent_id: payload.target_agent_id || payload.routing?.target?.agent_id || null,
    target_agent: payload.target_agent || payload.routing?.target?.agent_label || payload.extensions?.custom?.target_agent_label || null,
    flow_type: payload.flow_type || payload.semantics?.flow_type || "run",
    message_type: payload.message_type || payload.semantics?.message_type || payload.semantics?.kind || "analysis",
    semantics: dictValue(payload.semantics),
    routing: dictValue(payload.routing),
    relations: dictValue(payload.relations),
    extensions: dictValue(payload.extensions),
    status_block: dictValue(payload.status_block || payload.statusBlock),
    context_block: dictValue(payload.context_block || payload.contextBlock),
    content,
    action_id: payload.action_id || content.payload?.action_id || null,
  };
}

async function handleActiveSend(state, payload) {
  state = await ensureProfileFresh(state, "active_send_profile_sync");
  const normalized = parseActiveSendPayload(payload);
  if (!normalized.group_id) {
    throw new Error("community-send requires group_id");
  }
  if (!String(normalized.content?.text || "").trim()) {
    throw new Error("community-send requires content.text");
  }
  return sendCommunityMessage(state, null, normalized);
}

async function loadRuntimeModule() {
  if (!runtimeModulePromise) {
    const runtimeUrl = `${pathToFileURL(WORKSPACE_RUNTIME_PATH).href}?ts=${Date.now()}`;
    runtimeModulePromise = import(runtimeUrl);
  }
  return runtimeModulePromise;
}

export async function receiveCommunityEvent(state, event) {
  state = await ensureProfileFresh(state, "webhook_profile_sync");
  const eventType = String(event?.event?.event_type || "").trim();
  if (isOutboundReceiptEventType(eventType)) {
    return handleOutboundReceiptEvent(state, event);
  }
  if (isOutboundDebugEventType(eventType)) {
    return handleOutboundCanonicalizedEvent(state, event);
  }

  const runtimeModule = await loadRuntimeModule();
  const judgment = await runtimeModule.handleRuntimeEvent(
    {
      handleProtocolViolation,
      loadGroupSession,
      loadWorkflowContract,
      loadGroupContext,
      loadChannelContext: loadGroupContext,
      resolveGroupSessionObligation,
    },
    state,
    event,
  );
  return executeRuntimeJudgment(state, judgment);
}

async function bootstrapState() {
  if (RESET_STATE_ON_START) {
    deleteFileIfExists(STATE_PATH);
  }
  installRuntime();
  installAgentProtocol();
  let state = loadJson(STATE_PATH, {}) || {};
  state = await connectToCommunity(state);
  persistCommunityState(state, "bootstrap_completed");
  return state;
}

export async function startCommunityIntegration() {
  let currentState = null;
  let bootstrapReady = false;
  let bootstrapFailure = null;

  const statePromise = bootstrapState();
  statePromise.then(
    (state) => {
      currentState = state;
      bootstrapReady = true;
      console.log(
        JSON.stringify(
          {
            ok: true,
            bootstrap: "completed",
            agentName: state.agentName,
            agentId: state.agentId,
            socketPath: TRANSPORT_MODE === "unix_socket" ? AGENT_SOCKET_PATH : undefined,
          },
          null,
          2,
        ),
      );
    },
    (error) => {
      bootstrapFailure = error;
      console.error(
        JSON.stringify(
          {
            ok: false,
            phase: "bootstrap_state",
            error: error.message,
            transport: TRANSPORT_MODE,
            socketPath: TRANSPORT_MODE === "unix_socket" ? AGENT_SOCKET_PATH : undefined,
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
    },
  );

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          ready: bootstrapReady,
          agent: currentState?.agentName || AGENT_NAME,
          agentId: currentState?.agentId || null,
          webhookPath: WEBHOOK_PATH,
          listen: TRANSPORT_MODE === "unix_socket" ? AGENT_SOCKET_PATH : `${LISTEN_HOST}:${LISTEN_PORT}`,
          socketPath: TRANSPORT_MODE === "unix_socket" ? AGENT_SOCKET_PATH : undefined,
          bootstrapError: bootstrapFailure?.message || null,
          skill: "CommunityIntegrationSkill",
          runtimePath: WORKSPACE_RUNTIME_PATH,
          agentProtocolPath: INSTALLED_AGENT_PROTOCOL_PATH,
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url === SEND_PATH) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          const state = await statePromise;
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const result = await handleActiveSend(state, payload);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          console.error(JSON.stringify({ ok: false, active_send_error: error.message }, null, 2));
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
      });
      return;
    }

    if (req.method !== "POST" || req.url !== WEBHOOK_PATH) {
      res.writeHead(404).end("not found");
      return;
    }

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const state = await statePromise;
        const rawBody = Buffer.concat(chunks);
        const signature = req.headers["x-community-webhook-signature"];
        if (typeof signature !== "string" || !verifySignature(state.webhookSecret, rawBody, signature)) {
          res.writeHead(401).end("invalid signature");
          return;
        }

        const payload = JSON.parse(rawBody.toString("utf8"));
        const result = await receiveCommunityEvent(state, payload);
        console.log(JSON.stringify({ ok: true, webhook: true, event_type: payload?.event?.event_type || "", result }, null, 2));
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (error) {
        console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      }
    });
  });

  server.on("error", (error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          listening: false,
          transport: TRANSPORT_MODE,
          socketPath: TRANSPORT_MODE === "unix_socket" ? AGENT_SOCKET_PATH : undefined,
          listen: TRANSPORT_MODE === "unix_socket" ? AGENT_SOCKET_PATH : `${LISTEN_HOST}:${LISTEN_PORT}`,
          error: error.message,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  });

  const onListening = () => {
    console.log(
      JSON.stringify(
        {
          ok: true,
          listening: true,
          agentName: currentState?.agentName || AGENT_NAME,
          groupSlug: currentState?.groupSlug || GROUP_SLUG,
          webhookUrl: currentState?.webhookUrl || null,
          webhookPath: WEBHOOK_PATH,
          sendPath: SEND_PATH,
          skill: "CommunityIntegrationSkill",
          mode: TRANSPORT_MODE === "unix_socket" ? "agent_socket" : "agent_webhook",
          socketPath: TRANSPORT_MODE === "unix_socket" ? AGENT_SOCKET_PATH : undefined,
          message: TRANSPORT_MODE === "unix_socket" ? `listening on socket_path=${AGENT_SOCKET_PATH}` : `listening on ${LISTEN_HOST}:${LISTEN_PORT}`,
        },
        null,
        2,
      ),
    );
  };

  if (TRANSPORT_MODE === "unix_socket") {
    ensureDir(AGENT_SOCKET_PATH);
    deleteFileIfExists(AGENT_SOCKET_PATH);
    server.listen(AGENT_SOCKET_PATH, onListening);
    process.on("exit", () => deleteFileIfExists(AGENT_SOCKET_PATH));
    process.on("SIGINT", () => {
      deleteFileIfExists(AGENT_SOCKET_PATH);
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      deleteFileIfExists(AGENT_SOCKET_PATH);
      process.exit(0);
    });
    return;
  }

  server.listen(LISTEN_PORT, LISTEN_HOST, onListening);
}






export const loadChannelContext = loadGroupContext;
