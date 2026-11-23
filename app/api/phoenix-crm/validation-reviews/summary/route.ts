import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { forbiddenError } from "@/lib/http/api-errors";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { keepPlaceChecksForTheClick, placeChecksHandoffKey } from "@/lib/phoenix-crm/server/place-checks-handoff";
import { readPlaceChecksWide } from "@/lib/phoenix-crm/server/place-checks-wide-read";
import { readsCompanyPlaceChecks } from "@/lib/phoenix-crm/server/validation-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the figures on the Place checks tabs that are counted over every place in use (owner, 23 Nov 2026,
// "Fix speed next"): the Not confirmed, History and "Approved by the system" counts, the scorecard, the
// filter lists and the two "in use" figures. The page used to count them itself, which meant reading every
// place in use and every decision before it drew the first waiting place (12.2 s on production). The board
// asks here once it is on screen, and again after a decision re-reads the page.
//
// The Super Admin and the SFE Manager, exactly as the page: `approve` is gate one and
// `readsCompanyPlaceChecks` gate two, both before a row is read. It READS and counts; nothing is decided.
//
// 🔴 WHAT IT READ WAITS TWO MINUTES FOR THE CLICK (`place-checks-handoff.ts`), under this person's key, so
// Not confirmed, a filter or the one-by-one review reads nothing again. It is kept by the moment the read
// STARTED: of two reads in flight, the one that started later is the one kept, whichever finishes last.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    if (!readsCompanyPlaceChecks(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager read this.");
    const startedAt = Date.now();
    const wide = await readPlaceChecksWide(viewer);
    keepPlaceChecksForTheClick(placeChecksHandoffKey(viewer), wide.everything, startedAt);
    return NextResponse.json({ summary: wide.summary, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not count the places in use.");
  }
}
