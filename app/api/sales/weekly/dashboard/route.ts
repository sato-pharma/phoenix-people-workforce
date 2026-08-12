import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");

    const params = new URL(request.url).searchParams;
    const parseList = (key: string) =>
      params
        .getAll(key)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
    const str = (key: string) => {
      const value = params.get(key);
      return value && value.trim() ? value.trim() : null;
    };
    const mode = (key: string): "include" | "exclude" =>
      (params.get(key) ?? "").toLowerCase() === "exclude" ? "exclude" : "include";
    const allWeeks = ["1", "true", "yes", "all"].includes((params.get("allWeeks") ?? "").toLowerCase());
    const accessScope = await resolveWeeklyAccessScope(access);
    const data = await loadWeeklyDashboard({
      weekStarts: parseList("week"),
      allWeeks,
      weekStart: str("week"),
      lineCodes: parseList("line"),
      lineFilterMode: mode("lineMode"),
      distributorCodes: parseList("distributor"),
      distributorFilterMode: mode("distributorMode"),
      regionCodes: parseList("region"),
      regionFilterMode: mode("regionMode"),
      productCodes: parseList("product"),
      productFilterMode: mode("productMode"),
      cycleMonths: parseList("month"),
      cycleMonthMode: mode("monthMode"),
      weekNumbers: parseList("weekNum").map((value) => Number(value)).filter((value) => Number.isFinite(value)),
      weekNumberMode: mode("weekNumMode"),
      // Individual uploads by weekly_sales_batches.id — see the Upload picker on the dashboard.
      batchIds: parseList("batch"),
      accessScope,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Failed to load the weekly dashboard.") },
      { status: 500 },
    );
  }
}
