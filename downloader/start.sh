#!/bin/sh
set -eu

echo "[bgutil] starting provider on 127.0.0.1:4416"
node /opt/bgutil-ytdlp-pot-provider/server/build/main.js &
provider_pid=$!
trap 'kill "$provider_pid" 2>/dev/null || true' TERM INT EXIT

ready=0
for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:4416/ping >/dev/null 2>&1; then
        echo "[bgutil] provider ready on 127.0.0.1:4416"
        ready=1
        break
    fi
    if ! kill -0 "$provider_pid" 2>/dev/null; then
        echo "[bgutil] provider exited during startup" >&2
        wait "$provider_pid" || true
        exit 1
    fi
    sleep 1
done

if [ "$ready" -ne 1 ]; then
    echo "[bgutil] provider did not become ready within 30s" >&2
    exit 1
fi

exec node /app/server.js
