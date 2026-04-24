import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const harness = await import(
  pathToFileURL(path.join(__dirname, "..", "scripts", "workflow_live", "newsflow_harness.mjs")).href + `?t=${Date.now()}`
);

test("summarizeStageWindow reports delta action ids and unexpected action ids", () => {
  const summary = harness.summarizeStageWindow(
    {
      stage_id: "material.collect",
      expected_action_ids: ["submit_artifact", "review_artifact", "request_rework", "resubmit_artifact", "close_or_handoff"],
    },
    [
      {
        id: "msg-before",
        content: { payload: { action_id: "submit_artifact" } },
      },
    ],
    [
      {
        id: "msg-before",
        content: { payload: { action_id: "submit_artifact" } },
      },
      {
        id: "msg-1",
        author: { agent_id: "worker-a-1" },
        flow_type: "run",
        message_type: "analysis",
        content: { text: "submit batch", payload: { action_id: "submit_artifact" } },
        status_block: { step_id: "material.collect", author_role: "worker_a" },
      },
      {
        id: "msg-2",
        author: { agent_id: "tester-1" },
        flow_type: "run",
        message_type: "review",
        content: { text: "needs fixes", payload: { action_id: "request_rework" } },
        status_block: { step_id: "material.collect", author_role: "tester" },
      },
      {
        id: "msg-3",
        author: { agent_id: "manager-1" },
        flow_type: "result",
        message_type: "summary",
        content: { text: "closed", payload: { action_id: "close_or_handoff" } },
        status_block: {
          step_id: "material.collect",
          step_status: "manager_material_collect_closed",
          author_role: "manager",
        },
      },
      {
        id: "msg-4",
        author: { agent_id: "mystery-1" },
        flow_type: "run",
        message_type: "analysis",
        content: { text: "wrong action", payload: { action_id: "invented_action" } },
        status_block: { step_id: "material.collect", author_role: "worker" },
      },
    ],
  );

  assert.equal(summary.stage_id, "material.collect");
  assert.equal(summary.message_count_delta, 4);
  assert.deepEqual(summary.observed_action_ids, ["submit_artifact", "request_rework", "close_or_handoff", "invented_action"]);
  assert.deepEqual(summary.unexpected_action_ids, ["invented_action"]);
  assert.deepEqual(summary.formal_close_message_ids, ["msg-3"]);
});

test("resolveHarnessStartIndex starts from the initial session stage when bootstrap already advanced", () => {
  const stageOrder = ["step0", "step1", "step2", "formal_start", "cycle.start"];
  const startIndex = harness.resolveHarnessStartIndex(stageOrder, {
    session: {
      data: {
        current_stage: "step1",
      },
    },
  });

  assert.equal(startIndex, 1);
});

test("resolveHarnessStartIndex falls back to the first stage when the initial stage is unknown", () => {
  const stageOrder = ["step0", "step1", "step2"];
  const startIndex = harness.resolveHarnessStartIndex(stageOrder, {
    session: {
      data: {
        current_stage: "unknown-stage",
      },
    },
  });

  assert.equal(startIndex, 0);
});

test("waitForSessionStage polls session until the target stage then captures one full snapshot", async () => {
  const originalFetch = global.fetch;
  const counts = {
    session: 0,
    protocol: 0,
    context: 0,
    events: 0,
    messages: 0,
  };
  let pollCount = 0;

  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/groups/group-1/session")) {
      counts.session += 1;
      pollCount += 1;
      const currentStage = pollCount >= 2 ? "step2" : "step1";
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { current_stage: currentStage, state_json: {} } });
        },
      };
    }
    if (value.includes("/groups/group-1/protocol")) {
      counts.protocol += 1;
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { protocol: { id: "protocol-1" } } });
        },
      };
    }
    if (value.includes("/groups/group-1/context")) {
      counts.context += 1;
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { group: { slug: "group-1" } } });
        },
      };
    }
    if (value.includes("/groups/group-1/events")) {
      counts.events += 1;
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: [] });
        },
      };
    }
    if (value.includes("/messages?group_id=group-1")) {
      counts.messages += 1;
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: [] });
        },
      };
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const result = await harness.waitForSessionStage("http://example.test/api/v1", "group-1", "token-1", "step2", 100, 0);
    assert.equal(result.reached, true);
    assert.equal(result.snapshot?.session?.data?.current_stage, "step2");
    assert.equal(counts.session, 3);
    assert.equal(counts.protocol, 1);
    assert.equal(counts.context, 1);
    assert.equal(counts.events, 1);
    assert.equal(counts.messages, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("waitForSessionStage tolerates partial full snapshot failures after the stage is reached", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { current_stage: "step2", state_json: {} } });
        },
      };
    }
    if (
      value.includes("/groups/group-1/protocol") ||
      value.includes("/groups/group-1/context") ||
      value.includes("/groups/group-1/events") ||
      value.includes("/messages?group_id=group-1")
    ) {
      throw new Error("temporary upstream timeout");
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const result = await harness.waitForSessionStage("http://example.test/api/v1", "group-1", "token-1", "step2", 100, 0);
    assert.equal(result.reached, true);
    assert.equal(result.snapshot?.session?.data?.current_stage, "step2");
    assert.deepEqual(result.snapshot?.messages, []);
    assert.deepEqual(result.snapshot?.partial_failures?.sort(), ["context", "events", "messages", "protocol"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("waitForSessionStage treats later workflow stages as reached when the session fast-forwards beyond the expected stage", async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const value = String(url);
    if (value.includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { current_stage: "publish.decision", state_json: {} } });
        },
      };
    }
    if (value.includes("/groups/group-1/protocol")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { protocol: { id: "protocol-1" } } });
        },
      };
    }
    if (value.includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { group: { slug: "group-1" } } });
        },
      };
    }
    if (value.includes("/groups/group-1/events")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: [] });
        },
      };
    }
    if (value.includes("/messages?group_id=group-1")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: [] });
        },
      };
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const stageOrder = ["formal_start", "cycle.start", "material.collect", "draft.compose", "publish.decision"];
    const result = await harness.waitForSessionStage(
      "http://example.test/api/v1",
      "group-1",
      "token-1",
      "cycle.start",
      100,
      0,
      stageOrder,
    );
    assert.equal(result.reached, true);
    assert.equal(result.snapshot?.session?.data?.current_stage, "publish.decision");
  } finally {
    global.fetch = originalFetch;
  }
});

test("createProjectGroup recovers the created group by slug when the create response times out", async () => {
  const originalFetch = global.fetch;
  let createAttempted = false;

  global.fetch = async (url) => {
    const value = String(url);
    if (value.endsWith("/groups")) {
      createAttempted = true;
      throw new Error("The operation was aborted due to timeout");
    }
    if (value.includes("/groups/by-slug/slug-1/join")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                id: "group-1",
                slug: "slug-1",
                group_type: "project",
              },
            },
          });
        },
      };
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const group = await harness.createProjectGroup(
      "http://example.test/api/v1",
      { token: "token-1" },
      "slug-1",
      "Recovered Group",
      "Recovered after timeout",
    );

    assert.equal(createAttempted, true);
    assert.equal(group.id, "group-1");
    assert.equal(group.slug, "slug-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("setupProjectGroupWithProtocol creates with admin auth, patches the target protocol, then joins all roles", async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const roles = {
    manager: { agent_id: "manager-1", token: "manager-token" },
    editor: { agent_id: "editor-1", token: "editor-token" },
    tester: { agent_id: "tester-1", token: "tester-token" },
    worker_a: { agent_id: "worker-a-1", token: "worker-a-token" },
    worker_b: { agent_id: "worker-b-1", token: "worker-b-token" },
  };
  const boundProtocol = { protocol_meta: { protocol_id: "protocol-1" } };

  global.fetch = async (url, options = {}) => {
    const value = String(url);
    calls.push({
      url: value,
      method: options.method || "GET",
      body: options.body ? JSON.parse(options.body) : null,
      authz: options.headers?.Authorization || null,
      token: options.headers?.["X-Agent-Token"] || null,
    });
    if (value.endsWith("/groups")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { id: "group-1", slug: "slug-1", group_type: "project" } });
        },
      };
    }
    if (value.includes("/groups/group-1/join")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { ok: true } });
        },
      };
    }
    if (value.includes("/groups/group-1/protocol") && (options.method || "GET") === "PATCH") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { ok: true } });
        },
      };
    }
    if (value.includes("/groups/group-1/protocol") && (options.method || "GET") === "GET") {
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            success: true,
            data: {
              group: {
                id: "group-1",
                metadata_json: {
                  community_v2: {
                    group_protocol: boundProtocol,
                  },
                },
              },
            },
          });
        },
      };
    }
    if (value.includes("/groups/group-1/context")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { group_protocol: boundProtocol } });
        },
      };
    }
    if (value.includes("/groups/group-1/session")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: { current_stage: "step0", state_json: {} } });
        },
      };
    }
    if (value.includes("/groups/group-1/events")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: [] });
        },
      };
    }
    if (value.includes("/messages?group_id=group-1")) {
      return {
        ok: true,
        async text() {
          return JSON.stringify({ success: true, data: [] });
        },
      };
    }
    throw new Error(`unexpected fetch: ${value}`);
  };

  try {
    const result = await harness.setupProjectGroupWithProtocol({
      baseUrl: "http://example.test/api/v1",
      roles,
      adminBearer: "admin-token",
      boundProtocol,
      label: "test-run",
      runRoot: "/tmp/test-run",
      groupSlug: "slug-1",
      groupMetadata: { purpose: "test" },
    });

    assert.equal(result.group_id, "group-1");
    assert.equal(result.slug, "slug-1");
    assert.equal(result.created_group.id, "group-1");
    assert.equal(result.setup_identity.group_id, "group-1");
    assert.equal(result.effective_snapshot.session.data.current_stage, "step0");
    assert.deepEqual(Object.keys(result.join_results).sort(), ["editor", "manager", "tester", "worker_a", "worker_b"]);

    assert.equal(calls[0].url, "http://example.test/api/v1/groups");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].authz, "Bearer admin-token");
    assert.deepEqual(calls[0].body.metadata_json, { purpose: "test" });
    assert.equal(calls[1].url, "http://example.test/api/v1/groups/group-1/protocol");
    assert.equal(calls[1].method, "PATCH");
    assert.deepEqual(calls[1].body, { group_protocol: boundProtocol });
    assert.equal(calls[2].url, "http://example.test/api/v1/groups/group-1/join");
    assert.equal(calls[3].url, "http://example.test/api/v1/groups/group-1/join");
    assert.equal(calls[4].url, "http://example.test/api/v1/groups/group-1/join");
    assert.equal(calls[5].url, "http://example.test/api/v1/groups/group-1/join");
    assert.equal(calls[6].url, "http://example.test/api/v1/groups/group-1/join");
  } finally {
    global.fetch = originalFetch;
  }
});
