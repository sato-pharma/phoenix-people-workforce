import { type NextRequest, NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { invalidateSalesDashboardCache } from "@/lib/dashboard/invalidation";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Both gates must pass: the role names the route has always admitted, and the matrix key that the
// permission screen and the module lock can see (`marketing_roi_refresh`, the same two roles).
const REFRESH_ALLOWED_ROLES = new Set(["Super Admin", "CEO"]);

/** GET — return the latest Marketing ROI refresh run status. */
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!REFRESH_ALLOWED_ROLES.has(access.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await assertPermission(access, "marketing_roi_refresh", "read");

    const supabase = getSupabaseAdmin({ requestTimeoutMs: 10_000 });
    const { data, error } = await supabase
      .from("marketing_roi_refresh_runs")
      .select("id, status, started_at, finished_at, error, affected_periods, row_counts")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ status: null });

    return NextResponse.json({
      id: data.id,
      status: data.status as "running" | "success" | "failed" | "skipped",
      startedAt: data.started_at,
      finishedAt: data.finished_at,
      error: data.error,
      affectedPeriods: data.affected_periods,
      rowCounts: data.row_counts,
    });
  } catch (err) {
    if (isForbiddenError(err)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

/** POST — trigger a full Marketing ROI fact-table refresh. Super Admin / CEO only.
 *  Awaits the Supabase function (up to ~45s); returns when the refresh run completes. */
export async function POST(request: NextRequest) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    if (!REFRESH_ALLOWED_ROLES.has(access.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await assertPermission(access, "marketing_roi_refresh", "update");

    const supabase = getSupabaseAdmin({ requestTimeoutMs: 58_000 });

    // Check for an in-progress run before firing a duplicate.
    const { data: running } = await supabase
      .from("marketing_roi_refresh_runs")
      .select("id")
      .eq("status", "running")
      .limit(1)
      .maybeSingle();

    if (running) {
      return NextResponse.json({ status: "already_running", runId: running.id });
    }

    // Full refresh (p_batch_id = null → refreshes all marketing requests).
    // The function is advisory-lock protected: concurrent callers return status='skipped'.
    const { error: rpcError } = await supabase.rpc("phx_refresh_marketing_roi_facts", {
      p_batch_id: null,
    });

    if (rpcError) {
      return NextResponse.json({ error: rpcError.message }, { status: 500 });
    }

    // The refresh just rebuilt the marketing-ROI fact tables; bust the cached dashboards
    // (smi-dashboard + the analytics caches) so the new numbers show immediately.
    invalidateSalesDashboardCache("marketing roi manual refresh");

    // Return the completed run row so the client can display the result.
    const { data: latest } = await supabase
      .from("marketing_roi_refresh_runs")
      .select("id, status, started_at, finished_at, error, affected_periods, row_counts")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return NextResponse.json({
      status: "accepted",
      run: latest
        ? {
            id: latest.id,
            status: latest.status,
            startedAt: latest.started_at,
            finishedAt: latest.finished_at,
            error: latest.error,
            affectedPeriods: latest.affected_periods,
            rowCounts: latest.row_counts,
          }
        : null,
    });
  } catch (err) {
    if (isForbiddenError(err)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
