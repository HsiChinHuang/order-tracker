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
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
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
// Filled in at boot from the environment the agent will actually inherit, and
// served by /healthz so "which model answered this incident?" is answerable from
// outside the container. Nulls mean the values were never pinned.
let AGENT_MODEL_IN_USE = { provider: null, model: null };
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS || 900000);
const MAX_BODY = 2 * 1024 * 1024;

const PROMPT_TEMPLATE = readFileSync(
  new URL("./prompts/investigate.md", import.meta.url),
  "utf8",
);

const incidents = new Map();

// The incidents Map is process memory, but every incident's payload lives on the
// incidents volume (alert.json, evidence.md, agent_response.md, recovery.json).
// Before restart the responder answered GET /incidents/<id> with 404 for every
// incident it had itself created -- the evidence outlived the state describing
// it. On boot, rebuild the Map from the volume so an incident id stays valid
// across container restarts.
async function loadExistingIncidents() {
  let entries;
  try {
    entries = await readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries.filter((d) => d.isDirectory())) {
    const name = ent.name;
    if (incidents.has(name)) continue;
    const dir = `${DATA_DIR}/${name}`;
    const read = (f) => {
      try {
        return JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
      } catch {
        return null;
      }
    };
    const alert = read("alert.json");
    const recovery = read("recovery.json");
    if (!alert && !recovery) continue; // not an incident dir
    let agentFinished = false;
    let agentText = "";
    try {
      agentText = readFileSync(`${dir}/agent_response.md`, "utf8");
      agentFinished = agentText.trim().length > 0;
    } catch {}
    // Re-derive verdict and write scope from the artifacts rather than trusting
    // recovery.json, which older builds rewrote with only two keys after a
    // POST /verify. A rebuilt record missing these would make the next re-verify
    // conclude "no verdict line" and escalate an incident that had already been
    // fixed and confirmed.
    const verdict = agentFinished ? parseVerdict(agentText) : null;
    const writeScope = read("write-scope.json");
    incidents.set(name, {
      status: recovery
        ? recovery.recovered
          ? "recovered"
          : "verified_unrecovered"
        : agentFinished
          ? "agent_completed"
          : alert
            ? "investigating_interrupted"
            : "unknown",
      startedAt: alert?.startsAt || null,
      finishedAt: recovery?.recovery?.checked_at || null,
      endpoint:
        alert?.annotations?.endpoint || alert?.labels?.http_route || "unknown",
      evidenceDir: dir,
      alert,
      recovered: recovery?.recovered,
      recovery: recovery?.recovery,
      verdict,
      writeScope: writeScope
        ? { outside: writeScope.outside || [], touched: writeScope.touched || [] }
        : { outside: [], touched: [] },
      rebuiltFromDisk: true,
    });
  }
}

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

// The cooldown guard has to survive a restart, otherwise a still-firing alert
// launches a fresh agent the moment the responder comes back up -- which is how a
// second full agent run got paid for during earlier testing (issue #8 checkpoint
// 3). "agent already running" cannot survive a restart honestly: the process died
// with the container. What gets persisted is lastStarted, and an interrupted run
// is remembered as such, so the guard reads "investigated Ns ago" rather than
// pretending an agent is alive.
const INFLIGHT_FILE = `${DATA_DIR}/inflight.json`;

function loadInflight() {
  try {
    const raw = JSON.parse(readFileSync(INFLIGHT_FILE, "utf8"));
    for (const [key, v] of Object.entries(raw)) {
      if (v?.running) {
        inflight.set(key, { ...v, running: false, interrupted: true });
        log(`cooldown: ${key} had an agent running when the responder last stopped; treating as investigated ${v.incidentId || "?"}`);
      } else if (v && typeof v.lastStarted === "number") {
        inflight.set(key, v);
      }
    }
    if (inflight.size) log(`cooldown state loaded: ${inflight.size} key(s)`);
  } catch {
    // first run, or the volume was wiped
  }
}

let saveInflightQueued = null;
async function saveInflight() {
  // Coalesce bursts of writes; the file is tiny and only read at boot.
  if (saveInflightQueued) return saveInflightQueued;
  saveInflightQueued = (async () => {
    const payload = Object.fromEntries(inflight);
    try {
      await writeFile(INFLIGHT_FILE, JSON.stringify(payload, null, 2));
    } catch (e) {
      log(`WARNING: could not persist cooldown state: ${e.message}`);
    } finally {
      saveInflightQueued = null;
    }
  })();
  return saveInflightQueued;
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
// `docker compose restart app` -- recovered=false right after the agent finishes
// is expected, which is why this is re-runnable through POST /incidents/{id}/verify.
//
// The distinction that matters is between a 5xx (incident continues) and a probe
// that got no answer at all. Status 0 means the request never completed: DNS
// failure, connection refused, timeout. Treating that as "not >= 500, therefore
// recovered" was a real bug -- caught by the fixture run, where APP_BASE_URL
// pointed at an unresolvable host and the responder reported recovered=true with
// all three probes at status 0, i.e. it certified recovery for an app it could
// not reach. Only a real 2xx/3xx response counts as evidence of health.
async function verify(endpoint) {
  if (!endpoint.includes("{")) return { verified: false, note: "no route template" };
  const results = [];
  for (const id of ["standard-1001", "express-1002", "standard-1003"]) {
    const url = endpoint.replace("{order_id}", id);
    const r = await get(`${APP_URL}${url}`);
    results.push({ url, status: r.http });
  }
  const failing = results.filter((r) => r.status >= 500);
  const unreachable = results.filter((r) => r.status === 0 || r.status >= 600 || r.status < 200);
  return {
    verified: true,
    results,
    still_failing: failing,
    // Non-empty means the check itself could not be performed. Callers must treat
    // this as UNKNOWN, never as recovery.
    unreachable,
    indeterminate: failing.length === 0 && unreachable.length > 0,
    checked_at: stamp(),
  };
}

// The agent gets read,grep,find,ls,edit and nothing else, and the image ships
// only node (no git, curl, docker, python3 -- verified in the running container).
// So nothing inside the agent can enforce a write boundary: it is a prompt
// instruction, and prompt instructions get ignored. The responder can, though,
// look at the filesystem afterwards and say what actually changed. That is the
// real enforcement point: detect, record, refuse to call it recovered.
//
// PRUNE_DIRS are skipped because they are dependency/VCS churn the agent is not
// expected to touch and scanning them would swamp the signal. Anything outside
// this list IS watched, including files the agent creates at the repo root.
// .git is pruned, so this audits the working tree, not commits: an agent with no
// git binary cannot commit, but it also means the audit must not be described as
// catching git history changes.
const PRUNE_DIRS = new Set([
  ".git",
  ".venv",
  "node_modules",
  "__pycache__",
  ".pi",
  "data",
  ".pytest_cache",
]);
const WRITE_ALLOW_PREFIX = "app/";

async function snapshotTree(root) {
  const { stat } = await import("node:fs/promises");
  const out = new Map();
  const walk = async (dir, rel) => {
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, does not invalidate the rest
    }
    for (const e of ents) {
      if (PRUNE_DIRS.has(e.name)) continue;
      const abs = `${dir}/${e.name}`;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(abs, relPath);
      } else if (e.isFile()) {
        try {
          const s = await stat(abs);
          out.set(relPath, `${s.size}:${Math.round(s.mtimeMs)}`);
        } catch {}
      }
    }
  };
  await walk(root, "");
  return out;
}

export function diffTrees(before, after) {
  const changed = [];
  const added = [];
  const removed = [];
  for (const [p, sig] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== sig) changed.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) removed.push(p);
  return { changed, added, removed };
}

export function classifyWriteScope(diff) {
  const touched = [...diff.changed, ...diff.added, ...diff.removed];
  const outside = touched.filter((p) => !p.startsWith(WRITE_ALLOW_PREFIX));
  return { allowed: touched.filter((p) => p.startsWith(WRITE_ALLOW_PREFIX)), outside, touched };
}

// The contract the agent actually satisfies is one VERDICT line at the end of
// agent_response.md, not a JSON object -- it has no tool that could emit and
// validate JSON, and response.schema.json was never read by anything. Parse the
// line and build the schema object here, so the schema describes what the
// responder produces instead of what nobody sends.
export function parseVerdict(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^VERDICT:\s*(fixed|no-action|needs-human)\s*-\s*(.+)$/i);
    if (m) {
      const kind = m[1].toLowerCase();
      return { kind, reason: m[2].trim(), line: lines[i], lineFromEnd: lines.length - 1 - i };
    }
  }
  return null;
}

// One place that decides status, from three inputs: what the agent claimed, what
// it actually touched, and what the probes measured. The ordering encodes the
// precedence -- an agent that wrote outside app/ cannot be trusted to have fixed
// anything regardless of its verdict, and an agent asking for a human is escalated
// whether or not the probes happen to look healthy.
function buildResponse(verdict, evidence, recovery, scope) {
  const base = {
    summary: "",
    root_cause: "not stated by the agent",
    action: "escalate",
    status: "escalated",
    details: "",
  };
  if (!verdict) {
    return {
      ...base,
      summary: "Agent finished without a VERDICT line; outcome unknown.",
      details:
        "The prompt requires a final 'VERDICT: <fixed|no-action|needs-human> - <cause>' line. " +
        "It was absent, so no outcome can be attributed to this run.",
    };
  }
  const cause = verdict.reason;
  if (scope && scope.outside.length) {
    return {
      ...base,
      summary: `${evidence.endpoint}: agent wrote outside ${WRITE_ALLOW_PREFIX} and its fix is not trusted.`,
      root_cause: cause,
      details: `${verdict.line} | out-of-scope files: ${scope.outside.join(", ")}`,
    };
  }
  if (verdict.kind === "needs-human") {
    return { ...base, summary: `${evidence.endpoint}: ${cause}`, root_cause: cause, details: verdict.line };
  }
  const healthy = isRecovered(recovery);
  if (verdict.kind === "fixed") {
    const why = recoveryProblem(recovery);
    return {
      summary: `${evidence.endpoint}: ${cause}`,
      root_cause: cause,
      action: "fix",
      status: healthy ? "resolved" : "pending",
      details: healthy ? verdict.line : `${verdict.line} | ${why}`,
      fix_commit_message: `fix(app): ${cause}`,
    };
  }
  // no-action: the agent believes the alert was wrong.
  const why = recoveryProblem(recovery);
  return {
    summary: `${evidence.endpoint}: ${cause}`,
    root_cause: cause,
    action: "false_positive",
    status: healthy ? "resolved" : "pending",
    details: healthy ? verdict.line : `${verdict.line} | ${why}`,
  };
}

// Spelled out because "pending" without a reason is what made the old runbook
// untrustworthy: the reader could not tell a restart away from a dead app.
function recoveryProblem(recovery) {
  if (!recovery || !recovery.verified) return "recovery could not be checked";
  const bad = (recovery.still_failing || []).length;
  const dark = (recovery.unreachable || []).length;
  const parts = [];
  if (bad) parts.push(`${bad} probe(s) still 5xx`);
  if (dark) parts.push(`${dark} probe(s) returned no HTTP response`);
  parts.push(
    "the app does not hot-reload; restart it and re-check with POST /incidents/<id>/verify",
  );
  return parts.join(", ");
}

// Single definition of "the incident is over": the check ran, nothing answered
// 5xx, AND nothing failed to answer. Used by the response object, the record and
// the API so the three can never disagree.
export function isRecovered(recovery) {
  return Boolean(
    recovery &&
      recovery.verified &&
      (recovery.results || []).length > 0 &&
      (recovery.still_failing || []).length === 0 &&
      (recovery.unreachable || []).length === 0,
  );
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

    // Snapshot before the agent runs so the write-scope audit below has a
    // baseline. The tree is a live Windows bind mount, so unrelated host edits
    // could otherwise be attributed to the agent.
    const before = await snapshotTree(REPO_DIR);

    const agent = await runAgent(prompt);
    rec.agent = agent;
    rec.status = agent.ok ? "agent_completed" : "agent_failed";
    await writeFile(
      `${dir}/agent_response.md`,
      agent.output || `# No output\n\n${agent.error || "agent produced nothing"}`,
    );

    const after = await snapshotTree(REPO_DIR);
    const diff = diffTrees(before, after);
    const scope = classifyWriteScope(diff);
    rec.writeScope = scope;
    await writeFile(
      `${dir}/write-scope.json`,
      JSON.stringify({ allowPrefix: WRITE_ALLOW_PREFIX, ...diff, ...scope }, null, 2),
    );
    if (scope.outside.length) {
      rec.status = "agent_out_of_scope";
      log(`${incidentId}: OUT OF SCOPE writes outside ${WRITE_ALLOW_PREFIX}: ${scope.outside.join(", ")}`);
    } else {
      log(`${incidentId}: agent wrote only under ${WRITE_ALLOW_PREFIX} (${scope.allowed.length} file(s))`);
    }

    const verdict = parseVerdict(agent.output);
    rec.verdict = verdict;

    rec.recovery = await verify(rec.endpoint || "unknown");
    rec.recovered = isRecovered(rec.recovery);
    const response = buildResponse(verdict, evidence, rec.recovery, scope);
    rec.response = response;
    await writeFile(
      `${dir}/recovery.json`,
      JSON.stringify(
        {
          recovery: rec.recovery,
          recovered: rec.recovered,
          verdict: verdict ? verdict.line : null,
          response,
          writeScope: { allowPrefix: WRITE_ALLOW_PREFIX, outside: scope.outside, touched: scope.touched },
        },
        null, 2,
      ),
    );
    log(`${incidentId}: agent ${rec.status}, verdict=${verdict ? verdict.kind : "MISSING"}, recovered=${rec.recovered}`);
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

// Exported so a test can assert that importing this module does NOT start it.
export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return json(res, 200, { status: "ok", agent: AGENT_CMD, model: AGENT_MODEL_IN_USE });
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
        await saveInflight();
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
      await saveInflight();
      accepted.push({ incidentId: id, firing: true, deduped: false });
      handle(id, alert)
        .catch((e) => log(`${id}: unhandled ${e}`))
        .finally(() => {
          const cur = inflight.get(key);
          if (cur && cur.incidentId === id) inflight.set(key, { running: false, lastStarted: Date.now(), incidentId: id });
          saveInflight();
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
    rec.recovered = isRecovered(rec.recovery);
    // Rebuilding the response here matters: the first build said "pending, not
    // hot-reloaded" and after a restart that is stale. Without this the verify
    // path also silently rewrote recovery.json down to two keys, so the artifact
    // stopped matching response.schema.json after any re-check.
    rec.response = buildResponse(
      rec.verdict,
      { endpoint: rec.endpoint || "unknown" },
      rec.recovery,
      rec.writeScope || { outside: [] },
    );
    try {
      await writeFile(
        `${rec.evidenceDir}/recovery.json`,
        JSON.stringify(
          {
            recovery: rec.recovery,
            recovered: rec.recovered,
            verdict: rec.verdict ? rec.verdict.line : null,
            response: rec.response,
            writeScope: {
              allowPrefix: WRITE_ALLOW_PREFIX,
              outside: (rec.writeScope || {}).outside || [],
              touched: (rec.writeScope || {}).touched || [],
            },
          },
          null, 2,
        ),
      );
    } catch {}
    log(`${rec.id || verifyRoute[1]}: re-verified recovered=${rec.recovered} status=${rec.response.status}`);
    return json(res, 200, {
      recovered: rec.recovered,
      recovery: rec.recovery,
      response: rec.response,
    });
  }

  json(res, 404, { detail: "Not found" });
});

export const WRITE_ALLOW_PREFIX_FOR_TESTS = WRITE_ALLOW_PREFIX;
export async function snapshotTreeForTests(root) {
  return snapshotTree(root);
}

// Boot side effects live behind a main-module guard. Importing this file to test
// the decision functions must not read the incidents volume, log to /dev/stdout or
// bind :8001 -- without this, `node --test` would fight the running responder for
// the port and rebuild incident state as a side effect of a unit test.
async function boot() {
  await mkdir(DATA_DIR, { recursive: true });
  loadInflight();
  await loadExistingIncidents();

// .env values are interpolated by compose at `up` time, and an ambient shell
// variable of the same name silently overrides them -- an incident was
// investigated with a model nobody chose because a stale export beat the .env
// line. entrypoint.sh validates the pair against models.json (and hard-fails on
// a mismatch when both are set), but that value is not in the responder's own
// log. Echo the pair actually in effect, loudly, and flag an unset provider so
// "which model fixed my incident?" is answerable from the container log alone.
{
  const provider = process.env.PI_PROVIDER || "";
  const model = process.env.PI_MODEL || "";
  AGENT_MODEL_IN_USE = { provider: provider || null, model: model || null };
  if (!provider && model) {
    log(`WARNING: PI_MODEL="${model}" set but PI_PROVIDER unset -- pi silently picks its own default provider`);
  } else if (!provider && !model) {
    log("WARNING: PI_PROVIDER/PI_MODEL unset -- pi uses ambient defaults; .env or the compose environment should pin the agent model");
  } else {
    log(`agent model in effect: ${provider}/${model || "(provider default)"}`);
  }

  // entrypoint.sh re-exports PI_PROVIDER/PI_MODEL from ${REPO_DIR}/.env so that
  // the file an operator edits wins over compose interpolation of an ambient
  // shell variable. If they still disagree, the entrypoint did not run (someone
  // overrode ENTRYPOINT, or REPO_DIR points elsewhere) and the container is
  // running a model the repo never asked for -- which is exactly the failure that
  // made earlier agent verdicts unattributable (issue #8).

  // Compose interpolates ${PI_MODEL} from the process environment FIRST and the
  // .env file only fills gaps, so an ambient export beats the file. This is not
  // hypothetical: on this machine a Windows user environment variable sets
  // PI_MODEL=Qwen3.8-Flash-Next-Thinking while .env says
  // Qwen3.6-35B-A3B-Instruct, and the container had been quietly using the
  // ambient one. The repo checkout is mounted at REPO_DIR, so compare against
  // the file the operator actually edited and say so when they disagree.
  const envFile = `${REPO_DIR}/.env`;
  try {
    const txt = readFileSync(envFile, "utf8");
    const pick = (k) => {
      const m = txt.match(new RegExp(`^${k}=(.*)$`, "m"));
      return m ? m[1].trim() : "";
    };
    const inFile = { PI_PROVIDER: pick("PI_PROVIDER"), PI_MODEL: pick("PI_MODEL") };
    const diff = Object.entries(inFile).filter(([k, v]) => v && v !== process.env[k]);
    if (diff.length) {
      for (const [k, v] of diff) {
        log(`WARNING: ${k} in effect is "${process.env[k] || "<unset>"}" but ${envFile} says "${v}" -- entrypoint.sh was expected to make .env win; check that the image's entrypoint is in use and REPO_DIR is mounted`);
      }
    } else if (inFile.PI_MODEL || inFile.PI_PROVIDER) {
      log(`${envFile} agrees with the environment`);
    }
  } catch {
    log(`note: no ${envFile} to cross-check the agent model against`);
  }

  let hasCfg = false;
  try {
    JSON.parse(readFileSync(`${process.env.PI_CODING_AGENT_DIR || "/root/.pi/agent"}/models.json`, "utf8"));
    hasCfg = true;
  } catch {}
  log(`models.json visible to agent: ${hasCfg ? "yes" : "NO -- agent calls will fail to authenticate"}`);
  log(`incidents rebuilt from ${DATA_DIR}: ${incidents.size}`);
}

  server.listen(PORT, "0.0.0.0", () =>
    log(`listening on :${PORT} agent=${AGENT_CMD} repo=${REPO_DIR}`),
  );
}

if (isMainModule()) {
  await boot();
}

// Robust across node 18 (host) and node 24 (container), and across being invoked
// as `node responder.mjs`, `node ./incident-response/responder.mjs` or as the
// entry of `node --test <dir>`, where argv[1] may be a relative path that
// fileURLToPath() rejects outright.
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
