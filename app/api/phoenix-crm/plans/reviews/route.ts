import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { loadPlanReviews } from "@/lib/phoenix-crm/server/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = one week's plans across the viewer's territories (their own scope, downward only): the ones
// waiting first, with their far-apart days, and the territories that have not sent one.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const reviews = await loadPlanReviews(viewer, { test: search.get("test"), weekStart: search.get("weekStart") });
    return NextResponse.json({ reviews, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the plans.");
  }
}
