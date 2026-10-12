import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { settleManyIntegrityCases } from "@/lib/phoenix-crm/server/integrity-board";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST = the Super Admin settles SEVERAL location-integrity cases with ONE reason (owner, 2026-10-13:
// "make me able to multi select and settle"). The gate is the single settle's, to the letter:
// `update` here is gate one, and the service refuses everyone but the Super Admin before it reads
// anything (`canSettleIntegrityCases`, a 404 and never a 403) — so the SFE Manager, who READS this
// board, cannot settle on it in bulk any more than he can one at a time.
//
// The answer names every case that settled and every case that did not, with its own reason: one
// failing row never stops the rest, because being told only "it failed" after ticking forty cases is
// how nobody settles anything again. Nothing is deleted and nobody is notified — no rep is ever told
// he was flagged, so no rep can be told a flag about him was closed.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const result = await settleManyIntegrityCases(viewer, await request.json());
    return NextResponse.json({ result, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not settle these cases.");
  }
}
