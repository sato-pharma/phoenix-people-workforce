import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadExecutiveReport, toExecutiveView } from "@/lib/sales/executive-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json(
        { success: false, error: "Forbidden: Executive Report is restricted to the admin account." },
        { status: 403 },
      );
    }
    await assertPermission(access, "sales", "import");

    const url = new URL(request.url);
    const periodParam = url.searchParams.get("period");
    // "all" / empty → all-time (null). Any concrete YYYY-MM narrows to that month.
    const period = !periodParam || periodParam === "all" ? null : periodParam;

    const report = await loadExecutiveReport(period);
    return NextResponse.json({ success: true, data: toExecutiveView(report) });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load Executive Report." },
      { status: 500 },
    );
  }
}
