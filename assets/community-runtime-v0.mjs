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
  return textOf(event?.event?.event_type || event?.event_type);
}

function classifyInput(eventType, message) {
  if (eventType === "protocol_violation") {
    return { category: "protocol_violation", reason: "event_type" };
  }
  if (["group_context", "channel_context"].includes(eventType)) {
    return { category: "group_context", reason: "event_type" };
  }
  if (["group_protocol", "channel_protocol"].includes(eventType)) {
    return { category: "group_protocol", reason: "event_type" };
  }
  if (message.flow_type === "status") {
    return { category: "status", reason: "status_flow" };
  }
  if (["start", "run", "result"].includes(message.flow_type)) {
    return { category: message.flow_type, reason: "flow_type" };
  }
  return { category: "unknown", reason: "fallback" };
}

function responsibilitySignals(message, state) {
  const selfId = textOf(state?.agentId);
  const targetId = textOf(message.target_agent_id);
  const authorId = textOf(message.author_agent_id);
  const groupId = textOf(message.group_id);
  const mentionIds = listOf(message.mentions)
    .map((item) => dictOf(item))
    .map((item) => firstText(item.mention_id, item.agent_id))
    .filter(Boolean);

  const question = /[??]$/.test(message.text) || /(please|can you|could you|question|review|reply|confirm)/i.test(message.text);
  const targeted = Boolean(targetId && selfId && targetId === selfId);
  const mentioned = Boolean(selfId && mentionIds.includes(selfId));
  // Delivery is already filtered by group membership on the community server.
  // If this runtime receives an event with a concrete group_id, treat it as
  // in-scope for that joined group instead of collapsing scope to one
  // home/current group.
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
  if (["group_context", "group_protocol"].includes(category)) {
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

function protocolMountOf(runtimeContext) {
  const source = dictOf(runtimeContext);
  return {
    agent_protocol: source.agent_protocol || dictOf(source.protocol_mount).agent_protocol || null,
    group_protocol: source.group_protocol || dictOf(source.protocol_mount).group_protocol || null,
    group_context: source.group_context || dictOf(source.protocol_mount).group_context || null,
    mounted_at: source.mounted_at || dictOf(source.protocol_mount).mounted_at || null,
  };
}

function judgmentResult(category, message, signals, obligationDecision, recommendation, runtimeContext = {}, extras = {}) {
  return {
    category,
    message,
    signals,
    obligation: obligationDecision,
    recommendation,
    protocol_mount: protocolMountOf(runtimeContext),
    observed: recommendation.mode === "observe_only",
    ...extras,
  };
}

export async function handleRuntimeEvent(adapter, state, event, runtimeContext = {}) {
  const eventType = extractEventType(event);
  const payload = extractPayload(event);
  const message = normalizeMessage(payload);
  const classification = classifyInput(eventType, message);
  const signals = responsibilitySignals(message, state);
  const obligationDecision = decideObligation(classification.category, signals);
  const recommendation = recommendHandling(classification.category, obligationDecision.obligation, signals);

  if (classification.category === "protocol_violation") {
    if (typeof adapter.handleProtocolViolation === "function") {
      await adapter.handleProtocolViolation(state, payload);
    }
    return judgmentResult(classification.category, message, signals, obligationDecision, recommendation, runtimeContext);
  }

  if (classification.category === "group_context") {
    if (typeof adapter.loadGroupContext === "function" && message.group_id) {
      await adapter.loadGroupContext(state, message.group_id, payload);
    } else if (typeof adapter.loadChannelContext === "function" && message.group_id) {
      await adapter.loadChannelContext(state, message.group_id, payload);
    }
    return judgmentResult(classification.category, message, signals, obligationDecision, recommendation, runtimeContext);
  }

  if (classification.category === "group_protocol") {
    if (typeof adapter.loadGroupProtocol === "function" && message.group_id) {
      await adapter.loadGroupProtocol(state, message.group_id, payload);
    }
    return judgmentResult(classification.category, message, signals, obligationDecision, recommendation, runtimeContext);
  }

  return judgmentResult(classification.category, message, signals, obligationDecision, recommendation, runtimeContext);
}
