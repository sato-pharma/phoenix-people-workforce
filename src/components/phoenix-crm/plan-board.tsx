"use client";

/**
 * Phoenix CRM — the Plan: ONE board for the month and its weeks (owner, 2026-09-29).
 *
 * "He plans by month or by week, and the weeks roll up into the month." The month sits on top — its
 * status, its due date (the last Thursday of the month before), its LATE stamp, the AM and PM meters
 * and the call rate, never added together — and its own Send / Take back / Approve / Return. Under it,
 * Week 1..N: each week is due the Thursday before it, carries its own status and stamp, and has its own
 * buttons, so a rep who sends a week at a time and one who sends the whole month use the same board.
 * A week shows its six days; a day shows its other activity at the top and its customers grouped by
 * brick with tick boxes (PlanDayPanel).
 *
 * The rep's ticks stay on this page as a draft over each week's saved version until he presses Save
 * (plan-week-draft.ts). A save goes one week at a time through the ordinary weekly save, so every day
 * passes the rules a hand-placed day always has, and the database refuses a save made against an older
 * version. A save that fails NEVER loses his ticks: they stay on the page, and when the week changed
 * underneath them he chooses whether to keep them or to see the saved week.
 *
 * A late month or week is ACCEPTED and STAMPED, never refused. Nothing here sends or approves on its
 * own: every send, take-back, approve and return is a press of its own button (and Send asks once
 * more). A manager reading his rep's plan gets the same board, read only, with Approve and Return.
 *
 * Owner, 2026-09-30 — "the best-appearing and easiest CRM, yet controlled":
 *   - "Suggest this day" and "Suggest the week" (plan-suggest.ts) fill the draft through `addCopies`,
 *     the one way a copy fills it, so a suggestion is reviewed, saved and sent exactly like a copy. The
 *     board hands them the month so far — the DRAFT included, since the saved tallies alone would
 *     re-suggest a customer he ticked a minute ago — and how many weeks are left to spread a customer.
 *   - On a phone the month's eight meters fold into one two-column strip, AM on the left and PM on the
 *     right, never added together; a tablet and a desktop keep the full cards.
 *   - The week and day on screen carry a tick in their chooser and an orange bar on their heading.
 */

import { useEffect, useId, useRef, useState } from "react";

import { crmPost, crmUrl, errorCodeOf, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { brickTintMap } from "@/components/phoenix-crm/brick-tints";
import { cairoStamp, countText, dayLabel, plural, type Tone } from "@/components/phoenix-crm/format";
import { pendingListNote, territoryLine } from "@/components/phoenix-crm/labels";
import { PlanCopyMenu, type CopiedPlacements, type SuggestContext } from "@/components/phoenix-crm/plan-copy-menu";
import { decisionBusy, PlanDecision, type PlanDecisionAction } from "@/components/phoenix-crm/plan-decision";
import { ChoiceLabel, PLAN_STATUS_TONE, PlanWeekPanel, problemText, type WeekBusy, type WeekHold } from "@/components/phoenix-crm/plan-week-panel";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmFacts,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmStat,
  CrmStatGrid,
  type NoteTone,
} from "@/components/phoenix-crm/ui";
import { monthEndOf, monthKeyOf } from "@/lib/phoenix-crm/calendar";
import { EMPTY_DOCTOR_FILTER, plannerBricks, plannerGrades, plannerSpecialities, type DoctorFilter } from "@/lib/phoenix-crm/plan-filters";
import { isPlanEditable, type PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import { monthPlacements } from "@/lib/phoenix-crm/plan-suggest";
import {
  addCopiedItems,
  buildWeekSavePayload,
  discardWeekDraft,
  draftFits,
  firstDayToPlan,
  firstWeekToPlan,
  holdSettled,
  indexCustomers,
  isWeekDirty,
  markWeekSaved,
  matchesSavedWeek,
  placeCustomer,
  rebaseDraft,
  savedWeekActivities,
  savedWeekItems,
  setPlannedActivity,
  startDraft,
  takeOffCustomer,
  weekFixes,
  weekProblems,
  weekScope,
  weekToPlanMove,
  type DailyCaps,
  type DraftProblem,
  type PlannedActivity,
  type WeekDraft,
} from "@/lib/phoenix-crm/plan-week-draft";
import type { PhoenixCrmListType } from "@/lib/phoenix-crm/types";
import type { MonthlyPlannerView, MonthlyWeekView, SavedPlan } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

/** A refusal that means the week on screen is out of date: the board reads it again, and keeps the ticks. */
const PLAN_RELOAD_CODES = new Set([
  "conflict",
  "invalid_request",
  "not_found",
  "phoenix_crm_bad_transition",
  "phoenix_crm_conflict",
  "phoenix_crm_customer_not_on_list",
  "phoenix_crm_day_not_editable",
  "phoenix_crm_not_editable",
  "phoenix_crm_place_changed",
  "phoenix_crm_plan_not_found",
  "phoenix_crm_version_conflict",
]);

/** Answers a save can get when it landed and only its answer was lost. */
const MAY_HAVE_SAVED = new Set(["offline", "failed", "internal_error", "statement_timeout"]);

/** What happened, said once the board shows the latest plan (the server's own words ask for a reload). */
const RELOADED_MESSAGES: Record<string, string> = {
  phoenix_crm_version_conflict: "This week was changed on another screen.",
  phoenix_crm_not_editable: "This week was sent for review or approved on another screen.",
};

type Notice = { tone: NoteTone; title: string; message?: string | null };

type BoardBusy =
  | { kind: "save" }
  | { kind: "month"; action: "send" | "reopen" | PlanDecisionAction }
  | { kind: "week"; weekStart: string; action: WeekBusy };

/** Unsaved ticks and a way out was pressed: another month, or back to the screen that opened the board. */
type Leaving = { kind: "month"; monthKey: string } | { kind: "back" };

/** One week of the month, as the board holds it. */
type WeekState = {
  week: MonthlyWeekView;
  scope: string;
  /** The rep may still change it: his, open, and a draft or returned. */
  editable: boolean;
  /** The draft on screen: over the saved version, or held through a save that failed or crossed another. */
  draft: WeekDraft | null;
  hold: WeekHold | null;
  /** It was held through a save whose answer was lost, and the reload showed that save had landed. */
  settled: boolean;
  items: PlanItemDraft[];
  activities: PlannedActivity[];
  dirty: boolean;
  /** Planned customers the next save changes by itself (left the list, or moved place). */
  fixes: number;
  problems: DraftProblem[];
};

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function pctText(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

function reviewerSentence(view: MonthlyPlannerView): string {
  if (view.isTest) return "This is a test plan: you review it yourself, and nobody is notified.";
  if (view.territory.reviewerName) return `${view.territory.reviewerName} reviews it.`;
  return "The manager above this territory reviews it.";
}

/** "Week 2 and Week 3". */
function weeksText(numbers: ReadonlyArray<number>): string {
  const names = numbers.map((number) => `Week ${number}`);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function PlanBoard({
  initialMonth,
  initialWeekStart,
  onBack,
  onChanged,
  onDirtyChange,
  onOpenList,
  seatId,
  test,
  weekNonce = 0,
}: {
  /** The month to open: "2026-10", or any day of it. The first plannable month when absent. */
  initialMonth?: string;
  /** The week to open (its Saturday); its month opens with it. */
  initialWeekStart?: string;
  /**
   * Where the board was opened FROM, when it was not the rep's own Plan tab — a manager's Team tab
   * reviewing a territory's month or week. Unsaved ticks are asked about before it lets them go.
   */
  onBack?: { label: string; onBack: () => void };
  /** A save, a send or a decision went through (a review list elsewhere reads itself again). */
  onChanged?: () => void;
  /** Unsaved ticks appeared or went: the page around the board asks before it swaps the territory. */
  onDirtyChange?: (dirty: boolean) => void;
  /** The List tab, for the customers not validated yet. */
  onOpenList?: () => void;
  seatId: string;
  test: boolean;
  /**
   * The portal's "+ Make weekly plan": each new positive value opens the first week still open and not
   * sent yet (else the first open week) and brings it into view. Nothing unsaved is dropped.
   */
  weekNonce?: number;
}) {
  const idPrefix = useId();
  const [month, setMonth] = useState<string | null>(() =>
    initialMonth ? monthKeyOf(initialMonth) : initialWeekStart ? monthKeyOf(initialWeekStart) : null,
  );
  const [weekStart, setWeekStart] = useState<string | null>(initialWeekStart ?? null);
  const [day, setDay] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, WeekDraft>>({});
  const [holds, setHolds] = useState<Record<string, WeekHold>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<BoardBusy | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [filter, setFilter] = useState<DoctorFilter>(EMPTY_DOCTOR_FILTER);
  const [query, setQuery] = useState("");
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [monthConfirm, setMonthConfirm] = useState<"send" | "reopen" | null>(null);
  const [seenNonce, setSeenNonce] = useState(0);
  // "+ Make weekly plan" looking for its week: `movedTo` is the month it moved on to, once.
  const [weekSearch, setWeekSearch] = useState<{ movedTo: string | null } | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const topRef = useRef<HTMLDivElement>(null);
  const weekRef = useRef<HTMLDivElement>(null);

  const resource = useCrmGet<MonthlyPlannerView>(crmUrl("/api/phoenix-crm/monthly-plans", { seatId, test, month }), "planner");
  const view = resource.data;
  const locked = busy !== null || resource.loading;

  // "+ Make weekly plan" asked again: answered while rendering, from the value seen last time — state
  // derived from a prop, never an effect. The week is chosen once the month is on screen (below).
  if (weekNonce !== seenNonce) {
    setSeenNonce(weekNonce);
    if (weekNonce > 0) setWeekSearch({ movedTo: null });
  }

  // ── The weeks, as the board holds them ────────────────────────────────────────────────────────
  const customers = view ? view.customers : [];
  const byId = indexCustomers(customers);
  const caps: DailyCaps = view ? { amDailyCap: view.rules.amDailyCap, pmDailyCap: view.rules.pmDailyCap } : { amDailyCap: 0, pmDailyCap: 0 };
  const monthPassed = view ? monthEndOf(view.monthStart) < view.cairoToday : false;

  function weekEditable(week: MonthlyWeekView): boolean {
    if (!view || !view.viewerIsRep || !week.open) return false;
    if (week.status !== null && !isPlanEditable(week.status)) return false;
    // The month's own "has passed" does not close its last week, which runs into the next month.
    return view.blockedReason === null || monthPassed;
  }

  const states: WeekState[] = view
    ? view.weeks.map((week): WeekState => {
        const scope = weekScope(seatId, test, week.weekStart);
        const editable = weekEditable(week);
        const raw = drafts[scope] ?? null;
        const fits = editable && draftFits(raw, scope, week);
        const flag = holds[scope] ?? null;
        // A draft over a version it does not know is set aside — unless a save of this page failed or
        // crossed another, in which case it is HELD so the ticks are never lost. One that says exactly
        // what the week now holds is a save that went through.
        const heldOver = editable && !fits && raw !== null && flag !== null && !matchesSavedWeek(raw, week);
        const draft = fits || heldOver ? raw : null;
        const items = draft ? draft.items : editable ? savedWeekItems(week) : [];
        const activities = draft ? draft.activities : editable ? savedWeekActivities(week) : [];
        const dirty = heldOver || (fits && isWeekDirty(draft, week));
        return {
          week,
          scope,
          editable,
          draft,
          hold: heldOver ? "changed" : dirty && flag === "unchecked" ? "unchecked" : null,
          // The hold answered itself: the save landed after all, so nothing is asked and nothing is kept.
          settled: holdSettled(raw, week, flag !== null),
          items,
          activities,
          dirty,
          fixes: editable ? weekFixes(week, items, byId) : 0,
          problems: editable ? weekProblems(week, items, byId, caps) : [],
        };
      })
    : [];

  // A save whose answer was lost turned out to have LANDED: the reload says exactly what the draft
  // says. Its hold goes with its draft, or the rep's next tick is added to a draft standing over a
  // version that is gone — which reaches him as "this week changed since you started", raised against
  // his own save, and `readyToSave` then refuses to save at all. Answered while rendering, like
  // "+ Make weekly plan" above: it settles in one pass, since a dropped draft has nothing left to
  // settle.
  const settled = states.filter((state) => state.settled).map((state) => state.scope);
  if (settled.length > 0) {
    setDrafts((previous) => settled.reduce((record, scope) => withoutKey(record, scope), previous));
    setHolds((previous) => settled.reduce((record, scope) => withoutKey(record, scope), previous));
  }

  const anyDirty = states.some((state) => state.dirty);
  const needsSave = states.filter((state) => state.dirty || state.fixes > 0);

  // The week "+ Make weekly plan" opens: this month's first week still to plan, or — when this month
  // has none left and nothing here is unsaved — the next month's, once that month is on screen.
  if (weekSearch && view && !resource.loading && (weekSearch.movedTo === null || monthKeyOf(view.monthStart) === weekSearch.movedTo)) {
    const move = weekToPlanMove({
      weeks: view.weeks,
      monthStart: view.monthStart,
      months: view.months,
      mayChangeMonth: weekSearch.movedTo === null && !anyDirty,
    });
    if (move.kind === "month") {
      const monthKey = monthKeyOf(move.monthStart);
      setWeekSearch({ movedTo: monthKey });
      setMonth(monthKey);
      setWeekStart(null);
      setDay(null);
    } else {
      setWeekSearch(null);
      if (move.kind === "week") {
        setWeekStart(move.week.weekStart);
        setDay(null);
        setScrollNonce((current) => current + 1);
      }
    }
  }

  const firstToPlan = view ? firstWeekToPlan(view.weeks) : null;
  const selected =
    states.find((state) => state.week.weekStart === weekStart) ??
    states.find((state) => state.week.weekStart === firstToPlan?.weekStart) ??
    states[0] ??
    null;
  const selectedDay = selected ? (selected.week.days.find((entry) => entry.date === day) ?? firstDayToPlan(selected.week.days)) : null;

  useEffect(() => {
    onDirtyChange?.(anyDirty);
  }, [anyDirty, onDirtyChange]);

  // A full page unload is the one way out the draft cannot survive, so the browser asks first. Only
  // while something is unsaved: a listener left attached keeps the page out of the back/forward cache.
  useEffect(() => {
    if (!anyDirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [anyDirty]);

  // The week "+ Make weekly plan" opened, brought into view.
  useEffect(() => {
    if (scrollNonce === 0) return;
    weekRef.current?.scrollIntoView({ block: "start" });
  }, [scrollNonce]);

  function scrollToTop() {
    const top = topRef.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  }

  /** A failure is scrolled into view; a success leaves the rep where he was working. */
  function show(next: Notice | null) {
    setNotice(next);
    if (next?.tone === "bad") scrollToTop();
  }

  // ── Changing a week's draft ───────────────────────────────────────────────────────────────────

  function change(state: WeekState, update: (draft: WeekDraft) => Pick<WeekDraft, "items" | "activities">) {
    if (!state.editable || locked) return;
    setDrafts((previous) => {
      const current = previous[state.scope];
      const keep = current !== undefined && (draftFits(current, state.scope, state.week) || holds[state.scope] !== undefined);
      const base = keep ? current : (state.draft ?? startDraft(state.scope, state.week));
      return { ...previous, [state.scope]: { ...base, ...update(base) } };
    });
  }

  function place(state: WeekState, item: PlanItemDraft) {
    change(state, (draft) => ({ items: placeCustomer(draft.items, item), activities: draft.activities }));
  }

  function remove(state: WeekState, date: string, customerId: string) {
    change(state, (draft) => ({ items: takeOffCustomer(draft.items, date, customerId), activities: draft.activities }));
  }

  function planActivity(state: WeekState, date: string, next: Omit<PlannedActivity, "planDate"> | null) {
    change(state, (draft) => ({ items: draft.items, activities: setPlannedActivity(draft.activities, date, next) }));
  }

  /** A copy fills the drafts of the weeks it reached — it never saves and never sends. */
  function addCopies(placements: CopiedPlacements) {
    for (const [copiedWeek, additions] of placements) {
      const state = states.find((entry) => entry.week.weekStart === copiedWeek);
      if (state) change(state, (draft) => ({ items: addCopiedItems(draft.items, additions), activities: draft.activities }));
    }
  }

  function keepMine(state: WeekState) {
    const held = state.draft;
    if (!held) return;
    setDrafts((previous) => ({ ...previous, [state.scope]: rebaseDraft(previous[state.scope] ?? held, state.week) }));
    setHolds((previous) => withoutKey(previous, state.scope));
    setNotice(null);
  }

  function showLatest(state: WeekState) {
    setDrafts((previous) => withoutKey(previous, state.scope));
    setHolds((previous) => withoutKey(previous, state.scope));
    setNotice(null);
  }

  /** Every unsaved week of the month goes back to what was last saved. */
  function discardAll() {
    setDrafts((previous) => {
      const next = { ...previous };
      for (const state of states) {
        const draft = next[state.scope];
        if (!draft) continue;
        const back = discardWeekDraft(draft, state.week);
        if (back) next[state.scope] = back;
        else delete next[state.scope];
      }
      return next;
    });
    setHolds({});
    setShowProblems(false);
    setNotice(null);
  }

  // ── Saving ────────────────────────────────────────────────────────────────────────────────────

  function refusedSave(state: WeekState, error: unknown) {
    const code = errorCodeOf(error);
    const name = `Week ${state.week.weekNumber}`;
    if (code !== null && MAY_HAVE_SAVED.has(code)) {
      setHolds((previous) => ({ ...previous, [state.scope]: "unchecked" }));
      show({ tone: "warn", title: `Phoenix could not confirm that ${name} was saved`, message: `${messageOf(error)} Your ticks are kept on this page.` });
      resource.reload();
      return;
    }
    if (code !== null && PLAN_RELOAD_CODES.has(code)) {
      setHolds((previous) => ({ ...previous, [state.scope]: "changed" }));
      show({ tone: "bad", title: `${name} was not saved`, message: `${RELOADED_MESSAGES[code] ?? messageOf(error)} Your ticks are kept on this page.` });
      resource.reload();
      return;
    }
    show({ tone: "bad", title: `${name} was not saved`, message: messageOf(error) });
  }

  /** One week through the ordinary weekly save. Null when it was refused (and the refusal is on screen). */
  async function saveOne(state: WeekState): Promise<SavedPlan | null> {
    if (!view) return null;
    const payload = buildWeekSavePayload({ seatId, test, week: state.week, draft: state.draft, customers: view.customers });
    try {
      const saved = await crmPost<SavedPlan>("/api/phoenix-crm/plans", payload, "plan");
      setDrafts((previous) => ({ ...previous, [state.scope]: markWeekSaved(state.scope, state.week, saved, payload.items, payload.activities) }));
      setHolds((previous) => withoutKey(previous, state.scope));
      return saved;
    } catch (error) {
      refusedSave(state, error);
      return null;
    }
  }

  /** Stops before anything leaves the page when a week needs a choice or a fix first. */
  function readyToSave(targets: ReadonlyArray<WeekState>): boolean {
    const held = targets.find((state) => state.hold === "changed");
    if (held) {
      setWeekStart(held.week.weekStart);
      show({
        tone: "bad",
        title: "Choose what to keep first",
        message: `Week ${held.week.weekNumber} changed since you started. Keep your ticks or show the saved week, then save.`,
      });
      return false;
    }
    const withProblems = targets.find((state) => state.problems.length > 0);
    if (withProblems) {
      setShowProblems(true);
      setWeekStart(withProblems.week.weekStart);
      setDay(withProblems.problems[0].date);
      show({
        tone: "bad",
        title: `Week ${withProblems.week.weekNumber} needs a fix before saving`,
        message: problemText(withProblems.problems[0]),
      });
      return false;
    }
    return true;
  }

  /** Every week with unsaved ticks, one at a time. Stops at the first refusal and keeps the rest. */
  async function saveWeeks(targets: ReadonlyArray<WeekState>): Promise<boolean> {
    if (!view || locked) return false;
    const pending = targets.filter((state) => state.editable && (state.dirty || state.fixes > 0));
    if (pending.length === 0) return true;
    if (!readyToSave(pending)) return false;
    setBusy({ kind: "save" });
    setNotice(null);
    setShowProblems(false);
    const saved: number[] = [];
    let fixed = 0;
    try {
      for (const state of pending) {
        if (!(await saveOne(state))) {
          if (saved.length > 0) onChanged?.();
          return false;
        }
        saved.push(state.week.weekNumber);
        fixed += state.fixes;
      }
      show({
        tone: "good",
        title: `${weeksText(saved)} saved`,
        message: fixed > 0 ? `${plural(fixed, "planned customer was", "planned customers were")} updated to the list as it is now.` : null,
      });
      onChanged?.();
      resource.reload();
      return true;
    } finally {
      setBusy(null);
    }
  }

  // ── A week's own buttons ──────────────────────────────────────────────────────────────────────

  async function sendWeek(state: WeekState) {
    if (!view || locked || !state.editable) return;
    if (!readyToSave([state])) return;
    const saveFirst = state.dirty || state.fixes > 0 || state.week.plan === null;
    const name = `Week ${state.week.weekNumber}`;
    setBusy({ kind: "week", weekStart: state.week.weekStart, action: "send" });
    setNotice(null);
    setShowProblems(false);
    try {
      let planId = state.draft?.saved?.planId ?? state.week.plan?.planId ?? null;
      let version = state.draft?.saved?.version ?? state.week.plan?.version ?? null;
      if (saveFirst) {
        const saved = await saveOne(state);
        if (!saved) return;
        planId = saved.planId;
        version = saved.version;
      }
      if (planId === null || version === null) {
        show({ tone: "bad", title: `${name} was not sent`, message: "Reload the plan, then send it again." });
        return;
      }
      try {
        await crmPost<unknown>("/api/phoenix-crm/plans/submit", { planId, action: "submit", expectedVersion: version }, "plan");
      } catch (error) {
        show({ tone: "bad", title: saveFirst ? `${name} was saved but not sent` : `${name} was not sent`, message: messageOf(error) });
        onChanged?.();
        resource.reload();
        return;
      }
      show({ tone: "good", title: `${name} sent for review`, message: reviewerSentence(view) });
      onChanged?.();
      resource.reload();
    } finally {
      setBusy(null);
    }
  }

  async function reopenWeek(state: WeekState) {
    const plan = state.week.plan;
    if (!view || !plan || locked) return;
    const name = `Week ${state.week.weekNumber}`;
    setBusy({ kind: "week", weekStart: state.week.weekStart, action: "reopen" });
    setNotice(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/plans/submit", { planId: plan.planId, action: "reopen", expectedVersion: plan.version }, "plan");
      show({ tone: "info", title: `${name} taken back`, message: "Change it, save it, and send it for review again." });
      onChanged?.();
      resource.reload();
    } catch (error) {
      const code = errorCodeOf(error);
      show({ tone: "bad", title: `${name} was not taken back`, message: messageOf(error) });
      if (code !== null && PLAN_RELOAD_CODES.has(code)) resource.reload();
    } finally {
      setBusy(null);
    }
  }

  /** The reviewer's decision on one week — only ever called from its own Approve or Return button. */
  async function decideWeek(state: WeekState, action: PlanDecisionAction, note: string): Promise<boolean> {
    const plan = state.week.plan;
    if (!view || !plan || locked) return false;
    const name = `Week ${state.week.weekNumber}`;
    setBusy({ kind: "week", weekStart: state.week.weekStart, action });
    setNotice(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/plans/decide", { planId: plan.planId, action, expectedVersion: plan.version, note: note || null }, "plan");
      show({
        tone: "good",
        title: action === "return" ? `${name} returned for changes` : `${name} approved`,
        message: view.isTest ? "This is a test plan, so nobody is notified." : "The rep is notified.",
      });
      onChanged?.();
      resource.reload();
      return true;
    } catch (error) {
      const code = errorCodeOf(error);
      show({ tone: "bad", title: action === "return" ? `${name} was not returned` : `${name} was not approved`, message: messageOf(error) });
      if (code !== null && PLAN_RELOAD_CODES.has(code)) resource.reload();
      return false;
    } finally {
      setBusy(null);
    }
  }

  // ── The month's own buttons ───────────────────────────────────────────────────────────────────

  async function transitionMonth(action: "send" | "reopen") {
    if (!view || locked) return;
    // The month goes with every week's latest ticks, so they are saved first.
    if (action === "send" && needsSave.length > 0 && !(await saveWeeks(needsSave))) return;
    setBusy({ kind: "month", action });
    setNotice(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/monthly-plans", { seatId, test, month: view.monthStart, action: action === "send" ? "submit" : "reopen" }, "plan");
      show(
        action === "send"
          ? { tone: "good", title: "Month sent for review", message: `Every week goes with it. ${reviewerSentence(view)}` }
          : { tone: "info", title: "Month taken back", message: "Change any week, then send the month for review again." },
      );
      onChanged?.();
      resource.reload();
    } catch (error) {
      show({ tone: "bad", title: action === "send" ? "The month was not sent" : "The month was not taken back", message: messageOf(error) });
      resource.reload();
    } finally {
      setBusy(null);
    }
  }

  /** The reviewer's decision on the month — only ever called from its own Approve or Return button. */
  async function decideMonth(action: PlanDecisionAction, note: string): Promise<boolean> {
    if (!view?.plan || locked) return false;
    const { plan } = view;
    setBusy({ kind: "month", action });
    setNotice(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/monthly-plans/reviews",
        { monthlyPlanId: plan.monthlyPlanId, action, expectedVersion: plan.version, note: note || null },
        "plan",
      );
      show({
        tone: "good",
        title: action === "return" ? "Month returned for changes" : "Month approved",
        message: view.isTest ? "This is a test plan, so nobody is notified." : "The rep is notified.",
      });
      onChanged?.();
      resource.reload();
      return true;
    } catch (error) {
      show({ tone: "bad", title: action === "return" ? "The month was not returned" : "The month was not approved", message: messageOf(error) });
      resource.reload();
      return false;
    } finally {
      setBusy(null);
    }
  }

  // ── Moving about ──────────────────────────────────────────────────────────────────────────────

  function openMonth(monthKey: string) {
    setMonth(monthKey);
    setWeekStart(null);
    setDay(null);
    setNotice(null);
    setShowProblems(false);
    setLeaving(null);
    setMonthConfirm(null);
  }

  function chooseMonth(next: string) {
    if (!view || locked) return;
    const monthKey = monthKeyOf(next);
    if (monthKey === monthKeyOf(view.monthStart)) return;
    if (anyDirty) {
      setLeaving({ kind: "month", monthKey });
      return;
    }
    openMonth(monthKey);
  }

  function chooseWeek(next: string) {
    setWeekStart(next);
    setDay(null);
  }

  function requestBack() {
    if (!onBack || locked) return;
    if (anyDirty) {
      setLeaving({ kind: "back" });
      return;
    }
    onBack.onBack();
  }

  function proceed(target: Leaving) {
    setLeaving(null);
    if (target.kind === "month") openMonth(target.monthKey);
    else onBack?.onBack();
  }

  async function leave(choice: "save" | "discard" | "stay") {
    const target = leaving;
    if (choice === "stay" || target === null) {
      setLeaving(null);
      return;
    }
    if (choice === "discard") {
      discardAll();
      proceed(target);
      return;
    }
    if (await saveWeeks(needsSave)) proceed(target);
  }

  // ── The page ──────────────────────────────────────────────────────────────────────────────────

  if (!view) {
    return (
      <div className="min-w-0 scroll-mt-24" ref={topRef}>
        <CrmPanel eyebrow="Plan" title="Plan">
          {onBack ? <CrmBackBar backLabel={onBack.label} onBack={onBack.onBack} title="Plan" /> : null}
          {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the plan" />}
        </CrmPanel>
      </div>
    );
  }

  const { plan } = view;
  const status = plan?.status ?? null;
  const showSpread = !view.viewerIsRep || view.viewerIsReviewer;
  const editableStates = states.filter((state) => state.editable);
  const anyPlaced = view.amMeter.placements + view.pmMeter.placements > 0 || states.some((state) => state.items.length > 0);
  const bricks = plannerBricks(view.customers);
  const tints = brickTintMap(bricks.map((brick) => brick.value));
  const filterOptions = {
    bricks: bricks.map((brick) => ({ value: brick.value, label: `Brick ${brick.label}` })),
    grades: plannerGrades(view.customers),
    specialities: plannerSpecialities(view.customers),
  };
  const monthBusy = busy?.kind === "month" ? busy.action : null;
  const weekBusy = busy?.kind === "week" && selected && busy.weekStart === selected.week.weekStart ? busy.action : null;
  // The two suggestions, on the rep's own plan only: the month so far with his unsaved ticks in it, the
  // weeks still open from the one on screen, so a customer is spread over them rather than bunched, and
  // his daily call-rate target, which a suggestion fills a day to (never past the cap).
  const suggest: SuggestContext | null =
    view.viewerIsRep && selected
      ? {
          gradeTargets: view.rules.gradeTargets,
          dayTargets: { am: view.callRate.amTarget, pm: view.callRate.pmTarget },
          placedThisMonth: monthPlacements(states.map((state) => ({ week: state.week, items: state.editable ? state.items : null }))),
          weeksLeft: Math.max(1, editableStates.filter((state) => state.week.weekStart >= selected.week.weekStart).length),
        }
      : null;

  const monthFacts: Array<{ label: string; value: string }> = [
    { label: "Due", value: view.dueOnLabel },
    { label: "Reviewer", value: view.isTest ? "You (test entries)" : (view.territory.reviewerName ?? "No manager above this territory") },
  ];
  if (plan?.submittedAt) {
    monthFacts.push({ label: "Last sent for review", value: `${cairoStamp(plan.submittedAt)}${plan.submittedByName ? ` · ${plan.submittedByName}` : ""}` });
  }
  if (plan?.decidedAt && (status === "approved" || status === "returned")) {
    monthFacts.push({
      label: status === "approved" ? "Approved" : "Returned",
      value: `${cairoStamp(plan.decidedAt)}${plan.decidedByName ? ` · ${plan.decidedByName}` : ""}${plan.decidedBySfe ? " (SFE Manager)" : ""}`,
    });
  }

  return (
    <div className="min-w-0 scroll-mt-24" ref={topRef}>
      <CrmPanel description={territoryLine(view.territory)} eyebrow={view.isTest ? "Plan · test entries" : "Plan"} title={view.monthLabel}>
        {onBack ? <CrmBackBar backLabel={onBack.label} onBack={requestBack} title={`${view.territory.name} · ${view.monthLabel}`} /> : null}

        {notice || resource.error || leaving ? (
          <div className="grid min-w-0 gap-2 px-4 pt-4 sm:px-5">
            {notice ? (
              <CrmNote title={notice.title} tone={notice.tone}>
                {notice.message}
              </CrmNote>
            ) : null}
            {resource.error ? (
              <CrmNote title="The plan on screen may be out of date" tone="bad">
                <span className="block">{resource.error}</span>
                <span className="mt-2 block">
                  <CrmButton onClick={resource.reload} size="sm">
                    Try again
                  </CrmButton>
                </span>
              </CrmNote>
            ) : null}
            {leaving ? (
              <CrmNote title="Your ticks are not saved" tone="warn">
                <span className="block">
                  {leaving.kind === "month" ? "Save them before opening another month, or leave them behind." : "Save them before going back, or leave them behind."}
                </span>
                <span className="mt-2 grid gap-2 sm:flex sm:flex-wrap">
                  <CrmButton busy={busy?.kind === "save"} disabled={locked} onClick={() => void leave("save")} size="sm" variant="primary">
                    {leaving.kind === "month" ? "Save, then open the month" : "Save, then go back"}
                  </CrmButton>
                  <CrmButton disabled={locked} onClick={() => void leave("discard")} size="sm" variant="danger">
                    Leave them
                  </CrmButton>
                  <CrmButton disabled={busy?.kind === "save"} onClick={() => void leave("stay")} size="sm">
                    Stay here
                  </CrmButton>
                </span>
              </CrmNote>
            ) : null}
          </div>
        ) : null}

        <CrmBlock title="Month">
          <CrmChoice
            columns={4}
            label="Month"
            onChange={chooseMonth}
            options={view.months.map((option) => ({
              value: option.monthStart,
              label: option.label,
              note: option.statusLabel,
              disabled: locked && option.monthStart !== view.monthStart,
            }))}
            value={view.monthStart}
          />
        </CrmBlock>

        <CrmBlock
          actions={
            <span className="flex max-w-full flex-wrap gap-1">
              <CrmPill tone={PLAN_STATUS_TONE[status ?? "none"]}>{plan?.statusLabel ?? "Not started"}</CrmPill>
              {plan?.submittedLate ? <CrmPill tone="warn">Sent late</CrmPill> : null}
              {view.overdue ? <CrmPill tone="bad">Overdue</CrmPill> : null}
            </span>
          }
          className="border-t border-slate-100"
          title={`${view.monthLabel} · the month`}
        >
          <p className="break-words text-sm font-bold text-slate-800">Due {view.dueOnLabel}</p>
          <div className="mt-3">
            <CrmFacts facts={monthFacts} />
          </div>
          {/* The deadline, said once where he is working. Never a block: a late month is accepted and
              stamped. Only the rep is told he is behind — a manager reads the stamp instead. */}
          {view.viewerIsRep && view.overdue ? (
            <CrmNote className="mt-3" title={`This month was due ${view.dueOnLabel}`} tone="warn">
              Send it as soon as it is ready. It will still be accepted, and it will be marked as sent late.
            </CrmNote>
          ) : null}
          {plan?.submittedLate ? (
            <CrmNote className="mt-3" title="Sent late" tone="warn">
              This month was due {view.dueOnLabel} and was sent {plan.submittedAt ? cairoStamp(plan.submittedAt) : "after it"}.
            </CrmNote>
          ) : null}
          {plan?.decisionNote && (status === "returned" || status === "approved") ? (
            <CrmNote className="mt-3" title={status === "returned" ? "What to change" : "Manager's note"} tone={status === "returned" ? "warn" : "good"}>
              <span className="block whitespace-pre-line">{plan.decisionNote}</span>
            </CrmNote>
          ) : null}
          {view.viewerIsRep && view.blockedReason && editableStates.length === 0 ? (
            <CrmNote className="mt-3" tone="warn">
              {view.blockedReason}
            </CrmNote>
          ) : null}

          {view.canEdit ? (
            monthConfirm === "send" ? (
              <div className="mt-3 grid min-w-0 gap-2 border border-orange-200 bg-orange-50/40 px-3.5 py-3">
                <p className="text-sm font-black text-slate-950">Send the whole month for review?</p>
                <p className="break-words text-sm font-medium leading-6 text-slate-600">
                  Every week goes with it{needsSave.length > 0 ? `, and ${weeksText(needsSave.map((state) => state.week.weekNumber))} ${needsSave.length === 1 ? "is" : "are"} saved first` : ""}.{" "}
                  {reviewerSentence(view)} Until then, you can take it back to change it.
                </p>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  <CrmButton
                    busy={monthBusy === "send" || busy?.kind === "save"}
                    disabled={locked}
                    onClick={() => {
                      setMonthConfirm(null);
                      void transitionMonth("send");
                    }}
                    variant="primary"
                  >
                    Send the month
                  </CrmButton>
                  <CrmButton disabled={monthBusy === "send"} onClick={() => setMonthConfirm(null)}>
                    Not yet
                  </CrmButton>
                </div>
              </div>
            ) : (
              <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap sm:items-center">
                <CrmButton busy={monthBusy === "send"} disabled={locked || !anyPlaced} onClick={() => setMonthConfirm("send")} variant="primary">
                  {status === "returned" ? "Send the month again" : "Send the month"}
                </CrmButton>
                {!anyPlaced ? <span className="text-xs font-semibold leading-5 text-slate-500">Place at least one customer on a day before sending the month.</span> : null}
              </div>
            )
          ) : null}

          {view.canReopen && plan ? (
            monthConfirm === "reopen" ? (
              <div className="mt-3 grid min-w-0 gap-2 border border-slate-200 bg-slate-50 px-3.5 py-3">
                <p className="text-sm font-black text-slate-950">Take the month back?</p>
                <p className="break-words text-sm font-medium leading-6 text-slate-600">
                  {status === "approved"
                    ? "It is approved. Taking it back makes every week a draft again, and they need a new approval once you send them."
                    : "It leaves the manager's review until you send it again."}
                </p>
                <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                  <CrmButton
                    busy={monthBusy === "reopen"}
                    disabled={locked}
                    onClick={() => {
                      setMonthConfirm(null);
                      void transitionMonth("reopen");
                    }}
                    variant="danger"
                  >
                    Take it back
                  </CrmButton>
                  <CrmButton disabled={monthBusy === "reopen"} onClick={() => setMonthConfirm(null)}>
                    {status === "approved" ? "Keep it approved" : "Keep it sent"}
                  </CrmButton>
                </div>
              </div>
            ) : (
              <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
                <CrmButton busy={monthBusy === "reopen"} disabled={locked} onClick={() => setMonthConfirm("reopen")}>
                  Take the month back to change it
                </CrmButton>
              </div>
            )
          ) : null}
        </CrmBlock>

        <CrmBlock className="border-t border-slate-100" title="This month">
          <MeterStrip view={view} />
          <div className="hidden md:block">
            <CrmStatGrid>
              <CrmStat label="AM covered" note={`${countText(view.amMeter.covered)} of ${countText(view.amMeter.panel)} placed`} value={pctText(view.amMeter.coveragePct)} />
              <CrmStat
                label="AM frequency"
                note={`${countText(view.amMeter.metNorm)} of ${countText(view.amMeter.withNorm)} at the grade`}
                tone={view.amMeter.underNorm > 0 ? "warn" : "neutral"}
                value={pctText(view.amMeter.frequencyPct)}
              />
              <CrmStat label="PM covered" note={`${countText(view.pmMeter.covered)} of ${countText(view.pmMeter.panel)} placed`} value={pctText(view.pmMeter.coveragePct)} />
              <CrmStat
                label="PM frequency"
                note={`${countText(view.pmMeter.metNorm)} of ${countText(view.pmMeter.withNorm)} at the grade`}
                tone={view.pmMeter.underNorm > 0 ? "warn" : "neutral"}
                value={pctText(view.pmMeter.frequencyPct)}
              />
            </CrmStatGrid>
            {/* The call rate is AM against its target and PM against its own, side by side — never one averaged figure. */}
            <CrmStatGrid className="mt-2">
              <CrmStat
                label="AM per day"
                note={`Target ${countText(view.callRate.amTarget)} · ${countText(view.callRate.workingDays)} working days`}
                tone={view.callRate.amPerDay !== null && view.callRate.amPerDay < view.callRate.amTarget ? "warn" : "neutral"}
                value={view.callRate.amPerDay === null ? "—" : String(view.callRate.amPerDay)}
              />
              <CrmStat label="AM placed" note={`Of ${countText(view.callRate.amExpected)} at the target`} value={countText(view.callRate.amPlacements)} />
              <CrmStat
                label="PM per day"
                note={`Target ${countText(view.callRate.pmTarget)} · ${countText(view.callRate.workingDays)} working days`}
                tone={view.callRate.pmPerDay !== null && view.callRate.pmPerDay < view.callRate.pmTarget ? "warn" : "neutral"}
                value={view.callRate.pmPerDay === null ? "—" : String(view.callRate.pmPerDay)}
              />
              <CrmStat label="PM placed" note={`Of ${countText(view.callRate.pmExpected)} at the target`} value={countText(view.callRate.pmPlacements)} />
            </CrmStatGrid>
          </div>
          {view.amMeter.overNorm + view.pmMeter.overNorm > 0 ? (
            <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">
              {countText(view.amMeter.overNorm)} AM and {countText(view.pmMeter.overNorm)} PM planned over the grade — allowed, shown as a deviation.
            </p>
          ) : null}
          {anyDirty ? <p className="mt-2 break-words text-xs font-semibold leading-5 text-slate-500">These count what is saved. Save to see your latest ticks in them.</p> : null}
        </CrmBlock>

        {editableStates.length > 0 ? (
          <CrmBlock className="border-t border-slate-100" title="Copy last month">
            <PlanCopyMenu
              caps={caps}
              customers={view.customers}
              disabled={locked}
              key={view.monthStart}
              onPlace={addCopies}
              scope={{ kind: "month", monthStart: view.monthStart, weeks: editableStates.map((state) => ({ week: state.week, items: state.items })) }}
              seatId={seatId}
              test={test}
            />
          </CrmBlock>
        ) : null}

        {/* Owner, 2026-09-22: information, never a refusal — a customer not validated yet is planned as he is. */}
        {view.pendingCount > 0 && view.viewerIsRep ? (
          <CrmBlock className="border-t border-slate-100">
            <CrmNote tone="info" title={`${countText(view.pendingCount)} not validated yet`}>
              <span className="block">{pendingListNote(view.pendingCount)}</span>
              {onOpenList ? (
                <span className="mt-2 block">
                  <CrmButton onClick={onOpenList} size="sm">
                    Open the list
                  </CrmButton>
                </span>
              ) : null}
            </CrmNote>
          </CrmBlock>
        ) : null}

        <CrmBlock className="border-t border-slate-100" title="Weeks">
          {states.length === 0 ? (
            <p className="text-sm font-medium text-slate-500">This month has no field-week.</p>
          ) : (
            <CrmChoice
              columns={4}
              label="Week"
              onChange={chooseWeek}
              options={states.map((state) => ({
                value: state.week.weekStart,
                label: <ChoiceLabel chosen={state.week.weekStart === selected?.week.weekStart}>Week {state.week.weekNumber}</ChoiceLabel>,
                note: [
                  state.week.statusLabel,
                  `due ${dayLabel(state.week.dueOn)}`,
                  state.week.plan?.submittedLate ? "sent late" : null,
                  state.week.overdue ? "overdue" : null,
                  state.dirty ? "unsaved" : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              }))}
              value={selected?.week.weekStart ?? null}
            />
          )}
        </CrmBlock>

        <div className="min-w-0 scroll-mt-24" ref={weekRef}>
          {selected && selectedDay ? (
            <PlanWeekPanel
              activities={selected.activities}
              busy={weekBusy}
              caps={caps}
              customers={view.customers}
              dirty={selected.dirty}
              editable={selected.editable}
              filter={filter}
              filterOptions={filterOptions}
              hold={selected.hold}
              idPrefix={idPrefix}
              items={selected.items}
              key={selected.week.weekStart}
              locked={locked}
              onActivity={(date, next) => planActivity(selected, date, next)}
              onCopied={addCopies}
              onDay={setDay}
              onDecide={(action, note) => decideWeek(selected, action, note)}
              onFilter={setFilter}
              onKeepMine={() => keepMine(selected)}
              onPlace={(item) => place(selected, item)}
              onQuery={setQuery}
              onRemove={(date, customerId) => remove(selected, date, customerId)}
              onReopen={() => void reopenWeek(selected)}
              onSend={() => void sendWeek(selected)}
              onShowLatest={() => showLatest(selected)}
              problems={selected.problems}
              query={query}
              reviewerSentence={reviewerSentence(view)}
              seatId={seatId}
              selectedDay={selectedDay}
              showProblems={showProblems}
              showSpread={showSpread}
              suggest={suggest}
              test={test}
              tints={tints}
              today={view.cairoToday}
              viewerIsRep={view.viewerIsRep}
              week={selected.week}
            />
          ) : null}
        </div>

        {plan ? (
          <PlanDecision
            approved={status === "approved"}
            busy={decisionBusy(monthBusy)}
            canApprove={view.canApprove}
            canReturn={view.canReturn}
            idPrefix={idPrefix}
            key={`${plan.monthlyPlanId}|${plan.version}`}
            locked={locked}
            onDecide={decideMonth}
            subject="month"
          />
        ) : null}
      </CrmPanel>

      {needsSave.length > 0 ? (
        <SaveBar
          busy={busy?.kind === "save"}
          dirty={anyDirty}
          blocked={needsSave.some((state) => state.hold === "changed")}
          fixes={needsSave.reduce((sum, state) => sum + state.fixes, 0)}
          locked={locked}
          onDiscard={discardAll}
          onSave={() => void saveWeeks(needsSave)}
          weeks={weeksText(needsSave.map((state) => state.week.weekNumber))}
        />
      ) : null}
    </div>
  );
}

// ── The month's meters on a phone ───────────────────────────────────────────────────────────────

/** One figure of the phone strip: the label, the value, and the note under it. */
function MeterLine({ label, note, tone = "neutral", value }: { label: string; note: string; tone?: Tone; value: string }) {
  return (
    <div className="min-w-0 border-t border-slate-100 py-2 first:border-t-0 first:pt-0">
      <p className="break-words text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className={cn("mt-0.5 break-words text-lg font-black leading-tight", tone === "warn" ? "text-amber-700" : "text-slate-950")}>{value}</p>
      <p className="break-words text-xs font-semibold leading-5 text-slate-500">{note}</p>
    </div>
  );
}

/**
 * The eight month cards, folded for a phone into two columns — AM on the left, PM on the right — so the
 * month reads in one glance instead of four rows of cards. Every figure the desktop shows is here, and
 * the two lists are never added together (the call-rate golden rule).
 */
function MeterStrip({ view }: { view: MonthlyPlannerView }) {
  const lists: ReadonlyArray<PhoenixCrmListType> = ["AM", "PM"];
  return (
    <div className="grid grid-cols-2 gap-2 md:hidden">
      {lists.map((listType) => {
        const meter = listType === "AM" ? view.amMeter : view.pmMeter;
        const perDay = listType === "AM" ? view.callRate.amPerDay : view.callRate.pmPerDay;
        const target = listType === "AM" ? view.callRate.amTarget : view.callRate.pmTarget;
        const placements = listType === "AM" ? view.callRate.amPlacements : view.callRate.pmPlacements;
        const expected = listType === "AM" ? view.callRate.amExpected : view.callRate.pmExpected;
        return (
          <div className="min-w-0 border border-l-[3px] border-slate-200/80 border-l-orange-500 bg-white px-3 py-2.5" key={listType}>
            <p className="text-sm font-black text-slate-950">{listType}</p>
            <div className="mt-1.5 grid min-w-0">
              <MeterLine label="Covered" note={`${countText(meter.covered)} of ${countText(meter.panel)} placed`} value={pctText(meter.coveragePct)} />
              <MeterLine
                label="Frequency"
                note={`${countText(meter.metNorm)} of ${countText(meter.withNorm)} at the grade`}
                tone={meter.underNorm > 0 ? "warn" : "neutral"}
                value={pctText(meter.frequencyPct)}
              />
              <MeterLine
                label="Per day"
                note={`Target ${countText(target)} · ${countText(view.callRate.workingDays)} working days`}
                tone={perDay !== null && perDay < target ? "warn" : "neutral"}
                value={perDay === null ? "—" : String(perDay)}
              />
              <MeterLine label="Placed" note={`Of ${countText(expected)} at the target`} value={countText(placements)} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── The save bar ────────────────────────────────────────────────────────────────────────────────

function SaveBar({
  blocked,
  busy,
  dirty,
  fixes,
  locked,
  onDiscard,
  onSave,
  weeks,
}: {
  /** A week changed under its ticks: the rep chooses what to keep before anything is saved. */
  blocked: boolean;
  busy: boolean;
  dirty: boolean;
  /** Planned customers the save changes by itself (left the list, or moved place). */
  fixes: number;
  locked: boolean;
  onDiscard: () => void;
  onSave: () => void;
  /** "Week 2 and Week 3". */
  weeks: string;
}) {
  const fixesText =
    fixes > 0 ? `${plural(fixes, "planned customer", "planned customers")} ${fixes === 1 ? "is" : "are"} brought up to date with the list when you save.` : null;

  return (
    // Held above the portal's bottom bar on phones (the app sets --crm-sticky-bottom to its height).
    <div className="sticky bottom-[var(--crm-sticky-bottom,0px)] z-20 mt-3 border border-orange-300 bg-white px-4 py-3 shadow-[0_-10px_30px_rgba(15,23,42,0.12)] sm:px-5 lg:bottom-0">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <p className="break-words text-sm font-black text-slate-950">{dirty ? `Unsaved changes · ${weeks}` : `The plan needs saving · ${weeks}`}</p>
          {/*
           * Both lines, never one instead of the other: what Discard changes will do is said BEFORE it is
           * pressed, because there is no second press left to say it in, and the fixes sentence still has
           * to reach a week that is unsaved AND out of date with the list — which is most of them.
           */}
          {fixesText ? <p className="break-words text-xs font-semibold leading-5 text-slate-500">{fixesText}</p> : null}
          {dirty ? (
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">Discard changes puts each week back to what was last saved.</p>
          ) : null}
        </div>
        <div className={cn("grid w-full gap-2 sm:flex sm:w-auto", dirty ? "grid-cols-2" : undefined)}>
          {/*
           * ONE press, on the owner's own instruction (2026-09-30): it used to ask "Discard your unsaved
           * ticks?" and wait for a second press, which is what he read as the button doing nothing — the
           * bar's wording changed and his ticks stayed. So the press discards, and it wears the danger
           * variant the confirm's own button wore, because it IS the destructive act now.
           */}
          {dirty ? (
            <CrmButton disabled={locked} onClick={onDiscard} variant="danger">
              Discard changes
            </CrmButton>
          ) : null}
          <CrmButton busy={busy} disabled={locked || blocked} onClick={onSave} variant="primary">
            Save
          </CrmButton>
        </div>
      </div>
    </div>
  );
}
