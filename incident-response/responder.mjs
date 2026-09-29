// Order Tracker incident responder.
//
// Receives Grafana alert webhooks at POST /alerts on port 8001, saves an
// evidence bundle (affected endpoint, metrics, logs, traces), then starts a
// coding agent in headless mode to investigate and fix the incident.
//
// Everything here talks to the stack over HTTP on purpose: the container image
// has no curl, no docker CLI and no git, so shelling out to them silently
// produced empty evidence in the previous version of this service.

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";

const PORT = Number(process.env.RESOLVER_PORT || 8001);
const DATA_DIR = process.env.RESOLVER_DATA_DIR || "/incidents";
const APP_URL = process.env.APP_BASE_URL || "http://app:8000";
const PROM_URL = process.env.PROMETHEUS_URL || "http://prometheus:9090";
const LOKI_URL = process.env.LOKI_URL || "http://loki:3100";
const TEMPO_URL = process.env.TEMPO_URL || "http://tempo:3200";
const REPO_DIR = process.env.REPO_DIR || "/work/repo";
const AGENT_CMD = process.env.AGENT_CMD || "pi";
const AGENT_TOOLS = process.env.AGENT_TOOLS || "read,grep,find,ls,edit";
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 900000);
const MAX_BODY = 2 * 1024 * 1024;

const PROMPT_TEMPLATE = readFileSync(
  new URL("./prompts/investigate.md", import.meta.url),
  "utf8",
);

const incidents = new Map();

// Grafana re-notifies a still-firing alert every repeat_interval, and the policy
// tree here uses 1m so the loop is observable in one sitting. Without this guard
// a 40-minute incident would launch ~40 coding agents against the same fault.
// Key: alertname + route. Value: { running, lastStarted, incidentId }.
const inflight = new Map();
const COOLDOWN_MS = Number(process.env.AGENT_COOLDOWN_MS || 15 * 60 * 1000);

function dedupeKey(alert) {
  const l = alert.labels || {};
  return `${l.alertname || "alert"}|${l.http_route || l.http_route || "no-route"}`;
}

const stamp = () => new Date().toISOString();

function log(...args) {
  console.log(`[responder ${stamp()}]`, ...args);
}

async function get(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 4000);
    }
    return { http: res.status, body };
  } catch (err) {
    return { http: 0, body: `${err.name}: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}

const prom = (q) =>
  get(`${PROM_URL}/api/v1/query?query=${encodeURIComponent(q)}`);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build the evidence an on-call engineer would look at. Each source is
// optional: an unavailable backend must degrade to a note, never lose the
// alert or silently hand the agent an empty bundle.
async function collectEvidence(alert) {
  const labels = alert.labels || {};
  const annotations = alert.annotations || {};
  const endpoint =
    annotations.endpoint || labels.http_route || labels.endpoint || "unknown";

  const out = { collected_at: stamp(), endpoint, sources: {} };

  out.sources.fifty_xx_rate = await prom(
    'sum(rate(http_requests_total{http_response_status_code=~"5.."}[5m])) by (http_route)',
  );
  out.sources.fifty_xx_count = await prom(
    'sum(increase(http_requests_total{http_response_status_code=~"5.."}[15m])) by (http_route, http_response_status_code)',
  );
  out.sources.all_requests = await prom(
    "sum(increase(http_requests_total[15m])) by (http_route, http_response_status_code)",
  );

  // Loki LogQL over the route recorded on each log record.
  const logql =
    endpoint === "unknown"
      ? '{service_name="order-tracker"}'
      : `{service_name="order-tracker"} |~ ${JSON.stringify(escapeRe(endpoint))}`;
  out.sources.loki = await get(
    `${LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(logql)}&limit=40&direction=backward`,
  );

  out.sources.tempo = await get(
    `${TEMPO_URL}/api/eval?q=${encodeURIComponent("tracesByServiceName")}&limit=20`,
  );

  // A live probe of the affected endpoint: the incident should reproduce here.
  if (endpoint !== "unknown" && endpoint.includes("{")) {
    const probes = [];
    for (const id of ["standard-1001", "express-1002", "standard-1003"]) {
      const url = endpoint.replace("{order_id}", id);
      probes.push({ url, ...(await get(`${APP_URL}${url}`)) });
    }
    out.sources.live_probe = probes;
  } else if (endpoint !== "unknown") {
    out.sources.live_probe = await get(`${APP_URL}${endpoint}`);
  }

  return out;
}

function bundle(id, alert, evidence) {
  const a = alert.annotations || {};
  const l = alert.labels || {};
  const cut = (v) => JSON.stringify(v, null, 2).slice(0, 9000);
  return `# Incident ${id}

- alertname: ${l.alertname || "unknown"}
- state: ${alert.status || "unknown"}
- affected endpoint: ${evidence.endpoint}
- severity: ${l.severity || "unknown"}
- summary: ${a.summary || "not provided"}
- description: ${a.description || "not provided"}
- dashboard: ${a.dashboardURL || a.dashboard_url || "not provided"}
- time window: ${a.time_window || "not provided"}
- startsAt: ${alert.startsAt || "not provided"}
- labels: ${JSON.stringify(l)}

## 5xx rate by route
\`\`\`json
${cut(evidence.sources.fifty_xx_rate)}
\`\`\`

## 5xx count, last 15m
\`\`\`json
${cut(evidence.sources.fifty_xx_count)}
\`\`\`

## All requests, last 15m
\`\`\`json
${cut(evidence.sources.all_requests)}
\`\`\`

## Loki log records
\`\`\`json
${cut(evidence.sources.loki)}
\`\`\`

## Tempo trace search
\`\`\`json
${cut(evidence.sources.tempo)}
\`\`\`

## Live probe of the affected endpoint
\`\`\`json
${cut(evidence.sources.live_probe)}
\`\`\`
`;
}

function runAgent(prompt) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const cap = (s) => (s.length > 300000 ? s.slice(0, 300000) : s);
    log(`starting agent: ${AGENT_CMD} --print --tools ${AGENT_TOOLS}`);
    const child = spawn(
      AGENT_CMD,
      ["--print", "--tools", AGENT_TOOLS, "--", prompt],
      { cwd: REPO_DIR, env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.on("data", (d) => (out = cap(out + d)));
    child.stderr.on("data", (d) => (err = cap(err + d)));
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      err += `\n[responder] agent exceeded ${AGENT_TIMEOUT_MS}ms and was killed`;
    }, AGENT_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(killer);
      resolve({ ok: false, output: "", error: `spawn failed: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({
        ok: code === 0,
        output: out.trim(),
        error: err.trim().slice(-4000),
        exitCode: code,
      });
    });
  });
}

// Does the incident still reproduce? This is the recovery check the runbook
// needs; it is deliberately separate from the agent's own claim. The app is not
// hot-reloading, so an edit made by the agent only takes effect after
// `docker compose restart app` — check=false right after the agent finishes is
// expected and is why this is re-runnable through POST /incidents/{id}/verify.
async function verify(endpoint) {
  if (!endpoint.includes("{")) return { verified: false, note: "no route template" };
  const results = [];
  for (const id of ["standard-1001", "express-1002", "standard-1003"]) {
    const url = endpoint.replace("{order_id}", id);
    const r = await get(`${APP_URL}${url}`);
    results.push({ url, status: r.http });
  }
  const failing = results.filter((r) => r.status >= 500);
  return {
    verified: true,
    results,
    still_failing: failing,
    checked_at: stamp(),
  };
}

async function handle(incidentId, alert) {
  const rec = incidents.get(incidentId);
  try {
    const evidence = await collectEvidence(alert);
    const dir = `${DATA_DIR}/${incidentId}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/alert.json`, JSON.stringify(alert, null, 2));
    await writeFile(`${dir}/evidence.md`, bundle(incidentId, alert, evidence));
    rec.endpoint = evidence.endpoint;
    rec.evidenceDir = dir;
    log(`${incidentId}: evidence saved (endpoint=${evidence.endpoint})`);

    const prompt =
      PROMPT_TEMPLATE.replace(/\{\{INCIDENT_DIR\}\}/g, dir) +
      `\n---\nAlert: ${JSON.stringify({
        status: alert.status,
        labels: alert.labels,
        annotations: alert.annotations,
      })}\nRepository to fix: ${REPO_DIR}`;

    const agent = await runAgent(prompt);
    rec.agent = agent;
    rec.status = agent.ok ? "agent_completed" : "agent_failed";
    await writeFile(
      `${dir}/agent_response.md`,
      agent.output || `# No output\n\n${agent.error || "agent produced nothing"}`,
    );

    rec.recovery = await verify(rec.endpoint || "unknown");
    rec.recovered = rec.recovery.verified && rec.recovery.still_failing.length === 0;
    await writeFile(
      `${dir}/recovery.json`,
      JSON.stringify({ recovery: rec.recovery, recovered: rec.recovered }, null, 2),
    );
    log(`${incidentId}: agent ${rec.status}, recovered=${rec.recovered}`);
  } catch (e) {
    rec.status = "error";
    rec.error = `${e.name}: ${e.message}`;
    log(`${incidentId}: ${rec.error}`);
  }
  rec.finishedAt = stamp();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > MAX_BODY) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

const json = (res, code, payload) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload, null, 2));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { status: "ok", agent: AGENT_CMD });
  }

  if (req.method === "GET" && url.pathname === "/incidents") {
    return json(res, 200, {
      incidents: [...incidents.entries()].map(([id, r]) => ({
        id,
        status: r.status,
        endpoint: r.endpoint,
        recovered: r.recovered,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        evidenceDir: r.evidenceDir,
      })),
    });
  }

  const one = url.pathname.match(/^\/incidents\/([\w-]+)$/);
  if (req.method === "GET" && one) {
    const r = incidents.get(one[1]);
    return r
      ? json(res, 200, { id: one[1], ...r })
      : json(res, 404, { detail: "Incident not found" });
  }

  if (req.method === "POST" && url.pathname === "/alerts") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)) || "{}");
    } catch (e) {
      return json(res, 400, { detail: `Invalid JSON: ${e.message}` });
    }

    // Grafana webhook shape is { alerts: [ { status, labels, annotations } ] }.
    // Accepting only a bare alert, or reading labels off the envelope, is what
    // made every previous incident report itself as alertname "Unknown".
    const alerts = Array.isArray(payload.alerts) ? payload.alerts : [payload];
    const accepted = [];

    for (const alert of alerts) {
      const state = String(alert.status || "firing").toLowerCase();
      const firing = state === "firing" || state === "alerting";
      const id = randomUUID().slice(0, 8);
      const key = dedupeKey(alert);
      const prev = inflight.get(key);
      const age = prev ? Date.now() - prev.lastStarted : Infinity;

      if (!firing) {
        // A resolved notification clears the guard so the next occurrence is
        // investigated immediately instead of waiting out the cooldown.
        inflight.delete(key);
        incidents.set(id, {
          status: "resolved_ignored",
          startedAt: stamp(),
          finishedAt: stamp(),
          alert,
        });
        accepted.push({ incidentId: id, firing: false, deduped: false });
        log(`${id}: resolved notification, nothing to investigate`);
        continue;
      }

      if (prev?.running) {
        accepted.push({ incidentId: id, firing: true, deduped: true, reason: "agent already running" });
        log(`${id}: skipped, agent already investigating ${key}`);
        continue;
      }
      if (prev && age < COOLDOWN_MS) {
        incidents.set(id, {
          status: "deduped",
          startedAt: stamp(),
          finishedAt: stamp(),
          alert,
          dedupedBecause: `last investigation ${Math.round(age / 1000)}s ago (cooldown ${COOLDOWN_MS / 1000}s)`,
          linkedIncidentId: prev.incidentId,
        });
        accepted.push({ incidentId: id, firing: true, deduped: true, reason: "cooldown" });
        log(`${id}: skipped, ${key} investigated ${Math.round(age / 1000)}s ago`);
        continue;
      }

      const rec = { status: "investigating", startedAt: stamp(), alert };
      incidents.set(id, rec);
      inflight.set(key, { running: true, lastStarted: Date.now(), incidentId: id });
      accepted.push({ incidentId: id, firing: true, deduped: false });
      handle(id, alert)
        .catch((e) => log(`${id}: unhandled ${e}`))
        .finally(() => {
          const cur = inflight.get(key);
          if (cur && cur.incidentId === id) inflight.set(key, { running: false, lastStarted: Date.now(), incidentId: id });
        });
    }

    log(`accepted ${accepted.length} alert(s) from Grafana`);
    return json(res, 202, { accepted });
  }

  const verifyRoute = url.pathname.match(/^\/incidents\/([\w-]+)\/verify$/);
  if (req.method === "POST" && verifyRoute) {
    const rec = incidents.get(verifyRoute[1]);
    if (!rec) return json(res, 404, { detail: "Incident not found" });
    rec.recovery = await verify(rec.endpoint || "unknown");
    rec.recovered = rec.recovery.verified && rec.recovery.still_failing.length === 0;
    try {
      await writeFile(
        `${rec.evidenceDir}/recovery.json`,
        JSON.stringify({ recovery: rec.recovery, recovered: rec.recovered }, null, 2),
      );
    } catch {}
    log(`${rec.id || verifyRoute[1]}: re-verified recovered=${rec.recovered}`);
    return json(res, 200, { recovered: rec.recovered, recovery: rec.recovery });
  }

  json(res, 404, { detail: "Not found" });
});

await mkdir(DATA_DIR, { recursive: true });
server.listen(PORT, "0.0.0.0", () =>
  log(`listening on :${PORT} agent=${AGENT_CMD} repo=${REPO_DIR}`),
);
