import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";
import { addManagerCustomer, loadManagerOwnList } from "@/lib/phoenix-crm/server/manager-customers";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manager's own list (owner, 2026-10-16) — the customers a district manager visits alone, kept apart from
// his reps' lists and never merged into them.
//
// GET = the list. `read`, narrowed in the service to whoever reads that district manager's plan.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const search = searchOf(request);
    const list = await loadManagerOwnList(viewer, { manager: search.get("manager"), test: search.get("test") });
    return NextResponse.json({ list, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load Manager's own list.");
  }
}

// POST = a customer he adds. `read`, narrowed in the service to the manager who plans the week himself
// (`assertManagerPlanWriter`). No validation step (his ruling): the managers are trusted.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    const customer = await addManagerCustomer(viewer, body);
    return NextResponse.json({ customer, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not add the customer.");
  }
}
