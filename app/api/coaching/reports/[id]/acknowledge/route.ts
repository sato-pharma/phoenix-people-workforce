import { NextResponse } from "next/server";

import { acknowledgeCoachingReport } from "@/lib/coaching/service";
import {
  jsonError,
  readJsonObject,
  requireCoachingPermission,
} from "@/app/api/coaching/_lib/route-utils";
import { clientAddress } from "@/lib/security/client-address";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const access = await requireCoachingPermission(request, "read");
    const { id } = await context.params;
    const payload = await readJsonObject(request, { allowEmpty: true });
    const report = await acknowledgeCoachingReport(id, access, {
      acknowledgmentText: typeof payload.acknowledgmentText === "string" ? payload.acknowledgmentText : null,
      ipAddress: clientAddress(request),
      userAgent: request.headers.get("user-agent"),
    });

    return NextResponse.json({
      data: report,
      message: "Coaching report acknowledged.",
      success: true,
    });
  } catch (error) {
    return jsonError(error, "Failed to acknowledge coaching report.");
  }
}
