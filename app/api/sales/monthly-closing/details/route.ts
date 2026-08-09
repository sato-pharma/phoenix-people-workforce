import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadMonthlyClosingDetails } from "@/lib/sales/monthly-closing-details";
import {
  listMonthlyClosingLines,
  listMonthlyClosingPeriods,
} from "@/lib/sales/monthly-distributor-import";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Unlike the sibling matrix route, Details is NOT admin-only: every role that can read sales
// gets it, bounded to their own line/region/product scope by resolveSalesAccessScope inside the
// service. Confidential products and the Head Office line stay CEO / Super Admin only there —
// `includeConfidential` from the query string is a request, not a grant.

function list(searchParams: URLSearchParams, key: string): string[] {
  return searchParams
    .getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    const { searchParams } = new URL(request.url);

    // Resolve the selection server-side; the query string never picks data the scope forbids.
    const [availableLines, availablePeriods] = await Promise.all([
      listMonthlyClosingLines(),
      listMonthlyClosingPeriods(),
    ]);
    const requestedLine = searchParams.get("line");
    const requestedPeriod = searchParams.get("period");
    const line = requestedLine && availableLines.includes(requestedLine)
      ? requestedLine
      : availableLines[0] ?? null;
    const period = requestedPeriod && availablePeriods.includes(requestedPeriod)
      ? requestedPeriod
      : availablePeriods[0] ?? null;

    const data = await loadMonthlyClosingDetails({
      access,
      line,
      period,
      availableLines,
      availablePeriods,
      includeConfidential: searchParams.get("includeConfidential") === "true",
      page: Number(searchParams.get("page") ?? 1),
      pageSize: Number(searchParams.get("pageSize") ?? 200),
      filters: {
        regionCodes: list(searchParams, "regionCodes"),
        areaCodes: list(searchParams, "areaCodes"),
        productCodes: list(searchParams, "productCodes"),
        distributorCodes: list(searchParams, "distributorCodes"),
        inclusion: searchParams.get("inclusion") ?? "",
        search: searchParams.get("search") ?? "",
      },
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: clientSafeErrorMessage(error, "Failed to load Monthly Closing details."),
      },
      { status: 500 },
    );
  }
}
