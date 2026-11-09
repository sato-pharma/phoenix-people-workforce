"use client";

import * as React from "react";

import type { MarketingSalesEvidence } from "@/lib/marketing-requests/sales-evidence";

function egp(value: number) {
  return `EGP ${Math.round(value).toLocaleString("en-US")}`;
}

/**
 * Compact "has this customer ever bought what we are pushing?" strip for an inbox row.
 *
 * Deliberately narrow: it answers ONE question and answers it before the approver opens anything.
 * The customer-wide total lives on the decision page and flatters a request — on the live request
 * the customer had traded EGP 2,774 over six months while only one of five promoted products had
 * ever sold there, once, for EGP 79.
 *
 * Fails quiet, not loud: an inbox row must still render if this lookup fails. A broken strip must
 * never cost the approver the row itself.
 */
export function MarketingRequestedProductHistory({ requestId }: { requestId: string }) {
  const [data, setData] = React.useState<MarketingSalesEvidence | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/marketing-requests/${requestId}/sales-evidence`, { cache: "no-store" });
        if (!response.ok) {
          if (!cancelled) setFailed(true);
          return;
        }
        const payload = (await response.json()) as MarketingSalesEvidence;
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  if (failed) {
    return (
      <p className="text-phx-xs font-bold text-slate-400">
        Sales history for the requested products is unavailable right now.
      </p>
    );
  }
  if (!data) {
    return <p className="text-phx-xs font-bold text-slate-400">Loading requested-product history...</p>;
  }

  const { requested } = data;
  const soldCount = requested.sold.length;

  return (
    <div>
      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-400">
        Requested products at this customer
      </p>
      {soldCount > 0 ? (
        <>
          <p className="mt-0.5 text-phx-sm font-black text-slate-950">
            {soldCount} of {requested.productCount} sold here · {egp(requested.totalValue)}
          </p>
          <p className="mt-1 text-phx-xs font-semibold leading-5 text-slate-600">
            {requested.sold.map((row) => `${row.label} ${egp(row.value)}`).join(" · ")}
          </p>
        </>
      ) : (
        <p className="mt-0.5 text-phx-sm font-black text-rose-700">
          None of the {requested.productCount} requested product{requested.productCount === 1 ? " has" : "s have"} ever
          sold at this customer
        </p>
      )}
      {requested.neverSold.length > 0 ? (
        <p className="mt-1 text-phx-xs font-semibold leading-5 text-amber-700">
          Never sold here: {requested.neverSold.join(", ")}
        </p>
      ) : null}
    </div>
  );
}
