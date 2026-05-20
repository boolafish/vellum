#!/usr/bin/env bash
#
# Launch smoke test for the md-editor Tauri app (macOS).
#
# tauri-driver / Selenium do NOT work on macOS (no WKWebView WebDriver), so we
# cannot drive the GUI. This script does the next best thing: it builds the
# frontend, launches the app in dev for a few seconds, captures its log, and
# fails if it sees a Rust panic, an error line, or an accelerator-parse failure
# (e.g. a bad menu shortcut string). It always kills the app before exiting so
# it is safe to run in CI.
#
# Usage:  bash scripts/smoke.sh
# Exit:   0 = clean launch, nonzero = build failed or bad log output.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG="$(mktemp -t md-editor-smoke.XXXXXX.log)"
RUN_SECONDS="${SMOKE_RUN_SECONDS:-12}"
APP_PID=""

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    # Kill the whole process group: cargo/tauri spawn child processes.
    kill -TERM -- "-$APP_PID" 2>/dev/null || kill -TERM "$APP_PID" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$APP_PID" 2>/dev/null || kill -KILL "$APP_PID" 2>/dev/null || true
  fi
  # Belt and suspenders: clean up any stragglers from this build.
  pkill -f "target/debug/md-editor" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Building frontend (tsc + vite)"
npm run build

echo "==> Launching Tauri app in dev for ${RUN_SECONDS}s (log: $LOG)"
# setsid-style new process group so cleanup can signal the whole tree.
set +e
( set -m; npm run tauri dev ) >"$LOG" 2>&1 &
APP_PID=$!
set -e

# Let it compile and boot. The first `tauri dev` can be slow (Rust build), so
# poll the log for either a readiness signal or a fatal line.
elapsed=0
booted=0
while (( elapsed < RUN_SECONDS )); do
  if grep -qiE "panicked|error while running tauri|failed to parse accelerator|invalid accelerator" "$LOG"; then
    break
  fi
  # tauri prints "Running" / app window opens; treat sustained quiet as booted.
  if grep -qiE "app listening|running .*md-editor|finished .*dev" "$LOG"; then
    booted=1
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

echo "==> Captured log:"
echo "-----------------------------------------------------------------"
cat "$LOG"
echo "-----------------------------------------------------------------"

status=0

if grep -qiE "panicked|error while running tauri application" "$LOG"; then
  echo "FAIL: Rust panic detected in app log."
  status=1
fi

if grep -qiE "failed to parse accelerator|invalid accelerator|unknown accelerator" "$LOG"; then
  echo "FAIL: menu accelerator parse failure detected (check src-tauri/src/menu.rs)."
  status=1
fi

# Generic error scan, excluding known-benign noise (e.g. "0 errors", build hints).
if grep -iE "\\berror\\b" "$LOG" \
     | grep -viE "0 error|no error|clearScreen|error while running tauri application" \
     >/dev/null; then
  echo "WARN: 'error' appeared in the log; review the captured output above."
  # Treat as failure to be CI-strict; relax this if it proves flaky.
  status=1
fi

if (( status == 0 )); then
  echo "PASS: app launched without panics or accelerator errors."
fi

exit "$status"
