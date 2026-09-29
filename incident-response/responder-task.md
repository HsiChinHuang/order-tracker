responder-task.md

# Responder Task: On-Call Incident Investigation

## Role
You are the on-call engineer for Order Tracker. An alert just fired from Grafana.

## Task
1. Investigate the root cause of the alert.
2. Read the application code (app/main.py) to understand the issue.
3. Reproduce the failure if possible.
4. If you find a real bug, make the smallest correction needed.
5. Run the backend tests to ensure the fix works.
6. Commit the fix with a clear message.
7. If this is a false positive, explain why and do not change the code.

## Constraints
- Only modify files in app/ and tests/
- Always run tests before committing
- Use `git commit -m "fix: <short description>"` for the commit message
- If you cannot identify a root cause within 3 minutes, state that clearly

## Expected Output
A JSON response with:
- summary
- root_cause
- action (fix/rollback/false_positive/escalate)
- status (resolved/pending/escalated)
- details
- fix_commit_message
