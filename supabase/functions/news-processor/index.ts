import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, DELETE",
};

// Directly querying ingestion schema (articles, article_ai, sources, categories, media_assets)

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

    // GET /articles (assemble enriched objects manually from normalized schema)
    if (method === "GET" && path === "/articles") {
      const { data: baseArticles, error: baseErr } = await supabaseClient
        .from("articles")
        .select(
          "id,title,snippet,published_at,language,canonical_url,url,source_id"
        )
        .order("published_at", { ascending: false })
        .limit(100);
      if (baseErr) throw baseErr;
      const ids = baseArticles?.map((a) => a.id) || [];

      // current AI layer
      const { data: aiRows } = await supabaseClient
        .from("article_ai")
        .select(
          "article_id,ai_title,ai_summary,ai_details,ai_language,is_current"
        )
        .in("article_id", ids.length ? ids : ["__none__"])
        .eq("is_current", true);
      const aiMap = new Map<string, any>();
      aiRows?.forEach((r) => aiMap.set(r.article_id, r));

      // sources
      const sourceIds = Array.from(
        new Set(baseArticles?.map((a) => a.source_id).filter(Boolean))
      );
      const { data: sources } = await supabaseClient
        .from("sources")
        .select("id,name,homepage")
        .in("id", sourceIds.length ? sourceIds : ["__none__"]);
      const sourceMap = new Map<string, any>();
      sources?.forEach((s) => sourceMap.set(s.id, s));

      // categories (collect mapping article -> categories)
      const { data: catLinks } = await supabaseClient
        .from("article_categories")
        .select("article_id,category_id")
        .in("article_id", ids.length ? ids : ["__none__"]);
      const catIds = Array.from(
        new Set(catLinks?.map((cl) => cl.category_id) || [])
      );
      const { data: categoriesAll } = await supabaseClient
        .from("categories")
        .select("id,path")
        .in("id", catIds.length ? catIds : ["__none__"]);
      const catPathMap = new Map<number, string>();
      categoriesAll?.forEach((c) => catPathMap.set(c.id, c.path));
      const articleCats = new Map<string, string[]>();
      catLinks?.forEach((cl) => {
        const arr = articleCats.get(cl.article_id) || [];
        const path = catPathMap.get(cl.category_id);
        if (path) arr.push(path);
        articleCats.set(cl.article_id, arr);
      });

      // thumbnails
      const { data: mediaLinks } = await supabaseClient
        .from("article_media")
        .select("article_id,media_id,role")
        .in("article_id", ids.length ? ids : ["__none__"])
        .eq("role", "thumbnail");
      const mediaIds = mediaLinks?.map((m) => m.media_id) || [];
      const { data: mediaAssets } = await supabaseClient
        .from("media_assets")
        .select("id,url")
        .in("id", mediaIds.length ? mediaIds : ["__none__"]);
      const mediaMap = new Map<string, string>();
      mediaAssets?.forEach((ma) => mediaMap.set(ma.id, ma.url));
      const thumbMap = new Map<string, string | null>();
      mediaLinks?.forEach((m) => {
        if (!thumbMap.has(m.article_id))
          thumbMap.set(m.article_id, mediaMap.get(m.media_id) || null);
      });

      const enriched = (baseArticles || []).map((a) => {
        const ai = aiMap.get(a.id);
        const categories = articleCats.get(a.id) || [];
        const title = ai?.ai_title || a.title;
        const summary = ai?.ai_summary || a.snippet || "";
        const explanation = ai?.ai_details || null;
        const readingTime = Math.max(
          1,
          Math.ceil(summary.split(/\s+/).length / 200)
        );
        return {
          id: a.id,
          title,
          summary,
          ai_explanation: explanation,
          explanation_generated: !!explanation,
          category: categories[0] || "general",
          language: a.language,
          source: sourceMap.get(a.source_id || "")?.name || "Unknown",
          source_url: a.canonical_url || a.url,
          image_url: thumbMap.get(a.id) || null,
          published_at: a.published_at,
          reading_time: readingTime,
          tags: categories,
          eli5_summary: null,
          audio_summary_url: null,
          audio_duration: 0,
          view_count: 0,
          created_at: a.published_at,
          updated_at: a.published_at,
          article_analytics: [], // analytics pipeline not yet integrated
        };
      });
      return new Response(JSON.stringify(enriched), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /articles/:id (assemble single record)
    if (method === "GET" && path.startsWith("/articles/")) {
      const articleId = path.split("/")[2];
      const { data: base, error: baseErr } = await supabaseClient
        .from("articles")
        .select(
          "id,title,snippet,published_at,language,canonical_url,url,source_id"
        )
        .eq("id", articleId)
        .single();
      if (baseErr) throw baseErr;
      const { data: ai } = await supabaseClient
        .from("article_ai")
        .select("ai_title,ai_summary,ai_details")
        .eq("article_id", articleId)
        .eq("is_current", true)
        .maybeSingle();
      const { data: catLinks } = await supabaseClient
        .from("article_categories")
        .select("category_id")
        .eq("article_id", articleId);
      const catIds = (catLinks || []).map((c) => c.category_id);
      const { data: cats } = await supabaseClient
        .from("categories")
        .select("id,path")
        .in("id", catIds.length ? catIds : ["__none__"]);
      const categories = cats?.map((c) => c.path) || [];
      const { data: mediaLink } = await supabaseClient
        .from("article_media")
        .select("media_id")
        .eq("article_id", articleId)
        .eq("role", "thumbnail")
        .limit(1);
      let image_url: string | null = null;
      if (mediaLink && mediaLink[0]) {
        const { data: asset } = await supabaseClient
          .from("media_assets")
          .select("url")
          .eq("id", mediaLink[0].media_id)
          .single();
        image_url = asset?.url || null;
      }
      const title = ai?.ai_title || base.title;
      const summary = ai?.ai_summary || base.snippet || "";
      const explanation = ai?.ai_details || null;
      const readingTime = Math.max(
        1,
        Math.ceil(summary.split(/\s+/).length / 200)
      );
      const result = {
        id: base.id,
        title,
        summary,
        ai_explanation: explanation,
        explanation_generated: !!explanation,
        category: categories[0] || "general",
        language: base.language,
        source: base.source_id || "unknown",
        source_url: base.canonical_url || base.url,
        image_url,
        published_at: base.published_at,
        reading_time: readingTime,
        tags: categories,
        eli5_summary: null,
        audio_summary_url: null,
        audio_duration: 0,
        view_count: 0,
        created_at: base.published_at,
        updated_at: base.published_at,
        article_analytics: [],
      };
      return new Response(JSON.stringify(result), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /articles/:id/explanation (generate & persist in article_ai)
    if (method === "POST" && path.match(/^\/articles\/.+\/explanation$/)) {
      if (!geminiApiKey)
        return new Response(JSON.stringify({ error: "Gemini key missing" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      const articleId = path.split("/")[2];
      const { data: base, error: baseErr } = await supabaseClient
        .from("articles")
        .select("id,title,snippet,language")
        .eq("id", articleId)
        .single();
      if (baseErr)
        return new Response(JSON.stringify({ error: "Article not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      const { data: existing } = await supabaseClient
        .from("article_ai")
        .select("ai_details")
        .eq("article_id", articleId)
        .eq("is_current", true)
        .maybeSingle();
      if (existing?.ai_details)
        return new Response(
          JSON.stringify({ explanation: existing.ai_details, cached: true }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      const prompt = `Provide a detailed explanation (900-1100 words). Title: ${base.title}\nSummary: ${base.snippet}`;
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );
      if (!resp.ok)
        return new Response(
          JSON.stringify({ error: "Gemini API error", status: resp.status }),
          {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      const data = await resp.json();
      const explanation =
        data.candidates?.[0]?.content?.parts?.[0]?.text ||
        "Explanation unavailable";
      await supabaseClient
        .from("article_ai")
        .update({ is_current: false })
        .eq("article_id", articleId)
        .eq("is_current", true);
      await supabaseClient
        .from("article_ai")
        .insert({
          article_id: articleId,
          ai_title: base.title,
          ai_summary: base.snippet,
          ai_details: explanation,
          ai_language: base.language,
          model: "gemini-1.5-flash",
          is_current: true,
        });
      return new Response(JSON.stringify({ explanation, cached: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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
