import { AlertTriangle } from "lucide-react";

import type { SamePharmacyCrossUseFlag } from "@/lib/direct-orders/same-pharmacy-cross-use";

/**
 * Same pharmacy, same person, BOTH modules (owner, 2026-10-28) — shown on the approval window of a
 * direct order AND of a marketing request, to every rung of the chain, the CEO included. Rose like the
 * twin warning: it is a possible double PAYMENT. Flagged, never blocked: the approver still decides.
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
    <div className={`border border-rose-300 bg-rose-50 px-3 py-2.5 ${className}`} data-same-pharmacy-flag="">
      <p className="flex items-start gap-1.5 text-phx-sm font-black text-rose-900">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{flag.headline}</span>
      </p>
      <ul className="mt-1.5 space-y-1">
        {flag.uses.map((use) => (
          <li className="break-words text-phx-xs font-medium text-rose-900" key={`${use.module}:${use.id}`}>
            <span className="font-black">{use.reference}</span> — {use.description}
          </li>
        ))}
      </ul>
      <p className="mt-1.5 break-words text-phx-xs text-rose-800">{flag.explanation}</p>
    </div>
  );
}
