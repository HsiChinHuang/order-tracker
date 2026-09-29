#!/usr/bin/env bash
# Put back the committed fix and restart the app.
set -euo pipefail

cd "$(dirname "$0")/.."

git diff --quiet app/main.py && { echo "app/main.py already clean"; } || {
  git checkout -- app/main.py
  echo "restored app/main.py from HEAD"
}

docker compose up -d --force-recreate app
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 http://localhost:8000/healthz || true)
  [ "$code" = "200" ] && break
  sleep 2
done
curl -s -o /dev/null -w '  GET /api/orders/express-1002 -> %{http_code}\n' \
  http://localhost:8000/api/orders/express-1002
