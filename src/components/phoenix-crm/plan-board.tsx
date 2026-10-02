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
 * A late week is ACCEPTED and STAMPED, never refused. Nothing here sends or approves on its own: every
 * send, request, approve and return is a press of its own button (and Send asks once more). A manager
 * reading his rep's plan gets the same board, read only, with Approve and Return.
 *
 * 🔴 Owner, 2026-10-01 — WEEKLY ONLY, after the first Delta (1) session: the board opened on
 * September, four reps pressed "Send the month" and were stamped late, and one planned a week that had
 * passed. On his OWN plan (opened from the Plan tab, not from Team) the rep now gets one path: the
 * month of his week, that ONE week active and every other week greyed, its days, its customers. No
 * month chooser, no month send, no Copy last month. A week he has sent changes only through "Ask to
 * edit this week" (the district manager, then SFE, then HR). The server refuses any other week too.
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
import { ChevronRight } from "lucide-react";

import { cairoStamp, countText, dayLabel, plural, weekLabel, type Tone } from "@/components/phoenix-crm/format";
import { pendingListNote, territoryLine } from "@/components/phoenix-crm/labels";
import type { CopiedPlacements, SuggestContext } from "@/components/phoenix-crm/plan-copy-menu";
import { decisionBusy, PlanDecision, type PlanDecisionAction } from "@/components/phoenix-crm/plan-decision";
import { ChoiceLabel, PLAN_STATUS_TONE, PlanWeekPanel, problemText, type WeekBusy, type WeekHold } from "@/components/phoenix-crm/plan-week-panel";
import { CrmStepFooter, CrmStepForm, CrmStepNext, crmStepBackClassName, type CrmStep } from "@/components/phoenix-crm/step-form";
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
import { monthKeyOf } from "@/lib/phoenix-crm/calendar";
import type { PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { setPlannedStart, type PlanDayStarts, type PlannedDayStart } from "@/lib/phoenix-crm/plan-day-starts";
import { EMPTY_DOCTOR_FILTER, plannerBricks, plannerGrades, plannerSpecialities, type DoctorFilter } from "@/lib/phoenix-crm/plan-filters";
import { isPlanEditable, type PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import { monthPlacements, suggestDay } from "@/lib/phoenix-crm/plan-suggest";
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
  savedWeekStarts,
  setPlannedActivity,
  startDraft,
  takeOffCustomer,
  weekFixes,
  weekProblems,
  weekScope,
  type DailyCaps,
  type DraftProblem,
  type PlannedActivity,
  type WeekContent,
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
  "phoenix_crm_plan_edit_already_open",
  "phoenix_crm_plan_edit_not_sent",
  "phoenix_crm_plan_not_found",
  "phoenix_crm_version_conflict",
  "phoenix_crm_week_passed",
]);

/** Answers a save can get when it landed and only its answer was lost. */
const MAY_HAVE_SAVED = new Set(["offline", "failed", "internal_error", "statement_timeout"]);

/** What happened, said once the board shows the latest plan (the server's own words ask for a reload). */
const RELOADED_MESSAGES: Record<string, string> = {
  phoenix_crm_version_conflict: "This week was changed on another screen.",
  phoenix_crm_not_editable: "This week was sent for review or approved on another screen.",
};

type Notice = { tone: NoteTone; title: string; message?: string | null };

type BoardBusy = { kind: "save" } | { kind: "month"; action: PlanDecisionAction } | { kind: "week"; weekStart: string; action: WeekBusy };

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
  starts: PlannedDayStart[];
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

/** "Week 2 and Week 3", or "First days, Week 1 and Week 2" — the weeks' own names, as the board shows them. */
function weeksText(names: ReadonlyArray<string>): string {
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
   * The portal's "+ Make weekly plan": each new positive value opens the rep's ONE week — the week he
   * plans now (owner, 2026-10-01) — and brings it into view. Nothing unsaved is dropped.
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
  const [seenNonce, setSeenNonce] = useState(0);
  // "+ Make weekly plan" asked for the rep's week; it is brought into view once the board is on screen.
  const [jumpToWeek, setJumpToWeek] = useState(false);
  const [scrollNonce, setScrollNonce] = useState(0);
  // The rep's step form (owner, 2026-10-02: Report It's form "used in visits entry and plans making"):
  // 1 the week, 2 its days, 3 one day's customers, 4 send. A board opened on one week starts on its days.
  const [planStep, setPlanStep] = useState(initialWeekStart ? 2 : 1);
  // Step 3 is two short screens, AM then PM (owner, 2026-10-02: "step 3 … too long, confusing").
  const [daySession, setDaySession] = useState<PhoenixCrmListType>("AM");
  // The days the step form has already filled with their suggestion this visit: a day is filled ONCE,
  // so a day he cleared on purpose stays clear when he comes back to it.
  const [filledDays, setFilledDays] = useState<ReadonlySet<string>>(() => new Set());
  const stepRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const weekRef = useRef<HTMLDivElement>(null);

  const resource = useCrmGet<MonthlyPlannerView>(crmUrl("/api/phoenix-crm/monthly-plans", { seatId, test, month }), "planner");
  const view = resource.data;
  const locked = busy !== null || resource.loading;

  // "+ Make weekly plan" asked again: answered while rendering, from the value seen last time — state
  // derived from a prop, never an effect. It goes back to the rep's one week (owner, 2026-10-01): the
  // board opens on it by default, so letting go of the week and the month on screen is the whole move.
  if (weekNonce !== seenNonce) {
    setSeenNonce(weekNonce);
    if (weekNonce > 0) {
      setMonth(null);
      setWeekStart(null);
      setDay(null);
      setPlanStep(2);
      setJumpToWeek(true);
    }
  }

  // ── The weeks, as the board holds them ────────────────────────────────────────────────────────
  const customers = view ? view.customers : [];
  const byId = indexCustomers(customers);
  const caps: DailyCaps = view ? { amDailyCap: view.rules.amDailyCap, pmDailyCap: view.rules.pmDailyCap } : { amDailyCap: 0, pmDailyCap: 0 };
  // 🔴 THE REP'S OWN PLAN — opened from his Plan tab, not from a manager's Team tab. It gets the one
  // path (owner, 2026-10-01): no month chooser, no month header, his one week active, the rest greyed.
  // Keyed on WHERE the board was opened, not on the role: the Super Admin's test board is both rep and
  // reviewer, and from Team he reviews.
  const repBoard = Boolean(view?.viewerIsRep) && !onBack;

  /** The rep ticks, saves and sends this week — the server's own answer (`repWeekState`), never a guess. */
  function weekEditable(week: MonthlyWeekView): boolean {
    return Boolean(view?.viewerIsRep) && week.canEdit && (week.status === null || isPlanEditable(week.status));
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
        const starts = draft ? draft.starts : editable ? savedWeekStarts(week) : [];
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
          starts,
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

  // "+ Make weekly plan" brings the rep's week into view once the board holding it is on screen.
  if (jumpToWeek && view && !resource.loading) {
    setJumpToWeek(false);
    setScrollNonce((current) => current + 1);
  }

  // The week the board opens on: the rep's ONE week on his own plan (owner, 2026-10-01); for a
  // reviewer, the first week still open and not sent.
  const firstToPlan = view
    ? ((view.viewerIsRep ? view.weeks.find((week) => week.weekStart === view.repWeek) : undefined) ?? firstWeekToPlan(view.weeks))
    : null;
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
    (weekRef.current ?? stepRef.current)?.scrollIntoView({ block: "start" });
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

  /**
   * One change to a week's draft, over the latest draft — never the one this render saw — so several in
   * one click (a whole brick ticked at once) apply in order and none is lost. A list the change leaves
   * out stays as it was.
   */
  function change(state: WeekState, update: (draft: WeekDraft) => Partial<WeekContent>) {
    if (!state.editable || locked) return;
    setDrafts((previous) => {
      const current = previous[state.scope];
      const keep = current !== undefined && (draftFits(current, state.scope, state.week) || holds[state.scope] !== undefined);
      const base = keep ? current : (state.draft ?? startDraft(state.scope, state.week));
      return { ...previous, [state.scope]: { ...base, ...update(base) } };
    });
  }

  function place(state: WeekState, item: PlanItemDraft) {
    change(state, (draft) => ({ items: placeCustomer(draft.items, item) }));
  }

  function remove(state: WeekState, date: string, customerId: string) {
    change(state, (draft) => ({ items: takeOffCustomer(draft.items, date, customerId) }));
  }

  function planActivity(state: WeekState, date: string, activityType: PhoenixCrmDayActivity, next: Pick<PlannedActivity, "halfDay" | "note"> | null) {
    change(state, (draft) => ({ activities: setPlannedActivity(draft.activities, date, activityType, next) }));
  }

  function planStarts(state: WeekState, date: string, next: PlanDayStarts) {
    change(state, (draft) => ({ starts: setPlannedStart(draft.starts, date, next) }));
  }

  /** A copy fills the drafts of the weeks it reached — it never saves and never sends. */
  function addCopies(placements: CopiedPlacements) {
    for (const [copiedWeek, additions] of placements) {
      const state = states.find((entry) => entry.week.weekStart === copiedWeek);
      if (state) change(state, (draft) => ({ items: addCopiedItems(draft.items, additions) }));
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
    const name = state.week.label;
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
      setDrafts((previous) => ({ ...previous, [state.scope]: markWeekSaved(state.scope, state.week, saved, payload) }));
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
        message: `${held.week.label} changed since you started. Keep your ticks or show the saved week, then save.`,
      });
      return false;
    }
    const withProblems = targets.find((state) => state.problems.length > 0);
    if (withProblems) {
      setShowProblems(true);
      setWeekStart(withProblems.week.weekStart);
      setDay(withProblems.problems[0].date);
      setPlanStep(3);
      show({
        tone: "bad",
        title: `${withProblems.week.label} needs a fix before saving`,
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
    const saved: string[] = [];
    let fixed = 0;
    try {
      for (const state of pending) {
        if (!(await saveOne(state))) {
          if (saved.length > 0) onChanged?.();
          return false;
        }
        saved.push(state.week.label);
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
    const name = state.week.label;
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

  /**
   * "Ask to edit this week" (owner, 2026-10-01): a sent week is no longer taken back by the rep. The
   * request goes to his district manager, then SFE, then HR — and only HR's acknowledgement opens it.
   */
  async function askToEdit(state: WeekState) {
    const plan = state.week.plan;
    if (!view || !plan || locked) return;
    const name = state.week.label;
    setBusy({ kind: "week", weekStart: state.week.weekStart, action: "ask" });
    setNotice(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/plans/edit-requests", { planId: plan.planId, expectedVersion: plan.version }, "plan");
      show({
        tone: "info",
        title: `You asked to edit ${name}`,
        message: view.isTest
          ? "This is a test plan: you take every step yourself in Team, and nobody is notified."
          : "Your district manager decides first, then SFE, then HR. The week opens again once HR acknowledges it.",
      });
      onChanged?.();
      resource.reload();
    } catch (error) {
      const code = errorCodeOf(error);
      show({ tone: "bad", title: "The request was not sent", message: messageOf(error) });
      if (code !== null && PLAN_RELOAD_CODES.has(code)) resource.reload();
    } finally {
      setBusy(null);
    }
  }

  /** The reviewer's decision on one week — only ever called from its own Approve or Return button. */
  async function decideWeek(state: WeekState, action: PlanDecisionAction, note: string): Promise<boolean> {
    const plan = state.week.plan;
    if (!view || !plan || locked) return false;
    const name = state.week.label;
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
  // A rep no longer sends or takes back a month (owner, 2026-10-01). What is left is the reviewer's
  // decision on a month sent before that day.

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
    setPlanStep(1);
    setWeekStart(null);
    setDay(null);
    setNotice(null);
    setShowProblems(false);
    setLeaving(null);
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
    // A greyed week is not a choice on the rep's own plan (owner, 2026-10-01): one week at a time.
    if (repBoard && view?.weeks.find((week) => week.weekStart === next)?.repState === "closed") return;
    setWeekStart(next);
    setDay(null);
    // On the rep's form a tap on his week moves him on to its days.
    if (repBoard) goStep(2);
  }

  /** A step of the rep's form, its top brought into view when he has scrolled past it. */
  function goStep(next: number) {
    setPlanStep(next);
    window.requestAnimationFrame(() => {
      const top = stepRef.current;
      if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
    });
  }

  /**
   * A day chosen on the rep's form is planned on the next step — the tap moves him on — starting with
   * its AM list, already filled with the day's suggestion the first time he opens it (owner,
   * 2026-10-02). Nothing is saved: the ticks land in the draft, where one tap clears them.
   */
  function openDay(date: string) {
    setDay(date);
    setDaySession("AM");
    if (!repBoard) return;
    goStep(3);
    fillDay(date, false);
  }

  /**
   * The day's suggestion, into the draft: the same `suggestDay` and the same way in (`addCopies`) as
   * "Suggest this day", so it carries no rule of its own. Unforced, it fills a day once, and only an
   * empty one; "Fill the day for me" forces it, and still only tops up what the day has room for.
   */
  function fillDay(date: string, force: boolean) {
    if (!selected || !selected.editable || !suggest) return;
    const key = `${selected.scope}|${date}`;
    if (!force && filledDays.has(key)) return;
    setFilledDays((previous) => new Set(previous).add(key));
    const target = selected.week.days.find((entry) => entry.date === date);
    if (!target || !target.editable) return;
    if (!force && selected.items.some((item) => item.planDate === date)) return;
    const result = suggestDay({
      week: selected.week,
      items: selected.items,
      activities: selected.activities,
      customers,
      caps,
      ...suggest,
      date,
    });
    if (result.placements.length > 0) addCopies(new Map([[selected.week.weekStart, result.placements]]));
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
  // 🔴 THE MONTH'S OWN WEEKS, FOR EVERYTHING THAT IS ABOUT THE MONTH (owner, 2026-10-01). The leading
  // week is shown like any other, but it belongs to the month before: it must not move this month's
  // placed count or its weeks-left arithmetic — the server keeps it out of every meter for the same reason.
  const ownWeeks = states.filter((state) => !state.week.leading);
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
  // month's weeks from the one on screen on, so a customer is spread over them rather than bunched, and
  // his daily call-rate target, which a suggestion fills a day to (never past the cap). The weeks are
  // the MONTH's, not the ones he can change: he plans one week at a time now (owner, 2026-10-01), and
  // counting only that one would cram a customer's whole month into it.
  const suggest: SuggestContext | null =
    view.viewerIsRep && selected
      ? {
          gradeTargets: view.rules.gradeTargets,
          dayTargets: { am: view.callRate.amTarget, pm: view.callRate.pmTarget },
          placedThisMonth: monthPlacements(
            states.filter((state) => !state.week.leading).map((state) => ({ week: state.week, items: state.editable ? state.items : null })),
          ),
          weeksLeft: Math.max(1, ownWeeks.filter((state) => state.week.weekStart >= selected.week.weekStart).length),
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

  // ── The blocks the rep's step form and a reviewer's whole board share ─────────────────────────
  const monthBlock = (
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
  );

  const pendingBlock = (
    <>
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
    </>
  );

  const weeksBlock = (
    <CrmBlock className="border-t border-slate-100" title="Weeks">
      {states.length === 0 ? (
        <p className="text-sm font-medium text-slate-500">This month has no field-week.</p>
      ) : (
        <CrmChoice
          columns={4}
          label="Week"
          onChange={chooseWeek}
          options={states.map((state) => {
            // 🔴 GREYED on the rep's own plan (owner, 2026-10-01): one week at a time. A week ahead
            // of his is not open yet; a week behind it has passed — it keeps the word for what was
            // sent, and one never sent reads "Closed", never "Not started", which invites a tap.
            const closed = repBoard && state.week.repState === "closed";
            const status = closed
              ? state.week.weekStart > view.repWeek
                ? "Not open yet"
                : state.week.status && state.week.status !== "draft"
                  ? state.week.statusLabel
                  : "Closed"
              : [
                  state.week.statusLabel,
                  state.week.plan?.submittedLate ? "sent late" : null,
                  state.week.overdue ? "overdue" : null,
                  state.dirty ? "unsaved" : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
            return {
              value: state.week.weekStart,
              label: <ChoiceLabel chosen={state.week.weekStart === selected?.week.weekStart}>{state.week.label}</ChoiceLabel>,
              disabled: closed,
              // The week's own DAYS under its status, never its due date (owner, 2026-10-02: "Week 1 ·
              // Not started · Sat 3 Oct – Thu 8 Oct … not Fri 2 Oct"). The due date stays in the week's
              // panel, where it is labelled DUE and cannot be read as the week's first day.
              note: (
                <>
                  <span className="block">{status}</span>
                  <span className="block">{weekLabel(state.week.weekStart)}</span>
                </>
              ),
            };
          })}
          value={selected?.week.weekStart ?? null}
        />
      )}
    </CrmBlock>
  );

  // The week panel as an ELEMENT built once per render — never a function called during render, which
  // the React compiler reads as running every handler inside it then (react-hooks/refs).
  const panelSection: "days" | "day" | "send" | undefined = repBoard ? (planStep === 2 ? "days" : planStep === 3 ? "day" : "send") : undefined;
  const weekPanelElement =
    selected && selectedDay ? (
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
      onActivity={(date, activityType, next) => planActivity(selected, date, activityType, next)}
      onAskToEdit={() => void askToEdit(selected)}
      onCopied={addCopies}
      onDay={openDay}
      onDecide={(action, note) => decideWeek(selected, action, note)}
      onFilter={setFilter}
      onKeepMine={() => keepMine(selected)}
      onPlace={(item) => place(selected, item)}
      onQuery={setQuery}
      onRemove={(date, customerId) => remove(selected, date, customerId)}
      onSend={() => void sendWeek(selected)}
      onShowLatest={() => showLatest(selected)}
      onStarts={(date, next) => planStarts(selected, date, next)}
      problems={selected.problems}
      query={query}
      reviewerSentence={reviewerSentence(view)}
      seatId={seatId}
      section={panelSection}
      selectedDay={selectedDay}
      dayFocus={repBoard && panelSection === "day" ? daySession : undefined}
      onFillDay={() => fillDay(selectedDay.date, true)}
      showProblems={showProblems}
      showSpread={showSpread}
      starts={selected.starts}
      suggest={suggest}
      test={test}
      tints={tints}
      today={view.cairoToday}
      viewerIsRep={view.viewerIsRep}
      week={selected.week}
    />
    ) : null;

  // The rep's four steps. Step 3 names the day it plans.
  const planSteps: ReadonlyArray<CrmStep> = [
    { label: "Week", description: "Which week you plan", title: "Choose the week" },
    { label: "Day", description: "The days of the week", title: "Choose the day" },
    { label: "Customers", description: "Who you will visit", title: selectedDay ? `${dayLabel(selectedDay.date)} · ${daySession} customers` : "Customers" },
    { label: "Send", description: "Send it for review", title: "Send the week" },
  ];
  const dayIndex = selected && selectedDay ? selected.week.days.findIndex((entry) => entry.date === selectedDay.date) : -1;
  // The next day that holds a list — a public holiday is skipped, the way a Friday is never in the week.
  const nextDay = selected && dayIndex >= 0 ? (selected.week.days.slice(dayIndex + 1).find((entry) => entry.listTypes.length > 0) ?? null) : null;
  const planFooter =
    planStep === 1 ? (
      <CrmStepFooter back={null}>
        <CrmStepNext disabled={!selected} onClick={() => goStep(2)} />
      </CrmStepFooter>
    ) : planStep === 2 ? (
      <CrmStepFooter back={() => goStep(1)}>
        <CrmStepNext onClick={() => (selectedDay ? openDay(selectedDay.date) : goStep(3))} />
      </CrmStepFooter>
    ) : planStep === 3 && daySession === "AM" && selectedDay?.listTypes.includes("PM") ? (
      <CrmStepFooter back={() => goStep(2)}>
        <CrmStepNext
          onClick={() => {
            setDaySession("PM");
            goStep(3);
          }}
        >
          Next: PM
        </CrmStepNext>
      </CrmStepFooter>
    ) : planStep === 3 ? (
      <CrmStepFooter
        back={() => {
          if (daySession === "PM") {
            setDaySession("AM");
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
        <CrmStepNext onClick={() => goStep(4)}>Review and send</CrmStepNext>
      </CrmStepFooter>
    ) : (
      <CrmStepFooter back={() => goStep(3)} />
    );

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

        {/* 🔴 The rep's own plan has ONE path (owner, 2026-10-01): no month to choose and no month to
            send — the title above names the month, and his week is the one open below. A manager
            reviewing from Team keeps his month chooser. */}
        {repBoard ? (
          view.blockedReason ? (
            <CrmBlock>
              <CrmNote tone="warn">{view.blockedReason}</CrmNote>
            </CrmBlock>
          ) : null
        ) : (
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
        )}

        {/* A month SENT before 2026-10-01 still carries its status and its reviewer's decision. A month
            with no header is not a thing any more — the rep sends a week at a time — so nothing shows. */}
        {!repBoard && plan ? (
          <CrmBlock
            actions={
              <span className="flex max-w-full flex-wrap gap-1">
                <CrmPill tone={PLAN_STATUS_TONE[status ?? "none"]}>{plan.statusLabel}</CrmPill>
                {plan.submittedLate ? <CrmPill tone="warn">Sent late</CrmPill> : null}
              </span>
            }
            className="border-t border-slate-100"
            title={`${view.monthLabel} · the month`}
          >
            <CrmFacts facts={monthFacts} />
            {plan.decisionNote && (status === "returned" || status === "approved") ? (
              <CrmNote className="mt-3" title={status === "returned" ? "What to change" : "Manager's note"} tone={status === "returned" ? "warn" : "good"}>
                <span className="block whitespace-pre-line">{plan.decisionNote}</span>
              </CrmNote>
            ) : null}
          </CrmBlock>
        ) : null}

        {repBoard ? (
          <div className="min-w-0 scroll-mt-24 border-t border-slate-100" ref={stepRef}>
            <CrmStepForm
              aside="Nothing reaches your manager until you press Send this week."
              chip={selected ? weekLabel(selected.week.weekStart) : view.monthLabel}
              footer={planFooter}
              onJump={goStep}
              step={planStep}
              steps={planSteps}
            >
              {planStep === 1 ? (
                // The step is the week, so its weeks lead; the month the week sits in follows.
                <>
                  {weeksBlock}
                  {monthBlock}
                  {pendingBlock}
                </>
              ) : (
                weekPanelElement
              )}
            </CrmStepForm>
          </div>
        ) : (
          <>
            {monthBlock}
            {pendingBlock}
            {weeksBlock}
            <div className="min-w-0 scroll-mt-24" ref={weekRef}>
              {weekPanelElement}
            </div>
          </>
        )}

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
          weeks={weeksText(needsSave.map((state) => state.week.label))}
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
