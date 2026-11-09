"use client";

import * as React from "react";
import { AlertTriangle, ChevronDown, ChevronUp, CircleSlash, TrendingUp } from "lucide-react";

import type { MarketingSalesEvidence } from "@/lib/marketing-requests/sales-evidence";
import { adminPanelClassName, adminSoftPanelClassName } from "@/components/admin/admin-design-tokens";

function egp(value: number) {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

/** Compact month label: "2026-01" -> "Jan 2026". Never abbreviated with an ellipsis. */
function monthLabel(period: string) {
  const [year, month] = period.split("-");
  const index = Number(month) - 1;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return names[index] ? `${names[index]} ${year}` : period;
}

function BreakdownTable({
  emptyLabel,
  rows,
  title,
}: {
  emptyLabel: string;
  rows: Array<{ label: string; qty: number; value: number }>;
  title: string;
}) {
  const max = Math.max(0, ...rows.map((row) => row.value));
  return (
    <div className={`${adminPanelClassName} rounded-[6px]`}>
      <p className="border-b border-phx-line px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="px-3 py-4 text-phx-sm font-semibold text-phx-ink-faint">{emptyLabel}</p>
      ) : (
        <ul className="divide-y divide-phx-paper-2">
          {rows.map((row) => (
            <li className="px-3 py-2" key={row.label}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-phx-sm font-bold text-phx-ink">{row.label}</span>
                <span className="shrink-0 text-phx-sm font-black text-phx-ink">{egp(row.value)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-md bg-phx-paper-2">
                <div
                  className="h-full rounded-md bg-phx-accent-line"
                  style={{ width: max > 0 ? `${Math.max(3, (row.value / max) * 100)}%` : "0%" }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Sales evidence for the SFE Validation step.
 *
 * Leads with a VERDICT, not a table. The step's job is to answer "is this customer worth spending
 * on?", and an approver should not have to read rows and do arithmetic to get there — so the
 * projected return over the request's own ROI window sits directly beside what the request asks
 * for, and the shortfall is stated in money.
 *
 * A customer with no history says so in words. Rendering an empty table would read as "the system
 * is broken" rather than "this customer is unproven", and unproven is the actual finding.
 */
export function MarketingSalesEvidencePanel({ requestId }: { requestId: string }) {
  const [data, setData] = React.useState<MarketingSalesEvidence | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/marketing-requests/${requestId}/sales-evidence`, { cache: "no-store" });
        const payload = await response.json();
        if (cancelled) return;
        if (!response.ok) {
          setError(payload.message ?? "Unable to load sales evidence.");
          return;
        }
        setData(payload as MarketingSalesEvidence);
      } catch {
        if (!cancelled) setError("Unable to load sales evidence.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (loading) {
    return (
      <div className={`${adminSoftPanelClassName} rounded-[8px] px-4 py-3 text-phx-sm font-bold text-phx-ink-soft`}>
        Loading sales evidence...
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="rounded-[8px] border border-[#FED7AA] bg-phx-accent-soft px-4 py-3 text-phx-sm font-bold text-[#9A3412]">
        {error ?? "Sales evidence is unavailable."}
      </div>
    );
  }

  const { ask, verdict } = data;
  const shortfall = verdict.projectedShortfall > 0;
  const underTarget = ask.roiStatus === "under_target";

  return (
    <section className="space-y-3 rounded-[10px] border border-phx-line bg-phx-paper p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-phx-sm font-black uppercase tracking-[0.14em] text-phx-ink-soft">Sales evidence</p>
          <p className="mt-1 text-phx-lg font-black text-phx-ink">{data.customerName}</p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-phx-xs font-black ${
            verdict.hasHistory ? "bg-[#DCFCE7] text-[#166534]" : "bg-[#FEF3C7] text-[#92400E]"
          }`}
        >
          {verdict.hasHistory ? <TrendingUp className="h-3.5 w-3.5" /> : <CircleSlash className="h-3.5 w-3.5" />}
          {verdict.hasHistory ? "Has historical sales" : "No historical sales"}
        </span>
      </div>

      {/* The verdict, in one sentence. */}
      <p className="text-phx-md font-bold leading-6 text-phx-ink-2">
        {verdict.hasHistory ? (
          <>
            This customer sold <strong className="text-phx-ink">{egp(verdict.totalValue)}</strong> across{" "}
            <strong className="text-phx-ink">{verdict.activeMonths}</strong>{" "}
            {verdict.activeMonths === 1 ? "month" : "months"}, {verdict.productCount}{" "}
            {verdict.productCount === 1 ? "product" : "products"} and {verdict.distributorCount}{" "}
            {verdict.distributorCount === 1 ? "distributor" : "distributors"} — about{" "}
            <strong className="text-phx-ink">{egp(verdict.monthlyRunRate)}</strong> per active month.
          </>
        ) : data.matchedPharmacyCodes.length === 0 ? (
          <>
            This customer has no validated distributor pharmacy code, so no sales can be matched to it.
            Nothing here is missing — there is simply nothing to match against yet.
          </>
        ) : (
          <>
            No sales matched this customer&apos;s{" "}
            {data.matchedPharmacyCodes.length === 1 ? "pharmacy code" : "pharmacy codes"} (
            {data.matchedPharmacyCodes.join(", ")}). That may mean the customer has never bought, or
            that the code it trades under is not the one registered here — this panel cannot tell
            the two apart, so treat it as unproven rather than disproven.
          </>
        )}
      </p>

      {/* Silently-filtered data must announce the filter. Without this line a shrunken total reads
          as "this customer barely buys" when the opposite may be true. Deliberately carries no
          quantity, count, product name or value — saying how many or how much would defeat the
          lock this line exists to respect. */}
      {data.confidentialProductsWithheld ? (
        <p className="text-phx-sm font-semibold leading-5 text-phx-ink-soft">
          Confidential products are excluded from these figures.
        </p>
      ) : null}

      {/* ── The requested products, judged on their own ──────────────────────────────────────
          The whole-customer total flatters a request. On the live request the customer had traded
          EGP 2,774 over six months, but only ONE of five promoted products had ever sold there —
          once, for EGP 79. It buys Tebofortine 40mg; the request promotes Forte 80 and 120. Same
          family, different SKUs, matched on CODE so a name never credits one to the other. This
          sits above the customer-wide figures because it is the number that decides the request. */}
      <div className={`${adminSoftPanelClassName} rounded-[6px] p-3`}>
        <p className="text-phx-sm font-black uppercase tracking-[0.14em] text-phx-ink-soft">
          The {data.requested.productCount} product{data.requested.productCount === 1 ? "" : "s"} this request promotes
        </p>
        {data.requested.sold.length > 0 ? (
          <>
            <p className="mt-1 text-phx-md font-bold leading-6 text-phx-ink-2">
              <strong className="text-phx-ink">{data.requested.sold.length}</strong> of{" "}
              <strong className="text-phx-ink">{data.requested.productCount}</strong> have sold at this customer,
              totalling <strong className="text-phx-ink">{egp(data.requested.totalValue)}</strong>.
            </p>
            <ul className="mt-2 space-y-1">
              {data.requested.sold.map((row) => (
                <li className="flex items-center justify-between gap-3 text-phx-sm" key={row.label}>
                  <span className="font-bold text-phx-ink">{row.label}</span>
                  <span className="shrink-0 font-black text-[#166534]">{egp(row.value)}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mt-1 text-phx-md font-bold leading-6 text-[#B91C1C]">
            None of these products has ever sold at this customer. The forecast rests entirely on
            products it has never bought.
          </p>
        )}
        {data.requested.neverSold.length > 0 ? (
          <p className="mt-2 rounded-[6px] border border-[#FED7AA] bg-phx-accent-soft px-3 py-2 text-phx-sm font-bold leading-5 text-[#9A3412]">
            Never sold here: {data.requested.neverSold.join(", ")}
          </p>
        ) : null}
      </div>

      {/* The ask, next to what the history projects. */}
      <div className="grid gap-2 sm:grid-cols-3">
        <div className={`${adminSoftPanelClassName} rounded-[6px] px-3 py-2`}>
          <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-soft">Request cost</p>
          <p className="mt-0.5 text-phx-lg font-black text-phx-ink">{egp(ask.estimatedCost)}</p>
        </div>
        <div className={`${adminSoftPanelClassName} rounded-[6px] px-3 py-2`}>
          <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-soft">
            Required return ({ask.roiDurationMonths}mo)
          </p>
          <p className="mt-0.5 text-phx-lg font-black text-phx-ink">{egp(ask.requiredRoiValue)}</p>
        </div>
        <div
          className={`rounded-[6px] border px-3 py-2 ${
            shortfall ? "border-[#FECACA] bg-[#FEF2F2]" : "border-[#BBF7D0] bg-[#F0FDF4]"
          }`}
        >
          <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-phx-ink-soft">
            History projects ({ask.roiDurationMonths}mo)
          </p>
          <p className={`mt-0.5 text-phx-lg font-black ${shortfall ? "text-[#B91C1C]" : "text-[#166534]"}`}>
            {egp(verdict.projectedOverWindow)}
          </p>
        </div>
      </div>

      {shortfall ? (
        <p className="flex items-start gap-2 rounded-[6px] border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-phx-sm font-bold leading-5 text-[#B91C1C]">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            At this customer&apos;s historical rate the request falls{" "}
            <strong>{egp(verdict.projectedShortfall)}</strong> short of the required return
            {underTarget ? " — and its forecast is already flagged under target" : ""}. Reaching it needs a
            step change in this customer&apos;s offtake, not a continuation of it.
          </span>
        </p>
      ) : null}

      {verdict.hasHistory ? (
        <>
          <button
            className="inline-flex items-center gap-1.5 rounded-[6px] border border-phx-line bg-white px-3 py-2 text-phx-sm font-black text-phx-ink transition hover:border-phx-accent-line hover:bg-phx-accent-soft shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]"
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {open ? "Hide full sales detail" : "Show all sales — per month, product and distributor"}
          </button>

          {open ? (
            <div className="grid gap-3 lg:grid-cols-3">
              <div className={`${adminPanelClassName} rounded-[6px]`}>
                <p className="border-b border-phx-line px-3 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-phx-ink-soft">
                  By month
                </p>
                <ul className="divide-y divide-phx-paper-2">
                  {data.byMonth.map((row) => (
                    <li className="flex items-center justify-between gap-3 px-3 py-2" key={row.period}>
                      <span className="text-phx-sm font-bold text-phx-ink">{monthLabel(row.period)}</span>
                      <span className="shrink-0 text-phx-sm font-black text-phx-ink">{egp(row.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <BreakdownTable emptyLabel="No products recorded" rows={data.byProduct} title="By product" />
              <BreakdownTable emptyLabel="No distributors recorded" rows={data.byDistributor} title="By distributor" />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
