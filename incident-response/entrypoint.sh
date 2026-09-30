#!/bin/sh
# The pi config dir arrives as a read-only bind mount. pi rewrites parts of it
# at startup (settings.json.lock, sessions, run-history) and, when it cannot, it
# fails to load models.json and then reports "No API key found for the selected
# model" even though models.json holds a valid key. So the config has to land on
# a writable filesystem.
#
# Copy only the small files pi needs rather than the whole directory: the real
# ~/.pi/agent is ~277MB (sessions and npm packages dominate) and copying that
# from a Windows bind mount stalls the container for minutes.
set -eu

SRC="${PI_AGENT_MOUNT:-/opt/pi-agent}"
DST="/root/.pi/agent"
WANT="models.json models-store.json settings.json trust.json auth.json web-search.json"

if [ -d "$SRC" ]; then
  mkdir -p "$DST"
  copied=""
  for f in $WANT; do
    if [ -f "$SRC/$f" ]; then
      cp "$SRC/$f" "$DST/$f" 2>/dev/null || true
      copied="$copied $f"
    fi
  done
  mkdir -p "$DST/sessions"
  export PI_CODING_AGENT_DIR="$DST"
  echo "[entrypoint] pi config copied to $DST:${copied:- NOTHING}"
  [ -f "$DST/models.json" ] || {
    echo "[entrypoint] FATAL: models.json missing from $SRC; agent cannot authenticate" >&2
    exit 1
  }
else
  echo "[entrypoint] FATAL: no pi config at $SRC; agent calls cannot authenticate" >&2
  exit 1
fi

export PI_CODING_AGENT_SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-/tmp/pi-sessions}"
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0

# The repository's .env is the file an operator edits, so it has to be what the
# agent actually runs on. Compose interpolation gives an already-exported shell
# variable precedence over .env, and on Windows+WSL Windows environment variables
# leak into WSL, so an old PI_MODEL from an unrelated project quietly replaced the
# value in .env and the container ran a model nobody selected (issue #8).
# Re-read the file here and let it win, naming the value it displaced.
ENV_FILE="${REPO_DIR:-/work/repo}/.env"
if [ -f "$ENV_FILE" ]; then
  for key in PI_PROVIDER PI_MODEL; do
    val=$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -1 | tr -d '\r' | sed "s/^[\"']//; s/[\"']$//")
    [ -n "$val" ] || continue
    cur=$(eval "printf %s \"\${$key:-}\"")
    if [ -n "$cur" ] && [ "$cur" != "$val" ]; then
      echo "[entrypoint] $key: using \"$val\" from $ENV_FILE, ignoring ambient \"$cur\""
    fi
    export "$key=$val"
  done
else
  echo "[entrypoint] note: no $ENV_FILE; PI_PROVIDER/PI_MODEL come from the environment only"
fi

# Fail fast on a provider/model pair that is not in the mounted models.json.
# A stale PI_MODEL in .env otherwise shows up only as an opaque agent failure
# after the alert has already been consumed.
if [ -n "${PI_PROVIDER:-}" ]; then
  node -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync(process.env.PI_CODING_AGENT_DIR + "/models.json", "utf8"))
      .providers?.[process.env.PI_PROVIDER];
    if (!p) { console.error(`[entrypoint] FATAL: provider ${process.env.PI_PROVIDER} not in models.json`); process.exit(1); }
    if (!p.apiKey) console.error("[entrypoint] WARNING: provider has no apiKey field");
    const ids = (p.models || []).map((m) => m.id);
    const want = process.env.PI_MODEL || "";
    if (want && ids.includes(want)) {
      console.log(`[entrypoint] agent model ok: ${process.env.PI_PROVIDER}/${want}`);
    } else {
      console.error(`[entrypoint] FATAL: PI_MODEL "${want}" not offered by ${process.env.PI_PROVIDER}; available: ${ids.join(", ")}`);
      process.exit(1);
    }
  ' || exit 1
fi

exec "$@"
