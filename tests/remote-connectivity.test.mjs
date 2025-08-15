import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

function loadDotEnv() {
  const p = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!(k in process.env)) process.env[k] = v;
  }
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  loadDotEnv();
}

const url = process.env.SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !service) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(url, service, {
  auth: { persistSession: false },
});

let articleId = null;
let marker = null;

describe("remote connectivity", () => {
  it("selects at least one article id (or handles empty)", async () => {
    const { data, error } = await supabase
      .from("articles")
      .select("id")
      .limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
      console.warn("No articles present yet. Skipping dependent test.");
      return; // treat empty as pass for connectivity
    }
    articleId = data[0].id;
    expect(typeof articleId).toBe("string");
  });

  it("inserts and reads back ai explanation marker", async () => {
    if (!articleId) return; // skipped gracefully
    await supabase
      .from("article_ai")
      .update({ is_current: false })
      .eq("article_id", articleId)
      .eq("is_current", true);
    marker = "vitest-connectivity-" + new Date().toISOString();
    const { error: insErr } = await supabase.from("article_ai").insert({
      article_id: articleId,
      ai_title: "Connectivity",
      ai_summary: "summary",
      ai_details: marker,
      ai_language: "en",
      model: "test",
      is_current: true,
    });
    if (insErr) throw insErr;
    const { data: back, error: backErr } = await supabase
      .from("article_ai")
      .select("ai_details")
      .eq("article_id", articleId)
      .eq("is_current", true)
      .limit(1);
    if (backErr) throw backErr;
    expect(back && back[0] && back[0].ai_details).toBe(marker);
  });
});
