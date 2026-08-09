import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getCoverageSummary } from "@/lib/sales/import-coverage";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const summary = await getCoverageSummary();
    return NextResponse.json({ data: summary, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden."), success: false }, { status: 403 });
    }
    return NextResponse.json({ error: clientSafeErrorMessage(error, "Failed to load coverage summary."), success: false }, { status: 500 });
  }
}
