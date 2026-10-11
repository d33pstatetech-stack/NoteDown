#!/usr/bin/env bash
# End-to-end tests against a real Worker (real workerd, real D1, real R2).
#
# Two suites run here:
#   live-sync    — browser device (IndexedDB) <-> cloud <-> second device
#   desktop-sync — desktop device (real Rust SQLite core) <-> cloud <-> second
#
# Unlike `pnpm test`, nothing is mocked: the Worker, its database and its object
# store are all real. Run this after changing the sync protocol, the storage
# adapters or the Worker.
set -euo pipefail

cd "$(dirname "$0")/.."

API_URL="${E2E_API_URL:-http://127.0.0.1:8787}"
ORIGIN="${E2E_ORIGIN:-http://localhost:5173}"

# The Rust bridge drives the same `notes-store` crate the desktop app ships, so
# the desktop suite covers the actual storage implementation rather than a
# JavaScript stand-in. It intentionally does not depend on Tauri.
if [ -z "${E2E_SQLITE_BRIDGE:-}" ]; then
  echo "==> building the SQLite bridge"
  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-target-e2e}" cargo build \
    --release --manifest-path tests/e2e/bridge/Cargo.toml
  if [ -n "$(uname 2>/dev/null || echo windows)" ] || [ "$(uname -s 2>/dev/null || echo MINGW)" != "Darwin" ]; then
    E2E_SQLITE_BRIDGE="$(pwd)/${CARGO_TARGET_DIR:-target-e2e}/release/sqlite-bridge.exe"
  else
    E2E_SQLITE_BRIDGE="$(pwd)/${CARGO_TARGET_DIR:-target-e2e}/release/sqlite-bridge"
  fi
fi

# Start the Worker unless one is already listening, so the script works both
# standalone and against an already-running dev server.
if ! curl -sf "${API_URL}/api/health" >/dev/null 2>&1; then
  echo "==> starting the Worker on ${API_URL}"
  pnpm --filter @notedown/worker dev >/tmp/notedown-e2e-worker.log 2>&1 &
  WORKER_PID=$!
  trap 'kill ${WORKER_PID} 2>/dev/null || true' EXIT
  for _ in $(seq 1 60); do
    curl -sf "${API_URL}/api/health" >/dev/null 2>&1 && break
    sleep 1
  done
fi

echo "==> running end-to-end tests against ${API_URL}"
E2E_API_URL="${API_URL}" \
E2E_ORIGIN="${ORIGIN}" \
E2E_SQLITE_BRIDGE="${E2E_SQLITE_BRIDGE}" \
  pnpm exec vitest run --config tests/e2e/vitest.config.ts "$@"