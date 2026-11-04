#!/bin/sh
# Traffic job of the compose demo: wait for the gateway replicas, send the synthetic coding-agent traffic, merge the
# traces of every replica into one export, then replay the demo PR policy change against it and write the HTML report.
set -eu

TY="node /app/bin/tokenyard.mjs"
out=/var/lib/tokenyard/export
mkdir -p "$out"

urls="http://tokenyard:4000"
ready="http://tokenyard:9464/readyz"
if getent hosts tokenyard-2 >/dev/null 2>&1; then
  urls="$urls http://tokenyard-2:4000"
  ready="$ready http://tokenyard-2:9464/readyz"
fi
for u in $ready; do
  until node -e "fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" "$u"; do sleep 1; done
done

start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# shellcheck disable=SC2086
$TY traffic --gateway-url $urls
sleep 3 # the gateways write traces asynchronously
$TY traces export --trace-dir /var/lib/tokenyard/traces --out "$out/demo.ndjson.gz" --since "$start"
set +e
$TY policy replay --base-dir /app/deploy/demo/base --head /app/deploy/demo/head --traces "$out/demo.ndjson.gz" > "$out/replay.txt"
set -e
cat "$out/replay.txt" # a failed ci.failOn gate (exit 1) is a result of the demo PR, not an error of this job
grep -q "tokenyard policy replay" "$out/replay.txt"
$TY report --traces "$out/demo.ndjson.gz" --by team --since "$start" --html "$out/report.html"
echo "tokenyard demo: done. Export, replay.txt and report.html are in the tokenyard-data volume under export/."
