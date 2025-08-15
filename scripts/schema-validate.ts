// Simple schema probe script for BFF -> ingestion DB
// Run with: deno run --allow-net --allow-env scripts/schema-validate.ts

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const requiredTables: Record<string, string[]> = {
  articles: [
    "id",
    "title",
    "snippet",
    "published_at",
    "language",
    "source_id",
    "canonical_url",
    "url",
  ],
  article_ai: [
    "id",
    "article_id",
    "ai_title",
    "ai_summary",
    "ai_details",
    "ai_language",
    "is_current",
  ],
  sources: ["id", "name", "homepage"],
  categories: ["id", "path"],
  article_categories: ["article_id", "category_id"],
  media_assets: ["id", "url"],
  article_media: ["article_id", "media_id", "role"],
};

const url = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

const client = createClient(url, serviceKey);

let failures = 0;
for (const [table, cols] of Object.entries(requiredTables)) {
  const colList = cols.join(",");
  const { error } = await client.from(table).select(colList).limit(1);
  if (error) {
    failures++;
    console.error(`Schema check failed for ${table}: ${error.message}`);
  } else {
    console.log(`OK ${table}`);
  }
}

if (failures) {
  console.error(`Schema validation failed (${failures} tables).`);
  Deno.exit(2);
}
console.log("Schema validation passed.");
