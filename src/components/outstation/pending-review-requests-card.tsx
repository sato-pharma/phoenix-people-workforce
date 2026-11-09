import { Clock } from "lucide-react";

import type { PendingOutstationReviewRequest } from "@/lib/outstation/service";
import { normalizeTransportation } from "@/lib/outstation/expense-taxonomy";

function formatEgp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

function formatTripDate(value: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric" }).format(
    date,
  );
}

/**
 * Read-only list of the submitter's own outstation requests that are HELD for
 * Super Admin review (governorate unconfirmed). Rendered above the ledger-backed
 * expense dashboard, which only shows accepted (payroll) rows.
 */
export function PendingReviewRequestsCard({
  requests,
}: {
  requests: PendingOutstationReviewRequest[];
}) {
  if (requests.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-lg border border-amber-200 bg-amber-50/60 p-4 shadow-[0_1px_3px_rgba(15,23,42,0.06)] sm:p-5">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-amber-600" />
        <span className="rounded-md bg-amber-100 px-2 py-1 text-phx-sm font-bold uppercase tracking-wider text-amber-700">
          Pending Super Admin review
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-phx-md leading-relaxed text-amber-800">
        {requests.length} request{requests.length === 1 ? "" : "s"} could not have the
        residence or destination governorate confirmed automatically, so {requests.length === 1 ? "it is" : "they are"} held
        for a Super Admin decision and {requests.length === 1 ? "is" : "are"} not in payroll yet.
      </p>

      <div className="mt-4 space-y-3">
        {requests.map((request) => (
          <div
            key={request.id}
            className="rounded-md border border-amber-200 bg-white p-3 sm:p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-bold text-slate-900">{request.destination}</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">
                  {formatTripDate(request.tripStartDate)} – {formatTripDate(request.tripEndDate)} ·{" "}
                  {normalizeTransportation(request.transportationType, null, null) || request.transportationType || "—"}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-slate-900">{formatEgp(request.amount)}</p>
                <span className="mt-1 inline-flex items-center px-2 py-0.5 text-phx-sm font-bold uppercase tracking-wider ring-1 bg-amber-50 text-amber-700 ring-amber-200">
                  Pending review
                </span>
              </div>
            </div>
            <p className="mt-2 text-phx-md leading-relaxed text-slate-600">{request.reason}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
