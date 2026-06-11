import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { deleteWeeklyBatch, listWeeklyBatches } from "@/lib/sales/weekly/service";

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
