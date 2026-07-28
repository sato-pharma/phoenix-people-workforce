"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ROI Tracker — the full evidence chain for every marketing request.
//
// ROI tracking answers seven questions in order, and a tracker is only complete if it answers
// all of them:
//
//   1. What did we SPEND?        estimated cost
//   2. What did we PROMISE?      expected / forecast ROI  (+ forecast coverage)
//   3. What was REQUIRED?        cost x 10
//   4. What did we ACTUALLY get? attributed sales value + units
//   5. Is it WORKING?            verdict + actual coverage
//   6. If not, WHY?              diagnosis — window still open? pharmacy codes missing?
//                                products not matched to Source-of-Sales? genuinely no sales?
//   7. What PROVES it?           the matched sales ledger, line by line
//
// Level 1 (this table) answers 1-5 for the whole portfolio, scannable and filterable.
// Level 2 (expand a row) answers 6-7 by lazy-loading the existing, already-gated
// /api/marketing-requests/[id]/roi-explain — no new attribution path, no N+1 on page load.
//
// Every number originates in getMarketingRoiReport (the authoritative v2 engine), so this page
// cannot disagree with ROI Tracking. Labels come from roi-labels.ts for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  BadgeCheck,
  ChevronDown,
  Coins,
  Gauge,
  PackageSearch,
  RefreshCcw,
  Search,
  ShieldAlert,
  Target,
} from "lucide-react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { ROI_DATA_COVERAGE_LABEL, ROI_RESULT_STATUS_LABEL } from "@/lib/marketing-requests/roi-labels";
import type { MarketingRoiExplain } from "@/lib/marketing-requests/roi-explain";
import type { MarketingRoiResultStatus, RoiFilterState } from "@/lib/marketing-requests/roi-report-types";
import { emptyRoiFilterState } from "@/lib/marketing-requests/roi-report-types";
import type { RoiTrackerReport, RoiTrackerRow } from "@/lib/marketing-requests/roi-tracker-service";
import { cn } from "@/lib/utils";

const money = (value: number) => `EGP ${Math.round(value).toLocaleString("en-US")}`;
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const units = (value: number) => Math.round(value).toLocaleString("en-US");

/** awaiting_data is informational (sky), never alarming: an open window has not failed. */
const VERDICT_STYLE: Record<MarketingRoiResultStatus, string> = {
  awaiting_data: "border-sky-200 bg-sky-50 text-sky-700",
  behind: "border-amber-200 bg-amber-50 text-amber-700",
  no_data: "border-slate-200 bg-slate-50 text-slate-600",
  on_track: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

const REQUEST_STATUS_STYLE: Record<string, string> = {
  approved: "border-emerald-200 bg-emerald-50 text-emerald-700",
  archived: "border-slate-200 bg-slate-100 text-slate-500",
  rejected: "border-rose-200 bg-rose-50 text-rose-700",
  returned: "border-amber-200 bg-amber-50 text-amber-700",
};

const REFERENCE_STYLE: Record<string, string> = {
  ambiguous: "border-amber-200 bg-amber-50 text-amber-700",
  matched: "border-emerald-200 bg-emerald-50 text-emerald-700",
  not_found: "border-rose-200 bg-rose-50 text-rose-700",
  pending: "border-slate-200 bg-slate-50 text-slate-600",
};
const REFERENCE_LABEL: Record<string, string> = {
  ambiguous: "Ambiguous code",
  matched: "Verified",
  not_found: "Unknown code",
  pending: "Unvalidated",
};

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-sm border px-2 py-0.5 text-[10px] font-black uppercase tracking-wide", className)}>
      {children}
    </span>
  );
}

/** Spent → promised → required → actual, the chain a reader compares. */
function MoneyChain({ row }: { row: RoiTrackerRow }) {
  const covered = row.actualCoverageRatio >= 1;
  return (
    <div className="flex flex-col gap-1.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-slate-500">Spent</dt>
        <dd className="tabular-nums text-slate-700">{money(row.estimatedCost)}</dd>
        <dt className="text-slate-500">Forecast</dt>
        <dd className="tabular-nums text-slate-700">
          {money(row.expectedRoiValue)} <span className="text-slate-400">({percent(row.forecastCoverageRatio)})</span>
        </dd>
        <dt className="text-slate-500">Required</dt>
        <dd className="tabular-nums text-slate-700">{money(row.requiredRoiValue)}</dd>
        <dt className="font-semibold text-slate-700">Actual</dt>
        <dd className="tabular-nums font-semibold text-slate-900">
          {money(row.actualSalesValue)}
          {row.actualSalesUnits > 0 ? <span className="ml-1 font-normal text-slate-500">· {units(row.actualSalesUnits)} u</span> : null}
        </dd>
      </dl>
      <div className="h-1.5 w-full max-w-[11rem] overflow-hidden rounded-sm bg-slate-100">
        <div
          className={cn("h-full rounded-sm", covered ? "bg-emerald-500" : "bg-orange-400")}
          style={{ width: `${Math.min(Math.round(row.actualCoverageRatio * 100), 100)}%` }}
        />
      </div>
      <span className="text-xs font-semibold tabular-nums text-slate-600">
        {percent(row.actualCoverageRatio)} of required
        {row.coverageGap > 0 ? <span className="ml-1 font-normal text-slate-500">· {money(row.coverageGap)} short</span> : null}
      </span>
    </div>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone?: "bad" | "good" }) {
  return (
    <div className="flex flex-col rounded-sm border border-slate-200 bg-white px-2 py-1">
      <span className={cn("text-sm font-bold tabular-nums", tone === "bad" && value > 0 ? "text-rose-600" : tone === "good" ? "text-emerald-600" : "text-slate-900")}>
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
    </div>
  );
}

/** Level 2 — why, and the proof. Lazy-loaded per request. */
function RequestDossier({ row }: { row: RoiTrackerRow }) {
  const [explain, setExplain] = useState<MarketingRoiExplain | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/marketing-requests/${row.requestId}/roi-explain`, { cache: "no-store" });
        const payload = (await response.json()) as MarketingRoiExplain & { message?: string };
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
    <div className="flex flex-col gap-5 border-t border-slate-200 bg-slate-50/70 p-4">
      {/* 6. WHY */}
      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Why this number</h4>
        {state === "loading" ? <p className="text-sm text-slate-500">Loading the diagnosis…</p> : null}
        {state === "error" ? <p className="text-sm text-rose-600">{message}</p> : null}
        {d ? (
          <>
            <p className="text-sm font-semibold text-slate-800">{d.reason.replace(/_/g, " ")}</p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Counter label="Pharmacies" value={d.pharmaciesTargeted} />
              <Counter label="Found in SoS" tone="good" value={d.pharmaciesFound} />
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

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Target setup — products */}
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Products ({row.products.length})</h4>
          {row.products.length === 0 ? (
            <p className="text-sm text-slate-500">No product lines recorded.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {row.products.map((product) => {
                const sos = explain?.targetSetup.products.find((p) => p.code === product.productCode);
                return (
                  <li className="rounded-sm border border-slate-200 bg-white p-2" key={`${row.requestId}-${product.productCode}`}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900">{product.productName}</span>
                      {sos ? (
                        <Badge className={sos.matchedToSos ? REFERENCE_STYLE.matched : REFERENCE_STYLE.not_found}>
                          {sos.matchedToSos ? "In sales data" : "Not in sales data"}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                      <span className="font-mono">{product.productCode}</span>
                      <span className="tabular-nums">Qty {units(product.forecastQty)}</span>
                      <span className="tabular-nums">@ {money(product.factoryPrice)}</span>
                      <span className="tabular-nums font-semibold">= {money(product.expectedValue)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Target setup — pharmacies */}
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Target pharmacies ({row.pharmacies.length})</h4>
          {row.pharmacies.length === 0 ? (
            <p className="text-sm text-slate-500">No target pharmacies linked — nothing can attribute to this request.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {row.pharmacies.map((pharmacy) => {
                const sos = explain?.targetSetup.pharmacies.find((p) => p.code === pharmacy.customerCode);
                return (
                  <li
                    className={cn("rounded-sm border bg-white p-2", pharmacy.referenceSuspect ? "border-rose-200" : "border-slate-200")}
                    key={`${row.requestId}-${pharmacy.customerCode}`}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-900">{pharmacy.pharmacyName}</span>
                      <Badge className={REFERENCE_STYLE[pharmacy.referenceStatus] ?? REFERENCE_STYLE.pending}>
                        {REFERENCE_LABEL[pharmacy.referenceStatus] ?? pharmacy.referenceStatus}
                      </Badge>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                      <span className="font-mono">{pharmacy.customerCode}</span>
                      {pharmacy.distributorCode ? <span>{pharmacy.distributorCode}</span> : null}
                      {sos ? (
                        <span className={sos.foundInSos ? "text-emerald-600" : "text-rose-600"}>
                          {sos.foundInSos ? "has sales in window" : "no sales in window"}
                        </span>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Approval chain */}
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Approval chain ({row.approvals.length})</h4>
          {row.approvals.length === 0 ? (
            <p className="text-sm text-slate-500">No approval steps recorded — this request has no actionable step.</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {row.approvals.map((step) => (
                <li className="rounded-sm border border-slate-200 bg-white p-2" key={`${row.requestId}-${step.sequence}-${step.stepName}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-slate-900">{step.sequence}. {step.stepName}</span>
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{step.status}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
                    <span>{step.assignedRole}</span>
                    {step.assignedHrId ? <span className="font-mono">{step.assignedHrId}</span> : null}
                    {step.decisionAt ? <span>{step.decisionAt.slice(0, 10)}</span> : null}
                    {step.isCc ? <span className="text-slate-400">CC</span> : null}
                  </div>
                  {step.decisionNote ? <p className="mt-1 text-xs text-slate-600">{step.decisionNote}</p> : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {/* 7. PROOF — the matched sales ledger */}
      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">
          Matched sales {explain ? `(${explain.ledger.length})` : ""}
        </h4>
        {state === "ready" && explain && explain.ledger.length === 0 ? (
          <p className="text-sm text-slate-500">No sales attributed to this request yet.</p>
        ) : null}
        {explain && explain.ledger.length > 0 ? (
          <div className="overflow-x-auto rounded-sm border border-slate-200 bg-white">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-[10px] font-black uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-1.5">Month</th>
                  <th className="px-2 py-1.5">Product</th>
                  <th className="px-2 py-1.5">Pharmacy</th>
                  <th className="px-2 py-1.5">Distributor</th>
                  <th className="px-2 py-1.5 text-right">Qty</th>
                  <th className="px-2 py-1.5 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {explain.ledger.map((line) => (
                  <tr className="border-b border-slate-100" key={line.ledgerKey}>
                    <td className="px-2 py-1.5 tabular-nums">{line.invoicePeriod}</td>
                    <td className="px-2 py-1.5">{line.productName || line.productCode}</td>
                    <td className="px-2 py-1.5 font-mono">{line.clientCode}</td>
                    <td className="px-2 py-1.5">{line.distributorCode}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{units(line.qty)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{money(line.valueCounted)}</td>
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

export function MarketingRoiTracker({
  basePath = "/admin",
  origin = "phoenix",
}: {
  basePath?: string;
  /** Which module this tracker reports on. The two are separate on purpose — see
   *  roi-tracker-service.ts. "phoenix" is the live, validated-at-entry set; "xlsx_import" is the
   *  frozen historical Excel import. */
  origin?: "phoenix" | "xlsx_import";
}) {
  const [report, setReport] = useState<RoiTrackerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [verdictFilter, setVerdictFilter] = useState<MarketingRoiResultStatus | "all">("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const fetchReport = useCallback(async (): Promise<RoiTrackerReport> => {
    const filters: RoiFilterState = emptyRoiFilterState();
    const response = await fetch("/api/marketing-requests/roi-tracker", {
      body: JSON.stringify({ filters, origin }),
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = (await response.json()) as RoiTrackerReport & { message?: string };
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

  const statuses = useMemo(
    () => Array.from(new Set((report?.rows ?? []).map((row) => row.status))).sort(),
    [report],
  );

  const rows = useMemo(() => {
    let list = report?.rows ?? [];
    if (verdictFilter !== "all") list = list.filter((row) => row.resultStatus === verdictFilter);
    if (statusFilter !== "all") list = list.filter((row) => row.status === statusFilter);
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
  }, [report, verdictFilter, statusFilter, search]);

  const kpi = report?.kpi;

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHero
        actions={
          <Button onClick={() => void refresh()} variant="secondary">
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
        description="Spent, promised, required, actually earned — and for every request, why the number is what it is and the sales that prove it."
        eyebrow="Marketing"
        icon={<Target className="h-6 w-6" />}
        title="ROI Tracker"
      />

      <div className="flex flex-wrap gap-2">
        {report?.salesDataAsOf ? <AdminInsightChip tone="slate">Sales data through {report.salesDataAsOf}</AdminInsightChip> : null}
        {report?.includedRestricted ? <AdminInsightChip tone="orange">Includes confidential products</AdminInsightChip> : null}
        {report && report.requestsWithSuspectCodes > 0 ? (
          <AdminInsightChip tone="orange">{report.requestsWithSuspectCodes} request(s) with unverified pharmacy codes</AdminInsightChip>
        ) : null}
      </div>

      {error ? (
        <AdminCallout tone="danger">
          <p className="font-semibold">{error}</p>
        </AdminCallout>
      ) : null}

      {kpi ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <AdminStatCard description="Marketing spend across the requests you can see." icon={<Coins className="h-5 w-5" />} label="Total spent" tone="orange" value={money(kpi.totalEstimatedCost)} />
          <AdminStatCard description="Attributed sales at the targeted pharmacies, inside each ROI window." icon={<BadgeCheck className="h-5 w-5" />} label="Actually earned" tone="emerald" value={money(kpi.totalActualValue)} />
          <AdminStatCard description="Actual sales against the required return." icon={<Gauge className="h-5 w-5" />} label="Coverage" tone="blue" value={percent(kpi.coverageRatio)} />
          <AdminStatCard description="Still measuring — window open, not yet judgeable." icon={<PackageSearch className="h-5 w-5" />} label="Data pending" tone="violet" value={String(kpi.awaitingDataCount)} />
        </div>
      ) : null}

      <AdminTableShell
        action={
          <div className="flex flex-col gap-2 lg:items-end">
            <label className="relative flex items-center">
              <Search aria-hidden="true" className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-slate-400" />
              <input
                aria-label="Search requests"
                className="w-full rounded-sm border border-slate-200 py-1 pl-7 pr-2 text-xs lg:w-64"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Request, customer, requester, line…"
                type="search"
                value={search}
              />
            </label>
            <div className="flex flex-wrap gap-1">
              {(["all", "on_track", "behind", "awaiting_data", "no_data"] as const).map((key) => (
                <button
                  className={cn(
                    "rounded-sm border px-2 py-1 text-xs font-semibold transition",
                    verdictFilter === key ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                  )}
                  key={key}
                  onClick={() => setVerdictFilter(key)}
                  type="button"
                >
                  {key === "all" ? "All verdicts" : ROI_RESULT_STATUS_LABEL[key]}
                </button>
              ))}
            </div>
            {statuses.length > 1 ? (
              <div className="flex flex-wrap gap-1">
                {["all", ...statuses].map((key) => (
                  <button
                    className={cn(
                      "rounded-sm border px-2 py-1 text-xs font-semibold capitalize transition",
                      statusFilter === key ? "border-orange-500 bg-orange-50 text-orange-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                    )}
                    key={key}
                    onClick={() => setStatusFilter(key)}
                    type="button"
                  >
                    {key === "all" ? "All statuses" : key.replace(/_/g, " ")}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        }
        description="Select a request to see why its number is what it is, and the sales that prove it."
        title={`Requests (${rows.length}${report && rows.length !== report.rows.length ? ` of ${report.rows.length}` : ""})`}
      >
        {loading ? (
          <p className="p-6 text-sm text-slate-500">Loading the ROI tracker…</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-slate-500">
            {report && report.rows.length === 0 && origin === "phoenix"
              ? "No marketing requests have been submitted in Phoenix yet. Historical requests imported from Excel live in Archived Marketing Requests."
              : "No requests match this view."}
          </p>
        ) : (
          <>
            <div className="hidden lg:block">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-left text-[11px] font-black uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3">Request</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Pay date &amp; ROI window</th>
                    <th className="px-4 py-3">Spent → earned</th>
                    <th className="px-4 py-3">Verdict &amp; data</th>
                    <th className="px-4 py-3">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const open = expanded === row.requestId;
                    return (
                      <Fragment key={row.requestId}>
                        <tr className="border-b border-slate-100 align-top">
                          <td className="px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-900">{row.requestCode}</span>
                              <Badge className={REQUEST_STATUS_STYLE[row.status] ?? "border-slate-200 bg-slate-50 text-slate-600"}>
                                {row.status.replace(/_/g, " ")}
                              </Badge>
                            </div>
                            <div className="text-xs text-slate-500">{row.requesterName ?? row.requesterHrId}</div>
                            <div className="text-xs text-slate-400">{[row.line, row.region].filter(Boolean).join(" · ")}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="text-slate-900">{row.customerName}</div>
                            <div className="text-xs text-slate-500">{row.requestTypeName ?? "—"}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="tabular-nums text-slate-900">{row.payDate ?? "—"}</div>
                            <div className="text-xs text-slate-500">{row.roiWindow ?? "—"}</div>
                            <div className="text-xs text-slate-400">{row.roiDurationMonths} month(s)</div>
                          </td>
                          <td className="px-4 py-3"><MoneyChain row={row} /></td>
                          <td className="px-4 py-3">
                            <div className="flex flex-col items-start gap-1">
                              <Badge className={VERDICT_STYLE[row.resultStatus]}>{ROI_RESULT_STATUS_LABEL[row.resultStatus]}</Badge>
                              <span className="text-xs text-slate-500">{ROI_DATA_COVERAGE_LABEL[row.dataCoverage]}</span>
                              <span className="text-xs text-slate-500">{row.attributionQuality.replace(/_/g, " ")}</span>
                              {row.suspectPharmacyCount > 0 ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600">
                                  <ShieldAlert className="h-3 w-3" />
                                  {row.suspectPharmacyCount} unverified code(s)
                                </span>
                              ) : null}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <button
                              aria-expanded={open}
                              className="inline-flex items-center gap-1 rounded-sm border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-300"
                              onClick={() => setExpanded(open ? null : row.requestId)}
                              type="button"
                            >
                              {open ? "Hide" : "Explain"}
                              <ChevronDown className={cn("h-3 w-3 transition", open && "rotate-180")} />
                            </button>
                          </td>
                        </tr>
                        {open ? (
                          <tr>
                            <td className="p-0" colSpan={6}><RequestDossier row={row} /></td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-3 p-3 lg:hidden">
              {rows.map((row) => {
                const open = expanded === row.requestId;
                return (
                  <article className="rounded-sm border border-slate-200 bg-white" key={row.requestId}>
                    <div className="flex flex-col gap-2 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">{row.requestCode}</span>
                        <Badge className={VERDICT_STYLE[row.resultStatus]}>{ROI_RESULT_STATUS_LABEL[row.resultStatus]}</Badge>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge className={REQUEST_STATUS_STYLE[row.status] ?? "border-slate-200 bg-slate-50 text-slate-600"}>{row.status.replace(/_/g, " ")}</Badge>
                        <span className="text-xs text-slate-500">{ROI_DATA_COVERAGE_LABEL[row.dataCoverage]}</span>
                      </div>
                      <div className="text-sm text-slate-700">{row.customerName}</div>
                      <div className="text-xs text-slate-500">{row.requesterName ?? row.requesterHrId}{row.line ? ` · ${row.line}` : ""}</div>
                      <div className="text-xs text-slate-500">Pay {row.payDate ?? "—"} · window {row.roiWindow ?? "—"}</div>
                      <MoneyChain row={row} />
                      {row.suspectPharmacyCount > 0 ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600">
                          <ShieldAlert className="h-3 w-3" />
                          {row.suspectPharmacyCount} unverified pharmacy code(s)
                        </span>
                      ) : null}
                      <button
                        aria-expanded={open}
                        className="mt-1 inline-flex items-center justify-center gap-1 rounded-sm border border-slate-200 px-2 py-1.5 text-xs font-semibold text-slate-700"
                        onClick={() => setExpanded(open ? null : row.requestId)}
                        type="button"
                      >
                        {open ? "Hide detail" : "Explain this number"}
                        <ChevronDown className={cn("h-3 w-3 transition", open && "rotate-180")} />
                      </button>
                    </div>
                    {open ? <RequestDossier row={row} /> : null}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </AdminTableShell>

      <p className="text-xs text-slate-500">
        Every figure comes from the same attribution engine as ROI Tracking
        {basePath === "/admin" ? " (/admin/marketing-requests/roi-tracking)" : ""}, so the two can never disagree. A
        request reads “{ROI_RESULT_STATUS_LABEL.awaiting_data}” while its ROI window extends past the latest validated
        sales month — it has not failed, it has not finished.
      </p>
    </div>
  );
}
