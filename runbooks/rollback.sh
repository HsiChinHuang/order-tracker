#!/bin/bash
set -euo pipefail

# runbooks/rollback.sh - Rollback the app to the previous committed version

echo "=== Rollback Runbook ==="

# 1. Check current status
echo "Checking health before rollback..."
curl -sf http://localhost:8000/healthz || echo "App is not healthy"

# 2. Revert to the previous commit
echo "Reverting to previous commit..."
git revert --no-edit HEAD 2>/dev/null || echo "No commit to revert (using current code)"

# 3. Rebuild and redeploy
echo "Rebuilding and redeploying..."
docker compose up --build -d --wait app

# 4. Verify recovery
echo "Verifying recovery..."
sleep 5
HEALTH=$(curl -sf http://localhost:8000/healthz 2>/dev/null || echo '{"status":"error"}')
echo "Health after rollback: $HEALTH"

if echo "$HEALTH" | grep -q '"ok"'; then
  echo "✅ Rollback successful - app is healthy"
else
  echo "⚠️  Rollback may not have resolved the issue"
fi
