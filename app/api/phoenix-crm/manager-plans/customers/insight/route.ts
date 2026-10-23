import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadManagerCustomerMarks } from "@/lib/phoenix-crm/server/manager-customer-marks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the marks on each customer of the rep or area he is planning with — grade and its monthly number, the
// rep's visits that month, his own visits, a live marketing request. `read`, narrowed in the service to the
// manager himself and the territories he plans in.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const insight = await loadManagerCustomerMarks(viewer, {
      seats: search.get("seats"),
      own: search.get("own"),
      date: search.get("date"),
      test: search.get("test"),
    });
    return NextResponse.json({ insight, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the customers' marks.");
  }
}
