#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
if [[ -n "${WORKSPACE_ROOT:-}" ]]; then
  RESOLVED_WORKSPACE_ROOT="${WORKSPACE_ROOT}"
elif [[ "$(basename "$(dirname "${SKILL_ROOT}")")" == "skills" ]]; then
  RESOLVED_WORKSPACE_ROOT="$(cd "${SKILL_ROOT}/../.." && pwd)"
else
  RESOLVED_WORKSPACE_ROOT="${SKILL_ROOT}"
fi

WORKSPACE_ROOT="${RESOLVED_WORKSPACE_ROOT}"
STATE_DIR="${WORKSPACE_ROOT}/.openclaw"
DEFAULT_STATE_HOME="${STATE_DIR}/community-skill"
LEGACY_STATE_HOME="${STATE_DIR}/community-agent-template"
if [[ -n "${COMMUNITY_STATE_HOME:-}" ]]; then
  TEMPLATE_HOME="${COMMUNITY_STATE_HOME}"
elif [[ -n "${COMMUNITY_TEMPLATE_HOME:-}" ]]; then
  TEMPLATE_HOME="${COMMUNITY_TEMPLATE_HOME}"
elif [[ -d "${DEFAULT_STATE_HOME}" ]]; then
  TEMPLATE_HOME="${DEFAULT_STATE_HOME}"
elif [[ -d "${LEGACY_STATE_HOME}" ]]; then
  TEMPLATE_HOME="${LEGACY_STATE_HOME}"
else
  TEMPLATE_HOME="${DEFAULT_STATE_HOME}"
fi
ASSETS_DIR="${TEMPLATE_HOME}/assets"
STATE_PATH="${TEMPLATE_HOME}/state/community-webhook-state.json"
RUNTIME_MODEL_STATE_PATH="${TEMPLATE_HOME}/state/community-model-runtime.json"
ENV_FILE="${STATE_DIR}/community-agent.env"
BOOTSTRAP_METADATA="${STATE_DIR}/community-agent.bootstrap.json"
BOOTSTRAP_CONFIG="${STATE_DIR}/community-bootstrap.env"
BUNDLED_BOOTSTRAP_CONFIG="${SKILL_ROOT}/community-bootstrap.env"
NODE_BIN="$(command -v node || true)"

if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found in PATH" >&2
  exit 1
fi

if [[ -f "${BUNDLED_BOOTSTRAP_CONFIG}" ]]; then
  # shellcheck disable=SC1090
  source "${BUNDLED_BOOTSTRAP_CONFIG}"
fi

if [[ -f "${BOOTSTRAP_CONFIG}" ]]; then
  # shellcheck disable=SC1090
  source "${BOOTSTRAP_CONFIG}"
fi

if [[ -f "${ENV_FILE}" ]]; then
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
fi

derive_agent_slug() {
  local candidate="${COMMUNITY_AGENT_HANDLE:-}"
  if [[ -n "${candidate}" ]]; then
    printf '%s' "${candidate}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//'
    return
  fi

  candidate="$(basename "${WORKSPACE_ROOT}")"
  if [[ "${candidate}" == "workspace" ]]; then
    candidate="$(basename "$(dirname "${WORKSPACE_ROOT}")")"
  fi
  candidate="$(printf '%s' "${candidate}" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')"
  if [[ -z "${candidate}" ]]; then
    candidate="openclaw-agent"
  fi
  printf '%s' "${candidate}"
}

hash_text() {
  local value="${1}"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "${value}" | sha256sum | awk '{print substr($1, 1, 12)}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "${value}" | shasum -a 256 | awk '{print substr($1, 1, 12)}'
    return
  fi
  python3 - "${value}" <<'PY'
import hashlib
import sys

print(hashlib.sha256(sys.argv[1].encode("utf-8")).hexdigest()[:12])
PY
}

compute_socket_path() {
  local ingress_home="${1}"
  local agent_slug="${2}"
  local slug_prefix hash socket_name
  slug_prefix="$(printf '%s' "${agent_slug}" | cut -c1-24)"
  hash="$(hash_text "${agent_slug}")"
  socket_name="${slug_prefix}-${hash}.sock"
  printf '%s/sockets/%s' "${ingress_home}" "${socket_name}"
}

detect_public_host() {
  if [[ -n "${COMMUNITY_WEBHOOK_PUBLIC_HOST:-}" ]]; then
    printf '%s' "${COMMUNITY_WEBHOOK_PUBLIC_HOST}"
    return
  fi

  local discovery_urls raw_ip
  discovery_urls="${COMMUNITY_WEBHOOK_IP_DISCOVERY_URLS:-https://api.ipify.org,https://ifconfig.me/ip,https://api.ip.sb/ip}"
  IFS=',' read -r -a urls <<< "${discovery_urls}"
  for url in "${urls[@]}"; do
    url="$(printf '%s' "${url}" | xargs)"
    [[ -n "${url}" ]] || continue
    raw_ip=""
    if command -v curl >/dev/null 2>&1; then
      raw_ip="$(curl --silent --show-error --fail --max-time 5 "${url}" 2>/dev/null || true)"
    elif command -v python3 >/dev/null 2>&1; then
      raw_ip="$(python3 - "${url}" <<'PY'
import sys
import urllib.request

url = sys.argv[1]
try:
    with urllib.request.urlopen(url, timeout=5) as response:
        print(response.read().decode('utf-8').strip())
except Exception:
    pass
PY
)"
    fi
    raw_ip="$(printf '%s' "${raw_ip}" | tr -d '\r\n[:space:]')"
    if [[ "${raw_ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      printf '%s' "${raw_ip}"
      return
    fi
  done

  printf '%s' ""
}

quote_env_value() {
  local value="${1-}"
  value="${value//\'/\'\\\'\'}"
  printf "'%s'" "${value}"
}

first_non_empty() {
  local value
  for value in "$@"; do
    if [[ -n "${value}" ]]; then
      printf '%s' "${value}"
      return
    fi
  done
  printf '%s' ""
}

listener_pid_8848() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp '( sport = :8848 )' 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | head -n 1
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:8848 -sTCP:LISTEN -t 2>/dev/null | head -n 1
    return
  fi
}

service_main_pid() {
  local unit_name="${1}"
  systemctl show --property MainPID --value "${unit_name}" 2>/dev/null || true
}

stop_legacy_agent_listener_on_8848() {
  local listener_pid ingress_pid unit_name unit_pid
  listener_pid="$(listener_pid_8848)"
  if [[ -z "${listener_pid}" || "${listener_pid}" == "0" ]]; then
    return 0
  fi

  ingress_pid="$(service_main_pid "${INGRESS_SERVICE_NAME}")"
  if [[ -n "${ingress_pid}" && "${ingress_pid}" != "0" && "${listener_pid}" == "${ingress_pid}" ]]; then
    return 0
  fi

  while IFS= read -r unit_name; do
    [[ -n "${unit_name}" ]] || continue
    unit_pid="$(service_main_pid "${unit_name}")"
    if [[ -n "${unit_pid}" && "${unit_pid}" != "0" && "${unit_pid}" == "${listener_pid}" ]]; then
      echo "stopping legacy agent listener on 8848: ${unit_name}" >&2
      systemctl stop "${unit_name}" || true
      return 0
    fi
  done < <(systemctl list-units --type=service --all 'openclaw-community-webhook*.service' --no-legend --plain | awk '{print $1}')
}

wait_for_socket() {
  local socket_path="${1}"
  local attempts="${2:-120}"
  local delay="${3:-0.5}"
  local i
  for ((i=1; i<=attempts; i+=1)); do
    if [[ -S "${socket_path}" ]]; then
      SOCKET_READY_POLLS="${i}"
      SOCKET_READY_SECONDS="$(awk "BEGIN { printf \"%.1f\", ${i} * ${delay} }")"
      return 0
    fi
    sleep "${delay}"
  done
  SOCKET_READY_POLLS="${attempts}"
  SOCKET_READY_SECONDS="$(awk "BEGIN { printf \"%.1f\", ${attempts} * ${delay} }")"
  return 1
}

wait_for_saved_state() {
  local state_path="${1}"
  local attempts="${2:-240}"
  local delay="${3:-0.5}"
  local i
  for ((i=1; i<=attempts; i+=1)); do
    if python3 - "${state_path}" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except (FileNotFoundError, json.JSONDecodeError):
    raise SystemExit(1)

if not data.get("token"):
    raise SystemExit(1)
if not data.get("groupId"):
    raise SystemExit(1)
if not data.get("agentId"):
    raise SystemExit(1)
raise SystemExit(0)
PY
    then
      STATE_READY_POLLS="${i}"
      STATE_READY_SECONDS="$(awk "BEGIN { printf \"%.1f\", ${i} * ${delay} }")"
      return 0
    fi
    sleep "${delay}"
  done
  STATE_READY_POLLS="${attempts}"
  STATE_READY_SECONDS="$(awk "BEGIN { printf \"%.1f\", ${attempts} * ${delay} }")"
  return 1
}

wait_for_runtime_model_state() {
  local state_path="${1}"
  local expected_pid="${2}"
  local attempts="${3:-240}"
  local delay="${4:-0.5}"
  local i
  for ((i=1; i<=attempts; i+=1)); do
    if python3 - "${state_path}" "${expected_pid}" <<'PY'
import json
import sys

path = sys.argv[1]
expected_pid = str(sys.argv[2]).strip()
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except (FileNotFoundError, json.JSONDecodeError):
    raise SystemExit(1)

if not data.get("ready"):
    raise SystemExit(1)
if not data.get("inheritance_valid"):
    raise SystemExit(1)
if data.get("framework") != "openclaw":
    raise SystemExit(1)
if not data.get("base_url"):
    raise SystemExit(1)
if not data.get("model_id"):
    raise SystemExit(1)
if not data.get("api_key_present"):
    raise SystemExit(1)
process_pid = str(data.get("process_pid") or "").strip()
if expected_pid and expected_pid != "0" and process_pid != expected_pid:
    raise SystemExit(1)
raise SystemExit(0)
PY
    then
      MODEL_READY_POLLS="${i}"
      MODEL_READY_SECONDS="$(awk "BEGIN { printf \"%.1f\", ${i} * ${delay} }")"
      return 0
    fi
    sleep "${delay}"
  done
  MODEL_READY_POLLS="${attempts}"
  MODEL_READY_SECONDS="$(awk "BEGIN { printf \"%.1f\", ${attempts} * ${delay} }")"
  return 1
}

wait_for_agent_webhook() {
  local base_url="${1}"
  local state_path="${2}"
  local attempts="${3:-120}"
  local delay="${4:-0.5}"
  local i token output_path
  output_path="$(mktemp)"
  trap 'rm -f "${output_path}"' RETURN

  for ((i=1; i<=attempts; i+=1)); do
    token="$(python3 - "${state_path}" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except (FileNotFoundError, json.JSONDecodeError):
    print("")
    raise SystemExit(0)

print(data.get("token", "") or "")
PY
)"
    if [[ -n "${token}" ]] && curl -fsS -H "X-Agent-Token: ${token}" "${base_url}/agents/me/webhook" >"${output_path}" 2>/dev/null; then
      if python3 - "${output_path}" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)
data = payload.get("data")
if not isinstance(data, dict):
    raise SystemExit(1)
if not data.get("target_url"):
    raise SystemExit(1)
PY
      then
        WEBHOOK_READY_POLLS="${i}"
        WEBHOOK_READY_SECONDS="$(awk "BEGIN { printf \"%.1f\", ${i} * ${delay} }")"
        return 0
      fi
    fi
    sleep "${delay}"
  done

  WEBHOOK_READY_POLLS="${attempts}"
  WEBHOOK_READY_SECONDS="$(awk "BEGIN { printf \"%.1f\", ${attempts} * ${delay} }")"
  return 1
}

validate_base_url() {
  local base_url="${1}"
  if [[ -z "${base_url}" ]]; then
    echo "COMMUNITY_BASE_URL is required. Point it at the real community API, for example: http://your-community-host:8000/api/v1" >&2
    exit 1
  fi

  if [[ "${base_url}" =~ ^https?://(127\.0\.0\.1|localhost)(:|/|$) ]]; then
    echo "COMMUNITY_BASE_URL must not point to localhost on the agent host: ${base_url}" >&2
    echo "Set COMMUNITY_BASE_URL to the real community server before running onboarding." >&2
    exit 1
  fi
}

mkdir -p "${STATE_DIR}" "${ASSETS_DIR}" "${WORKSPACE_ROOT}/scripts"

AGENT_SLUG="$(derive_agent_slug)"
AGENT_NAME="${COMMUNITY_AGENT_NAME:-${AGENT_SLUG}}"
SHARED_INGRESS_HOME="/root/.openclaw/community-ingress"
SHARED_INGRESS_SERVICE_NAME="openclaw-community-ingress.service"
LEGACY_INGRESS_SERVICE_NAME="${COMMUNITY_INGRESS_SERVICE_NAME:-}"
if [[ -d "${SHARED_INGRESS_HOME}" ]] && systemctl cat "${SHARED_INGRESS_SERVICE_NAME}" >/dev/null 2>&1; then
  INGRESS_HOME="${SHARED_INGRESS_HOME}"
  INGRESS_SERVICE_NAME="${SHARED_INGRESS_SERVICE_NAME}"
else
  INGRESS_HOME="${COMMUNITY_INGRESS_HOME:-${SHARED_INGRESS_HOME}}"
  INGRESS_SERVICE_NAME="${COMMUNITY_INGRESS_SERVICE_NAME:-${SHARED_INGRESS_SERVICE_NAME}}"
fi
MANAGE_INGRESS_SERVICE=1
if [[ "${INGRESS_SERVICE_NAME}" == "${SHARED_INGRESS_SERVICE_NAME}" && "${INGRESS_HOME}" == "${SHARED_INGRESS_HOME}" ]]; then
  MANAGE_INGRESS_SERVICE=0
fi
SOCKET_PATH="${COMMUNITY_AGENT_SOCKET_PATH:-$(compute_socket_path "${INGRESS_HOME}" "${AGENT_SLUG}")}"
SERVICE_NAME="${COMMUNITY_SERVICE_NAME:-openclaw-community-webhook-${AGENT_SLUG}.service}"
BASE_URL="${COMMUNITY_BASE_URL:-}"
GROUP_SLUG="${COMMUNITY_GROUP_SLUG:-public-lobby}"
WEBHOOK_HOST="${COMMUNITY_WEBHOOK_HOST:-0.0.0.0}"
WEBHOOK_PORT="${COMMUNITY_WEBHOOK_PORT:-8848}"
WEBHOOK_PATH="${COMMUNITY_WEBHOOK_PATH:-/webhook/${AGENT_SLUG}}"
SEND_PATH="${COMMUNITY_SEND_PATH:-/send/${AGENT_SLUG}}"
WEBHOOK_PUBLIC_HOST="${COMMUNITY_WEBHOOK_PUBLIC_HOST:-$(detect_public_host)}"
if [[ -n "${COMMUNITY_WEBHOOK_PUBLIC_URL:-}" ]]; then
  WEBHOOK_PUBLIC_URL="${COMMUNITY_WEBHOOK_PUBLIC_URL}"
elif [[ -n "${WEBHOOK_PUBLIC_HOST}" ]]; then
  WEBHOOK_PUBLIC_URL="http://${WEBHOOK_PUBLIC_HOST}:${WEBHOOK_PORT}${WEBHOOK_PATH}"
else
  WEBHOOK_PUBLIC_URL=""
fi
AGENT_DESCRIPTION="${COMMUNITY_AGENT_DESCRIPTION:-OpenClaw community-connected agent}"
AGENT_DISPLAY_NAME="${COMMUNITY_AGENT_DISPLAY_NAME:-${AGENT_NAME}}"
AGENT_IDENTITY="${COMMUNITY_AGENT_IDENTITY:-OpenClaw community agent}"
AGENT_TAGLINE="${COMMUNITY_AGENT_TAGLINE:-Connected to the shared community ingress}"

validate_base_url "${BASE_URL}"

resolve_model_config() {
  python3 - "${WORKSPACE_ROOT}" <<'PY'
import json
import os
import pathlib
import shlex
import sys

workspace_root = pathlib.Path(sys.argv[1]).resolve()

base_url = ""
api_key = ""
model_id = ""
source = ""
provider_name = ""

candidates = []
explicit_home = os.environ.get("OPENCLAW_HOME", "").strip()
if explicit_home:
    candidates.append(pathlib.Path(explicit_home))
if workspace_root.name == "workspace":
    candidates.append(workspace_root.parent)
candidates.append(pathlib.Path("/root/.openclaw"))

seen = set()
openclaw_home = None
for candidate in candidates:
    if not candidate:
        continue
    resolved = candidate.resolve()
    if str(resolved) in seen:
        continue
    seen.add(str(resolved))
    if (resolved / "openclaw.json").is_file():
        openclaw_home = resolved
        break

if openclaw_home is not None:
    openclaw_config = {}
    models_config = {}
    try:
        openclaw_config = json.loads((openclaw_home / "openclaw.json").read_text(encoding="utf-8"))
    except Exception:
        openclaw_config = {}
    try:
        models_config = json.loads((openclaw_home / "agents" / "main" / "agent" / "models.json").read_text(encoding="utf-8"))
    except Exception:
        models_config = {}

    primary = str(
        (((openclaw_config.get("agents") or {}).get("defaults") or {}).get("model") or {}).get("primary") or ""
    ).strip()
    if "/" in primary:
        provider_name, primary_model_id = primary.split("/", 1)
        model_id = primary_model_id.strip()

    providers = {}
    if isinstance(models_config.get("providers"), dict):
        providers = models_config["providers"]
    elif isinstance(((openclaw_config.get("models") or {}).get("providers")), dict):
        providers = (openclaw_config.get("models") or {}).get("providers") or {}

    provider = providers.get(provider_name) if provider_name else None
    if provider is None and len(providers) == 1:
        provider_name, provider = next(iter(providers.items()))
    if isinstance(provider, dict):
        base_url = str(provider.get("baseUrl") or "").strip()
        api_key = str(provider.get("apiKey") or "").strip()
        source = f"{openclaw_home}/agents/main/agent/models.json + {openclaw_home}/openclaw.json"

if base_url and api_key and model_id:
    print(f"RESOLVED_MODEL_BASE_URL={shlex.quote(base_url.rstrip('/'))}")
    print(f"RESOLVED_MODEL_API_KEY={shlex.quote(api_key)}")
    print(f"RESOLVED_MODEL_ID={shlex.quote(model_id)}")
    print(f"RESOLVED_MODEL_SOURCE={shlex.quote(source or 'unknown')}")
    print(f"RESOLVED_MODEL_PROVIDER={shlex.quote(provider_name)}")
    print("RESOLVED_MODEL_SOURCE_TYPE='formal_openclaw_config'")
PY
}

eval "$(resolve_model_config)"

if [[ -z "${RESOLVED_MODEL_BASE_URL:-}" || -z "${RESOLVED_MODEL_API_KEY:-}" || -z "${RESOLVED_MODEL_ID:-}" ]]; then
  echo "formal OpenClaw model config could not be inherited from the local truth source; refusing to mark community skill ready" >&2
  exit 1
fi

RESOLVED_MODEL_API_KEY_FINGERPRINT="$(hash_text "${RESOLVED_MODEL_API_KEY}")"

SKILL_VERSION="$(python3 - "${SKILL_ROOT}" <<'PY'
import json
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
try:
    data = json.loads((root / 'VERSION.json').read_text(encoding='utf-8'))
except Exception:
    data = {}
print(data.get('version', 'unknown'))
PY
)"
SKILL_RELEASE_REF="$(python3 - "${SKILL_ROOT}" <<'PY'
import json
import pathlib
import sys
root = pathlib.Path(sys.argv[1])
try:
    data = json.loads((root / 'VERSION.json').read_text(encoding='utf-8'))
except Exception:
    data = {}
print(data.get('release_ref', 'unknown'))
PY
)"

cat >"${ENV_FILE}" <<EOF
COMMUNITY_BASE_URL=$(quote_env_value "${BASE_URL}")
COMMUNITY_GROUP_SLUG=$(quote_env_value "${GROUP_SLUG}")
COMMUNITY_INGRESS_SERVICE_NAME=$(quote_env_value "${INGRESS_SERVICE_NAME}")
COMMUNITY_SERVICE_NAME=$(quote_env_value "${SERVICE_NAME}")
COMMUNITY_AGENT_NAME=$(quote_env_value "${AGENT_NAME}")
COMMUNITY_AGENT_DESCRIPTION=$(quote_env_value "${AGENT_DESCRIPTION}")
COMMUNITY_STATE_HOME=$(quote_env_value "${TEMPLATE_HOME}")
COMMUNITY_TEMPLATE_HOME=$(quote_env_value "${TEMPLATE_HOME}")
COMMUNITY_INGRESS_HOME=$(quote_env_value "${INGRESS_HOME}")
COMMUNITY_TRANSPORT=$(quote_env_value "unix_socket")
COMMUNITY_AGENT_SOCKET_PATH=$(quote_env_value "${SOCKET_PATH}")
COMMUNITY_WEBHOOK_HOST=$(quote_env_value "${WEBHOOK_HOST}")
COMMUNITY_WEBHOOK_PORT=$(quote_env_value "${WEBHOOK_PORT}")
COMMUNITY_WEBHOOK_PATH=$(quote_env_value "${WEBHOOK_PATH}")
COMMUNITY_SEND_PATH=$(quote_env_value "${SEND_PATH}")
COMMUNITY_WEBHOOK_PUBLIC_HOST=$(quote_env_value "${WEBHOOK_PUBLIC_HOST}")
COMMUNITY_WEBHOOK_PUBLIC_URL=$(quote_env_value "${WEBHOOK_PUBLIC_URL}")
COMMUNITY_RESET_STATE_ON_START=$(quote_env_value "${COMMUNITY_RESET_STATE_ON_START:-0}")
COMMUNITY_AGENT_DISPLAY_NAME=$(quote_env_value "${AGENT_DISPLAY_NAME}")
COMMUNITY_AGENT_HANDLE=$(quote_env_value "${AGENT_SLUG}")
COMMUNITY_AGENT_IDENTITY=$(quote_env_value "${AGENT_IDENTITY}")
COMMUNITY_AGENT_TAGLINE=$(quote_env_value "${AGENT_TAGLINE}")
COMMUNITY_AGENT_BIO=$(quote_env_value "${COMMUNITY_AGENT_BIO:-}")
COMMUNITY_AGENT_AVATAR_TEXT=$(quote_env_value "${COMMUNITY_AGENT_AVATAR_TEXT:-}")
COMMUNITY_AGENT_ACCENT_COLOR=$(quote_env_value "${COMMUNITY_AGENT_ACCENT_COLOR:-}")
COMMUNITY_AGENT_EXPERTISE=$(quote_env_value "${COMMUNITY_AGENT_EXPERTISE:-}")
COMMUNITY_MODEL_CONFIG_SOURCE=$(quote_env_value "${RESOLVED_MODEL_SOURCE:-}")
COMMUNITY_MODEL_CONFIG_SOURCE_TYPE=$(quote_env_value "${RESOLVED_MODEL_SOURCE_TYPE:-formal_openclaw_config}")
COMMUNITY_MODEL_CONFIG_MODE=$(quote_env_value "formal_inherited")
COMMUNITY_MODEL_PROVIDER=$(quote_env_value "${RESOLVED_MODEL_PROVIDER:-}")
COMMUNITY_MODEL_API_KEY_FINGERPRINT=$(quote_env_value "${RESOLVED_MODEL_API_KEY_FINGERPRINT:-}")
MODEL_BASE_URL=$(quote_env_value "${RESOLVED_MODEL_BASE_URL:-}")
MODEL_API_KEY=$(quote_env_value "${RESOLVED_MODEL_API_KEY:-}")
MODEL_ID=$(quote_env_value "${RESOLVED_MODEL_ID:-}")
COMMUNITY_OPENCLAW_STATE_DIR=$(quote_env_value "${STATE_DIR}/community-openclaw")
COMMUNITY_OPENCLAW_CONFIG_PATH=$(quote_env_value "${STATE_DIR}/community-openclaw/openclaw.json")
COMMUNITY_OPENCLAW_BIN=$(quote_env_value "$(command -v openclaw || true)")
COMMUNITY_OPENCLAW_TIMEOUT_SECONDS=$(quote_env_value "${COMMUNITY_OPENCLAW_TIMEOUT_SECONDS:-120}")
EOF

cat >"${BOOTSTRAP_METADATA}" <<EOF
{
  "agent_slug": "${AGENT_SLUG}",
  "ingress_service_name": "${INGRESS_SERVICE_NAME}",
  "service_name": "${SERVICE_NAME}",
  "community_base_url": "${BASE_URL}",
  "ingress_home": "${INGRESS_HOME}",
  "socket_path": "${SOCKET_PATH}",
  "webhook_port": ${WEBHOOK_PORT},
  "webhook_path": "${WEBHOOK_PATH}",
  "send_path": "${SEND_PATH}",
  "openclaw_state_dir": "${STATE_DIR}/community-openclaw",
  "openclaw_config_path": "${STATE_DIR}/community-openclaw/openclaw.json",
  "skill_version": "${SKILL_VERSION}",
  "skill_release_ref": "${SKILL_RELEASE_REF}"
}
EOF

cat >"${BOOTSTRAP_CONFIG}" <<EOF
COMMUNITY_BASE_URL=${BASE_URL}
COMMUNITY_GROUP_SLUG=${GROUP_SLUG}
COMMUNITY_WEBHOOK_HOST=${WEBHOOK_HOST}
COMMUNITY_WEBHOOK_PORT=${WEBHOOK_PORT}
COMMUNITY_WEBHOOK_PUBLIC_HOST=${WEBHOOK_PUBLIC_HOST}
EOF

for asset_name in IDENTITY SOUL USER; do
  workspace_asset="${WORKSPACE_ROOT}/assets/${asset_name}.md"
  template_asset="${ASSETS_DIR}/${asset_name}.md"
  if [[ -f "${workspace_asset}" ]]; then
    cp "${workspace_asset}" "${template_asset}"
  fi
done

if [[ ! -f "${ASSETS_DIR}/IDENTITY.md" ]]; then
  cat >"${ASSETS_DIR}/IDENTITY.md" <<'EOF'
You are an OpenClaw community-connected agent.
Respond helpfully, clearly, and collaboratively.
EOF
fi

if [[ ! -f "${ASSETS_DIR}/SOUL.md" ]]; then
  cat >"${ASSETS_DIR}/SOUL.md" <<'EOF'
Work with care, honesty, and calm execution.
EOF
fi

if [[ ! -f "${ASSETS_DIR}/USER.md" ]]; then
  cat >"${ASSETS_DIR}/USER.md" <<'EOF'
Support the user with practical progress and direct answers.
EOF
fi

mkdir -p "${INGRESS_HOME}" "${INGRESS_HOME}/sockets"
ROUTE_REGISTRY="${INGRESS_HOME}/route-registry.json"
INGRESS_SCRIPT="${SKILL_ROOT}/scripts/community-ingress-server.mjs"
INGRESS_ENV="${INGRESS_HOME}/community-ingress.env"
INGRESS_SERVICE_PATH="/etc/systemd/system/${INGRESS_SERVICE_NAME}"
AGENT_SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"

if [[ "${MANAGE_INGRESS_SERVICE}" == "1" ]]; then
cat >"${INGRESS_ENV}" <<EOF
COMMUNITY_INGRESS_HOME='${INGRESS_HOME}'
COMMUNITY_ROUTE_REGISTRY='${ROUTE_REGISTRY}'
COMMUNITY_INGRESS_HOST='0.0.0.0'
COMMUNITY_INGRESS_PORT='8848'
EOF
fi

if [[ ! -f "${ROUTE_REGISTRY}" ]]; then
  cat >"${ROUTE_REGISTRY}" <<'EOF'
{
  "agents": {}
}
EOF
fi

python3 - "${ROUTE_REGISTRY}" "${AGENT_SLUG}" "${WORKSPACE_ROOT}" "${SERVICE_NAME}" "${WEBHOOK_PATH}" "${SEND_PATH}" "${SOCKET_PATH}" <<'PY'
import json
import os
import sys

registry_path, slug, workspace_root, service_name, webhook_path, send_path, socket_path = sys.argv[1:]
os.makedirs(os.path.dirname(registry_path), exist_ok=True)
try:
    with open(registry_path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except FileNotFoundError:
    data = {"agents": {}}

agents = data.setdefault("agents", {})
agents[slug] = {
    "agent_slug": slug,
    "workspace_root": workspace_root,
    "service_name": service_name,
    "webhook_path": webhook_path,
    "send_path": send_path,
    "socket_path": socket_path,
}

with open(registry_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
PY

if [[ "${MANAGE_INGRESS_SERVICE}" == "1" ]]; then
cat >"${INGRESS_SERVICE_PATH}" <<UNIT
[Unit]
Description=OpenClaw Community Ingress
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${INGRESS_HOME}
EnvironmentFile=-${INGRESS_ENV}
ExecStart=${NODE_BIN} ${INGRESS_SCRIPT}
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
fi

cat >"${AGENT_SERVICE_PATH}" <<UNIT
[Unit]
Description=OpenClaw Community Integration Agent (${AGENT_SLUG})
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${WORKSPACE_ROOT}
EnvironmentFile=-${ENV_FILE}
Environment=WORKSPACE_ROOT=${WORKSPACE_ROOT}
Environment=COMMUNITY_TRANSPORT=unix_socket
Environment=COMMUNITY_AGENT_SOCKET_PATH=${SOCKET_PATH}
Environment=COMMUNITY_INGRESS_HOME=${INGRESS_HOME}
ExecStart=${NODE_BIN} ${SKILL_ROOT}/scripts/community-webhook-server.mjs
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

if [[ "${MANAGE_INGRESS_SERVICE}" == "1" ]]; then
  chmod 644 "${INGRESS_SERVICE_PATH}"
fi
chmod 644 "${AGENT_SERVICE_PATH}"
systemctl daemon-reload
if [[ "${MANAGE_INGRESS_SERVICE}" == "1" ]]; then
  systemctl enable "${INGRESS_SERVICE_NAME}" >/dev/null
fi
systemctl enable "${SERVICE_NAME}" >/dev/null
stop_legacy_agent_listener_on_8848
if [[ "${MANAGE_INGRESS_SERVICE}" == "0" ]] && [[ -n "${LEGACY_INGRESS_SERVICE_NAME}" ]] && [[ "${LEGACY_INGRESS_SERVICE_NAME}" != "${INGRESS_SERVICE_NAME}" ]]; then
  systemctl disable --now "${LEGACY_INGRESS_SERVICE_NAME}" >/dev/null 2>&1 || true
fi
rm -f "${RUNTIME_MODEL_STATE_PATH}"
if [[ "${MANAGE_INGRESS_SERVICE}" == "1" ]]; then
  systemctl restart "${INGRESS_SERVICE_NAME}" || systemctl start "${INGRESS_SERVICE_NAME}"
fi
systemctl restart "${SERVICE_NAME}" || systemctl start "${SERVICE_NAME}"

if wait_for_socket "${SOCKET_PATH}" "${COMMUNITY_SOCKET_WAIT_ATTEMPTS:-120}" "${COMMUNITY_SOCKET_WAIT_DELAY:-0.5}"; then
  echo "PASS socket ready after ${SOCKET_READY_SECONDS}s (${SOCKET_READY_POLLS} polls): ${SOCKET_PATH}"
else
  echo "agent socket did not become ready during onboarding window after ${SOCKET_READY_SECONDS}s (${SOCKET_READY_POLLS} polls): ${SOCKET_PATH}" >&2
  exit 1
fi

SERVICE_MAIN_PID="$(service_main_pid "${SERVICE_NAME}")"
if wait_for_runtime_model_state "${RUNTIME_MODEL_STATE_PATH}" "${SERVICE_MAIN_PID}" "${COMMUNITY_MODEL_WAIT_ATTEMPTS:-240}" "${COMMUNITY_MODEL_WAIT_DELAY:-0.5}"; then
  echo "PASS runtime model inheritance ready after ${MODEL_READY_SECONDS}s (${MODEL_READY_POLLS} polls): ${RUNTIME_MODEL_STATE_PATH}"
else
  echo "runtime model inheritance did not become ready during onboarding window after ${MODEL_READY_SECONDS}s (${MODEL_READY_POLLS} polls): ${RUNTIME_MODEL_STATE_PATH}" >&2
  echo "expected the current ${SERVICE_NAME} main PID (${SERVICE_MAIN_PID}) to publish ready formal model inheritance state" >&2
  exit 1
fi

if wait_for_saved_state "${STATE_PATH}" "${COMMUNITY_STATE_WAIT_ATTEMPTS:-240}" "${COMMUNITY_STATE_WAIT_DELAY:-0.5}"; then
  echo "PASS community state ready after ${STATE_READY_SECONDS}s (${STATE_READY_POLLS} polls): ${STATE_PATH}"
else
  echo "agent community state did not become ready during onboarding window after ${STATE_READY_SECONDS}s (${STATE_READY_POLLS} polls): ${STATE_PATH}" >&2
  echo "expected saved state with token, groupId, and agentId" >&2
  exit 1
fi

if wait_for_agent_webhook "${BASE_URL}" "${STATE_PATH}" "${COMMUNITY_WEBHOOK_WAIT_ATTEMPTS:-120}" "${COMMUNITY_WEBHOOK_WAIT_DELAY:-0.5}"; then
  echo "PASS agent webhook registered after ${WEBHOOK_READY_SECONDS}s (${WEBHOOK_READY_POLLS} polls)"
else
  echo "agent webhook subscription did not become active after ${WEBHOOK_READY_SECONDS}s (${WEBHOOK_READY_POLLS} polls)" >&2
  exit 1
fi

cat <<EOF
Workspace: ${WORKSPACE_ROOT}
Skill root: ${SKILL_ROOT}
Env file: ${ENV_FILE}
Bootstrap metadata: ${BOOTSTRAP_METADATA}
Ingress service: ${INGRESS_SERVICE_NAME}
Agent service: ${SERVICE_NAME}
Agent slug: ${AGENT_SLUG}
Socket path: ${SOCKET_PATH}
Webhook URL: ${WEBHOOK_PUBLIC_URL}
Send path: ${SEND_PATH}
EOF
