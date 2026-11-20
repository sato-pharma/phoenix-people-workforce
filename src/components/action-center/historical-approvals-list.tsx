"use client";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import type { HistoricalApprovalItem } from "@/components/action-center/types";
import { HISTORY_MODULE_LABELS } from "@/components/action-center/types";
import { LANDING_INK, LandingRailLine, LandingTitle, landingActionClassName } from "@/components/employee-portal/landing-kit";
import { cairoDate } from "@/lib/format/cairo-datetime";

// The kit's language (landing-kit.tsx): where a request ended is coloured small text on a thin rail
// at the row's left — never a filled pill. Returned takes the kit's own orange-700 tone.
const DECISION_TEXT: Record<HistoricalApprovalItem["decision"], string> = {
  approved: "text-emerald-700",
  rejected: "text-rose-700",
  returned: "text-orange-700",
};

const DECISION_RAIL: Record<HistoricalApprovalItem["decision"], string> = {
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  returned: "bg-orange-500",
};

const DECISION_LABEL: Record<HistoricalApprovalItem["decision"], string> = {
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned",
};

const PANEL = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;

type Props = {
  items: HistoricalApprovalItem[];
};

export function HistoricalApprovalsList({ items }: Props) {
  if (items.length === 0) {
    return (
      <section className={PANEL}>
        <header className="border-b border-slate-200 px-3 py-2.5 sm:px-4">
          <LandingTitle>No approval history yet</LandingTitle>
        </header>
        <LandingRailLine rail="bg-slate-300">
          Every leave, excuse, plan, or resignation you approve or reject will appear here with the decision date.
        </LandingRailLine>
      </section>
    );
  }

  return (
    <div className={`divide-y divide-slate-200 ${PANEL}`}>
      {items.map((item) => (
        <div key={item.id} className="flex min-w-0 gap-3 px-3 py-3.5 sm:px-4">
          <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${DECISION_RAIL[item.decision]}`} />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-col gap-0.5">
              {/* The label is where the request ENDED (its final state); the note under it says what
                  this person did when it differs: "Approved by you · rejected later". */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-phx-xs font-bold uppercase tracking-[0.1em]">
                <span className={DECISION_TEXT[item.decision]}>{DECISION_LABEL[item.decision]}</span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="text-slate-500">{HISTORY_MODULE_LABELS[item.module]}</span>
              </div>
              {item.outcomeNote ? <p className="break-words text-xs font-semibold text-slate-600">{item.outcomeNote}</p> : null}
              <p className={`break-words text-sm font-bold ${LANDING_INK}`} dir="auto">{item.title}</p>
              <p className="break-words text-xs text-slate-600" dir="auto">{item.employeeName}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <span className="whitespace-nowrap text-xs tabular-nums text-slate-500">{cairoDate(item.decidedAt)}</span>
              {item.href ? (
                <a href={item.href} className={landingActionClassName("outline")}>
                  View request
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
