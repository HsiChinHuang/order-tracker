#!/usr/bin/env bash
# Reintroduce the express estimated_delivery fault on purpose.
#
# The bug is fixed in the tracked app/main.py, so the 5xx alert has nothing to
# fire on and the responder has nothing to investigate. Run this before testing
# the alert -> webhook -> agent -> recovery loop, and run
# scripts/restore-fix.sh afterwards.
#
# It patches the working tree only; nothing here is committed.
#
# Ordering matters, and getting it wrong cost real debugging time: the previous
# version edited app/main.py FIRST and restarted second. When the restart failed,
# the tree was patched while the running container still served the old code, so
# every request returned 200 and the incident looked like it "would not
# reproduce" -- it had actually never been deployed. Here the toolchain, the
# container and a known-good baseline response are all checked before a single
# byte is written, and the script ends by asserting the fault is live.
set -euo pipefail

cd "$(dirname "$0")/.."

# Docker is not always on PATH in the same shape: in WSL it is often docker.exe
# or has to be reached through cmd.exe. Resolve it once, fail loudly if absent.
# Resolve a docker CLI that actually works -- see scripts/lib-docker.sh for why a
# PATH lookup is not enough here.
# shellcheck source=lib-docker.sh
. "$(dirname "$0")/lib-docker.sh"
if ! docker_resolve; then
  echo "FATAL: no working docker CLI (probed docker, docker.exe, cmd.exe /c docker, powershell.exe docker)." >&2
  echo "On WSL this usually means Docker Desktop's WSL integration is off: the docker on PATH is a stub that always exits 1." >&2
  exit 1
fi

APP_PORT="${ORDER_TRACKER_PORT:-8000}"
BASE="http://localhost:${APP_PORT}"
TARGET=app/main.py
GOOD='        estimated_at = placed_at + timedelta(days=2)'
BAD='        estimated_at = placed_at.replace(day=placed_at.day + 2)'
FAULTY_ORDER=/api/orders/express-1002

fail() { echo "FAIL: $*" >&2; exit 1; }

# --- 1. preflight: only touch the tree once we know a restart is possible -----
docker_run compose version >/dev/null 2>&1 ||
  fail "docker compose is not usable here; refusing to patch app/main.py because the app could not be restarted afterwards"

state=$(docker_run compose ps --format '{{.Name}} {{.State}}' app 2>/dev/null | head -1)
# `docker compose ps --format '{{.State}}'` reports "running", not "Up".
case " ${state} " in
  *" running "*|*" Up "*) echo "preflight: app container is up (${state})" ;;
  *) fail "app container is not running (got '${state:-none}'); refusing to patch app/main.py" ;;
esac

# The compose file hard-requires PI_AGENT_DIR; if it is unset the restart below
# would fail mid-flight. Check the same thing compose would.
docker_run compose config >/dev/null 2>&1 ||
  fail "compose config is invalid (is PI_AGENT_DIR set in the environment or .env?); refusing to patch app/main.py"

# --- 2. baseline: the order must currently succeed, or we prove nothing --------
pre=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE$FAULTY_ORDER" || echo 000)
case "$pre" in
  200) echo "preflight: GET $FAULTY_ORDER -> 200 (baseline is healthy, good)" ;;
  500) echo "preflight: GET $FAULTY_ORDER -> 500 (fault already live)" ;;
  *) fail "GET $FAULTY_ORDER returned $pre before any change; the app is not in a known state, refusing to patch" ;;
esac

# --- 3. patch -----------------------------------------------------------------
if grep -qF "$BAD" "$TARGET"; then
  echo "already broken: $TARGET"
else
  grep -qF "$GOOD" "$TARGET" ||
    fail "expected line not found in $TARGET; refusing to guess at a patch location"
  python3 - "$TARGET" "$GOOD" "$BAD" <<'PY'
import sys
path, good, bad = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
open(path, "w").write(src.replace(good, bad, 1))
PY
  echo "patched $TARGET (bug reintroduced)"
fi

# --- 4. deploy the patch ------------------------------------------------------
echo "restarting app so it imports the patched module..."
# Capture, do not discard. The first real run of this script hit a transient
# Docker Desktop restart failure, and because the previous draft sent the
# restart output to /dev/null there was nothing left to read. On failure the
# output goes to stderr; on success it is dropped.
if ! restart_out=$(docker_run compose up -d --no-deps --force-recreate app 2>&1); then
  echo "$restart_out" >&2
  fail "restart failed AFTER patching: the tree is modified but the old code is running. Fix the restart, or run scripts/restore-fix.sh --force to put app/main.py back."
fi

for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$BASE/healthz" || true)
  [ "$code" = "200" ] && break
  sleep 2
done

# --- 5. assert the incident is actually live ----------------------------------
post=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE$FAULTY_ORDER" || echo 000)
echo "  GET $FAULTY_ORDER -> $post"
[ "$post" = "500" ] || fail "expected 500 from $FAULTY_ORDER after patching, got $post: the fault is NOT live, so no alert will fire. Investigate before blaming the alerting path."

echo
echo "incident is live. The 5xx series appears in Prometheus within ~10s and the"
echo "rule evaluates every 30s, so expect the webhook within ~40s. Restore with:"
echo "  scripts/restore-fix.sh"
