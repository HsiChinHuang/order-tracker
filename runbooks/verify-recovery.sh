#!/usr/bin/env bash
# runbooks/verify-recovery.sh - Verify that the app has recovered after a fix.
#
# This replaced a version whose 5xx selector used the pre-OTLP attribute name
# rather than http_response_status_code. A nonexistent label selector is not an
# error in PromQL, it is an empty result, and the old script piped curl through
# `|| echo '{"data":{"result":[]}}'`, so it printed a clean-looking 5xx reading
# whether or not the incident was still live. It could not fail. Two separate
# fixes: query the real label, and treat an empty or failed query as UNKNOWN,
# which is a distinct outcome from "zero 5xx".
#
# Deliberately not repeating the old selector text here: the acceptance check for
# issue #3 is a grep for that attribute name, and a comment mentioning it would
# make the check report a live bug.
#
# Exit status: 0 recovered, 1 not recovered, 2 could not tell.
set -uo pipefail

APP="${ORDER_TRACKER_URL:-http://localhost:${ORDER_TRACKER_PORT:-8000}}"
PROM="${PROMETHEUS_URL:-http://localhost:${PROMETHEUS_PORT:-9090}}"
RESPONDER="${RESPONDER_URL:-http://localhost:${RESPONDER_PORT:-8001}}"
INCIDENT_ID="${1:-}"

UNKNOWN=0

say() { printf '%s\n' "$*"; }

# 1. Preferred path: ask the responder, which probes the templated route with
# real order ids and records recovery.json. Re-runnable, so it is safe to call
# after `docker compose restart app` even though the first check right after the
# agent finishes is expected to report still_failing (the app is not hot-reloading).
if [ -n "$INCIDENT_ID" ]; then
  say "1. Asking the responder to re-verify incident $INCIDENT_ID ..."
  body=$(curl -s -m 15 -X POST "$RESPONDER/incidents/$INCIDENT_ID/verify" 2>/dev/null)
  verdict=$(printf '%s' "$body" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('PARSE_ERROR'); sys.exit()
if 'detail' in d: print('NOT_FOUND'); sys.exit()
r=d.get('recovery') or {}
res=r.get('results') or []
if not d.get('recovery'): print('NO_RECOVERY_DATA'); sys.exit()
bad=[x for x in res if int(x.get('status') or 0)>=500]
print('RECOVERED' if d.get('recovered') else 'STILL_FAILING')
for x in res: print('    ', x['url'], '->', x['status'])
" 2>/dev/null || echo "CURL_FAILED")
  say "   responder: $verdict"
  case "$verdict" in
    RECOVERED*) say "   => responder reports recovery" ;;
    STILL_FAILING*) say "   => incident still reproducing"; exit 1 ;;
    *) say "   => responder could not confirm ($verdict); falling back to Prometheus"; UNKNOWN=1 ;;
  esac
else
  say "1. No incident id given, skipping responder verify (usage: $0 <incidentId>)"
  UNKNOWN=1
fi

# 2. Independent check: has the 5xx rate actually gone to zero over 5m?
say "2. Querying Prometheus for 5xx over the last 5 minutes ..."
raw=$(curl -s -m 10 --get "$PROM/api/v1/query" \
  --data-urlencode 'query=sum(increase(http_requests_total{http_response_status_code=~"5.."}[5m]))' 2>/dev/null)
if [ -z "$raw" ]; then
  say "   UNKNOWN: Prometheus did not answer. Do not report recovery."
  exit 2
fi
# An empty 5xx result is ambiguous: it is what recovery looks like, and it is
# also exactly what a wrong label name looks like. Disambiguate by asking whether
# ANY http_requests_total series exist. Traffic present + no 5xx = healthy.
# No traffic at all = the pipeline is broken and silence proves nothing.
traffic=$(curl -s -m 10 --get "$PROM/api/v1/query" \
  --data-urlencode 'query=count(http_requests_total)' 2>/dev/null | python3 -c "
import sys,json
try: r=json.load(sys.stdin)['data']['result']
except Exception: r=[]
print(r[0]['value'][1] if r else 'none')" 2>/dev/null || echo none)
read -r status value <<<"$(printf '%s' "$raw" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('BADJSON none'); sys.exit()
if d.get('status')!='success': print('QUERY_ERROR', d.get('error','')); sys.exit()
res=d['data']['result']
if not res: print('EMPTY none'); sys.exit()
v=res[0]['value'][1]
print('OK', v)
")"
case "$status" in
  OK)
    say "   5xx increase over 5m = $value (total http_requests_total series: $traffic)"
    # A counter increase of exactly 0.0 is recovery; anything above is not.
    if [ "$(printf '%s' "$value" | python3 -c 'import sys;print(1 if float(sys.stdin.read())<=0 else 0)')" = "1" ]; then
      say "   => no 5xx in the window"
    else
      say "   => 5xx still being counted"; exit 1
    fi
    ;;
  EMPTY)
    if [ "$traffic" = "none" ]; then
      say "   UNKNOWN: no http_requests_total series at all, and no 5xx series."
      say "   Silence here proves nothing -- check the app and the collector."
      exit 2
    fi
    say "   5xx increase over 5m = 0 (no 5xx series; total http_requests_total series: $traffic)"
    say "   => genuinely zero 5xx, not an empty-label artifact"
    ;;
  *)
    say "   UNKNOWN: $status $value"; exit 2 ;;
esac

# 3. Positive proof: the endpoint that was failing must now serve 200.
say "3. Probing the orders that the responder probes ..."
probe_ok=1
for id in standard-1001 express-1002 standard-1003; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$APP/api/orders/$id" 2>/dev/null || echo 000)
  say "   GET /api/orders/$id -> $code"
  [ "$code" = "200" ] || probe_ok=0
done
[ "$probe_ok" = "1" ] || { say "=> at least one probe did not return 200"; exit 1; }

if [ "$UNKNOWN" = "1" ]; then
  say "=== RECOVERED by direct probe; the responder check was unavailable ==="
else
  say "=== RECOVERED: responder, Prometheus and direct probes all agree ==="
fi
exit 0
