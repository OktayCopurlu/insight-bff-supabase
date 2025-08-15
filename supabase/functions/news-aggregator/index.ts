import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

serve(
  () =>
    new Response(
      JSON.stringify({
        deprecated: true,
        message:
          "news-aggregator function deprecated after extraction; ingestion handled by collector service.",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
);
