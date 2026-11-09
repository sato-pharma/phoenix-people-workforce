"use client";

import {
  isMarketingAdminOverrideNote,
  MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES,
} from "@/lib/marketing-requests/admin-override-note";
import type { MarketingApproverChainRung } from "@/lib/marketing-requests/service";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";
import { formatStableEnGb } from "@/lib/format/cairo-datetime";
import { stableCurrencyFormatter } from "@/lib/format/stable-currency";

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Shared between the inbox's two tabs ------------------------------------------------------------------------------------------------ */
/*                                                                                                                                                                                                             */
/* Extracted when the History tab was added (2026-08-19). A decision rung has to LOOK the same          */
/* whether it is being made or being remembered — two copies of this drift, and the day they            */
/* disagree is the day somebody reads a past approval wrong.                                            */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export function egp(value: number) {
  return stableCurrencyFormatter("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

export function formatDate(value: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return formatStableEnGb(parsed, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
  });
}

/** Date AND time, Africa/Cairo — a decision time without the clock is not an audit trail. */
export function formatDateTime(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatStableEnGb(parsed, {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  });
}

export const RUNG_TONE: Record<MarketingApproverChainRung["status"], string> = {
  approved: "border-emerald-200 bg-emerald-50 text-emerald-800",
  current: "border-orange-300 bg-orange-50 text-orange-900",
  pending: "border-slate-200 bg-slate-50 text-slate-500",
  rejected: "border-rose-200 bg-rose-50 text-rose-800",
  returned: "border-amber-200 bg-amber-50 text-amber-900",
  skipped: "border-slate-200 bg-slate-50 text-slate-400",
};

export const RUNG_VERB: Record<MarketingApproverChainRung["status"], string> = {
  approved: "Approved",
  current: "Waiting",
  pending: "Not reached yet",
  rejected: "Rejected",
  returned: "Returned",
  skipped: "Skipped",
};

/**
 * Who signed this off, when, and what they wrote.
 *
 * The chain used to render as a bare breadcrumb of step names. The CEO signs LAST, so he was the
 * one person being asked to commit money on the strength of three approvals he could not read.
 *
 * `title` exists because the same list answers two different questions: on a pending row it is the
 * approvals SO FAR, on a decided row it is the complete record.
 */
export function ApprovalHistory({
  requestCode,
  rungs,
  title = "Approval history",
}: {
  /**
   * Optional, and only read to spot the one out-of-band SFE Validation note (see
   * `admin-override-note.ts`). A caller that omits it gets the ordinary treatment on every note.
   */
  requestCode?: string | null;
  rungs: MarketingApproverChainRung[];
  title?: string;
}) {
  if (rungs.length === 0) return null;
  return (
    <div className="border-b border-slate-100 px-4 py-3">
      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-400">{title}</p>
      <ol className="mt-2 space-y-1.5">
        {rungs.map((rung) => {
          const decidedAt = formatDateTime(rung.decisionAt);
          return (
            <li
              className={`rounded-sm border px-2.5 py-1.5 ${RUNG_TONE[rung.status]}`}
              key={`${rung.sequence}-${rung.stepName}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-phx-xs font-black">
                  {rung.sequence}. {rung.stepName}
                </span>
                <span className="text-phx-xs font-bold">{RUNG_VERB[rung.status]}</span>
                {rung.approverName ? (
                  <span className="text-phx-xs font-medium">by {rung.approverName}</span>
                ) : null}
                {decidedAt ? <span className="text-phx-sm font-semibold opacity-80">{decidedAt}</span> : null}
                {rung.isMine ? (
                  <span className="rounded-sm bg-slate-900 px-1.5 py-0.5 text-phx-xs font-black uppercase tracking-[0.1em] text-white">
                    Yours
                  </span>
                ) : null}
              </div>
              {/* Full note, never truncated — the reason for a decision is the whole point of showing it. */}
              {rung.decisionNote ? (
                <p
                  className={`mt-1 text-phx-xs leading-snug ${
                    isMarketingAdminOverrideNote({ requestCode, stepName: rung.stepName })
                      ? MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES
                      : "font-medium"
                  }`}
                >
                  &ldquo;{rung.decisionNote}&rdquo;
                </p>
              ) : rung.status === "approved" ? (
                <p className="mt-1 text-phx-sm font-medium italic opacity-70">No comment left</p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
