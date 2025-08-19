# Insight BFF (Supabase Edge Functions)

Backend-for-Frontend layer extracted from the original `news-web-app-1/supabase` (formerly `Insight-frontend`) directory.

## Purpose

Provides a thin API surface (Edge Functions) for the frontend (news app) to:

1. Fetch clusters and articles (cluster-first, AI enriched via cluster_ai)
2. Generate / retrieve AI explanations, coverage comparisons (ephemeral), quizzes (placeholder)
3. Chat about an article context (AI chat) — handled by the BFF server (`server.mjs`), not an Edge Function
4. Manage auth (limited) / future preferences

## Current State (Post-Extraction)

Functions now query the normalized ingestion schema directly (`articles`, `sources`, `article_categories`, `media_assets`, `clusters`, `cluster_ai`, etc.) and assemble responses in code. No extra SQL views or new tables were added for core article flows.

## Migration Strategy Overview

Phase 1 (DONE): Extract functions into their own folder.

Phase 2: (DONE) Refactor functions to stitch data from base tables without DB changes.

Phase 3: Add real analytics / bias metrics (will require new storage or external pipeline).

Phase 4: Optional feature tables (quizzes, coverage comparisons persistence, chats history, user preferences) can be added later if persistence becomes necessary.

## Directory Structure

```
supabase/
  functions/
    coverage-analyzer/
    news-aggregator/
    news-processor/
    quiz-generator/
    user-management/
scripts/
  schema-validate.ts
  run-local-and-test.sh
tests/
  e2e.test.ts (Deno)
  e2e-node.mjs (Node)
.env / .env.example
package.json
```

## Environment Variables (Edge Functions & Local)

Set in Supabase (secrets) or `.env` for local:

- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY (used for writes / privileged reads)
- GEMINI_API_KEY (LLM)
- Optional: EDGE_TOKEN, feature flags.

## Persistence Limitations

Endpoints that would rely on data not present in the ingestion schema (quizzes persistence, coverage comparisons store, persistent chat, user preferences) currently return placeholders or 501 responses.

## Type Generation

Generate DB types (updates `types/database.ts`):

```bash
npm run generate:types
```

(Requires `supabase` CLI installed and project id inside command.)

## Schema Validation

Quick probe for required tables & columns:

```bash
npm run schema:validate
```

(Uses Deno; install via `brew install deno` if not present.)

## Running Locally + E2E (Node)

Start a single function and run Node-based tests automatically:

```bash
npm run test:local
```

Or manually:

```bash
supabase functions serve news-processor --no-verify-jwt &
BFF_BASE_URL=http://localhost:54321/functions/v1 npm run test:node
```

## Deno E2E Tests

Using native Deno test runner:

```bash
BFF_BASE_URL=http://localhost:54321/functions/v1 deno test --allow-net --allow-env tests/e2e.test.ts
```

Skip expensive endpoints via env flags (set to `true`): `SKIP_EXPLANATION`, `SKIP_CHAT`, `SKIP_COVERAGE`.

## Integration (Manual REST)

See `scripts/integration-test.http` for ready-made calls (VS Code REST Client). For chat, use the BFF endpoint `/cluster/:id/chat`.

## Next Action Checklist

1. Deploy updated functions to Supabase project pointing at ingestion DB.
2. Update frontend to call new endpoints and adapt to missing analytics fields.
3. Plan analytics pipeline & persistence tables for quizzes / comparisons if needed.

## License

Internal project module – licensing inherits root project.

---

## Observability and Ops

- GET /metrics — returns lightweight in-process counters for the BFF and translation layer (providerCalls, cacheHits/Misses, dbHits/Writes, latencyMs {last, avg, total}). Counters reset on process restart; suitable for smoke checks and CI.
- Console logs with prefix "metric:" are emitted for quick grepping:
  - metric: bff.batch.limited — IP-based token bucket limited a /translate/batch request
  - metric: bff.batch.failed|succeeded — batch outcomes with counts
  - metric: provider.call — translation provider call with latency_ms
  - metric: provider.cache_hit — in-memory cache served a translation
  - metric: provider.db_hit — DB cache served a translation
  - metric: provider.db_write — translation persisted to DB cache

### Cost controls

- /translate/batch has an IP-based token bucket. Tune with RATE_LIMIT_BATCH (tokens/interval) and RATE_LIMIT_INTERVAL_MS. Empty ids arrays are no-ops and logged.
- Translation timeouts and retries can be tuned via MT_TIMEOUT_MS, MT_RETRIES, MT_BACKOFF_MS. Long texts are chunked using MT_CHUNK_THRESHOLD and MT_CHUNK_MAX to reduce timeouts.

### Warm-up backfill

- scripts/backfill-warm-clusters.js performs a small backfill by fetching recent items via /feed and warming translations via /translate/batch in chunks. It respects 429s by pausing briefly.
