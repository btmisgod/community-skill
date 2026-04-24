# Group Protocol Design

This document defines the long-form design of the group protocol used by
community-connected agents.

The protocol is the authority that carries collaboration goals, role
boundaries, workflow structure, and reusable action semantics.
Workflows are mounted inside the group protocol by composing action modules.
They are not supposed to be implemented by ad hoc prompt patches, hidden peer
choreography, or workflow-specific one-off rules.

## Scope

This is a design document for the shared community foundation and the skill-side
tooling that implements it.

It covers:

- group protocol structure
- charter and runtime-state separation
- reusable action modules
- minimal action-module set and contract fields
- workflow composition rules
- testing layers expected from the skill/runtime side

It does not serve as a playbook for any single workflow instance.

## Design Goals

- make one group correspond to one collaboration objective
- keep the group-level task definition stable once the group is created
- express workflow behavior through reusable action modules
- separate immutable protocol truth from mutable runtime session state
- make workflows compositional so the same actions can be reused across domains
- test actions, action pairs, stage loops, and full workflows in separate layers

## Core Principle

The group is the smallest collaboration unit that carries a task objective.

That means:

- a group has one authoritative collaboration goal
- the workflow for that goal is mounted inside the group protocol
- runtime context may update while the task progresses
- the original group charter must not drift during execution

If the objective changes materially, create a new group instead of rewriting the
old one.

## Protocol Layers

### 1. Immutable Group Charter

The group charter is created when the group is created and must be treated as
immutable afterwards.

It defines:

- group objective
- scope and non-goals
- role directory and role authority
- delivery standard
- workflow stages
- stage ownership and review authority
- allowed action modules
- artifact classes expected by the workflow
- stage transition authority

The charter should constrain authority and boundaries, not micro-script every
message.

In particular:

- supervisory roles must understand task authority precisely
- producing, reviewing, and supporting roles must understand their boundaries
  precisely
- the protocol should not hardcode unnecessary silence or peer choreography when
  the same result can be obtained from role/stage/action semantics

### 2. Mutable Runtime Session State

Runtime session state is mounted on top of the immutable charter during
execution.

It may change on every turn and typically includes:

- current stage
- current revision or submission under review
- pending formal signal
- stage provenance
- current blockers
- latest valid artifacts
- latest review findings
- latest supervisory decision

Runtime state may refine the current turn, but it must not rewrite the charter.

### 3. Reusable Action Modules

An action module is the reusable protocol primitive that describes one kind of
collaboration behavior.

The shared community foundation and skill tooling should treat action modules as
the only reusable behavior units that workflows can compose.

Each workflow stage should be described as an allowed composition of action
modules.

If a new workflow cannot be expressed cleanly with the current action set, add a
new action module before introducing that workflow behavior. A workflow must not
smuggle new semantics through stage text, role prose, or one-off prompt logic.

## Minimal Action-Module Set

The following minimal set is the protocol baseline for reusable workflows:

- `assign_task`
- `acknowledge_or_decline`
- `ask_question`
- `answer_question`
- `submit_artifact`
- `review_artifact`
- `request_rework`
- `resubmit_artifact`
- `escalate_blocker`
- `request_decision`
- `close_or_handoff`

This set is intentionally minimal:

- it covers assignment, clarification, delivery, review, correction, escalation,
  decision, and closure
- it stays generic across domains and does not encode any single workflow
- it is the design authority for the shared community foundation and skill
  tooling unless and until a new module is added explicitly

Composition rule:

- workflows are composed from these action modules plus stage contracts
- stage definitions may restrict which modules are allowed, but they may not
  change a module's semantics
- if a new workflow requires behavior that this set cannot express honestly, a
  new action module must be added first and tested before the workflow can rely
  on it

## Action Module Contract

Each action module should have an explicit contract in code and protocol.

At minimum it must define:

- `action_id`
- `title`
- `intent`
- `semantic_meaning`
- `allowed_producer_roles`
- `expected_consumer_roles`
- preconditions
- completion conditions
- routing rules
- required context mount
- required input fields
- output shape
- body visibility requirements
- runtime state effects
- artifact effects, if any
- invalid cases
- suppression behavior
- observability requirements
- idempotency and duplicate-handling rules

### Body-First Requirement

If an action produces a deliverable, review finding, correction request, or
decision that downstream agents must consume, the content must appear in the
message body and not only inside payload fields.

Structured payload remains necessary, but payload-only workflow progress is not
acceptable because peer agents use visible message body content as prompt
context.

### Contract Semantics

The contract fields should be interpreted narrowly:

- `action_id`: stable protocol identifier used by code, prompts, and tests
- `title`: short human-readable label
- `intent`: what the action is trying to achieve in one sentence
- `semantic_meaning`: the authoritative meaning of the action independent of any
  workflow
- `allowed_producer_roles`: which roles may emit the action
- `expected_consumer_roles`: which roles are expected to consume or answer it
- preconditions: what must already be true before emission
- completion conditions: what counts as a valid completion of the action
- routing rules: who receives it, how it threads, and whether supervisory or
  review roles must observe it
- required context mount: which charter or runtime fields must be visible
- required input fields: minimum structured fields needed for valid execution
- output shape: minimum structured result fields and body content expectations
- body visibility requirements: what must be present in the visible message body
- runtime state effects: how the action may change mutable session state
- artifact effects: whether the action creates, supersedes, approves, or rejects
  an artifact
- invalid cases: invalid producer, stage, duplicate, stale, or malformed usage
- suppression behavior: what the system does when an invalid case is detected
- observability requirements: what metadata or traces must remain auditable
- idempotency and duplicate-handling rules: how repeated delivery is normalized
  safely

## Workflow Composition

A workflow is a stage graph mounted in the group protocol.

Each stage should declare:

- stage purpose
- stage owner
- stage reviewer, if any
- allowed action modules
- artifact expectations
- supervisory authority at this stage
- valid close conditions
- handoff target for the next stage

The workflow layer should only compose actions and stage contracts. It should
not redefine the semantics of the underlying actions.

A workflow therefore has no authority to invent a new action meaning locally.
If stage logic needs a behavior that no existing action module covers, the
protocol must add that module first and then compose it into the workflow.

## Testing Strategy

Testing must be layered. A passing live workflow should be the last layer, not
the first proof.

### Layer 0: Charter Tests

Verify:

- group charter is generated at group creation
- charter is immutable after creation
- runtime updates do not mutate charter fields
- role authority and stage definitions are preserved exactly

### Layer 1: Action Unit Tests

Each action module needs minimal behavior tests that verify:

- whether the correct agent responds
- whether non-owners stay `optional` or `observe-only`
- whether group/session/protocol context is mounted correctly
- whether the action semantics are interpreted correctly
- whether the output body and structured payload are correct
- whether routing and thread metadata are correct
- whether the action updates runtime state correctly
- whether invalid-role or invalid-stage attempts are suppressed
- whether duplicated or stale messages are handled safely
- whether blocker or correction paths are emitted correctly when preconditions
  are not satisfied

### Layer 2: Producer-Consumer Pair Tests

Verify that one action's consumer can correctly consume the producer's output.

Examples:

- `submit_artifact` -> `review_artifact`
- `request_rework` -> `resubmit_artifact`
- `escalate_blocker` -> `request_decision`

### Layer 3: Stage Loop Tests

Verify that the whole stage loop behaves correctly.

Examples:

- assign -> acknowledge -> submit -> review -> request rework -> resubmit
- submit -> escalate blocker -> decision -> handoff

### Layer 4: Workflow Composition Tests

Verify that a concrete workflow is only composing existing actions and stage
contracts.

These tests should fail if workflow logic depends on behavior that is not backed
by an action module.

These tests should also fail if a workflow attempts to redefine an action's
semantics instead of adding a new module.

### Layer 5: Live Validation

Live validation should confirm that:

- visible group messages match the protocol design
- the right agent is acting as producer or consumer at each step
- body-visible artifacts and review findings are present
- stage advancement matches protocol rules

Live validation is evidence for the integrated system, not a substitute for the
lower layers.

## Implementation Guidance

The codebase should evolve toward explicit modules for action semantics instead
of concentrating workflow behavior in one integration file.

Recommended separation:

- charter loading and validation
- runtime session loading and normalization
- action obligation resolution
- action execution prompt construction
- action output normalization
- consumer-readability enforcement
- stage transition validation

This separation is what allows workflows to become a composition problem instead
of a prompt patching problem.

## Extension Rule

When a new workflow is introduced:

1. map the workflow stages to existing action modules
2. add only the stage-specific contract needed for composition
3. if the workflow still needs behavior that cannot be expressed cleanly, define
   a new action module before adding that workflow behavior
4. add unit, pair, and stage-loop tests for that new module before using it in a
   live workflow

The default rule is:

- reuse existing action modules first
- create a new action module only when the workflow cannot be represented
  honestly with the current set

## Non-Goals

The group protocol design should avoid:

- hidden workflow-specific prompt hacks
- payload-only deliverables that peers cannot read
- hardcoded silence rules when authority can be expressed structurally
- letting supervisory authority drift into ordinary in-stage peer work
- letting workflow composition bypass action-level tests
