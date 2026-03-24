import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILL_ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      i += 1;
    } else {
      options[key] = "true";
    }
  }
  return { positional, options };
}

function pruneEmpty(value) {
  const next = {};
  for (const [key, item] of Object.entries(value || {})) {
    if (item === undefined || item === null) {
      continue;
    }
    if (typeof item === "string" && !item.trim()) {
      continue;
    }
    next[key] = item;
  }
  return next;
}

function resolveWorkspaceRoot() {
  if (process.env.WORKSPACE_ROOT) {
    return path.resolve(process.env.WORKSPACE_ROOT);
  }
  if (path.basename(path.dirname(SKILL_ROOT)) === "skills") {
    return path.resolve(SKILL_ROOT, "..", "..");
  }
  return path.resolve(SKILL_ROOT);
}

function parseEnvValue(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return "";
  }
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    const inner = value.slice(1, -1);
    return inner.replace(/\'/g, "'").replace(/\"/g, '"');
  }
  return value;
}

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const value = parseEnvValue(trimmed.slice(eq + 1));
    process.env[key] = value;
  }
}

let runtimePromise = null;
let loadedContext = null;
const COMMAND_TIMEOUT_MS = Number(process.env.COMMUNITY_CLI_TIMEOUT_MS || '45000');
const COMMAND_REQUEST_TIMEOUT_MS = Number(process.env.COMMUNITY_CLI_REQUEST_TIMEOUT_MS || '90000');
const SEND_IDEMPOTENCY_TTL_MS = Number(process.env.COMMUNITY_SEND_IDEMPOTENCY_TTL_MS || '600000');
let currentCommand = 'status';
let currentPhase = 'startup';

const VERSION_PATH = path.join(SKILL_ROOT, 'VERSION.json');
const RELEASES_PATH = path.join(SKILL_ROOT, 'RELEASES.json');
const GIT_BIN = process.env.COMMUNITY_GIT_BIN || (process.platform === 'win32' ? 'D:/Program Files/Git/cmd/git.exe' : 'git');
const STATE_DIRNAME = '.openclaw';

function loadJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function boolOption(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function commandExists(bin) {
  const result = spawnSync('bash', ['-lc', `command -v ${bin}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function parseJsonEnvFile(envPath) {
  const values = {};
  if (!fs.existsSync(envPath)) {
    return values;
  }
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    values[key] = parseEnvValue(trimmed.slice(eq + 1));
  }
  return values;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function resolveOpenClawHome(workspaceRoot) {
  const candidates = [
    process.env.OPENCLAW_HOME,
    path.basename(workspaceRoot) === 'workspace' ? path.resolve(workspaceRoot, '..') : '',
    '/root/.openclaw',
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (!normalized) {
      continue;
    }
    const configPath = path.join(normalized, 'openclaw.json');
    if (fs.existsSync(configPath)) {
      return normalized;
    }
  }
  return null;
}

function resolveRealModelConfig(workspaceRoot) {
  const explicitModel = {
    baseUrl: firstNonEmpty(process.env.MODEL_BASE_URL),
    apiKey: firstNonEmpty(process.env.MODEL_API_KEY),
    modelId: firstNonEmpty(process.env.MODEL_ID),
  };
  if (explicitModel.baseUrl && explicitModel.apiKey && explicitModel.modelId) {
    return {
      ...explicitModel,
      provider: '',
      source: 'environment:MODEL_*',
    };
  }

  const openclawHome = resolveOpenClawHome(workspaceRoot);
  if (openclawHome) {
    const openclawPath = path.join(openclawHome, 'openclaw.json');
    const modelsPath = path.join(openclawHome, 'agents', 'main', 'agent', 'models.json');
    const openclawConfig = loadJsonFile(openclawPath, {}) || {};
    const modelsConfig = loadJsonFile(modelsPath, {}) || {};
    const primary = String(openclawConfig?.agents?.defaults?.model?.primary || '').trim();
    let providerName = '';
    let modelId = '';
    if (primary.includes('/')) {
      [providerName, modelId] = primary.split('/', 2);
    }
    const providers = modelsConfig?.providers || openclawConfig?.models?.providers || {};
    let provider = providerName ? providers?.[providerName] : null;
    if (!provider && Object.keys(providers).length === 1) {
      [providerName, provider] = Object.entries(providers)[0];
    }
    const baseUrl = String(provider?.baseUrl || '').trim();
    const apiKey = String(provider?.apiKey || '').trim();
    const resolvedModelId = String(modelId || '').trim();
    if (baseUrl && apiKey && resolvedModelId) {
      return {
        baseUrl,
        apiKey,
        modelId: resolvedModelId,
        provider: providerName,
        source: `${modelsPath} + ${openclawPath}`,
      };
    }
  }

  const fallback = {
    baseUrl: firstNonEmpty(process.env.OPENAI_BASE_URL, process.env.OPENAI_API_BASE, process.env.LLM_BASE_URL),
    apiKey: firstNonEmpty(process.env.OPENAI_API_KEY, process.env.LLM_API_KEY),
    modelId: firstNonEmpty(process.env.OPENAI_MODEL, process.env.OPENAI_MODEL_ID, process.env.DEFAULT_MODEL, process.env.MODEL),
  };
  if (fallback.baseUrl && fallback.apiKey && fallback.modelId) {
    return {
      ...fallback,
      provider: '',
      source: 'environment:OPENAI/LLM',
    };
  }
  return null;
}

function detectPort8848Status(options = {}) {
  const confirmed = boolOption(options['confirm-port-open']) || boolOption(process.env.COMMUNITY_PORT_8848_CONFIRMED);
  const status = {
    confirmed,
    listenerDetected: false,
    publicUrl: firstNonEmpty(process.env.COMMUNITY_WEBHOOK_PUBLIC_URL),
    publicHost: firstNonEmpty(process.env.COMMUNITY_WEBHOOK_PUBLIC_HOST),
    canAutoVerifyPublicReachability: false,
    blockers: [],
    summary: '',
  };
  if (commandExists('ss')) {
    const result = spawnSync('ss', ['-ltn', '( sport = :8848 )'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    status.listenerDetected = result.status === 0 && /:8848\b/.test(String(result.stdout || ''));
  }
  if (confirmed) {
    status.summary = '8848 marked as externally reachable by explicit confirmation';
    return status;
  }
  status.blockers.push('public reachability of port 8848 cannot be proven automatically from this host; confirm firewall/security-group exposure');
  status.summary = status.listenerDetected
    ? 'local listener detection succeeded, but external reachability still requires manual confirmation'
    : 'no explicit confirmation for 8848 external reachability';
  return status;
}

function buildProfileOverrides(options = {}) {
  return pruneEmpty({
    display_name: options['display-name'],
    handle: options.handle,
    identity: options.identity,
    tagline: options.tagline,
    bio: options.bio,
    avatar_text: options['avatar-text'],
    accent_color: options['accent-color'],
    expertise: options.expertise
      ? String(options.expertise)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
  });
}

function loadVersionManifest() {
  return loadJsonFile(VERSION_PATH, {}) || {};
}

function loadReleaseManifest() {
  return loadJsonFile(RELEASES_PATH, { current: null, releases: [] }) || { current: null, releases: [] };
}

function findRelease(version) {
  const manifest = loadReleaseManifest();
  const normalized = String(version || '').trim();
  return (manifest.releases || []).find((item) => String(item?.version || '').trim() === normalized) || null;
}

function fallbackReleaseRef(version) {
  const normalized = String(version || '').trim();
  if (!normalized) {
    return null;
  }
  return normalized.startswith('v') ? normalized : `v${normalized}`;
}

function latestPublishedRelease() {
  const manifest = loadReleaseManifest();
  const current = String(manifest.current || '').trim();
  return findRelease(current) || null;
}

function git(args, options = {}) {
  const result = spawnSync(GIT_BIN, args, {
    cwd: SKILL_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim();
    throw new Error(message);
  }
  return String(result.stdout || '').trim();
}

function resolveGitDir() {
  const dotGit = path.join(SKILL_ROOT, '.git');
  if (fs.existsSync(dotGit) && fs.statSync(dotGit).isDirectory()) {
    return dotGit;
  }
  if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
    const raw = fs.readFileSync(dotGit, 'utf8').trim();
    const match = raw.match(/^gitdir:\s*(.+)$/i);
    if (match) {
      return path.resolve(SKILL_ROOT, match[1].trim());
    }
  }
  return null;
}

function readLooseRef(gitDir, refName) {
  const refPath = path.join(gitDir, ...refName.split('/'));
  if (fs.existsSync(refPath)) {
    return fs.readFileSync(refPath, 'utf8').trim();
  }
  const packedRefs = path.join(gitDir, 'packed-refs');
  if (fs.existsSync(packedRefs)) {
    const lines = fs.readFileSync(packedRefs, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.startsWith('#') || line.startsWith('^')) {
        continue;
      }
      const [hash, ref] = line.split(' ');
      if (ref === refName) {
        return hash.trim();
      }
    }
  }
  return null;
}

function currentGitRefFromFiles() {
  try {
    const gitDir = resolveGitDir();
    if (!gitDir) {
      return null;
    }
    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) {
      return null;
    }
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (!head) {
      return null;
    }
    if (!head.startsWith('ref: ')) {
      return head;
    }
    return readLooseRef(gitDir, head.slice(5).trim());
  } catch {
    return null;
  }
}

function ensureCleanWorkingTree() {
  const status = git(['status', '--short']);
  if (status.trim()) {
    throw new Error('working tree is dirty; commit or stash local changes before self-update or rollback');
  }
}

function currentGitRef() {
  return currentGitRefFromFiles();
}

function writeVersionState(payload) {
  const workspaceRoot = loadedContext?.workspaceRoot || resolveWorkspaceRoot();
  const versionStatePath = path.join(workspaceRoot, '.openclaw', 'community-skill-version.json');
  fs.mkdirSync(path.dirname(versionStatePath), { recursive: true });
  fs.writeFileSync(versionStatePath, `${JSON.stringify(payload, null, 2)}
`);
  return versionStatePath;
}

function maybeRunOnboarding(runOptions = {}) {
  if (process.platform === 'win32') {
    return { ran: false, reason: 'unsupported_platform' };
  }
  const scriptPath = path.join(SKILL_ROOT, 'scripts', 'ensure-community-agent-onboarding.sh');
  if (!fs.existsSync(scriptPath)) {
    return { ran: false, reason: 'missing_onboarding_script' };
  }
  const env = {
    ...process.env,
    ...(runOptions.env || {}),
  };
  const result = spawnSync('bash', [scriptPath], {
    cwd: resolveWorkspaceRoot(),
    stdio: 'inherit',
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    throw new Error(`onboarding refresh failed with exit code ${result.status}`);
  }
  return { ran: true, reason: runOptions.reason || 'onboarding_refreshed' };
}

function trace(phase, extra = {}) {
  currentPhase = phase;
  console.error(
    JSON.stringify(
      {
        ok: true,
        cli_trace: true,
        command: currentCommand,
        phase,
        ...extra,
      },
      null,
      2,
    ),
  );
}

async function flushStreams() {
  await Promise.all([
    new Promise((resolve) => process.stdout.write('', resolve)),
    new Promise((resolve) => process.stderr.write('', resolve)),
  ]);
}

function sendCacheFilePath() {
  const workspaceRoot = loadedContext?.workspaceRoot || resolveWorkspaceRoot();
  return path.join(workspaceRoot, ".openclaw", "community-send-idempotency.json");
}

function loadSendCache() {
  const cachePath = sendCacheFilePath();
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return {};
  }
}

function saveSendCache(cache) {
  const cachePath = sendCacheFilePath();
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}
`);
}

function pruneSendCache(cache) {
  const cutoff = Date.now() - SEND_IDEMPOTENCY_TTL_MS;
  const next = {};
  for (const [key, entry] of Object.entries(cache || {})) {
    const updatedAt = Number(entry?.updatedAt || 0);
    if (updatedAt >= cutoff) {
      next[key] = entry;
    }
  }
  return next;
}

function computeSendIdempotencyKey(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload || {})).digest("hex");
}

function upsertSendCacheEntry(idempotencyKey, patch) {
  const cache = pruneSendCache(loadSendCache());
  cache[idempotencyKey] = {
    ...(cache[idempotencyKey] || {}),
    ...patch,
    updatedAt: Date.now(),
  };
  saveSendCache(cache);
  return cache[idempotencyKey];
}

function recentSendCacheEntry(idempotencyKey) {
  const cache = pruneSendCache(loadSendCache());
  const entry = cache[idempotencyKey] || null;
  saveSendCache(cache);
  return entry;
}

function buildSyntheticSuccessResponse(status, data) {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function withSendRequestSuccessHandling(idempotencyKey, callback) {
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url || "";
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (method === "POST" && /\/messages(?:\?|$)/.test(url)) {
      const headers = new Headers(init?.headers || (typeof input !== "string" ? input?.headers : undefined) || {});
      headers.set("Idempotency-Key", idempotencyKey);
      const response = await originalFetch(input, {
        ...init,
        headers,
        signal: AbortSignal.timeout(COMMAND_REQUEST_TIMEOUT_MS),
      });
      trace("send.api_response_headers", { status: response.status, ok: response.ok, idempotencyKey });
      if (response.ok) {
        upsertSendCacheEntry(idempotencyKey, {
          state: "sent",
          status: response.status,
        });
        return buildSyntheticSuccessResponse(response.status, {
          accepted: true,
          status: response.status,
          idempotency_key: idempotencyKey,
        });
      }
      return response;
    }
    return originalFetch(input, init);
  };

  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function startCommandWatchdog() {
  const timer = setTimeout(async () => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          timeout: true,
          command: currentCommand,
          phase: currentPhase,
          timeoutMs: COMMAND_TIMEOUT_MS,
        },
        null,
        2,
      ),
    );
    await flushStreams();
    process.exit(124);
  }, COMMAND_TIMEOUT_MS);
  timer.unref();
  return timer;
}

async function getRuntime() {
  if (runtimePromise) {
    return runtimePromise;
  }

  const workspaceRoot = resolveWorkspaceRoot();
  const stateDir = path.join(workspaceRoot, ".openclaw");
  const bundledBootstrap = path.join(SKILL_ROOT, "community-bootstrap.env");
  const workspaceBootstrap = path.join(stateDir, "community-bootstrap.env");
  const workspaceEnv = path.join(stateDir, "community-agent.env");

  process.env.WORKSPACE_ROOT = workspaceRoot;
  loadEnvFile(bundledBootstrap);
  loadEnvFile(workspaceBootstrap);
  loadEnvFile(workspaceEnv);
  process.env.WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || workspaceRoot;

  loadedContext = {
    workspaceRoot,
    stateDir,
    bundledBootstrap,
    workspaceBootstrap,
    workspaceEnv,
  };

  runtimePromise = import(pathToFileURL(path.join(SKILL_ROOT, "scripts", "community_integration.mjs")).href);
  return runtimePromise;
}

async function ensureState() {
  const runtime = await getRuntime();
  const saved = runtime.loadSavedCommunityState();
  const state = await runtime.connectToCommunity(saved);
  runtime.saveCommunityState(state);
  return { runtime, state };
}

async function requireSavedState(requirements = {}) {
  const runtime = await getRuntime();
  const state = runtime.loadSavedCommunityState();
  if (requirements.token && !state.token) {
    throw new Error("saved community state is missing token; run profile-sync or onboarding first");
  }
  if (requirements.groupId && !state.groupId) {
    throw new Error("saved community state is missing groupId; run profile-sync or onboarding first");
  }
  return { runtime, state };
}

function localStateCleanupPaths() {
  const workspaceRoot = loadedContext?.workspaceRoot || resolveWorkspaceRoot();
  const stateRoot = path.join(workspaceRoot, STATE_DIRNAME);
  return [
    path.join(stateRoot, 'community-agent.env'),
    path.join(stateRoot, 'community-bootstrap.env'),
    path.join(stateRoot, 'community-agent.bootstrap.json'),
    path.join(stateRoot, 'community-skill-version.json'),
    path.join(stateRoot, 'community-send-idempotency.json'),
    path.join(stateRoot, 'community-agent-template', 'state', 'community-webhook-state.json'),
    path.join(stateRoot, 'community-agent-template', 'state', 'community-channel-contexts.json'),
    path.join(stateRoot, 'community-agent-template', 'state', 'community-workflow-contracts.json'),
    path.join(stateRoot, 'community-agent-template', 'state', 'community-protocol-violations.json'),
    path.join(stateRoot, 'community-agent-template', 'state', 'community-outbound-receipts.json'),
    path.join(stateRoot, 'community-agent-template', 'state', 'community-outbound-debug.json'),
    path.join(stateRoot, 'community-agent-template', 'state', 'community-outbound-guard.json'),
  ];
}

async function cmdCleanupLocalState(options) {
  const confirmed = String(options['confirm-clean-env'] || '').trim().toLowerCase();
  if (confirmed !== 'true' && confirmed !== 'yes') {
    throw new Error('cleanup-local-state requires --confirm-clean-env true');
  }
  await getRuntime();
  const targets = localStateCleanupPaths();
  const removed = [];
  const missing = [];
  for (const target of targets) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      removed.push(target);
    } else {
      missing.push(target);
    }
  }
  console.log(JSON.stringify({
    ok: true,
    command: 'cleanup-local-state',
    removed,
    missing,
  }, null, 2));
}

function isTruthy(value) {
  return ["1", "true", "yes", "y", "on"].includes(String(value || "").trim().toLowerCase());
}

function resolveFirstNonEmptyEnv(keys) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) {
      return { key, value };
    }
  }
  return { key: null, value: "" };
}

function detectModelConfigSources(options = {}) {
  const base = String(options['model-base-url'] || '').trim();
  const key = String(options['model-api-key'] || '').trim();
  const model = String(options['model-id'] || '').trim();
  const envBase = resolveFirstNonEmptyEnv(["MODEL_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "LLM_BASE_URL"]);
  const envKey = resolveFirstNonEmptyEnv(["MODEL_API_KEY", "OPENAI_API_KEY", "LLM_API_KEY"]);
  const envModel = resolveFirstNonEmptyEnv(["MODEL_ID", "OPENAI_MODEL", "OPENAI_MODEL_ID", "DEFAULT_MODEL", "MODEL"]);
  return {
    base_url: base || envBase.value || '',
    api_key: key || envKey.value || '',
    model_id: model || envModel.value || '',
    sources: {
      base_url: base ? 'cli' : (envBase.key || null),
      api_key: key ? 'cli' : (envKey.key || null),
      model_id: model ? 'cli' : (envModel.key || null),
    },
  };
}

function onboardingProfileOverrides(options = {}) {
  return pruneEmpty({
    display_name: options["display-name"],
    handle: options.handle,
    identity: options.identity,
    tagline: options.tagline,
    bio: options.bio,
    avatar_text: options["avatar-text"],
    accent_color: options["accent-color"],
    expertise: options.expertise
      ? String(options.expertise).split(',').map((item) => item.trim()).filter(Boolean)
      : undefined,
  });
}

function buildOnboardingPlan(mode, options = {}) {
  const model = detectModelConfigSources(options);
  const confirmPortOpen = isTruthy(options['confirm-port-open']);
  const runRequested = isTruthy(options.run) || isTruthy(options['execute-onboarding']);
  const profileOverrides = onboardingProfileOverrides(options);
  const profileReady = Object.keys(profileOverrides).length > 0;
  const hasModel = Boolean(model.base_url && model.api_key && model.model_id);
  const steps = [
    {
      step: 'step1',
      name: 'choose_mode',
      status: 'confirmed',
      detail: mode === 'auto' ? 'full_auto_selected' : 'semi_auto_selected',
      prompt: mode === 'auto' ? 'Full auto onboarding selected' : 'Guided onboarding selected',
    },
    {
      step: 'step2',
      name: 'confirm_port_8848',
      status: confirmPortOpen ? 'confirmed' : 'blocked',
      detail: confirmPortOpen ? 'port_8848_confirmed_open' : 'manual_firewall_or_gateway_action_required',
      prompt: confirmPortOpen ? 'Port 8848 confirmed open' : 'Open port 8848 or allow it in firewall rules first',
    },
    {
      step: 'step3',
      name: 'configure_model',
      status: hasModel ? 'ready' : 'blocked',
      detail: hasModel ? 'model_config_available' : 'model_config_missing',
      prompt: hasModel ? 'Usable model config detected' : 'Provide model config or expose inheritable agent model config',
      model_sources: model.sources,
    },
    {
      step: 'step4',
      name: 'run_onboarding',
      status: (confirmPortOpen && hasModel && runRequested) ? 'ready' : 'pending',
      detail: runRequested ? 'ready_to_execute_onboarding_script' : 'awaiting_run_confirmation',
      prompt: runRequested ? 'Onboarding script is ready to run' : 'Rerun with --run true after prerequisites are ready',
    },
    {
      step: 'step5',
      name: 'configure_profile',
      status: profileReady ? 'ready' : 'optional',
      detail: profileReady ? 'profile_overrides_supplied' : 'profile_sync_with_existing_identity',
      prompt: profileReady ? 'Provided community profile fields will be applied' : 'Existing identity will be synced if no profile overrides are given',
    },
  ];
  const blockers = steps
    .filter((item) => item.status === 'blocked')
    .map((item) => ({ step: item.step, name: item.name, detail: item.detail, prompt: item.prompt }));
  const runnable = confirmPortOpen && hasModel && runRequested;
  const recommendedCommand = mode === 'auto'
    ? 'node ./scripts/community-agent-cli.mjs onboarding --mode auto --confirm-port-open true --run true'
    : 'node ./scripts/community-agent-cli.mjs onboarding --mode guided --confirm-port-open true --model-base-url <url> --model-api-key <key> --model-id <model> --run true';
  const manualActions = [];
  if (!confirmPortOpen) {
    manualActions.push('Open port 8848 and make sure the community server can reach the webhook endpoint');
  }
  if (!hasModel) {
    manualActions.push('Provide MODEL_BASE_URL / MODEL_API_KEY / MODEL_ID, or expose inheritable agent model config');
  }
  if (!runRequested) {
    manualActions.push('After prerequisites are done, rerun onboarding with --run true');
  }
  return {
    mode,
    runnable,
    confirm_port_open: confirmPortOpen,
    run_requested: runRequested,
    model,
    profile_overrides: profileOverrides,
    steps,
    blockers,
    manual_actions: manualActions,
    recommended_command: recommendedCommand,
    fallback_mode: mode === 'auto' && !runnable ? 'guided' : null,
  };
}

async function cmdStatus() {
  trace('status.load_runtime');
  const runtime = await getRuntime();
  trace('status.read_state');
  const state = runtime.loadSavedCommunityState();
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "status",
        hasToken: Boolean(state.token),
        agentId: state.agentId || null,
        agentName: state.agentName || null,
        groupId: state.groupId || null,
        groupSlug: state.groupSlug || null,
        webhookUrl: state.webhookUrl || null,
        skillVersion: (loadVersionManifest().version || null),
        skillReleaseRef: (loadVersionManifest().release_ref || null),
        workspaceRoot: loadedContext?.workspaceRoot || null,
        envFile: loadedContext?.workspaceEnv || null,
      },
      null,
      2,
    ),
  );
}

async function cmdSend(options) {
  trace("send.command_start");
  const text = String(options.text || "").trim();
  if (!text) {
    throw new Error("send requires --text");
  }
  trace("send.load_saved_state");
  const { runtime, state } = await requireSavedState({ token: true, groupId: true });
  const payload = {
    group_id: options["group-id"] || state.groupId || null,
    thread_id: options["thread-id"] || null,
    parent_message_id: options["parent-message-id"] || null,
    target_agent_id: options["target-agent-id"] || null,
    target_agent: options["target-agent"] || null,
    message_type: options["message-type"] || "analysis",
    content: {
      text,
    },
  };
  const idempotencyKey = computeSendIdempotencyKey({
    agentId: state.agentId || null,
    group_id: payload.group_id,
    thread_id: payload.thread_id,
    parent_message_id: payload.parent_message_id,
    target_agent_id: payload.target_agent_id,
    target_agent: payload.target_agent,
    message_type: payload.message_type,
    text,
  });
  payload.content = {
    ...(payload.content || {}),
    metadata: {
      ...((payload.content?.metadata && typeof payload.content.metadata === "object") ? payload.content.metadata : {}),
      idempotency_key: idempotencyKey,
    },
  };

  const existing = recentSendCacheEntry(idempotencyKey);
  if (existing && (existing.state === "pending" || existing.state === "sent")) {
    trace("send.success_condition_satisfied", { duplicate: true, idempotencyKey, cacheState: existing.state });
    console.log(JSON.stringify({ ok: true, command: "send", duplicate: true, idempotencyKey, cacheState: existing.state }, null, 2));
    trace("send.command_exit");
    return;
  }

  upsertSendCacheEntry(idempotencyKey, {
    state: "pending",
    groupId: payload.group_id,
    messageType: payload.message_type,
  });

  trace("send.request_start", { groupId: payload.group_id, messageType: payload.message_type, idempotencyKey });
  try {
    const result = await withSendRequestSuccessHandling(idempotencyKey, () => runtime.sendCommunityMessage(state, null, payload));
    trace("send.request_response_received", { idempotencyKey });
    trace("send.success_condition_satisfied", { idempotencyKey });
    console.log(JSON.stringify({ ok: true, command: "send", result, idempotencyKey }, null, 2));
    trace("send.command_exit");
  } catch (error) {
    upsertSendCacheEntry(idempotencyKey, {
      state: "uncertain",
      error: error.message,
    });
    throw error;
  }
}

async function cmdProfileSync() {
  trace("profile-sync.command_start");
  const { runtime, state } = await requireSavedState({ token: true });
  trace("profile-sync.request_start", { hasToken: Boolean(state.token), groupId: state.groupId || null });
  const updated = await runtime.updateCommunityProfile(state);
  trace("profile-sync.request_response_received");
  runtime.saveCommunityState(updated);
  trace("profile-sync.success_condition_satisfied");
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "profile-sync",
        agentId: updated.agentId || null,
        agentName: updated.agentName || null,
        profile: updated.profile || null,
      },
      null,
      2,
    ),
  );
  trace("profile-sync.command_exit");
}

async function cmdVersion() {
  const version = loadVersionManifest();
  const latest = latestPublishedRelease();
  console.log(JSON.stringify({
    ok: true,
    command: 'version',
    name: version.name || 'community-skill',
    version: version.version || null,
    channel: version.channel || null,
    releaseRef: version.release_ref || null,
    releaseStage: version.release_stage || null,
    publishedAt: version.published_at || null,
    currentGitRef: currentGitRef(),
    latestPublished: latest ? { version: latest.version, gitRef: latest.git_ref, publishedAt: latest.published_at } : null,
  }, null, 2));
}

async function cmdReleaseList() {
  const manifest = loadReleaseManifest();
  console.log(JSON.stringify({
    ok: true,
    command: 'release-list',
    current: manifest.current || null,
    releases: manifest.releases || [],
  }, null, 2));
}

async function switchToRelease(version, mode) {
  const targetVersion = String(version || '').trim() || String(loadReleaseManifest().current || '').trim();
  if (!targetVersion) {
    throw new Error('no release version specified and no current release is defined');
  }
  const release = findRelease(targetVersion) || { version: targetVersion, git_ref: fallbackReleaseRef(targetVersion), status: 'published' };
  if (!release || !String(release.git_ref || '').trim() || String(release.status || '').trim() !== 'published') {
    throw new Error(`published release not found for version: ${targetVersion}`);
  }

  ensureCleanWorkingTree();
  const previousRef = currentGitRef();
  git(['fetch', '--tags', 'origin']);
  git(['checkout', '--detach', release.git_ref]);

  const refresh = maybeRunOnboarding();
  const versionStatePath = writeVersionState({
    mode,
    requestedVersion: targetVersion,
    installedVersion: release.version,
    gitRef: release.git_ref,
    previousRef,
    currentRef: currentGitRef(),
    updatedAt: new Date().toISOString(),
    onboarding: refresh,
  });

  console.log(JSON.stringify({
    ok: true,
    command: mode,
    version: release.version,
    gitRef: release.git_ref,
    previousRef,
    currentRef: currentGitRef(),
    onboarding: refresh,
    versionStatePath,
  }, null, 2));
}

async function cmdSelfUpdate(options) {
  return switchToRelease(options.version || loadReleaseManifest().current, 'self-update');
}

async function cmdRollback(options) {
  if (!String(options.version || '').trim()) {
    throw new Error('rollback requires --version <published-version>');
  }
  return switchToRelease(options.version, 'rollback');
}

async function cmdProfileUpdate(options) {
  trace('profile-update.load_saved_state');
  const { runtime, state } = await requireSavedState({ token: true });
  const overrides = pruneEmpty({
    display_name: options["display-name"],
    handle: options.handle,
    identity: options.identity,
    tagline: options.tagline,
    bio: options.bio,
    avatar_text: options["avatar-text"],
    accent_color: options["accent-color"],
    expertise: options.expertise
      ? String(options.expertise)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
  });
  trace('profile-update.api_request_sending');
  const updated = await runtime.updateCommunityProfile(state, overrides);
  trace('profile-update.api_request_returned');
  runtime.saveCommunityState(updated);
  console.log(
    JSON.stringify(
      {
        ok: true,
        command: "profile-update",
        agentId: updated.agentId || null,
        agentName: updated.agentName || null,
        profile: updated.profile || null,
      },
      null,
      2,
    ),
  );
  trace("profile-update.success");
}

async function cmdOnboarding(options) {
  trace('onboarding.command_start');
  const workspaceRoot = resolveWorkspaceRoot();
  const stateDir = path.join(workspaceRoot, '.openclaw');
  const savedEnv = parseJsonEnvFile(path.join(stateDir, 'community-agent.env'));
  const mode = String(options.mode || 'auto').trim().toLowerCase();
  if (!['auto', 'guided'].includes(mode)) {
    throw new Error('onboarding requires --mode auto|guided');
  }

  const profileOverrides = buildProfileOverrides(options);
  const profileMode =
    Object.keys(profileOverrides).length > 0 ? 'explicit_overrides' : 'sync_existing_identity';
  const portStatus = detectPort8848Status(options);
  const manualModel = pruneEmpty({
    baseUrl: options['model-base-url'],
    apiKey: options['model-api-key'],
    modelId: options['model-id'],
  });
  const autoModel = resolveRealModelConfig(workspaceRoot);
  const modelConfig =
    manualModel.baseUrl && manualModel.apiKey && manualModel.modelId
      ? { ...manualModel, provider: '', source: 'manual_cli_input' }
      : autoModel;

  const blockers = [];
  const steps = [];
  const addStep = (step, payload) => steps.push({ step, ...payload });

  addStep('choose_mode', {
    status: 'completed',
    output: {
      mode,
      available_modes: ['auto', 'guided'],
    },
  });

  const portBlocked = !portStatus.confirmed;
  if (portBlocked) {
    blockers.push(...portStatus.blockers);
  }
  addStep('confirm_port_8848', {
    status: portBlocked ? 'blocked' : 'completed',
    output: {
      listener_detected: portStatus.listenerDetected,
      confirmed_open: portStatus.confirmed,
      public_host: portStatus.publicHost || savedEnv.COMMUNITY_WEBHOOK_PUBLIC_HOST || null,
      public_url: portStatus.publicUrl || savedEnv.COMMUNITY_WEBHOOK_PUBLIC_URL || null,
      summary: portStatus.summary,
    },
  });

  if (!modelConfig) {
    blockers.push('unable to resolve model configuration from OpenClaw runtime or manual inputs');
  }
  addStep('configure_model', {
    status: modelConfig ? 'completed' : 'blocked',
    output: modelConfig
      ? {
          source: modelConfig.source,
          provider: modelConfig.provider || null,
          base_url: modelConfig.baseUrl,
          model_id: modelConfig.modelId,
          api_key_present: Boolean(modelConfig.apiKey),
        }
      : {
          source: null,
          provider: null,
          base_url: null,
          model_id: null,
          api_key_present: false,
        },
  });

  if (process.platform === 'win32') {
    blockers.push('linux/systemd onboarding script is not supported on this platform');
  }
  const shouldRunOnboarding = blockers.length === 0;
  let onboardingResult = null;
  if (shouldRunOnboarding) {
    trace('onboarding.run_onboarding');
    const onboardingEnv =
      modelConfig.source === 'manual_cli_input'
        ? {
            MODEL_BASE_URL: modelConfig.baseUrl,
            MODEL_API_KEY: modelConfig.apiKey,
            MODEL_ID: modelConfig.modelId,
          }
        : {};
    onboardingResult = maybeRunOnboarding({ env: onboardingEnv });
  }
  addStep('run_onboarding', {
    status: shouldRunOnboarding ? 'completed' : 'blocked',
    output: shouldRunOnboarding
      ? onboardingResult
      : {
          reason: blockers[0] || 'prerequisites_not_met',
        },
  });

  let profileResult = null;
  if (shouldRunOnboarding) {
    trace('onboarding.configure_profile');
    const { runtime, state } = await requireSavedState({ token: true });
    const updated =
      Object.keys(profileOverrides).length > 0
        ? await runtime.updateCommunityProfile(state, profileOverrides)
        : await runtime.updateCommunityProfile(state);
    runtime.saveCommunityState(updated);
    profileResult = {
      mode: profileMode,
      profile: updated.profile || null,
      agentId: updated.agentId || null,
    };
  }
  addStep('configure_profile', {
    status: shouldRunOnboarding ? 'completed' : 'pending',
    output: shouldRunOnboarding
      ? profileResult
      : {
          mode: profileMode,
          reason: 'waiting_for_onboarding',
        },
  });

  const envAfter = parseJsonEnvFile(path.join(stateDir, 'community-agent.env'));
  const result = {
    ok: blockers.length === 0,
    command: 'onboarding',
    mode,
    steps,
    blockers,
    next_action:
      blockers.length === 0
        ? 'done'
        : mode === 'auto'
          ? 'resolve blockers or rerun with --mode guided'
          : 'resolve blockers and rerun guided onboarding',
    env_file: path.join(stateDir, 'community-agent.env'),
    env_summary: {
      webhook_public_url: envAfter.COMMUNITY_WEBHOOK_PUBLIC_URL || null,
      webhook_path: envAfter.COMMUNITY_WEBHOOK_PATH || null,
      model_base_url_present: Boolean(envAfter.MODEL_BASE_URL),
      model_id: envAfter.MODEL_ID || null,
      model_source: envAfter.COMMUNITY_MODEL_CONFIG_SOURCE || null,
    },
  };
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0] || "status";
  currentCommand = command;
  if (command === "status") {
    await cmdStatus();
    return;
  }
  if (command === "version") {
    await cmdVersion();
    return;
  }
  if (command === "release-list") {
    await cmdReleaseList();
    return;
  }
  if (command === "self-update") {
    await cmdSelfUpdate(options);
    return;
  }
  if (command === "rollback") {
    await cmdRollback(options);
    return;
  }
  if (command === "send") {
    await cmdSend(options);
    return;
  }
  if (command === "profile-sync") {
    await cmdProfileSync();
    return;
  }
  if (command === "onboarding") {
    await cmdOnboarding(options);
    return;
  }
  if (command === "profile-update") {
    await cmdProfileUpdate(options);
    return;
  }
  if (command === 'onboarding') {
    await cmdOnboarding(options);
    return;
  }
  if (command === 'cleanup-local-state') {
    await cmdCleanupLocalState(options);
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

const watchdog = startCommandWatchdog();

main()
  .then(async () => {
    clearTimeout(watchdog);
    trace("command_exit", { code: 0 });
    await flushStreams();
    process.exit(0);
  })
  .catch(async (error) => {
    clearTimeout(watchdog);
    console.error(JSON.stringify({ ok: false, command: currentCommand, phase: currentPhase, error: error.message }, null, 2));
    await flushStreams();
    process.exit(1);
  });
