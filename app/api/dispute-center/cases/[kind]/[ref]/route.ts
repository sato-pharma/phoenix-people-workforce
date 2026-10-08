import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { loadDisputeCaseForAssist } from "@/lib/dispute-center/assist.ts";
import { disputeCenterError } from "@/lib/dispute-center/http.ts";
import { isDisputeCaseKind } from "@/lib/dispute-center/types.ts";
import { validationError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One case in full: the conversation, the history, the decision, and the module's own record as
// facts beside the claim. The participant check runs inside each adapter.
export async function GET(request: Request, context: { params: Promise<{ kind: string; ref: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const { kind, ref } = await context.params;
    if (!isDisputeCaseKind(kind)) throw validationError("That kind of dispute does not exist.");
    const dispute = await loadDisputeCaseForAssist(access, kind, decodeURIComponent(ref));
    return NextResponse.json({ case: dispute, success: true });
  } catch (error) {
    return disputeCenterError(error, "Unable to open this dispute.");
  }
}
