import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { latestUploadedPeriod } from "@/lib/sales/weekly/batch-scope";
import { listMasterAreas } from "@/lib/sales/weekly/branch-region-map";
import { loadWeeklyManagerIndex } from "@/lib/sales/weekly/manager-attribution";
import { REGION_NAMES, lineName, loadMonthlyTargets } from "@/lib/sales/monthly-targets";
import {
  buildWeeklySummaryWorkbook,
  currentCairoCycleMonth,
  cycleMonthsOfCurrentYear,
  type MonthTargetInput,
} from "@/lib/sales/weekly/summary-workbook";
import { listWeeklyBatches, loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Weekly Sales — "Summarized Report" (5-tab management workbook).
//
// A SECOND export alongside the analyst BI workbook at /api/sales/weekly/export, which is untouched.
// Same auth posture as that route: weekly_sales:read + the viewer's weekly access scope, so a
// product- or territory-scoped viewer gets the same redaction they get on screen. Its own rate-limit
// scope, so downloading this cannot consume the BI workbook's budget.
//
// Note the sibling /api/sales/weekly/export-batches route has neither a rate limit nor an access
// scope — it reads with the service-role client directly. That is not a pattern to copy here; doing
// so would leak restricted products and out-of-territory branches into a management workbook.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");
    await assertExportRateLimit({
      actor: access.loginId ?? access.hrId,
      request,
      scope: "export:sales:weekly-summary",
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

    // Non-period filters (distributor / region / product / line) apply to ALL five tabs, so a
    // manager exporting their own line sees a coherent workbook. The PERIOD filters apply only to
    // Tabs 1-2 — Tabs 3-5 define their own period by construction (this month / this year).
    const sharedFilters = {
      lineCodes: parseList("line"),
      lineFilterMode: mode("lineMode"),
      distributorCodes: parseList("distributor"),
      distributorFilterMode: mode("distributorMode"),
      regionCodes: parseList("region"),
      regionFilterMode: mode("regionMode"),
      productCodes: parseList("product"),
      productFilterMode: mode("productMode"),
      accessScope,
      includeFactRows: true,
      // MANDATORY — the same safeguard the BI export has always had (export/route.ts).
      //
      // A row whose product never resolved to a mapped master product must never reach a report. It
      // is not merely noise: the distributor's raw SKU appears as a phantom product carrying units
      // that belong to a real one, so the real product reads SHORT by exactly that amount and the
      // total is split across two names. Measured on overseas June W3: 635 units across 4 unmapped
      // SKUs, one of them "لاكتو ال اف لبن أطفال 400 جرام" — a Lacto the master already lists as
      // Lacto Advanced / Lacto Basic. Mapping is a precondition for reporting, not a nicety.
      excludeUnmapped: true,
    } as const;

    const cycleMonths = parseList("month");
    const weekNumbers = parseList("weekNum")
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    const ytdMonths = cycleMonthsOfCurrentYear();

    // "البيع اللي اترفع" — the sheet that was uploaded, not the whole history.
    //
    // Scope precedence for Tabs 1-2:
    //   1. Upload picker (?batch=<uuid>) — exact, and the only unambiguous identity. A week date is
    //      not: distributors share week dates, and the loader merges dates less than 5 days apart
    //      into one group and expands any selection back to the whole group. That is what inflated
    //      overseas Pedia to 11,455 units against a true 1,005.
    //   2. Month / Week-of-month filters, if he set them.
    //   3. Neither — fall back to the LATEST (month, week) rather than the whole validated history,
    //      which is what made the first build show dates going back to May.
    //
    // Batch ids are applied inside the loader AFTER de-cumulation, never as a fetch narrowing:
    // fetching only the chosen sheet would strip the earlier weeks of its month, and each week is
    // subtracted from the one before, so the sheet would report its cumulative figure instead.
    const batchIds = parseList("batch");
    const periodFilterSet = cycleMonths.length > 0 || weekNumbers.length > 0;
    let effectiveMonths = cycleMonths;
    let effectiveWeeks = weekNumbers;
    if (batchIds.length === 0 && !periodFilterSet) {
      const validated = (await listWeeklyBatches(500)).filter((batch) => batch.status === "validated");
      const latest = latestUploadedPeriod(validated);
      if (latest) {
        effectiveMonths = [latest.cycleMonth];
        effectiveWeeks = [latest.weekNumber];
      }
    }

    // allWeeks is mandatory on the MTD/YTD loads: without it the batch query caps at 200 batches
    // (newest-first) and would silently truncate the year. Tabs 1-2 need it too when no period
    // filter is set, because a distributor's latest sheet can be months behind the newest.
    const [weekly, mtd, ytd, managerIndex, masterAreas] = await Promise.all([
      loadWeeklyDashboard({
        ...sharedFilters,
        // An explicit upload selection replaces the period filters entirely — the sheet IS the scope.
        cycleMonths: batchIds.length > 0 ? [] : effectiveMonths,
        cycleMonthMode: mode("monthMode"),
        weekNumbers: batchIds.length > 0 ? [] : effectiveWeeks,
        weekNumberMode: mode("weekNumMode"),
        batchIds,
        allWeeks: batchIds.length > 0,
      }),
      loadWeeklyDashboard({ ...sharedFilters, allWeeks: true, cycleMonths: [currentCairoCycleMonth()] }),
      loadWeeklyDashboard({ ...sharedFilters, allWeeks: true, cycleMonths: ytdMonths }),
      loadWeeklyManagerIndex(),
      // Tab 2's rows are AREAS, and the owner's standing rule is names, never codes. The fact rows
      // carry only area_code, so the vocabulary comes from the master alongside them.
      listMasterAreas(),
    ]);

    // The subtitle must say WHICH sheet is on screen. "All months · All weeks" was the old label and
    // it was actively misleading — it read as the whole history when the tab now shows one upload.
    // The trend column needs a SERIES, and the selected upload is a single point. Reload the same
    // scope across every week of whatever cycle months the chosen rows landed in, so each region can
    // show its trajectory around the selected sheet. Sequential on purpose: the months are only
    // known once `weekly` has resolved.
    //
    // It MUST also inherit the selected upload's DISTRIBUTORS. Inheriting only the line filter drew
    // every distributor's month behind a table showing one distributor's sheet — two different
    // populations in one row. June alone carries 8 distinct week dates across 7 distributors, so the
    // mixed series bore no relation to the numbers beside it (Cairo drew a peak-then-fall against a
    // PS-only reality of 26 → 42 → 105 → 124, steadily rising).
    const trendMonths = [...new Set((weekly.factRows ?? []).map((row) => row.cycleMonth).filter(Boolean))];
    const trendDistributors = [...new Set((weekly.factRows ?? []).map((row) => row.distributorCode).filter(Boolean))];

    // ── Month vs Target ───────────────────────────────────────────────────────
    // The month under measurement is THE MONTH HE IS UPLOADING — the cycle month the selected sheet
    // landed in — not simply "this Cairo month". Uploading July's last week on 2 August must be
    // measured against July's target; against August's it would read as a near-total miss.
    const targetCycleMonth = [...trendMonths].sort().at(-1) ?? currentCairoCycleMonth();
    const targetPeriod = targetCycleMonth.slice(0, 7);

    // A month's target needs the month's SALES, not the selected week's — so the vs-target grid is
    // fed the whole cycle month. Both loads already in flight cover it in every real case, so this
    // costs no extra round trip: `mtd` IS the current cycle month, and `ytd` holds every month of
    // this year. Only a sheet from a previous YEAR needs its own read.
    const monthAlreadyLoaded =
      targetCycleMonth === currentCairoCycleMonth() ? "mtd" : ytdMonths.includes(targetCycleMonth) ? "ytd" : "none";

    const [trend, monthTargetRows, extraMonth] = await Promise.all([
      trendMonths.length > 0
        ? loadWeeklyDashboard({
            ...sharedFilters,
            allWeeks: true,
            cycleMonths: trendMonths,
            distributorCodes: trendDistributors,
            distributorFilterMode: "include",
          })
        : Promise.resolve(weekly),
      loadMonthlyTargets(targetPeriod),
      monthAlreadyLoaded === "none"
        ? loadWeeklyDashboard({ ...sharedFilters, allWeeks: true, cycleMonths: [targetCycleMonth] })
        : Promise.resolve(null),
    ]);

    const monthRows =
      monthAlreadyLoaded === "mtd"
        ? (mtd.factRows ?? [])
        : monthAlreadyLoaded === "ytd"
          ? (ytd.factRows ?? []).filter((row) => row.cycleMonth === targetCycleMonth)
          : (extraMonth?.factRows ?? []);

    // A filter that narrows the SALES must narrow the TARGET the same way, or the tab reports a miss
    // the field never made. Targets are held at (line, area, product), so line, region (via the
    // area's own region) and product all map across exactly. Distributor is the one that cannot —
    // a target belongs to an area, not to whoever delivered it — so that one is disclosed instead.
    const areaRegion = new Map(masterAreas.map((area) => [area.areaCode.trim().toUpperCase(), area.regionCode]));
    const wanted = (key: string) => new Set(parseList(key).map((value) => value.trim().toUpperCase()));
    const lineWanted = wanted("line");
    const regionWanted = wanted("region");
    const productWanted = wanted("product");
    const passes = (set: Set<string>, filterMode: "include" | "exclude", value: string) =>
      set.size === 0 || set.has(value.trim().toUpperCase()) === (filterMode === "include");
    const scopedTargetRows = monthTargetRows.filter(
      (row) =>
        passes(lineWanted, mode("lineMode"), lineName(row.lineCode)) &&
        passes(regionWanted, mode("regionMode"), areaRegion.get(row.areaCode.trim().toUpperCase()) ?? "") &&
        passes(productWanted, mode("productMode"), row.productCode),
    );

    // The engine speaks line CODES; every row of this workbook speaks the official line NAME. Resolve
    // once here so the workbook builder never has to reach into the targets domain — and therefore
    // never drags a database client into a module the tests build workbooks from directly.
    const monthTargets: MonthTargetInput[] = scopedTargetRows.map((row) => ({
      lineLabel: lineName(row.lineCode),
      areaCode: row.areaCode,
      targetUnits: row.targetUnits ?? 0,
    }));
    // "Has a target" means a real number was uploaded for that line. A line present only with null or
    // zero units is not being measured in units, and saying it achieved 0% would be a fabrication.
    const targetedLines = [
      ...new Set(monthTargets.filter((target) => target.targetUnits > 0).map((target) => target.lineLabel).filter(Boolean)),
    ];

    const distributorFilterActive = parseList("distributor").length > 0;
    const vsTargetFilterCaveat = distributorFilterActive
      ? "CAUTION: a distributor filter is active. A target belongs to an AREA, not to the distributor " +
        "that delivered it, so it cannot be narrowed the same way — the sales here are one " +
        "distributor's while the target is the area's whole month, and every percentage on this tab " +
        "is understated. Clear the distributor filter to read achievement. "
      : "";

    const monthLabel = cycleMonths.length > 0 ? cycleMonths.map((m) => m.slice(0, 7)).join(", ") : null;
    const weekLabel = weekNumbers.length > 0 ? weekNumbers.map((w) => `W${w}`).join(", ") : null;
    const periodLabel =
      batchIds.length > 0
        ? `${batchIds.length} selected upload${batchIds.length === 1 ? "" : "s"}`
        : monthLabel || weekLabel
          ? [monthLabel, weekLabel].filter(Boolean).join(" · ")
          : "Latest uploaded week";
    const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

    const buffer = await buildWeeklySummaryWorkbook({
      weekly,
      mtd,
      ytd,
      managerIndex,
      ytdMonths,
      periodLabel,
      generatedAt,
      // 0 or 1 line = one combined tab set; more than one = a tab set per picked line.
      lineFilter: parseList("line"),
      masterAreas,
      trend,
      vsTarget: {
        period: targetPeriod,
        monthRows,
        targets: monthTargets,
        targetedLines,
        regionNames: Object.entries(REGION_NAMES).map(([regionCode, regionName]) => ({ regionCode, regionName })),
        filterCaveat: vsTargetFilterCaveat,
      },
    });

    // Name the file after what is actually in it. "all-months" was left over from the old scope and
    // now lies: with no period filter the workbook holds each distributor's latest sheet, not the
    // whole history. Line and distributor filters are named too, so two downloads never collide.
    const periodSegment =
      batchIds.length > 0
        ? `${batchIds.length}-upload${batchIds.length === 1 ? "" : "s"}`
        : cycleMonths.length > 0
          ? cycleMonths.map((m) => m.slice(0, 7)).join("-")
          : "latest-sheet";
    const weekSegment = weekNumbers.length > 0 ? `_${weekNumbers.map((w) => `w${w}`).join("-")}` : "";
    const slug = (values: string[]) =>
      values.length === 0 ? "" : `_${values.map((v) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-")).join("-")}`;
    const filename =
      `phoenix-weekly-summary_${periodSegment}${weekSegment}` +
      `${slug(parseList("line"))}${slug(parseList("distributor"))}.xlsx`;

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
    return new Response(JSON.stringify({ error: clientSafeErrorMessage(error, "Summarized report failed.") }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
