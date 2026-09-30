#!/usr/bin/env bash
# Put back the committed fix and restart the app.
#
# The previous version ran `git checkout -- app/main.py` unconditionally. That
# discards the working copy with no undo, and it did exactly that during testing:
# an uncommitted rewrite of the responder-side app changes was destroyed and had
# to be reconstructed from the running container. Restore is a destructive
# operation, so it now refuses unless app/main.py matches HEAD or --force is
# given, and it verifies the app really serves the fix afterwards.
set -euo pipefail

cd "$(dirname "$0")/.."

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
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

fail() { echo "FAIL: $*" >&2; exit 1; }

if [ -n "$(git status --porcelain -- "$TARGET" 2>/dev/null)" ]; then
  if [ "$FORCE" = 1 ]; then
    echo "app/main.py has uncommitted changes and --force was given: discarding them."
    git stash push -- "$TARGET" >/dev/null 2>&1 &&
      echo "  (a copy is recoverable with: git stash pop)" ||
      echo "  WARNING: could not stash; the discarded content is unrecoverable"
    git checkout -- "$TARGET"
    echo "restored app/main.py from HEAD"
  else
    echo "app/main.py differs from HEAD. Refusing to discard it silently." >&2
    echo "If you really mean to throw those edits away, re-run with --force" >&2
    echo "(it stashes first, so the content stays recoverable)." >&2
    git --no-pager diff --stat -- "$TARGET" >&2 || true
    exit 1
  fi
else
  echo "app/main.py already matches HEAD"
fi

grep -qF "$GOOD" "$TARGET" ||
  fail "the committed fix line is not present in $TARGET after restoring; HEAD does not contain the fix -- do not trust this restore"
echo "fix line present in $TARGET"

# Capture the restart output rather than dropping it: a restart that fails while
# the file on disk is already correct is the dangerous state, and it needs to be
# readable.
if ! restart_out=$(docker_run compose up -d --no-deps --force-recreate app 2>&1); then
  echo "$restart_out" >&2
  fail "restart failed; app/main.py is correct on disk but the running container may still serve the fault"
fi

for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$BASE/healthz" || true)
  [ "$code" = "200" ] && break
  sleep 2
done

post=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/api/orders/express-1002" || echo 000)
echo "  GET /api/orders/express-1002 -> $post"
[ "$post" = "200" ] || fail "expected 200 from /api/orders/express-1002 after restore, got $post: the fix is on disk but the running app still fails"

echo "fix restored and the app is serving it."
