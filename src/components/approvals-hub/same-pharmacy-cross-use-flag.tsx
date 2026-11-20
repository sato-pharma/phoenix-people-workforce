import { AlertTriangle } from "lucide-react";

import type { SamePharmacyCrossUseFlag } from "@/lib/direct-orders/same-pharmacy-cross-use";

/**
 * Same pharmacy, same person, BOTH modules (owner, 2026-10-28) — shown on the approval window of a
 * direct order AND of a marketing request, to every rung of the chain, the CEO included. A rose rail like
 * the twin warning — never a tinted box: it is a possible double PAYMENT. Flagged, never blocked: the
 * approver still decides.
 * Renders nothing when there is no flag, so a caller passes the optional field straight through.
 */
export function SamePharmacyCrossUseNotice({
  className = "",
  flag,
}: {
  className?: string;
  flag: SamePharmacyCrossUseFlag | null | undefined;
}) {
  if (!flag || flag.uses.length === 0) return null;
  return (
    <div className={`flex min-w-0 gap-3 ${className}`} data-same-pharmacy-flag="" role="alert">
      <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-rose-500" />
      <div className="min-w-0">
        <p className="flex items-start gap-1.5 text-phx-sm font-bold text-rose-800">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="min-w-0 break-words">{flag.headline}</span>
        </p>
        <ul className="mt-1.5 space-y-1">
          {flag.uses.map((use) => (
            <li className="break-words text-phx-xs font-medium text-slate-700" key={`${use.module}:${use.id}`}>
              <span className="font-bold text-[#08111f]">{use.reference}</span> — {use.description}
            </li>
          ))}
        </ul>
        <p className="mt-1.5 break-words text-phx-xs text-slate-600">{flag.explanation}</p>
      </div>
    </div>
  );
}
