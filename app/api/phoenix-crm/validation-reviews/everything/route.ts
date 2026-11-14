import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { forbiddenError } from "@/lib/http/api-errors";
import type { PlaceChecksEverything } from "@/lib/phoenix-crm/place-checks-on-demand";
import { resolvePhoenixCrmViewer, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { placeChecksHandoffKey, takePlaceChecksForTheClick } from "@/lib/phoenix-crm/server/place-checks-handoff";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { canDecideValidationReviews, loadValidatedPlaces, loadValidationReviews } from "@/lib/phoenix-crm/server/validation-reviews";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the part of Place checks that waits for the click (owner, 2026-11-14, "Load lists on demand"):
// every place in use and every decision older than the 14-day window, read when he opens Not confirmed,
// picks a filter or a decider, taps a count, or opens the one-by-one review — never with the page, which
// used to send all of it (12.5 MB) and froze the server building it (`place-checks-on-demand.ts`).
// The Super Admin and the SFE Manager, exactly as the page: `approve` is gate one and
// `canDecideValidationReviews` gate two, both before a row is read. A district manager's board is drawn
// whole by its own page and never asks this route.
async function readEverything(viewer: PhoenixCrmViewer): Promise<PlaceChecksEverything> {
  const [reviews, validated] = await Promise.all([loadValidationReviews(viewer, { everyDecision: true }), loadValidatedPlaces(viewer)]);
  // A waiting place is always `recent`, so these are decided rows only.
  return { validated: validated.rows, olderDecided: reviews.rows.filter((row) => !row.recent) };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "approve");
    const viewer = await resolvePhoenixCrmViewer(access);
    if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin and the SFE Manager read this.");
    // The rows the page read for this person a moment ago, when they are still there (`place-checks-handoff.ts`);
    // otherwise the same two reads the page makes.
    const everything: PlaceChecksEverything = takePlaceChecksForTheClick(placeChecksHandoffKey(viewer)) ?? (await readEverything(viewer));
    return NextResponse.json({ everything, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the places in use.");
  }
}
