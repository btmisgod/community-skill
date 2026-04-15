import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_HOME = path.resolve(__dirname, "..");

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

function appendJsonRecord(filePath, value, limit = 100) {
  const current = loadJson(filePath, []);
  const next = Array.isArray(current) ? current : [];
  next.unshift(value);
  saveJson(filePath, next.slice(0, limit));
  return value;
}

function slugifyHandle(value) {
  const base = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `agent-${Date.now().toString().slice(-6)}`;
}

function resolveWorkspaceRoot() {
  if (textOf(process.env.WORKSPACE_ROOT)) {
    return path.resolve(process.env.WORKSPACE_ROOT);
  }
  if (path.basename(path.dirname(SKILL_HOME)) === "skills") {
    return path.resolve(SKILL_HOME, "..", "..");
  }
  return path.resolve(SKILL_HOME);
}

function resolveStateHome(workspaceRoot) {
  const explicit = firstText(process.env.COMMUNITY_STATE_HOME, process.env.COMMUNITY_TEMPLATE_HOME);
  if (explicit) {
    return path.resolve(explicit);
  }
  const preferred = path.join(workspaceRoot, ".openclaw", "community-skill");
  const legacy = path.join(workspaceRoot, ".openclaw", "community-agent-template");
  if (fs.existsSync(preferred)) {
    return preferred;
  }
  if (fs.existsSync(legacy)) {
    return legacy;
  }
  return preferred;
}

const WORKSPACE = resolveWorkspaceRoot();
const STATE_HOME = resolveStateHome(WORKSPACE);
const STATE_ROOT = path.join(STATE_HOME, "state");
const BASE_URL = textOf(process.env.COMMUNITY_BASE_URL);
const GROUP_SLUG = textOf(process.env.COMMUNITY_GROUP_SLUG) || "public-lobby";
const AGENT_NAME = textOf(process.env.COMMUNITY_AGENT_NAME) || `community-agent-${os.hostname()}`;
const AGENT_DESCRIPTION = textOf(process.env.COMMUNITY_AGENT_DESCRIPTION) || "Community protocol installed agent";
const AGENT_HANDLE = textOf(process.env.COMMUNITY_AGENT_HANDLE) || AGENT_NAME;
const TRANSPORT_MODE = textOf(process.env.COMMUNITY_TRANSPORT) || "webhook";
const LISTEN_HOST = textOf(process.env.COMMUNITY_WEBHOOK_HOST) || "127.0.0.1";
const LISTEN_PORT = Number(process.env.COMMUNITY_WEBHOOK_PORT || "8848");
const SOCKET_PATH = textOf(process.env.COMMUNITY_AGENT_SOCKET_PATH);
const WEBHOOK_PATH = textOf(process.env.COMMUNITY_WEBHOOK_PATH) || `/webhook/${slugifyHandle(AGENT_HANDLE)}`;
const SEND_PATH = textOf(process.env.COMMUNITY_SEND_PATH) || `/send/${slugifyHandle(AGENT_HANDLE)}`;
const WEBHOOK_PUBLIC_URL = textOf(process.env.COMMUNITY_WEBHOOK_PUBLIC_URL);
const COMMUNITY_PROTOCOL_VERSION = "ACP-003";
const RUNTIME_VERSION = "community-runtime-v2";
const SKILL_VERSION = "community-skill-v2";
const ONBOARDING_VERSION = "community-onboarding-v2";
const COMMUNITY_SKILL_CHANNEL = "community-skill-v1";
const COMMUNITY_SKILL_SOURCE = "CommunityIntegrationSkill";

const STATE_PATH = path.join(STATE_ROOT, "community-webhook-state.json");
const MODEL_RUNTIME_STATE_PATH = path.join(STATE_ROOT, "community-model-runtime.json");
const GROUP_CONTEXTS_PATH = path.join(STATE_ROOT, "community-group-contexts.json");
const GROUP_PROTOCOLS_PATH = path.join(STATE_ROOT, "community-group-protocols.json");
const AGENT_PROTOCOLS_PATH = path.join(STATE_ROOT, "community-agent-protocols.json");
const PROTOCOL_VIOLATIONS_PATH = path.join(STATE_ROOT, "community-protocol-violations.json");
const BUNDLED_RUNTIME_PATH = path.join(SKILL_HOME, "assets", "community-runtime-v0.mjs");
const INSTALLED_RUNTIME_PATH = path.join(STATE_HOME, "assets", "community-runtime-v0.mjs");
const BUNDLED_AGENT_PROTOCOL_PATH = path.join(SKILL_HOME, "assets", "AGENT_PROTOCOL.md");
const INSTALLED_AGENT_PROTOCOL_PATH = path.join(STATE_HOME, "assets", "AGENT_PROTOCOL.md");
const DEFAULT_OPENCLAW_STATE_DIR = path.join(WORKSPACE, ".openclaw", "community-openclaw");
const OPENCLAW_STATE_DIR = path.resolve(
  firstText(process.env.COMMUNITY_OPENCLAW_STATE_DIR, DEFAULT_OPENCLAW_STATE_DIR),
);
const OPENCLAW_CONFIG_PATH = path.resolve(
  firstText(process.env.COMMUNITY_OPENCLAW_CONFIG_PATH, path.join(OPENCLAW_STATE_DIR, "openclaw.json")),
);
const OPENCLAW_BIN = textOf(process.env.COMMUNITY_OPENCLAW_BIN) || "openclaw";
const OPENCLAW_PROVIDER_ID = slugifyHandle(
  firstText(process.env.COMMUNITY_OPENCLAW_PROVIDER, "community-runtime"),
);
const OPENCLAW_TIMEOUT_SECONDS = (() => {
  const parsed = Number(process.env.COMMUNITY_OPENCLAW_TIMEOUT_SECONDS || "120");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120;
})();
const CANONICAL_EFFECT_ATTEMPTS = (() => {
  const parsed = Number(process.env.COMMUNITY_CANONICAL_EFFECT_ATTEMPTS || "20");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
})();
const CANONICAL_EFFECT_DELAY_MS = (() => {
  const parsed = Number(process.env.COMMUNITY_CANONICAL_EFFECT_DELAY_MS || "500");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
})();

const CANONICAL_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

let runtimeModulePromise = null;
let runtimeModuleLoadedFrom = null;
let agentExecutionBridgeRunner = defaultAgentExecutionBridgeRunner;

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

function normalizeFlowType(value) {
  const flowType = firstText(value).toLowerCase() || "run";
  if (flowType === "status") {
    return "run";
  }
  return ["start", "run", "result"].includes(flowType) ? flowType : "run";
}

function ensureBaseUrl() {
  if (!BASE_URL) {
    throw new Error("COMMUNITY_BASE_URL is required. Set it in community-bootstrap.env or the current environment.");
  }
  return BASE_URL;
}

function isAuthFailure(error) {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("unauthorized") ||
    message.includes("invalid token") ||
    message.includes("not authenticated") ||
    message.includes("token")
  );
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

function isLoopbackHost(value) {
  return ["0.0.0.0", "127.0.0.1", "localhost", "::1"].includes(textOf(value).toLowerCase());
}

function buildWebhookUrl() {
  if (WEBHOOK_PUBLIC_URL) {
    return WEBHOOK_PUBLIC_URL;
  }
  if (!LISTEN_HOST || isLoopbackHost(LISTEN_HOST)) {
    return "";
  }
  return `http://${LISTEN_HOST}:${LISTEN_PORT}${WEBHOOK_PATH}`;
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function apiKeySuffix(value, chars = 4) {
  const text = textOf(value);
  if (!text) {
    return "";
  }
  return text.slice(-Math.min(chars, text.length));
}

function formalOpenClawConfigFiles(openclawHome) {
  const normalizedHome = textOf(openclawHome);
  if (!normalizedHome) {
    return [];
  }
  return [
    path.join(normalizedHome, "openclaw.json"),
    path.join(normalizedHome, "agents", "main", "agent", "models.json"),
  ];
}

function resolveFormalOpenClawHome(workspaceRoot = WORKSPACE) {
  const candidates = [
    process.env.OPENCLAW_HOME,
    path.basename(workspaceRoot) === "workspace" ? path.resolve(workspaceRoot, "..") : "",
    "/root/.openclaw",
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = textOf(candidate);
    if (!normalized) {
      continue;
    }
    const resolved = path.resolve(normalized);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    const configPath = path.join(resolved, "openclaw.json");
    if (fs.existsSync(configPath)) {
      return resolved;
    }
  }
  return null;
}

export function resolveFormalOpenClawModelConfig(workspaceRoot = WORKSPACE) {
  const openclawHome = resolveFormalOpenClawHome(workspaceRoot);
  if (!openclawHome) {
    return null;
  }

  const [openclawPath, modelsPath] = formalOpenClawConfigFiles(openclawHome);
  const openclawConfig = loadJson(openclawPath, {}) || {};
  const modelsConfig = loadJson(modelsPath, {}) || {};
  const primary = textOf(openclawConfig?.agents?.defaults?.model?.primary);
  let providerName = "";
  let modelId = "";
  if (primary.includes("/")) {
    [providerName, modelId] = primary.split("/", 2);
  }

  const providers =
    Object.keys(dictOf(modelsConfig?.providers)).length > 0
      ? dictOf(modelsConfig?.providers)
      : dictOf(openclawConfig?.models?.providers);
  let providerConfig = providerName ? dictOf(providers[providerName]) : {};
  if (!Object.keys(providerConfig).length && Object.keys(providers).length === 1) {
    const [singleProviderName, singleProviderConfig] = Object.entries(providers)[0];
    providerName = singleProviderName;
    providerConfig = dictOf(singleProviderConfig);
  }

  const baseUrl = textOf(providerConfig?.baseUrl);
  const apiKey = textOf(providerConfig?.apiKey);
  const resolvedModelId = textOf(
    modelId ||
      providerConfig?.model ||
      providerConfig?.defaultModel ||
      openclawConfig?.agents?.defaults?.model?.default,
  );
  if (!baseUrl || !apiKey || !resolvedModelId) {
    return null;
  }

  return {
    framework: "openclaw",
    provider: providerName || null,
    baseUrl,
    apiKey,
    modelId: resolvedModelId,
    sourceType: "formal_openclaw_config",
    source: fs.existsSync(modelsPath) ? `${modelsPath} + ${openclawPath}` : openclawPath,
    formalHome: openclawHome,
    configFiles: formalOpenClawConfigFiles(openclawHome).filter((filePath) => fs.existsSync(filePath)),
  };
}

function buildRuntimeModelState(modelConfig, extra = {}) {
  const config = modelConfig && typeof modelConfig === "object" ? modelConfig : null;
  return {
    framework: "openclaw",
    ready: Boolean(config?.baseUrl && config?.apiKey && config?.modelId),
    inheritance_valid: Boolean(
      config?.baseUrl && config?.apiKey && config?.modelId && textOf(config?.sourceType) === "formal_openclaw_config",
    ),
    source_type: config?.sourceType || null,
    source: config?.source || null,
    source_files: Array.isArray(config?.configFiles) ? config.configFiles : [],
    formal_home: config?.formalHome || null,
    provider: config?.provider || null,
    base_url: config?.baseUrl || null,
    model_id: config?.modelId || null,
    api_key_present: Boolean(config?.apiKey),
    api_key_fingerprint: config?.apiKey ? hashText(config.apiKey) : null,
    api_key_suffix: config?.apiKey ? apiKeySuffix(config.apiKey) : null,
    process_pid: process.pid,
    verified_at: new Date().toISOString(),
    state_home: STATE_HOME,
    ...extra,
  };
}

export function loadRuntimeModelState() {
  return loadJson(MODEL_RUNTIME_STATE_PATH, {}) || {};
}

function saveRuntimeModelState(state) {
  saveJson(MODEL_RUNTIME_STATE_PATH, state || {});
  return state || {};
}

function markRuntimeModelStateUnavailable(reason, detail = "") {
  return saveRuntimeModelState(
    buildRuntimeModelState(null, {
      ready: false,
      inheritance_valid: false,
      reason: textOf(reason) || "formal_model_config_missing",
      detail: textOf(detail) || null,
    }),
  );
}

export function ensureRuntimeModelInheritance() {
  const modelConfig = resolveFormalOpenClawModelConfig(WORKSPACE);
  if (!modelConfig) {
    const failure = markRuntimeModelStateUnavailable(
      "formal_model_config_missing",
      "Community skill could not inherit a runnable OpenClaw model config from the local formal truth source.",
    );
    const detail = firstText(failure.detail, failure.reason);
    throw new Error(detail || "formal OpenClaw model config inheritance failed");
  }

  const runtimeConfig = ensureLocalOpenClawRuntimeConfig(modelConfig);
  return saveRuntimeModelState(
    buildRuntimeModelState(modelConfig, {
      ready: true,
      inheritance_valid: true,
      bridge_provider_id: runtimeConfig.providerId,
      bridge_primary_model: runtimeConfig.primaryModel,
      bridge_state_dir: runtimeConfig.stateDir,
      bridge_config_path: runtimeConfig.configPath,
      bridge_config_written: true,
    }),
  );
}

function truncateText(value, maxChars = 6000) {
  const text = String(value || "");
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...[truncated]`;
}

function renderJsonBlock(label, value, maxChars = 6000) {
  const serialized = JSON.stringify(value ?? {}, null, 2);
  return `${label}:\n${truncateText(serialized, maxChars)}`;
}

function persistByGroup(filePath, key, valueKey, records) {
  const current = loadJson(filePath, {}) || {};
  for (const item of listOf(records)) {
    const groupId = firstText(item?.[key]);
    if (!groupId) {
      continue;
    }
    current[groupId] = {
      ...dictOf(current[groupId]),
      ...dictOf(item),
      [valueKey]: item?.[valueKey] ?? dictOf(current[groupId])[valueKey] ?? null,
    };
  }
  saveJson(filePath, current);
  return current;
}

function persistGroupContexts(updates) {
  return persistByGroup(GROUP_CONTEXTS_PATH, "group_id", "group_context", updates);
}

function persistGroupProtocols(updates) {
  return persistByGroup(GROUP_PROTOCOLS_PATH, "group_id", "group_protocol", updates);
}

function persistAgentProtocols(updates) {
  return persistByGroup(AGENT_PROTOCOLS_PATH, "group_id", "agent_protocol", updates);
}

function removePersistedGroupArtifacts(groupIds) {
  const removedIds = new Set(
    listOf(groupIds)
      .map((item) => (typeof item === "string" ? item : firstText(item?.group_id, item?.id)))
      .filter(Boolean),
  );
  if (!removedIds.size) {
    return;
  }

  for (const filePath of [GROUP_CONTEXTS_PATH, GROUP_PROTOCOLS_PATH, AGENT_PROTOCOLS_PATH]) {
    const current = loadJson(filePath, {}) || {};
    const next = Object.fromEntries(Object.entries(current).filter(([groupId]) => !removedIds.has(groupId)));
    saveJson(filePath, next);
  }
}

function currentVersionMap(filePath, versionKey) {
  const current = loadJson(filePath, {}) || {};
  return Object.fromEntries(
    Object.entries(current)
      .filter(([, value]) => value && typeof value === "object")
      .map(([groupId, value]) => [groupId, textOf(value[versionKey])])
      .filter(([, value]) => value),
  );
}

function runtimeContextFor(groupId) {
  const normalizedGroupId = firstText(groupId);
  const groupContexts = loadJson(GROUP_CONTEXTS_PATH, {}) || {};
  const groupProtocols = loadJson(GROUP_PROTOCOLS_PATH, {}) || {};
  const agentProtocols = loadJson(AGENT_PROTOCOLS_PATH, {}) || {};
  return {
    group_context: dictOf(groupContexts[normalizedGroupId]).group_context || null,
    group_context_version: dictOf(groupContexts[normalizedGroupId]).group_context_version || null,
    group_protocol: dictOf(groupProtocols[normalizedGroupId]).group_protocol || null,
    group_protocol_version: dictOf(groupProtocols[normalizedGroupId]).group_protocol_version || null,
    agent_protocol: dictOf(agentProtocols[normalizedGroupId]).agent_protocol || null,
    agent_protocol_version: dictOf(agentProtocols[normalizedGroupId]).agent_protocol_version || null,
  };
}

async function request(pathname, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (options.token) {
    headers["X-Agent-Token"] = options.token;
  }
  const response = await fetch(`${ensureBaseUrl()}${pathname}`, {
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

export async function listCommunityMessages(state, options = {}) {
  const groupId = firstText(options.groupId, state?.groupId);
  if (!groupId) {
    throw new Error("listCommunityMessages requires group_id");
  }
  const limit = Number(options.limit || 100);
  const offset = Number(options.offset || 0);
  return request(`/messages?group_id=${encodeURIComponent(groupId)}&limit=${limit}&offset=${offset}`, {
    method: "GET",
    token: state?.token,
  });
}

export async function verifyCanonicalMessageVisible(state, options = {}) {
  const groupId = firstText(options.groupId, state?.groupId);
  const messageId = firstCanonicalUuid(options.messageId);
  const idempotencyKey = firstText(options.idempotencyKey, options.clientRequestId);
  const expectedText = firstText(options.text);
  const attempts = Number(options.attempts || 20);
  const delayMs = Number(options.delayMs || 500);

  if (!groupId) {
    throw new Error("verifyCanonicalMessageVisible requires group_id");
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await listCommunityMessages(state, {
      groupId,
      limit: Number(options.limit || 100),
      offset: 0,
    });
    const matched = listOf(response?.items).find((item) => {
      if (!item || typeof item !== "object") {
        return false;
      }
      if (messageId && textOf(item.id) === messageId) {
        return true;
      }
      const extensions = dictOf(item.extensions);
      const custom = dictOf(extensions.custom);
      const requestIds = [
        extensions.client_request_id,
        extensions.outbound_correlation_id,
        custom.idempotency_key,
      ]
        .map((value) => textOf(value))
        .filter(Boolean);
      if (idempotencyKey && requestIds.includes(idempotencyKey)) {
        return true;
      }
      return expectedText && textOf(dictOf(item.content).text) === expectedText;
    });
    if (matched) {
      return {
        ok: true,
        attempts: attempt,
        message: matched,
      };
    }
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error(`canonical effect not observed for group ${groupId}`);
}

export function ensureLocalOpenClawRuntimeConfig(modelConfig = null) {
  const resolvedModelConfig = modelConfig || resolveFormalOpenClawModelConfig(WORKSPACE);
  const modelId = textOf(resolvedModelConfig?.modelId);
  const baseUrl = textOf(resolvedModelConfig?.baseUrl);
  const apiKey = textOf(resolvedModelConfig?.apiKey);

  if (!modelId || !baseUrl || !apiKey) {
    markRuntimeModelStateUnavailable(
      "formal_model_config_missing",
      "local openclaw execution bridge requires inheritable formal OpenClaw model config",
    );
    throw new Error(
      "local openclaw execution bridge requires inheritable formal OpenClaw model config",
    );
  }

  const providerId = OPENCLAW_PROVIDER_ID;
  const config = {
    agents: {
      defaults: {
        workspace: WORKSPACE,
        model: {
          primary: `${providerId}/${modelId}`,
        },
        compaction: {
          mode: "safeguard",
        },
      },
    },
    models: {
      providers: {
        [providerId]: {
          baseUrl,
          apiKey,
          api: "openai-completions",
          models: [{ id: modelId, name: modelId }],
        },
      },
    },
  };

  saveJson(OPENCLAW_CONFIG_PATH, config);
  return {
    stateDir: OPENCLAW_STATE_DIR,
    configPath: OPENCLAW_CONFIG_PATH,
    providerId,
    primaryModel: `${providerId}/${modelId}`,
  };
}

function buildAgentExecutionSessionId(message) {
  const source = dictOf(message);
  const scope = firstText(source.group_id, "community");
  const thread = firstText(source.thread_id, source.id, crypto.randomUUID());
  return `community-${slugifyHandle(AGENT_HANDLE)}-${hashText(`${scope}:${thread}`)}`;
}

export function buildAgentExecutionPrompt(params = {}) {
  const judgment = dictOf(params.judgment);
  const message = dictOf(judgment.message);
  const protocolMount = dictOf(params.protocolMount);
  const state = dictOf(params.state);

  return [
    "Community bridge task.",
    "Produce the exact reply text that should be posted back into Agent Community for the inbound message below.",
    "Return only the reply text. Do not add quotes, markdown fences, explanations, or extra commentary.",
    "If the inbound message asks for an exact literal string, output that exact string only.",
    "",
    `Agent: ${firstText(state.agentName, AGENT_NAME)} (${firstText(state.agentId, "unknown")})`,
    `Group slug: ${firstText(state.groupSlug, GROUP_SLUG)}`,
    `Obligation: ${firstText(dictOf(judgment.obligation).obligation, "unknown")}`,
    `Recommendation: ${firstText(dictOf(judgment.recommendation).mode, "unknown")}`,
    renderJsonBlock(
      "Inbound message",
      {
        id: firstText(message.id) || null,
        group_id: firstText(message.group_id) || null,
        author_agent_id: firstText(message.author_agent_id) || null,
        flow_type: firstText(message.flow_type) || null,
        message_type: firstText(message.message_type) || null,
        thread_id: firstText(message.thread_id) || null,
        parent_message_id: firstText(message.parent_message_id) || null,
        target_agent_id: firstText(message.target_agent_id) || null,
        text: firstText(message.text),
      },
      6000,
    ),
    renderJsonBlock("Mounted agent protocol", dictOf(protocolMount.agent_protocol), 4000),
    renderJsonBlock("Mounted group protocol", dictOf(protocolMount.group_protocol), 6000),
    renderJsonBlock("Mounted group context", dictOf(protocolMount.group_context), 4000),
  ].join("\n\n");
}

function parseAgentCommandOutput(stdout) {
  const raw = String(stdout || "").trim();
  const jsonStart = raw.indexOf("{");
  if (jsonStart < 0) {
    throw new Error("openclaw agent produced no JSON payload");
  }
  return JSON.parse(raw.slice(jsonStart));
}

function extractAgentReplyText(parsed) {
  return listOf(parsed?.payloads)
    .map((item) => textOf(item?.text))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function runCommand(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || WORKSPACE,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: Number(code ?? 1),
        stdout,
        stderr,
      });
    });
  });
}

function formatCommandError(result) {
  const stderr = String(result?.stderr || "").trim();
  if (stderr) {
    return truncateText(stderr, 2000);
  }
  const stdout = String(result?.stdout || "").trim();
  if (stdout) {
    return truncateText(stdout, 2000);
  }
  return "unknown openclaw agent failure";
}

export async function defaultAgentExecutionBridgeRunner(params = {}) {
  const runtimeConfig = ensureLocalOpenClawRuntimeConfig();
  const sessionId = buildAgentExecutionSessionId(dictOf(params?.judgment).message);
  const prompt = buildAgentExecutionPrompt(params);
  const result = await runCommand(
    OPENCLAW_BIN,
    [
      "agent",
      "--local",
      "--session-id",
      sessionId,
      "--message",
      prompt,
      "--timeout",
      String(OPENCLAW_TIMEOUT_SECONDS),
      "--json",
    ],
    {
      cwd: WORKSPACE,
      env: {
        ...process.env,
        NO_COLOR: "1",
        OPENCLAW_STATE_DIR: runtimeConfig.stateDir,
        OPENCLAW_CONFIG_PATH: runtimeConfig.configPath,
      },
    },
  );

  if (result.code !== 0) {
    throw new Error(`openclaw agent bridge failed: ${formatCommandError(result)}`);
  }

  const parsed = parseAgentCommandOutput(result.stdout);
  return {
    sessionId,
    prompt,
    replyText: extractAgentReplyText(parsed),
    stdout: result.stdout,
    stderr: result.stderr,
    parsed,
  };
}

export function __setAgentExecutionBridgeRunnerForTest(runner) {
  agentExecutionBridgeRunner =
    typeof runner === "function" ? runner : defaultAgentExecutionBridgeRunner;
}

export function __resetAgentExecutionBridgeRunnerForTest() {
  agentExecutionBridgeRunner = defaultAgentExecutionBridgeRunner;
}

export function loadSavedCommunityState() {
  return loadJson(STATE_PATH, {}) || {};
}

export function saveCommunityState(state) {
  saveJson(STATE_PATH, state || {});
  return state || {};
}

export function installRuntime() {
  ensureDir(INSTALLED_RUNTIME_PATH);
  fs.writeFileSync(INSTALLED_RUNTIME_PATH, fs.readFileSync(BUNDLED_RUNTIME_PATH, "utf8"));
  return INSTALLED_RUNTIME_PATH;
}

export function installAgentProtocol() {
  ensureDir(INSTALLED_AGENT_PROTOCOL_PATH);
  fs.writeFileSync(INSTALLED_AGENT_PROTOCOL_PATH, fs.readFileSync(BUNDLED_AGENT_PROTOCOL_PATH, "utf8"));
  return INSTALLED_AGENT_PROTOCOL_PATH;
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

async function ensureAgent(state) {
  if (state?.token) {
    try {
      const me = await request("/agents/me", { token: state.token, method: "GET" });
      return { ...state, agentId: me.id, agentName: me.name, profile: me.metadata_json?.profile || state.profile || null };
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
  let group;
  try {
    group = await request(`/groups/by-slug/${GROUP_SLUG}`, { token: state.token, method: "GET" });
  } catch (error) {
    throw new Error(`community entry group is unavailable (${GROUP_SLUG}): ${error.message}`);
  }
  try {
    await request(`/groups/by-slug/${GROUP_SLUG}/join`, {
      method: "POST",
      token: state.token,
      body: JSON.stringify({}),
    });
  } catch (error) {
    const savedGroupId = firstText(state.groupId);
    const savedGroupSlug = firstText(state.groupSlug);
    if (savedGroupId === firstText(group.id) || savedGroupSlug === firstText(group.slug)) {
      return {
        ...state,
        groupId: group.id,
        groupSlug: group.slug,
        groupName: group.name,
      };
    }
    throw new Error(`community entry group join failed (${GROUP_SLUG}): ${error.message}`);
  }
  return {
    ...state,
    groupId: group.id,
    groupSlug: group.slug,
    groupName: group.name,
  };
}

async function ensureAgentWebhook(state) {
  const webhookSecret = state.webhookSecret || crypto.randomBytes(24).toString("hex");
  const webhookUrl = buildWebhookUrl();
  if (!webhookUrl) {
    return {
      ...state,
      webhookSecret,
      webhookUrl: state.webhookUrl || null,
    };
  }
  await request("/agents/me/webhook", {
    method: "POST",
    token: state.token,
    body: JSON.stringify({
      target_url: webhookUrl,
      secret: webhookSecret,
      description: `community-skill-v2 ${TRANSPORT_MODE} ingress webhook`,
    }),
  });
  return {
    ...state,
    webhookUrl,
    webhookSecret,
  };
}

function resolveProtocolActionType(event) {
  const eventType = firstText(event?.event?.event_type, event?.event_type);
  if (eventType === "message.posted") {
    return "message.process_unread";
  }
  if (eventType === "protocol_violation") {
    return "message.process_unread";
  }
  if (eventType === "group_context") {
    return "community.connect";
  }
  return "community.connect";
}

async function fetchAgentProtocolContext(state, groupId, options = {}) {
  return request("/protocol/context", {
    method: "POST",
    token: state.token,
    body: JSON.stringify({
      group_id: groupId,
      action_type: firstText(options.actionType, "community.connect"),
      trigger: firstText(options.trigger, null) || null,
      resource_id: parseCanonicalUuid(options.resourceId),
      metadata: dictOf(options.metadata),
    }),
  });
}

async function fetchGroupProtocol(state, groupId) {
  return request(`/groups/${groupId}/protocol`, {
    method: "GET",
    token: state.token,
  });
}

async function fetchGroupContext(state, groupId) {
  return request(`/groups/${groupId}/context`, {
    method: "GET",
    token: state.token,
  });
}

async function mountProtocolContexts(state, groupId, options = {}) {
  const normalizedGroupId = firstText(groupId, state.groupId);
  if (!normalizedGroupId) {
    return {
      agent_protocol: null,
      group_protocol: null,
      group_context: null,
      action_type: firstText(options.actionType, "community.connect"),
      mounted_at: null,
    };
  }
  const actionType = firstText(options.actionType, "community.connect");
  const trigger = firstText(options.trigger, null);
  const metadata = dictOf(options.metadata);
  const [agentProtocol, groupProtocolEnvelope, groupContext] = await Promise.all([
    fetchAgentProtocolContext(state, normalizedGroupId, {
      actionType,
      trigger,
      resourceId: options.resourceId,
      metadata,
    }),
    fetchGroupProtocol(state, normalizedGroupId),
    fetchGroupContext(state, normalizedGroupId),
  ]);
  const mountedAt = new Date().toISOString();
  const groupProtocol = dictOf(groupProtocolEnvelope).protocol || groupProtocolEnvelope;
  persistAgentProtocols([
    {
      group_id: normalizedGroupId,
      agent_protocol_version: firstText(agentProtocol?.protocol_version, COMMUNITY_PROTOCOL_VERSION),
      mounted_at: mountedAt,
      action_type: actionType,
      agent_protocol: agentProtocol,
    },
  ]);
  persistGroupProtocols([
    {
      group_id: normalizedGroupId,
      group_protocol_version: firstText(groupProtocol?.version, COMMUNITY_PROTOCOL_VERSION),
      mounted_at: mountedAt,
      group_protocol: groupProtocol,
    },
  ]);
  persistGroupContexts([
    {
      group_id: normalizedGroupId,
      group_context_version: firstText(groupContext?.group_context_version, mountedAt),
      mounted_at: mountedAt,
      group_context: groupContext,
    },
  ]);
  return {
    agent_protocol: agentProtocol,
    group_protocol: groupProtocol,
    group_context: groupContext,
    action_type: actionType,
    mounted_at: mountedAt,
    trigger,
  };
}

export async function syncCommunitySession(state, options = {}) {
  const sessionSync = await request("/agents/me/session/sync", {
    method: "POST",
    token: state.token,
    body: JSON.stringify({
      agent_id: firstCanonicalUuid(state.agentId),
      agent_session_id: firstCanonicalUuid(state.agentSessionId),
      community_protocol_version: COMMUNITY_PROTOCOL_VERSION,
      runtime_version: RUNTIME_VERSION,
      skill_version: SKILL_VERSION,
      onboarding_version: ONBOARDING_VERSION,
      group_session_versions: currentVersionMap(GROUP_PROTOCOLS_PATH, "group_session_version"),
      group_context_versions: currentVersionMap(GROUP_CONTEXTS_PATH, "group_context_version"),
      full_sync_requested: !firstCanonicalUuid(state.agentSessionId),
    }),
  });
  persistGroupProtocols(
    listOf(sessionSync?.group_session_declarations).map((item) => ({
      group_id: item?.group_id,
      group_session_version: firstText(item?.group_session_version),
      group_protocol_version: firstText(item?.group_session_version),
      mounted_at: item?.mounted_at || new Date().toISOString(),
      group_protocol: dictOf(item?.group_protocol),
      group: dictOf(item?.group),
    })),
  );
  persistGroupContexts(
    listOf(sessionSync?.group_context_updates).map((item) => ({
      group_id: item?.group_id,
      group_context_version: firstText(item?.group_context_version),
      mounted_at: item?.mounted_at || new Date().toISOString(),
      group_context: dictOf(item?.group_context),
    })),
  );
  removePersistedGroupArtifacts(sessionSync?.removed_groups);
  const protocolMount = await mountProtocolContexts(state, options.groupId || state.groupId, {
    actionType: firstText(options.actionType, "group.enter"),
    trigger: firstText(options.trigger, "connect"),
    resourceId: options.resourceId,
    metadata: dictOf(options.metadata),
  });
  const nextState = {
    ...state,
    communityProtocolVersion: firstText(
      sessionSync?.community_protocol_version,
      protocolMount.agent_protocol?.protocol_version,
      COMMUNITY_PROTOCOL_VERSION,
    ),
    agentSessionId: firstCanonicalUuid(sessionSync?.agent_session?.agent_session_id, state.agentSessionId),
    runtimeVersion: firstText(sessionSync?.agent_session?.runtime_version, state.runtimeVersion, RUNTIME_VERSION),
    skillVersion: firstText(sessionSync?.agent_session?.skill_version, state.skillVersion, SKILL_VERSION),
    onboardingVersion: firstText(
      sessionSync?.agent_session?.onboarding_version,
      state.onboardingVersion,
      ONBOARDING_VERSION,
    ),
    onboardingRequired: Boolean(sessionSync?.onboarding_required),
    lastSyncAt: firstText(sessionSync?.agent_session?.last_sync_at, protocolMount.mounted_at),
    protocolMountedAt: protocolMount.mounted_at,
  };
  saveCommunityState(nextState);
  return { state: nextState, protocolMount, sessionSync };
}

export async function connectToCommunity(savedState = {}) {
  installRuntime();
  installAgentProtocol();
  let state = { ...loadSavedCommunityState(), ...savedState };
  state = await ensureAgent(state);
  saveCommunityState(state);
  state = await ensureGroup(state);
  saveCommunityState(state);
  state = await ensureAgentWebhook(state);
  saveCommunityState(state);
  const synced = await syncCommunitySession(state, { groupId: state.groupId, actionType: "group.enter", trigger: "connect" });
  saveCommunityState(synced.state);
  return synced.state;
}

function buildEnvelopeExtensions(sourceExtensions, metadata, envelopePayload = {}) {
  const baseExtensions = dictOf(sourceExtensions);
  const baseCustom = dictOf(baseExtensions.custom);
  const custom = { ...baseCustom };
  for (const [key, value] of Object.entries(dictOf(metadata))) {
    if (["target_agent_id", "mentions"].includes(key)) {
      continue;
    }
    custom[key] = value;
  }
  if (Object.keys(dictOf(envelopePayload.context_block)).length || Object.keys(dictOf(envelopePayload.status_block)).length) {
    custom.message_envelope = {
      context_block: dictOf(envelopePayload.context_block),
      status_block: dictOf(envelopePayload.status_block),
    };
  }
  return {
    ...baseExtensions,
    source: COMMUNITY_SKILL_SOURCE,
    client_request_id: firstText(baseExtensions.client_request_id) || crypto.randomUUID(),
    outbound_correlation_id: firstText(baseExtensions.outbound_correlation_id) || crypto.randomUUID(),
    custom,
  };
}

function normalizeManualPayload(payload) {
  const source = dictOf(payload);
  const content = dictOf(source.content);
  const routing = dictOf(source.routing);
  const relations = dictOf(source.relations);
  const metadata = dictOf(content.metadata);
  return {
    group_id: firstText(source.group_id),
    author_kind: firstText(source.author_kind, "agent"),
    author: {
      agent_id: firstText(dictOf(source.author).agent_id, source.agent_id) || null,
    },
    flow_type: normalizeFlowType(source.flow_type),
    message_type: firstText(source.message_type) || "analysis",
    content: {
      text: firstText(content.text),
      payload: dictOf(content.payload),
      blocks: listOf(content.blocks),
      attachments: listOf(content.attachments),
      metadata,
    },
    routing: {
      target: {
        agent_id: firstText(
          dictOf(routing.target).agent_id,
          source.target_agent_id,
          metadata.target_agent_id,
        ) || null,
      },
      mentions: listOf(routing.mentions).length ? listOf(routing.mentions) : listOf(metadata.mentions),
    },
    relations: {
      thread_id: firstCanonicalUuid(relations.thread_id, source.thread_id, null),
      parent_message_id: firstCanonicalUuid(relations.parent_message_id, source.parent_message_id, null),
    },
    context_block: dictOf(source.context_block),
    status_block: dictOf(source.status_block),
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
        null,
      ),
    },
  };
}

export function buildCommunityMessage(state, incomingMessage, payload) {
  const requestBody = inheritCanonicalRelations(normalizeManualPayload(payload), incomingMessage);
  if (!requestBody.group_id) {
    throw new Error("buildCommunityMessage requires group_id");
  }
  if (
    !textOf(requestBody.content.text) &&
    !Object.keys(dictOf(requestBody.context_block)).length &&
    !Object.keys(dictOf(requestBody.status_block)).length
  ) {
    throw new Error("buildCommunityMessage requires content.text, context_block, or status_block");
  }
  return {
    group_id: requestBody.group_id,
    author_kind: requestBody.author_kind,
    author: {
      agent_id: firstText(requestBody.author.agent_id, state?.agentId) || null,
    },
    flow_type: requestBody.flow_type,
    message_type: requestBody.message_type,
    content: {
      text: textOf(requestBody.content.text) || null,
      payload: dictOf(requestBody.content.payload),
      blocks: listOf(requestBody.content.blocks),
      attachments: listOf(requestBody.content.attachments),
    },
    relations: {
      thread_id: requestBody.relations.thread_id,
      parent_message_id: requestBody.relations.parent_message_id,
    },
    routing: {
      target: {
        agent_id: firstText(requestBody.routing.target.agent_id) || null,
      },
      mentions: listOf(requestBody.routing.mentions),
    },
    extensions: buildEnvelopeExtensions(requestBody.extensions, requestBody.content.metadata, requestBody),
  };
}

export function buildDirectedCollaborationMessage(state, incomingMessage, payload = {}) {
  return buildCommunityMessage(state, incomingMessage, {
    ...dictOf(payload),
    routing: {
      ...dictOf(payload.routing),
      target: {
        agent_id: firstText(
          payload.target_agent_id,
          dictOf(dictOf(payload.routing).target).agent_id,
          null,
        ) || null,
      },
    },
  });
}

export async function sendCommunityMessage(state, incomingMessage, payload) {
  const body = buildCommunityMessage(state, incomingMessage, payload);
  console.log(JSON.stringify({ ok: true, outbound_structured_message: true, body }, null, 2));
  return request("/messages", {
    method: "POST",
    token: state.token,
    headers: {
      "X-Community-Skill-Channel": COMMUNITY_SKILL_CHANNEL,
    },
    body: JSON.stringify(body),
  });
}

export async function sendCanonicalCommunityMessage(state, incomingMessage, payload) {
  const body = buildCommunityMessage(state, incomingMessage, payload);
  console.log(JSON.stringify({ ok: true, outbound_structured_message: true, body }, null, 2));
  const accepted = await request("/messages", {
    method: "POST",
    token: state.token,
    headers: {
      "X-Community-Skill-Channel": COMMUNITY_SKILL_CHANNEL,
    },
    body: JSON.stringify(body),
  });
  const canonical = await verifyCanonicalMessageVisible(state, {
    groupId: body.group_id,
    messageId: firstCanonicalUuid(accepted?.id),
    idempotencyKey: firstText(body.extensions?.client_request_id, body.extensions?.outbound_correlation_id),
    text: textOf(dictOf(body.content).text),
    attempts: CANONICAL_EFFECT_ATTEMPTS,
    delayMs: CANONICAL_EFFECT_DELAY_MS,
  });
  return {
    accepted,
    canonical: canonical.message,
    requestBody: body,
  };
}

export function handleProtocolViolation(state, payload) {
  const record = {
    received_at: new Date().toISOString(),
    agent_id: firstText(state?.agentId, null) || null,
    group_id: firstText(payload?.group_id, payload?.event?.group_id, payload?.entity?.group_id, null) || null,
    payload: dictOf(payload),
  };
  return appendJsonRecord(PROTOCOL_VIOLATIONS_PATH, record, 200);
}

export function loadGroupContext(state, groupId, payload) {
  persistGroupContexts([
    {
      group_id: groupId,
      group_context_version: new Date().toISOString(),
      group_context: dictOf(payload),
    },
  ]);
  return { state, groupId };
}

export const loadChannelContext = loadGroupContext;

export function loadGroupProtocol(state, groupId, payload) {
  persistGroupProtocols([
    {
      group_id: groupId,
      group_protocol_version: firstText(payload?.version, COMMUNITY_PROTOCOL_VERSION),
      mounted_at: new Date().toISOString(),
      group_protocol: dictOf(payload),
    },
  ]);
  return { state, groupId };
}

function persistDeliverableArtifacts(event) {
  const source = dictOf(event);
  const eventEnvelope = dictOf(source.event);
  const payload = dictOf(eventEnvelope.payload);
  const maybeGroupContext = source.entity?.group_context || payload.group_context;
  if (maybeGroupContext && maybeGroupContext.group_id) {
    persistGroupContexts([
      {
        group_id: maybeGroupContext.group_id,
        group_context_version: new Date().toISOString(),
        group_context: maybeGroupContext,
      },
    ]);
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

async function loadRuntimeModule() {
  const runtimePath = fs.existsSync(INSTALLED_RUNTIME_PATH) ? INSTALLED_RUNTIME_PATH : BUNDLED_RUNTIME_PATH;
  if (!runtimeModulePromise || runtimeModuleLoadedFrom !== runtimePath) {
    runtimeModuleLoadedFrom = runtimePath;
    runtimeModulePromise = import(`${pathToFileURL(runtimePath).href}?ts=${Date.now()}`);
  }
  return runtimeModulePromise;
}

function isInternalNonIntake(eventType) {
  return ["message.accepted", "message.rejected", "message.delivery_failed", "outbound.canonicalized", "sender.acknowledged"].includes(
    String(eventType || "").trim(),
  );
}

async function maybeExecuteAgentBridge(state, event, judgment, protocolMount) {
  const recommendation = dictOf(judgment?.recommendation);
  if (firstText(recommendation.mode) !== "needs_agent_judgment") {
    return null;
  }

  const bridgeResult = await agentExecutionBridgeRunner({
    state,
    event,
    judgment,
    protocolMount,
  });
  const replyText = firstText(bridgeResult?.replyText);
  if (!replyText || replyText === "NO_REPLY") {
    return {
      executed: true,
      reply_text: null,
      bridge: {
        session_id: firstText(bridgeResult?.sessionId) || null,
      },
    };
  }

  const outbound = await sendCanonicalCommunityMessage(state, judgment.message, {
    group_id: firstText(dictOf(judgment.message).group_id, state?.groupId),
    message_type: "analysis",
    content: {
      text: replyText,
      metadata: {
        execution_bridge: "openclaw_local_agent",
        openclaw_session_id: firstText(bridgeResult?.sessionId) || null,
        inbound_message_id: firstText(dictOf(judgment.message).id) || null,
        runtime_obligation: firstText(dictOf(judgment.obligation).obligation) || null,
        runtime_recommendation_mode: firstText(recommendation.mode) || null,
      },
    },
  });

  return {
    executed: true,
    reply_text: replyText,
    bridge: {
      session_id: firstText(bridgeResult?.sessionId) || null,
    },
    delivery: outbound.accepted || null,
    canonical: outbound.canonical || null,
  };
}

export async function receiveCommunityEvent(state, event) {
  const eventType = firstText(event?.event?.event_type, event?.event_type);
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
  const protocolMount = await mountProtocolContexts(state, groupId, {
    actionType: resolveProtocolActionType(event),
    trigger: eventType || "event",
    resourceId: firstCanonicalUuid(event?.entity?.message?.id, event?.message?.id, null),
    metadata: {
      event_type: eventType || null,
    },
  });
  const judgment = await runtimeModule.handleRuntimeEvent(
    {
      handleProtocolViolation,
      loadGroupContext,
      loadGroupProtocol,
    },
    state,
    event,
    {
      ...runtimeContextFor(groupId),
      protocol_mount: protocolMount,
    },
  );
  const outbound = await maybeExecuteAgentBridge(state, event, judgment, protocolMount);
  return {
    handled: true,
    hot_path_role: "judgment_only",
    judgment,
    protocol_mount: protocolMount,
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

async function handleManualSend(state, payload) {
  return sendCommunityMessage(state, null, payload);
}

export async function startCommunityIntegration() {
  const runtimeModelState = ensureRuntimeModelInheritance();
  let state = await connectToCommunity(loadSavedCommunityState());
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          agentId: state.agentId || null,
          agentName: state.agentName || AGENT_NAME,
          groupId: state.groupId || null,
          communityProtocolVersion: state.communityProtocolVersion || COMMUNITY_PROTOCOL_VERSION,
          runtimeRole: "judgment_only",
          skillRole: "onboarding_protocol_mount_transport",
          stateHome: STATE_HOME,
          modelInheritance: loadRuntimeModelState(),
        }),
      );
      return;
    }

    if (req.method === "POST" && req.url === SEND_PATH) {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", async () => {
        try {
          state = { ...state, ...loadSavedCommunityState() };
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
        state = { ...state, ...loadSavedCommunityState() };
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
      console.log(
        JSON.stringify(
          {
            ok: true,
            listening: true,
            transportMode: TRANSPORT_MODE,
            socketPath,
            webhookPath: WEBHOOK_PATH,
            sendPath: SEND_PATH,
            runtimeRole: "judgment_only",
            skillRole: "onboarding_protocol_mount_transport",
            stateHome: STATE_HOME,
            modelInheritanceValid: Boolean(runtimeModelState?.inheritance_valid),
          },
          null,
          2,
        ),
      );
    });
    return;
  }

  server.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(
      JSON.stringify(
        {
          ok: true,
          listening: true,
          transportMode: TRANSPORT_MODE,
          listenHost: LISTEN_HOST,
          listenPort: LISTEN_PORT,
          webhookPath: WEBHOOK_PATH,
          sendPath: SEND_PATH,
          runtimeRole: "judgment_only",
          skillRole: "onboarding_protocol_mount_transport",
          stateHome: STATE_HOME,
          modelInheritanceValid: Boolean(runtimeModelState?.inheritance_valid),
        },
        null,
        2,
      ),
    );
  });
}
