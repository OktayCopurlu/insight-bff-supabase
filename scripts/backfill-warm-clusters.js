#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config();
import request from "supertest";
import { app } from "../server.mjs";

// One-off backfill script: warms last N clusters for a given market/lang by hitting /translate/batch.
// Usage: node scripts/backfill-warm-clusters.js --lang=tr --count=50

function arg(name, defVal) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!found) return defVal;
  const v = found.split("=")[1];
  return v || defVal;
}

async function main() {
  const lang = arg("lang", "en");
  const count = Math.max(
    1,
    Math.min(parseInt(arg("count", "50"), 10) || 50, 200)
  );
  console.log(`[warm] Starting warm-up for ${count} clusters, lang=${lang}`);

  // Query the BFF for feed to get recent cluster IDs (non-strict, larger limit)
  const res = await request(app)
    .get(`/feed?lang=${encodeURIComponent(lang)}&limit=${count}`)
    .set("Accept-Language", lang)
    .expect((r) => [200].includes(r.status));

  const items = Array.isArray(res.body) ? res.body : res.body?.data || [];
  const ids = items
    .map((x) => x.id)
    .filter(Boolean)
    .slice(0, count);
  console.log(`[warm] Collected ${ids.length} cluster ids`);
  if (!ids.length) return;

  // Call batch translate in chunks of 10 to respect limiter defaults
  const chunkSize = 10;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    try {
      const r = await request(app)
        .post(`/translate/batch?lang=${encodeURIComponent(lang)}`)
        .set("Content-Type", "application/json")
        .send({ ids: chunk })
        .expect((x) => [200, 429, 500].includes(x.status));
      console.log(
        `[warm] chunk ${i / chunkSize + 1}: status=${r.status} ok=${
          r.body?.results?.length || 0
        } fail=${r.body?.failed?.length || 0}`
      );
      if (r.status === 429) await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.warn(`[warm] chunk error:`, e.message);
    }
  }
  console.log(`[warm] Done`);
}

main().catch((e) => {
  console.error("Warm-up failed:", e.message);
  process.exit(1);
});
