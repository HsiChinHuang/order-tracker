#!/bin/bash
set -euo pipefail

# runbooks/verify-recovery.sh - Verify that the app has recovered after a fix

echo "=== Verify Recovery Runbook ==="

# 1. Health check
echo "1. Running health check..."
HEALTH=$(curl -sf http://localhost:8000/healthz 2>/dev/null || echo '{"status":"error"}')
echo "   Health: $HEALTH"

# 2. List orders
echo "2. Checking orders endpoint..."
ORDERS=$(curl -sf http://localhost:8000/api/orders 2>/dev/null || echo "[]")
echo "   Orders count: $(echo "$ORDERS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "unknown")"

# 3. Test order lookup for all orders
echo "3. Testing order lookup for each order..."
for order_id in $(echo "$ORDERS" | python3 -c "import sys,json; [print(o['id']) for o in json.load(sys.stdin)]" 2>/dev/null); do
  STATUS=$(curl -sf "http://localhost:8000/api/orders/$order_id" -w "%{http_code}" -o /dev/null 2>/dev/null || echo "000")
  echo "   Order $order_id: HTTP $STATUS"
done

# 4. Check for 5xx errors in metrics
echo "4. Checking Prometheus for 5xx errors..."
FIVEXX=$(curl -sf "http://localhost:9090/api/v1/query?query=sum(rate(http_requests_total{status_code=~\"5..\"}[5m]))" 2>/dev/null || echo '{"data":{"result":[]}}')
echo "   5xx rate: $FIVEXX"

echo "=== Recovery verification complete ==="
