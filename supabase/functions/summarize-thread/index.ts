import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const openaiKey = Deno.env.get("OPENAI_API_KEY");

    if (!openaiKey) {
      return new Response(
        JSON.stringify({ error: "Missing OPENAI_API_KEY secret" }),
        { status: 500, headers: corsHeaders }
      );
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const body = await req.json();
    const thread_id = body?.thread_id as string | undefined;
    const max_messages = Number(body?.max_messages ?? 50);
    const style = (body?.style as string | undefined) ?? "concise";

    if (!thread_id) {
      return new Response(JSON.stringify({ error: "thread_id is required" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    // Load recent messages for this thread (RLS ensures membership)
    const { data: messages, error } = await supabase
      .from("messages")
      .select("sender_id, body, created_at")
      .eq("thread_id", thread_id)
      .order("created_at", { ascending: true })
      .limit(max_messages);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ summary: null, messageCount: 0 }), {
        status: 200,
        headers: corsHeaders,
      });
    }

    // Build a compact prompt with timestamps
    const formatted = messages
      .map((m: any) => {
        const ts = m.created_at ? new Date(m.created_at).toISOString() : "";
        return `${ts} [${m.sender_id}]: ${m.body}`;
      })
      .join("\n");

    const system =
      "You are a helpful assistant that summarizes chat threads. " +
      "Return only the summary, no markdown, and keep it aligned with the requested style.";

    const user =
      `Summarize the following thread in a ${style} way. ` +
      `Focus on key decisions, open questions, and action items.\n\nTHREAD:\n${formatted}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(
        JSON.stringify({ error: "OpenAI request failed", details: errText }),
        { status: 502, headers: corsHeaders }
      );
    }

    const result = await response.json();
    const summary = result?.choices?.[0]?.message?.content ?? null;

    return new Response(
      JSON.stringify({ summary, messageCount: messages.length }),
      { status: 200, headers: corsHeaders }
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
