import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );

    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) {
      throw new Error("Gemini API key not found");
    }

    const { method } = req;
    const url = new URL(req.url);
    const path = url.pathname.replace("/functions/v1/coverage-analyzer", "");

    if (method === "POST" && path === "/analyze") {
      const { articleId } = await req.json();
      const { data: article, error: articleError } = await supabaseClient
        .from("articles")
        .select("id,title,snippet")
        .eq("id", articleId)
        .single();
      if (articleError) throw articleError;

      // No persistence layer for comparisons (table not present). Always compute fresh.

      const comparisonPrompt = `Generate perspective comparisons for: ${article.title}`;
      const geminiResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: comparisonPrompt }] }],
          }),
        }
      );
      const geminiData = await geminiResponse.json();
      let comparisonData;
      try {
        const responseText = geminiData.candidates[0].content.parts[0].text;
        comparisonData = JSON.parse(
          responseText.replace(/```json\n?/g, "").replace(/```/g, "")
        );
      } catch {
        comparisonData = { comparisons: [] };
      }

      return new Response(
        JSON.stringify({
          article_id: articleId,
          comparisons: comparisonData.comparisons,
          persisted: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (method === "GET" && path.startsWith("/comparison/")) {
      return new Response(
        JSON.stringify({
          error: "Coverage comparisons persistence not configured",
        }),
        {
          status: 501,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
