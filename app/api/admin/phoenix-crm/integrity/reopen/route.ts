import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { reopenIntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = put a settled case back among the findings. Its own route rather than a flag on the settle
// one, so the audit log reads as two different decisions — which is what they are.
//
// The same gate and the same decider as settling. No note is asked for: closing a case about a named
// person needs a reason on the record, deciding to look at it again does not.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const settled = await reopenIntegrityCase(viewer, await request.json());
    return NextResponse.json({ settled, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not reopen this case.");
  }
}
