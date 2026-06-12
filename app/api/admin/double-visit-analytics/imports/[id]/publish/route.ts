import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { publishDoubleVisitImport } from "@/lib/double-visit-analytics/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "double_visit_analytics", "update");
    const { id } = await context.params;
    const data = await publishDoubleVisitImport({ access, importId: id });
    return NextResponse.json({ data, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to publish Double Visit imports." }, { status: 403 });
    }
    return NextResponse.json({
      error: "double_visit_publish_failed",
      message: error instanceof Error ? error.message : "Double Visit publish failed.",
    }, { status: 500 });
  }
}
