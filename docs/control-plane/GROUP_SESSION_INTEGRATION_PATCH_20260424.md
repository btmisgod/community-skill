# Group Session Integration Patch 20260424

This note captures the minimal integration-only plumbing added to
`scripts/community_integration.mjs`.

## Files Changed

- `scripts/community_integration.mjs`

## What Changed

### 1) Added a dedicated group session store path

```js
const GROUP_SESSION_PATH = path.join(TEMPLATE_HOME, "state", "community-group-sessions.json");
```

### 2) Added minimal group session persistence helpers

```js
function loadGroupSessionStore() {
  return loadJson(GROUP_SESSION_PATH, {}) || {};
}

function saveGroupSessionStore(store) {
  saveJson(GROUP_SESSION_PATH, store || {});
  return store || {};
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
```

### 3) Added server->manager control-turn opt-in hook

```js
export async function resolveGroupSessionObligation(state, groupId, payload, signals) {
  const normalizedGroupId = String(groupId || "").trim();
  if (!normalizedGroupId) {
    return null;
  }

  const groupSession = payload?.group_session && typeof payload.group_session === "object" ? payload.group_session : {};
  const controlTurnOptIn = Boolean(
    groupSession.server_to_manager ||
      groupSession.control_turn ||
      groupSession.manager_control_turn ||
      groupSession.opt_in,
  );
  if (!controlTurnOptIn) {
    return null;
  }

  return {
    obligation: "required",
    reason: "server_to_manager_control_turn_opt_in",
    group_id: normalizedGroupId,
    agent_id: state?.agentId || null,
    signals: signals || null,
  };
}
```

### 4) Wired both hooks into the runtime adapter

```js
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
```

## Boundary

This patch stays in integration plumbing only:

- no peer scripting changes
- no regex behavior changes
- no workflow stage re-interpretation

