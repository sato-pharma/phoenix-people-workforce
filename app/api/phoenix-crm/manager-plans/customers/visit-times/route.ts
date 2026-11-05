import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadManagerCustomerVisitTimes } from "@/lib/phoenix-crm/server/manager-visit-times";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = "Show visit times" on his plan board (owner, 2026-11-05): each customer's saved days and hours, the
// rep's last visit with its time and whether he was on it, and his own last visit. `read`, narrowed in the
// service to the manager himself and the territories he plans in — the month marks' own gate.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const times = await loadManagerCustomerVisitTimes(viewer, {
      seats: search.get("seats"),
      own: search.get("own"),
      date: search.get("date"),
      test: search.get("test"),
    });
    return NextResponse.json({ times, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the visit times.");
  }
}
