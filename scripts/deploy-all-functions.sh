#!/usr/bin/env bash
set -euo pipefail

PROJECT_REF=${PROJECT_REF:-darjwmlcicbrqrmzadxe}
FUNCS=(news-processor ai-chat coverage-analyzer quiz-generator user-management)

echo "Checking Supabase CLI auth" >&2
if ! supabase projects list >/dev/null 2>&1; then
  cat >&2 <<'EOF'
ERROR: Supabase CLI not authenticated.
Run:  supabase login
Paste your personal access token from https://supabase.com/account/tokens
Or set SUPABASE_ACCESS_TOKEN env var before running this script.
EOF
  exit 1
fi

echo "Linking project $PROJECT_REF (idempotent)" >&2
supabase link --project-ref "$PROJECT_REF" >/dev/null || true

echo "Deploying functions: ${FUNCS[*]}" >&2
for f in "${FUNCS[@]}"; do
  echo "-- Deploy $f" >&2
  supabase functions deploy "$f" --project-ref "$PROJECT_REF"
done

echo "All functions deployed. Base URL: https://$PROJECT_REF.functions.supabase.co" >&2
