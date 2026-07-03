import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { notFoundError, toApiError } from "@/lib/http/api-errors";
import { getRunById } from "@/lib/synthetic-journeys/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "synthetic_journeys", "read");
    const { id } = await context.params;
    const run = await getRunById(id);
    if (!run) {
      throw notFoundError(`Synthetic journey run "${id}" was not found.`);
    }
    return NextResponse.json({ run });
  } catch (error) {
    const apiError = toApiError(error, "Failed to load the synthetic journey run.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
