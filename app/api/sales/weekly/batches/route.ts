import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { deleteWeeklyBatch, listWeeklyBatches, retagWeeklyBatch } from "@/lib/sales/weekly/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
  }
  if (error instanceof SalesWorkflowError) {
    return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
  }
  return NextResponse.json({ success: false, error: error instanceof Error ? error.message : fallback }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    const data = await listWeeklyBatches();
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return fail(error, "Failed to load weekly uploads.");
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    const batchId = new URL(request.url).searchParams.get("batchId")?.trim();
    if (!batchId) {
      return NextResponse.json({ success: false, error: "Missing batchId." }, { status: 400 });
    }
    await deleteWeeklyBatch(batchId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return fail(error, "Failed to delete the weekly upload.");
  }
}

// Re-tag a batch's month-cycle + week-of-month (fixes boundary sheets so de-cumulation pairs correctly).
export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "import");
    const body = (await request.json().catch(() => ({}))) as {
      batchId?: string;
      cycleMonth?: string;
      weekNumber?: number | string;
    };
    await retagWeeklyBatch({
      batchId: String(body?.batchId ?? "").trim(),
      cycleMonth: String(body?.cycleMonth ?? "").trim(),
      weekNumber: Number(body?.weekNumber),
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return fail(error, "Failed to re-tag the weekly upload.");
  }
}
