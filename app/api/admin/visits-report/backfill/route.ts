import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { syncIReports360Visits } from "@/lib/crm/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Capped per request to keep each call safely within function duration limits — a full
// historical backfill (e.g. Jan 2026 -> today) is done as several sequential calls, one
// chunk at a time, not one giant range.
const MAX_BACKFILL_SPAN_DAYS = 45;

function dateParam(value: unknown) {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin") {
      return NextResponse.json(
        { error: "forbidden", message: "Only Super Admin can trigger a visits backfill.", success: false },
        { status: 403 },
      );
    }

    const body = await request.json().catch(() => ({}));
    const dateFrom = dateParam((body as { dateFrom?: unknown })?.dateFrom);
    const dateTo = dateParam((body as { dateTo?: unknown })?.dateTo);
    if (!dateFrom || !dateTo) {
      return NextResponse.json(
        { error: "invalid_range", message: "dateFrom and dateTo (YYYY-MM-DD) are required.", success: false },
        { status: 400 },
      );
    }
    if (dateTo < dateFrom) {
      return NextResponse.json(
        { error: "invalid_range", message: "dateTo must be on or after dateFrom.", success: false },
        { status: 400 },
      );
    }
    const spanDays =
      Math.round((new Date(`${dateTo}T00:00:00Z`).getTime() - new Date(`${dateFrom}T00:00:00Z`).getTime()) / 86400000) + 1;
    if (spanDays > MAX_BACKFILL_SPAN_DAYS) {
      return NextResponse.json(
        {
          error: "range_too_large",
          message: `Backfill range is capped at ${MAX_BACKFILL_SPAN_DAYS} days per request — split into smaller chunks.`,
          success: false,
        },
        { status: 400 },
      );
    }

    const result = await syncIReports360Visits({ dateFrom, dateTo, trigger: "manual_backfill" });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Visits backfill failed.";
    return NextResponse.json({ error: "visits_backfill_failed", message, success: false }, { status: 500 });
  }
}
