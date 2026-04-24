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

function normalizeMessage(message) {
  const source = dictOf(message);
  if (!Object.keys(source).length) {
    return {};
  }

  const author = dictOf(source.author);
  const content = dictOf(source.content);
  const relations = dictOf(source.relations);
  const routing = dictOf(source.routing);
  const target = dictOf(routing.target);
  const extensions = dictOf(source.extensions);
  const custom = dictOf(extensions.custom);

  return {
    id: source.id || null,
    group_id: source.group_id || null,
    author_agent_id: firstText(author.agent_id, source.agent_id) || null,
    flow_type: firstText(source.flow_type, dictOf(source.semantics).flow_type) || "run",
    message_type: firstText(source.message_type, dictOf(source.semantics).message_type, dictOf(source.semantics).kind) || null,
    text: firstText(content.text),
    payload: dictOf(content.payload),
    thread_id: firstText(relations.thread_id) || null,
    parent_message_id: firstText(relations.parent_message_id) || null,
    target_agent_id: firstText(target.agent_id, source.target_agent_id, custom.target_agent_id) || null,
    mentions: listOf(routing.mentions),
    extensions,
    custom,
  };
}

function extractPayload(event) {
  const source = dictOf(event);
  return source?.entity?.message || source?.event?.payload?.message || source?.event?.payload || source?.entity || {};
}

function extractEventType(event) {
  return textOf(event?.event?.event_type);
}

function contextGroupId(message, payload) {
  const source = dictOf(payload);
  return firstText(
    message.group_id,
    dictOf(source.group_session).group_id,
    dictOf(source.group_session_declaration).group_id,
    dictOf(source.group_context).group_id,
    dictOf(source.channel_context).group_id,
  );
}

function classifyInput(eventType, message) {
  if (eventType === "protocol_violation") {
    return { category: "protocol_violation", reason: "event_type" };
  }
  if (eventType === "workflow_contract") {
    return { category: "workflow_contract", reason: "event_type" };
  }
  if (["group_context", "channel_context"].includes(eventType)) {
    return { category: "group_context", reason: "event_type" };
  }
  if (["group_session.updated", "group_session", "group_session_declaration"].includes(eventType)) {
    return { category: "group_session", reason: "event_type" };
  }
  if (message.flow_type === "status") {
    return { category: "status", reason: "status_flow" };
  }
  if (["start", "run", "result"].includes(message.flow_type)) {
    return { category: message.flow_type, reason: "flow_type" };
  }
  return { category: "unknown", reason: "fallback" };
}

function responsibilitySignals(message, state, groupId) {
  const selfId = textOf(state?.agentId);
  const targetId = textOf(message.target_agent_id);
  const authorId = textOf(message.author_agent_id);
  const mentionIds = listOf(message.mentions)
    .map((item) => dictOf(item))
    .map((item) => firstText(item.mention_id, item.agent_id))
    .filter(Boolean);

  const question = /[?？]$/.test(message.text) || /(please|can you|could you|question|review|reply|confirm)/i.test(message.text);
  const targeted = Boolean(targetId && selfId && targetId === selfId);
  const mentioned = Boolean(selfId && mentionIds.includes(selfId));
  // Delivery is already filtered by group membership on the community server.
  // If this runtime receives an event with a concrete group id, treat it as
  // in-scope for that joined group instead of collapsing scope to one home group.
  const groupScope = Boolean(groupId);
  const selfMessage = Boolean(authorId && selfId && authorId === selfId);

  return {
    targeted,
    mentioned,
    group_scope: groupScope,
    status: message.flow_type === "status",
    self_message: selfMessage,
    question,
  };
}

function decideObligation(category, signals) {
  if (signals.self_message) {
    return { obligation: "observe_only", reason: "self_message" };
  }
  if (!signals.group_scope) {
    return { obligation: "observe_only", reason: "out_of_group_scope" };
  }
  if (category === "protocol_violation") {
    return { obligation: "observe_only", reason: "protocol_violation" };
  }
  if (["workflow_contract", "group_context", "group_session"].includes(category)) {
    return { obligation: "observe_only", reason: "context_update" };
  }
  if (signals.status) {
    return { obligation: "observe_only", reason: "status_facility" };
  }
  if (signals.targeted) {
    return { obligation: "required", reason: "targeted_to_self" };
  }
  if (signals.mentioned) {
    return { obligation: "optional", reason: "mentioned_to_self" };
  }
  if (["start", "run", "result"].includes(category)) {
    return { obligation: "optional", reason: "visible_collaboration" };
  }
  return { obligation: "observe_only", reason: "default_observe" };
}

function recommendHandling(category, obligation, signals) {
  if (obligation === "required") {
    return { mode: "needs_agent_judgment", reason: signals.question ? "required_question" : "required_collaboration" };
  }
  if (obligation === "required_ack") {
    return { mode: "needs_agent_judgment", reason: "required_ack" };
  }
  if (obligation === "optional" && ["start", "run", "result"].includes(category)) {
    return { mode: "agent_discretion", reason: "optional_collaboration" };
  }
  return { mode: "observe_only", reason: "observe_only_default" };
}

function judgmentResult(category, message, signals, obligationDecision, recommendation, extras = {}) {
  return {
    category,
    message,
    signals,
    obligation: obligationDecision,
    recommendation,
    observed: recommendation.mode === "observe_only",
    ...extras,
  };
}

function runtimeMemo(state) {
  if (!state || typeof state !== "object") {
    return {};
  }
  if (!state.__communityRuntimeMemo || typeof state.__communityRuntimeMemo !== "object") {
    state.__communityRuntimeMemo = {};
  }
  return state.__communityRuntimeMemo;
}

function managerControlTurnOf(payload) {
  const source = dictOf(payload);
  return (
    dictOf(dictOf(source.group_session).manager_control_turn) ||
    dictOf(dictOf(source.group_session_declaration).manager_control_turn) ||
    dictOf(source.manager_control_turn)
  );
}

function resolveBuiltInGroupSessionObligation(state, groupId, payload, signals) {
  if (!groupId || !signals.group_scope) {
    return null;
  }
  const controlTurn = managerControlTurnOf(payload);
  if (!Object.keys(controlTurn).length) {
    return null;
  }
  const selfId = textOf(state?.agentId);
  const requiredAgentIds = listOf(controlTurn.required_agent_ids).map((item) => textOf(item)).filter(Boolean);
  if (!selfId || !requiredAgentIds.includes(selfId)) {
    return null;
  }
  const turnId = firstText(
    controlTurn.turn_id,
    controlTurn.activation_version,
    dictOf(payload).group_session?.group_session_version,
    dictOf(payload).group_session_declaration?.group_session_version,
  );
  if (turnId) {
    const memo = runtimeMemo(state);
    const seenTurns = dictOf(memo.manager_control_turns);
    const memoKey = `${groupId}:${turnId}`;
    if (seenTurns[memoKey]) {
      return { obligation: "observe_only", reason: "duplicate_server_manager_control_turn" };
    }
    seenTurns[memoKey] = true;
    memo.manager_control_turns = seenTurns;
  }
  return {
    obligation: "required",
    reason: firstText(controlTurn.reason, "server_manager_control_turn"),
  };
}

async function mountGroupSession(adapter, state, groupId, payload) {
  if (!groupId) {
    return;
  }
  if (typeof adapter.loadGroupSession === "function") {
    await adapter.loadGroupSession(state, groupId, payload);
    return;
  }
  // group_session.updated carries a sync view. When integration lacks a
  // dedicated session loader, force a canonical /groups/{id}/context refresh so
  // the runtime can mount the full server truth, including group_session.
  if (typeof adapter.loadGroupContext === "function") {
    await adapter.loadGroupContext(state, groupId, null);
    return;
  }
  if (typeof adapter.loadChannelContext === "function") {
    await adapter.loadChannelContext(state, groupId, null);
  }
}

async function resolveGroupSessionObligation(adapter, state, groupId, payload, signals) {
  if (!groupId || typeof adapter.resolveGroupSessionObligation !== "function") {
    return null;
  }
  const decision = await adapter.resolveGroupSessionObligation(state, groupId, payload, signals);
  const normalized = dictOf(decision);
  const obligation = textOf(normalized.obligation).toLowerCase();
  if (!["required", "required_ack", "optional", "observe_only"].includes(obligation)) {
    return null;
  }
  return {
    obligation,
    reason: firstText(normalized.reason, "adapter_group_session_control"),
  };
}

export async function handleRuntimeEvent(adapter, state, event) {
  const eventType = extractEventType(event);
  const payload = extractPayload(event);
  const message = normalizeMessage(payload);
  const classification = classifyInput(eventType, message);
  const effectiveGroupId = contextGroupId(message, payload);
  const signals = responsibilitySignals(message, state, effectiveGroupId);

  if (classification.category === "protocol_violation") {
    if (typeof adapter.handleProtocolViolation === "function") {
      await adapter.handleProtocolViolation(state, payload);
    }
    const obligationDecision = decideObligation(classification.category, signals);
    const recommendation = recommendHandling(classification.category, obligationDecision.obligation, signals);
    return judgmentResult(classification.category, message, signals, obligationDecision, recommendation);
  }

  if (classification.category === "workflow_contract") {
    if (typeof adapter.loadWorkflowContract === "function" && effectiveGroupId) {
      await adapter.loadWorkflowContract(effectiveGroupId, payload, "event");
    }
    const obligationDecision = decideObligation(classification.category, signals);
    const recommendation = recommendHandling(classification.category, obligationDecision.obligation, signals);
    return judgmentResult(classification.category, message, signals, obligationDecision, recommendation);
  }

  if (classification.category === "group_context") {
    if (typeof adapter.loadGroupContext === "function" && effectiveGroupId) {
      await adapter.loadGroupContext(state, effectiveGroupId, payload);
    } else if (typeof adapter.loadChannelContext === "function" && effectiveGroupId) {
      await adapter.loadChannelContext(state, effectiveGroupId, payload);
    }
    const obligationDecision = decideObligation(classification.category, signals);
    const recommendation = recommendHandling(classification.category, obligationDecision.obligation, signals);
    return judgmentResult(classification.category, message, signals, obligationDecision, recommendation);
  }

  if (classification.category === "group_session") {
    await mountGroupSession(adapter, state, effectiveGroupId, payload);
    const obligationDecision =
      (await resolveGroupSessionObligation(adapter, state, effectiveGroupId, payload, signals)) ||
      resolveBuiltInGroupSessionObligation(state, effectiveGroupId, payload, signals) ||
      decideObligation(classification.category, signals);
    const recommendation = recommendHandling(classification.category, obligationDecision.obligation, signals);
    return judgmentResult(classification.category, message, signals, obligationDecision, recommendation, {
      context_group_id: effectiveGroupId || null,
      manager_control_turn: managerControlTurnOf(payload),
    });
  }

  const obligationDecision = decideObligation(classification.category, signals);
  const recommendation = recommendHandling(classification.category, obligationDecision.obligation, signals);
  return judgmentResult(classification.category, message, signals, obligationDecision, recommendation, {
    context_group_id: effectiveGroupId || null,
  });
}
