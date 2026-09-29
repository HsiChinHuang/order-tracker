#!/bin/bash
# collect-evidence.sh - Collect evidence for an incident
# Usage: ./collect-evidence.sh <INCIDENT_ID>

set -euo pipefail

INCIDENT_ID="${1:-$(date +%Y%m%d-%H%M%S)}"
EVIDENCE_DIR="incidents/${INCIDENT_ID}"
mkdir -p "$EVIDENCE_DIR"

echo "Collecting evidence for incident: ${INCIDENT_ID}"
echo "=== Health Check ==="
curl -sf http://localhost:8000/healthz > "$EVIDENCE_DIR/healthz.json" 2>&1 || echo '{"status":"error","detail":"App unreachable"}' > "$EVIDENCE_DIR/healthz.json"

echo "=== Orders ==="
curl -sf http://localhost:8000/api/orders > "$EVIDENCE_DIR/orders.json" 2>&1 || echo '[]' > "$EVIDENCE_DIR/orders.json"

echo "=== App Logs (last 100 lines) ==="
docker compose logs --tail=100 app > "$EVIDENCE_DIR/app-logs.txt" 2>&1 || echo "Cannot collect logs" > "$EVIDENCE_DIR/app-logs.txt"

echo "=== Prometheus Query (5xx rate) ==="
curl -sf "http://localhost:9090/api/v1/query?query=sum(rate(http_requests_total{status_code=~\"5..\"}[5m]))" > "$EVIDENCE_DIR/prometheus-5xx.json" 2>&1 || echo "Cannot query Prometheus" > "$EVIDENCE_DIR/prometheus-5xx.json"

echo "=== All evidence collected in ${EVIDENCE_DIR}/"
ls -la "$EVIDENCE_DIR/"
