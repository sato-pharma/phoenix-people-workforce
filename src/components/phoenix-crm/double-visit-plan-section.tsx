"use client";

/**
 * Phoenix CRM — the Team tab's "Double visits": the district manager's own plan of which rep he joins
 * on which day, AM or PM, and after the day how it went (owner, 2026-10-02).
 *
 * 🔴 THE REP NEVER SEES IT (owner, 2026-10-02: "Rep does not see it"). This section lives in the Team
 * tab only — never on a rep's Plan, his Today or any notice — and the route refuses him
 * (server/double-visit-plans.ts). The district manager plans his own; the SFE Manager and the Super
 * Admin choose a district manager and read his week, and the Super Admin tries the writing in test
 * mode only.
 *
 * One half-day saves on its own, the moment a rep is chosen, so there is nothing unsaved to lose when
 * he moves to another section. The screen sends the rep it showed for that half-day, so a change made
 * on another screen first is refused rather than written over.
 */

import { useState } from "react";
import { ArrowLeft } from "lucide-react";

import { crmPost, crmUrl, errorCodeOf, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { countText, dayLabel, weekLabel } from "@/components/phoenix-crm/format";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmChoice,
  CrmEmpty,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPill,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import {
  defaultDoubleVisitWeek,
  doubleVisitWeekName,
  doubleVisitWeeks,
  type DoubleVisitHalf,
  type DoubleVisitOutcome,
} from "@/lib/phoenix-crm/double-visit-plan-rules";
import type {
  DoubleVisitDayView,
  DoubleVisitManagerOption,
  DoubleVisitPlanView,
  DoubleVisitRepOption,
  DoubleVisitSlotView,
} from "@/lib/phoenix-crm/view-types";

const OUTCOME: Record<DoubleVisitOutcome, { label: string; tone: PillTone }> = {
  done: { label: "Done", tone: "good" },
  not_done: { label: "Not done", tone: "bad" },
  // The day's visits have not closed yet (02:00 Cairo the next morning): nothing is judged before then.
  open: { label: "Not yet", tone: "neutral" },
  ahead: { label: "Planned", tone: "info" },
};

function slotKey(date: string, half: DoubleVisitHalf): string {
  return `${date}|${half}`;
}

function managerAccent(manager: DoubleVisitManagerOption): string {
  if (manager.planned === 0) return "border-l-slate-300";
  return manager.done >= manager.planned ? "border-l-emerald-500" : "border-l-amber-500";
}

function introText(view: DoubleVisitPlanView): string {
  if (view.mode === "own") {
    const done =
      "A half-day you planned reads Done once a visit you made with that rep that half-day is saved, counted the way Reports counts double visits.";
    return view.canWrite
      ? `Choose the rep you join for each half-day: this week from today on, and the coming week. A day that has passed stays as you planned it. ${done} Your reps do not see this plan.`
      : `${done} Your reps do not see this plan.`;
  }
  const done =
    "A planned half-day reads Done once a visit they made with that rep that half-day is saved, counted the way Reports counts double visits.";
  if (view.canWrite) return `Test mode: you plan as this district manager, on test entries only. Nobody is notified. ${done}`;
  return `Read only: each district manager plans their own double visits. ${done} The reps do not see these plans.`;
}

export function DoubleVisitPlanSection({ cairoToday, test }: { cairoToday: string; test: boolean }) {
  const [week, setWeek] = useState<string | null>(null);
  const [manager, setManager] = useState<string | null>(null);
  const plan = useCrmGet<DoubleVisitPlanView>(crmUrl("/api/phoenix-crm/double-visit-plans", { test, week, manager }), "plan");
  const [choosing, setChoosing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ key: string; message: string } | null>(null);

  const view = plan.data;

  function reset() {
    setChoosing(null);
    setProblem(null);
  }

  function chooseWeek(next: string) {
    reset();
    setWeek(next);
  }

  function openManager(next: string | null) {
    reset();
    setManager(next);
  }

  async function save(day: DoubleVisitDayView, slot: DoubleVisitSlotView, seatId: string | null) {
    if (!view) return;
    const key = slotKey(day.date, slot.half);
    if (seatId === slot.seatId) {
      setChoosing(null);
      return;
    }
    setBusy(key);
    setProblem(null);
    try {
      const next = await crmPost<DoubleVisitPlanView>(
        "/api/phoenix-crm/double-visit-plans",
        {
          test,
          // Whose plan: the Super Admin's test mode names the district manager he is trying it as. A
          // district manager's own plan needs no name — the server writes his, and only his.
          manager: view.mode === "pick" ? (view.manager?.hrId ?? null) : null,
          date: day.date,
          half: slot.half,
          seatId,
          expectedSeatId: slot.seatId,
        },
        "plan",
      );
      setChoosing(null);
      plan.replace(next);
    } catch (error) {
      setProblem({ key, message: messageOf(error) });
      // Another screen changed this half-day first: read the week again so he chooses against it.
      if (errorCodeOf(error) === "phoenix_crm_double_visit_changed") plan.reload();
    } finally {
      setBusy(null);
    }
  }

  // The weeks stay on screen while a week loads: changing the week reads a new view, which shows
  // nothing of the old one until it arrives.
  const fallbackWeeks = doubleVisitWeeks(cairoToday).map((entry) => ({ weekStart: entry, name: doubleVisitWeekName(entry, cairoToday) }));
  const weeks = view?.weeks ?? fallbackWeeks;
  const selectedWeek = view?.weekStart ?? week ?? defaultDoubleVisitWeek(cairoToday);
  const weekBlock = (
    <CrmBlock className="border-t border-slate-100" title="Week">
      <CrmChoice
        columns={3}
        label="Week"
        onChange={chooseWeek}
        options={weeks.map((entry) => ({ value: entry.weekStart, label: entry.name, note: weekLabel(entry.weekStart) }))}
        value={selectedWeek}
      />
    </CrmBlock>
  );
  const backToManagers =
    manager !== null ? (
      <CrmBlock className="border-t border-slate-100">
        <CrmButton onClick={() => openManager(null)} size="sm" variant="ghost">
          <ArrowLeft aria-hidden className="h-4 w-4" />
          All district managers
        </CrmButton>
      </CrmBlock>
    ) : null;

  if (!view) {
    return (
      <>
        {weekBlock}
        {backToManagers}
        <div className="border-t border-slate-100">
          {plan.error ? <CrmLoadError message={plan.error} onRetry={plan.reload} /> : <CrmLoading label="Loading the double visits" />}
        </div>
      </>
    );
  }

  // SFE and the Super Admin, before choosing whose plan to read.
  if (view.mode === "pick" && !view.manager) {
    const managers = view.managers ?? [];
    return (
      <>
        {weekBlock}
        {plan.error ? <CrmLoadError message={plan.error} onRetry={plan.reload} /> : null}
        <CrmBlock className="border-t border-slate-100" title={`District managers · ${countText(managers.length)}`}>
          <p className="break-words text-sm font-medium leading-6 text-slate-600">
            Each district manager plans which of their reps they join, on which day, AM or PM. Open one to read their week against what happened.
            The reps do not see these plans.
          </p>
        </CrmBlock>
        {managers.length === 0 ? (
          <div className="border-t border-slate-100">
            <CrmEmpty message="A district manager shows here once their line opens in Phoenix CRM." title="No district managers to show" />
          </div>
        ) : (
          <div className="divide-y divide-slate-100 border-t border-slate-100">
            {managers.map((entry) => (
              <CrmCard
                accent={managerAccent(entry)}
                actions={
                  <CrmButton onClick={() => openManager(entry.hrId)} size="sm">
                    Open the plan
                  </CrmButton>
                }
                key={entry.hrId}
                meta={entry.place}
                title={entry.name}
              >
                <p className="break-words text-sm font-black text-slate-800">
                  Planned {countText(entry.planned)} · done {countText(entry.done)}
                </p>
              </CrmCard>
            ))}
          </div>
        )}
      </>
    );
  }

  const anyEditable = view.days.some((day) => day.editable);
  const notDone = view.summary.notDone > 0 ? ` · ${countText(view.summary.notDone)} not done` : "";
  const title = view.mode === "own" ? "Your double visits" : [view.manager?.name ?? "District manager", view.manager?.place].filter(Boolean).join(" · ");

  return (
    <>
      {weekBlock}
      {backToManagers}
      {plan.error ? <CrmLoadError message={plan.error} onRetry={plan.reload} /> : null}
      <CrmBlock className="border-t border-slate-100" title={title}>
        <p className="break-words text-base font-black text-slate-950">
          {view.summaryText}
          {notDone}
        </p>
        <p className="mt-1 break-words text-sm font-medium leading-6 text-slate-600">{introText(view)}</p>
        {anyEditable && view.reps.length === 0 ? (
          <CrmNote className="mt-3" tone="info" title="No rep to plan with yet">
            A double visit is planned with a rep of the team. Every territory beneath this district manager is without a rep for now.
          </CrmNote>
        ) : null}
      </CrmBlock>

      {view.summary.planned === 0 && !anyEditable ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Nothing was planned for this week." title="No double visit planned" />
        </div>
      ) : (
        <div className="divide-y divide-slate-100 border-t border-slate-100">
          {view.days.map((day) => (
            <DayBlock
              busy={busy}
              choosing={choosing}
              day={day}
              key={day.date}
              onSave={(slot, seatId) => void save(day, slot, seatId)}
              onToggle={(slot) => {
                const key = slotKey(day.date, slot.half);
                setProblem(null);
                setChoosing((current) => (current === key ? null : key));
              }}
              problem={problem}
              reps={view.reps}
            />
          ))}
        </div>
      )}
    </>
  );
}

function DayBlock({
  busy,
  choosing,
  day,
  onSave,
  onToggle,
  problem,
  reps,
}: {
  busy: string | null;
  choosing: string | null;
  day: DoubleVisitDayView;
  onSave: (slot: DoubleVisitSlotView, seatId: string | null) => void;
  onToggle: (slot: DoubleVisitSlotView) => void;
  problem: { key: string; message: string } | null;
  reps: ReadonlyArray<DoubleVisitRepOption>;
}) {
  return (
    <section className="min-w-0 px-4 py-3.5 sm:px-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h4 className="break-words text-sm font-black text-slate-950">{dayLabel(day.date)}</h4>
        {day.holiday ? <CrmPill tone="neutral">Public holiday</CrmPill> : null}
      </div>
      {day.holiday ? (
        <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-500">{day.holiday}: a day off, so no double visit is planned on it.</p>
      ) : null}
      {day.slots.length > 0 ? (
        <div className="mt-2 grid min-w-0 gap-3">
          {day.slots.map((slot) => {
            const key = slotKey(day.date, slot.half);
            return (
              <SlotRow
                busy={busy === key}
                choosing={choosing === key}
                day={day}
                key={slot.half}
                locked={busy !== null}
                onSave={(seatId) => onSave(slot, seatId)}
                onToggle={() => onToggle(slot)}
                problem={problem?.key === key ? problem.message : null}
                reps={reps}
                slot={slot}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function SlotRow({
  busy,
  choosing,
  day,
  locked,
  onSave,
  onToggle,
  problem,
  reps,
  slot,
}: {
  busy: boolean;
  choosing: boolean;
  day: DoubleVisitDayView;
  /** Another half-day is saving: one save at a time. */
  locked: boolean;
  onSave: (seatId: string | null) => void;
  onToggle: () => void;
  problem: string | null;
  reps: ReadonlyArray<DoubleVisitRepOption>;
  slot: DoubleVisitSlotView;
}) {
  // A half the day still holds can take a rep; one planned before the day became a holiday can only be cleared.
  const canPick = day.editable && day.halves.includes(slot.half) && reps.length > 0;
  const canClear = day.editable && slot.seatId !== null;
  const outcome = slot.outcome ? OUTCOME[slot.outcome] : null;
  return (
    <div className="grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] gap-x-2">
      <p className="pt-0.5 text-xs font-black uppercase tracking-[0.12em] text-slate-500">{slot.half}</p>
      <div className="min-w-0">
        {slot.seatId ? (
          <>
            <p className="break-words text-sm font-black text-slate-900">{slot.repName}</p>
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">{slot.territoryName}</p>
          </>
        ) : (
          <p className="break-words text-sm font-semibold text-slate-500">No double visit</p>
        )}
        {outcome ? (
          <div className="mt-1 flex flex-wrap gap-1">
            <CrmPill tone={outcome.tone}>{outcome.label}</CrmPill>
          </div>
        ) : null}
        {canPick || canClear ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {canPick ? (
              <CrmButton busy={busy} disabled={locked} onClick={onToggle} size="sm">
                {choosing ? "Close" : slot.seatId ? "Change the rep" : "Choose the rep"}
              </CrmButton>
            ) : null}
            {canClear ? (
              <CrmButton disabled={locked} onClick={() => onSave(null)} size="sm" variant="ghost">
                Remove
              </CrmButton>
            ) : null}
          </div>
        ) : null}
        {choosing && canPick ? (
          <div className="mt-2">
            <CrmChoice
              columns={2}
              label={`The rep you join on ${dayLabel(day.date)}, ${slot.half}`}
              onChange={(seatId) => onSave(seatId)}
              options={reps.map((rep) => ({ value: rep.seatId, label: rep.repName, note: rep.territoryName, disabled: locked }))}
              value={slot.seatId}
            />
          </div>
        ) : null}
        {problem ? (
          <CrmNote className="mt-2" title="Not saved" tone="bad">
            {problem}
          </CrmNote>
        ) : null}
      </div>
    </div>
  );
}
