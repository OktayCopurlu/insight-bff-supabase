#!/usr/bin/env bash
set -euo pipefail

# Starts local supabase function (needs supabase CLI) and runs Node E2E tests.
# Usage: ./scripts/run-local-and-test.sh [function] (default: news-processor plus others implicitly)

FUNC=${1:-news-processor}
BASE_URL="http://localhost:54321/functions/v1"

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI required (https://supabase.com/docs/guides/cli)" >&2
  exit 2
fi

# Export env vars from .env if present
if [ -f .env ]; then
  export $(grep -v '^#' .env | grep -E '^(SUPABASE_|GEMINI_)' | xargs)
fi

# Start function in background
supabase functions serve $FUNC --no-verify-jwt >/tmp/bff-func.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true' EXIT

# Wait for port
echo "Waiting for local functions to be available..."
for i in {1..30}; do
  if curl -s "$BASE_URL/$FUNC" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ $i -eq 30 ]; then
    echo "Timeout waiting for function." >&2
    exit 3
  fi
done

echo "Running Node E2E tests..."
BFF_BASE_URL="$BASE_URL" node tests/e2e-node.mjs

echo "Done."
