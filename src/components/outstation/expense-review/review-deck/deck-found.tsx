"use client";

import { ChevronRight, Loader2 } from "lucide-react";

import { CrmPill } from "@/components/phoenix-crm/ui";
import { expenseApprovalState } from "@/lib/outstation/approval-state";
import { expenseTripAwaitingLabel, expenseTripDaysAwaiting, expenseTripTriage } from "@/lib/outstation/expense-approval-triage";
import { isImportedHistoryTrip } from "@/lib/outstation/imported-history";
import { cn } from "@/lib/utils";

import type { Decision, LoadedRecord } from "../review-model";
import { EmployeeNote } from "../review-parts";
import { SIGNAL_TONE, type Signal, type TripSignals } from "./deck-signals";
import { STAGE_VIEWS, type StageView } from "./deck-stage";

/**
 * "What the system found" — the Place checks reviewer's own section, here in three sentences: field
 * work, claim checks, photos. Each is a button that puts its evidence on the stage, so reading a
 * sentence and seeing the proof behind it is one click.
 *
 * Under them, the reasons the list held the trip back for, how long it has waited, why an allowance
 * was not paid (the system's sentences, cut out of the employee's note in payroll-expense-mapping.ts),
 * and the employee's own note — printed ONCE, here, and never on a list row.
 */
export function DeckFound({
  decision,
  now,
  onView,
  record,
  signals,
  view,
}: {
  decision: Decision;
  now: number;
  onView: (view: StageView) => void;
  record: LoadedRecord;
  signals: TripSignals;
  view: StageView;
}) {
  const signalFor: Record<StageView, Signal> = { checks: signals.claim, field: signals.fieldWork, photos: signals.photos };
  const awaiting = expenseApprovalState(decision) === "pending" && !isImportedHistoryTrip(record.date);
  const reading = awaiting ? expenseTripTriage(record) : null;
  const daysAwaiting = awaiting ? expenseTripDaysAwaiting(record.submittedAt, now) : null;
  return (
    <section className="min-w-0 space-y-3 border-b border-slate-100 px-5 py-4" data-deck-found>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
        <h4 className="break-words text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">What the system found</h4>
        {daysAwaiting !== null ? (
          <span className={cn("text-phx-2xs font-black", daysAwaiting >= 7 ? "text-orange-700" : "text-slate-500")}>
            {expenseTripAwaitingLabel(daysAwaiting)}
          </span>
        ) : null}
      </div>
      {reading ? (
        <div className="flex min-w-0 flex-wrap gap-1" data-deck-triage>
          {reading.triage === "look" ? (
            reading.reasons.map((reason) => (
              <CrmPill key={reason} tone="bad">
                {reason}
              </CrmPill>
            ))
          ) : (
            <CrmPill tone="good">Nothing found when it was submitted</CrmPill>
          )}
        </div>
      ) : null}
      <ul className="min-w-0 space-y-1.5">
        {STAGE_VIEWS.map((one) => {
          const signal = signalFor[one.key];
          const tone = SIGNAL_TONE[signal.tone];
          const Icon = one.icon;
          const showing = view === one.key;
          return (
            <li key={one.key}>
              <button
                aria-pressed={showing}
                className={cn(
                  "flex w-full min-w-0 items-start gap-3 border border-l-[3px] px-3 py-2.5 text-left transition",
                  tone.bar,
                  showing ? "border-y-slate-300 border-r-slate-300 bg-slate-50" : "border-y-slate-200 border-r-slate-200 bg-white hover:bg-slate-50",
                )}
                data-found-signal={one.key}
                data-tone={signal.tone}
                onClick={() => onView(one.key)}
                type="button"
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                <span className="min-w-0 flex-1">
                  <span className="block text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{one.label}</span>
                  <span className={cn("mt-0.5 flex items-start gap-1.5 break-words text-sm font-bold", tone.text)}>
                    {signal.tone === "loading" ? <Loader2 aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" /> : null}
                    <span className="min-w-0 break-words">{signal.line}</span>
                  </span>
                </span>
                <span className="mt-0.5 shrink-0 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">
                  {showing ? "Showing" : <ChevronRight aria-hidden className="h-4 w-4" />}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {record.allowanceNotices && record.allowanceNotices.length > 0 ? (
        <div className="min-w-0 space-y-1 border-l-[3px] border-l-amber-500 bg-amber-50 px-3 py-2 text-xs" data-allowance-notices>
          {record.allowanceNotices.map((notice) => (
            <p className="break-words text-amber-900" key={notice}>
              <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-amber-700">Allowance</span>
              {" · "}
              {notice}
            </p>
          ))}
        </div>
      ) : null}
      {record.employeeNote ? (
        <div className="min-w-0 border-t border-slate-100 pt-3">
          <EmployeeNote note={record.employeeNote} wide />
        </div>
      ) : null}
    </section>
  );
}
