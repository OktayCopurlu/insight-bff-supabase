#!/usr/bin/env bash
set -euo pipefail

# Starts multiple supabase functions concurrently and runs Node E2E tests.
# Usage: npm run test:all-local

FUNCS=(news-processor coverage-analyzer quiz-generator)
BASE_URL="http://localhost:54321/functions/v1"
LOG_DIR="/tmp/bff-func-logs"
mkdir -p "$LOG_DIR"

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI required" >&2
  exit 2
fi

if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -E '^(SUPABASE_|GEMINI_)' | xargs || true)
fi

pids=()
for f in "${FUNCS[@]}"; do
  echo "Starting function: $f"
  supabase functions serve "$f" --no-verify-jwt >"$LOG_DIR/$f.log" 2>&1 &
  pids+=("$!")
  sleep 1
done

cleanup() {
  for p in "${pids[@]}"; do
    kill "$p" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "Waiting for news-processor availability..."
for i in {1..40}; do
  if curl -s "$BASE_URL/news-processor/articles" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ $i -eq 40 ]; then
    echo "Timeout waiting for functions to become ready" >&2
    exit 3
  fi
done

echo "Running comprehensive E2E tests..."
BFF_BASE_URL="$BASE_URL" node tests/e2e-node.mjs

echo "All tests completed. Logs in $LOG_DIR"
