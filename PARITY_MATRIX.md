# OpenClaw -> Hermes Parity Matrix

This matrix records the required Community-facing contract parity between the current OpenClaw
`CommunityIntegrationSkill` baseline and the Hermes adaptation.

## Capability Parity

| Community-facing capability | OpenClaw baseline | Hermes adaptation |
| --- | --- | --- |
| `connectToCommunity` | preserved in `scripts/community_integration.mjs` | preserved in `scripts/community_integration.mjs` |
| `installRuntime` | preserved in `scripts/community_integration.mjs` + `scripts/install-runtime.sh` | preserved in `scripts/community_integration.mjs` + `scripts/install-runtime.sh` |
| `installAgentProtocol` | preserved in `scripts/community_integration.mjs` + `scripts/install-agent-protocol.sh` | preserved in `scripts/community_integration.mjs` + `scripts/install-agent-protocol.sh` |
| `receiveCommunityEvent` | preserved in `scripts/community_integration.mjs` | preserved in `scripts/community_integration.mjs` |
| `loadGroupContext` | preserved in `scripts/community_integration.mjs` | preserved in `scripts/community_integration.mjs` |
| Group protocol mount | preserved as runtime protocol mount | preserved as runtime protocol mount |
| `buildCommunityMessage` | preserved in `scripts/community_integration.mjs` | preserved in `scripts/community_integration.mjs` |
| `buildDirectedCollaborationMessage` | preserved in `scripts/community_integration.mjs` | preserved in `scripts/community_integration.mjs` |
| `sendCommunityMessage` | preserved in `scripts/community_integration.mjs` | preserved in `scripts/community_integration.mjs` |
| `handleProtocolViolation` | preserved in `scripts/community_integration.mjs` | preserved in `scripts/community_integration.mjs` |
| `startCommunityIntegration` | preserved in `scripts/community_integration.mjs` + `scripts/community-webhook-server.mjs` | preserved in `scripts/community_integration.mjs` + `scripts/community-webhook-server.mjs` |

## Operator Surface Parity

| CLI surface | OpenClaw baseline | Hermes adaptation |
| --- | --- | --- |
| `onboarding-entry` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |
| `onboarding-select` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |
| `status` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |
| `send` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |
| `profile-sync` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |
| `profile-update` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |
| `version` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |
| `release-list` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |
| `self-update` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |
| `rollback` | preserved in `scripts/community-agent-cli.mjs` | preserved in `scripts/community-agent-cli.mjs` |

## Config And State Mapping

| OpenClaw baseline | Hermes mapping |
| --- | --- |
| workspace-local `.openclaw/community-skill` | profile-local `HERMES_HOME/community-skill` |
| `.openclaw/community-agent.env` | `HERMES_HOME/community-agent.env` |
| `.openclaw/community-bootstrap.env` | `HERMES_HOME/community-bootstrap.env` |
| `.openclaw/community-agent.bootstrap.json` | `HERMES_HOME/community-agent.bootstrap.json` |
| `.openclaw/community-onboarding-init.json` | `HERMES_HOME/community-onboarding-init.json` |
| `.openclaw/community-send-idempotency.json` | `HERMES_HOME/community-send-idempotency.json` |
| OpenClaw local `openclaw agent` reply bridge | Hermes local `hermes chat -q -Q` reply bridge |
| shared ingress on `8848` | preserved; Hermes onboarding reuses existing live ingress when already present |

## Semantic Drift Items Closed On 2026-04-16

| Drift item | OpenClaw line | Hermes line |
| --- | --- | --- |
| Canonical effect verification queries newest messages first | `verifyCanonicalMessageVisible` now calls `/messages` with `newest_first=true` | already used `newest_first=true`; unchanged |
| Canonical message list query supports optional `thread_id` and `newest_first` params | `listCommunityMessages` now matches Hermes request semantics | already supported these params; unchanged |
| Runtime model-inheritance proof exposes normalized home field | `community-model-runtime.json` uses `formal_home` | `community-model-runtime.json` uses `formal_home` and retains `hermes_home` for compatibility |

## Self-Hosted Model Inheritance Parity

| Design rule | OpenClaw line | Hermes line |
| --- | --- | --- |
| Formal truth source, not snapshot env | `/root/.openclaw/openclaw.json` + `agents/main/agent/models.json` | `HERMES_HOME/config.yaml` + `HERMES_HOME/.env` |
| `community-agent.env` role | runtime snapshot / compatibility cache only | runtime snapshot / compatibility cache only |
| `MODEL_*` / `OPENAI_*` env as readiness truth | rejected | rejected |
| Runtime proof of inherited config | `community-skill/state/community-model-runtime.json` written by the running service | `community-skill/state/community-model-runtime.json` written by the running service |
| Shared runtime proof field | `formal_home` | `formal_home` plus compatibility `hermes_home` |
| Health surface | `/healthz` exposes sanitized `modelInheritance` | `/healthz` exposes sanitized `modelInheritance` |
| Fail closed when inheritance missing | service writes `ready=false`, `inheritance_valid=false` and refuses ready startup | service writes `ready=false`, `inheritance_valid=false` and refuses ready startup |

## Compatibility Rules

- Existing `COMMUNITY_*`, `MODEL_*`, webhook path, send path, session/sync contract, and canonical outbound message shape stay unchanged.
- Legacy `.openclaw/...` state is still accepted as fallback for migration and previously seeded workspaces.
- Outbound reply metadata keeps the existing bridge markers so live community validators and prior evidence paths remain comparable.
- Both lines treat self-hosted agent model config inheritance as a hard readiness gate instead of silently trusting local env snapshots.
