"use client";

/**
 * Phoenix CRM — a manager's review of a SENT week, as steps (owner, 2026-10-02).
 *
 * On 1 October district managers approved 13 weeks of 51–94 customers each in a median of two minutes.
 * So a week waiting for review opens on the same step form the rep plans with (step-form.tsx), and the
 * manager walks it:
 *   1 Week      — where it stands, what changed since the last send, and the month's coverage;
 *   2 Day       — its days with their AM · PM counts; a tap on a day moves him on;
 *   3 Customers — that day's AM list, then its PM list, read only;
 *   4 Decide    — the coverage again, then Approve · Return the week · Return one day.
 *
 * Nothing approves or returns by itself: every decision is the press of its own button in PlanDecision,
 * and the board's one `decideWeek` sends it. The rep's own form is untouched — this is the reviewer's,
 * opened from Team on a week waiting for review that he decides (plan-board.tsx `reviewing`). His other
 * reach — the month chooser, the other weeks, Back to Team — stays on the board around it.
 *
 * COVERAGE is VALIDATED customers only (owner, 2026-10-02): every customer carried over from iReports360
 * is still pending, so it starts empty and says so in words rather than showing a zero. AM and PM are
 * never added together. Nothing here shows a visit, a location or any integrity signal — a review
 * judges the PLAN, and the rep's honesty is never on this screen.
 */

import { useRef, useState } from "react";
import { ChevronRight } from "lucide-react";

import type { BrickTint } from "@/components/phoenix-crm/brick-tints";
import { cairoStamp, countText, dayLabel, monthLabel, percentText, plural, weekLabel } from "@/components/phoenix-crm/format";
import { decisionBusy, PlanDecision, type PlanDecisionAction } from "@/components/phoenix-crm/plan-decision";
import { PLAN_STATUS_TONE, PlanWeekPanel, type WeekBusy } from "@/components/phoenix-crm/plan-week-panel";
import { CrmStepFooter, CrmStepForm, CrmStepNext, crmStepBackClassName, type CrmStep } from "@/components/phoenix-crm/step-form";
import { CrmBlock, CrmButton, CrmFacts, CrmNote, CrmPill, CrmStat, CrmStatGrid } from "@/components/phoenix-crm/ui";
import { monthKeyOf } from "@/lib/phoenix-crm/calendar";
import { dayActivityLabel } from "@/lib/phoenix-crm/day-activities";
import { EMPTY_DOCTOR_FILTER } from "@/lib/phoenix-crm/plan-filters";
import {
  changedDaysOf,
  planReviewCoverage,
  returnableDays,
  type PlanSentChanges,
  type ReviewCoverage,
  type ReviewLeftOut,
  type SentActivity,
  type SentDayChange,
  type SentItem,
} from "@/lib/phoenix-crm/plan-review-rules";
import type { DailyCaps } from "@/lib/phoenix-crm/plan-week-draft";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmGrade, PhoenixCrmDoctorListType } from "@/lib/phoenix-crm/types";
import type { MonthlyPlannerView, MonthlyWeekView, PlanDayView } from "@/lib/phoenix-crm/view-types";
import { PlanOutstationTrips } from "@/components/phoenix-crm/plan-outstation-trips";

/** How many left-out names show before "Show all". */
const LEFT_OUT_SHOWN = 12;

/** The four steps of a review, in the owner's order. */
export const REVIEW_STEP_LABELS = ["Week", "Day", "Customers", "Decide"] as const;

function nothing(): void {}

/** The day a review opens on: the first day with customers, else the first working day. */
function firstReviewDay(days: ReadonlyArray<PlanDayView>): PlanDayView {
  return days.find((day) => day.items.length > 0) ?? days.find((day) => day.listTypes.length > 0) ?? days[0];
}

/** "AM: Dr Hany, Dr Rania · PM: Al Salam Hospital" — the two lists apart, never one count. */
function itemsText(items: ReadonlyArray<SentItem>): string {
  return (["AM", "PM"] as const)
    .filter((listType) => items.some((item) => item.listType === listType))
    .map((listType) => `${listType}: ${items.filter((item) => item.listType === listType).map((item) => item.name ?? "A customer").join(", ")}`)
    .join(" · ");
}

function activitiesText(activities: ReadonlyArray<SentActivity>): string {
  return activities.map((activity) => `${dayActivityLabel(activity.activityType)} · ${activity.halfDay ? "half day" : "whole day"}`).join(", ");
}

export function PlanReviewSteps({
  busy,
  caps,
  customers,
  filterOptions,
  idPrefix,
  locked,
  onDecide,
  onOpenMonth,
  seatId,
  tints,
  view,
  week,
}: {
  /** The decision being sent on this week, if any. */
  busy: WeekBusy | null;
  caps: DailyCaps;
  customers: ReadonlyArray<PlannerCustomer>;
  filterOptions: {
    bricks: ReadonlyArray<{ value: string; label: string }>;
    grades: ReadonlyArray<PhoenixCrmGrade>;
    specialities: ReadonlyArray<string>;
    /** Polyclinics and centres customers are seated in; absent or empty hides the picker. */
    venues?: ReadonlyArray<{ value: string; label: string }>;
  };
  idPrefix: string;
  locked: boolean;
  /** The board's one way to decide a week; `day` names the ONE day returned, else null. */
  onDecide: (action: PlanDecisionAction, note: string, day: string | null) => Promise<boolean>;
  /** Opens another month on the board — a week a month opens with is counted on the month it belongs to. */
  onOpenMonth: (monthKey: string) => void;
  seatId: string;
  tints: ReadonlyMap<string, BrickTint>;
  view: MonthlyPlannerView;
  /** The week under review: sent, waiting for this reviewer's decision. */
  week: MonthlyWeekView;
}) {
  const [step, setStep] = useState(1);
  const [day, setDay] = useState<string | null>(null);
  const [session, setSession] = useState<PhoenixCrmDoctorListType>("AM");
  const topRef = useRef<HTMLDivElement>(null);

  const coverage = planReviewCoverage({
    weeks: view.weeks,
    reviewedWeekStart: week.weekStart,
    customers: view.customers,
    settings: { gradeTargets: view.rules.gradeTargets },
  });
  const changes = week.sentChanges;
  const changedDays = changedDaysOf(changes);
  const selectedDay = week.days.find((entry) => entry.date === day) ?? firstReviewDay(week.days);
  const dayIndex = week.days.findIndex((entry) => entry.date === selectedDay.date);
  // The next day that holds a list — a public holiday is skipped, the way a Friday is never in the week.
  const nextDay = week.days.slice(dayIndex + 1).find((entry) => entry.listTypes.length > 0) ?? null;
  const dayHasPm = selectedDay.listTypes.includes("PM") || selectedDay.items.some((item) => item.listType === "PM");
  const dayChange = changes?.kind === "compared" ? (changes.days.find((entry) => entry.date === selectedDay.date) ?? null) : null;
  const totals = week.days.reduce((sum, entry) => ({ AM: sum.AM + entry.counts.AM, PM: sum.PM + entry.counts.PM }), { AM: 0, PM: 0 });
  const plannedDays = week.days.filter((entry) => entry.counts.AM + entry.counts.PM > 0).length;
  const weekMonth = monthLabel(monthKeyOf(week.weekStart));

  /** A step, its top brought into view when he has scrolled past it. */
  function goStep(next: number) {
    setStep(next);
    window.requestAnimationFrame(() => {
      const top = topRef.current;
      if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
    });
  }

  /** A tap on a day moves him on to its customers, its AM list first. */
  function openDay(date: string) {
    setDay(date);
    setSession("AM");
    goStep(3);
  }

  const steps: ReadonlyArray<CrmStep> = [
    { label: REVIEW_STEP_LABELS[0], description: "Where it stands and its coverage", title: "Review the week" },
    { label: REVIEW_STEP_LABELS[1], description: "Its days, AM and PM", title: "Choose a day" },
    { label: REVIEW_STEP_LABELS[2], description: "Each day's AM, then PM", title: `${dayLabel(selectedDay.date)} · ${session} customers` },
    { label: REVIEW_STEP_LABELS[3], description: "Approve or return", title: "Your decision" },
  ];

  // The week panel's two read-only parts, as ELEMENTS built once per render (the board's own rule).
  const panelProps = {
    activities: [],
    busy,
    caps,
    changedDays,
    customers,
    dirty: false,
    gradeTargets: view.rules.gradeTargets,
    editable: false,
    filter: EMPTY_DOCTOR_FILTER,
    filterOptions,
    hold: null,
    idPrefix,
    items: [],
    locked,
    onActivity: nothing,
    onAskToEdit: nothing,
    onCopied: nothing,
    onDay: openDay,
    onDecide,
    onFilter: nothing,
    onKeepMine: nothing,
    onPlace: nothing,
    onQuery: nothing,
    onRemove: nothing,
    onSend: nothing,
    onShowLatest: nothing,
    onStarts: nothing,
    problems: [],
    query: "",
    reviewerSentence: "",
    seatId,
    selectedDay,
    showProblems: false,
    showSpread: true,
    starts: [],
    suggest: null,
    test: view.isTest,
    tints,
    today: view.cairoToday,
    viewerIsRep: false,
    week,
  };
  const daysPanel = <PlanWeekPanel {...panelProps} key={`days-${week.weekStart}`} section="days" />;
  const dayPanel = <PlanWeekPanel {...panelProps} key={`day-${week.weekStart}`} reviewList={session} section="day" />;

  const coverageBlock = (
    <ReviewCoverageBlock
      coverage={coverage}
      month={weekMonth}
      onOpenMonth={() => onOpenMonth(monthKeyOf(week.weekStart))}
    />
  );

  const facts: Array<{ label: string; value: string }> = [
    { label: "Rep", value: view.territory.repName ?? "No rep in this territory" },
    { label: "Due", value: week.dueOnLabel },
  ];
  if (week.plan?.submittedAt) {
    facts.push({
      label: "Sent for review",
      value: `${cairoStamp(week.plan.submittedAt)}${week.plan.submittedByName ? ` · ${week.plan.submittedByName}` : ""}`,
    });
  }

  const footer =
    step === 1 ? (
      <CrmStepFooter back={null}>
        <CrmStepNext onClick={() => goStep(2)} />
      </CrmStepFooter>
    ) : step === 2 ? (
      <CrmStepFooter back={() => goStep(1)}>
        <CrmStepNext onClick={() => openDay(selectedDay.date)}>Read {dayLabel(selectedDay.date)}</CrmStepNext>
      </CrmStepFooter>
    ) : step === 3 && session === "AM" && dayHasPm ? (
      <CrmStepFooter back={() => goStep(2)}>
        <CrmStepNext
          onClick={() => {
            setSession("PM");
            goStep(3);
          }}
        >
          Next: PM
        </CrmStepNext>
      </CrmStepFooter>
    ) : step === 3 ? (
      <CrmStepFooter
        back={() => {
          if (session === "PM") {
            setSession("AM");
            goStep(3);
          } else goStep(2);
        }}
      >
        {nextDay ? (
          <button className={crmStepBackClassName} onClick={() => openDay(nextDay.date)} type="button">
            Next day · {dayLabel(nextDay.date)}
            <ChevronRight aria-hidden className="h-4 w-4" />
          </button>
        ) : null}
        <CrmStepNext onClick={() => goStep(4)}>Decide</CrmStepNext>
      </CrmStepFooter>
    ) : (
      <CrmStepFooter back={() => goStep(3)} />
    );

  return (
    <div className="min-w-0 scroll-mt-24 border-t border-slate-100" data-plan-review="" ref={topRef}>
      <CrmStepForm
        aside="Nothing is approved or returned until you press its button."
        chip={weekLabel(week.weekStart)}
        footer={footer}
        onJump={goStep}
        step={step}
        steps={steps}
      >
        {step === 1 ? (
          <>
            {/* A business trip in this week (owner, 2026-11-07: "Trip on the CRM side"). */}
            <PlanOutstationTrips
              from={week.weekStart}
              to={week.days.at(-1)?.date ?? week.weekStart}
              trips={view.outstationTrips}
            />
            <CrmBlock
              actions={
                <span className="flex max-w-full flex-wrap gap-1">
                  <CrmPill tone={PLAN_STATUS_TONE[week.status ?? "none"]}>{week.statusLabel}</CrmPill>
                  {week.plan?.submittedLate ? <CrmPill tone="warn">Sent late</CrmPill> : null}
                </span>
              }
              className="border-l-4 border-l-orange-500"
              title={week.label}
            >
              <p className="break-words text-lg font-black leading-tight text-slate-950">{weekLabel(week.weekStart)}</p>
              <p className="mt-1 break-words text-sm font-bold text-slate-700">
                {countText(totals.AM)} AM · {countText(totals.PM)} PM placed · {plural(plannedDays, "day", "days")} planned
              </p>
              <div className="mt-3">
                <CrmFacts facts={facts} />
              </div>
              {week.leadingNote ? (
                <CrmNote className="mt-3" tone="info">
                  {week.leadingNote}
                </CrmNote>
              ) : null}
            </CrmBlock>
            <SentChangesBlock changes={changes} onOpenDay={openDay} />
            {coverageBlock}
          </>
        ) : step === 2 ? (
          daysPanel
        ) : step === 3 ? (
          <>
            {dayChange ? (
              <CrmBlock className="border-t border-slate-100">
                <CrmNote title="Changed since the last send" tone="info">
                  <DayChangeLines change={dayChange} />
                </CrmNote>
              </CrmBlock>
            ) : null}
            {dayPanel}
          </>
        ) : (
          <>
            <CrmBlock>
              <p className="break-words text-sm font-bold text-slate-700">
                {weekLabel(week.weekStart)} · {countText(totals.AM)} AM · {countText(totals.PM)} PM placed · {plural(plannedDays, "day", "days")} planned
              </p>
            </CrmBlock>
            {coverageBlock}
            <PlanDecision
              approved={false}
              busy={decisionBusy(busy)}
              canApprove={week.canApprove}
              canReturn={week.canReturn}
              idPrefix={`${idPrefix}-review-${week.weekStart}`}
              key={`${week.plan?.planId ?? "none"}|${week.plan?.version ?? 0}`}
              locked={locked}
              onDecide={onDecide}
              returnDays={week.canReturn ? returnableDays(week.days, view.cairoToday).map((entry) => entry.date) : undefined}
              subject="week"
            />
          </>
        )}
      </CrmStepForm>
    </div>
  );
}

// ── What changed since the last send ────────────────────────────────────────────────────────────

function DayChangeLines({ change }: { change: SentDayChange }) {
  return (
    <span className="grid min-w-0 gap-1">
      {change.added.length > 0 ? (
        <span className="block break-words">
          <span className="font-black text-emerald-800">Added {countText(change.added.length)}</span> · {itemsText(change.added)}
        </span>
      ) : null}
      {change.removed.length > 0 ? (
        <span className="block break-words">
          <span className="font-black text-rose-800">Removed {countText(change.removed.length)}</span> · {itemsText(change.removed)}
        </span>
      ) : null}
      {change.activitiesAdded.length > 0 ? (
        <span className="block break-words">
          <span className="font-black text-slate-900">Activity added</span> · {activitiesText(change.activitiesAdded)}
        </span>
      ) : null}
      {change.activitiesRemoved.length > 0 ? (
        <span className="block break-words">
          <span className="font-black text-slate-900">Activity taken off</span> · {activitiesText(change.activitiesRemoved)}
        </span>
      ) : null}
    </span>
  );
}

/**
 * What changed against the version sent before (owner, 2026-10-02): a week that comes back after a
 * return or an acknowledged edit is read for its changes, day by day — a tap on a day opens it.
 */
function SentChangesBlock({ changes, onOpenDay }: { changes: PlanSentChanges | null; onOpenDay: (date: string) => void }) {
  if (!changes) return null;
  if (changes.kind === "first") {
    return (
      <CrmBlock className="border-t border-slate-100" title="What changed">
        <p className="break-words text-sm font-medium leading-6 text-slate-600">This is the first time this week is sent, so there is no earlier version to compare it with.</p>
      </CrmBlock>
    );
  }
  const since = changes.previousSentAt ? ` on ${cairoStamp(changes.previousSentAt)}` : "";
  if (changes.kind === "unknown") {
    return (
      <CrmBlock className="border-t border-slate-100" title="What changed">
        <CrmNote tone="neutral">
          This week was sent before{since}, but that send was made before Phoenix kept a copy of each send, so what changed cannot be shown. Read
          every day.
        </CrmNote>
      </CrmBlock>
    );
  }
  if (changes.days.length === 0) {
    return (
      <CrmBlock className="border-t border-slate-100" title="What changed">
        <CrmNote title="Nothing changed since the last send" tone="good">
          The rep sent the same customers and activities as they sent{since}.
        </CrmNote>
      </CrmBlock>
    );
  }
  return (
    <CrmBlock className="border-t border-slate-100" title={`What changed since the last send${since}`}>
      <ul className="grid min-w-0 gap-2">
        {changes.days.map((change) => (
          <li className="min-w-0 border border-l-[3px] border-slate-200 border-l-sky-500 bg-white px-3.5 py-3 text-sm leading-6" key={change.date}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <p className="break-words font-black text-slate-950">{dayLabel(change.date)}</p>
              <CrmButton onClick={() => onOpenDay(change.date)} size="sm">
                Open the day
              </CrmButton>
            </div>
            <div className="mt-1 min-w-0 font-medium text-slate-700">
              <DayChangeLines change={change} />
            </div>
          </li>
        ))}
      </ul>
    </CrmBlock>
  );
}

// ── Coverage on the review ──────────────────────────────────────────────────────────────────────

/**
 * Validated customers only, per list and grade: the month's target visits the sent weeks — this one
 * included — cover, and who is left out of the month so far. Neutral figures: nobody has set a level
 * that counts as good.
 */
function ReviewCoverageBlock({ coverage, month, onOpenMonth }: { coverage: ReviewCoverage | null; month: string; onOpenMonth: () => void }) {
  if (coverage === null) {
    return (
      <CrmBlock className="border-t border-slate-100" title="Coverage this month">
        <CrmNote tone="info">
          <span className="block">This week belongs to {month}, so its coverage is counted with the weeks of {month}.</span>
          <span className="mt-2 block">
            <CrmButton onClick={onOpenMonth} size="sm">
              Open {month}
            </CrmButton>
          </span>
        </CrmNote>
      </CrmBlock>
    );
  }
  if (coverage.validated === 0) {
    return (
      <CrmBlock className="border-t border-slate-100" title="Coverage this month">
        <CrmNote title="No validated customers yet" tone="info">
          Coverage starts as customers are validated at the door. Every customer on this list is still waiting for that, so there is nothing to count
          yet.
        </CrmNote>
      </CrmBlock>
    );
  }
  return (
    <CrmBlock className="border-t border-slate-100" title="Coverage this month">
      <p className="break-words text-sm font-medium leading-6 text-slate-600">
        Validated customers only. Counts every day of {month} already sent or approved, and this week.
      </p>
      {(["AM", "PM"] as const).map((listType) => {
        const list = coverage.lists[listType];
        return (
          <div className="mt-4 min-w-0" key={listType}>
            <p className="break-words text-sm font-black text-slate-950">
              {listType} · {plural(list.validated, "validated customer", "validated customers")}
            </p>
            {list.validated === 0 ? (
              <p className="mt-1 break-words text-sm font-medium text-slate-500">No {listType} customer is validated yet.</p>
            ) : (
              <>
                <CrmStatGrid className="mt-2">
                  {list.grades.map((row) => (
                    <CrmStat
                      key={row.grade}
                      label={`${listType} · Grade ${row.grade}`}
                      note={
                        row.customers === 0
                          ? `No validated grade ${row.grade} customer`
                          : row.targetVisits === null
                            ? `No target set for grade ${row.grade} · ${plural(row.customers, "customer", "customers")}`
                            : `${percentText(row.coveragePct)} of the target visits · ${plural(row.customers, "customer", "customers")}`
                      }
                      value={row.customers === 0 || row.targetVisits === null ? "—" : `${countText(row.coveredVisits)} of ${countText(row.targetVisits)}`}
                    />
                  ))}
                  <CrmStat
                    label={`${listType} · Left out`}
                    note="Validated, on no sent day this month"
                    tone={list.leftOut.length > 0 ? "warn" : "neutral"}
                    value={countText(list.leftOut.length)}
                  />
                </CrmStatGrid>
                {list.ungraded > 0 ? (
                  <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
                    {plural(list.ungraded, "validated customer has", "validated customers have")} no grade, so no target to count.
                  </p>
                ) : null}
                <LeftOutNames entries={list.leftOut} listType={listType} month={month} />
              </>
            )}
          </div>
        );
      })}
    </CrmBlock>
  );
}

function LeftOutNames({ entries, listType, month }: { entries: ReadonlyArray<ReviewLeftOut>; listType: PhoenixCrmDoctorListType; month: string }) {
  const [all, setAll] = useState(false);
  if (entries.length === 0) {
    return <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">Every validated {listType} customer is on a sent day of {month}.</p>;
  }
  const shown = all ? entries : entries.slice(0, LEFT_OUT_SHOWN);
  return (
    <div className="mt-2 min-w-0">
      <p className="break-words text-phx-sm font-black uppercase tracking-[0.14em] text-slate-500">
        {listType} left out of {month} so far
      </p>
      <ul className="mt-1.5 flex min-w-0 flex-wrap gap-1.5">
        {shown.map((entry) => (
          <li className="min-w-0 max-w-full break-words border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-bold text-slate-700" key={entry.customerId}>
            {entry.name}
            {entry.grade ? ` · Grade ${entry.grade}` : " · No grade"}
          </li>
        ))}
      </ul>
      {entries.length > shown.length ? (
        <span className="mt-2 block">
          <CrmButton onClick={() => setAll(true)} size="sm">
            Show all {countText(entries.length)}
          </CrmButton>
        </span>
      ) : null}
    </div>
  );
}
