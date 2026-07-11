import { NextResponse } from "next/server";

import { getSupabaseAdmin } from "@/lib/supabase/server";

// Readiness probe: verifies the process can actually serve requests — required config is
// present AND Supabase is reachable with a cheap head query. Returns 503 (not ready) when
// a dependency is down so orchestration/uptime checks can react. Public + unauthenticated,
// but it returns only booleans/status — never data or secret values. Not called per user
// request, so a light DB ping is acceptable.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PHOENIX_AUTH_SECRET",
];

export async function GET() {
  const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());

  let databaseOk = false;
  let databaseError: string | null = null;
  try {
    // Cheap connectivity check: HEAD count on a small system table (no rows returned).
    const { error } = await getSupabaseAdmin({ requestTimeoutMs: 4000 })
      .from("app_error_events")
      .select("id", { count: "exact", head: true })
      .limit(1);
    if (error) {
      databaseError = error.message;
    } else {
      databaseOk = true;
    }
  } catch (error) {
    databaseError = error instanceof Error ? error.message : "supabase unreachable";
  }

  const ready = missingEnv.length === 0 && databaseOk;
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      checks: {
        env: missingEnv.length === 0,
        // Only the NAMES of any missing vars — never values.
        missingEnv,
        database: databaseOk,
        databaseError: databaseOk ? null : databaseError,
      },
      revision: process.env.K_REVISION ?? null,
      time: new Date().toISOString(),
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
