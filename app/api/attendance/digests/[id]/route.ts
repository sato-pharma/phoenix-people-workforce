import { NextResponse } from "next/server";

import { getDigestDetailForEmployee } from "@/lib/attendance/digest-read";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!access.hrId) throw validationError("No HR ID on session.");

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("Invalid digest id.");

    const digest = await getDigestDetailForEmployee(id, access.hrId);
    if (!digest) {
      return NextResponse.json({ error: "not_found", message: "Digest was not found." }, { status: 404 });
    }
    return NextResponse.json({ digest });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance digest failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
