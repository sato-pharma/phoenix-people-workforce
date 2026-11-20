import { LANDING_INK, LandingPanel } from "@/components/employee-portal/landing-kit";
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
    <LandingPanel title="Pending Super Admin review">
      <ul className="divide-y divide-slate-200">
        {requests.map((request) => (
          <li className="relative px-3 py-3 pl-4 sm:px-4 sm:pl-5" key={request.id}>
            {/* Held, not refused: the amber rail says "waiting", the words beside the amount say why. */}
            <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-amber-400" />
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={`break-words text-sm font-bold ${LANDING_INK}`} dir="auto">{request.destination}</p>
                <p className="mt-0.5 text-xs font-semibold tabular-nums text-slate-500">
                  {formatTripDate(request.tripStartDate)} – {formatTripDate(request.tripEndDate)} ·{" "}
                  {normalizeTransportation(request.transportationType, null, null) || request.transportationType || "—"}
                </p>
              </div>
              <div className="text-right">
                <p className={`text-sm font-bold tabular-nums ${LANDING_INK}`}>{formatEgp(request.amount)}</p>
                <span className="mt-1 inline-flex items-center border-l-2 border-amber-400 pl-1.5 text-phx-xs font-bold uppercase tracking-[0.06em] text-amber-800">
                  Pending review
                </span>
              </div>
            </div>
            <p className="mt-2 break-words text-phx-md leading-relaxed text-slate-600" dir="auto">{request.reason}</p>
          </li>
        ))}
      </ul>
    </LandingPanel>
  );
}
