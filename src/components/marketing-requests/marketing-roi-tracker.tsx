"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ROI Tracker — one page, four zones, everything visible at once.
//
// NOT a request table with the answers buried in it. That shape already exists (ROI Tracking) and
// it fails on this data: today all 217 requests read "Data pending / EGP 0 / 0%", so a table shows
// 217 rows of nothing while burying the three facts that actually matter — how much money is in
// flight, when it becomes judgeable, and what is blocking measurement. The zones answer those
// first; the request list is the last thing on the page, not the whole page.
//
// So the page reads top-to-bottom, each zone answering one question, no tabs and nothing hidden:
//
//   ZONE 1  WHERE IS THE MONEY?    a single bar; every EGP lands in exactly one bucket,
//                                  including "Unmeasurable" so broken data is a number an
//                                  executive sees rather than a footnote
//   ZONE 2  IS IT MATURING?        one compact row per spend-month — how much of what we
//                                  committed that month has come back so far
//   ZONE 3  WHAT NEEDS ME?         three counts: ready to judge / blocked / not started yet
//   ZONE 4  SHOW ME THE REQUESTS   the list, and one click opens the full case file
//
// Clicking any band in zone 1 or any chip in zone 3 sets `focus`, which filters zone 4. Zone 4
// additionally carries a multi-select filter bar (see FACETS) plus free-text search, so anyone can
// narrow the list on any dimension the rows actually carry. All of it is client-side over rows the
// server already scoped, and all of it is stateless between visits — there are still no view modes,
// no saved perspectives and no config to maintain, which is the over-engineering being avoided.
//
// Every number originates in getMarketingRoiReport (the authoritative v2 engine) via
// getMarketingRoiTracker, so this page cannot disagree with ROI Tracking. Labels come from
// roi-labels.ts for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

import { countOf } from "@/lib/i18n/format";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, RefreshCcw, Search, SlidersHorizontal, Target } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import { ROI_DATA_COVERAGE_LABEL, ROI_RESULT_STATUS_LABEL } from "@/lib/marketing-requests/roi-labels";
import type { MarketingRoiExplain } from "@/lib/marketing-requests/roi-explain";
import { ROI_NEAR_MISS_ACTION, ROI_NEAR_MISS_LABEL } from "@/lib/marketing-requests/roi-explain";
import type { MarketingRoiResultStatus, RoiFilterState } from "@/lib/marketing-requests/roi-report-types";
import { emptyRoiFilterState } from "@/lib/marketing-requests/roi-report-types";
import type { RoiTrackerReport, RoiTrackerRow } from "@/lib/marketing-requests/roi-tracker-service";
import { singleProductUnits } from "@/lib/marketing-requests/roi-units";
import { cairoDate } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";

const money = (value: number) => `EGP ${Math.round(value).toLocaleString("en-US")}`;
const compact = (value: number) =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(Math.round(value));
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const units = (value: number) => Math.round(value).toLocaleString("en-US");

/**
 * Every request lands in exactly ONE bucket — that is what makes the zone-1 bar honest (the
 * segments always sum to the total committed, so no money can hide).
 *
 * Order is deliberate: a campaign that hit its target counts as delivered even if one of its
 * pharmacy codes is unverified, because the sales actually landed. Only campaigns that have NOT
 * delivered are judged on whether their data can support a verdict at all.
 */
type Bucket = "delivered" | "unmeasurable" | "missed" | "measuring";

function bucketOf(row: RoiTrackerRow): Bucket {
  if (row.resultStatus === "on_track") return "delivered";
  if (row.suspectPharmacyCount > 0 || row.pharmacies.length === 0) return "unmeasurable";
  if (row.dataCoverage === "complete") return "missed";
  return "measuring";
}

const BUCKET_META: Record<Bucket, { label: string; bar: string; chip: string; help: string }> = {
  delivered: {
    bar: "bg-emerald-500",
    chip: "border-emerald-200 bg-emerald-50 text-emerald-700",
    help: "Hit the required return.",
    label: "Delivered",
  },
  measuring: {
    bar: "bg-sky-400",
    chip: "border-sky-200 bg-sky-50 text-sky-700",
    help: "Window still open — not judgeable yet.",
    label: "Still measuring",
  },
  missed: {
    bar: "bg-amber-500",
    chip: "border-amber-200 bg-amber-50 text-amber-700",
    help: "Window closed below the required return.",
    label: "Missed",
  },
  unmeasurable: {
    bar: "bg-rose-500",
    chip: "border-rose-200 bg-rose-50 text-rose-700",
    help: "Pharmacy codes missing or unverified — cannot attribute sales.",
    label: "Unmeasurable",
  },
};

const BUCKET_ORDER: Bucket[] = ["delivered", "measuring", "missed", "unmeasurable"];

/** Zone 3 — the three things a human can act on. Derived, not stored. */
type Action = "judge" | "blocked" | "upcoming";

function actionOf(row: RoiTrackerRow): Action | null {
  if (row.suspectPharmacyCount > 0 || row.pharmacies.length === 0) return "blocked";
  if (row.dataCoverage === "complete") return "judge";
  if (row.dataCoverage === "no_validated_data") return "upcoming";
  return null;
}

const ACTION_META: Record<Action, { label: string; help: string; tone: string }> = {
  blocked: { help: "Bad or missing pharmacy codes", label: "Blocked", tone: "border-rose-200 bg-rose-50 text-rose-700" },
  judge: { help: "Window closed — needs a verdict", label: "Ready to judge", tone: "border-amber-200 bg-amber-50 text-amber-700" },
  upcoming: { help: "Window has not opened yet", label: "Not started", tone: "border-slate-200 bg-slate-50 text-slate-600" },
};

const VERDICT_STYLE: Record<MarketingRoiResultStatus, string> = {
  awaiting_data: "border-sky-200 bg-sky-50 text-sky-700",
  behind: "border-amber-200 bg-amber-50 text-amber-700",
  no_data: "border-slate-200 bg-slate-50 text-slate-600",
  on_track: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

// Every state roi-tracker-service can emit has its own entry — a missing one fell back to
// "Unvalidated", so a code a reviewer had approved by hand, or a venue with no distributor
// account at all, read as never checked.
const REFERENCE_STYLE: Record<string, string> = {
  ambiguous: "border-amber-200 bg-amber-50 text-amber-700",
  manual_approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  matched: "border-emerald-200 bg-emerald-50 text-emerald-700",
  no_code: "border-slate-200 bg-slate-50 text-slate-600",
  not_found: "border-rose-200 bg-rose-50 text-rose-700",
  pending: "border-slate-200 bg-slate-50 text-slate-600",
};
const REFERENCE_LABEL: Record<string, string> = {
  ambiguous: "Ambiguous code",
  manual_approved: "Approved by a reviewer",
  matched: "Verified",
  no_code: "No distributor code",
  not_found: "Unknown code",
  pending: "Unvalidated",
};

/**
 * Nothing on this page renders a raw enum. Every machine value gets a sentence a person can read
 * — an underscore-stripped enum ("no validated coverage") still reads as leaked database internals,
 * so these are written out properly instead.
 */
const REASON_LABEL: Record<string, string> = {
  attributed: "Sales matched — this campaign is being measured normally.",
  missing_pharmacy_code: "The target pharmacy codes are missing or unverified, so no sale can be matched to this campaign.",
  no_validated_coverage: "No validated sales data covers this campaign's window yet.",
  partial_data_pending: "Only part of the window has validated sales data so far — the rest is still loading.",
  pharmacy_no_product_sales: "The target pharmacies had no sales of the promoted products inside the window.",
  product_bridge_issue: "The promoted products could not be matched to Source-of-Sales products.",
};
const readableReason = (reason: string) => REASON_LABEL[reason] ?? "Unrecognised reason — please report this.";

const STEP_STATUS_LABEL: Record<string, string> = {
  approved: "Approved",
  current: "Waiting on this step",
  pending: "Not reached yet",
  rejected: "Rejected",
  returned: "Sent back",
  skipped: "Skipped",
};
const readableStepStatus = (status: string) => STEP_STATUS_LABEL[status] ?? "Unknown";

/**
 * Export columns mirror what a request block shows on screen, then add the target-pharmacy
 * detail (name / code / distributor) that the card only summarises as a count.
 *
 * Ratios stay text ("62%", "Not measured yet") rather than numeric, because summing coverage
 * percentages down a column would be meaningless.
 */
const EXPORT_COLUMNS: ExportColumn[] = [
  { key: "requestCode", label: "Request", width: 14 },
  { key: "customerName", label: "Customer", width: 30 },
  { key: "region", label: "Region", width: 18 },
  { key: "line", label: "Line", width: 16 },
  { key: "requester", label: "Requester", width: 22 },
  { key: "requestType", label: "Request type", width: 20 },
  { key: "status", label: "Request status", width: 20 },
  { key: "progress", label: "Progress", width: 18 },
  { key: "result", label: "Result", width: 16 },
  { key: "salesData", label: "Sales data", width: 24 },
  { key: "payDate", label: "Pay date", width: 13 },
  { key: "roiWindow", label: "ROI window", width: 22 },
  // ── target pharmacy: one row each, so a request with 3 pharmacies occupies 3 rows ──
  { key: "pharmacyName", label: "Target pharmacy", width: 34 },
  { key: "pharmacyCode", label: "Pharmacy code", width: 18 },
  { key: "distributorName", label: "Distributor", width: 26 },
  { key: "pharmacyCodeStatus", label: "Code check", width: 18 },
  { key: "pharmacyIndex", label: "Pharmacy # of", width: 14 },
  // ── request-level figures: written on the FIRST pharmacy row only (see toExportRows) ──
  { key: "forecastUnits", label: "Forecast units", numeric: true, width: 15 },
  { key: "actualUnits", label: "Units sold", numeric: true, width: 13 },
  { key: "unitAchievement", label: "Units vs forecast", width: 17 },
  { key: "estimatedCost", label: "Spent (EGP)", numeric: true, width: 15 },
  { key: "requiredRoiValue", label: "Required return (EGP)", numeric: true, width: 20 },
  { key: "actualSalesValue", label: "Earned (EGP)", numeric: true, width: 16 },
  { key: "coverage", label: "Covered", width: 12 },
  { key: "coverageGap", label: "Gap to target (EGP)", numeric: true, width: 19 },
  { key: "products", label: "Products", width: 34 },
];

const CODE_CHECK_LABEL: Record<string, string> = {
  ambiguous: "Ambiguous — matches more than one",
  manual_approved: "Approved by a reviewer",
  matched: "Verified",
  no_code: "No distributor code",
  not_found: "Not found in reference",
  pending: "Never validated",
};

/**
 * One row per targeted pharmacy, because a request can target several and the whole point of
 * these columns is to see them individually.
 *
 * The request-level money and unit figures are written on that request's FIRST pharmacy row and
 * left blank on its continuation rows. Repeating them would inflate the workbook's SUM() totals
 * by the pharmacy count — a request costing EGP 40,000 across 3 pharmacies would read as
 * EGP 120,000 spent. Blank continuation cells keep every total exactly equal to the on-screen
 * figures. The identity columns DO repeat, so filtering by pharmacy or distributor in Excel
 * still shows which request each row belongs to.
 */
function toExportRows(row: RoiTrackerRow): ExportRow[] {
  // Units only for a single-product request — units of different products are never added, so a
  // multi-product request leaves the unit cells blank and is measured by value.
  const unitFigures = singleProductUnits(row);
  const forecastUnits = unitFigures?.forecastUnits ?? null;
  // Same rule the cards use: with no validated sales, an actual of 0 is "not measured", not a
  // measured zero. Blank cells keep that distinction in Excel instead of asserting a false zero.
  const measured = row.dataCoverage !== "no_validated_data";

  const identity = {
    customerName: row.customerName,
    line: row.line ?? "",
    payDate: row.payDate ?? "",
    progress: BUCKET_META[bucketOf(row)].label,
    region: row.region ?? "",
    requestCode: row.requestCode,
    requestType: row.requestTypeName ?? "",
    requester: row.requesterName ?? "Unknown requester",
    result: ROI_RESULT_STATUS_LABEL[row.resultStatus],
    roiWindow: row.roiWindow ?? "",
    salesData: ROI_DATA_COVERAGE_LABEL[row.dataCoverage],
    status: readableRequestStatus(row.status),
  };

  const figures = {
    actualSalesValue: measured ? Math.round(row.actualSalesValue) : null,
    actualUnits: measured && unitFigures ? Math.round(unitFigures.actualUnits) : null,
    coverage: measured ? percent(row.actualCoverageRatio) : "Not measured yet",
    coverageGap: Math.round(row.coverageGap),
    estimatedCost: Math.round(row.estimatedCost),
    forecastUnits,
    products: row.products.map((product) => product.productName).join(", "),
    requiredRoiValue: Math.round(row.requiredRoiValue),
    unitAchievement: !unitFigures
      ? "Several products — measured by value"
      : measured && unitFigures.forecastUnits > 0
        ? percent(unitFigures.actualUnits / unitFigures.forecastUnits)
        : "Not measured yet",
  };

  // A request with no targets still deserves a row — otherwise it silently vanishes from the
  // export, which is exactly the kind of blind spot this module exists to remove.
  if (row.pharmacies.length === 0) {
    return [
      {
        ...identity,
        ...figures,
        distributorName: "",
        pharmacyCode: "",
        pharmacyCodeStatus: "No target pharmacy recorded",
        pharmacyIndex: "",
        pharmacyName: "",
      },
    ];
  }

  return row.pharmacies.map((pharmacy, index) => ({
    ...identity,
    ...(index === 0 ? figures : {}),
    distributorName: pharmacy.distributorName ?? pharmacy.distributorCode ?? "",
    pharmacyCode: pharmacy.customerCode,
    pharmacyCodeStatus: CODE_CHECK_LABEL[pharmacy.referenceStatus] ?? "Unknown",
    pharmacyIndex: `${index + 1} of ${row.pharmacies.length}`,
    pharmacyName: pharmacy.pharmacyName,
  }));
}

const REQUEST_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  approved: "Approved",
  archived: "Archived",
  cancelled: "Cancelled",
  closed: "Closed",
  draft: "Draft",
  finance_hold: "On finance hold",
  pending_approval: "Waiting for approval",
  pending_validation: "Waiting for validation",
  rejected: "Rejected",
  returned: "Sent back",
  roi_tracking: "In ROI tracking",
};
const readableRequestStatus = (status: string) => REQUEST_STATUS_LABEL[status] ?? "Unknown";

/**
 * Filter dimensions. Each one reads its values straight off the loaded rows, so the dropdowns can
 * never offer an option that matches nothing, and a new value appearing in the data needs no code
 * change here.
 *
 * Filtering is client-side on purpose: the page already holds every row the viewer is allowed to
 * see, so this is instant, needs no second query path, and cannot drift from the server's scoping.
 * Within one dimension the selected values are OR-ed; across dimensions they are AND-ed.
 */
type Facet = { key: string; label: string; values: (row: RoiTrackerRow) => string[] };

const FACETS: Facet[] = [
  { key: "region", label: "Region", values: (row) => (row.region ? [row.region] : []) },
  { key: "line", label: "Line", values: (row) => (row.line ? [row.line] : []) },
  { key: "requester", label: "Requester", values: (row) => [row.requesterName ?? "Unknown requester"] },
  { key: "customer", label: "Customer", values: (row) => [row.customerName] },
  { key: "type", label: "Request type", values: (row) => (row.requestTypeName ? [row.requestTypeName] : []) },
  { key: "progress", label: "Progress", values: (row) => [BUCKET_META[bucketOf(row)].label] },
  { key: "result", label: "Result", values: (row) => [ROI_RESULT_STATUS_LABEL[row.resultStatus]] },
  { key: "coverage", label: "Sales data", values: (row) => [ROI_DATA_COVERAGE_LABEL[row.dataCoverage]] },
  { key: "status", label: "Request status", values: (row) => [readableRequestStatus(row.status)] },
  { key: "product", label: "Product", values: (row) => row.products.map((product) => product.productName) },
  { key: "distributor", label: "Distributor", values: (row) => row.distributorCodes },
];

type FacetState = Record<string, string[]>;

function matchesFacets(row: RoiTrackerRow, selected: FacetState): boolean {
  return FACETS.every((facet) => {
    const chosen = selected[facet.key];
    if (!chosen || chosen.length === 0) return true;
    const rowValues = facet.values(row);
    return chosen.some((value) => rowValues.includes(value));
  });
}

/**
 * A plain <details> disclosure rather than a managed popover — native open/close, no outside-click
 * listener, no focus trap, nothing to get out of sync. Eleven of these cost less than one popover
 * abstraction would.
 */
function FacetSelect({
  facet,
  options,
  selected,
  onChange,
}: {
  facet: Facet;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (options.length === 0) return null;

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value]);

  return (
    <details className="relative">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-semibold transition",
          selected.length > 0
            ? "border-slate-900 bg-slate-900 text-white"
            : "border-slate-200 text-slate-700 hover:border-slate-300",
        )}
      >
        {facet.label}
        {selected.length > 0 ? <span className="tabular-nums">({selected.length})</span> : null}
        <ChevronDown className="h-3 w-3" />
      </summary>
      <div className="absolute left-0 z-30 mt-1 flex max-h-72 w-64 flex-col gap-0.5 overflow-auto rounded-sm border border-slate-200 bg-white p-2 shadow-lg">
        {selected.length > 0 ? (
          <button
            className="mb-1 self-start text-phx-xs font-semibold text-slate-500 underline"
            onClick={() => onChange([])}
            type="button"
          >
            Clear {facet.label.toLowerCase()}
          </button>
        ) : null}
        {options.map((option) => (
          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-xs hover:bg-slate-50" key={option}>
            <input checked={selected.includes(option)} onChange={() => toggle(option)} type="checkbox" />
            <span className="min-w-0 flex-1 text-slate-700">{option}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-sm border px-2 py-0.5 text-phx-sm font-black uppercase tracking-wide", className)}>
      {children}
    </span>
  );
}

// ── ZONE 1 ───────────────────────────────────────────────────────────────────
function MoneyWaterfall({
  rows,
  focus,
  onFocus,
}: {
  rows: RoiTrackerRow[];
  focus: string | null;
  onFocus: (next: string | null) => void;
}) {
  const totals = useMemo(() => {
    const acc: Record<Bucket, { cost: number; count: number }> = {
      delivered: { cost: 0, count: 0 },
      measuring: { cost: 0, count: 0 },
      missed: { cost: 0, count: 0 },
      unmeasurable: { cost: 0, count: 0 },
    };
    for (const row of rows) {
      const b = bucketOf(row);
      acc[b].cost += row.estimatedCost;
      acc[b].count += 1;
    }
    return acc;
  }, [rows]);

  const committed = rows.reduce((sum, row) => sum + row.estimatedCost, 0);
  const earned = rows.reduce((sum, row) => sum + row.actualSalesValue, 0);

  return (
    <section className="flex flex-col gap-3 rounded-sm border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-black uppercase tracking-wide text-slate-500">Where the money is</h2>
        <p className="text-sm text-slate-600">
          <span className="font-semibold tabular-nums text-slate-900">{money(committed)}</span> committed ·{" "}
          <span className="font-semibold tabular-nums text-slate-900">{money(earned)}</span> earned back
        </p>
      </div>

      {committed > 0 ? (
        <div className="flex h-7 w-full overflow-hidden rounded-sm bg-slate-100">
          {BUCKET_ORDER.map((b) => {
            const share = totals[b].cost / committed;
            if (share <= 0) return null;
            return (
              <button
                aria-label={`${BUCKET_META[b].label}: ${money(totals[b].cost)}`}
                className={cn(
                  "h-full transition-opacity hover:opacity-80",
                  BUCKET_META[b].bar,
                  focus && focus !== `bucket:${b}` ? "opacity-35" : "",
                )}
                key={b}
                onClick={() => onFocus(focus === `bucket:${b}` ? null : `bucket:${b}`)}
                style={{ width: `${share * 100}%` }}
                title={`${BUCKET_META[b].label} — ${money(totals[b].cost)}`}
                type="button"
              />
            );
          })}
        </div>
      ) : (
        <div className="h-7 w-full rounded-sm bg-slate-100" />
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {BUCKET_ORDER.map((b) => (
          <button
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-sm border p-2 text-left transition",
              focus === `bucket:${b}` ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:border-slate-300",
            )}
            key={b}
            onClick={() => onFocus(focus === `bucket:${b}` ? null : `bucket:${b}`)}
            type="button"
          >
            <span className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-sm", BUCKET_META[b].bar)} />
              <span className="text-phx-sm font-black uppercase tracking-wide text-slate-500">{BUCKET_META[b].label}</span>
            </span>
            <span className="text-sm font-bold tabular-nums text-slate-900">{money(totals[b].cost)}</span>
            <span className="text-phx-xs text-slate-500">
              {countOf(totals[b].count, "request")} · {BUCKET_META[b].help}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ── ZONE 2 ───────────────────────────────────────────────────────────────────
function Maturation({ rows }: { rows: RoiTrackerRow[] }) {
  const months = useMemo(() => {
    const map = new Map<string, { committed: number; earned: number; count: number; required: number }>();
    for (const row of rows) {
      const key = (row.payDate ?? "").slice(0, 7) || "unknown";
      const entry = map.get(key) ?? { committed: 0, count: 0, earned: 0, required: 0 };
      entry.committed += row.estimatedCost;
      entry.earned += row.actualSalesValue;
      // Each request carries its OWN required return; a flat "10x the cost" disagreed with every
      // request whose type sets a different multiple.
      entry.required += row.requiredRoiValue;
      entry.count += 1;
      map.set(key, entry);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  if (months.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 rounded-sm border border-slate-200 bg-white p-4">
      <h2 className="text-xs font-black uppercase tracking-wide text-slate-500">Is it maturing?</h2>
      <p className="text-xs text-slate-500">
        How much of each month&apos;s spend has come back so far, against what those campaigns are required to return.
      </p>
      <ul className="flex flex-col gap-1.5">
        {months.map(([month, m]) => {
          const required = m.required;
          const ratio = required > 0 ? m.earned / required : 0;
          return (
            <li className="flex items-center gap-3" key={month}>
              <span className="w-16 shrink-0 font-mono text-xs tabular-nums text-slate-600">{month}</span>
              <span className="w-20 shrink-0 text-xs tabular-nums text-slate-500">{compact(m.committed)} spent</span>
              <div className="h-2 flex-1 overflow-hidden rounded-sm bg-slate-100">
                <div
                  className={cn("h-full rounded-sm", ratio >= 1 ? "bg-emerald-500" : ratio > 0 ? "bg-orange-400" : "bg-slate-200")}
                  style={{ width: `${Math.min(Math.round(ratio * 100), 100)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-600">{percent(ratio)}</span>
              <span className="w-14 shrink-0 text-right text-phx-xs text-slate-400">{m.count} req</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── ZONE 3 ───────────────────────────────────────────────────────────────────
function ActionStrip({
  rows,
  focus,
  onFocus,
}: {
  rows: RoiTrackerRow[];
  focus: string | null;
  onFocus: (next: string | null) => void;
}) {
  const counts = useMemo(() => {
    const acc: Record<Action, number> = { blocked: 0, judge: 0, upcoming: 0 };
    for (const row of rows) {
      const a = actionOf(row);
      if (a) acc[a] += 1;
    }
    return acc;
  }, [rows]);

  return (
    <section className="flex flex-col gap-2 rounded-sm border border-slate-200 bg-white p-4">
      <h2 className="text-xs font-black uppercase tracking-wide text-slate-500">What needs you</h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {(["judge", "blocked", "upcoming"] as const).map((a) => (
          <button
            className={cn(
              "flex items-center justify-between rounded-sm border p-2 text-left transition",
              focus === `action:${a}` ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:border-slate-300",
            )}
            key={a}
            onClick={() => onFocus(focus === `action:${a}` ? null : `action:${a}`)}
            type="button"
          >
            <span className="flex flex-col">
              <span className="text-xs font-semibold text-slate-800">{ACTION_META[a].label}</span>
              <span className="text-phx-xs text-slate-500">{ACTION_META[a].help}</span>
            </span>
            <Badge className={ACTION_META[a].tone}>{counts[a]}</Badge>
          </button>
        ))}
      </div>
    </section>
  );
}

// ── ZONE 4 detail — the case file ────────────────────────────────────────────
function Counter({ label, value, tone }: { label: string; value: number; tone?: "bad" | "good" }) {
  return (
    <div className="flex flex-col rounded-sm border border-slate-200 bg-white px-2 py-1">
      <span
        className={cn(
          "text-sm font-bold tabular-nums",
          tone === "bad" && value > 0 ? "text-rose-600" : tone === "good" ? "text-emerald-600" : "text-slate-900",
        )}
      >
        {value}
      </span>
      <span className="text-phx-sm uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}

function CaseFile({ row }: { row: RoiTrackerRow }) {
  const [explain, setExplain] = useState<MarketingRoiExplain | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        let response: Response;
        try {
          response = await fetch(`/api/marketing-requests/${row.requestId}/roi-explain`, { cache: "no-store" });
        } catch {
          // Same rule as the report fetch: never surface the browser's raw "Failed to fetch".
          throw new Error("Could not reach Phoenix to explain this number. Close and reopen to retry.");
        }
        const payload = (await response.json().catch(() => ({}))) as MarketingRoiExplain & { message?: string };
        if (!response.ok) throw new Error(payload.message ?? "Could not load the diagnosis.");
        if (!cancelled) {
          setExplain(payload);
          setState("ready");
        }
      } catch (caught) {
        if (!cancelled) {
          setMessage(caught instanceof Error ? caught.message : "Could not load the diagnosis.");
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.requestId]);

  const d = explain?.diagnostic;

  return (
    <div className="flex flex-col gap-4 border-t border-slate-200 bg-slate-50/70 p-4">
      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Why this number</h4>
        {state === "loading" ? <p className="text-sm text-slate-500">Loading…</p> : null}
        {state === "error" ? <p className="text-sm text-rose-600">{message}</p> : null}
        {d ? (
          <>
            <p className="text-sm text-slate-800">{readableReason(d.reason)}</p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Counter label="Pharmacies" value={d.pharmaciesTargeted} />
              <Counter label="Found" tone="good" value={d.pharmaciesFound} />
              <Counter label="Missing" tone="bad" value={d.pharmaciesMissing} />
              <Counter label="Products" value={d.productsTargeted} />
              <Counter label="Matched" tone="good" value={d.productsMatched} />
              <Counter label="Unmatched" tone="bad" value={d.productsUnmatched} />
            </div>
            <div className="grid grid-cols-3 gap-2 sm:max-w-md">
              <Counter label="Months in window" value={d.monthsInWindow} />
              <Counter label="Sales loaded" tone="good" value={d.monthsCovered} />
              <Counter label="Still pending" value={d.monthsPending} />
            </div>
          </>
        ) : null}
      </section>

      {/*
        Near misses — real validated sales that failed on exactly ONE attribution key.
        This is the difference between "no sales found" (a dead end) and "the pharmacy bought
        80 units of something else" (a lead). Explicitly NOT part of ROI: the heading and every
        figure say "would have", so nobody can mistake it for money earned.
      */}
      {explain?.nearMisses && explain.nearMisses.groups.length > 0 ? (
        <section className="flex flex-col gap-2 rounded-sm border border-amber-200 bg-amber-50/50 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-xs font-black uppercase tracking-wide text-amber-800">
              Near misses — sales that just failed to count
            </h4>
            <span className="text-xs text-amber-800">
              {money(explain.nearMisses.totalValueIfMatched)} would have counted
              {explain.nearMisses.truncated ? " (at least — scan capped)" : ""}
            </span>
          </div>
          <p className="text-xs text-slate-600">
            None of this is included in the ROI above. Each line is real validated sales that missed on exactly one
            of the four matching keys — distributor, pharmacy code, product, or month.
          </p>
          <ul className="flex flex-col gap-2">
            {explain.nearMisses.groups.map((group) => (
              <li className="flex flex-col gap-0.5 rounded-sm border border-amber-200 bg-white p-2" key={group.kind}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-800">{ROI_NEAR_MISS_LABEL[group.kind]}</span>
                  <span className="text-xs font-semibold tabular-nums text-slate-700">
                    {money(group.valueIfMatched)} · {units(group.units)} units · {group.rows} line(s)
                  </span>
                </div>
                <span className="text-phx-xs text-slate-500">{ROI_NEAR_MISS_ACTION[group.kind]}</span>
                {group.sample.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {group.sample.map((sample, index) => (
                      <li className="flex flex-wrap gap-x-2 text-phx-xs tabular-nums text-slate-500" key={`${group.kind}-${index}`}>
                        <span className="font-mono">{sample.invoicePeriod}</span>
                        <span>{sample.productName}</span>
                        <span>· {sample.distributorCode}</span>
                        <span>· code {sample.clientCode}</span>
                        <span className="ml-auto">{money(sample.valueIfMatched)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Products ({row.products.length})</h4>
          {row.products.length === 0 ? (
            <p className="text-sm text-slate-500">None recorded.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {row.products.map((p) => {
                const sos = explain?.targetSetup.products.find((x) => x.code === p.productCode);
                return (
                  <li className="rounded-sm border border-slate-200 bg-white p-2" key={`${row.requestId}-${p.productCode}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900">{p.productName}</span>
                      {sos ? (
                        <Badge className={sos.matchedToSos ? REFERENCE_STYLE.matched : REFERENCE_STYLE.not_found}>
                          {sos.matchedToSos ? "In sales data" : "Not in sales data"}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                      <span className="font-mono">{p.productCode}</span>
                      <span className="tabular-nums">Qty {units(p.forecastQty)}</span>
                      <span className="tabular-nums font-semibold">{money(p.expectedValue)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Target pharmacies ({row.pharmacies.length})</h4>
          {row.pharmacies.length === 0 ? (
            <p className="text-sm text-rose-600">None linked — nothing can attribute to this request.</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {row.pharmacies.map((ph) => (
                <li
                  className={cn("rounded-sm border bg-white p-2", ph.referenceSuspect ? "border-rose-200" : "border-slate-200")}
                  key={`${row.requestId}-${ph.customerCode}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">{ph.pharmacyName}</span>
                    <Badge className={REFERENCE_STYLE[ph.referenceStatus] ?? REFERENCE_STYLE.pending}>
                      {REFERENCE_LABEL[ph.referenceStatus] ?? REFERENCE_LABEL.pending}
                    </Badge>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                    <span className="font-mono">{ph.customerCode}</span>
                    {ph.distributorCode ? <span>{ph.distributorCode}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Approval chain ({row.approvals.length})</h4>
          {row.approvals.length === 0 ? (
            <p className="text-sm text-slate-500">No approval steps recorded.</p>
          ) : (
            <ol className="flex flex-col gap-1.5">
              {row.approvals.map((s) => (
                <li className="rounded-sm border border-slate-200 bg-white p-2" key={`${row.requestId}-${s.sequence}-${s.stepName}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">
                      {s.sequence}. {s.stepName}
                    </span>
                    <span className="text-xs font-semibold text-slate-500">{readableStepStatus(s.status)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600">
                    <span>{s.assignedRole}</span>
                    {s.decisionAt ? <span>{cairoDate(s.decisionAt)}</span> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">
          Matched sales {explain ? `(${explain.ledger.length})` : ""}
        </h4>
        {state === "ready" && explain && explain.ledger.length === 0 ? (
          <p className="text-sm text-slate-500">No sales attributed to this request yet.</p>
        ) : null}
        {explain && explain.ledger.length > 0 ? (
          <div className="rounded-sm border border-slate-200 bg-white">
            {/* Fits-the-screen: a fixed table with set column shares that wraps, never a scroll. */}
            <table className="w-full table-fixed border-collapse text-xs">
              <colgroup>
                <col className="w-[17%]" />
                <col className="w-[29%]" />
                <col className="w-[22%]" />
                <col className="w-[12%]" />
                <col className="w-[20%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-phx-sm font-black uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-1.5">Month</th>
                  <th className="px-2 py-1.5">Product</th>
                  <th className="px-2 py-1.5">Pharmacy</th>
                  <th className="px-2 py-1.5 text-right">Qty</th>
                  <th className="px-2 py-1.5 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {explain.ledger.map((l) => (
                  <tr className="border-b border-slate-100" key={l.ledgerKey}>
                    <td className="px-2 py-1.5 tabular-nums">{l.invoicePeriod}</td>
                    <td className="break-words px-2 py-1.5">{l.productName || l.productCode}</td>
                    <td className="break-all px-2 py-1.5 font-mono">{l.clientCode}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{units(l.qty)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{money(l.valueCounted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// ── PAGE ─────────────────────────────────────────────────────────────────────
export function MarketingRoiTracker({
  origin = "phoenix",
}: {
  /** Which module this reports on. Separate pages, separate URLs — see roi-tracker-service.ts. */
  origin?: "phoenix" | "xlsx_import";
}) {
  const [report, setReport] = useState<RoiTrackerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // The ONE piece of cross-zone state. "bucket:<b>" or "action:<a>" or null.
  const [focus, setFocus] = useState<string | null>(null);
  const [facets, setFacets] = useState<FacetState>({});

  const fetchReport = useCallback(async (): Promise<RoiTrackerReport> => {
    const filters: RoiFilterState = emptyRoiFilterState();
    let response: Response;
    try {
      response = await fetch("/api/marketing-requests/roi-tracker", {
        body: JSON.stringify({ filters, origin }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    } catch {
      // fetch() rejects only on a TRANSPORT failure — server unreachable, offline, DNS. Its native
      // message is the raw string "Failed to fetch", which is browser jargon, not an explanation.
      throw new Error("Could not reach Phoenix. Check your connection, then press Refresh.");
    }
    let payload: RoiTrackerReport & { message?: string };
    try {
      payload = (await response.json()) as RoiTrackerReport & { message?: string };
    } catch {
      throw new Error("Phoenix returned an unexpected response. Press Refresh, and report this if it repeats.");
    }
    if (!response.ok) throw new Error(payload.message ?? "Could not load the ROI tracker.");
    return payload;
  }, [origin]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await fetchReport();
        if (!cancelled) setReport(payload);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load the ROI tracker.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchReport]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchReport());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the ROI tracker.");
    } finally {
      setLoading(false);
    }
  }, [fetchReport]);

  // Memoised so the `?? []` fallback does not hand the filter useMemo a brand-new array
  // identity on every render, which would defeat it entirely.
  const allRows = useMemo(() => report?.rows ?? [], [report]);

  // Options are derived from the rows the OTHER active filters already allow, so choices that
  // would return nothing simply stop being offered instead of leading to an empty list.
  const facetOptions = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const facet of FACETS) {
      const others: FacetState = { ...facets, [facet.key]: [] };
      const pool = allRows.filter((row) => matchesFacets(row, others));
      const seen = new Set<string>();
      for (const row of pool) for (const value of facet.values(row)) if (value) seen.add(value);
      // Keep anything already selected visible even if the other filters now exclude it —
      // otherwise a chosen value could vanish from its own dropdown and become unclearable.
      for (const value of facets[facet.key] ?? []) seen.add(value);
      result[facet.key] = [...seen].sort((a, b) => a.localeCompare(b));
    }
    return result;
  }, [allRows, facets]);

  const activeFilterCount = useMemo(
    () => FACETS.reduce((sum, facet) => sum + (facets[facet.key]?.length ?? 0), 0),
    [facets],
  );

  const rows = useMemo(() => {
    let list = allRows;
    if (focus?.startsWith("bucket:")) {
      const b = focus.slice(7) as Bucket;
      list = list.filter((row) => bucketOf(row) === b);
    } else if (focus?.startsWith("action:")) {
      const a = focus.slice(7) as Action;
      list = list.filter((row) => actionOf(row) === a);
    }
    if (activeFilterCount > 0) {
      list = list.filter((row) => matchesFacets(row, facets));
    }
    const term = search.trim().toLowerCase();
    if (term) {
      list = list.filter((row) =>
        [row.requestCode, row.customerName, row.requesterName ?? "", row.requesterHrId, row.line ?? "", row.region ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(term),
      );
    }
    return list;
  }, [allRows, focus, search, facets, activeFilterCount]);

  // Records on the workbook itself which view produced it, so an exported file can still be read
  // months later without someone having to guess whether it was the whole set or a slice.
  const exportSubtitle = useMemo(() => {
    const parts: string[] = [`${rows.length} of ${countOf(allRows.length, "request")}`, "one row per target pharmacy"];
    for (const facet of FACETS) {
      const chosen = facets[facet.key];
      if (chosen && chosen.length > 0) parts.push(`${facet.label}: ${chosen.join(", ")}`);
    }
    if (search.trim()) parts.push(`Search: "${search.trim()}"`);
    parts.push(report?.salesDataAsOf ? `Sales data through ${report.salesDataAsOf}` : "No validated sales data loaded");
    return parts.join(" · ");
  }, [rows, allRows, facets, search, report]);

  const focusLabel = focus?.startsWith("bucket:")
    ? BUCKET_META[focus.slice(7) as Bucket].label
    : focus?.startsWith("action:")
      ? ACTION_META[focus.slice(7) as Action].label
      : null;

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHero
        actions={
          <Button onClick={() => void refresh()} variant="secondary">
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
        description="Where the money is, whether it is maturing, what needs you, and the evidence behind every number."
        eyebrow="Marketing"
        icon={<Target className="h-6 w-6" />}
        title="ROI Tracker"
      />

      <div className="flex flex-wrap gap-2">
        {report?.salesDataAsOf ? <AdminInsightChip tone="slate">Sales data through {report.salesDataAsOf}</AdminInsightChip> : null}
        {report?.includedRestricted ? <AdminInsightChip tone="orange">Includes confidential products</AdminInsightChip> : null}
      </div>

      {/*
        Without this, a page full of zeros is indistinguishable from a portfolio that earned
        nothing. When no validated Source-of-Sales data is loaded at all, say so once, loudly,
        instead of letting every request quietly report a zero it never actually measured.
      */}
      {!loading && report && !report.salesDataAsOf && allRows.length > 0 ? (
        <AdminCallout tone="warning">
          <div>
            <p className="font-semibold">No validated sales data is loaded.</p>
            <p className="mt-1">
              Spend and forecast below are real. Earned value cannot be calculated for any request until validated
              Source-of-Sales data is uploaded — so a blank result here means &ldquo;not measured yet&rdquo;, not
              &ldquo;this campaign returned nothing&rdquo;.
            </p>
          </div>
        </AdminCallout>
      ) : null}

      {error ? (
        <AdminCallout tone="danger">
          <p className="font-semibold">{error}</p>
        </AdminCallout>
      ) : null}

      {loading ? <p className="text-sm text-slate-500">Loading the ROI tracker…</p> : null}

      {!loading && allRows.length === 0 ? (
        <AdminCallout tone="neutral">
          <p className="font-semibold">
            {origin === "phoenix"
              ? "No marketing requests have been submitted in Phoenix yet."
              : "No archived requests to show."}
          </p>
          {origin === "phoenix" ? (
            <p className="mt-1 text-sm">Historical requests imported from Excel live in Archived Marketing Requests.</p>
          ) : null}
        </AdminCallout>
      ) : null}

      {allRows.length > 0 ? (
        <>
          <MoneyWaterfall focus={focus} onFocus={setFocus} rows={allRows} />
          <Maturation rows={allRows} />
          <ActionStrip focus={focus} onFocus={setFocus} rows={allRows} />

          <AdminTableShell
            action={
              <div className="flex flex-wrap items-center gap-2">
                {focusLabel ? (
                  <button
                    className="inline-flex items-center gap-1 rounded-sm border border-slate-900 bg-slate-900 px-2 py-1 text-xs font-semibold text-white"
                    onClick={() => setFocus(null)}
                    type="button"
                  >
                    {focusLabel} · clear
                  </button>
                ) : null}
                <label className="relative flex items-center">
                  <Search aria-hidden="true" className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-slate-400" />
                  <input
                    aria-label="Search requests"
                    className={cn(phxFieldClassName, "pl-7 lg:w-56")}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Request, customer, requester…"
                    type="search"
                    value={search}
                  />
                </label>
                {/*
                  Exports `rows`, not `allRows` — whatever the filters and search currently leave
                  on screen is exactly what lands in the workbook. Nothing is re-fetched, so the
                  export can never contain a request the viewer is not already allowed to see.
                */}
                <ExportXlsxButton
                  columns={EXPORT_COLUMNS}
                  label="Export XLSX"
                  rows={rows.flatMap(toExportRows)}
                  sheetName="ROI Tracker"
                  subtitle={exportSubtitle}
                  title={origin === "xlsx_import" ? "Archived Marketing Requests — ROI" : "Marketing ROI Tracker"}
                />
              </div>
            }
            description="Select a request to see why its number is what it is, and the sales that prove it."
            title={`Requests (${rows.length}${rows.length !== allRows.length ? ` of ${allRows.length}` : ""})`}
          >
            <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-slate-50/50 px-3 py-2">
              <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />
              {FACETS.map((facet) => (
                <FacetSelect
                  facet={facet}
                  key={facet.key}
                  onChange={(next) => setFacets((current) => ({ ...current, [facet.key]: next }))}
                  options={facetOptions[facet.key] ?? []}
                  selected={facets[facet.key] ?? []}
                />
              ))}
              {activeFilterCount > 0 ? (
                <button
                  className="ml-auto text-xs font-semibold text-slate-600 underline"
                  onClick={() => setFacets({})}
                  type="button"
                >
                  Clear {activeFilterCount} filter(s)
                </button>
              ) : null}
            </div>

            {rows.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">Nothing matches this view.</p>
            ) : (
              // Each request is its OWN bordered block, not a row in a shared table. With a
              // 4-line identity, a units line and a money line per request, table columns forced
              // everything into one cramped strip and adjacent requests visually bled together.
              <div className="flex flex-col gap-3 p-3">
                {rows.map((row) => {
                  const open = expanded === row.requestId;
                  const b = bucketOf(row);
                  // Units are shown for a single-product request only — units of different
                  // products are never added. A multi-product request is measured by value.
                  const unitFigures = singleProductUnits(row);
                  const forecastUnits = unitFigures?.forecastUnits ?? 0;
                  const unitRatio = unitFigures && forecastUnits > 0 ? unitFigures.actualUnits / forecastUnits : 0;
                  // A hard "0 sold" is only the truth once validated sales actually cover the
                  // window. With no validated data the same 0 means "not measured yet", and
                  // printing it as a number reads as failure — the misleading zero this module
                  // already had to fix once on the CEO dashboard. Show an em-dash instead.
                  const measured = row.dataCoverage !== "no_validated_data";
                  return (
                    <article
                      className={cn(
                        "overflow-hidden rounded-sm border bg-white",
                        open ? "border-slate-900" : "border-slate-200",
                      )}
                      key={row.requestId}
                    >
                      {/* identity */}
                      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-3 py-2">
                        <span className="font-semibold text-slate-900">{row.requestCode}</span>
                        <Badge className={BUCKET_META[b].chip}>{BUCKET_META[b].label}</Badge>
                        <Badge className={VERDICT_STYLE[row.resultStatus]}>{ROI_RESULT_STATUS_LABEL[row.resultStatus]}</Badge>
                        {row.suspectPharmacyCount > 0 ? (
                          <Badge className={REFERENCE_STYLE.not_found}>
                            {row.suspectPharmacyCount} unverified pharmacy code(s)
                          </Badge>
                        ) : null}
                        <button
                          aria-expanded={open}
                          className="ml-auto inline-flex items-center gap-1 rounded-sm border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-300"
                          onClick={() => setExpanded(open ? null : row.requestId)}
                          type="button"
                        >
                          {open ? "Hide detail" : "Explain this number"}
                          <ChevronDown className={cn("h-3 w-3 transition", open && "rotate-180")} />
                        </button>
                      </div>

                      <div className="grid gap-4 px-3 py-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                        {/* who / where / when */}
                        <div className="flex flex-col gap-1">
                          <span className="text-sm font-medium text-slate-800">{row.customerName}</span>
                          {/*
                            Region is a labelled field of its own and is ALWAYS rendered, even when
                            null — owner request, so the slot is already there the day a request
                            starts carrying one. It resolves from the requester's employee record
                            (roi-report-service: requesterRow.regionName), not from the request
                            form, so it fills in as soon as the requester has a region on file.
                          */}
                          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
                            <dt className="text-slate-400">Region</dt>
                            <dd className={row.region ? "text-slate-700" : "text-slate-400 italic"}>
                              {row.region ?? "Not recorded yet"}
                            </dd>
                            <dt className="text-slate-400">Line</dt>
                            <dd className="text-slate-700">{row.line ?? "—"}</dd>
                            <dt className="text-slate-400">Requester</dt>
                            <dd className="text-slate-700">{row.requesterName ?? "Unknown requester"}</dd>
                            <dt className="text-slate-400">Paid</dt>
                            <dd className="tabular-nums text-slate-700">{row.payDate ?? "—"}</dd>
                            <dt className="text-slate-400">Window</dt>
                            <dd className="tabular-nums text-slate-700">{row.roiWindow ?? "—"}</dd>
                          </dl>
                          <span className="text-xs text-slate-400">{ROI_DATA_COVERAGE_LABEL[row.dataCoverage]}</span>
                        </div>

                        {/* UNITS — how many we forecast vs how many actually sold */}
                        <div className="flex flex-col gap-1 rounded-sm border border-slate-100 bg-slate-50/50 p-2">
                          <span className="text-phx-sm font-black uppercase tracking-wide text-slate-500">Units</span>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-lg font-bold tabular-nums text-slate-900">
                              {measured && unitFigures ? units(unitFigures.actualUnits) : "—"}
                            </span>
                            <span className="text-xs text-slate-500">
                              {unitFigures ? `sold of ${units(forecastUnits)} forecast` : `${row.products.length} products`}
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-sm bg-slate-200">
                            {measured && unitFigures ? (
                              <div
                                className={cn("h-full rounded-sm", unitRatio >= 1 ? "bg-emerald-500" : "bg-orange-400")}
                                style={{ width: `${Math.min(Math.round(unitRatio * 100), 100)}%` }}
                              />
                            ) : null}
                          </div>
                          <span className="text-phx-xs tabular-nums text-slate-500">
                            {!unitFigures
                              ? "Several products — measured by value"
                              : !measured
                              ? "No validated sales cover this window yet"
                              : forecastUnits > 0
                                ? `${percent(unitRatio)} of forecast units`
                                : "No forecast quantity recorded"}
                          </span>
                        </div>

                        {/* VALUE — the money those units are worth */}
                        <div className="flex flex-col gap-1 rounded-sm border border-slate-100 bg-slate-50/50 p-2">
                          <span className="text-phx-sm font-black uppercase tracking-wide text-slate-500">Value</span>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-lg font-bold tabular-nums text-slate-900">
                              {measured ? money(row.actualSalesValue) : "—"}
                            </span>
                            <span className="text-xs text-slate-500">of {money(row.requiredRoiValue)} required</span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-sm bg-slate-200">
                            {measured ? (
                              <div
                                className={cn(
                                  "h-full rounded-sm",
                                  row.actualCoverageRatio >= 1 ? "bg-emerald-500" : "bg-orange-400",
                                )}
                                style={{ width: `${Math.min(Math.round(row.actualCoverageRatio * 100), 100)}%` }}
                              />
                            ) : null}
                          </div>
                          <span className="text-phx-xs tabular-nums text-slate-500">
                            {measured ? `${percent(row.actualCoverageRatio)} covered · ` : ""}spent {money(row.estimatedCost)}
                          </span>
                        </div>
                      </div>

                      {open ? <CaseFile row={row} /> : null}
                    </article>
                  );
                })}
              </div>
            )}
          </AdminTableShell>
        </>
      ) : null}
    </div>
  );
}
