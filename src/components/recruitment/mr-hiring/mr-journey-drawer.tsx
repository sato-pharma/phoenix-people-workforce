"use client";

// Recruitment / Medical Rep hiring — one candidate's hiring journey (§10), in a side sheet: where they
// are, the one thing to do next (only the buttons THIS viewer may press), the nine steps as a
// checklist, and the full timeline from the WhatsApp CV to the offer.
//
// The CV and the application are on the sheet at every step, for everyone who opens it (owner,
// 7 Nov 2026: "the cv and application must appear and be appearing in all steps for every one"). A
// wide screen is THREE PANES (owner, same day): the CV on the left, the application and the WhatsApp
// replies in the middle, the journey on the right as it was — so the CV stays in view while a result is
// written. A narrow screen keeps one column, the CV and the application right under the current step.
//
// Everything is read from the journey route, which has already removed the salary for anyone who may
// not see it — nothing here hides a number the browser holds.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleDashed, Minus, X } from "lucide-react";

import { useIsWideScreen } from "@/components/employee-portal/portal-chrome-hooks";
import { getJson } from "@/components/recruitment/recruitment-fetch";
import { RecruitmentPill } from "@/components/recruitment/recruitment-premium";
import { MrCvApplication } from "@/components/recruitment/mr-hiring/mr-cv-application";
import { MrBookingForm, MrRecommendationForm, MrResultForm } from "@/components/recruitment/mr-hiring/mr-forms";
import { phxButtonAccentClassName, phxButtonGhostClassName, phxButtonPrimaryClassName } from "@/components/ui/form-tokens";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import type { CandidateTimelineEvent } from "@/lib/recruitment/candidate-timeline";
import {
  cairoWhen,
  dayLabel,
  mrStageHeadline,
  mrStageStateLine,
  mrStageTone,
  mrVisibleChecklist,
  mrWhere,
} from "@/lib/recruitment/mr-hiring/display";
import type { MrRow } from "@/lib/recruitment/mr-hiring/rows";
import {
  MR_LINE_LABELS,
  MR_RECOMMENDATION_LABELS,
  MR_RESULT_STEP_LABELS,
  MR_ROUND_LABELS,
  MR_STEP_LABELS,
  mrResultLabel,
  type MrAreaChoice,
  type MrResultStep,
} from "@/lib/recruitment/mr-hiring/vocabulary";
import { cn } from "@/lib/utils";

type Journey = { row: MrRow; timeline: CandidateTimelineEvent[]; areaChoices: MrAreaChoice[] };
type Mode = null | { kind: "result"; step: MrResultStep; withoutDsm: boolean } | { kind: "recommend" } | { kind: "book" };

const MONEY = new Intl.NumberFormat("en-EG", { maximumFractionDigits: 0 });

function recordLabel(step: MrResultStep): string {
  if (step === "hr_screening") return "Screen the CV";
  if (step === "final_decision") return "Make the decision";
  if (step === "dsm") return "Record DSM feedback";
  if (step === "rsm") return "Record RSM evaluation";
  return `Record result · ${MR_RESULT_STEP_LABELS[step]}`;
}

export function MrJourneyDrawer({
  candidateHref,
  candidateId,
  initialAction = null,
  onChanged,
  onClose,
}: {
  /** Where "Open the candidate" goes for this viewer, or null when there is nowhere for them to go. */
  candidateHref: string | null;
  candidateId: string;
  /** Opens with this viewer's own form already open beside the CV, when they may use it. */
  initialAction?: "result" | "recommend" | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const dialogRef = useDialogA11y({ onClose, open: true });
  const wide = useIsWideScreen();
  const [journey, setJourney] = useState<Journey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const initialApplied = useRef(false);

  const load = useCallback(async () => {
    try {
      const data = await getJson(`/api/recruitment/mr-hiring/${encodeURIComponent(candidateId)}/journey`);
      const loaded = data.row as MrRow;
      setJourney({
        areaChoices: (data.areaChoices as MrAreaChoice[] | undefined) ?? [],
        row: loaded,
        timeline: (data.timeline as CandidateTimelineEvent[]) ?? [],
      });
      setError(null);
      if (!initialApplied.current) {
        initialApplied.current = true;
        if (initialAction === "result" && loaded.can.record) setMode({ kind: "result", step: loaded.can.record, withoutDsm: false });
        else if (initialAction === "recommend" && loaded.can.recommend) setMode({ kind: "recommend" });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the hiring journey.");
    }
  }, [candidateId, initialAction]);

  useEffect(() => {
    // Scheduled, not inline: react-hooks/set-state-in-effect is an error in this repo.
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const done = (message: string | null = null) => {
    setMode(null);
    setNotice(message);
    onChanged();
    void load();
  };

  const row = journey?.row ?? null;

  return (
    <div className="fixed inset-0 z-[200] flex justify-end bg-[#020617]/60" onClick={onClose}>
      <div
        aria-labelledby="mr-journey-title"
        aria-modal="true"
        className="flex h-full w-full max-w-2xl flex-col border-l border-slate-200 bg-white lg:max-w-[min(160rem,96%)]"
        onClick={(event) => event.stopPropagation()}
        ref={dialogRef}
        role="dialog"
      >
        <header className="flex items-start justify-between gap-3 bg-slate-950 px-4 py-3 text-white sm:px-5">
          <div className="min-w-0">
            <p className="text-phx-2xs font-black uppercase tracking-[0.2em] text-orange-300">Hiring journey · Medical Representative</p>
            <h2 className="mt-1 break-words text-lg font-black" id="mr-journey-title">
              {row?.name ?? "Loading…"}
            </h2>
            {row ? (
              <p className="mt-0.5 break-words text-xs text-slate-300">
                {[row.area, row.line ? `${MR_LINE_LABELS[row.line]} line` : null, row.governorate, row.arrivedOn ? `CV on ${row.arrivedOn}` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
          </div>
          <button aria-label="Close" className="border border-white/20 p-1.5 text-white hover:bg-white/10" onClick={onClose} type="button">
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {wide ? <MrCvApplication candidateId={candidateId} layout="panes" /> : null}
          <div className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-5">
            {error ? <p className="border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-bold text-rose-800">{error}</p> : null}
            {!row && !error ? <p className="text-sm text-slate-500">Loading the journey…</p> : null}

            {row ? (
              <>
                <section className="border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <RecruitmentPill tone={mrStageTone(row.stage)}>{mrStageHeadline(row.stage)}</RecruitmentPill>
                  </div>
                  <p className="mt-2 break-words text-sm text-slate-700">{mrStageStateLine(row.stage)}</p>
                  {notice ? <p className="mt-2 border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-900">{notice}</p> : null}

                  {mode === null ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {row.can.record ? (
                        <button
                          className={phxButtonAccentClassName}
                          onClick={() => setMode({ kind: "result", step: row.can.record as MrResultStep, withoutDsm: false })}
                          type="button"
                        >
                          {recordLabel(row.can.record)}
                        </button>
                      ) : null}
                      {row.can.decideWithoutDsm ? (
                        <button className={phxButtonPrimaryClassName} onClick={() => setMode({ kind: "result", step: "dsm", withoutDsm: true })} type="button">
                          Decide without DSM feedback
                        </button>
                      ) : null}
                      {row.can.recommend ? (
                        <button className={phxButtonAccentClassName} onClick={() => setMode({ kind: "recommend" })} type="button">
                          Write the recommendation
                        </button>
                      ) : null}
                      {row.can.book.length > 0 ? (
                        <button className={phxButtonAccentClassName} onClick={() => setMode({ kind: "book" })} type="button">
                          Book {MR_ROUND_LABELS[row.can.book[0]]}
                        </button>
                      ) : null}
                      {row.offerHref ? (
                        <a className={phxButtonAccentClassName} href={row.offerHref}>
                          Prepare offer
                        </a>
                      ) : null}
                      {candidateHref ? (
                        <a className={phxButtonGhostClassName} href={candidateHref}>
                          Open the candidate
                        </a>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-4 border-t border-slate-200 pt-4">
                      {mode.kind === "result" ? (
                        <MrResultForm
                          areaChoices={journey?.areaChoices ?? []}
                          candidateId={row.candidateId}
                          candidateName={row.name}
                          decidedWithoutDsm={mode.withoutDsm}
                          defaultArea={row.area}
                          defaultLine={row.line}
                          onCancel={() => setMode(null)}
                          onDone={() => done()}
                          step={mode.step}
                        />
                      ) : mode.kind === "recommend" ? (
                        <MrRecommendationForm candidateId={row.candidateId} candidateName={row.name} onCancel={() => setMode(null)} onDone={() => done()} />
                      ) : (
                        <MrBookingForm onCancel={() => setMode(null)} onDone={(message) => done(message)} row={row} />
                      )}
                    </div>
                  )}
                </section>

                {wide ? null : <MrCvApplication candidateId={candidateId} />}

                <section>
                  <h3 className="text-phx-xs font-black uppercase tracking-[0.15em] text-slate-700">The steps</h3>
                  <ol className="mt-2 divide-y divide-slate-200 border border-slate-200">
                    {mrVisibleChecklist(row.stage).map((item, index) => {
                      const label = item.step === "final" && row.stage.jointFinal ? "Joint final · HR Manager + NSM" : MR_STEP_LABELS[item.step];
                      const result = item.result;
                      const recommendation = item.step === "recommendation" ? row.recommendation : null;
                      return (
                        <li className={cn("flex gap-3 px-3 py-2.5", item.status === "current" && "bg-orange-50")} key={item.step}>
                          <span
                            aria-hidden="true"
                            className={cn(
                              "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border text-phx-2xs font-black",
                              item.status === "done" && "border-emerald-600 bg-emerald-600 text-white",
                              item.status === "current" && "border-orange-500 text-orange-600",
                              item.status === "closed_here" && "border-rose-600 bg-rose-600 text-white",
                              (item.status === "upcoming" || item.status === "skipped") && "border-slate-300 text-slate-400",
                            )}
                          >
                            {item.status === "done" ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : item.status === "skipped" ? (
                              <Minus className="h-3.5 w-3.5" />
                            ) : item.status === "current" ? (
                              <CircleDashed className="h-3.5 w-3.5" />
                            ) : (
                              index + 1
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="break-words text-sm font-bold text-slate-900">
                              {label}
                              {item.status === "skipped" ? (
                                <span className="ml-1 font-normal text-slate-500">· replaced by the joint final</span>
                              ) : null}
                            </p>
                            {item.booking ? (
                              <p className="break-words text-xs text-slate-600">
                                {cairoWhen(item.booking.startsAt)} ·{" "}
                                {mrWhere(item.booking)}
                                {item.booking.interviewerName ? ` · ${item.booking.interviewerName}` : ""}
                              </p>
                            ) : null}
                            {result ? (
                              <p className="break-words text-xs text-slate-700">
                                <span className="font-bold">{mrResultLabel(result.step, result.result)}</span>
                                {result.decidedWithoutDsm ? " · decided by HR, no DSM feedback" : result.byName ? ` · ${result.byName}` : ""}
                                {result.rating ? ` · rating ${result.rating} of 5` : ""} · {cairoWhen(result.createdAt)}
                                <span className="mt-0.5 block whitespace-pre-wrap text-slate-600">{result.comment}</span>
                              </p>
                            ) : null}
                            {recommendation ? (
                              <p className="break-words text-xs text-slate-700">
                                <span className="font-bold">{MR_RECOMMENDATION_LABELS[recommendation.recommendation]}</span>
                                {recommendation.byName ? ` · ${recommendation.byName}` : ""}
                                {recommendation.proposedJoiningDate ? ` · joining ${dayLabel(recommendation.proposedJoiningDate)}` : ""}
                                {recommendation.proposedSalary !== null ? ` · EGP ${MONEY.format(recommendation.proposedSalary)} a month` : ""}
                                {recommendation.note ? <span className="mt-0.5 block whitespace-pre-wrap text-slate-600">{recommendation.note}</span> : null}
                              </p>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>

                <section>
                  <h3 className="text-phx-xs font-black uppercase tracking-[0.15em] text-slate-700">Timeline</h3>
                  {journey && journey.timeline.length > 0 ? (
                    <ol className="mt-2 space-y-2">
                      {journey.timeline.map((event) => (
                        <li className="border-l-2 border-orange-400 pl-3" key={event.id}>
                          <p className="text-phx-2xs font-bold uppercase tracking-wide text-slate-500">{cairoWhen(event.at)}</p>
                          <p className="break-words text-sm font-bold text-slate-900">{event.title}</p>
                          {event.detail ? <p className="whitespace-pre-wrap break-words text-xs text-slate-600">{event.detail}</p> : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-2 text-sm text-slate-500">Nothing recorded yet.</p>
                  )}
                </section>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
