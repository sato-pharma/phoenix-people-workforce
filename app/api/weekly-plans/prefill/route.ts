import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getPlanPrefill } from "@/lib/weekly-planning/service";
import type { EmployeePlanKind } from "@/lib/weekly-planning/plan-v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only cross-domain prefill for the plan editor: approved vacation/excuse
// (locked) and, for monthly plans, already-submitted weekly plans (sourced).
// Recomputed on every open so monthly plans live-reflect the latest weekly work.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const kind: EmployeePlanKind = url.searchParams.get("kind") === "monthly" ? "monthly" : "weekly";
    const anchor = url.searchParams.get("anchor") ?? new Date().toISOString().slice(0, 10);
    const prefill = await getPlanPrefill(access, kind, anchor);
    return NextResponse.json({ data: prefill, success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load plan prefill.";
    const forbidden = isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:");
    return NextResponse.json(
      { error: forbidden ? "forbidden" : "plan_prefill_error", message, success: false },
      { status: forbidden ? 403 : 400 },
    );
  }
}
