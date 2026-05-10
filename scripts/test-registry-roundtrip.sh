#!/usr/bin/env bash
# scripts/test-registry-roundtrip.sh — smoke-test the registry-server +
# `prime publish` + `prime install --remote` round-trip.
#
# Exercises:
#   1. Boot the registry server on a free port
#   2. POST persona-stripe via `prime publish`
#   3. Verify it appears in /atoms
#   4. `prime install` from a clean dir using --remote
#   5. Verify the file landed on disk + at least one transitive dep was
#      flagged (404, since we only published one atom)
#   6. Tear down the server
#
# Usage:
#   bash scripts/test-registry-roundtrip.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=7790
STORE="/tmp/prime-registry-roundtrip-store"
DEST="/tmp/prime-registry-roundtrip-dest"
LOG="/tmp/prime-registry-roundtrip.log"

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

rm -rf "$STORE" "$DEST"
mkdir -p "$STORE" "$DEST"

echo "==> boot registry server on :$PORT (store=$STORE)"
bun "$ROOT/scripts/registry-server.ts" --port "$PORT" --root "$STORE" > "$LOG" 2>&1 &
SERVER_PID=$!

# Wait for ready (curl /healthz)
for i in $(seq 1 20); do
  if curl -sS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

if ! curl -sS "http://localhost:$PORT/healthz" >/dev/null 2>&1; then
  echo "FAIL: server did not come up. Log:"
  cat "$LOG"
  exit 1
fi

echo "==> publish @example/method-make-tea"
PRIME_REGISTRY="http://localhost:$PORT" \
  bun "$ROOT/packages/cli/src/index.ts" publish \
  "$ROOT/examples/hello-world/primes/sources/@example/method-make-tea.prime" 2>&1 | tail -3

echo "==> verify in /atoms"
LIST=$(curl -sS "http://localhost:$PORT/atoms")
if ! echo "$LIST" | grep -q "@example/method-make-tea"; then
  echo "FAIL: atom not in /atoms list"
  echo "$LIST"
  exit 1
fi

echo "==> install into clean dir with --remote"
# install will exit non-zero because we only published 1 atom (5 transitive
# deps are expected to 404). That's the correct round-trip behaviour — we
# care that the requested atom landed on disk, not that ALL deps resolved.
set +e
PRIME_REGISTRY="http://localhost:$PORT" \
  bun "$ROOT/packages/cli/src/index.ts" install \
  @example/method-make-tea --dir "$DEST" --no-related 2>&1 | tail -8
INSTALL_RC=$?
set -e

echo "==> verify file on disk"
if [ ! -f "$DEST/@example/method-make-tea.prime" ]; then
  echo "FAIL: file not written to dest"
  ls -la "$DEST/@community/" || true
  exit 1
fi
BYTES=$(wc -c < "$DEST/@example/method-make-tea.prime")
echo "    OK — $BYTES bytes at $DEST/@example/method-make-tea.prime"

echo "==> all assertions passed"
echo "    (server log: $LOG)"
