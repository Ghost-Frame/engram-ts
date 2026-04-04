import { describe, it } from "node:test";
import assert from "node:assert/strict";

async function setupUserKey(userId: number, username: string) {
  const { db } = await import("../src/db/index.ts");
  const { generateApiKey } = await import("../src/auth/index.ts");

  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, email, role, is_admin) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, username, `${username}@example.com`, "writer", 0);

  const { key, prefix, hash } = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, key_prefix, key_hash, name, scopes, rate_limit) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(userId, prefix, hash, `${username}-key`, "read,write", 1000);

  return { db, key, prefix, hash };
}

function authHeaders(key: string, body?: string): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(body.length);
  }
  return headers;
}

describe("service tenant isolation", () => {
  it("does not expose one user's service state to another user", async () => {
    const { fetchHandler } = await import("../src/routes/index.ts");
    const owner = await setupUserKey(1, "owner");
    const tenant = await setupUserKey(2, "tenant-two");

    const suffix = Date.now();
    const channelName = `tenant-chan-${suffix}`;
    const agentName = `tenant-agent-${suffix}`;
    const rubricName = `tenant-rubric-${suffix}`;

    try {
      const taskBody = JSON.stringify({ agent: "tenant-agent", project: "tenant-project", title: `tenant-task-${suffix}` });
      const channelBody = JSON.stringify({ name: channelName, description: "tenant scoped" });
      const agentBody = JSON.stringify({ name: agentName, type: "worker" });
      const rubricBody = JSON.stringify({
        name: rubricName,
        criteria: [{ name: "quality", weight: 1, scale_min: 0, scale_max: 1 }],
      });

      const createTask = await fetchHandler(new Request("http://127.0.0.1/tasks", {
        method: "POST",
        headers: authHeaders(owner.key, taskBody),
        body: taskBody,
      }), "127.0.0.1");
      assert.equal(createTask.status, 201);

      const createChannel = await fetchHandler(new Request("http://127.0.0.1/axon/channels", {
        method: "POST",
        headers: authHeaders(owner.key, channelBody),
        body: channelBody,
      }), "127.0.0.1");
      assert.equal(createChannel.status, 201);

      const createAgent = await fetchHandler(new Request("http://127.0.0.1/soma/agents", {
        method: "POST",
        headers: authHeaders(owner.key, agentBody),
        body: agentBody,
      }), "127.0.0.1");
      assert.equal(createAgent.status, 201);

      const createRubric = await fetchHandler(new Request("http://127.0.0.1/thymus/rubrics", {
        method: "POST",
        headers: authHeaders(owner.key, rubricBody),
        body: rubricBody,
      }), "127.0.0.1");
      assert.equal(createRubric.status, 201);

      const ownerTasks = await (await fetchHandler(new Request("http://127.0.0.1/tasks", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as Array<{ title: string }>;
      assert.ok(ownerTasks.some((task) => task.title === `tenant-task-${suffix}`));

      const tenantTasks = await (await fetchHandler(new Request("http://127.0.0.1/tasks", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as Array<{ title: string }>;
      assert.ok(!tenantTasks.some((task) => task.title === `tenant-task-${suffix}`));

      const ownerChannels = await (await fetchHandler(new Request("http://127.0.0.1/axon/channels", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as Array<{ name: string }>;
      assert.ok(ownerChannels.some((channel) => channel.name === channelName));

      const tenantChannels = await (await fetchHandler(new Request("http://127.0.0.1/axon/channels", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as Array<{ name: string }>;
      assert.ok(!tenantChannels.some((channel) => channel.name === channelName));

      const ownerAgents = await (await fetchHandler(new Request("http://127.0.0.1/soma/agents", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as Array<{ name: string }>;
      assert.ok(ownerAgents.some((agent) => agent.name === agentName));

      const tenantAgents = await (await fetchHandler(new Request("http://127.0.0.1/soma/agents", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as Array<{ name: string }>;
      assert.ok(!tenantAgents.some((agent) => agent.name === agentName));

      const ownerRubrics = await (await fetchHandler(new Request("http://127.0.0.1/thymus/rubrics", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as Array<{ name: string }>;
      assert.ok(ownerRubrics.some((rubric) => rubric.name === rubricName));

      const tenantRubrics = await (await fetchHandler(new Request("http://127.0.0.1/thymus/rubrics", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as Array<{ name: string }>;
      assert.ok(!tenantRubrics.some((rubric) => rubric.name === rubricName));
    } finally {
      owner.db.prepare("DELETE FROM api_keys WHERE key_prefix = ? AND key_hash = ?").run(owner.prefix, owner.hash);
      owner.db.prepare("DELETE FROM api_keys WHERE key_prefix = ? AND key_hash = ?").run(tenant.prefix, tenant.hash);
      owner.db.prepare("DELETE FROM chiasm_tasks WHERE title = ?").run(`tenant-task-${suffix}`);
      owner.db.prepare("DELETE FROM chiasm_task_updates WHERE agent = ? AND summary IS NULL").run("tenant-agent");
      owner.db.prepare("DELETE FROM axon_channels WHERE name = ?").run(channelName);
      owner.db.prepare("DELETE FROM soma_agent_logs WHERE agent_id IN (SELECT id FROM soma_agents WHERE name = ?)").run(agentName);
      owner.db.prepare("DELETE FROM soma_agent_groups WHERE agent_id IN (SELECT id FROM soma_agents WHERE name = ?)").run(agentName);
      owner.db.prepare("DELETE FROM soma_agents WHERE name = ?").run(agentName);
      owner.db.prepare("DELETE FROM rubrics WHERE name = ?").run(rubricName);
    }
  });

  it("allows duplicate axon channel names across users and keeps emitted service events tenant-scoped", async () => {
    const { fetchHandler } = await import("../src/routes/index.ts");
    const owner = await setupUserKey(1, "owner-dup");
    const tenant = await setupUserKey(2, "tenant-dup");

    const suffix = Date.now();
    const sharedChannel = `shared-channel-${suffix}`;
    const tenantTaskTitle = `tenant-two-task-${suffix}`;

    try {
      const channelBody = JSON.stringify({ name: sharedChannel, description: "shared name allowed across tenants" });
      const ownerChannel = await fetchHandler(new Request("http://127.0.0.1/axon/channels", {
        method: "POST",
        headers: authHeaders(owner.key, channelBody),
        body: channelBody,
      }), "127.0.0.1");
      assert.equal(ownerChannel.status, 201);

      const tenantChannel = await fetchHandler(new Request("http://127.0.0.1/axon/channels", {
        method: "POST",
        headers: authHeaders(tenant.key, channelBody),
        body: channelBody,
      }), "127.0.0.1");
      assert.equal(tenantChannel.status, 201);

      const taskBody = JSON.stringify({ agent: "tenant-agent", project: "tenant-project", title: tenantTaskTitle });
      const createTask = await fetchHandler(new Request("http://127.0.0.1/tasks", {
        method: "POST",
        headers: authHeaders(tenant.key, taskBody),
        body: taskBody,
      }), "127.0.0.1");
      assert.equal(createTask.status, 201);

      const tenantEvents = await (await fetchHandler(new Request("http://127.0.0.1/axon/events?channel=system&type=task.created", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as Array<{ payload?: { title?: string } }>;
      assert.ok(tenantEvents.some((event) => event.payload?.title === tenantTaskTitle));

      const ownerEvents = await (await fetchHandler(new Request("http://127.0.0.1/axon/events?channel=system&type=task.created", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as Array<{ payload?: { title?: string } }>;
      assert.ok(!ownerEvents.some((event) => event.payload?.title === tenantTaskTitle));
    } finally {
      owner.db.prepare("DELETE FROM api_keys WHERE key_prefix = ? AND key_hash = ?").run(owner.prefix, owner.hash);
      owner.db.prepare("DELETE FROM api_keys WHERE key_prefix = ? AND key_hash = ?").run(tenant.prefix, tenant.hash);
      owner.db.prepare("DELETE FROM chiasm_task_updates WHERE task_id IN (SELECT id FROM chiasm_tasks WHERE title = ?)").run(tenantTaskTitle);
      owner.db.prepare("DELETE FROM chiasm_tasks WHERE title = ?").run(tenantTaskTitle);
      owner.db.prepare("DELETE FROM axon_events WHERE user_id IN (1, 2) AND type = 'task.created'").run();
      owner.db.prepare("DELETE FROM axon_channels WHERE name = ?").run(sharedChannel);
    }
  });

  it("scopes feed, stats, subscriptions, evaluations, and metrics by tenant", async () => {
    const { fetchHandler } = await import("../src/routes/index.ts");
    const owner = await setupUserKey(1, "owner-aggregate");
    const tenant = await setupUserKey(2, "tenant-aggregate");

    const suffix = Date.now();
    const taskTitle = `aggregate-task-${suffix}`;
    const rubricName = `aggregate-rubric-${suffix}`;
    const metricName = `aggregate-metric-${suffix}`;

    try {
      const ownerTaskStatsBefore = await (await fetchHandler(new Request("http://127.0.0.1/tasks/stats", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as { total: number };
      const tenantTaskStatsBefore = await (await fetchHandler(new Request("http://127.0.0.1/tasks/stats", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as { total: number };

      const taskBody = JSON.stringify({ agent: "aggregate-agent", project: "aggregate-project", title: taskTitle });
      const createTask = await fetchHandler(new Request("http://127.0.0.1/tasks", {
        method: "POST",
        headers: authHeaders(owner.key, taskBody),
        body: taskBody,
      }), "127.0.0.1");
      assert.equal(createTask.status, 201);

      const subscribeBody = JSON.stringify({ agent: "aggregate-agent", channel: "system" });
      const subscribeRes = await fetchHandler(new Request("http://127.0.0.1/axon/subscribe", {
        method: "POST",
        headers: authHeaders(owner.key, subscribeBody),
        body: subscribeBody,
      }), "127.0.0.1");
      assert.equal(subscribeRes.status, 201);

      const rubricBody = JSON.stringify({
        name: rubricName,
        criteria: [{ name: "quality", weight: 1, scale_min: 0, scale_max: 10 }],
      });
      const createRubric = await fetchHandler(new Request("http://127.0.0.1/thymus/rubrics", {
        method: "POST",
        headers: authHeaders(owner.key, rubricBody),
        body: rubricBody,
      }), "127.0.0.1");
      assert.equal(createRubric.status, 201);
      const createdRubric = await createRubric.json() as { id: number };

      const evalBody = JSON.stringify({
        rubric_id: createdRubric.id,
        agent: "aggregate-agent",
        subject: "aggregate-subject",
        scores: { quality: 9 },
        evaluator: "aggregate-evaluator",
      });
      const createEval = await fetchHandler(new Request("http://127.0.0.1/thymus/evaluate", {
        method: "POST",
        headers: authHeaders(owner.key, evalBody),
        body: evalBody,
      }), "127.0.0.1");
      assert.equal(createEval.status, 201);

      const metricBody = JSON.stringify({ agent: "aggregate-agent", metric: metricName, value: 0.75 });
      const createMetric = await fetchHandler(new Request("http://127.0.0.1/thymus/metrics", {
        method: "POST",
        headers: authHeaders(owner.key, metricBody),
        body: metricBody,
      }), "127.0.0.1");
      assert.equal(createMetric.status, 201);

      const ownerFeed = await (await fetchHandler(new Request("http://127.0.0.1/feed", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as Array<{ title: string }>;
      assert.ok(ownerFeed.some((item) => item.title === taskTitle));

      const tenantFeed = await (await fetchHandler(new Request("http://127.0.0.1/feed", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as Array<{ title: string }>;
      assert.ok(!tenantFeed.some((item) => item.title === taskTitle));

      const ownerTaskStats = await (await fetchHandler(new Request("http://127.0.0.1/tasks/stats", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as { total: number };
      assert.equal(ownerTaskStats.total, ownerTaskStatsBefore.total + 1);

      const tenantTaskStats = await (await fetchHandler(new Request("http://127.0.0.1/tasks/stats", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as { total: number };
      assert.equal(tenantTaskStats.total, tenantTaskStatsBefore.total);

      const ownerSubs = await (await fetchHandler(new Request("http://127.0.0.1/axon/subscriptions", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as Array<{ agent: string; channel: string }>;
      assert.ok(ownerSubs.some((sub) => sub.agent === "aggregate-agent" && sub.channel === "system"));

      const tenantSubs = await (await fetchHandler(new Request("http://127.0.0.1/axon/subscriptions", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as Array<{ agent: string; channel: string }>;
      assert.ok(!tenantSubs.some((sub) => sub.agent === "aggregate-agent" && sub.channel === "system"));

      const ownerEvaluations = await (await fetchHandler(new Request("http://127.0.0.1/thymus/evaluations", {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as Array<{ agent: string; subject: string }>;
      assert.ok(ownerEvaluations.some((evaluation) => evaluation.agent === "aggregate-agent" && evaluation.subject === "aggregate-subject"));

      const tenantEvaluations = await (await fetchHandler(new Request("http://127.0.0.1/thymus/evaluations", {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as Array<{ agent: string; subject: string }>;
      assert.ok(!tenantEvaluations.some((evaluation) => evaluation.agent === "aggregate-agent" && evaluation.subject === "aggregate-subject"));

      const ownerMetricSummary = await (await fetchHandler(new Request(`http://127.0.0.1/thymus/metrics/summary?agent=aggregate-agent&metric=${encodeURIComponent(metricName)}`, {
        headers: authHeaders(owner.key),
      }), "127.0.0.1")).json() as { count: number };
      assert.equal(ownerMetricSummary.count, 1);

      const tenantMetricSummary = await (await fetchHandler(new Request(`http://127.0.0.1/thymus/metrics/summary?agent=aggregate-agent&metric=${encodeURIComponent(metricName)}`, {
        headers: authHeaders(tenant.key),
      }), "127.0.0.1")).json() as { count: number };
      assert.equal(tenantMetricSummary.count, 0);
    } finally {
      owner.db.prepare("DELETE FROM api_keys WHERE key_prefix = ? AND key_hash = ?").run(owner.prefix, owner.hash);
      owner.db.prepare("DELETE FROM api_keys WHERE key_prefix = ? AND key_hash = ?").run(tenant.prefix, tenant.hash);
      owner.db.prepare("DELETE FROM chiasm_task_updates WHERE task_id IN (SELECT id FROM chiasm_tasks WHERE title = ?)").run(taskTitle);
      owner.db.prepare("DELETE FROM chiasm_tasks WHERE title = ?").run(taskTitle);
      owner.db.prepare("DELETE FROM axon_subscriptions WHERE agent = ? AND channel = ?").run("aggregate-agent", "system");
      owner.db.prepare("DELETE FROM evaluations WHERE agent = ? AND subject = ?").run("aggregate-agent", "aggregate-subject");
      owner.db.prepare("DELETE FROM quality_metrics WHERE agent = ? AND metric = ?").run("aggregate-agent", metricName);
      owner.db.prepare("DELETE FROM rubrics WHERE name = ?").run(rubricName);
    }
  });
});
