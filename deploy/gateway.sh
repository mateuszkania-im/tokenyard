#!/bin/sh
# Gateway entrypoint of the compose demo.
# Optional companions are picked up by their service name on the compose network: when a service named `redis` resolves
# (profile redis) the gateway uses the Redis counter store, so replicas share budgets; when `otel-collector` resolves
# (profile otel) it exports OTel spans there. Without them it runs standalone on the in-memory store.
set -eu

: "${TOKENYARD_INSTANCE_ID:?set TOKENYARD_INSTANCE_ID}"
: "${TOKENYARD_TRACE_SALT:?set TOKENYARD_TRACE_SALT}"
: "${TOKENYARD_METRICS_TOKEN:?set TOKENYARD_METRICS_TOKEN}"
export TOKENYARD_TRACE_SALT TOKENYARD_METRICS_TOKEN

set -- serve \
  --port 4000 --host 0.0.0.0 \
  --policy /app/deploy/demo/base \
  --state-dir "/var/lib/tokenyard/state/$TOKENYARD_INSTANCE_ID" \
  --trace-dir /var/lib/tokenyard/traces \
  --instance-id "$TOKENYARD_INSTANCE_ID" \
  --metrics-port 9464 --metrics-host 0.0.0.0

if getent hosts redis >/dev/null 2>&1; then
  export TOKENYARD_REDIS_URL=redis://redis:6379
  set -- "$@" --store redis
  echo "tokenyard demo: counter store redis ($TOKENYARD_INSTANCE_ID)" >&2
fi
if getent hosts otel-collector >/dev/null 2>&1; then
  set -- "$@" --otlp-endpoint http://otel-collector:4318
  echo "tokenyard demo: exporting spans to otel-collector ($TOKENYARD_INSTANCE_ID)" >&2
fi
exec node /app/bin/tokenyard.mjs "$@"
