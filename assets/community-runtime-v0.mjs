function dictOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function textOf(value) {
  const text = String(value || "").trim();
  return text;
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

function normalizeFlowType(value) {
  const flowType = firstText(value).toLowerCase() || "run";
  if (flowType === "status") {
    return "run";
  }
  if (["start", "run", "result"].includes(flowType)) {
    return flowType;
  }
  return "run";
}

function normalizeAuthorKind(value, fallback = "agent") {
  const authorKind = firstText(value).toLowerCase() || fallback;
  if (["agent", "system"].includes(authorKind)) {
    return authorKind;
  }
  return fallback;
}

function normalizeMessage(message) {
  const source = dictOf(message);
  const author = dictOf(source.author);
  const content = dictOf(source.content);
  const relations = dictOf(source.relations);
  const routing = dictOf(source.routing);
  const target = dictOf(routing.target);
  const semantics = dictOf(source.semantics);
  const authorAgentId = firstText(author.agent_id, source.agent_id) || null;
  const authorKind = normalizeAuthorKind(
    firstText(source.author_kind, author.author_kind),
    authorAgentId ? "agent" : "system",
  );
  return {
    id: source.id || null,
    group_id: source.group_id || null,
    author_kind: authorKind,
    author_agent_id: authorAgentId,
    flow_type: normalizeFlowType(firstText(source.flow_type, semantics.flow_type)),
    message_type: firstText(source.message_type, semantics.message_type, semantics.kind) || null,
    text: firstText(content.text),
    payload: dictOf(content.payload),
    status_block: dictOf(source.status_block || content.status_block),
    context_block: dictOf(source.context_block || content.context_block),
    thread_id: firstText(relations.thread_id, source.thread_id) || null,
    parent_message_id: firstText(relations.parent_message_id, source.parent_message_id) || null,
    target_agent_id: firstText(target.agent_id, source.target_agent_id) || null,
    mentions: listOf(routing.mentions),
    routing,
    relations,
    extensions: dictOf(source.extensions),
  };
}

function extractDeliverableEvent(event) {
  const source = dictOf(event);
  const envelope = dictOf(source.event);
  const payload = dictOf(envelope.payload);
  const message = normalizeMessage(source.message || source.entity?.message || payload.message || payload);
  return {
    event_id: source.event_id || envelope.event_id || null,
    event_type: firstText(source.event_type, envelope.event_type),
    group_id: firstText(source.group_id, envelope.group_id, message.group_id) || null,
    occurred_at: source.occurred_at || source.occurredAt || source.created_at || envelope.created_at || null,
    delivery_scope: dictOf(source.delivery_scope || source.deliveryScope),
    message,
  };
}

function classifyEvent(deliverable) {
  const eventType = deliverable.event_type;
  const scope = String(deliverable.delivery_scope?.scope || "").trim().toLowerCase();
  if (["message.accepted", "message.rejected", "message.delivery_failed", "outbound.canonicalized", "sender.acknowledged"].includes(eventType)) {
    return { category: "non_intake", reason: "internal_event" };
  }
  if (eventType === "group_session.updated") {
    return { category: "group_session_update", reason: "group_session" };
  }
  if (eventType === "broadcast.delivered" || scope === "group_context") {
    return { category: "group_context", reason: "system_context" };
  }
  return { category: deliverable.message.flow_type || "run", reason: "formal_flow_type" };
}

function responsibilitySignals(deliverable, state) {
  const message = deliverable.message;
  const selfId = firstText(state?.agentId);
  const targetId = firstText(message.target_agent_id);
  const authorId = firstText(message.author_agent_id);
  const mentionIds = listOf(message.mentions)
    .map((item) => dictOf(item))
    .map((item) => firstText(item.mention_id, item.agent_id))
    .filter(Boolean);
  return {
    targeted: Boolean(selfId && targetId && selfId === targetId),
    mentioned: Boolean(selfId && mentionIds.includes(selfId)),
    group_scope: Boolean(deliverable.group_id),
    has_status_block: Object.keys(dictOf(message.status_block)).length > 0,
    has_context_block: Object.keys(dictOf(message.context_block)).length > 0,
    self_message: Boolean(selfId && authorId && selfId === authorId),
    question: /[?？]$/.test(message.text) || /(请|review|reply|confirm|can you|could you|please)/i.test(message.text),
  };
}

function decideObligation(classification, deliverable, signals) {
  if (classification.category === "non_intake") {
    return { obligation: "observe_only", reason: "non_runtime_intake" };
  }
  if (signals.self_message) {
    return { obligation: "observe_only", reason: "self_message" };
  }
  if (!signals.group_scope) {
    return { obligation: "observe_only", reason: "out_of_group_scope" };
  }
  if (["group_context", "group_session_update"].includes(classification.category)) {
    return { obligation: "observe_only", reason: "context_only" };
  }
  if (signals.targeted) {
    return { obligation: "required", reason: "targeted_to_self" };
  }
  if (signals.mentioned) {
    return { obligation: "optional", reason: "mentioned_to_self" };
  }
  if (["start", "run", "result"].includes(classification.category)) {
    return { obligation: "optional", reason: "visible_collaboration" };
  }
  return { obligation: "observe_only", reason: "default_observe" };
}

function recommendHandling(obligation, signals) {
  if (obligation.obligation === "required") {
    return { mode: "needs_agent_judgment", reason: signals.question ? "required_question" : "required_collaboration" };
  }
  if (obligation.obligation === "optional") {
    return { mode: "agent_discretion", reason: "optional_collaboration" };
  }
  return { mode: "observe_only", reason: "observe_only_default" };
}

export async function handleRuntimeEvent(_adapter, state, event, runtimeContext = {}) {
  const deliverable = extractDeliverableEvent(event);
  const classification = classifyEvent(deliverable);
  const signals = responsibilitySignals(deliverable, state, runtimeContext);
  const obligation = decideObligation(classification, deliverable, signals);
  const recommendation = recommendHandling(obligation, signals);

  return {
    category: classification.category,
    message: deliverable.message,
    event: {
      event_id: deliverable.event_id,
      event_type: deliverable.event_type,
      group_id: deliverable.group_id,
      occurred_at: deliverable.occurred_at,
      delivery_scope: deliverable.delivery_scope,
    },
    signals,
    obligation,
    recommendation,
  };
}
