import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { reportItJsonError, reportItSignedOut } from "@/lib/report-it/http";
import { getReport } from "@/lib/report-it/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);

    if (access.source === "guest" || !access.hrId) return reportItSignedOut();
    await assertPermission(access, "report_it", "read");

    const { id } = await params;
    const report = await getReport(access, id);

    if (!report) {
      return NextResponse.json({ error: "Report not found." }, { status: 404 });
    }

    return NextResponse.json(report);
  } catch (error) {
    return reportItJsonError(error, "Failed to fetch report.");
  }
}
