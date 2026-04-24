import { listActionModules, normalizeActionModuleId } from "../action_modules/index.mjs";

function trimString(value) {
  return String(value ?? "").trim();
}

function uniqueActionIds(values) {
  return [...new Set((values || []).map((value) => normalizeActionModuleId(value)).filter(Boolean))];
}

function stageSpec(spec) {
  return Object.freeze({
    stage_id: spec.stage_id,
    owner: spec.owner || null,
    organizer_role: spec.organizer_role || null,
    primary_consumer_role: spec.primary_consumer_role || null,
    observe_only_roles: [...(spec.observe_only_roles || [])],
    goal: spec.goal || null,
    input: [...(spec.input || [])],
    output: [...(spec.output || [])],
    notes: [...(spec.notes || [])],
    allowed_action_modules: uniqueActionIds(spec.allowed_action_modules),
    next_stage: spec.next_stage || null,
    stop_after_reaching: Boolean(spec.stop_after_reaching),
  });
}

function managerCloseStage(stageId, nextStage, semanticDescription, allowedRoles, managerAgentId) {
  return {
    stage_id: stageId,
    semantic_description: semanticDescription,
    allowed_roles: [...allowedRoles],
    accepted_status_blocks: [
      {
        gate_id: "manager_start",
        lifecycle_phase: "start",
        step_statuses: [`manager_${stageId.replace(/\./g, "_")}_started`],
        allowed_roles: ["manager"],
      },
      {
        gate_id: "manager_done",
        lifecycle_phase: "result",
        step_statuses: [`manager_${stageId.replace(/\./g, "_")}_closed`],
        allowed_roles: ["manager"],
      },
    ],
    completion_condition: {
      all_of: [
        {
          gate_id: "manager_done",
          min_count: 1,
          required_agent_ids: [managerAgentId],
        },
      ],
    },
    next_stage: nextStage || null,
  };
}

export const NEWSFLOW_WORKFLOW_ID = "newsflow-action-composed-v1";
export const NEWSFLOW_EXECUTION_SPEC_ID = "newsflow-action-composed-execution-spec-v1";
export const NEWSFLOW_STOP_STAGE = "retrospective.plan";

const STAGE_SPECS = Object.freeze([
  stageSpec({
    stage_id: "step0",
    owner: "manager",
    goal: "Establish the startup surface and explain the bootstrap path before any business-stage work begins.",
    input: ["group_objective", "group_protocol_summary", "role_structure"],
    output: ["startup_handoff_package"],
    allowed_action_modules: ["submit_artifact", "assign_task", "close_or_handoff"],
    notes: [
      "Manager publishes the startup charter in visible text and assigns the step1 alignment task.",
      "Step0 exists to make the startup flow visible in group messages, not to start business-stage artifact work.",
    ],
    next_stage: "step1",
  }),
  stageSpec({
    stage_id: "step1",
    owner: "non_manager_alignment_under_manager_closure",
    goal: "Let every non-manager agent confirm task understanding and role boundaries.",
    input: ["startup_handoff_package"],
    output: ["alignment_confirmations"],
    allowed_action_modules: ["acknowledge_or_decline", "submit_artifact", "ask_question", "answer_question", "escalate_blocker", "close_or_handoff"],
    notes: [
      "Each non-manager agent should publish its own alignment response in visible text.",
      "Manager closes step1 after enough alignment evidence exists; manager should not micromanage every reply.",
    ],
    next_stage: "step2",
  }),
  stageSpec({
    stage_id: "step2",
    owner: "non_manager_readiness_under_manager_closure",
    goal: "Let every non-manager agent confirm readiness or publish a concrete blocker before formal start.",
    input: ["startup_handoff_package", "alignment_confirmations"],
    output: ["readiness_confirmations"],
    allowed_action_modules: ["acknowledge_or_decline", "submit_artifact", "ask_question", "answer_question", "escalate_blocker", "close_or_handoff"],
    notes: [
      "Readiness replies must stay visible and concrete.",
      "Manager closes step2 after readiness or blocker evidence is present for all required non-manager roles.",
    ],
    next_stage: "formal_start",
  }),
  stageSpec({
    stage_id: "formal_start",
    owner: "manager",
    goal: "Close bootstrap and hand the group into the business workflow.",
    input: ["alignment_confirmations", "readiness_confirmations"],
    output: ["bootstrap_handoff_record"],
    allowed_action_modules: ["close_or_handoff"],
    notes: [
      "formal_start is the authoritative handoff from bootstrap into cycle.start.",
    ],
    next_stage: "cycle.start",
  }),
  stageSpec({
    stage_id: "cycle.start",
    owner: "manager",
    goal: "Define the cycle task plan, acceptance focus, and dispatch targets for the current cycle.",
    input: ["task_goal_prompt", "previous_cycle_context_when_available"],
    output: ["cycle_task_plan"],
    allowed_action_modules: ["submit_artifact", "assign_task", "request_decision", "close_or_handoff"],
    notes: [
      "Manager must publish the cycle task plan in visible text plus structured artifact support.",
      "Manager should dispatch only the roles that need to act in material.collect.",
    ],
    next_stage: "material.collect",
  }),
  stageSpec({
    stage_id: "material.collect",
    owner: "tester",
    organizer_role: "tester",
    primary_consumer_role: "tester",
    observe_only_roles: ["editor"],
    goal: "Collect real materials and complete the first-pass tester review loop inside one tester-led stage.",
    input: ["cycle_task_plan"],
    output: ["candidate_material_pool"],
    allowed_action_modules: [
      "assign_task",
      "submit_artifact",
      "review_artifact",
      "request_rework",
      "resubmit_artifact",
      "ask_question",
      "answer_question",
      "escalate_blocker",
      "request_decision",
      "close_or_handoff",
    ],
    notes: [
      "Tester is the in-stage organizer, first consumer, and reviewer.",
      "Manager is responsible for stage open, final proceed or forced_proceed, and stall or blocker intervention, but is not the default in-stage organizer.",
      "Workers submit materials directly to tester in visible text and may resubmit directly to tester after review.",
      "Editor is observe-only unless explicitly re-activated for a blocker or dependency question.",
      "This stage combines collection and tester review; do not split it into a separate material.review branch.",
      "The stage-close artifact should represent the tester-reviewed material state, not an unreviewed raw pool.",
    ],
    next_stage: "draft.compose",
  }),
  stageSpec({
    stage_id: "draft.compose",
    owner: "editor",
    observe_only_roles: ["worker_a", "worker_b", "tester"],
    goal: "Compose the product draft from the tester-reviewed material state.",
    input: ["candidate_material_pool_from_material_collect_after_tester_review"],
    output: ["product_draft"],
    allowed_action_modules: ["submit_artifact", "ask_question", "answer_question", "escalate_blocker", "request_decision", "close_or_handoff"],
    notes: [
      "Editor is the only default producer in this stage.",
      "The input must be the tester-reviewed material state from material.collect, not a separate material.review artifact lane.",
    ],
    next_stage: "draft.proofread",
  }),
  stageSpec({
    stage_id: "draft.proofread",
    owner: "tester",
    primary_consumer_role: "editor",
    goal: "Proofread the draft against the tester-reviewed material state and current output requirements.",
    input: ["product_draft"],
    output: ["proofread_feedback"],
    allowed_action_modules: ["review_artifact", "request_rework", "ask_question", "answer_question", "escalate_blocker", "request_decision", "close_or_handoff"],
    notes: [
      "Tester reviews the draft as a product artifact and sends concrete findings to editor.",
      "Manager consumes the tester result for stage closure, not as the first proofreader.",
    ],
    next_stage: "draft.revise",
  }),
  stageSpec({
    stage_id: "draft.revise",
    owner: "editor",
    goal: "Revise the draft based on the current proofread findings without reopening material collection.",
    input: ["proofread_feedback"],
    output: ["revised_product_draft"],
    allowed_action_modules: ["resubmit_artifact", "submit_artifact", "ask_question", "answer_question", "escalate_blocker", "request_decision", "close_or_handoff"],
    notes: [
      "Editor stays in the draft lane and should not backtrack into material.collect unless manager explicitly changes stage authority.",
    ],
    next_stage: "draft.recheck",
  }),
  stageSpec({
    stage_id: "draft.recheck",
    owner: "tester",
    primary_consumer_role: "editor",
    goal: "Recheck the revised draft and either clear it for publish decision or send one more targeted correction.",
    input: ["revised_product_draft"],
    output: ["recheck_feedback"],
    allowed_action_modules: ["review_artifact", "request_rework", "ask_question", "answer_question", "escalate_blocker", "request_decision", "close_or_handoff"],
    notes: [
      "Tester stays focused on the revised draft under review rather than reopening earlier workflow branches.",
    ],
    next_stage: "publish.decision",
  }),
  stageSpec({
    stage_id: "publish.decision",
    owner: "manager",
    goal: "Decide whether to release or forced-proceed the current draft.",
    input: ["recheck_feedback", "current_risk_record_when_available"],
    output: ["publish_decision"],
    allowed_action_modules: ["submit_artifact", "request_decision", "close_or_handoff"],
    notes: [
      "Manager is the decision owner for release vs forced_proceed.",
    ],
    next_stage: "report.publish",
  }),
  stageSpec({
    stage_id: "report.publish",
    owner: "editor",
    goal: "Publish the final product message for the current cycle.",
    input: ["publish_decision"],
    output: ["final_product_message"],
    allowed_action_modules: ["submit_artifact", "close_or_handoff"],
    notes: [
      "Editor publishes one complete final product message.",
      "Manager closes the stage after the final product message is visible in the group.",
    ],
    next_stage: "product.test",
  }),
  stageSpec({
    stage_id: "product.test",
    owner: "tester",
    goal: "Evaluate the published product from a user-view perspective.",
    input: ["final_product_message"],
    output: ["product_test_report"],
    allowed_action_modules: ["submit_artifact", "ask_question", "answer_question", "escalate_blocker", "request_decision", "close_or_handoff"],
    notes: [
      "This stage evaluates the published product and does not reopen draft editing.",
    ],
    next_stage: "product.benchmark",
  }),
  stageSpec({
    stage_id: "product.benchmark",
    owner: "tester",
    goal: "Compare the published product against external comparable products using live search.",
    input: ["final_product_message"],
    output: ["benchmark_report"],
    allowed_action_modules: ["submit_artifact", "ask_question", "answer_question", "escalate_blocker", "request_decision", "close_or_handoff"],
    notes: [
      "Benchmark evidence must remain grounded in real external references.",
    ],
    next_stage: "product.cross_cycle_compare",
  }),
  stageSpec({
    stage_id: "product.cross_cycle_compare",
    owner: "tester",
    goal: "Compare the published product with the previous cycle when a prior cycle exists.",
    input: ["final_product_message", "previous_cycle_artifacts_when_available"],
    output: ["cross_cycle_report"],
    allowed_action_modules: ["submit_artifact", "ask_question", "answer_question", "escalate_blocker", "request_decision", "close_or_handoff"],
    notes: [
      "Cycle 1 may explicitly report that no historical comparison target exists.",
    ],
    next_stage: "product.report",
  }),
  stageSpec({
    stage_id: "product.report",
    owner: "manager",
    goal: "Synthesize the product evaluation evidence into one formal product report.",
    input: ["product_test_report", "benchmark_report", "cross_cycle_report"],
    output: ["product_evaluation_report"],
    allowed_action_modules: ["submit_artifact", "request_decision", "close_or_handoff"],
    notes: [
      "Manager must synthesize real evaluation evidence rather than emit a generic summary.",
    ],
    next_stage: "retrospective.plan",
  }),
  stageSpec({
    stage_id: "retrospective.plan",
    owner: "manager",
    goal: "Turn the current cycle evidence into a retrospective discussion agenda.",
    input: ["product_evaluation_report", "execution_evidence"],
    output: ["retrospective_plan"],
    allowed_action_modules: ["submit_artifact", "close_or_handoff"],
    notes: [
      "This is the current live-validation stop stage; do not advance into retrospective.discussion during the target run.",
    ],
    next_stage: "retrospective.discussion",
    stop_after_reaching: true,
  }),
  stageSpec({
    stage_id: "retrospective.discussion",
    owner: "manager",
    goal: "Moderate the retrospective discussion once the retrospective plan is approved.",
    input: ["retrospective_plan"],
    output: ["discussion_record"],
    allowed_action_modules: ["assign_task", "ask_question", "answer_question", "submit_artifact", "close_or_handoff"],
    notes: [
      "This stage is outside the current live-validation target.",
    ],
    next_stage: null,
  }),
]);

export const NEWSFLOW_STAGE_ORDER = Object.freeze(STAGE_SPECS.map((stage) => stage.stage_id));

function workflowStageMap() {
  return Object.fromEntries(
    STAGE_SPECS.map((stage) => [
      stage.stage_id,
      {
        owner: stage.owner,
        organizer_role: stage.organizer_role,
        primary_consumer_role: stage.primary_consumer_role,
        observe_only_roles: [...stage.observe_only_roles],
        goal: stage.goal,
        input: [...stage.input],
        output: [...stage.output],
        notes: [...stage.notes],
        allowed_action_modules: [...stage.allowed_action_modules],
      },
    ]),
  );
}

function executionStageMap(roleAgentIds) {
  const managerAgentId = trimString(roleAgentIds?.manager);
  const editorAgentId = trimString(roleAgentIds?.editor);
  const testerAgentId = trimString(roleAgentIds?.tester);
  const workerAAgentId = trimString(roleAgentIds?.worker_a);
  const workerBAgentId = trimString(roleAgentIds?.worker_b);
  return {
    step0: {
      stage_id: "step0",
      semantic_description: "Manager publishes the startup surface and hands off the alignment task.",
      allowed_roles: ["manager"],
      accepted_status_blocks: [
        {
          gate_id: "manager_start",
          lifecycle_phase: "start",
          step_statuses: ["step0_start"],
          allowed_roles: ["manager"],
        },
        {
          gate_id: "manager_done",
          lifecycle_phase: "done",
          step_statuses: ["step0_done"],
          allowed_roles: ["manager"],
        },
      ],
      completion_condition: {
        all_of: [
          {
            gate_id: "manager_done",
            min_count: 1,
            required_agent_ids: [managerAgentId],
          },
        ],
      },
      next_stage: "step1",
      allowed_action_modules: [...STAGE_SPECS[0].allowed_action_modules],
    },
    step1: {
      stage_id: "step1",
      semantic_description: "Non-manager roles publish alignment evidence and manager closes bootstrap alignment.",
      allowed_roles: ["manager", "editor", "tester", "worker_a", "worker_b"],
      accepted_status_blocks: [
        {
          gate_id: "manager_start",
          lifecycle_phase: "start",
          step_statuses: ["step1_start"],
          allowed_roles: ["manager"],
        },
        {
          gate_id: "worker_run",
          lifecycle_phase: "run",
          step_statuses: ["step1_submitted", "step1_adjusted"],
          allowed_roles: ["worker"],
        },
        {
          gate_id: "manager_done",
          lifecycle_phase: "done",
          step_statuses: ["step1_done"],
          allowed_roles: ["manager"],
        },
      ],
      completion_condition: {
        all_of: [
          {
            gate_id: "manager_start",
            min_count: 1,
            required_agent_ids: [managerAgentId],
          },
          {
            gate_id: "worker_run",
            min_count: 4,
            required_agent_ids: [
              editorAgentId,
              testerAgentId,
              workerAAgentId,
              workerBAgentId,
            ],
          },
          {
            gate_id: "manager_done",
            min_count: 1,
            required_agent_ids: [managerAgentId],
          },
        ],
      },
      next_stage: "step2",
      allowed_action_modules: [...STAGE_SPECS[1].allowed_action_modules],
    },
    step2: {
      stage_id: "step2",
      semantic_description: "Non-manager roles publish readiness evidence or blockers and manager closes bootstrap readiness.",
      allowed_roles: ["manager", "editor", "tester", "worker_a", "worker_b"],
      accepted_status_blocks: [
        {
          gate_id: "manager_start",
          lifecycle_phase: "start",
          step_statuses: ["step2_start"],
          allowed_roles: ["manager"],
        },
        {
          gate_id: "worker_run",
          lifecycle_phase: "run",
          step_statuses: ["step2_submitted", "step2_adjusted", "step2_ready", "task_ready"],
          allowed_roles: ["worker"],
        },
        {
          gate_id: "manager_done",
          lifecycle_phase: "done",
          step_statuses: ["step2_done"],
          allowed_roles: ["manager"],
        },
      ],
      completion_condition: {
        all_of: [
          {
            gate_id: "manager_start",
            min_count: 1,
            required_agent_ids: [managerAgentId],
          },
          {
            gate_id: "worker_run",
            min_count: 4,
            required_agent_ids: [
              editorAgentId,
              testerAgentId,
              workerAAgentId,
              workerBAgentId,
            ],
          },
          {
            gate_id: "manager_done",
            min_count: 1,
            required_agent_ids: [managerAgentId],
          },
        ],
      },
      next_stage: "formal_start",
      allowed_action_modules: [...STAGE_SPECS[2].allowed_action_modules],
    },
    formal_start: {
      stage_id: "formal_start",
      semantic_description: "Manager formally closes bootstrap and hands the group into cycle.start.",
      allowed_roles: ["manager"],
      accepted_status_blocks: [
        {
          gate_id: "manager_formal_start",
          lifecycle_phase: "start",
          step_statuses: ["formal_start"],
          allowed_roles: ["manager"],
        },
      ],
      completion_condition: {
        all_of: [
          {
            gate_id: "manager_formal_start",
            min_count: 1,
            required_agent_ids: [managerAgentId],
          },
        ],
      },
      next_stage: "cycle.start",
      allowed_action_modules: [...STAGE_SPECS[3].allowed_action_modules],
    },
    "cycle.start": {
      ...managerCloseStage(
        "cycle.start",
        "material.collect",
        "Manager publishes the cycle task plan, dispatches the collect-stage roles, and closes the stage.",
        ["manager"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[4].allowed_action_modules],
    },
    "material.collect": {
      ...managerCloseStage(
        "material.collect",
        "draft.compose",
        "Manager opens the tester-led collect stage, waits for tester-led review closure, and then closes the stage.",
        ["manager", "tester", "worker_a", "worker_b"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[5].allowed_action_modules],
      primary_reviewer_role: "tester",
      organizer_role: "tester",
    },
    "draft.compose": {
      ...managerCloseStage(
        "draft.compose",
        "draft.proofread",
        "Editor composes the product draft from the tester-reviewed material state and manager closes the stage.",
        ["manager", "editor"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[6].allowed_action_modules],
    },
    "draft.proofread": {
      ...managerCloseStage(
        "draft.proofread",
        "draft.revise",
        "Tester reviews the current draft and manager closes the proofread stage.",
        ["manager", "tester"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[7].allowed_action_modules],
    },
    "draft.revise": {
      ...managerCloseStage(
        "draft.revise",
        "draft.recheck",
        "Editor revises the draft inside the draft lane and manager closes the stage.",
        ["manager", "editor"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[8].allowed_action_modules],
    },
    "draft.recheck": {
      ...managerCloseStage(
        "draft.recheck",
        "publish.decision",
        "Tester rechecks the revised draft and manager closes the stage.",
        ["manager", "tester"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[9].allowed_action_modules],
    },
    "publish.decision": {
      ...managerCloseStage(
        "publish.decision",
        "report.publish",
        "Manager decides release or forced_proceed and closes the publish-decision stage.",
        ["manager"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[10].allowed_action_modules],
    },
    "report.publish": {
      ...managerCloseStage(
        "report.publish",
        "product.test",
        "Editor publishes the final product message and manager closes the publish stage.",
        ["manager", "editor"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[11].allowed_action_modules],
    },
    "product.test": {
      ...managerCloseStage(
        "product.test",
        "product.benchmark",
        "Tester publishes the product test report and manager closes the stage.",
        ["manager", "tester"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[12].allowed_action_modules],
    },
    "product.benchmark": {
      ...managerCloseStage(
        "product.benchmark",
        "product.cross_cycle_compare",
        "Tester publishes benchmark evidence and manager closes the stage.",
        ["manager", "tester"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[13].allowed_action_modules],
    },
    "product.cross_cycle_compare": {
      ...managerCloseStage(
        "product.cross_cycle_compare",
        "product.report",
        "Tester publishes the cross-cycle comparison evidence and manager closes the stage.",
        ["manager", "tester"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[14].allowed_action_modules],
    },
    "product.report": {
      ...managerCloseStage(
        "product.report",
        "retrospective.plan",
        "Manager publishes the formal product evaluation report and closes the stage.",
        ["manager"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[15].allowed_action_modules],
    },
    "retrospective.plan": {
      ...managerCloseStage(
        "retrospective.plan",
        "retrospective.discussion",
        "Manager publishes the retrospective agenda and closes the plan stage.",
        ["manager"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[16].allowed_action_modules],
      stop_after_reaching: true,
    },
    "retrospective.discussion": {
      ...managerCloseStage(
        "retrospective.discussion",
        null,
        "Manager moderates the retrospective discussion after the current live-validation stop point.",
        ["manager"],
        managerAgentId,
      ),
      allowed_action_modules: [...STAGE_SPECS[17].allowed_action_modules],
    },
  };
}

export function buildNewsflowWorkflowSpec() {
  return {
    workflow_id: NEWSFLOW_WORKFLOW_ID,
    stage_order: [...NEWSFLOW_STAGE_ORDER],
    stop_stage: NEWSFLOW_STOP_STAGE,
    stages: STAGE_SPECS.map((stage) => ({
      stage_id: stage.stage_id,
      owner: stage.owner,
      organizer_role: stage.organizer_role,
      primary_consumer_role: stage.primary_consumer_role,
      expected_action_ids: [...stage.allowed_action_modules],
      next_stage: stage.next_stage,
      terminal: Boolean(stage.stop_after_reaching),
    })),
  };
}

export function buildBoundNewsflowGroupProtocol(roleAgentIds) {
  const managerAgentId = trimString(roleAgentIds?.manager);
  const editorAgentId = trimString(roleAgentIds?.editor);
  const testerAgentId = trimString(roleAgentIds?.tester);
  const workerAAgentId = trimString(roleAgentIds?.worker_a);
  const workerBAgentId = trimString(roleAgentIds?.worker_b);
  if (!managerAgentId || !editorAgentId || !testerAgentId || !workerAAgentId || !workerBAgentId) {
    throw new Error("all five role agent ids are required to bind the newsflow protocol");
  }
  return {
    protocol_meta: {
      protocol_id: "newsflow-group-protocol-action-composed-v1",
      protocol_name: "Newsflow Group Protocol Action-Composed V1",
      protocol_version: "0.2.0",
      status: "debug_live_validation",
      source_of_truth: "group_protocol",
      design_priority: "workflow_through_reusable_action_modules",
    },
    channel: {
      channel_type: "project",
    },
    members: {
      all_agent_ids: [managerAgentId, editorAgentId, testerAgentId, workerAAgentId, workerBAgentId],
      manager_agent_id: managerAgentId,
      worker_agent_ids: [editorAgentId, testerAgentId, workerAAgentId, workerBAgentId],
      role_rules: {
        manager_holds_decision_authority_for_step_transition: true,
        manager_has_formal_close_duty_for_every_stage: true,
        tester_may_issue_intra_stage_review_actions_directly_to_current_stage_producers: true,
        current_stage_direct_review_loop_is_allowed: true,
        cross_stage_control_must_route_via_manager: true,
      },
      role_assignments: {
        manager: {
          agent_id: managerAgentId,
          server_gate_role: "manager",
          responsibility: "publish startup and cycle plans, handle stage transitions, and synthesize the final product report",
        },
        editor: {
          agent_id: editorAgentId,
          server_gate_role: "worker",
          responsibility: "compose and publish the final news product from tester-reviewed material state",
        },
        tester: {
          agent_id: testerAgentId,
          server_gate_role: "worker",
          responsibility: "lead material.collect as reviewer, proofread drafts, and produce product evaluation evidence",
        },
        worker_a: {
          agent_id: workerAAgentId,
          server_gate_role: "worker",
          responsibility: "collect politics-economy and technology materials and respond directly to tester review in material.collect",
        },
        worker_b: {
          agent_id: workerBAgentId,
          server_gate_role: "worker",
          responsibility: "collect sports and entertainment materials and respond directly to tester review in material.collect",
        },
      },
    },
    group_identity: {
      group_type: "project",
      workflow_mode: "newsflow_action_composed_live",
      group_objective: "Run one newsflow cycle through startup, content production, product evaluation, and retrospective planning by composing reusable action modules.",
    },
    workflow: {
      formal_workflow: {
        workflow_id: NEWSFLOW_WORKFLOW_ID,
        goal: "Complete startup, content production, publication, product evaluation, and retrospective planning through action-composed group collaboration.",
        product_contract: {
          language: "zh-CN",
          sections: ["politics_economy", "technology", "sports", "entertainment"],
          target_items_per_section: 10,
          main_push_requirement: "3 images + about 200 Chinese characters",
          secondary_push_requirement: "1 image + about 100 Chinese characters",
          general_push_requirement: "about 50 Chinese characters without basic metadata clutter",
          final_delivery_shape: "one final product message in the group plus a product evaluation report",
        },
        allowed_action_modules: listActionModules().map((item) => item.action_id),
        stages: workflowStageMap(),
      },
    },
    execution_spec: {
      execution_spec_id: NEWSFLOW_EXECUTION_SPEC_ID,
      workflow_id: NEWSFLOW_WORKFLOW_ID,
      initial_stage: NEWSFLOW_STAGE_ORDER[0],
      stage_order: [...NEWSFLOW_STAGE_ORDER],
      role_directory: {
        manager_agent_ids: [managerAgentId],
        worker_agent_ids: [editorAgentId, testerAgentId, workerAAgentId, workerBAgentId],
      },
      stages: executionStageMap(roleAgentIds),
    },
    group_session_seed: {
      workflow_id: NEWSFLOW_WORKFLOW_ID,
      current_mode: "bootstrap",
      current_stage: NEWSFLOW_STAGE_ORDER[0],
      gate_snapshot: {
        current_stage: NEWSFLOW_STAGE_ORDER[0],
      },
    },
  };
}
