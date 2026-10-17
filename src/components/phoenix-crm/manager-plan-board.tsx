"use client";

/**
 * Phoenix CRM — a manager's weekly plan (owner, 2026-10-16: "exactly like the numbered form that the
 * medical reps use", inverted — his reps appear with the bricks they visit that day). Planned by a
 * district manager, and since 2026-10-17 by the regional manager, the national sales managers and the
 * product managers too ("the only one step extra is that he choose before his scope").
 *
 * The same step form as the rep's plan (step-form.tsx): Week → Day → What I do → Send. Each half-day is
 * exactly ONE of three things, AM and PM each its own choice:
 *   - WITH A REP: the reps, each with where the rep is going that half-day; he picks one, then ticks some
 *     of that rep's customers or presses Mark all. A rep's draft customers show, marked Not sent; a rep
 *     with no plan at all is skipped.
 *   - ADMIN: one of the seven day activities, and a note — plus Office for everyone but a district manager.
 *   - SINGLE VISIT: an area of the district, then customers from that area's rep lists, from Manager's own
 *     list, or a new one he types (an existing name is offered first).
 *
 * 🔴 THE EXTRA STEP — a regional, national or product manager first chooses the DISTRICT MANAGER, and the
 * reps and areas shown are that district manager's. Once per day by default; "Another district manager for
 * this half" picks one for a single half-day (owner, 2026-10-17: "once per day by default but have the
 * option to half-day when choosing area"). A product manager chooses the line first — Pedia or Anti
 * Infective — and may skip the district manager altogether: "Any rep in <line>". A district manager plans
 * his own district and sees no picker.
 *
 * 🔴 TICKING A REP IS NOT A DOUBLE VISIT. The double visit is counted only when the REP logs it and names
 * him; this plan is what he intends, read against what happened in the "Manager plans" report.
 *
 * 🔴 THE REP NEVER SEES ANY OF IT — no screen, no notice. A district manager's week is sent to his RSM or
 * NSM, and after a regional manager approves it always goes on to the NSM above him; everyone else's goes
 * to the same people who approve their legacy plan today, and HR then acknowledges it by itself. All of it
 * is decided in the Approvals Hub (Approve, Return the week, Return one day).
 *
 * One half-day saves itself about 1.5 seconds after his last change, like the rep's board — the same
 * version check, so a change made on another screen first is refused rather than written over, and his
 * edit stays on the page until he chooses again. A half-day still missing something says what and waits.
 */

import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";

import { crmPost, crmUrl, errorCodeOf, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { countText, plural } from "@/components/phoenix-crm/format";
import { ManagerCustomerForm } from "@/components/phoenix-crm/manager-customer-form";
import { CrmStepFooter, CrmStepForm, CrmStepNext, type CrmStep } from "@/components/phoenix-crm/step-form";
import {
  CrmBlock,
  CrmButton,
  CrmCheck,
  CrmChoice,
  CrmEmpty,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSearchField,
  CrmShowMore,
  crmTextareaClassName,
  type CrmChoiceOption,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import {
  DM_SINGLE_VISIT_HALF_DAYS_MAX,
  MANAGER_PLAN_NOTE_MAX,
  MANAGER_PLAN_REASON_MAX,
  MANAGER_SLOT_CUSTOMER_MAX,
  MANAGER_SLOT_KINDS,
  type ManagerHalf,
  type ManagerSlotKind,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { PLAN_AUTOSAVE_DELAY_MS } from "@/lib/phoenix-crm/plan-week-draft";
import type {
  AreaCustomersView,
  CustomerMatch,
  ManagerBoardDay,
  ManagerBoardRepHalf,
  ManagerBoardScope,
  ManagerBoardSlot,
  ManagerCustomerView,
  ManagerPlanBoardView,
  ManagerPlanTransitionResult,
} from "@/lib/phoenix-crm/view-types";

const BOARD = "/api/phoenix-crm/manager-plans";
const AREA = "/api/phoenix-crm/manager-plans/customers/area";
/** A single visit's area list is shown a page at a time. */
const AREA_PAGE = 40;

const STEPS: ReadonlyArray<CrmStep> = [
  { label: "Week", description: "Which week you plan", title: "Choose the week" },
  { label: "Day", description: "Saturday to Thursday", title: "Choose the day" },
  { label: "What I do", description: "AM, then PM", title: "What you do that day" },
  { label: "Send", description: "To your manager", title: "Send your week" },
];

// ── One half-day, as he edits it ────────────────────────────────────────────────────────────────

type CustomerRef = { key: string; customerId: string | null; managerCustomerId: string | null; name: string };

type HalfDraft = {
  kind: ManagerSlotKind | null;
  /**
   * The district manager the half-day is planned with — "dm:<seat>", or a product manager's whole line,
   * "line:<code>". A regional, national or product manager's With a rep and Single visit only; null for a
   * district manager's own district and for Admin.
   */
  scope: string | null;
  repSeatId: string | null;
  activityType: string | null;
  areaSeatId: string | null;
  note: string;
  customers: CustomerRef[];
};

function emptyDraft(): HalfDraft {
  return { kind: null, scope: null, repSeatId: null, activityType: null, areaSeatId: null, note: "", customers: [] };
}

function halfKey(date: string, half: ManagerHalf): string {
  return `${date}|${half}`;
}

function repRef(customerId: string, name: string): CustomerRef {
  return { key: `c:${customerId}`, customerId, managerCustomerId: null, name };
}

function ownRef(managerCustomerId: string, name: string): CustomerRef {
  return { key: `m:${managerCustomerId}`, customerId: null, managerCustomerId, name };
}

/** A half-day that names a district: with a rep, or single visits in one of its areas. */
function namesADistrict(kind: ManagerSlotKind | null): boolean {
  return kind === "with_rep" || kind === "single_visit";
}

function draftFromSlot(slot: ManagerBoardSlot | undefined): HalfDraft {
  return {
    kind: slot?.kind ?? null,
    scope: slot?.scopeKey ?? null,
    repSeatId: slot?.repSeatId ?? null,
    activityType: slot?.activityType ?? null,
    areaSeatId: slot?.areaSeatId ?? null,
    note: slot?.note ?? "",
    customers: (slot?.customers ?? []).map((customer) =>
      customer.customerId ? repRef(customer.customerId, customer.name) : ownRef(customer.managerCustomerId ?? "", customer.name),
    ),
  };
}

/** A regional, national or product manager: the planner who chooses a district manager first. */
function choosesADistrict(view: ManagerPlanBoardView | null): boolean {
  return Boolean(view?.writer && view.writer.kind !== "dm");
}

/** What a half-day still lacks before it can be saved, or null when it can. */
function draftProblem(draft: HalfDraft, choosesDistrict: boolean): string | null {
  if (choosesDistrict && namesADistrict(draft.kind) && !draft.scope) return "choose the district manager";
  if (draft.kind === "with_rep") {
    if (!draft.repSeatId) return "choose the rep you go with";
    if (draft.customers.length === 0) return "tick at least one of the rep's customers";
  }
  if (draft.kind === "admin" && !draft.activityType) return "choose the activity";
  if (draft.kind === "single_visit") {
    if (!draft.areaSeatId) return "choose the area";
    if (draft.customers.length === 0) return "choose at least one customer";
  }
  if (draft.customers.length > MANAGER_SLOT_CUSTOMER_MAX) return `keep it to ${MANAGER_SLOT_CUSTOMER_MAX} customers`;
  return null;
}

/** The scope the server is told: the district manager's seat and its line, or a whole line. */
function scopeFields(key: string | null, scopes: ReadonlyArray<ManagerBoardScope>): { scopeDmSeatId: string | null; scopeLineCode: string | null } {
  const found = key ? scopes.find((scope) => scope.key === key) : undefined;
  return found ? { scopeDmSeatId: found.dmSeatId, scopeLineCode: found.lineCode } : { scopeDmSeatId: null, scopeLineCode: null };
}

function draftPayload(date: string, half: ManagerHalf, draft: HalfDraft, scopes: ReadonlyArray<ManagerBoardScope>) {
  return {
    date,
    half,
    kind: draft.kind,
    repSeatId: draft.kind === "with_rep" ? draft.repSeatId : null,
    activityType: draft.kind === "admin" ? draft.activityType : null,
    areaSeatId: draft.kind === "single_visit" ? draft.areaSeatId : null,
    ...scopeFields(namesADistrict(draft.kind) ? draft.scope : null, scopes),
    note: draft.note.trim() || null,
    customers:
      draft.kind === "admin" || draft.kind === null
        ? []
        : draft.customers.map((customer) => (customer.customerId ? { customerId: customer.customerId } : { managerCustomerId: customer.managerCustomerId })),
  };
}

function sameDraft(left: HalfDraft, right: HalfDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

const REP_WEEK: Record<ManagerBoardRepHalf["weekState"], { label: string; tone: PillTone }> = {
  sent: { label: "Sent", tone: "good" },
  not_sent: { label: "Not sent", tone: "warn" },
  no_plan: { label: "No plan", tone: "neutral" },
};

// ── The board ───────────────────────────────────────────────────────────────────────────────────

export function ManagerPlanBoard({
  onChanged,
  onDirtyChange,
  test,
}: {
  /** The week was sent: the page's counts read again. */
  onChanged?: () => void;
  /** Half-days not saved yet: the page asks before it lets them go. */
  onDirtyChange?: (dirty: boolean) => void;
  test: boolean;
}) {
  const idPrefix = useId();
  const [week, setWeek] = useState<string | null>(null);
  // The district manager whose reps and areas the board carries — a regional, national or product
  // manager's only. A new one is a new address, so the board it was chosen FROM stays on screen while it
  // loads (the Team tab's pickers do the same), never a spinner over the whole week; a different week is
  // never held over.
  const [scopeKey, setScopeKey] = useState<string | null>(null);
  const [chosenFrom, setChosenFrom] = useState<ManagerPlanBoardView | null>(null);
  const board = useCrmGet<ManagerPlanBoardView>(crmUrl(BOARD, { week, scope: scopeKey, test }), "board");
  const view = board.data ?? (chosenFrom && (week === null || chosenFrom.weekStart === week) ? chosenFrom : null);
  const [step, setStep] = useState(1);
  const [date, setDate] = useState<string | null>(null);
  const [half, setHalf] = useState<ManagerHalf>("AM");
  const [drafts, setDrafts] = useState<Record<string, HalfDraft>>({});
  /** The district manager he chose for a whole day; a half-day may still name another. */
  const [dayScopes, setDayScopes] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  const saving = useRef(false);
  // The board a save is checked against — the one on screen, or the one the last save answered with.
  const viewRef = useRef<ManagerPlanBoardView | null>(null);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // The scope on screen, read by a save that finishes after he moved on.
  const scopeRef = useRef<string | null>(null);
  useEffect(() => {
    scopeRef.current = scopeKey;
  }, [scopeKey]);

  const pending = Object.keys(drafts);
  useEffect(() => {
    onDirtyChange?.(pending.length > 0);
  }, [pending.length, onDirtyChange]);

  const choosesDistrict = choosesADistrict(view);
  const days = view?.days ?? [];
  const day: ManagerBoardDay | null = days.find((entry) => entry.date === date) ?? days.find((entry) => entry.editable) ?? days[0] ?? null;
  const dayHalves = day?.halves ?? [];
  const currentHalf: ManagerHalf = dayHalves.includes(half) ? half : (dayHalves[0] ?? "AM");
  const slot = day?.slots.find((entry) => entry.half === currentHalf);
  const key = day ? halfKey(day.date, currentHalf) : null;
  const draft = key ? (drafts[key] ?? draftFromSlot(slot)) : draftFromSlot(undefined);
  const canEdit = Boolean(view?.canWrite && day?.editable);

  function draftOf(target: ManagerBoardDay, targetHalf: ManagerHalf): HalfDraft {
    return drafts[halfKey(target.date, targetHalf)] ?? draftFromSlot(target.slots.find((entry) => entry.half === targetHalf));
  }

  /** The district manager of a day: the one he chose for it, else the first one a half-day of it names. */
  function dayScopeOf(target: ManagerBoardDay): string | null {
    const chosen = dayScopes[target.date];
    if (chosen) return chosen;
    for (const entry of target.halves) {
      const halfDraft = draftOf(target, entry);
      if (namesADistrict(halfDraft.kind) && halfDraft.scope) return halfDraft.scope;
    }
    return null;
  }

  /** The district manager a half-day shows: its own, or the day's. */
  function halfScopeOf(target: ManagerBoardDay, targetHalf: ManagerHalf): string | null {
    if (!choosesDistrict) return null;
    const halfDraft = draftOf(target, targetHalf);
    return namesADistrict(halfDraft.kind) && halfDraft.scope ? halfDraft.scope : dayScopeOf(target);
  }

  /** Loads another district manager's reps and areas, keeping this board on screen meanwhile. */
  function showScope(next: string | null) {
    if (!next || next === scopeKey) return;
    if (view) setChosenFrom(view);
    setScopeKey(next);
  }

  function edit(next: HalfDraft) {
    if (!key || !canEdit) return;
    setDrafts((previous) => ({ ...previous, [key]: next }));
    setSaveState({ kind: "idle" });
  }

  /**
   * The district manager for the whole day. A half-day of it with nothing chosen yet follows; one that
   * already holds a rep, an area or customers keeps its own, and says so.
   */
  function chooseDayScope(next: string) {
    if (!day || !canEdit) return;
    setDayScopes((previous) => ({ ...previous, [day.date]: next }));
    const moved: Record<string, HalfDraft> = {};
    let shown = next;
    for (const entry of day.halves) {
      const halfDraft = draftOf(day, entry);
      if (!namesADistrict(halfDraft.kind) || halfDraft.scope === next) continue;
      const untouched = !halfDraft.repSeatId && !halfDraft.areaSeatId && halfDraft.customers.length === 0;
      if (untouched) moved[halfKey(day.date, entry)] = { ...halfDraft, scope: next };
      else if (entry === currentHalf && halfDraft.scope) shown = halfDraft.scope;
    }
    if (Object.keys(moved).length > 0) {
      setDrafts((previous) => ({ ...previous, ...moved }));
      setSaveState({ kind: "idle" });
    }
    showScope(shown);
  }

  /** Another district manager for this half-day only; what was chosen under the old one is cleared. */
  function chooseHalfScope(next: string) {
    if (!day) return;
    const dayScope = dayScopeOf(day);
    if (!dayScopes[day.date] && dayScope) setDayScopes((previous) => ({ ...previous, [day.date]: dayScope }));
    edit({ ...draft, scope: next, repSeatId: null, areaSeatId: null, customers: [] });
    showScope(next);
  }

  /** Saves every half-day that can be saved, one at a time; the rest wait and say why. */
  async function saveWaiting(options: { keepalive?: boolean } = {}): Promise<boolean> {
    if (saving.current) return false;
    saving.current = true;
    let allSaved = true;
    try {
      for (const [waitingKey, waiting] of Object.entries(drafts)) {
        const [waitingDate, waitingHalf] = waitingKey.split("|") as [string, ManagerHalf];
        const savedSlot = viewRef.current?.days.find((entry) => entry.date === waitingDate)?.slots.find((entry) => entry.half === waitingHalf);
        if (waiting.kind === null && !savedSlot?.kind) {
          // Cleared before it was ever saved: nothing to send.
          setDrafts((previous) => {
            const { [waitingKey]: _gone, ...rest } = previous;
            return rest;
          });
          continue;
        }
        const problem = draftProblem(waiting, choosesADistrict(viewRef.current));
        if (problem) {
          allSaved = false;
          continue;
        }
        setSaveState({ kind: "saving" });
        try {
          const next = await crmPost<ManagerPlanBoardView>(
            BOARD,
            {
              ...draftPayload(waitingDate, waitingHalf, waiting, viewRef.current?.scopes ?? []),
              expectedVersion: viewRef.current?.plan?.version ?? null,
              scope: scopeRef.current,
              test,
            },
            "board",
            { keepalive: options.keepalive },
          );
          if (options.keepalive) continue;
          viewRef.current = next;
          // The answer is in the scope on screen; if he moved to another while it saved, read that one.
          if ((next.scope ?? null) === (scopeRef.current ?? null)) board.replace(next);
          else board.reload();
          setDrafts((previous) => {
            if (!previous[waitingKey] || !sameDraft(previous[waitingKey], waiting)) return previous;
            const { [waitingKey]: _saved, ...rest } = previous;
            return rest;
          });
        } catch (failure) {
          allSaved = false;
          setSaveState({ kind: "failed", message: messageOf(failure) });
          // Another screen moved the week first: read it again, and his edit stays on the page.
          if (errorCodeOf(failure)?.includes("version") || errorCodeOf(failure) === "conflict") board.reload();
          return false;
        }
      }
      setSaveState(allSaved ? { kind: "saved" } : { kind: "idle" });
      return allSaved;
    } finally {
      saving.current = false;
    }
  }

  const onSaveTimer = useEffectEvent(() => {
    void saveWaiting();
  });
  useEffect(() => {
    if (Object.keys(drafts).length === 0) return;
    const timer = window.setTimeout(() => onSaveTimer(), PLAN_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [drafts]);

  const onHidden = useEffectEvent(() => {
    if (Object.keys(drafts).length > 0) void saveWaiting({ keepalive: true });
  });
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === "hidden") onHidden();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  // The board leaving the screen — Nosiba Salah switching "My territory · My district", a tab change —
  // clears the autosave timer with it, so an edit made inside its 1.5 s would be lost. It is sent on the
  // way out instead, the way a hidden page sends it.
  useEffect(() => () => onHidden(), []);

  function chooseWeek(next: string) {
    if (Object.keys(drafts).length > 0) void saveWaiting();
    setWeek(next);
    setDate(null);
    setDrafts({});
    setDayScopes({});
    setStep(2);
  }

  if (!view) {
    return (
      <CrmPanel eyebrow="Plan" title="Your week">
        {board.error ? <CrmLoadError message={board.error} onRetry={board.reload} /> : <CrmLoading label="Loading your week" />}
      </CrmPanel>
    );
  }

  const plan = view.plan;
  const waitingProblems = Object.entries(drafts).flatMap(([waitingKey, waiting]) => {
    const problem = waiting.kind === null ? null : draftProblem(waiting, choosesDistrict);
    if (!problem) return [];
    const [waitingDate, waitingHalf] = waitingKey.split("|");
    const dayText = days.find((entry) => entry.date === waitingDate)?.dateText ?? waitingDate;
    return [`${dayText} ${waitingHalf}: ${problem}`];
  });
  const statusText =
    saveState.kind === "saving"
      ? "Saving…"
      : saveState.kind === "failed"
        ? `Not saved — ${saveState.message}`
        : waitingProblems.length > 0
          ? `Not saved yet — ${waitingProblems[0]}`
          : pending.length > 0
            ? "Saving soon…"
            : saveState.kind === "saved"
              ? "Saved"
              : null;

  function goStep(next: number) {
    const target = Math.min(Math.max(next, 1), STEPS.length);
    setStep(target);
    if (target === 3 && day) showScope(halfScopeOf(day, currentHalf));
  }

  const chip = view.weeks.find((entry) => entry.weekStart === view.weekStart)?.name ?? "This week";

  // What a With a rep or Single visit half-day shows in place of its reps and areas while they are not the
  // ones of its district manager yet: the day's choice first, then the load.
  const halfScope = day ? halfScopeOf(day, currentHalf) : null;
  let districtGate: ReactNode = null;
  if (choosesDistrict && namesADistrict(draft.kind)) {
    if (!halfScope) {
      districtGate = <CrmNote tone="info">Choose the district manager for this day first.</CrmNote>;
    } else if (view.scope !== halfScope) {
      const name = view.scopes.find((entry) => entry.key === halfScope)?.name ?? slot?.scopeName ?? "the district manager";
      districtGate =
        scopeKey !== halfScope ? (
          <div>
            <CrmButton onClick={() => showScope(halfScope)} size="sm">
              {`Show ${name}`}
            </CrmButton>
          </div>
        ) : board.error ? (
          <CrmLoadError message={board.error} onRetry={board.reload} />
        ) : board.loading ? (
          <CrmLoading label="Loading the district's reps and areas" />
        ) : (
          <CrmNote tone="warn">This district manager is no longer one you plan with. Choose another for this day.</CrmNote>
        );
    }
  }

  return (
    <CrmPanel
      description={
        choosesDistrict
          ? "Plan each half-day: choose the district manager, then go with one of the reps, make single visits in an area of that district, or record an admin activity or a day in the Office. The reps do not see it."
          : "Plan each half-day: with a rep, an admin activity, or single visits in an area of your district. Your reps do not see it."
      }
      eyebrow={view.isTest ? "Plan · test persona" : "Plan"}
      title={view.manager ? `${view.manager.name} · ${view.manager.place}` : "Your week"}
    >
      {plan ? (
        <CrmBlock>
          <CrmNote title={plan.statusLine} tone={plan.status === "returned" ? "warn" : plan.status === "approved" ? "good" : "neutral"}>
            <span className="block">
              {plan.dueText}
              {plan.submittedLate ? " · sent after the Thursday deadline" : ""}
            </span>
            {plan.decisionNote ? <span className="mt-1 block whitespace-pre-line">What to change: {plan.decisionNote}</span> : null}
            {plan.returnedDay ? (
              <span className="mt-1 block">Only {days.find((entry) => entry.date === plan.returnedDay)?.dateText ?? plan.returnedDay} is open to change.</span>
            ) : null}
          </CrmNote>
        </CrmBlock>
      ) : null}

      <div className="min-w-0 border-t border-slate-100">
        <CrmStepForm
          aside={plan?.firstApproverName ? `Nothing reaches ${plan.firstApproverName} until you press Send this week.` : "Nothing is sent until you press Send this week."}
          canJump={(target) => target <= 2 || day !== null}
          chip={chip}
          footer={
            <CrmStepFooter back={step > 1 ? () => goStep(step - 1) : null}>
              {statusText ? <span className="self-center text-xs font-bold text-slate-500">{statusText}</span> : null}
              {step < STEPS.length ? <CrmStepNext disabled={step >= 2 && day === null} onClick={() => goStep(step + 1)} /> : null}
            </CrmStepFooter>
          }
          onJump={goStep}
          step={step}
          steps={STEPS}
        >
          {step === 1 ? <WeekStep onWeek={chooseWeek} view={view} /> : null}
          {step === 2 ? (
            <DayStep
              days={days}
              drafts={drafts}
              onDay={(next) => {
                setDate(next);
                setHalf("AM");
                setStep(3);
                const nextDay = days.find((entry) => entry.date === next);
                if (nextDay) showScope(halfScopeOf(nextDay, nextDay.halves[0] ?? "AM"));
              }}
              selected={day?.date ?? null}
            />
          ) : null}
          {step === 3 && day ? (
            <HalfStep
              canEdit={canEdit}
              day={day}
              dayScope={choosesDistrict ? dayScopeOf(day) : null}
              districtGate={districtGate}
              draft={draft}
              half={currentHalf}
              idPrefix={idPrefix}
              onDayScope={chooseDayScope}
              onDraft={edit}
              onHalf={(next) => {
                setHalf(next);
                showScope(halfScopeOf(day, next));
              }}
              onHalfScope={chooseHalfScope}
              onScope={showScope}
              slot={slot}
              test={test}
              view={view}
            />
          ) : null}
          {step === 4 ? (
            <SendStep
              days={days}
              drafts={drafts}
              idPrefix={idPrefix}
              onChanged={() => {
                board.reload();
                onChanged?.();
              }}
              saveWaiting={saveWaiting}
              test={test}
              view={view}
              waitingProblems={waitingProblems}
            />
          ) : null}
        </CrmStepForm>
      </div>
    </CrmPanel>
  );
}

// ── Step 1 · the week ───────────────────────────────────────────────────────────────────────────

function WeekStep({ onWeek, view }: { onWeek: (week: string) => void; view: ManagerPlanBoardView }) {
  const options: Array<CrmChoiceOption<string>> = view.weeks.map((entry) => ({
    value: entry.weekStart,
    label: entry.name,
    note: entry.weekStart === view.weekStart && view.plan ? view.plan.statusLabel : undefined,
  }));
  return (
    <div className="grid min-w-0 gap-3">
      <CrmChoice columns={2} label="Week" onChange={onWeek} options={options} value={view.weekStart} />
      <p className="text-xs font-semibold leading-5 text-slate-500">
        You plan the coming week, due Thursday 23:55. A week you are already in and never sent can still be sent; it is marked late.
      </p>
    </div>
  );
}

// ── Step 2 · the day ────────────────────────────────────────────────────────────────────────────

function dayNote(day: ManagerBoardDay, drafts: Record<string, HalfDraft>): string {
  if (day.holiday) return `${day.holiday} · no plan`;
  if (day.halves.length === 0) return "No field day";
  return day.halves
    .map((half) => {
      const waiting = drafts[halfKey(day.date, half)];
      const summary = waiting ? "Not saved yet" : (day.slots.find((slot) => slot.half === half)?.summary ?? "Nothing planned");
      return `${half}: ${summary}`;
    })
    .join(" · ");
}

function DayStep({
  days,
  drafts,
  onDay,
  selected,
}: {
  days: ManagerBoardDay[];
  drafts: Record<string, HalfDraft>;
  onDay: (date: string) => void;
  selected: string | null;
}) {
  if (days.length === 0) return <CrmEmpty message="This week has no field days." title="No days to plan" />;
  const options: Array<CrmChoiceOption<string>> = days.map((day) => ({
    value: day.date,
    label: day.dateText,
    note: dayNote(day, drafts),
    disabled: day.halves.length === 0,
    tone: day.halves.length > 0 && day.halves.every((half) => day.slots.some((slot) => slot.half === half && slot.kind)) ? "good" : undefined,
  }));
  return <CrmChoice columns={2} label="Day" onChange={onDay} options={options} value={selected} />;
}

// ── The district manager a regional, national or product manager plans with ────────────────────

function scopeOption(scope: ManagerBoardScope, disabled: boolean): CrmChoiceOption<string> {
  return scope.dmSeatId
    ? { value: scope.key, label: scope.dmName ?? "No district manager", note: scope.place ?? undefined, disabled }
    : { value: scope.key, label: `Any rep in ${scope.lineName ?? "the line"}`, note: "Without a district manager", disabled };
}

/**
 * The district managers to choose from, grouped as the organogram groups them: a product manager chooses
 * the line first (Pedia or Anti Infective) and then its district managers or "Any rep in <line>"; a
 * national sales manager sees the districts under a regional manager grouped under that region.
 */
function ScopePicker({
  byLine,
  disabled,
  label,
  onPick,
  scopes,
  value,
}: {
  byLine: boolean;
  disabled: boolean;
  label: string;
  onPick: (key: string) => void;
  scopes: ReadonlyArray<ManagerBoardScope>;
  value: string | null;
}) {
  const [pickedLine, setPickedLine] = useState<string | null>(null);
  if (scopes.length === 0) return <CrmEmpty message="No district manager is in your reach right now." title="No district managers" />;

  if (byLine) {
    const lines = new Map<string, string>();
    for (const scope of scopes) if (!lines.has(scope.lineCode)) lines.set(scope.lineCode, scope.lineName ?? scope.lineCode);
    const valueLine = value ? (scopes.find((scope) => scope.key === value)?.lineCode ?? null) : null;
    const line = pickedLine ?? valueLine ?? (lines.size === 1 ? [...lines.keys()][0] : null);
    const lineOptions: Array<CrmChoiceOption<string>> = [...lines].map(([code, name]) => ({ value: code, label: name, disabled }));
    return (
      <div className="grid min-w-0 gap-3">
        <CrmChoice columns={2} label="Line" onChange={setPickedLine} options={lineOptions} value={line} />
        {line ? (
          <CrmChoice
            columns={2}
            label={label}
            onChange={onPick}
            options={scopes.filter((scope) => scope.lineCode === line).map((scope) => scopeOption(scope, disabled))}
            value={value}
          />
        ) : null}
      </div>
    );
  }

  const groups: Array<{ heading: string | null; scopes: ManagerBoardScope[] }> = [];
  for (const scope of scopes) {
    const found = groups.find((group) => group.heading === scope.group);
    if (found) found.scopes.push(scope);
    else groups.push({ heading: scope.group, scopes: [scope] });
  }
  groups.sort((left, right) => Number(left.heading !== null) - Number(right.heading !== null));
  return (
    <div className="grid min-w-0 gap-3">
      {groups.map((group) => (
        <div className="grid min-w-0 gap-1.5" key={group.heading ?? "direct"}>
          {group.heading ? <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{group.heading}</p> : null}
          <CrmChoice
            columns={2}
            label={group.heading ? `${label} · ${group.heading}` : label}
            onChange={onPick}
            options={group.scopes.map((scope) => scopeOption(scope, disabled))}
            value={value}
          />
        </div>
      ))}
    </div>
  );
}

/** "Another district manager for this half" — and, once one is chosen, the way back to the day's. */
function HalfScopeControl({
  byLine,
  dayScope,
  draftScope,
  onPick,
  scopes,
}: {
  byLine: boolean;
  dayScope: string;
  draftScope: string | null;
  onPick: (key: string) => void;
  scopes: ReadonlyArray<ManagerBoardScope>;
}) {
  const [open, setOpen] = useState(false);
  const own = draftScope !== null && draftScope !== dayScope;
  const ownName = own ? (scopes.find((scope) => scope.key === draftScope)?.name ?? "another district manager") : null;
  return (
    <div className="grid min-w-0 gap-2">
      {ownName ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="min-w-0 break-words text-sm font-bold text-slate-900">{`This half: ${ownName}`}</p>
          <CrmButton onClick={() => onPick(dayScope)} size="sm" variant="ghost">
            Same as the day
          </CrmButton>
        </div>
      ) : null}
      {open ? (
        <div className="grid min-w-0 gap-3 border border-slate-200 p-3">
          <ScopePicker
            byLine={byLine}
            disabled={false}
            label="District manager for this half"
            onPick={(next) => {
              setOpen(false);
              onPick(next);
            }}
            scopes={scopes}
            value={draftScope}
          />
          <div>
            <CrmButton onClick={() => setOpen(false)} size="sm" variant="ghost">
              Cancel
            </CrmButton>
          </div>
        </div>
      ) : (
        <div>
          <CrmButton onClick={() => setOpen(true)} size="sm" variant="ghost">
            Another district manager for this half
          </CrmButton>
        </div>
      )}
    </div>
  );
}

// ── Step 3 · what he does that day ──────────────────────────────────────────────────────────────

function HalfStep({
  canEdit,
  day,
  dayScope,
  districtGate,
  draft,
  half,
  idPrefix,
  onDayScope,
  onDraft,
  onHalf,
  onHalfScope,
  onScope,
  slot,
  test,
  view,
}: {
  canEdit: boolean;
  day: ManagerBoardDay;
  /** The day's district manager — a regional, national or product manager's only. */
  dayScope: string | null;
  /** Shown in place of the reps and areas until they are the half-day's district manager's. */
  districtGate: ReactNode;
  draft: HalfDraft;
  half: ManagerHalf;
  idPrefix: string;
  onDayScope: (key: string) => void;
  onDraft: (next: HalfDraft) => void;
  onHalf: (half: ManagerHalf) => void;
  onHalfScope: (key: string) => void;
  onScope: (key: string | null) => void;
  slot: ManagerBoardSlot | undefined;
  test: boolean;
  view: ManagerPlanBoardView;
}) {
  const choosesDistrict = choosesADistrict(view);
  const byLine = view.writer?.kind === "pm";
  const halfOptions: Array<CrmChoiceOption<ManagerHalf>> = day.halves.map((entry) => ({
    value: entry,
    label: entry,
    note: day.slots.find((candidate) => candidate.half === entry)?.summary ?? "Nothing planned",
  }));
  const kindOptions: Array<CrmChoiceOption<ManagerSlotKind>> = MANAGER_SLOT_KINDS.map((entry) => ({
    value: entry.key,
    label: entry.label,
    disabled: !canEdit,
  }));

  function chooseKind(kind: ManagerSlotKind) {
    if (kind === draft.kind) return;
    const scope = choosesDistrict && namesADistrict(kind) ? dayScope : null;
    onDraft({ ...emptyDraft(), kind, scope, note: draft.note });
    if (scope) onScope(scope);
  }

  const dayScopeName = dayScope ? (view.scopes.find((entry) => entry.key === dayScope)?.name ?? null) : null;

  return (
    <div className="grid min-w-0 gap-5">
      {choosesDistrict ? (
        <div className="grid min-w-0 gap-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{`${day.dateText} · District manager for this day`}</p>
          {canEdit ? (
            <ScopePicker byLine={byLine} disabled={false} label="District manager for this day" onPick={onDayScope} scopes={view.scopes} value={dayScope} />
          ) : (
            <p className="break-words text-sm font-bold text-slate-900">{dayScopeName ?? "None chosen"}</p>
          )}
        </div>
      ) : null}
      {day.halves.length > 1 ? <CrmChoice columns={2} label="Half-day" onChange={onHalf} options={halfOptions} value={half} /> : null}
      {!canEdit ? (
        <CrmNote tone="neutral">{view.canWrite ? "This day has passed, or is not open to change." : "This week is sent. Ask to edit it from Send."}</CrmNote>
      ) : null}
      <div className="grid min-w-0 gap-2">
        <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{`${day.dateText} · ${half}`}</p>
        <CrmChoice columns={3} label="What you do" onChange={chooseKind} options={kindOptions} value={draft.kind} />
      </div>

      {choosesDistrict && canEdit && dayScope && namesADistrict(draft.kind) ? (
        <HalfScopeControl
          byLine={byLine}
          dayScope={dayScope}
          draftScope={draft.scope}
          key={halfKey(day.date, half)}
          onPick={onHalfScope}
          scopes={view.scopes}
        />
      ) : null}
      {choosesDistrict && !canEdit && namesADistrict(draft.kind) && slot?.scopeName ? (
        <p className="break-words text-sm font-bold text-slate-900">{`This half: ${slot.scopeName}`}</p>
      ) : null}

      {draft.kind === "with_rep"
        ? (districtGate ?? <WithRepPart canEdit={canEdit} day={day} draft={draft} half={half} onDraft={onDraft} slot={slot} view={view} />)
        : null}
      {draft.kind === "admin" ? <AdminPart canEdit={canEdit} draft={draft} idPrefix={idPrefix} onDraft={onDraft} view={view} /> : null}
      {draft.kind === "single_visit"
        ? (districtGate ?? (
            <SingleVisitPart canEdit={canEdit} draft={draft} half={half} idPrefix={idPrefix} onDraft={onDraft} slot={slot} test={test} view={view} />
          ))
        : null}

      {canEdit && (draft.kind !== null || slot?.kind) ? (
        <div>
          <CrmButton onClick={() => onDraft(emptyDraft())} size="sm" variant="ghost">
            Clear this half-day
          </CrmButton>
        </div>
      ) : null}
    </div>
  );
}

function toggle(draft: HalfDraft, ref: CustomerRef, on: boolean): HalfDraft {
  const without = draft.customers.filter((customer) => customer.key !== ref.key);
  return { ...draft, customers: on ? [...without, ref] : without };
}

function WithRepPart({
  canEdit,
  day,
  draft,
  half,
  onDraft,
  slot,
  view,
}: {
  canEdit: boolean;
  day: ManagerBoardDay;
  draft: HalfDraft;
  half: ManagerHalf;
  onDraft: (next: HalfDraft) => void;
  slot: ManagerBoardSlot | undefined;
  view: ManagerPlanBoardView;
}) {
  if (view.reps.length === 0) {
    return <CrmEmpty message={choosesADistrict(view) ? "No rep sits in this district right now." : "No rep sits in your team right now."} title="No reps" />;
  }
  const halves = new Map(day.repHalves.filter((entry) => entry.half === half).map((entry) => [entry.seatId, entry]));
  // The rep this half-day already holds, with customers he ticked: that rep stays selectable even when
  // the rep's own half is now empty, so the customers the rep dropped can still be seen and unticked.
  const keptSeatId = slot?.kind === "with_rep" && slot.repSeatId && slot.customers.length > 0 ? slot.repSeatId : null;
  const options: Array<CrmChoiceOption<string>> = view.reps.map((rep) => {
    const repHalf = halves.get(rep.seatId);
    const state = REP_WEEK[repHalf?.weekState ?? rep.weekState];
    const where = repHalf && repHalf.bricks.length > 0 ? repHalf.bricks.join(", ") : null;
    const nothingToTick = rep.weekState === "no_plan" || !repHalf || repHalf.customers.length === 0;
    const disabled = !canEdit || (nothingToTick && rep.seatId !== keptSeatId);
    return {
      value: rep.seatId,
      label: rep.name,
      disabled,
      note: (
        <span className="grid gap-1">
          <span className="break-words">{rep.weekState === "no_plan" ? "No plan this week" : (where ?? "Nothing planned this half")}</span>
          <span>
            <CrmPill tone={state.tone}>{state.label}</CrmPill>
          </span>
        </span>
      ),
    };
  });
  const chosen = draft.repSeatId ? halves.get(draft.repSeatId) : undefined;
  const repCustomers = chosen?.customers ?? [];
  const onDay = new Set(repCustomers.map((customer) => customer.customerId));
  // A customer he ticked that the rep has since dropped from this half stays, flagged, until he unticks it.
  const dropped = (slot?.repSeatId === draft.repSeatId ? (slot?.customers ?? []) : []).filter(
    (customer) => customer.customerId && !onDay.has(customer.customerId),
  );
  const ticked = new Set(draft.customers.map((customer) => customer.key));

  return (
    <div className="grid min-w-0 gap-4">
      <CrmChoice
        columns={2}
        label="Which rep"
        onChange={(seatId) => onDraft({ ...draft, repSeatId: seatId, customers: [] })}
        options={options}
        value={draft.repSeatId}
      />
      {chosen || dropped.length > 0 ? (
        <div className="grid min-w-0 gap-3 border border-slate-200 p-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-black text-slate-900">
              {`${countText(draft.customers.length)} of ${plural(repCustomers.length + dropped.length, "customer", "customers")} ticked`}
              {chosen?.weekState === "not_sent" ? (
                <CrmPill className="ml-2" tone="warn">
                  Not sent
                </CrmPill>
              ) : null}
            </p>
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <CrmButton
                  disabled={repCustomers.length === 0}
                  onClick={() => onDraft({ ...draft, customers: repCustomers.map((customer) => repRef(customer.customerId, customer.name)) })}
                  size="sm"
                  variant="primary"
                >
                  Mark all
                </CrmButton>
                <CrmButton disabled={draft.customers.length === 0} onClick={() => onDraft({ ...draft, customers: [] })} size="sm">
                  Clear
                </CrmButton>
              </div>
            ) : null}
          </div>
          {chosen?.weekState === "not_sent" ? (
            <p className="text-xs font-semibold leading-5 text-amber-800">The rep has not sent this week yet, so these customers may still change.</p>
          ) : null}
          {!chosen ? (
            <p className="text-xs font-semibold leading-5 text-amber-800">The rep has nothing planned this half any more. Untick the customers below, or choose another rep.</p>
          ) : null}
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            {repCustomers.map((customer) => (
              <CrmCheck
                checked={ticked.has(`c:${customer.customerId}`)}
                disabled={!canEdit}
                key={customer.customerId}
                onChange={(on) => onDraft(toggle(draft, repRef(customer.customerId, customer.name), on))}
              >
                <span className="block break-words" dir="auto">
                  {customer.name}
                </span>
                <span className="block break-words text-xs font-semibold text-slate-500">
                  {[customer.grade ? `Grade ${customer.grade}` : null, customer.speciality, customer.brickName ?? customer.zone].filter(Boolean).join(" · ")}
                </span>
              </CrmCheck>
            ))}
            {dropped.map((customer) => (
              <CrmCheck
                checked={ticked.has(`c:${customer.customerId}`)}
                disabled={!canEdit}
                key={`dropped-${customer.customerId}`}
                onChange={(on) => onDraft(toggle(draft, repRef(customer.customerId ?? "", customer.name), on))}
              >
                <span className="block break-words" dir="auto">
                  {customer.name}
                </span>
                <span className="block text-xs font-bold text-amber-700">No longer on the rep&apos;s day</span>
              </CrmCheck>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AdminPart({
  canEdit,
  draft,
  idPrefix,
  onDraft,
  view,
}: {
  canEdit: boolean;
  draft: HalfDraft;
  idPrefix: string;
  onDraft: (next: HalfDraft) => void;
  view: ManagerPlanBoardView;
}) {
  const options: Array<CrmChoiceOption<string>> = view.activities.map((entry) => ({ value: entry.key, label: entry.label, disabled: !canEdit }));
  // Office makes eight (everyone but a district manager): two full rows of four, nothing to span.
  const withOffice = options.length > 7;
  return (
    <div className="grid min-w-0 gap-4">
      {/* Seven activities: the seven-way grid's two-then-four rows with the last spanning the gap, but never
          seven across — inside the half-day panel a seven-wide row squeezes "Admin work" to one word a line. */}
      <CrmChoice
        className={withOffice ? undefined : "lg:grid-cols-4 lg:[&>*:last-child]:col-span-2"}
        columns={withOffice ? 4 : 7}
        label="Activity"
        onChange={(activityType) => onDraft({ ...draft, activityType })}
        options={options}
        value={draft.activityType}
      />
      <label className="grid min-w-0 gap-1.5" htmlFor={`${idPrefix}-admin-note`}>
        <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Note</span>
        <textarea
          className={crmTextareaClassName}
          dir="auto"
          disabled={!canEdit}
          id={`${idPrefix}-admin-note`}
          maxLength={MANAGER_PLAN_NOTE_MAX}
          onChange={(event) => onDraft({ ...draft, note: event.target.value })}
          placeholder="Where, with whom, what for"
          value={draft.note}
        />
      </label>
    </div>
  );
}

function SingleVisitPart({
  canEdit,
  draft,
  half,
  idPrefix,
  onDraft,
  slot,
  test,
  view,
}: {
  canEdit: boolean;
  draft: HalfDraft;
  half: ManagerHalf;
  idPrefix: string;
  onDraft: (next: HalfDraft) => void;
  slot: ManagerBoardSlot | undefined;
  test: boolean;
  view: ManagerPlanBoardView;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(AREA_PAGE);
  const [adding, setAdding] = useState(false);
  const area = useCrmGet<AreaCustomersView>(draft.areaSeatId && canEdit ? crmUrl(AREA, { area: draft.areaSeatId, test }) : null, "area");
  if (view.areas.length === 0) {
    return <CrmEmpty message={choosesADistrict(view) ? "No area of this district is on file yet." : "No area of your district is on file yet."} title="No areas" />;
  }

  const areaOptions: Array<CrmChoiceOption<string>> = view.areas.map((entry) => ({
    value: entry.seatId,
    label: entry.areaName,
    note: entry.repName ?? "No rep",
    disabled: !canEdit,
  }));
  const ticked = new Set(draft.customers.map((customer) => customer.key));
  const words = query.trim().toLowerCase();
  const matches = (name: string) => !words || name.toLowerCase().includes(words);
  const repList = (area.data?.repList ?? [])
    .filter((customer) => matches(customer.name))
    .sort((left, right) => Number(right.listType === half) - Number(left.listType === half) || left.name.localeCompare(right.name));
  const ownList = (area.data?.ownList ?? []).filter((customer) => customer.status === "active" && matches(customer.name));
  const shown = repList.slice(0, limit);

  function pickMatch(match: CustomerMatch) {
    const ref = match.source === "own" ? ownRef(match.id, match.name) : repRef(match.id, match.name);
    onDraft(toggle(draft, ref, true));
    setAdding(false);
  }

  function added(customer: ManagerCustomerView) {
    onDraft(toggle(draft, ownRef(customer.id, customer.name), true));
    setAdding(false);
    area.reload();
  }

  // A district manager has two days of single visits a week at most — four half-days (owner, 2026-10-17).
  const singleVisitHalves = view.days.flatMap((entry) => entry.slots).filter((entry) => entry.kind === "single_visit").length;

  return (
    <div className="grid min-w-0 gap-4">
      {view.writer?.kind === "dm" ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-500">
          {`Single visits are limited to two days a week, which is four half-days. This week holds ${singleVisitHalves} of ${DM_SINGLE_VISIT_HALF_DAYS_MAX}.`}
        </p>
      ) : null}
      <CrmChoice columns={3} label="Area" onChange={(areaSeatId) => onDraft({ ...draft, areaSeatId, customers: [] })} options={areaOptions} value={draft.areaSeatId} />

      {!canEdit ? (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {(slot?.customers ?? []).map((customer) => (
            <CrmPill key={customer.customerId ?? customer.managerCustomerId ?? customer.name} tone={customer.own ? "orange" : "neutral"}>
              <span className="break-words normal-case tracking-normal" dir="auto">
                {customer.name}
              </span>
            </CrmPill>
          ))}
        </div>
      ) : draft.areaSeatId ? (
        <div className="grid min-w-0 gap-4 border border-slate-200 p-3">
          <p className="text-sm font-black text-slate-900">{`${plural(draft.customers.length, "customer", "customers")} chosen`}</p>
          {draft.customers.length > 0 ? (
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {draft.customers.map((customer) => (
                <button
                  className="inline-flex max-w-full items-center gap-1 border border-orange-200 bg-orange-50 px-2 py-1 text-left text-xs font-bold text-orange-800 hover:bg-orange-100"
                  key={customer.key}
                  onClick={() => onDraft(toggle(draft, customer, false))}
                  type="button"
                >
                  <span className="break-words" dir="auto">
                    {customer.name}
                  </span>
                  <span aria-hidden>×</span>
                  <span className="sr-only">Take off</span>
                </button>
              ))}
            </div>
          ) : null}

          {adding ? (
            <ManagerCustomerForm
              areas={view.areas.map((entry) => ({ seatId: entry.seatId, areaName: entry.areaName }))}
              defaultAreaSeatId={draft.areaSeatId}
              onAdded={added}
              onCancel={() => setAdding(false)}
              onPickExisting={pickMatch}
              test={test}
            />
          ) : (
            <div>
              <CrmButton onClick={() => setAdding(true)} size="sm">
                Add a customer
              </CrmButton>
            </div>
          )}

          {area.error ? <CrmLoadError message={area.error} onRetry={area.reload} /> : null}
          {!area.data && !area.error ? <CrmLoading label="Loading the area's customers" /> : null}
          {area.data ? (
            <>
              <CrmSearchField id={`${idPrefix}-area-search`} label="Find a customer" onChange={setQuery} placeholder="Type a name" value={query} />
              {ownList.length > 0 ? (
                <div className="grid min-w-0 gap-2">
                  <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Manager&apos;s own list</p>
                  <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                    {ownList.map((customer) => (
                      <CrmCheck
                        checked={ticked.has(`m:${customer.id}`)}
                        key={customer.id}
                        onChange={(on) => onDraft(toggle(draft, ownRef(customer.id, customer.name), on))}
                      >
                        <span className="block break-words" dir="auto">
                          {customer.name}
                        </span>
                        <span className="block break-words text-xs font-semibold text-slate-500">
                          {[`Grade ${customer.grade}`, customer.potentialGrade, customer.speciality].filter(Boolean).join(" · ")}
                        </span>
                      </CrmCheck>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="grid min-w-0 gap-2">
                <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">The area&apos;s rep lists</p>
                {repList.length === 0 ? <p className="text-sm font-semibold text-slate-500">No customer on these lists matches.</p> : null}
                <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                  {shown.map((customer) => (
                    <CrmCheck
                      checked={ticked.has(`c:${customer.customerId}`)}
                      key={customer.customerId}
                      onChange={(on) => onDraft(toggle(draft, repRef(customer.customerId, customer.name), on))}
                    >
                      <span className="block break-words" dir="auto">
                        {customer.name}
                      </span>
                      <span className="block break-words text-xs font-semibold text-slate-500">
                        {[customer.listType, customer.grade ? `Grade ${customer.grade}` : null, customer.speciality, customer.repName ?? "No rep"].filter(Boolean).join(" · ")}
                      </span>
                    </CrmCheck>
                  ))}
                </div>
              </div>
              <CrmShowMore left={repList.length - shown.length} onMore={() => setLimit((value) => value + AREA_PAGE)} page={AREA_PAGE} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Step 4 · send ───────────────────────────────────────────────────────────────────────────────

function SendStep({
  days,
  drafts,
  idPrefix,
  onChanged,
  saveWaiting,
  test,
  view,
  waitingProblems,
}: {
  days: ManagerBoardDay[];
  drafts: Record<string, HalfDraft>;
  idPrefix: string;
  onChanged: () => void;
  saveWaiting: () => Promise<boolean>;
  test: boolean;
  view: ManagerPlanBoardView;
  waitingProblems: string[];
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [asked, setAsked] = useState(false);
  const plan = view.plan;
  const planned = days.flatMap((day) => day.slots.filter((slot) => slot.kind)).length;
  const fieldHalves = days.reduce((sum, day) => sum + day.halves.length, 0);
  const offRepDay = days.flatMap((day) => day.slots.flatMap((slot) => slot.customers.filter((customer) => customer.flag))).length;
  // Who decides it, in order — and, for everyone but a district manager, HR's own acknowledgement after.
  const route = [plan?.firstApproverName, plan?.secondApproverName].filter(Boolean).join(", then ");
  const hrAcknowledges = choosesADistrict(view);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      if (Object.keys(drafts).length > 0 && !(await saveWaiting())) {
        setError(waitingProblems[0] ? `Finish or clear ${waitingProblems[0]} first.` : "A half-day could not be saved. Try again.");
        setBusy(false);
        return;
      }
      if (!plan?.planId) {
        setError("Plan at least one half-day first.");
        setBusy(false);
        return;
      }
      await crmPost<ManagerPlanTransitionResult>("/api/phoenix-crm/manager-plans/submit", { planId: plan.planId, version: plan.version, test }, "plan");
      setConfirming(false);
      setBusy(false);
      onChanged();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  }

  async function askToEdit() {
    if (!plan?.planId) return;
    setBusy(true);
    setError(null);
    try {
      await crmPost<{ requestId: string }>("/api/phoenix-crm/manager-plans/edit-requests", { planId: plan.planId, reason: reason.trim(), test }, "ask");
      setAsked(true);
      setAsking(false);
      setBusy(false);
      onChanged();
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 gap-2">
        {days
          .filter((day) => day.halves.length > 0 || day.holiday)
          .map((day) => (
            <div className="min-w-0 border border-slate-200" key={day.date}>
              <p className="border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-600">
                {day.holiday ? `${day.dateText} · ${day.holiday}` : day.dateText}
              </p>
              {day.halves.map((half) => {
                const slot = day.slots.find((entry) => entry.half === half);
                const waiting = drafts[halfKey(day.date, half)];
                const flags = slot?.customers.filter((customer) => customer.flag) ?? [];
                return (
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2" key={half}>
                    <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{half}</span>
                    <span className="min-w-0 break-words text-sm font-bold text-slate-900">{waiting ? "Not saved yet" : (slot?.summary ?? "Nothing planned")}</span>
                    {flags.length > 0 ? <CrmPill tone="warn">{`${countText(flags.length)} not on the rep's day`}</CrmPill> : null}
                  </div>
                );
              })}
            </div>
          ))}
      </div>
      <p className="text-sm font-semibold text-slate-600">
        {`${countText(planned)} of ${plural(fieldHalves, "half-day", "half-days")} planned`}
        {offRepDay > 0 ? ` · ${plural(offRepDay, "customer is", "customers are")} not on the rep's sent day` : ""}
      </p>
      {route ? (
        <p className="text-xs font-semibold leading-5 text-slate-500">
          {`It goes to ${route}.${hrAcknowledges ? " Once it is approved, HR acknowledges it automatically." : ""}`}
        </p>
      ) : null}

      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}

      {plan?.state === "plan" && view.canWrite ? (
        confirming ? (
          <CrmNote title={`Send this week to ${plan.firstApproverName ?? "your manager"}?`} tone="info">
            <p>Once it is sent, a change needs that approval first.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <CrmButton busy={busy} onClick={() => void send()} variant="primary">
                Send this week
              </CrmButton>
              <CrmButton disabled={busy} onClick={() => setConfirming(false)}>
                Not yet
              </CrmButton>
            </div>
          </CrmNote>
        ) : (
          <div>
            <CrmButton disabled={planned === 0 && Object.keys(drafts).length === 0} onClick={() => setConfirming(true)} variant="primary">
              Send this week
            </CrmButton>
          </div>
        )
      ) : null}

      {plan?.state === "sent" && view.manager ? (
        asked ? (
          <CrmNote tone="good">Your ask to edit is sent. You will be told when it is decided.</CrmNote>
        ) : asking ? (
          <div className="grid min-w-0 gap-3 border border-slate-200 p-3">
            <label className="grid min-w-0 gap-1.5" htmlFor={`${idPrefix}-edit-reason`}>
              <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Why you need to change it *</span>
              <textarea
                className={crmTextareaClassName}
                dir="auto"
                id={`${idPrefix}-edit-reason`}
                maxLength={MANAGER_PLAN_REASON_MAX}
                onChange={(event) => setReason(event.target.value)}
                placeholder="For example: a rep sent a week after mine"
                value={reason}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <CrmButton busy={busy} disabled={reason.trim().length < 3} onClick={() => void askToEdit()} variant="primary">
                Send the ask
              </CrmButton>
              <CrmButton disabled={busy} onClick={() => setAsking(false)}>
                Cancel
              </CrmButton>
            </div>
          </div>
        ) : (
          <div>
            <CrmButton onClick={() => setAsking(true)}>Ask to edit this week</CrmButton>
          </div>
        )
      ) : null}

      {plan?.state === "asked" ? (
        <CrmNote tone="info">
          {plan.editAsk?.status === "first_approved"
            ? `${plan.firstApproverName ?? "Your manager"} approved your ask to edit. It now waits for ${plan.editAsk.waitingOnName ?? "the second approver"}.`
            : `Your ask to edit waits for ${plan.editAsk?.waitingOnName ?? plan.firstApproverName ?? "your manager"}.`}
        </CrmNote>
      ) : null}
      {plan?.state === "closed" ? <CrmNote tone="neutral">This week is closed.</CrmNote> : null}
    </div>
  );
}
