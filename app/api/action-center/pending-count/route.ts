import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { getVacationActionCenterData } from "@/lib/vacation/service";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { getManagerPendingExcuses } from "@/lib/excuses/service";
import { listOutstationRequests } from "@/lib/outstation/service";
import { getApproverPendingRequests } from "@/lib/marketing-requests/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIVE_CONTRACT_STATUSES = new Set(["requested", "manager_review", "hr_review"]);

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "leave", "read");

    const settled = await Promise.allSettled([
      getVacationActionCenterData(access).then((d) => d.rows.length).catch(() => 0),
      getResignationsDashboardData()
        .then((d) => d.records.filter((r) => r.status === "submitted" || r.status === "under_review").length)
        .catch(() => 0),
      getManagerPendingExcuses(access).then((d) => d.length).catch(() => 0),
      listOutstationRequests()
        .then((d) => d.filter((r) => r.status === "submitted").length)
        .catch(() => 0),
      getApproverPendingRequests(access).then((d) => d.rows.length).catch(() => 0),
      getContractRenewalDashboardData(access)
        .then((d) => d.rows.filter((r) => r.workflow && ACTIVE_CONTRACT_STATUSES.has(r.workflow.status)).length)
        .catch(() => 0),
    ]);

    const count = settled.reduce(
      (sum, r) => sum + (r.status === "fulfilled" ? r.value : 0),
      0,
    );

    return NextResponse.json({ count }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ count: 0 });
  }
}
