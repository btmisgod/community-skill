import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function roleAssignmentsOf(groupLayer) {
  return dictValue(dictValue(groupLayer?.members).role_assignments);
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

function stageCardsFor(groupLayer, executionSpec, currentStage) {
  const workflowStages = dictValue(formalWorkflowOf(groupLayer).stages);
  const workflowStage = dictValue(workflowStages[currentStage]);
  const executionStages = dictValue(executionSpec?.stages);
  const executionStage = dictValue(executionStages[currentStage]);
  const nextStageId = firstNonEmpty(executionStage.next_stage);
  const nextExecutionStage = dictValue(executionStages[nextStageId]);
  return {
    workflow_stage_card: {
      owner: workflowStage.owner || null,
      goal: workflowStage.goal || null,
      input: safeListSummary(workflowStage.input, 12),
      output: safeListSummary(workflowStage.output, 12),
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

function loadModelConfig() {
  refreshModelEnvFromFiles();
  const baseUrl = resolveModelSetting("MODEL_BASE_URL", ["OPENAI_BASE_URL", "OPENAI_API_BASE", "LLM_BASE_URL"]);
  const apiKey = resolveModelSetting("MODEL_API_KEY", ["OPENAI_API_KEY", "LLM_API_KEY"]);
  const modelId = resolveModelSetting("MODEL_ID", ["OPENAI_MODEL", "OPENAI_MODEL_ID", "DEFAULT_MODEL", "MODEL"]);
  if (!baseUrl || !apiKey || !modelId) {
    throw new Error("MODEL_BASE_URL, MODEL_API_KEY, and MODEL_ID must be set or inherited from current agent model config");
  }
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, modelId };
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
    renderCard("Transition rules card", runtimeContext.transition_rules_card),
    "If runtime context says the current agent role is manager and the current stage is manager-owned, do not describe what the manager should do in third person. You are that manager and must emit the formal manager signal directly.",
    "Manager-specific rule: never close a stage mechanically. Before any manager-owned close signal, inspect the incoming message and verify that the current stage deliverable or evidence actually exists.",
    "Manager-specific rule: if the current message does not contain the expected deliverable/evidence, do not emit a formal close signal. Ask for the missing artifact or request correction instead.",
    "Manager-specific rule: every manager close must carry a structured payload with real content or explicit evidence_refs/artifact_refs. Plain text plus a status_block is invalid.",
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
        "If you are the manager, you must not advance a stage unless your response includes the stage-appropriate artifact or evidence-backed decision payload.",
        "If you cannot verify the required deliverable/evidence from the current message, do not emit a formal close status_block. Return a correction/review style message instead.",
        "Do not invent message sources. The current source is Agent Community webhook delivery.",
        "Do not expose internal chain-of-thought.",
        agentProtocol,
        runtimeInstructions(runtimeContext),
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
  const flowType =
    firstNonEmpty(source.flow_type, source.flowType) ||
    inferFlowType(messageType, intent);
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
  const lifecyclePhase = firstNonEmpty(
    block.lifecycle_phase,
    payloadStatus.lifecycle_phase,
    payloadData.lifecycle_phase,
    semantics.lifecycle_phase,
    payload?.flow_type === "result" ? "result" : payload?.flow_type === "start" ? "start" : "run",
  );
  const authorRole = firstNonEmpty(
    roleCard.current_agent_role,
    roleCard.server_gate_role,
    block.author_role,
    payloadStatus.author_role,
    payloadData.author_role,
    semantics.author_role,
  );
  const stepStatus = canonicalFormalStepStatus(
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

const STAGE_ARTIFACT_SHAPE_RULES = {
  cycle_task_plan: ["task_plan", "tasks", "assignments", "section_plans", "workstreams", "sections"],
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

function payloadMatchesExpectedArtifactKind(payload, expectedKinds) {
  if (!expectedKinds.length) {
    return true;
  }
  return expectedKinds.includes(firstNonEmpty(dictValue(payload).kind));
}

function payloadHasExpectedArtifactShape(payload, expectedKinds) {
  const source = dictValue(payload);
  if (!Object.keys(source).length || !payloadMatchesExpectedArtifactKind(source, expectedKinds)) {
    return false;
  }
  const kind = firstNonEmpty(source.kind);
  const requiredKeys = listValue(STAGE_ARTIFACT_SHAPE_RULES[kind]);
  if (requiredKeys.length) {
    return requiredKeys.some((key) => hasMeaningfulArtifactValue(source[key]));
  }
  return payloadHasStructuredArtifact(source);
}

function isManagerFormalClose(statusBlock, runtimeContext) {
  const block = dictValue(statusBlock);
  const role = firstNonEmpty(block.author_role, dictValue(runtimeContext?.role_card).current_agent_role);
  if (role !== "manager") {
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
    return payloadHasExpectedArtifactShape(incomingPayload, expectedKinds);
  }
  if (payloadHasStructuredArtifact(payload)) {
    return true;
  }
  if (hasMeaningfulArtifactValue(payload.evidence_refs) || hasMeaningfulArtifactValue(payload.artifact_refs)) {
    return true;
  }
  return payloadHasStructuredArtifact(incomingPayload);
}

async function enrichOutboundFormalMessage(requestBody, state, sendContext = {}) {
  const statusBlock = dictValue(requestBody?.status_block);
  if (!Object.keys(statusBlock).length) {
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
  if (!Object.keys(runtimeContext).length) {
    if (!missingFormalStatusFields(statusBlock).length && !isGenericFormalStepStatus(statusBlock.step_status)) {
      return requestBody;
    }
    return requestBody;
  }
  const normalizedStatusBlock = normalizeOutboundStatusBlock(statusBlock, requestBody, state, runtimeContext, sendContext);
  if (!Object.keys(normalizedStatusBlock).length) {
    return {
      ...requestBody,
      status_block: {},
    };
  }
  if (isManagerFormalClose(normalizedStatusBlock, runtimeContext) && !managerFormalCloseHasEvidence(requestBody, sendContext.incoming_message, runtimeContext)) {
    return {
      ...requestBody,
      status_block: {},
      extensions: {
        ...dictValue(requestBody.extensions),
        custom: {
          ...dictValue(dictValue(requestBody.extensions).custom),
          formal_signal_suppressed_reason: "missing_stage_artifact_evidence",
        },
      },
    };
  }
  return {
    ...requestBody,
    status_block: normalizedStatusBlock,
  };
}

async function executeTask(message, state, runtimeContext, judgment = null) {
  const model = loadModelConfig();
  const endpoint = `${model.baseUrl}/chat/completions`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${model.apiKey}`,
  };
  const requestBody = {
    model: model.modelId,
    messages: buildExecutionPrompt(message, state, runtimeContext, judgment),
    temperature: 0.4,
    response_format: { type: "json_object" },
  };
  let response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    signal: signalWithTimeout(60000),
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
      signal: signalWithTimeout(60000),
    });
    payload = await response.json();
  }
  if (!response.ok) {
    throw new Error(`Model request failed: ${JSON.stringify(payload)}`);
  }
  const raw = payload.choices?.[0]?.message?.content?.trim() || "";
  const parsed = extractJsonObject(raw);
  if (parsed) {
    return enrichExecutionStatusBlock(normalizeExecutionDecision(parsed, raw), state, runtimeContext, message);
  }
  return enrichExecutionStatusBlock(normalizeExecutionDecision(
    {
      should_send: Boolean(raw),
      flow_type: "run",
      message_type: "analysis",
      text: raw,
      payload: {},
      reason: "unstructured_model_output",
    },
    raw,
  ), state, runtimeContext, message);
}

export async function fetchRuntimeContext(groupId, state) {
  const [protocolData, channelData, sessionData] = await Promise.all([
    request(`/groups/${groupId}/protocol`, { method: "GET", token: state.token }),
    request(`/groups/${groupId}/context`, { method: "GET", token: state.token }),
    request(`/groups/${groupId}/session`, { method: "GET", token: state.token }),
  ]);
  await loadGroupContext(state, groupId, channelData);
  const protocolEnvelope = protocolData?.data?.protocol || protocolData?.protocol || protocolData || null;
  const groupLayer =
    protocolEnvelope?.layers?.group ||
    protocolData?.data?.group?.metadata_json?.community_v2?.group_protocol ||
    protocolData?.group?.metadata_json?.community_v2?.group_protocol ||
    protocolData?.group_protocol ||
    {};
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
  return {
    protocol_version: protocolEnvelope?.version || groupLayer?.protocol_meta?.protocol_version || session?.protocol_version || "unknown",
    group_slug:
      channelData?.data?.group?.slug ||
      channelData?.group_slug ||
      groupLayer?.group?.group_slug ||
      "",
    role_card: roleCardForAgent(groupLayer, executionSpec, state, currentAgentRole, workerAgentIds),
    group_objective_card: {
      group_type: groupLayer?.group_identity?.group_type || null,
      workflow_mode: groupLayer?.group_identity?.workflow_mode || null,
      group_objective: groupLayer?.group_identity?.group_objective || workflow?.goal || null,
    },
    product_contract_card: productContractCard(groupLayer),
    workflow_stage_card: stageCards.workflow_stage_card,
    execution_stage_card: {
      ...stageCards.execution_stage_card,
      execution_spec_id: executionSpec.execution_spec_id || session?.gate_snapshot?.execution_spec_id || null,
    },
    next_execution_stage_card: stageCards.next_execution_stage_card,
    runtime_session_card: runtimeSessionCard(session),
    transition_rules_card: transitionRulesCard(groupLayer),
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
  const normalizedFlowType =
    firstNonEmpty(source.flow_type, semantics.flow_type, legacyMetadata.flow_type) ||
    inferFlowType(source.message_type || semantics.message_type, normalizedIntent);
  const normalizedMessageType = normalizeOutboundMessageType(
    source.message_type || semantics.message_type || legacyMetadata.message_type || "analysis",
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

  return pruneNullish({
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
  return {
    id: runtimeMessage?.id || null,
    group_id: runtimeMessage?.group_id || null,
    flow_type: runtimeMessage?.flow_type || "run",
    message_type: runtimeMessage?.message_type || "analysis",
    content: {
      text: runtimeMessage?.text || "",
      payload: runtimeMessage?.payload || {},
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
  const model = loadModelConfig();
  const identity = loadText(preferredAssetPath("IDENTITY.md"));
  const soul = loadText(preferredAssetPath("SOUL.md"));
  const user = loadText(preferredAssetPath("USER.md"));
  const agentProtocol = installedAgentProtocolText();
  const response = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${model.apiKey}`,
    },
    body: JSON.stringify({
      model: model.modelId,
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
    }),
    signal: signalWithTimeout(60000),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(`Model deliberation failed: ${JSON.stringify(payload)}`);
  }
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

async function executeRuntimeJudgment(state, judgment) {
  const obligation = String(judgment?.obligation?.obligation || "observe_only").trim().toLowerCase();
  const runtimeMessage = judgment?.message || {};
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

  const executionMessage = canonicalMessageForExecution(runtimeMessage);
  let runtimeContext = {};
  if (runtimeMessage?.group_id) {
    try {
      runtimeContext = await fetchRuntimeContext(runtimeMessage.group_id, state);
    } catch {
      runtimeContext = {};
    }
  }

  let execution;
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

  const result = await sendCommunityMessage(state, incomingMessageForRuntime(runtimeMessage), {
    group_id: runtimeMessage.group_id,
    flow_type: execution.flow_type || "run",
    message_type: execution.message_type || "analysis",
    content: {
      text: execution.text,
      payload: execution.payload || {},
    },
    status_block: execution.status_block || {},
    context_block: execution.context_block || {},
    relations: {
      thread_id: firstNonEmpty(execution.relations?.thread_id, runtimeMessage.thread_id, runtimeMessage.id) || null,
      parent_message_id: firstNonEmpty(execution.relations?.parent_message_id, runtimeMessage.id) || null,
    },
    routing: {
      target: {
        agent_id: firstNonEmpty(execution.routing?.target?.agent_id, runtimeMessage.author_agent_id) || null,
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
      loadWorkflowContract,
      loadGroupContext,
      loadChannelContext: loadGroupContext,
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


