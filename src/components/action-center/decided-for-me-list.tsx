"use client";

import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { HISTORY_MODULE_LABELS } from "@/components/action-center/types";
import { LANDING_INK, LandingRailLine, LandingTitle, landingActionClassName } from "@/components/employee-portal/landing-kit";
import type { DecidedForMeItem } from "@/lib/action-center/decided-for-me";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";

// The kit's language (landing-kit.tsx): square, white, a decision shown as coloured small text on a
// thin rail — never a filled pill. Returned takes the kit's own orange-700 tone, not the house orange.
const DECISION_TEXT: Record<DecidedForMeItem["decision"], string> = {
  approved: "text-emerald-700",
  rejected: "text-rose-700",
  returned: "text-orange-700",
};

const DECISION_RAIL: Record<DecidedForMeItem["decision"], string> = {
  approved: "bg-emerald-500",
  rejected: "bg-rose-500",
  returned: "bg-orange-500",
};

const DECISION_LABEL: Record<DecidedForMeItem["decision"], string> = {
  approved: "Approved",
  rejected: "Rejected",
  returned: "Returned",
};

const BASIS_LABEL: Record<DecidedForMeItem["basis"], string> = {
  team: "Your team",
  line: "Your line",
};

const PANEL = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;

type Props = {
  items: DecidedForMeItem[];
  windowDays: number;
  // The lookup failed. Distinct from an empty list on purpose: telling a manager back from leave
  // that "nobody decided anything for you" when the query never ran is the one wrong answer this
  // tab must never give. Measured on production 2026-09-07 — a transient directory failure
  // returned an empty list where the true answer was eight items.
  failed?: boolean;
};

/** Africa/Cairo, never the raw UTC instant — house rule for every time shown to a reader. */
function formatDecidedAt(iso: string): string {
  if (!iso) return "—";
  try {
    return stableEnGbFormatter({
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Africa/Cairo",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** A panel that states one condition: its title, then the words on a rail — never an empty square. */
function StatePanel({ title, rail, children }: { title: string; rail: string; children: React.ReactNode }) {
  return (
    <section className={PANEL}>
      <header className="border-b border-slate-200 px-3 py-2.5 sm:px-4">
        <LandingTitle>{title}</LandingTitle>
      </header>
      <LandingRailLine rail={rail}>{children}</LandingRailLine>
    </section>
  );
}

// `windowDays` is still taken: the page passes it, and the window is the lookup's own. The sentence
// that printed it sat under the panel's header, which the owner's rule removes (2026-11-20).
export function DecidedForMeList({ items, failed }: Props) {
  if (failed) {
    return (
      <StatePanel rail="bg-amber-500" title="Could not load this list">
        Something went wrong fetching what was decided for you, so this is <strong>not</strong> a
        statement that nothing happened. Reload the page, and tell IT if it keeps failing.
      </StatePanel>
    );
  }

  if (items.length === 0) {
    return (
      <StatePanel rail="bg-slate-300" title="Nobody decided anything for you">
        When someone covers for you — while you are on leave, or when an administrator steps in —
        what they decided on your team and your lines is listed here, so nothing that happened in
        your absence stays invisible.
      </StatePanel>
    );
  }

  return (
    <section className={PANEL}>
      <header className="border-b border-slate-200 px-3 py-2.5 sm:px-4">
        <LandingTitle>Decided for you</LandingTitle>
      </header>
      <div className="divide-y divide-slate-200">
        {items.map((item) => (
          <div key={item.id} className="flex min-w-0 gap-3 px-3 py-3.5 sm:px-4">
            <span aria-hidden="true" className={`w-1 shrink-0 self-stretch ${DECISION_RAIL[item.decision]}`} />
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-phx-xs font-bold uppercase tracking-[0.1em]">
                  <span className={DECISION_TEXT[item.decision]}>{DECISION_LABEL[item.decision]}</span>
                  <span aria-hidden="true" className="text-slate-300">·</span>
                  <span className="text-slate-500">{HISTORY_MODULE_LABELS[item.module]}</span>
                  <span aria-hidden="true" className="text-slate-300">·</span>
                  <span className="text-slate-500">{BASIS_LABEL[item.basis]}</span>
                </div>
                <p className={`break-words text-sm font-bold ${LANDING_INK}`} dir="auto">{item.title}</p>
                <p className="break-words text-xs text-slate-600" dir="auto">{item.employeeName}</p>
                <p className="break-words text-xs font-semibold text-slate-600" dir="auto">
                  Decided by {item.decidedByName || item.decidedByHrId}
                </p>
                {item.decidedNote ? (
                  // Their words, in full. Never truncated and never ellipsised (house rule), and
                  // `whitespace-pre-line` because these notes are typed with real line breaks —
                  // collapsing them turns a greeting and an instruction into one run-on sentence.
                  <p className="mt-1 whitespace-pre-line break-words border-l-2 border-slate-300 py-1 pl-2.5 text-xs leading-5 text-slate-700" dir="auto">
                    {item.decidedNote}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3">
                <span className="text-xs tabular-nums text-slate-500">{formatDecidedAt(item.decidedAt)}</span>
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
    </section>
  );
}
