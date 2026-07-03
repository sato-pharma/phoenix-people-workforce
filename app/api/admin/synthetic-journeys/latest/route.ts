import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { getLatestRun } from "@/lib/synthetic-journeys/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "synthetic_journeys", "read");
    const run = await getLatestRun();
    return NextResponse.json({ run });
  } catch (error) {
    const apiError = toApiError(error, "Failed to load the latest synthetic journey run.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
