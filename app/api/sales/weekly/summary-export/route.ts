import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { resolveWeeklyAccessScope } from "@/lib/sales/weekly/access";
import { latestUploadedPeriod } from "@/lib/sales/weekly/batch-scope";
import { listMasterAreas } from "@/lib/sales/weekly/branch-region-map";
import { loadWeeklyAreaSplitIndex } from "@/lib/sales/weekly/branch-area-split";
import { loadWeeklyManagerIndex } from "@/lib/sales/weekly/manager-attribution";
import { REGION_NAMES, loadMonthlyTargets } from "@/lib/sales/monthly-targets";
import {
  scopeMonthSalesRows,
  scopeMonthTargets,
  vsTargetVisibility,
} from "@/lib/sales/weekly/month-target-scope";
import {
  buildWeeklySummaryWorkbook,
  currentCairoCycleMonth,
  cycleMonthsOfCurrentYear,
  type VsTargetTabInput,
} from "@/lib/sales/weekly/summary-workbook";
import { listWeeklyBatches, loadWeeklyDashboard } from "@/lib/sales/weekly/service";
import { assertWeeklyTerritoryViewer } from "@/lib/sales/weekly/territory-gate";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Ceiling on how many cycle months the Month vs Target tab will build in one export.
 *
 * Each month costs its own `phx_monthly_targets` round trip, and a month outside the current year
 * costs a dashboard load too. Without a cap a pathological month filter fans out unbounded reads
 * against a 60-second route. Whatever is cut is NAMED on the sheet, never silently dropped.
 */
const VS_TARGET_MAX_MONTHS = 12;

// Weekly Sales — "Summarized Report" (5-tab management workbook).
//
// A SECOND export alongside the analyst BI workbook at /api/sales/weekly/export, which is untouched.
// Same auth posture as that route: weekly_sales:read, the territory-viewer role gate (a Medical Rep
// holds the grant but never gets a territory workbook — territory-gate.ts), and the viewer's weekly
// access scope, so a product- or territory-scoped viewer gets the same redaction they get on screen.
// Its own rate-limit scope, so downloading this cannot consume the BI workbook's budget.
//
// Note the sibling /api/sales/weekly/export-batches route read with the service-role client and had
// neither a rate limit nor an access scope until 2026-09-20, when it was given both. That is not a
// pattern to copy: a route that skips the scope leaks restricted products and out-of-territory
// branches into a management workbook.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "weekly_sales", "read");
    assertWeeklyTerritoryViewer(access);
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
      const validated = (await listWeeklyBatches()).filter((batch) => batch.status === "validated");
      const latest = latestUploadedPeriod(validated);
      if (latest) {
        effectiveMonths = [latest.cycleMonth];
        effectiveWeeks = [latest.weekNumber];
      }
    }

    // allWeeks is mandatory on the MTD/YTD loads: without it the batch query caps at 200 batches
    // (newest-first) and would silently truncate the year. Tabs 1-2 need it too when no period
    // filter is set, because a distributor's latest sheet can be months behind the newest.
    const [weekly, mtd, ytd, managerIndex, areaSplit, masterAreas] = await Promise.all([
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
      // The organogram's own line -> area map, so a depot serving several territories can be
      // divided among them instead of stopping at the manager above them all. It fails soft: an
      // unreadable map yields an empty index, which splits nothing and changes no tab.
      loadWeeklyAreaSplitIndex(),
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
    //
    // Every rule this tab needs now lives in src/lib/sales/weekly/month-target-scope.ts: who may see
    // it, when it cannot be answered honestly, and which of the month's targets are actually this
    // viewer's. It moved out of this route because the rule that matters most was MISSING while it
    // was written here — phx_monthly_targets is a SECURITY DEFINER RPC carrying no viewer bound, so
    // narrowing only by the URL params divided a Regional Manager's three regions of sales by the
    // NATIONAL target — and nothing inline in a route handler can be unit-tested.
    const distributorFilterActive = parseList("distributor").length > 0;
    const visibility = vsTargetVisibility(access.role, distributorFilterActive);

    // The month under measurement is THE MONTH HE IS UPLOADING — the cycle month the selected sheet
    // landed in — not simply "this Cairo month". Uploading July's last week on 2 August must be
    // measured against July's target; against August's it would read as a near-total miss.
    //
    // When the selection resolves to no rows at all, fall back to the months he actually ASKED for
    // and show them against their real targets with zero sales. NEVER substitute a different month:
    // this used to fall back to the current Cairo month, so a filter matching nothing produced a
    // sheet headed with a month he never selected, showing that month's target over the empty
    // selection's sales — a fabricated miss. An exclude-mode month filter cannot be used this way
    // (those are the months he asked to leave OUT), so that case gets a blocked sheet instead.
    const requestedMonths = mode("monthMode") === "include" ? effectiveMonths : [];
    const monthsInScope = [...new Set(trendMonths.length > 0 ? trendMonths : requestedMonths)].sort();
    const targetCycleMonths = monthsInScope.slice(0, VS_TARGET_MAX_MONTHS);
    const skippedMonths = monthsInScope.slice(VS_TARGET_MAX_MONTHS);

    // A month's target needs the month's SALES, not the selected week's — so each grid is fed its
    // whole cycle month. The loads already in flight cover it in every real case, so this costs no
    // extra round trip: `mtd` IS the current cycle month and `ytd` holds every month of this year.
    // Only a month from a previous YEAR needs its own read.
    const loadTargetMonths = () =>
      Promise.all(
        targetCycleMonths.map(async (cycleMonth) => {
          const alreadyLoaded =
            cycleMonth === currentCairoCycleMonth() ? "mtd" : ytdMonths.includes(cycleMonth) ? "ytd" : "none";
          const [targets, extra] = await Promise.all([
            loadMonthlyTargets(cycleMonth.slice(0, 7)),
            alreadyLoaded === "none"
              ? loadWeeklyDashboard({ ...sharedFilters, allWeeks: true, cycleMonths: [cycleMonth] })
              : Promise.resolve(null),
          ]);
          const rows =
            alreadyLoaded === "mtd"
              ? (mtd.factRows ?? [])
              : alreadyLoaded === "ytd"
                ? (ytd.factRows ?? []).filter((row) => row.cycleMonth === cycleMonth)
                : (extra?.factRows ?? []);
          return { cycleMonth, targets, rows };
        }),
      );

    const wantsVsTarget = visibility.kind === "shown" && targetCycleMonths.length > 0;

    // The target load is GUARDED, and that is the whole point of the catch: it feeds exactly one of
    // six tabs. Letting it reject inside this Promise.all returned a 500 and cost the manager five
    // tabs that have no dependency on a target at all. A source that cannot be read must say so, not
    // take the workbook down with it.
    const [trend, targetMonths] = await Promise.all([
      trendMonths.length > 0
        ? loadWeeklyDashboard({
            ...sharedFilters,
            allWeeks: true,
            cycleMonths: trendMonths,
            distributorCodes: trendDistributors,
            distributorFilterMode: "include",
          })
        : Promise.resolve(weekly),
      wantsVsTarget
        ? loadTargetMonths().catch((error: unknown) => {
            console.error("[weekly summary-export] monthly targets unavailable", error);
            return null;
          })
        : Promise.resolve(null),
    ]);

    // area_code -> name AND owning region. The region is what makes the tab's subtotals reconcile,
    // and what the access bound needs to place a target row inside a viewer's territory.
    const areaIndex = new Map(
      masterAreas.map((area) => [
        area.areaCode.trim().toUpperCase(),
        { areaName: area.areaName, regionCode: area.regionCode.trim().toUpperCase() },
      ]),
    );
    // Prepared once, not per month and certainly not per row — they cannot change between months.
    const regionFilter = { values: parseList("region"), mode: mode("regionMode") };
    const lineFilterForTargets = { values: parseList("line"), mode: mode("lineMode") };
    const productFilterForTargets = { values: parseList("product"), mode: mode("productMode") };

    const vsTarget = ((): VsTargetTabInput => {
      // "hidden" and "blocked" are already final answers — a role that gets no tab, or a distributor
      // filter that makes every percentage wrong.
      if (visibility.kind !== "shown") return visibility;
      if (targetCycleMonths.length === 0) {
        return {
          kind: "blocked",
          reason:
            "Month vs Target needs to know WHICH month to measure, and the current filters do not " +
            "name one. Pick a month, or a specific upload, and export again.",
        };
      }
      if (targetMonths === null) {
        return {
          kind: "blocked",
          reason:
            "Month vs Target could not be built: this month's uploaded targets could not be read. " +
            "Every other tab in this workbook is complete and unaffected. Try the export again, and " +
            "report it if the tab is still missing.",
        };
      }

      const unresolvedAreas = new Set<string>();
      const unrecognisedLines = new Set<string>();
      const driftAreas = new Set<string>();
      const months = targetMonths.map(({ cycleMonth, targets, rows }) => {
        // Targets are bounded by the viewer's OWN weekly scope first — the same applyWeeklyAccessScope
        // the sales side already ran — then by his URL filters. Numerator and denominator therefore
        // move together by construction; neither can be narrowed without the other.
        const scoped = scopeMonthTargets({
          targets,
          accessScope,
          areaIndex,
          line: lineFilterForTargets,
          region: regionFilter,
          product: productFilterForTargets,
        });
        // ...and the sales side is re-judged on each area's OWN region, so an area row always sits
        // under the region that carries its target and the two reconcile. A no-op on today's data.
        const sales = scopeMonthSalesRows(rows, areaIndex, regionFilter);
        for (const area of scoped.unresolvedAreas) unresolvedAreas.add(area);
        for (const line of scoped.unrecognisedLines) unrecognisedLines.add(line);
        for (const area of sales.driftAreas) driftAreas.add(area);
        return {
          // A cycle month is stored as YYYY-MM-01; the sheet has always named it as YYYY-MM.
          period: cycleMonth.slice(0, 7),
          monthRows: sales.rows,
          targets: scoped.targets,
          targetedLines: scoped.targetedLines,
        };
      });

      // Nothing is dropped silently — it is counted, named, and he decides. (Rows withheld by the
      // ACCESS bound are deliberately not reported: that is intended redaction, not a fault, and
      // stating its size would disclose how much territory the viewer is not allowed to see.)
      const dataNote = [
        skippedMonths.length > 0
          ? `Only the first ${VS_TARGET_MAX_MONTHS} months are shown; ` +
            `${skippedMonths.map((month) => month.slice(0, 7)).join(", ")} ` +
            "were left out of this tab. Narrow the month filter to see them."
          : "",
        unrecognisedLines.size > 0
          ? `Targets on ${[...unrecognisedLines].join(", ")} are not field-line targets and are not ` +
            "measured here."
          : "",
        unresolvedAreas.size > 0
          ? `${unresolvedAreas.size} area${unresolvedAreas.size === 1 ? "" : "s"} carrying a target ` +
            `could not be placed in a region (${[...unresolvedAreas].join(", ")}) — their targets are ` +
            "not counted here until the area master is corrected."
          : "",
        driftAreas.size > 0
          ? `${[...driftAreas].join(", ")} sit in a region other than the one their distributor branch ` +
            "is mapped to, so their sales are excluded from this region filter — the branch-to-area " +
            "map needs revalidating."
          : "",
      ]
        .filter(Boolean)
        .join(" ");

      return { kind: "shown", months, dataNote };
    })();

    const monthLabel = cycleMonths.length > 0 ? cycleMonths.map((m) => m.slice(0, 7)).join(", ") : null;
    const weekLabel = weekNumbers.length > 0 ? weekNumbers.map((w) => `W${w}`).join(", ") : null;
    const periodLabel =
      batchIds.length > 0
        ? `${batchIds.length} selected upload${batchIds.length === 1 ? "" : "s"}`
        : monthLabel || weekLabel
          ? [monthLabel, weekLabel].filter(Boolean).join(" · ")
          : "Latest uploaded week";
    const generatedAt = cairoDateTimeSortable(new Date().toISOString()) + " Cairo";

    const buffer = await buildWeeklySummaryWorkbook({
      weekly,
      mtd,
      ytd,
      managerIndex,
      areaSplit,
      ytdMonths,
      periodLabel,
      generatedAt,
      // 0 or 1 line = one combined tab set; more than one = a tab set per picked line.
      lineFilter: parseList("line"),
      masterAreas,
      trend,
      regionNames: Object.entries(REGION_NAMES).map(([regionCode, regionName]) => ({ regionCode, regionName })),
      vsTarget,
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
