import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
} from "@/lib/payroll/copilot/access";
import { getRunView } from "@/lib/payroll/copilot/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);
    const { runId } = await params;
    const view = await getRunView(runId);
    return NextResponse.json(view);
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
