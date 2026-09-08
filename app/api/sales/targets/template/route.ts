import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  SALES_LINES,
  expandTargetPeriodScope,
  loadMonthlyTargets,
  loadTargetableAreas,
  loadTargetableProducts,
  type TargetPeriodScope,
} from "@/lib/sales/monthly-targets";
import { generateTargetsTemplate } from "@/lib/sales/targets-template";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES: readonly TargetPeriodScope[] = ["month", "quarter", "semester"];
const PERIOD_RE = /^\d{4}-\d{2}$/;

// GET /api/sales/targets/template?line=cns&period=2026-10&scope=quarter&populated=true
//
// One workbook, two fill states. `populated=false` lays out every (period × area × product) row
// with the codes and dropdowns wired and the numbers blank; `populated=true` is the same sheet
// with the current targets already in it, so a month can be edited in Excel and uploaded straight
// back rather than re-typed. `scope` widens the layout to the CALENDAR quarter or half containing
// `period` (owner, 2026-09-08 — he sets targets by month, quarter or semester).
//
// Edit access = sales:import (Super Admin + SFE Manager). The populated download carries real
// target values, so it is gated exactly like the authoring screen rather than like a blank form.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const url = new URL(request.url);
    const requested = url.searchParams.get("line");
    // The smart template is per-line (its dropdowns + auto-fill need that line's products
    // and areas), so resolve to a concrete line — defaulting to the first when none is given.
    const line = SALES_LINES.find((entry) => entry.code === requested) ?? SALES_LINES[0];

    const requestedScope = String(url.searchParams.get("scope") ?? "month") as TargetPeriodScope;
    const scope: TargetPeriodScope = SCOPES.includes(requestedScope) ? requestedScope : "month";
    const requestedPeriod = String(url.searchParams.get("period") ?? "").trim();
    const populated = url.searchParams.get("populated") === "true";

    // No period given means the caller wants the plain form, not a span — that is the shape every
    // existing caller of this route expects, so it must stay reachable.
    const periods = PERIOD_RE.test(requestedPeriod) ? expandTargetPeriodScope(requestedPeriod, scope) : [];

    const [areas, products] = await Promise.all([
      loadTargetableAreas(line.code),
      loadTargetableProducts(line.code),
    ]);

    // `${period}|${areaCode}|${productCode}` -> the stored target. Loaded per month because
    // phx_monthly_targets takes one period; the spans here are 1, 3 or 6 calls.
    let existing: Map<string, { targetUnits: number | null; targetValue: number | null }> | undefined;
    if (populated && periods.length > 0) {
      existing = new Map();
      const loaded = await Promise.all(periods.map((period) => loadMonthlyTargets(period)));
      for (const rows of loaded) {
        for (const row of rows) {
          if (row.lineCode !== line.code) continue;
          existing.set(`${row.period}|${row.areaCode}|${row.productCode.toUpperCase()}`, {
            targetUnits: row.targetUnits,
            targetValue: row.targetValue,
          });
        }
      }
    }

    const buffer = await generateTargetsTemplate({
      lineLabel: line.label,
      areas,
      products,
      periods,
      existing,
    });

    const span = periods.length > 0 ? `-${scope}-${periods[0]}` : "";
    const fileName = `targets-${populated ? "current" : "template"}-${line.code}${span}.xlsx`;
    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to build the template.") }, { status: 500 });
  }
}
