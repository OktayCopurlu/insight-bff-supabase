// deno-lint-ignore-file no-explicit-any
// @ts-ignore Deno is provided by the runtime
// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};

// Directly querying ingestion schema (articles, sources, categories, media_assets, clusters, cluster_ai)

serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    const { method } = req;
    const url = new URL(req.url);
    let path = url.pathname
      .replace("/functions/v1/news-processor", "")
      .replace("/news-processor", "");
    if (path === "") path = "/";

    // Legacy /articles endpoints removed.

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as any).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
