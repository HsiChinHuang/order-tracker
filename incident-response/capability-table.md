# Capability Table: Incident Responder

## Overview

The incident responder is a bounded, read-only first responder that runs a coding agent (Codex or Claude Code) in headless mode when a Grafana alert fires.

## Capabilities

| Capability | Description | Permission |
|---|---|---|
| Receive alerts | Accepts webhook POST to `/alerts` from Grafana | Read |
| Collect evidence | Runs read-only queries against app API, Prometheus, Loki, Tempo | Read |
| Inspect codebase | Reads source code in the repository | Read |
| Run tests | Runs `pytest` to verify current state | Read |
| Propose fix | Can commit minimal code changes | Write (allowlisted) |
| Rollback | Can revert to a known good commit | Write (allowlisted) |
| Restart app | Can restart the Docker Compose stack | Write (allowlisted) |

## Autonomy Levels

| Level | Description | Requires Human Approval |
|---|---|---|
| 0 - Observe | Collect evidence, generate report | No |
| 1 - Verify | Run tests, verify recovery | No |
| 2 - Fix | Commit and push minimal fix | No |
| 3 - Rollback | Revert to previous version | No |
| 4 - Critical | Database changes, credential rotation | **Yes** |

## Allowed Actions (Allowlist)

```yaml
allowed_commands:
  - pytest
  - git add
  - git commit
  - git push
  - docker compose up --build -d --wait
  - docker compose restart
  - curl http://localhost:8000/healthz
  - curl http://localhost:9090/api/v1/query
  - curl http://localhost:8000/api/orders/*
```

## Escalation Policy

- Any action not in the allowlist → escalate to human
- Any action requiring level 4 autonomy → escalate to human
- If the responder cannot identify a root cause within 3 minutes → escalate
- If the fix causes test failures → revert and escalate
