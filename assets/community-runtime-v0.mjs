function dictOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function textOf(value) {
  return String(value || "").trim();
}

function lower(value) {
  return textOf(value).toLowerCase();
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
  if (!source || !Object.keys(source).length) {
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
  const currentGroupId = textOf(state?.groupId);
  const mentionIds = listOf(message.mentions)
    .map((item) => dictOf(item))
    .map((item) => firstText(item.mention_id, item.agent_id))
    .filter(Boolean);

  const question = /[?？]$/.test(message.text) || /请|是否|能否|可以/.test(message.text);
  const targeted = Boolean(targetId && selfId && targetId === selfId);
  const mentioned = Boolean(selfId && mentionIds.includes(selfId));
  const groupScope = Boolean(groupId && (!currentGroupId || currentGroupId === groupId));
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
  if (["workflow_contract", "group_context"].includes(category)) {
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

function defaultResponseDecision(category, obligation, signals) {
  if (obligation === "required") {
    return { action: signals.question ? "full_reply" : "brief_reply", reason: "required_obligation" };
  }
  if (obligation === "required_ack") {
    return { action: "ack", reason: "required_ack" };
  }
  if (obligation === "optional" && ["start", "run", "result"].includes(category)) {
    return { action: "observe_only", reason: "optional_collaboration" };
  }
  return { action: "observe_only", reason: "observe_only_default" };
}

function fallbackReplyText(message, category, decision) {
  if (decision.action === "ack") {
    return "已收到，我会按当前群组上下文继续协作。";
  }
  if (decision.action === "brief_reply") {
    return `已收到这条${category}消息，我会继续跟进。`;
  }
  if (decision.action === "full_reply") {
    return `已收到这条${category}消息。我会结合当前群组上下文继续处理并同步后续情况。`;
  }
  return "";
}

async function dispatchReply(adapter, state, event, message, category, decision, signals, obligationDecision) {
  if (decision.action === "observe_only") {
    return {
      ignored: false,
      observed: true,
      category,
      obligation: obligationDecision,
      signals,
      decision,
    };
  }

  const incomingMessage = {
    id: message.id,
    group_id: message.group_id,
    thread_id: message.thread_id,
    parent_message_id: message.parent_message_id,
    agent_id: message.author_agent_id,
    agent_name: null,
    source_agent_name: null,
  };

  let replyText = "";
  if (typeof adapter.generateReply === "function") {
    try {
      replyText = await adapter.generateReply(
        {
          id: message.id,
          group_id: message.group_id,
          flow_type: message.flow_type,
          message_type: message.message_type,
          content: { text: message.text, payload: message.payload },
          relations: { thread_id: message.thread_id, parent_message_id: message.parent_message_id },
          routing: { target: { agent_id: message.target_agent_id }, mentions: message.mentions },
          extensions: message.extensions,
        },
        state,
        {},
        { responseDecision: decision, contextFlags: signals, mode: category },
      );
    } catch {
      replyText = "";
    }
  }

  if (!textOf(replyText)) {
    replyText = fallbackReplyText(message, category, decision);
  }

  if (!textOf(replyText)) {
    return {
      ignored: false,
      observed: true,
      category,
      obligation: obligationDecision,
      signals,
      decision,
    };
  }

  const outbound = {
    group_id: message.group_id,
    flow_type: "run",
    message_type: decision.action === "ack" ? "summary" : "analysis",
    content: {
      text: replyText,
      payload: {},
    },
    relations: {
      thread_id: message.thread_id || message.id || null,
      parent_message_id: message.id || null,
    },
    routing: {
      target: {
        agent_id: message.author_agent_id,
      },
      mentions: [],
    },
    extensions: {
      custom: {
        responsibility_reason: obligationDecision.reason,
      },
    },
  };

  const result = await adapter.postCommunityMessage(state, incomingMessage, outbound);
  return {
    posted: true,
    category,
    obligation: obligationDecision,
    signals,
    decision,
    result,
  };
}

export async function handleRuntimeEvent(adapter, state, event) {
  const eventType = extractEventType(event);
  const payload = extractPayload(event);
  const message = normalizeMessage(payload);
  const classification = classifyInput(eventType, message);

  if (classification.category === "protocol_violation") {
    if (typeof adapter.handleProtocolViolation === "function") {
      await adapter.handleProtocolViolation(state, payload);
    }
    const signals = responsibilitySignals(message, state);
    const obligationDecision = decideObligation(classification.category, signals);
    const decision = defaultResponseDecision(classification.category, obligationDecision.obligation, signals);
    return dispatchReply(adapter, state, event, message, classification.category, decision, signals, obligationDecision);
  }

  if (classification.category === "workflow_contract") {
    if (typeof adapter.loadWorkflowContract === "function" && message.group_id) {
      await adapter.loadWorkflowContract(state, message.group_id, payload);
    }
    const signals = responsibilitySignals(message, state);
    const obligationDecision = decideObligation(classification.category, signals);
    const decision = defaultResponseDecision(classification.category, obligationDecision.obligation, signals);
    return dispatchReply(adapter, state, event, message, classification.category, decision, signals, obligationDecision);
  }

  if (classification.category === "group_context") {
    if (typeof adapter.loadGroupContext === "function" && message.group_id) {
      await adapter.loadGroupContext(state, message.group_id, payload);
    } else if (typeof adapter.loadChannelContext === "function" && message.group_id) {
      await adapter.loadChannelContext(state, message.group_id, payload);
    }
    const signals = responsibilitySignals(message, state);
    const obligationDecision = decideObligation(classification.category, signals);
    const decision = defaultResponseDecision(classification.category, obligationDecision.obligation, signals);
    return dispatchReply(adapter, state, event, message, classification.category, decision, signals, obligationDecision);
  }

  const signals = responsibilitySignals(message, state);
  const obligationDecision = decideObligation(classification.category, signals);
  const decision = defaultResponseDecision(classification.category, obligationDecision.obligation, signals);
  return dispatchReply(adapter, state, event, message, classification.category, decision, signals, obligationDecision);
}
