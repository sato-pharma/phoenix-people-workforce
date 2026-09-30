import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadForecastAccuracy, loadForecastBoard } from "@/lib/phoenix-crm/server/daily-forecast";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the managers' forecast board over the CNS territories beneath the viewer.
//   ?view=day   (default) one day: who sent, when, and the forecast against the day's share of target;
//   ?view=month a published month: what each territory forecast against what the closing credits it.
//
// The service refuses anyone who does not read team reports: a rep never reaches another rep's
// forecast, and never sees a verdict on his own (Golden Rule #1).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    if (search.get("view") === "month") {
      const accuracy = await loadForecastAccuracy(viewer, { period: search.get("period"), test: search.get("test") });
      return NextResponse.json({ board: { kind: "month", accuracy }, success: true });
    }
    const day = await loadForecastBoard(viewer, { day: search.get("day"), test: search.get("test") });
    return NextResponse.json({ board: { kind: "day", day }, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the forecast board.");
  }
}
