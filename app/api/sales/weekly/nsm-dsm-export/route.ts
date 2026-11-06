import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { REGION_NAMES } from "@/lib/sales/monthly-targets";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { latestUploadedPeriod } from "@/lib/sales/weekly/batch-scope";
import { loadWeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { listMasterAreas } from "@/lib/sales/weekly/branch-region-map";
import { loadWeeklyManagerIndex } from "@/lib/sales/weekly/manager-attribution";
import { buildNsmDsmWorkbook } from "@/lib/sales/weekly/nsm-dsm-workbook";
import { listWeeklyBatches, loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import { assertWeeklyTerritoryViewer } from "@/lib/sales/weekly/territory-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Weekly Sales — "NSM/DSM Export" (the field-manager workbook).
//
// A THIRD export alongside the analyst BI workbook (/api/sales/weekly/export) and the Summarized
// Report (/api/sales/weekly/summary-export), both untouched. Same auth posture as those two:
// weekly_sales:read, the territory-viewer role gate (a Medical Rep holds the grant but never gets a
// territory workbook — territory-gate.ts), and the viewer's weekly access scope, so a product- or
// territory-scoped viewer gets exactly the redaction they get on screen. Its own rate-limit scope,
// so downloading this cannot consume either sibling's budget.
//
// It sends the SAME filter query the other two buttons send, and reads ONE dashboard load — the
// viewer's current filters — so the workbook reconciles to what is on screen. It deliberately does
// not load MTD/YTD scopes: this is the manager's view of the sheet in front of him, not a period
// comparison. That is what the Summarized Report is for.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");
    assertWeeklyTerritoryViewer(access);
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:weekly-nsm-dsm",
    });

    const params = new URL(request.url).searchParams;
    const parseList = (key: string) =>
      params
        .getAll(key)
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
    const mode = (key: string): "include" | "exclude" =>
      (params.get(key) ?? "").toLowerCase() === "exclude" ? "exclude" : "include";

    const accessScope = await resolveWeeklyAccessScope(access);

    const cycleMonths = parseList("month");
    const weekNumbers = parseList("weekNum")
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    const batchIds = parseList("batch");
    const lineFilter = parseList("line");

    // Scope precedence, identical to the Summarized Report so the two buttons never disagree about
    // which sheet the viewer is looking at:
    //   1. Upload picker (?batch=<uuid>) — exact, and the only unambiguous sheet identity.
    //   2. Month / Week-of-month filters, if set.
    //   3. Neither — the LATEST (month, week), not the whole validated history.
    let effectiveMonths = cycleMonths;
    const effectiveWeeks = weekNumbers;
    const periodFilterSet = cycleMonths.length > 0 || weekNumbers.length > 0;
    if (batchIds.length === 0 && !periodFilterSet) {
      const validated = (await listWeeklyBatches()).filter((batch) => batch.status === "validated");
      const latest = latestUploadedPeriod(validated);
      // The MONTH, with every week in it — deliberately NOT latestUploadedPeriod's (month, week),
      // which is what the two sibling exports default to. This book's whole point is the weekly
      // grid: W1..Wn per product with the month beside them. Defaulting to the latest WEEK collapsed
      // that grid to one column and printed a month total that was really one week's sales, which
      // reads as a collapse in the business rather than as a narrow scope.
      if (latest) effectiveMonths = [latest.cycleMonth];
    }

    const [dashboard, managerIndex, areaSplit, masterAreas] = await Promise.all([
      loadWeeklyDashboard({
        lineCodes: lineFilter,
        lineFilterMode: mode("lineMode"),
        distributorCodes: parseList("distributor"),
        distributorFilterMode: mode("distributorMode"),
        regionCodes: parseList("region"),
        regionFilterMode: mode("regionMode"),
        productCodes: parseList("product"),
        productFilterMode: mode("productMode"),
        accessScope,
        includeFactRows: true,
        // MANDATORY — the same safeguard both sibling exports carry. A row whose product never
        // resolved to a mapped master product must never reach a report: the distributor's raw SKU
        // appears as a phantom product carrying units that belong to a real one, so the real product
        // reads SHORT by exactly that amount and the total splits across two names.
        excludeUnmapped: true,
        // An explicit upload selection replaces the period filters entirely — the sheet IS the scope.
        cycleMonths: batchIds.length > 0 ? [] : effectiveMonths,
        cycleMonthMode: mode("monthMode"),
        weekNumbers: batchIds.length > 0 ? [] : effectiveWeeks,
        weekNumberMode: mode("weekNumMode"),
        batchIds,
        allWeeks: batchIds.length > 0 || effectiveWeeks.length === 0,
      }),
      loadWeeklyManagerIndex(),
      // The organogram's own line -> area map, so a depot serving several territories is divided
      // among them instead of stopping at the manager above them all. Fails soft: an unreadable map
      // yields an empty index, which splits nothing and changes no tab.
      loadWeeklyAreaSplitIndex(),
      // Rows are AREAS, and the owner's standing rule is names, never codes. The fact rows carry
      // only area_code, so the vocabulary comes from the master alongside them.
      listMasterAreas(),
    ]);

    const rows = dashboard.factRows ?? [];

    // The period label is the cycle month(s) the rows actually landed in — never "this Cairo month".
    // A July sheet uploaded in August is a JULY report, and heading it August would be a lie the
    // reader has no way to catch.
    const monthsInRows = [...new Set(rows.map((row) => row.cycleMonth).filter(Boolean))].sort();
    const monthName = (cycleMonth: string) => {
      const names = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
      ];
      const [year, month] = cycleMonth.split("-");
      return `${names[Number(month) - 1] ?? month} ${year}`;
    };
    const periodLabel =
      monthsInRows.length === 0
        ? "No period"
        : monthsInRows.length === 1
          ? monthName(monthsInRows[0])
          : `${monthName(monthsInRows[0])} - ${monthName(monthsInRows[monthsInRows.length - 1])}`;

    const buffer = await buildNsmDsmWorkbook({
      rows,
      areaSplit,
      managerIndex,
      areaNames: new Map(masterAreas.map((area) => [area.areaCode, area.areaName])),
      regionNames: new Map(Object.entries(REGION_NAMES)),
      lineFilter,
      // The product AXIS, so the columns mean the same thing in every book built from this sheet.
      // availableProducts is the dashboard's stable filter universe — scoped by week and distributor
      // only, never by the line, region or product filters — so a district manager's book and the
      // national one derive the SAME order. Ranking by the value present in the view instead made
      // column N a different product in each book, which is the one thing a reader cannot catch.
      productAxis: (dashboard.availableProducts ?? []).map((option) => option.code),
      // Which region this book is FOR, taken from the request rather than from the rows. Splitting a
      // depot across the areas it serves can land a fraction of a region-filtered row in a
      // neighbouring region, so the rows alone cannot say whose book this is.
      regionFilter: parseList("region"),
      periodLabel,
      generatedAt: new Date().toISOString(),
    });

    // Name the file after what is actually in it, so two downloads never collide in a Downloads
    // folder and a manager can tell one month's book from another without opening it.
    const periodSegment =
      batchIds.length > 0
        ? `${batchIds.length}-upload${batchIds.length === 1 ? "" : "s"}`
        : monthsInRows.length > 0
          ? monthsInRows.map((month) => month.slice(0, 7)).join("-")
          : "latest-sheet";
    const weekSegment = weekNumbers.length > 0 ? `_${weekNumbers.map((week) => `w${week}`).join("-")}` : "";
    const slug = (values: string[]) =>
      values.length === 0 ? "" : `_${values.map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-")).join("-")}`;
    const filename =
      `phoenix-weekly-nsm-dsm_${periodSegment}${weekSegment}` +
      `${slug(lineFilter)}${slug(parseList("region"))}.xlsx`;

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return new Response(JSON.stringify({ error: "rate_limited", message: error.message }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(error.retryAfterSeconds) },
      });
    }
    if (isForbiddenError(error)) {
      return new Response(JSON.stringify({ error: "Forbidden." }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (error instanceof SalesWorkflowError) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: error.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: clientSafeErrorMessage(error, "NSM/DSM export failed.") }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
