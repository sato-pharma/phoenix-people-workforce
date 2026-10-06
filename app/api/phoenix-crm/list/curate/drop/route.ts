import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { sfeDropFromList } from "@/lib/phoenix-crm/server/list";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the SFE Manager drops an irrelevant customer off a rep's list himself (owner, 2026-10-06).
// Filed and decided as a drop request at the SFE step, so the Archive's history reads the same whoever
// took the customer off the list. The SFE Manager and the Super Admin (`canCurateList`); a rep's own
// ask to drop still goes to his district manager and then to SFE, at /list/requests.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const dropped = await sfeDropFromList(viewer, body);
    return NextResponse.json({ dropped, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not drop the customer from the list.");
  }
}
