#!/bin/sh
# Compose smoke test (CI: Linux only; needs Docker). Runs the demo stack and the redis profile to completion.
# The traffic job fails when the replay does not print its report, so a green run means: mock, gateway, traffic, trace
# export and policy replay all worked inside the read-only image.
set -eu
cd "$(dirname "$0")/.."
out=$(mktemp)
cleanup() {
  docker compose --profile redis --profile otel down -v >/dev/null 2>&1 || true
  rm -f "$out"
}
trap cleanup EXIT

docker compose up --build --abort-on-container-exit --exit-code-from traffic 2>&1 | tee "$out"
grep -q "tokenyard policy replay" "$out"
docker compose down -v

# Two replicas with distinct instance ids share budgets through Redis; the replay reads the merged export of both.
docker compose --profile redis up --abort-on-container-exit --exit-code-from traffic 2>&1 | tee "$out"
grep -q "tokenyard policy replay" "$out"
# Read from the stopped containers' logs: live attach can miss a line printed before it.
logs=$(docker compose --profile redis logs tokenyard tokenyard-2)
echo "$logs" | grep -q "counter store redis (tokenyard-1)"
echo "$logs" | grep -q "counter store redis (tokenyard-2)"
grep -q "from 2 instance(s)" "$out"
echo "compose smoke: ok"
