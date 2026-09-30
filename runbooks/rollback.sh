#!/usr/bin/env bash
# runbooks/rollback.sh - Revert app/main.py to a known-good commit.
#
# The previous version ran `git revert --no-edit HEAD 2>/dev/null || echo "No
# commit to revert"` with no argument. That is wrong in two ways: HEAD is
# whatever commit happens to be on top -- which in this repo is a telemetry
# submission, not an incident fix -- so a blind revert would undo the wrong
# change; and redirecting git's stderr to /dev/null then printing a cheerful
# fallback turned a genuine conflict into a success message.
#
# It now requires the commit to roll back TO, restricts itself to app/main.py,
# and fails loudly.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_PORT="${ORDER_TRACKER_PORT:-8000}"
BASE="http://localhost:${APP_PORT}"
TARGET=app/main.py

die() { echo "FAIL: $*" >&2; exit 1; }

usage() {
  cat >&2 <<USAGE
usage: runbooks/rollback.sh [--dry-run] <commit-ish>

Rolls $TARGET back to its content at <commit-ish> and leaves the result
staged-but-uncommitted so a human decides what to commit. It does NOT run
git revert and it does NOT touch any other path.

  --dry-run   show what would change and exit without writing
USAGE
  exit 2
}

DRY=""
case "${1:-}" in
  --dry-run) DRY=1; shift ;;
esac
[ $# -eq 1 ] || usage
REF="$1"

git rev-parse --verify "${REF}^{commit}" >/dev/null 2>&1 ||
  die "$REF is not a commit"
git cat-file -e "${REF}:${TARGET}" 2>/dev/null ||
  die "$TARGET does not exist at $REF; refusing to blank out the file"

echo "=== Rollback Runbook ==="
echo "target file: $TARGET"
echo "restoring content from: $(git rev-parse --short "$REF") ($(git log -1 --format=%s "$REF"))"

if [ -n "$(git status --porcelain -- "$TARGET")" ]; then
  echo "note: $TARGET has uncommitted changes; a stash copy is taken first"
fi

if [ -n "$DRY" ]; then
  echo "--- dry run: diff that would be applied ---"
  git --no-pager diff "$REF" -- "$TARGET" || true
  echo "--- nothing written (--dry-run) ---"
  exit 0
fi

git stash push -- "$TARGET" >/dev/null 2>&1 || true
# Show, do not hide: a conflict or an unreadable blob must stop this script, not
# be swallowed into a reassuring message.
if ! git checkout "$REF" -- "$TARGET"; then
  die "checkout of $TARGET from $REF failed; the working tree is unchanged, see messages above"
fi
echo "restored $TARGET from $REF (previous working copy is in 'git stash')"

# Resolve a docker CLI that actually works -- see scripts/lib-docker.sh.
# shellcheck source=../scripts/lib-docker.sh
. "$(dirname "$0")/../scripts/lib-docker.sh"
if ! docker_resolve; then
  echo "FATAL: no working docker CLI (probed docker, docker.exe, cmd.exe /c docker, powershell.exe docker)." >&2
  echo "On WSL this usually means Docker Desktop's WSL integration is off: the docker on PATH is a stub that always exits 1." >&2
  exit 1
fi

echo "restarting app on the rolled-back code..."
if ! restart_out=$(docker_run compose up -d --no-deps --force-recreate app 2>&1); then
  echo "$restart_out" >&2
  die "restart failed; file is rolled back but the container may still run the old code"
fi

for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "$BASE/healthz" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || die "app did not become healthy after rollback"

post=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/api/orders/express-1002" || echo 000)
echo "  GET /api/orders/express-1002 -> $post"
if [ "$post" = "200" ]; then
  echo "rollback applied and the app serves it. Commit or discard with git."
else
  echo "WARNING: app is healthy but the failing order returned $post, so $REF is not a known-good state."
  exit 1
fi
