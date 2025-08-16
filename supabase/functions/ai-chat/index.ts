const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 200, headers: corsHeaders });
  try {
    const { createClient } = await import(
      "https://esm.sh/@supabase/supabase-js@2"
    );
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );
    const geminiApiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiApiKey) throw new Error("Gemini API key not found");

    const url = new URL(req.url);
    const path = url.pathname.replace(
      /^\/functions\/v1\/ai-chat|^\/ai-chat/,
      ""
    );
    const method = req.method;

    if (method === "POST" && (path === "/chat" || path === "")) {
      const { articleId, message, chatHistory = [] } = await req.json();

      // Fetch base + AI layer (no compatibility views)
      const { data: base, error: baseErr } = await supabaseClient
        .from("articles")
        .select("id,title,snippet,language,source_id")
        .eq("id", articleId)
        .single();
      if (baseErr)
        return new Response(JSON.stringify({ error: "Article not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      // Legacy per-article AI table deprecated; use base article fields only
      const title = base.title;
      const summary = base.snippet || "";
      const explanation = "";
      const analytic = { bias_score: 0, sentiment_label: "neutral" }; // placeholder

      const context =
        `You are an AI assistant helping users understand news articles.\n\n` +
        `Article Title: ${title}\n` +
        `Article Summary: ${summary}\n` +
        `Article Source ID: ${base.source_id}\n` +
        `Bias Score: ${analytic.bias_score}\n` +
        `Sentiment: ${analytic.sentiment_label}\n` +
        `${explanation ? `Detailed Explanation: ${explanation}\n` : ""}` +
        `Previous conversation:\n${chatHistory
          .map((m: any) => `${m.type}: ${m.content}`)
          .join("\n")}\n\n` +
        `User's question: ${message}\n\n` +
        `Provide a helpful, accurate response about this article. Keep under 200 words.`;

      const geminiResp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: context }] }] }),
        }
      );
      if (!geminiResp.ok)
        return new Response(
          JSON.stringify({
            error: "Gemini API error",
            status: geminiResp.status,
          }),
          {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      const geminiData = await geminiResp.json();
      const aiResponse =
        geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "No response";

      return new Response(JSON.stringify({ response: aiResponse }), {
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
