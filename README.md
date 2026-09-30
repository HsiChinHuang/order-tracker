# Order Tracker

A small order tracking app plus the observability stack and alert-driven incident
responder built for the AI Dev Tools Zoomcamp Homework 4.

Three sample orders are created on first startup. The user flow is creating an
order and checking its status; the exercise around it is detecting and handling a
5xx incident that the app is configured to reproduce.

## Layout

```
app/                     FastAPI service (the system under observation)
observability/           collector, Prometheus, Loki, Tempo, Grafana provisioning
incident-response/       the responder service (Node) + its prompt, policy, schema
scripts/                 reproduce the fault / put the fix back
runbooks/                what a human runs during and after an incident
tests/                   pytest suite for the app
```

## Prerequisites

- Docker with Compose. On WSL 2 with Docker Desktop, `docker` inside the distro may
  be the stub that always exits 1; `docker.exe` works. `scripts/lib-docker.sh`
  probes for a CLI that can actually run `compose version` and adopts it, which is
  why the scripts here work under both.
- Python 3.11+ and `uv` only if you want to run the tests on the host.
- A [pi](https://github.com/badlogic/pi-mono) config directory containing
  `models.json`, for the investigating agent. Without it the responder starts, but
  every agent run fails to authenticate and the responder says so at startup.

## Configure

`.env` is git-ignored and required. Compose refuses to even render without
`PI_AGENT_DIR`:

```bash
cp .env.example .env    # then edit PI_AGENT_DIR, PI_PROVIDER, PI_MODEL
```

One precedence trap worth knowing before you debug it: an environment variable
already exported in your shell **wins over `.env`**, and on Windows + WSL the
Windows environment leaks into WSL. An old `PI_MODEL` from another project will
silently replace the one in the file. Check what will really be used with

```bash
docker compose config | grep -A2 PI_MODEL
```

The responder also compares its own `PI_MODEL` against `REPO_DIR/.env` and logs a
`WARNING` when they disagree.

## Run

```bash
docker compose up --build -d --wait
```

| Service | URL | Notes |
| --- | --- | --- |
| app | <http://127.0.0.1:8000> | web UI; API at `/api/orders`, health at `/healthz` |
| Grafana | <http://127.0.0.1:3001> | `admin` / `GRAFANA_PASSWORD` (default `admin`) |
| Prometheus | <http://127.0.0.1:9090> | |
| Loki | <http://127.0.0.1:3100> | query UI at `/explore` |
| Tempo | <http://127.0.0.1:3200> | |
| responder | <http://127.0.0.1:8001> | `/healthz`, `/incidents` |
| collector metrics | <http://127.0.0.1:8889> | collector self-metrics only |

Every port is published on `127.0.0.1` only and is overridable:
`ORDER_TRACKER_PORT` (8000), `GRAFANA_PORT` (3000 in compose, 3001 in this fork
because another container holds 3000), `PROMETHEUS_PORT` (9090), `LOKI_PORT`
(3100), `TEMPO_PORT` (3200), `RESPONDER_PORT` (8001), `COLLECTOR_PROM_PORT` (8889).
Grafana's alert-rule deep links are built from `GF_SERVER_ROOT_URL`, which follows
`GRAFANA_PORT`.

Stop with `docker compose down`; add `-v` only to delete order and incident data
too.

## Telemetry

The app emits traces, metrics and logs over OTLP gRPC to
`http://otel-collector:4317` (4318 is the HTTP listener and drops gRPC traffic).
The collector fans out: traces to Tempo, logs to Loki, metrics to Prometheus, with
`job=order-tracker` and the OTLP-normalized metric names
(`http_requests_total`, `http_response_status_code`, `http_route`).

Log lines are JSON with `trace_id` / `span_id`, which is what makes the
log-to-trace jump work. Note that those per-request attributes are Loki
*structured metadata*, not index labels: `{service_name="order-tracker",
trace_id="..."}` as a **selector** returns nothing. Filter them after `| json`:

```logql
{service_name="order-tracker"} | json | http_response_status_code="500"
```

The dashboards in Grafana (`General / Order Tracker`) carry RED metrics, the log
searches and the exemplar link from a latency spike to the trace that caused it.

## The incident, and the responder

The committed `app/main.py` is already **fixed**, so the 5xx alert has nothing to
fire on and a quiet window correctly shows no alert instances. To see the whole
loop you first reintroduce the fault:

```bash
./scripts/reproduce-incident.sh      # patches app/main.py, restarts, asserts 500
```

Within ~30s the rule `order-tracker-5xx` fires
(`sum by (http_route) (increase(http_requests_total{http_response_status_code=~"5.."}[5m])) > 0`,
30s interval), Grafana notifies the webhook contact point
`http://responder:8001/alerts`, and the responder:

1. collects evidence from Prometheus, Loki, Tempo and the app into
   `/incidents/<id>/alert.json` and `evidence.md`
2. launches `pi --print --tools read,grep,find,ls,edit` with
   `incident-response/prompts/investigate.md`
3. diffs the repository before/after to record what the agent really touched
   (`write-scope.json`; anything outside `app/` escalates the incident)
4. probes the endpoint and parses the agent's trailing `VERDICT:` line into
   `recovery.json`

The app is not hot-reloading (`--reload` would look configured and never fire
across a Windows bind mount), so the agent's edit only takes effect after a
restart, and a fresh incident therefore reports `recovered=false` honestly:

```bash
./scripts/restore-fix.sh --force     # puts the committed fix back, asserts 200
curl -s -X POST http://127.0.0.1:8001/incidents/<id>/verify
./runbooks/verify-recovery.sh <id>   # cross-checks responder, Prometheus, probes
```

If the agent's edit was wrong rather than merely unrestarted, roll the file back to
a known-good commit instead of hand-editing it. The runbook needs the commit
explicitly -- it no longer reverts whatever happens to be HEAD -- and leaves the
result staged so a human decides what to commit:

```bash
./runbooks/rollback.sh --dry-run <commit-ish>   # show the diff, write nothing
./runbooks/rollback.sh <commit-ish>
```

Read `incident-response/capability-table.md` and `autonomy-policy.yaml` before
describing what the responder can do: it cannot run tests, commit, push or restart
anything, and the docs are written so that claim cannot creep back in.

## Tests and checks

```bash
.venv/bin/python -m pytest tests/ -q      # or: uv run --frozen pytest -q
node --check incident-response/responder.mjs
bash -n scripts/*.sh runbooks/*.sh
docker compose exec -T prometheus promtool check config /etc/prometheus/prometheus.yaml
# the alert rule as Grafana actually loaded it, with per-instance state
curl -su admin:admin http://127.0.0.1:3001/api/prometheus/grafana/api/v1/rules \
  | python3 -c "import json,sys; [print(r['name'], r['state'], [(a['labels'].get('http_route'), a['state']) for a in r.get('alerts', [])]) for g in json.load(sys.stdin)['data']['groups'] for r in g['rules']]"
```

There is no `grafana cli ... listing-rules` in Grafana 11.5; the endpoint above is
the provisioning-backed Prometheus-compatible rules API.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Web page |
| GET | `/healthz` | Database health check |
| GET | `/api/orders` | List orders |
| POST | `/api/orders` | Create an order |
| GET | `/api/orders/{id}` | Check an order |
| PATCH | `/api/orders/{id}` | Change an order status |

The app uses SQLite to keep setup small. Run one app container at a time; the
exercise is about detecting and handling an incident, not scaling the database.
