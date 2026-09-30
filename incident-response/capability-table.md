# Capability Table: Incident Responder

## What this component actually is

A Node HTTP server (`incident-response/responder.mjs`, image `node:24-slim`) that
receives Grafana alert webhooks on `/alerts`, collects evidence over HTTP from the
telemetry backends, and then launches `pi` in print mode as the investigating
agent. Everything below was checked against the running container rather than
copied from a design doc; see the commands in each section.

## The one sentence that matters

The responder can collect and judge. The **agent** can only read files and edit
files under `app/`. It has no shell, so it cannot run tests, commit, push, restart
containers, or issue HTTP requests. An earlier version of this table claimed all of
those; `autonomy-policy.yaml` now records what is enforced and what is not.

## Capabilities

| Capability | Who does it | How | Boundary |
|---|---|---|---|
| Receive alerts | responder | `POST /alerts` from the Grafana webhook contact point | loopback-published port |
| Deduplicate | responder | alertname + `http_route` label, `AGENT_COOLDOWN_MS` (default 15 min) | in-memory; only the incident index is rebuilt at boot, so the cooldown resets on restart (#8) |
| Collect evidence | responder | `fetch` against `http://prometheus:9090`, `http://loki:3100`, `http://tempo:3200`, `http://app:8000` | write to `/incidents/<id>/` |
| Investigate | agent (`pi`) | `read`, `grep`, `find`, `ls`, `edit` | no bash, no network |
| Edit code | agent | `edit` tool | prompt says `app/` only; **audited** by responder afterwards |
| Decide an outcome | responder | parses the trailing `VERDICT:` line + write-scope audit + probes | see `response.schema.json` |
| Verify recovery | responder | probes `standard-1001`, `express-1002`, `standard-1003` | `recovered` requires a real 2xx/3xx (#5) |
| Restart the app | **nobody** | manual `docker compose restart app` | the agent cannot do this, so recovery right after an edit is expected to read "not yet" |
| Commit the fix | **nobody** | manual | no `git` in the image |
| Run tests | **nobody** | manual `.venv/bin/python -m pytest` | no `pytest`/`python3` in the image |

## Artifacts per incident (`/incidents/<id>/`, the `incidents` volume)

| File | Written by | Contents |
|---|---|---|
| `alert.json` | responder | the raw Grafana webhook payload, including the resolved `endpoint` annotation |
| `evidence.md` | responder | 5xx increase, matching Loki log lines, trace lookups, live endpoint probes |
| `agent_response.md` | agent | the agent's stdout, expected to end in a `VERDICT:` line |
| `write-scope.json` | responder | before/after tree diff: `changed`, `added`, `removed`, `allowed`, `outside` |
| `recovery.json` | responder | probe results, `indeterminate`, parsed verdict, the `response.schema.json` object |

## HTTP surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | liveness, echoes the configured `AGENT_CMD` |
| GET | `/incidents` | index of incidents, rebuilt from the volume at boot |
| GET | `/incidents/{id}` | one record including its `writeScope` |
| POST | `/alerts` | Grafana contact point target |
| POST | `/incidents/{id}/verify` | re-run the probes; this is how you confirm recovery after restarting the app |

## Verify for yourself

Run these from the host, not inside the container -- that is the whole point:

```bash
# no shell tools, no test runner, no git inside the responder
docker compose exec responder sh -c 'for b in git curl docker python3 pytest; do command -v $b || echo "$b MISSING"; done'
# agent tool grant
grep -n AGENT_TOOLS compose.yaml
# what an actual run left behind
docker compose exec responder ls /incidents/<id>
```

## Autonomy levels

Retained as a maturity vocabulary, but only level 2 is implemented, and levels 0
and 1 are narrower than they sound: "verify" means HTTP probes, not tests.

| Level | Description | Requires Human Approval |
|---|---|---|
| 0 - Observe | collect evidence, write artifacts | No |
| 1 - Verify | HTTP probe the affected endpoint (not a test suite) | No |
| 2 - Fix | edit under `app/`; audit reports anything else | No |
| 3 - Rollback | `runbooks/rollback.sh`, needs an explicit commit and a human | **Yes** |
| 4 - Critical | schema changes, credential rotation | **Yes** (never attempted) |
