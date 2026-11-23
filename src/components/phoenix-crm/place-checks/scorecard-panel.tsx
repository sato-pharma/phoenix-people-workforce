"use client";

/**
 * Phoenix CRM — Place checks: the scorecard, and on the Super Admin's board how often his decisions
 * matched the system's advice.
 *
 * The scorecard is each rep's captures (owner, 2026-10-17: "is this a report that really shows me
 * data?"). It headed the company board until the rebuild of 23 Nov 2026, a screen above the first
 * waiting place; there it is now a tab, drawn open. A district manager's board still opens with it,
 * folded under its totals.
 *
 * 🔴 THE METER IS THE SUPER ADMIN'S ALONE: nobody else decides, and a district manager's board is never
 * told there is advice. A meter that could not be read says so, never a share of nothing.
 */

import { AdminCallout } from "@/components/admin/admin-design-system";
import { PlaceCheckScorecard } from "@/components/phoenix-crm/place-check-scorecard";
import type { PlaceCheckBoard } from "@/components/phoenix-crm/place-checks/use-place-check-board";
import { CrmPill } from "@/components/phoenix-crm/ui";
import type { PlaceCheckAdviceKind } from "@/lib/phoenix-crm/place-check-advice";
import { AGREEMENT_WINDOW_DAYS, agreementSentence, type PlaceCheckAgreement } from "@/lib/phoenix-crm/place-check-stored-advice";

const ADVISED: Record<PlaceCheckAdviceKind, string> = {
  approve: "The system said approve",
  reject: "The system said reject",
  look: "The system said check it yourself",
};

function AgreementMeter({ agreement }: { agreement: PlaceCheckAgreement | null }) {
  if (!agreement) {
    return (
      <AdminCallout tone="warning">
        <span>How often your decisions matched the system&apos;s advice could not be read just now.</span>
      </AdminCallout>
    );
  }
  return (
    <div className="min-w-0 border border-slate-200 bg-white">
      <div className="px-4 py-3">
        <h2 className="break-words text-sm font-black uppercase tracking-[0.12em] text-slate-500">
          Your decisions and the system&apos;s advice, last {AGREEMENT_WINDOW_DAYS} days
        </h2>
        <p className="mt-1 break-words text-sm text-slate-700">{agreementSentence(agreement)}</p>
      </div>
      {agreement.kinds.length > 0 ? (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {agreement.kinds.map((kind) => (
            <li key={`${kind.advice}:${kind.code}`} className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-sm">
              <span className="min-w-0 flex-1 basis-60 break-words font-semibold text-slate-900">{kind.label}</span>
              <span className="min-w-0 break-words text-slate-600">
                {ADVISED[kind.advice]}. You approved {kind.approved} and rejected {kind.rejected}
                {kind.agreed === null ? "." : `, so ${kind.agreed} of ${kind.decided} matched.`}
              </span>
              {kind.advice === "approve" && kind.meetsReady ? <CrmPill tone="good">Counts as Ready</CrmPill> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function PlaceChecksScorecardPanel({ board }: { board: PlaceCheckBoard }) {
  const { agreement, filters, lanes, mode, openScore, scorecard, set, team } = board;
  return (
    <>
      {lanes ? <AgreementMeter agreement={agreement} /> : null}
      {scorecard ? (
        <PlaceCheckScorecard
          mode={mode}
          onOpen={openScore}
          onPickRep={(rep) => set("rep", rep)}
          opened={!team}
          pickedRep={filters.rep}
          reps={scorecard.reps}
          total={scorecard.total}
        />
      ) : null}
    </>
  );
}
