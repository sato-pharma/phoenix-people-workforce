import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { reportItJsonError, reportItSignedOut } from "@/lib/report-it/http";
import { listReports } from "@/lib/report-it/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    if (access.source === "guest" || !access.hrId) return reportItSignedOut();
    await assertPermission(access, "report_it", "read");

    const url = new URL(request.url);
    const p = url.searchParams;

    const opts = {
      limit: Number(p.get("limit") ?? "50"),
      offset: Number(p.get("offset") ?? "0"),
      isSerious: p.has("isSerious") ? p.get("isSerious") === "true" : undefined,
      outcome: p.get("outcome") ?? undefined,
      medicine: p.get("medicine") ?? undefined,
      submittedBy: p.get("submittedBy") ?? undefined,
      dateFrom: p.get("dateFrom") ?? undefined,
      dateTo: p.get("dateTo") ?? undefined,
      line: p.get("line") ?? undefined,
      area: p.get("area") ?? undefined,
      department: p.get("department") ?? undefined,
    };

    const result = await listReports(access, opts);
    return NextResponse.json(result);
  } catch (error) {
    return reportItJsonError(error, "Failed to list reports.");
  }
}
