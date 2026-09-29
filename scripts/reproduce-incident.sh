#!/usr/bin/env bash
# Reintroduce the express estimated_delivery fault on purpose.
#
# The bug is fixed in the tracked app/main.py, so the 5xx alert has nothing to
# fire on and the responder has nothing to investigate. Run this before testing
# the alert -> webhook -> agent -> recovery loop, and run
# scripts/restore-fix.sh afterwards.
#
# It patches the working tree only; nothing here is committed.
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET=app/main.py
GOOD='        estimated_at = placed_at + timedelta(days=2)'
BAD='        estimated_at = placed_at.replace(day=placed_at.day + 2)'

if grep -qF "$BAD" "$TARGET"; then
  echo "already broken: $TARGET"
else
  grep -qF "$GOOD" "$TARGET" || {
    echo "expected line not found in $TARGET; refusing to guess" >&2
    exit 1
  }
  python3 - "$TARGET" "$GOOD" "$BAD" <<'PY'
import sys
path, good, bad = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
open(path, "w").write(src.replace(good, bad, 1))
PY
  echo "patched $TARGET (bug reintroduced)"
fi

echo "restarting app so it imports the patched module..."
docker compose up -d --force-recreate app

for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://localhost:8000/healthz || true)
  [ "$code" = "200" ] && break
  sleep 2
done

echo "now hitting the order that fails:"
curl -s -o /dev/null -w '  GET /api/orders/express-1002 -> %{http_code}\n' \
  http://localhost:8000/api/orders/express-1002
echo "the 5xx series should appear in Prometheus within ~30s; the alert evaluates every 30s."
