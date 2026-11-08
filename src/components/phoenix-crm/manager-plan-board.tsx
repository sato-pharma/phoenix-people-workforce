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
 * 🔴 THE TRAINING MANAGER (owner, 2026-10-24: "he neevr choose dr he choose the region then the area/rep only")
 * chooses a REGION instead of a district manager, the same way — once per day, another for one half-day — and
 * then With a rep (the rep alone, never a customer), An area (one area of the region), or Admin / Office.
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

import { RecordConversationThread } from "@/components/conversations/record-conversation-thread";
import { AdminDelete } from "@/components/phoenix-crm/admin-delete";
import { crmGet, crmPost, crmUrl, errorCodeOf, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { countText, plural } from "@/components/phoenix-crm/format";
import { ManagerCustomerForm } from "@/components/phoenix-crm/manager-customer-form";
import { CustomerCard, CustomerGroupBar, CustomerMarks, groupLook, useCustomerInsight } from "@/components/phoenix-crm/manager-customer-marks";
import { CustomerVisitTimesLines, useCustomerVisitTimes, useShowVisitTimes, VisitTimesToggle } from "@/components/phoenix-crm/visit-times";
import { ManagerSingleVisitDayAsk } from "@/components/phoenix-crm/manager-single-visit-day-ask";
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
  dmSingleVisitLimitLine,
  managerNextHold,
  managerPlanDaysLabel,
  MANAGER_PLAN_NOTE_MAX,
  MANAGER_PLAN_REASON_MAX,
  MANAGER_SLOT_CUSTOMER_MAX,
  VACANT_AREA_NOTE,
  VACANT_LIST_LABEL,
  type ManagerHalf,
  type ManagerSlotKind,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { customerGroups, customerPriority, ownInsightKey, suggestedCustomers, type GroupableCustomer } from "@/lib/phoenix-crm/manager-customer-marks-rules";
import { compareFoldedNames, foldedWordsMatch } from "@/lib/phoenix-crm/name-fold";
import { PLAN_AUTOSAVE_DELAY_MS } from "@/lib/phoenix-crm/plan-week-draft";
import type {
  AreaCustomersView,
  CustomerMatch,
  DistrictManagerDay,
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

/** `areaSeatId`: With my manager or product manager only — the ticked area the doctor was chosen in. */
type CustomerRef = { key: string; customerId: string | null; managerCustomerId: string | null; name: string; areaSeatId?: string | null };

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
  /** With a district manager, or with my manager or product manager: the areas ticked for the half-day. */
  areaSeatIds: string[];
  /** With my manager or product manager: the person a district manager goes with. */
  seniorHrId: string | null;
  note: string;
  customers: CustomerRef[];
};

function emptyDraft(): HalfDraft {
  return { kind: null, scope: null, repSeatId: null, activityType: null, areaSeatId: null, areaSeatIds: [], seniorHrId: null, note: "", customers: [] };
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

/**
 * A half-day that names a district: with a rep, with its district manager, with a manager or product manager in
 * it, or single visits in one of its areas — or, for the Training Manager, a region: with a rep, or an area. A
 * district manager's own carry no scope (`choosesADistrict` is false for him).
 */
function namesADistrict(kind: ManagerSlotKind | null): boolean {
  return kind === "with_rep" || kind === "single_visit" || kind === "with_dm" || kind === "with_senior" || kind === "with_area";
}

function draftFromSlot(slot: ManagerBoardSlot | undefined): HalfDraft {
  return {
    kind: slot?.kind ?? null,
    scope: slot?.scopeKey ?? null,
    repSeatId: slot?.repSeatId ?? null,
    activityType: slot?.activityType ?? null,
    areaSeatId: slot?.areaSeatId ?? null,
    areaSeatIds: slot?.areaSeatIds ?? [],
    seniorHrId: slot?.seniorHrId ?? null,
    note: slot?.note ?? "",
    customers: (slot?.customers ?? []).map((customer) =>
      customer.customerId
        ? slot?.kind === "with_senior"
          ? { ...repRef(customer.customerId, customer.name), areaSeatId: customer.areaSeatId }
          : repRef(customer.customerId, customer.name)
        : ownRef(customer.managerCustomerId ?? "", customer.name),
    ),
  };
}

/** A regional, national or product manager, or the Training Manager: the planner who chooses a scope first. */
function choosesADistrict(view: ManagerPlanBoardView | null): boolean {
  return Boolean(view?.writer && view.writer.kind !== "dm");
}

/** The Training Manager: her scope is a region, and her With a rep names the rep alone (owner, 2026-10-24). */
function plansARegion(view: ManagerPlanBoardView | null): boolean {
  return view?.writer?.kind === "tm";
}

/** What a half-day still lacks before it can be saved, or null when it can. */
function draftProblem(draft: HalfDraft, choosesDistrict: boolean, byRegion: boolean, customersOptional: boolean): string | null {
  if (choosesDistrict && namesADistrict(draft.kind) && !draft.scope) return byRegion ? "choose the region" : "choose the district manager";
  if (draft.kind === "with_rep") {
    if (!draft.repSeatId) return "choose the rep you go with";
    if (!byRegion && !customersOptional && draft.customers.length === 0) return "tick at least one of the rep's customers";
  }
  if (draft.kind === "with_area" && !draft.areaSeatId) return "choose the area";
  if (draft.kind === "with_dm") {
    if (!draft.scope?.startsWith("dm:")) return "choose the district manager you go with";
    if (draft.areaSeatIds.length === 0) return "tick at least one of the district manager's areas";
  }
  if (draft.kind === "with_senior") {
    if (choosesDistrict && !draft.scope?.startsWith("dm:")) return "choose the district manager first";
    if (!draft.seniorHrId) return "choose who you go with";
    if (draft.areaSeatIds.length === 0) return "tick at least one area";
  }
  if (draft.kind === "admin" && !draft.activityType) return "choose the activity";
  if (draft.kind === "single_visit") {
    if (!draft.areaSeatId) return "choose the area";
    if (!customersOptional && draft.customers.length === 0) return "choose at least one customer";
  }
  if (draft.customers.length > MANAGER_SLOT_CUSTOMER_MAX) return `keep it to ${MANAGER_SLOT_CUSTOMER_MAX} customers`;
  return null;
}

/** The scope the server is told: the district manager's seat and its line, a whole line, or the Training Manager's region. */
function scopeFields(
  key: string | null,
  scopes: ReadonlyArray<ManagerBoardScope>,
): { scopeDmSeatId: string | null; scopeLineCode: string | null; scopeRegionCode: string | null } {
  const found = key ? scopes.find((scope) => scope.key === key) : undefined;
  if (!found) return { scopeDmSeatId: null, scopeLineCode: null, scopeRegionCode: null };
  if (found.regionCode) return { scopeDmSeatId: null, scopeLineCode: null, scopeRegionCode: found.regionCode };
  return { scopeDmSeatId: found.dmSeatId, scopeLineCode: found.lineCode, scopeRegionCode: null };
}

function draftPayload(date: string, half: ManagerHalf, draft: HalfDraft, scopes: ReadonlyArray<ManagerBoardScope>) {
  return {
    date,
    half,
    kind: draft.kind,
    repSeatId: draft.kind === "with_rep" ? draft.repSeatId : null,
    activityType: draft.kind === "admin" ? draft.activityType : null,
    areaSeatId: draft.kind === "single_visit" || draft.kind === "with_area" ? draft.areaSeatId : null,
    areaSeatIds: draft.kind === "with_dm" || draft.kind === "with_senior" ? draft.areaSeatIds : [],
    seniorHrId: draft.kind === "with_senior" ? draft.seniorHrId : null,
    ...scopeFields(namesADistrict(draft.kind) ? draft.scope : null, scopes),
    note: draft.note.trim() || null,
    customers:
      draft.kind === "admin" || draft.kind === "with_dm" || draft.kind === "with_area" || draft.kind === null
        ? []
        : draft.customers.map((customer) => (customer.customerId ? { customerId: customer.customerId } : { managerCustomerId: customer.managerCustomerId })),
  };
}

function sameDraft(left: HalfDraft, right: HalfDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Answers a save can get when it LANDED and only its answer was lost — the phone's connection dropped on
 * the way back, or the server's reply never parsed. The rep's board reads them the same way (plan-board.tsx).
 */
const MAY_HAVE_SAVED = new Set(["offline", "failed", "internal_error", "statement_timeout"]);

/** Would saving this half-day send exactly what the week already holds? Names and customer order aside. */
function savesNothing(date: string, half: ManagerHalf, draft: HalfDraft, slot: ManagerBoardSlot | undefined, scopes: ReadonlyArray<ManagerBoardScope>): boolean {
  const shape = (payload: ReturnType<typeof draftPayload>) =>
    JSON.stringify({ ...payload, customers: payload.customers.map((entry) => JSON.stringify(entry)).sort() });
  return shape(draftPayload(date, half, draft, scopes)) === shape(draftPayload(date, half, draftFromSlot(slot), scopes));
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "failed"; message: string };

/** A half-day on the page that cannot be saved yet, and what it still lacks. */
type WaitingProblem = { date: string; half: ManagerHalf; dayText: string; problem: string };

const REP_WEEK: Record<ManagerBoardRepHalf["weekState"], { label: string; tone: PillTone }> = {
  sent: { label: "Sent", tone: "good" },
  not_sent: { label: "Not sent", tone: "warn" },
  // A rep who has not moved to Phoenix CRM yet: his plan is the one he filed in the old CRM (owner, 2026-10-17).
  old_crm: { label: "Old CRM plan", tone: "info" },
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
  // 🔴 A TIMER THAT FIRES DURING A SAVE IS OWED ANOTHER TRY. It returned quietly, and an edit to the half-day on
  // its way changed nothing the timer watches when that save finished, so it sat on "Saving soon…" for ever.
  const missedSave = useRef(false);
  const [saveNudge, setSaveNudge] = useState(0);
  // Next stopped on this half-day, and the day whose empty half he has been told about once.
  const [nextHeldAt, setNextHeldAt] = useState<string | null>(null);
  const [nextWarnedDay, setNextWarnedDay] = useState<string | null>(null);
  // 🔴 A SAVE WHOSE ANSWER NEVER CAME BACK MAY STILL HAVE LANDED (production, 24 Oct 2026: Osama Mohamed's
  // phone lost two answers in ten minutes). Each landed save moves the week's version, so the next save,
  // sent with the version the screen still held, was refused as "changed on another screen" — raised
  // against his own save. Until the week is read again, the board's version is not known.
  const versionUnknown = useRef(false);
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
  // 🔴 A READ STILL ON ITS WAY LANDS AFTER A SAVE'S ANSWER AND OVERWRITES IT, older than the save: the half-day
  // reads empty on the page, and the next save is refused as "changed on another screen". While one is on its way
  // the board reads again rather than taking the answer, as the rep's board does.
  const readOnItsWay = useRef(false);
  useEffect(() => {
    readOnItsWay.current = board.loading;
  }, [board.loading]);

  const pending = Object.keys(drafts);
  useEffect(() => {
    onDirtyChange?.(pending.length > 0);
  }, [pending.length, onDirtyChange]);

  const choosesDistrict = choosesADistrict(view);
  const byRegion = plansARegion(view);
  const days = view?.days ?? [];
  const day: ManagerBoardDay | null = days.find((entry) => entry.date === date) ?? days.find((entry) => entry.editable) ?? days[0] ?? null;
  const dayHalves = day?.halves ?? [];
  const currentHalf: ManagerHalf = dayHalves.includes(half) ? half : (dayHalves[0] ?? "AM");
  const slot = day?.slots.find((entry) => entry.half === currentHalf);
  const key = day ? halfKey(day.date, currentHalf) : null;
  const draft = key ? (drafts[key] ?? draftFromSlot(slot)) : draftFromSlot(undefined);
  const canEdit = Boolean(view?.canWrite && day?.editable);

  /** What a half-day on the page still lacks. A cleared one lacks nothing. */
  function problemOf(waiting: HalfDraft): string | null {
    return waiting.kind === null ? null : draftProblem(waiting, choosesDistrict, byRegion, view?.customersOptional === true);
  }

  const waitingProblems: WaitingProblem[] = Object.entries(drafts).flatMap(([waitingKey, waiting]) => {
    const problem = problemOf(waiting);
    if (!problem) return [];
    const [waitingDate, waitingHalf] = waitingKey.split("|") as [string, ManagerHalf];
    return [{ date: waitingDate, half: waitingHalf, dayText: days.find((entry) => entry.date === waitingDate)?.dateText ?? waitingDate, problem }];
  });

  // A reload or a closed tab cannot take a half-day that cannot be saved, or one whose save failed.
  const unsavedWork = waitingProblems.length > 0 || saveState.kind === "failed";
  useEffect(() => {
    if (!unsavedWork) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsavedWork]);

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
      const untouched = !halfDraft.repSeatId && !halfDraft.areaSeatId && halfDraft.areaSeatIds.length === 0 && halfDraft.customers.length === 0;
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
    edit({ ...draft, scope: next, repSeatId: null, areaSeatId: null, areaSeatIds: [], customers: [] });
    showScope(next);
  }

  /** Saves every half-day that can be saved, one at a time; the rest wait and say why. */
  async function saveWaiting(options: { keepalive?: boolean } = {}): Promise<boolean> {
    if (saving.current) {
      missedSave.current = true;
      return false;
    }
    saving.current = true;
    let allSaved = true;
    try {
      // The last save's answer was lost: read the week first, so this save carries the version it is now.
      if (versionUnknown.current && !options.keepalive) {
        const shown = viewRef.current;
        try {
          const fresh = await crmGet<ManagerPlanBoardView>(crmUrl(BOARD, { week: shown?.weekStart ?? week, scope: scopeRef.current, test }), "board");
          versionUnknown.current = false;
          viewRef.current = fresh;
          if (fresh.weekStart === shown?.weekStart && (fresh.scope ?? null) === (scopeRef.current ?? null) && !readOnItsWay.current) board.replace(fresh);
          else board.reload();
        } catch (failure) {
          setSaveState({ kind: "failed", message: messageOf(failure) });
          return false;
        }
      }
      for (const [waitingKey, waiting] of Object.entries(drafts)) {
        const [waitingDate, waitingHalf] = waitingKey.split("|") as [string, ManagerHalf];
        const savedSlot = viewRef.current?.days.find((entry) => entry.date === waitingDate)?.slots.find((entry) => entry.half === waitingHalf);
        // Cleared before it was ever saved, or already exactly what the week holds (a save whose answer
        // was lost that landed after all): nothing to send.
        if ((waiting.kind === null && !savedSlot?.kind) || (savedSlot?.kind && savesNothing(waitingDate, waitingHalf, waiting, savedSlot, viewRef.current?.scopes ?? []))) {
          setDrafts((previous) => {
            if (!previous[waitingKey] || !sameDraft(previous[waitingKey], waiting)) return previous;
            const { [waitingKey]: _gone, ...rest } = previous;
            return rest;
          });
          continue;
        }
        // 🔴 The same answer the screen gave (owner look, 2026-11-01): told nothing here, a half-day naming the rep or the area alone read "Saving soon…" and never went.
        const problem = draftProblem(waiting, choosesADistrict(viewRef.current), plansARegion(viewRef.current), viewRef.current?.customersOptional === true);
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
          // A save flushed as the page hides is never read back, so the version it made is not known here.
          if (options.keepalive) {
            versionUnknown.current = true;
            continue;
          }
          viewRef.current = next;
          // The answer is in the scope on screen; if he moved to another while it saved, read that one.
          if ((next.scope ?? null) === (scopeRef.current ?? null) && !readOnItsWay.current) board.replace(next);
          else board.reload();
          setDrafts((previous) => {
            if (!previous[waitingKey] || !sameDraft(previous[waitingKey], waiting)) return previous;
            const { [waitingKey]: _saved, ...rest } = previous;
            return rest;
          });
        } catch (failure) {
          allSaved = false;
          if (options.keepalive) {
            versionUnknown.current = true;
            continue;
          }
          const failedDay = viewRef.current?.days.find((entry) => entry.date === waitingDate)?.dateText ?? waitingDate;
          setSaveState({ kind: "failed", message: `${failedDay} ${waitingHalf}: ${messageOf(failure)}` });
          const code = errorCodeOf(failure);
          if (code !== null && MAY_HAVE_SAVED.has(code)) versionUnknown.current = true;
          // Another screen moved the week first: read it again, and his edit stays on the page.
          if (code?.includes("version") || code === "conflict") board.reload();
          return false;
        }
      }
      setSaveState(allSaved ? { kind: "saved" } : { kind: "idle" });
      return allSaved;
    } finally {
      saving.current = false;
      if (missedSave.current) {
        missedSave.current = false;
        setSaveNudge((current) => current + 1);
      }
    }
  }

  const onSaveTimer = useEffectEvent(() => {
    void saveWaiting();
  });
  useEffect(() => {
    if (Object.keys(drafts).length === 0) return;
    const timer = window.setTimeout(() => onSaveTimer(), PLAN_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [drafts, saveNudge]);

  const onHidden = useEffectEvent(() => {
    if (Object.keys(drafts).length > 0) void saveWaiting({ keepalive: true });
  });
  useEffect(() => {
    // Back in sight or back online, what is still waiting is tried again, a save that failed included.
    function tryAgain() {
      setSaveNudge((current) => current + 1);
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") onHidden();
      else tryAgain();
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", tryAgain);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", tryAgain);
    };
  }, []);
  // The board leaving the screen — Nosiba Salah switching "My territory · My district", a tab change —
  // clears the autosave timer with it, so an edit made inside its 1.5 s would be lost. It is sent on the
  // way out instead, the way a hidden page sends it.
  useEffect(() => () => onHidden(), []);

  function chooseWeek(next: string) {
    // Pressing the week already on screen is only a way forward: nothing he chose goes with it.
    if (next === view?.weekStart) {
      setStep(2);
      return;
    }
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
  const statusText =
    saveState.kind === "saving"
      ? "Saving…"
      : saveState.kind === "failed"
        ? `Not saved — ${saveState.message}`
        : waitingProblems.length > 0
          ? `Not saved yet — ${waitingProblems[0].dayText} ${waitingProblems[0].half}: ${waitingProblems[0].problem}`
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

  function openDay(next: string) {
    const nextDay = days.find((entry) => entry.date === next);
    const firstHalf = nextDay?.halves[0] ?? "AM";
    setDate(next);
    setHalf(firstHalf);
    setStep(3);
    if (nextDay) showScope(halfScopeOf(nextDay, firstHalf));
  }

  /** The half-day named on Send as not saved yet, opened to finish it. */
  function openHalf(next: string, nextHalf: ManagerHalf) {
    const nextDay = days.find((entry) => entry.date === next);
    setDate(next);
    setHalf(nextHalf);
    setStep(3);
    if (nextDay) showScope(halfScopeOf(nextDay, nextHalf));
  }

  /** What stops Next on the half-day on screen, or null when it may walk on. */
  function nextHold() {
    if (!day || !canEdit) return null;
    const chosenScope = dayScopes[day.date];
    return managerNextHold({
      dayText: day.dateText,
      half: currentHalf,
      problem: problemOf(draft),
      chosenScopeName: chosenScope ? (view?.scopes.find((entry) => entry.key === chosenScope)?.name ?? null) : null,
      dayHasAPlan: day.halves.some((entry) => draftOf(day, entry).kind !== null),
      leavesTheDay: day.halves.indexOf(currentHalf) === day.halves.length - 1,
    });
  }

  // 🔴 NEXT WALKS THE WEEK, NOT THE STEPS (owner walk, 2026-10-28) — on "What I do" it went straight to Send
  // after one half-day, so planning Saturday to Thursday was six trips back to the day list. It goes AM →
  // PM → the next day he can still plan, and only then to Send. A day already passed, or one he cannot
  // edit, is stepped over while he plans; read-only, every day still to come is walked.
  function goNext() {
    if (step !== 3 || !day) {
      goStep(step + 1);
      return;
    }
    // 🔴 AND NEVER PAST A HALF-DAY THAT IS NOT SAVED. It stops and says why, right above the button; a half-day
    // that can be saved goes now, not 1.5 seconds later, and a save that failed is tried again.
    const hold = nextHold();
    if (hold && !(hold.once && nextWarnedDay === day.date)) {
      setNextHeldAt(key);
      if (hold.once) setNextWarnedDay(day.date);
      return;
    }
    setNextHeldAt(null);
    if (Object.keys(drafts).length > 0) void saveWaiting();
    const halfIndex = day.halves.indexOf(currentHalf);
    const laterHalf = day.halves[halfIndex + 1];
    if (laterHalf && (!view?.canWrite || day.editable)) {
      setHalf(laterHalf);
      showScope(halfScopeOf(day, laterHalf));
      return;
    }
    const dayIndex = days.findIndex((entry) => entry.date === day.date);
    const nextDay = days.slice(dayIndex + 1).find((entry) => entry.halves.length > 0 && (view?.canWrite ? entry.editable : !entry.passed));
    if (nextDay) openDay(nextDay.date);
    else goStep(4);
  }

  const chip = view.weeks.find((entry) => entry.weekStart === view.weekStart)?.name ?? "This week";
  const sendWord = sendWordOf(view);

  // What a With a rep or Single visit half-day shows in place of its reps and areas while they are not the
  // ones of its district manager yet: the day's choice first, then the load.
  const halfScope = day ? halfScopeOf(day, currentHalf) : null;
  let districtGate: ReactNode = null;
  if (choosesDistrict && namesADistrict(draft.kind)) {
    if (!halfScope) {
      districtGate = <CrmNote tone="info">{byRegion ? "Choose the region for this day first." : "Choose the district manager for this day first."}</CrmNote>;
    } else if (view.scope !== halfScope) {
      const name = view.scopes.find((entry) => entry.key === halfScope)?.name ?? slot?.scopeName ?? (byRegion ? "the region" : "the district manager");
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
          <CrmLoading label={byRegion ? "Loading the region's reps and areas" : "Loading the district's reps and areas"} />
        ) : (
          <CrmNote tone="warn">
            {byRegion ? "This region holds no rep now. Choose another for this day." : "This district manager is no longer one you plan with. Choose another for this day."}
          </CrmNote>
        );
    }
  }

  return (
    <CrmPanel
      description={
        byRegion
          ? "Plan each half-day: choose the region, then go with one of its reps, spend it in one of its areas, or record an admin activity or a day in the Office. The reps do not see it."
          : choosesDistrict
            ? "Plan each half-day: choose the district manager, then go with one of the reps, make single visits in an area of that district, or record an admin activity or a day in the Office. The reps do not see it."
            : "Plan each half-day: with a rep, with your manager or product manager, an admin activity, or single visits in an area of your district. Your reps do not see it."
      }
      eyebrow={view.isTest ? "Plan · test persona" : "Plan"}
      title={view.manager ? `${view.manager.name} · ${view.manager.place}` : "Your week"}
    >
      {plan ? (
        <CrmBlock>
          <CrmNote title={plan.statusLine} tone={plan.status === "returned" ? "warn" : plan.status === "approved" ? "good" : "neutral"}>
            {/* Each date names what it is (owner walk, 2026-10-28: a bare date under "Waiting for Hany Saad to
                approve" read as either the send or the deadline). */}
            <span className="block">
              {plan.sentText
                ? `Sent ${plan.sentText}${plan.submittedLate ? ` · late, due ${plan.dueText}` : ""}`
                : `Due ${plan.dueText}${plan.overdue ? " · overdue" : ""}`}
            </span>
            {plan.decisionNote ? <span className="mt-1 block whitespace-pre-line">What to change: {plan.decisionNote}</span> : null}
            {plan.returnedDay ? (
              <span className="mt-1 block">Only {days.find((entry) => entry.date === plan.returnedDay)?.dateText ?? plan.returnedDay} is open to change.</span>
            ) : null}
          </CrmNote>
          {/* The week's conversation (owner, 2026-11-01): the same thread its approvers read in the Approvals Hub. */}
          {plan.conversation ? (
            <div className="mt-3">
              <RecordConversationThread base={plan.conversation.url} key={plan.planId} note={plan.conversation.note} startClosed />
            </div>
          ) : null}
          {view.adminDeletes && plan.planId ? (
            <div className="mt-3">
              <AdminDelete
                id={plan.planId}
                isTest={view.isTest}
                kind="manager_plan"
                onDeleted={() => {
                  board.reload();
                  onChanged?.();
                }}
                subject={chip}
              />
            </div>
          ) : null}
        </CrmBlock>
      ) : null}

      <div className="min-w-0 border-t border-slate-100">
        <CrmStepForm
          aside={
            plan && plan.state !== "plan"
              ? undefined
              : plan?.firstApproverName
                ? `Nothing reaches ${plan.firstApproverName} until you press ${sendWord}.`
                : `Nothing is sent until you press ${sendWord}.`
          }
          canJump={(target) => target <= 2 || day !== null}
          chip={chip}
          footer={
            <CrmStepFooter back={step > 1 ? () => goStep(step - 1) : null}>
              {statusText ? <span className="self-center text-xs font-bold text-slate-500">{statusText}</span> : null}
              {saveState.kind === "failed" ? (
                <CrmButton onClick={() => void saveWaiting()} size="sm">
                  Try again
                </CrmButton>
              ) : null}
              {step < STEPS.length ? <CrmStepNext disabled={step >= 2 && day === null} onClick={goNext} /> : null}
            </CrmStepFooter>
          }
          onJump={goStep}
          step={step}
          steps={STEPS.map((entry) => (entry.label === "Day" ? { ...entry, description: managerPlanDaysLabel(view.writer?.kind ?? null) } : entry))}
        >
          {step === 1 ? <WeekStep onWeek={chooseWeek} view={view} /> : null}
          {step === 2 ? (
            <DayStep
              days={days}
              anyHalfIsEnough={view.customersOptional}
              drafts={drafts}
              onDay={openDay}
              problemOf={problemOf}
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
              nextHoldMessage={nextHeldAt === key ? (nextHold()?.message ?? null) : null}
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
              latestPlan={() => viewRef.current?.plan ?? null}
              onOpenHalf={openHalf}
              problemOf={problemOf}
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

/** The Send button's words: the coming week is never "this week" (owner walk, 2026-10-28). */
function sendWordOf(view: ManagerPlanBoardView): string {
  return view.weeks.find((entry) => entry.weekStart === view.weekStart)?.coming ? "Send the coming week" : "Send this week";
}

function WeekStep({ onWeek, view }: { onWeek: (week: string) => void; view: ManagerPlanBoardView }) {
  // Each week says where it stands, the one not on screen too: "Coming week" alone hid a week already sent.
  const options: Array<CrmChoiceOption<string>> = view.weeks.map((entry) => ({
    value: entry.weekStart,
    label: entry.name,
    note: entry.statusLabel ?? undefined,
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

function dayNote(day: ManagerBoardDay, drafts: Record<string, HalfDraft>, problemOf: (waiting: HalfDraft) => string | null): string {
  if (day.holiday) return `${day.holiday} · no plan`;
  if (day.halves.length === 0) return "No field day";
  return day.halves
    .map((half) => {
      const waiting = drafts[halfKey(day.date, half)];
      const problem = waiting ? problemOf(waiting) : null;
      const summary = problem ? `Not saved: ${problem}` : waiting ? "Not saved yet" : (day.slots.find((slot) => slot.half === half)?.summary ?? "Nothing planned");
      return `${half}: ${summary}`;
    })
    .join(" · ");
}

/** Whether a day reads as finished on the day list: both its halves, or one where AM and PM are each optional. */
function dayIsPlanned(day: ManagerBoardDay, anyHalfIsEnough: boolean): boolean {
  const planned = (half: ManagerHalf) => day.slots.some((slot) => slot.half === half && slot.kind);
  return day.halves.length > 0 && (anyHalfIsEnough ? day.halves.some(planned) : day.halves.every(planned));
}

function DayStep({
  anyHalfIsEnough,
  days,
  drafts,
  onDay,
  problemOf,
  selected,
}: {
  /** AM and PM are each optional for this planner, so one half planned finishes the day. */
  anyHalfIsEnough: boolean;
  days: ManagerBoardDay[];
  drafts: Record<string, HalfDraft>;
  onDay: (date: string) => void;
  problemOf: (waiting: HalfDraft) => string | null;
  selected: string | null;
}) {
  if (days.length === 0) return <CrmEmpty message="This week has no field days." title="No days to plan" />;
  // A passed day stays open to read what was planned, greyed and named so it is never mistaken for one
  // still to plan (owner walk, 2026-10-28: Saturday and Sunday looked as plannable as Thursday on a Tuesday).
  const options: Array<CrmChoiceOption<string>> = days.map((day) => ({
    value: day.date,
    label: day.passed && day.date !== selected ? <span className="text-slate-400">{day.dateText}</span> : day.dateText,
    note: day.passed ? `Passed · ${dayNote(day, drafts, problemOf)}` : dayNote(day, drafts, problemOf),
    disabled: day.halves.length === 0,
    tone: dayIsPlanned(day, anyHalfIsEnough) ? "good" : undefined,
  }));
  return <CrmChoice columns={2} label="Day" onChange={onDay} options={options} value={selected} />;
}

// ── The district manager a regional, national or product manager plans with ────────────────────

function scopeOption(scope: ManagerBoardScope, disabled: boolean): CrmChoiceOption<string> {
  if (scope.regionCode) return { value: scope.key, label: scope.name, disabled };
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
  if (scopes.length === 0) {
    return label.startsWith("Region") ? (
      <CrmEmpty message="No region holds a rep right now." title="No regions" />
    ) : (
      <CrmEmpty message="No district manager is in your reach right now." title="No district managers" />
    );
  }

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
            options={scopes
              .filter((scope) => scope.lineCode === line)
              // In place order, "Any rep in <line>" last (owner walk, 2026-10-28: the districts came in seat order).
              .sort(
                (left, right) =>
                  Number(left.dmSeatId === null) - Number(right.dmSeatId === null) ||
                  (left.place ?? "").localeCompare(right.place ?? "", undefined, { numeric: true }),
              )
              .map((scope) => scopeOption(scope, disabled))}
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
  byRegion,
  dayScope,
  draftScope,
  onPick,
  scopes,
}: {
  byLine: boolean;
  /** The Training Manager: the scope is a region. */
  byRegion: boolean;
  dayScope: string;
  draftScope: string | null;
  onPick: (key: string) => void;
  scopes: ReadonlyArray<ManagerBoardScope>;
}) {
  const [open, setOpen] = useState(false);
  const word = byRegion ? "region" : "district manager";
  const own = draftScope !== null && draftScope !== dayScope;
  const ownName = own ? (scopes.find((scope) => scope.key === draftScope)?.name ?? `another ${word}`) : null;
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
            label={byRegion ? "Region for this half" : "District manager for this half"}
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
            {`Another ${word} for this half`}
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
  nextHoldMessage,
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
  /** Why Next stopped here, said right above it. */
  nextHoldMessage: string | null;
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
  const byRegion = plansARegion(view);
  const halfOptions: Array<CrmChoiceOption<ManagerHalf>> = day.halves.map((entry) => ({
    value: entry,
    label: entry,
    note: day.slots.find((candidate) => candidate.half === entry)?.summary ?? "Nothing planned",
  }));
  const kindOptions: Array<CrmChoiceOption<ManagerSlotKind>> = view.slotKinds.map((entry) => ({
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
          <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{`${day.dateText} · ${byRegion ? "Region" : "District manager"} for this day`}</p>
          {canEdit ? (
            <ScopePicker
              byLine={byLine}
              disabled={false}
              label={byRegion ? "Region for this day" : "District manager for this day"}
              onPick={onDayScope}
              scopes={view.scopes}
              value={dayScope}
            />
          ) : (
            <p className="break-words text-sm font-bold text-slate-900">{dayScopeName ?? "None chosen"}</p>
          )}
        </div>
      ) : null}
      {day.halves.length > 1 ? <CrmChoice columns={2} label="Half-day" onChange={onHalf} options={halfOptions} value={half} /> : null}
      {canEdit && view.customersOptional && day.halves.length > 1 ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-500">AM and PM are each optional. Plan one of them or both.</p>
      ) : null}
      {!canEdit ? (
        <CrmNote tone="neutral">{view.canWrite ? "This day has passed, or is not open to change." : "This week is sent. Ask to edit it from Send."}</CrmNote>
      ) : null}
      <div className="grid min-w-0 gap-2">
        <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">{`${day.dateText} · ${half}`}</p>
        <CrmChoice columns={kindOptions.length > 3 ? 2 : 3} label="What you do" onChange={chooseKind} options={kindOptions} value={draft.kind} />
      </div>

      {choosesDistrict && canEdit && dayScope && namesADistrict(draft.kind) ? (
        <HalfScopeControl
          byLine={byLine}
          byRegion={byRegion}
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
        ? (districtGate ??
          (byRegion ? (
            <RegionRepPart canEdit={canEdit} day={day} draft={draft} half={half} onDraft={onDraft} view={view} />
          ) : (
            <WithRepPart canEdit={canEdit} day={day} draft={draft} half={half} onDraft={onDraft} slot={slot} test={test} view={view} />
          )))
        : null}
      {draft.kind === "with_area" ? (districtGate ?? <WithAreaPart canEdit={canEdit} draft={draft} onDraft={onDraft} view={view} />) : null}
      {draft.kind === "with_dm" ? (districtGate ?? <WithDmPart canEdit={canEdit} day={day} draft={draft} onDraft={onDraft} view={view} />) : null}
      {draft.kind === "with_senior"
        ? (districtGate ?? <WithSeniorPart canEdit={canEdit} draft={draft} idPrefix={idPrefix} onDraft={onDraft} slot={slot} test={test} view={view} />)
        : null}
      {draft.kind === "admin" ? <AdminPart canEdit={canEdit} draft={draft} idPrefix={idPrefix} onDraft={onDraft} view={view} /> : null}
      {draft.kind === "single_visit"
        ? (districtGate ?? (
            <SingleVisitPart canEdit={canEdit} date={day.date} draft={draft} half={half} idPrefix={idPrefix} onDraft={onDraft} slot={slot} test={test} view={view} />
          ))
        : null}

      {canEdit && (draft.kind !== null || slot?.kind) ? (
        <div>
          <CrmButton onClick={() => onDraft(emptyDraft())} size="sm" variant="ghost">
            Clear this half-day
          </CrmButton>
        </div>
      ) : null}
      {nextHoldMessage ? <CrmNote tone="warn">{nextHoldMessage}</CrmNote> : null}
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
  test,
  view,
}: {
  canEdit: boolean;
  day: ManagerBoardDay;
  draft: HalfDraft;
  half: ManagerHalf;
  onDraft: (next: HalfDraft) => void;
  slot: ManagerBoardSlot | undefined;
  test: boolean;
  view: ManagerPlanBoardView;
}) {
  // The marks on each of the rep's customers (owner, 2026-10-23): grade, the rep's visits this month against
  // it, his own visits, a live marketing request — and the groups they share. Read for the chosen rep only.
  const insight = useCustomerInsight({ seats: draft.repSeatId ? [draft.repSeatId] : [], date: day.date, test });
  // "Show visit times" (owner, 2026-11-05): read only while the switch is on.
  const [showTimes] = useShowVisitTimes();
  const visitTimes = useCustomerVisitTimes({ seats: draft.repSeatId ? [draft.repSeatId] : [], date: day.date, test, on: showTimes });
  const [group, setGroup] = useState<string | null>(null);
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
    // A rep's old-CRM plan names no brick, so the half says how many customers it holds instead; a customer
    // who is not on the rep's Phoenix list cannot be ticked, so a half of only those has nothing to tick.
    const where =
      repHalf && repHalf.bricks.length > 0
        ? repHalf.bricks.join(", ")
        : repHalf && repHalf.customers.length > 0
          ? plural(repHalf.customers.length, "customer", "customers")
          : null;
    const nothingToTick = rep.weekState === "no_plan" || !repHalf || !repHalf.customers.some((customer) => customer.customerId);
    // Where customers are optional (owner, 2026-11-01) the rep alone is enough, so a rep with nothing to tick is still offered.
    const disabled = !canEdit || (!view.customersOptional && nothingToTick && rep.seatId !== keptSeatId);
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
  // Every rep greyed is a dead end the screen must name (owner walk, 2026-10-28: a product manager planning on
  // time finds the reps not sent yet, since they plan to the same Thursday). One line says why, and one tap
  // turns the half into single visits in the same district, where the area's doctors are.
  const noneToPick = canEdit && options.every((option) => option.disabled);
  const offersSingleVisit = view.slotKinds.some((entry) => entry.key === "single_visit");
  const noneReason = view.reps.every((rep) => rep.weekState === "no_plan")
    ? "No rep here has a plan this week yet, so there is nobody to go with this half."
    : "No rep here has customers planned this half, so there is nobody to go with.";
  const chosen = draft.repSeatId ? halves.get(draft.repSeatId) : undefined;
  const repCustomers = chosen?.customers ?? [];
  // The customers he can tick: all of a Phoenix rep's, and the ones of an old-CRM rep's plan that sit on the
  // rep's Phoenix list. The rest show and wait (`customerId` null).
  const tickable = repCustomers.flatMap((customer) => (customer.customerId ? [{ customerId: customer.customerId, name: customer.name }] : []));
  const onDay = new Set(tickable.map((customer) => customer.customerId));
  // A customer he ticked that the rep has since dropped from this half stays, flagged, until he unticks it.
  const dropped = (slot?.repSeatId === draft.repSeatId ? (slot?.customers ?? []) : []).filter(
    (customer) => customer.customerId && !onDay.has(customer.customerId),
  );
  const ticked = new Set(draft.customers.map((customer) => customer.key));
  const marks = insight.data?.insights ?? {};
  const groupable: GroupableCustomer[] = repCustomers.flatMap((customer) =>
    customer.customerId ? [{ id: customer.customerId, speciality: customer.speciality, place: customer.brickName ?? customer.zone, pharmacy: marks[customer.customerId]?.pharmacy ?? null }] : [],
  );
  const groups = insight.data ? customerGroups(groupable, marks, insight.data.monthName) : [];
  const suggested = suggestedCustomers(groupable.map((customer) => customer.id), marks);
  // The customers worth his half-day most come first; the rest keep the rep's own order.
  const ordered = [...repCustomers].sort(
    (left, right) => Number(suggested.has(right.customerId ?? "")) - Number(suggested.has(left.customerId ?? "")),
  );

  return (
    <div className="grid min-w-0 gap-4">
      <CrmChoice
        columns={2}
        label="Which rep"
        onChange={(seatId) => {
          setGroup(null);
          onDraft({ ...draft, repSeatId: seatId, customers: [] });
        }}
        options={options}
        value={draft.repSeatId}
      />
      {noneToPick ? (
        <div className="grid min-w-0 gap-2 border border-slate-200 p-3">
          <p className="break-words text-sm font-semibold leading-6 text-slate-700">{noneReason}</p>
          {offersSingleVisit ? (
            <div>
              <CrmButton onClick={() => onDraft({ ...emptyDraft(), kind: "single_visit", scope: draft.scope, note: draft.note })} size="sm" variant="primary">
                Make single visits in this district instead
              </CrmButton>
            </div>
          ) : null}
        </div>
      ) : null}
      {draft.repSeatId && view.customersOptional && !chosen && dropped.length === 0 ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-500">This rep has no customers planned this half. The rep alone is enough to save it.</p>
      ) : null}
      {chosen || dropped.length > 0 ? (
        <div className="grid min-w-0 gap-3 border border-slate-200 p-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-black text-slate-900">
              {`${view.customersOptional ? "Customers (optional) · " : ""}${countText(draft.customers.length)} of ${plural(tickable.length + dropped.length, "customer", "customers")} ticked`}
              {chosen?.weekState === "not_sent" ? (
                <CrmPill className="ml-2" tone="warn">
                  Not sent
                </CrmPill>
              ) : null}
            </p>
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <CrmButton
                  disabled={tickable.length === 0}
                  onClick={() => onDraft({ ...draft, customers: tickable.map((customer) => repRef(customer.customerId, customer.name)) })}
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
          {chosen?.weekState === "old_crm" ? (
            <p className="text-xs font-semibold leading-5 text-sky-800">
              This is the plan the rep filed in the old CRM. A customer who is not on the rep&apos;s Phoenix list is shown but cannot be ticked.
            </p>
          ) : null}
          {!chosen ? (
            <p className="text-xs font-semibold leading-5 text-amber-800">The rep has nothing planned this half any more. Untick the customers below, or choose another rep.</p>
          ) : null}
          {chosen ? <CustomerGroupBar active={group} customers={groupable} insight={insight.data} onActive={setGroup} /> : null}
          <div>
            <VisitTimesToggle />
          </div>
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            {ordered.map((customer, index) => {
              const details = [customer.grade ? `Grade ${customer.grade}` : null, customer.speciality, customer.brickName ?? customer.zone].filter(Boolean).join(" · ");
              const customerId = customer.customerId;
              if (!customerId) {
                return (
                  <div className="min-w-0 border border-dashed border-slate-300 p-2.5" key={`off-list-${index}-${customer.name}`}>
                    <span className="block break-words text-sm font-semibold text-slate-700" dir="auto">
                      {customer.name}
                    </span>
                    <span className="block break-words text-xs font-semibold text-slate-500">{details}</span>
                    <span className="block text-xs font-bold text-slate-500">Not on the rep&apos;s Phoenix list</span>
                  </div>
                );
              }
              const look = groupLook(group, groups, customerId);
              return (
                <CustomerCard dimmed={look.dimmed} grade={marks[customerId]?.grade ?? customer.grade} highlight={look.highlight} key={customerId}>
                  <CrmCheck checked={ticked.has(`c:${customerId}`)} disabled={!canEdit} onChange={(on) => onDraft(toggle(draft, repRef(customerId, customer.name), on))}>
                    <span className="block break-words" dir="auto">
                      {customer.name}
                    </span>
                    <span className="block break-words text-xs font-semibold text-slate-500">{details}</span>
                    <CustomerMarks insight={marks[customerId]} monthName={insight.data?.monthName ?? ""} suggested={suggested.has(customerId)} />
                    {showTimes ? <CustomerVisitTimesLines customerKey={customerId} error={visitTimes.error} today={day.date} view={visitTimes.data} /> : null}
                  </CrmCheck>
                </CustomerCard>
              );
            })}
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

/**
 * The Training Manager's With a rep (owner, 2026-10-24: "he neevr choose dr he choose the region then the
 * area/rep only"): the reps of the region she chose, each with where the rep is that half-day. She picks the
 * rep and nothing else, so a rep with no plan is still offered.
 */
function RegionRepPart({
  canEdit,
  day,
  draft,
  half,
  onDraft,
  view,
}: {
  canEdit: boolean;
  day: ManagerBoardDay;
  draft: HalfDraft;
  half: ManagerHalf;
  onDraft: (next: HalfDraft) => void;
  view: ManagerPlanBoardView;
}) {
  if (view.reps.length === 0) return <CrmEmpty message="No rep sits in this region right now." title="No reps" />;
  const halves = new Map(day.repHalves.filter((entry) => entry.half === half).map((entry) => [entry.seatId, entry]));
  const options: Array<CrmChoiceOption<string>> = view.reps.map((rep) => {
    const repHalf = halves.get(rep.seatId);
    const state = REP_WEEK[repHalf?.weekState ?? rep.weekState];
    const where = repHalf && repHalf.bricks.length > 0 ? repHalf.bricks.join(", ") : null;
    return {
      value: rep.seatId,
      label: rep.name,
      disabled: !canEdit,
      note: (
        <span className="grid gap-1">
          <span className="break-words">{rep.territoryName}</span>
          {where ? <span className="break-words">{where}</span> : null}
          <span>
            <CrmPill tone={state.tone}>{state.label}</CrmPill>
          </span>
        </span>
      ),
    };
  });
  return (
    <CrmChoice
      columns={2}
      label="Which rep"
      onChange={(seatId) => onDraft({ ...draft, repSeatId: seatId, customers: [] })}
      options={options}
      value={draft.repSeatId}
    />
  );
}

/** The Training Manager's An area (owner, 2026-10-24): one area of the region she chose, a vacant one by its own name. */
function WithAreaPart({
  canEdit,
  draft,
  onDraft,
  view,
}: {
  canEdit: boolean;
  draft: HalfDraft;
  onDraft: (next: HalfDraft) => void;
  view: ManagerPlanBoardView;
}) {
  if (view.areas.length === 0) return <CrmEmpty message="This region has no area right now." title="No areas" />;
  const options: Array<CrmChoiceOption<string>> = view.areas.map((area) => ({
    value: area.seatId,
    label: area.areaName,
    note: area.vacant ? "Vacant" : (area.repName ?? area.territoryName),
    disabled: !canEdit,
  }));
  return (
    <CrmChoice
      columns={2}
      label="Which area"
      onChange={(areaSeatId) => onDraft({ ...draft, areaSeatId, customers: [] })}
      options={options}
      value={draft.areaSeatId}
    />
  );
}

/**
 * With a district manager (owner, 2026-10-23: "he chooses one, then all his areas including vacant appear"):
 * every area of the district manager picked for the half-day, a vacant one by its own name, ticked one or more.
 */
function WithDmPart({
  canEdit,
  day,
  draft,
  onDraft,
  view,
}: {
  canEdit: boolean;
  day: ManagerBoardDay;
  draft: HalfDraft;
  onDraft: (next: HalfDraft) => void;
  view: ManagerPlanBoardView;
}) {
  if (!draft.scope?.startsWith("dm:")) {
    return <CrmEmpty message="Choose a district manager above. Any rep in the line has no district manager to go with." title="Choose the district manager" />;
  }
  const dmSeatId = draft.scope.slice("dm:".length);
  const dmDay = (
    <DistrictManagerDayPanel
      dmDay={day.districtManagerDays.find((entry) => entry.dmSeatId === dmSeatId) ?? null}
      dmName={view.scopes.find((scope) => scope.key === draft.scope)?.dmName ?? null}
      unread={view.districtManagerPlanUnread}
    />
  );
  if (view.areas.length === 0) {
    return (
      <div className="grid min-w-0 gap-3">
        {dmDay}
        <CrmEmpty message="This district manager has no area right now." title="No areas" />
      </div>
    );
  }
  const ticked = new Set(draft.areaSeatIds);
  const toggleArea = (seatId: string, on: boolean) => {
    const without = draft.areaSeatIds.filter((id) => id !== seatId);
    onDraft({ ...draft, areaSeatIds: on ? [...without, seatId] : without });
  };
  return (
    <div className="grid min-w-0 gap-3">
      {dmDay}
      <div className="grid min-w-0 gap-3 border border-slate-200 p-3">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-black text-slate-900">{`${countText(draft.areaSeatIds.length)} of ${plural(view.areas.length, "area", "areas")} ticked`}</p>
          {canEdit ? (
            <div className="flex flex-wrap gap-2">
              <CrmButton onClick={() => onDraft({ ...draft, areaSeatIds: view.areas.map((area) => area.seatId) })} size="sm" variant="primary">
                Mark all
              </CrmButton>
              <CrmButton disabled={draft.areaSeatIds.length === 0} onClick={() => onDraft({ ...draft, areaSeatIds: [] })} size="sm">
                Clear
              </CrmButton>
            </div>
          ) : null}
        </div>
        <div className="grid min-w-0 gap-2 sm:grid-cols-2">
          {view.areas.map((area) => (
            <CrmCheck checked={ticked.has(area.seatId)} disabled={!canEdit} key={area.seatId} onChange={(on) => toggleArea(area.seatId, on)}>
              <span className="block break-words" dir="auto">
                {area.areaName}
              </span>
              <span className={`block break-words text-xs font-semibold ${area.vacant ? "text-amber-700" : "text-slate-500"}`}>
                {area.vacant ? "Vacant" : (area.repName ?? area.territoryName)}
              </span>
            </CrmCheck>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The district manager's own plan for the day (owner, 2026-11-08: "they must see this district manager plan is
 * planning what today — with a rep, a single, double, area — and see the doctors also"). Read only: each half he
 * planned, the rep on a double visit, the area, and the doctors he ticked. His week is shown as it stands, a draft
 * included, with its status said; a read that failed is said, never shown as nothing planned.
 */
function DistrictManagerDayPanel({ dmDay, dmName, unread }: { dmDay: DistrictManagerDay | null; dmName: string | null; unread: boolean }) {
  const who = dmDay?.dmName ?? dmName ?? "The district manager";
  if (unread) {
    return <CrmNote tone="warn" title={`${who}'s own plan for this day`}>It could not be read just now. Reload the page to try again.</CrmNote>;
  }
  if (!dmDay) {
    return <CrmNote tone="neutral" title="The district manager's own plan for this day">Nobody holds this district manager seat, so there is no plan to show.</CrmNote>;
  }
  return (
    <div className="grid min-w-0 gap-2 border border-slate-200 p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="break-words text-sm font-black text-slate-900">{`${who}'s own plan for this day`}</p>
        <CrmPill tone={dmDay.sent ? "info" : "warn"}>{dmDay.sent ? dmDay.statusLabel : `${dmDay.statusLabel} · not sent yet`}</CrmPill>
      </div>
      {dmDay.halves.length === 0 ? (
        <p className="break-words text-sm font-semibold leading-6 text-slate-500">Nothing is planned for this day yet.</p>
      ) : (
        <ul className="grid min-w-0 gap-2">
          {dmDay.halves.map((entry) => (
            <li className="grid min-w-0 gap-1 border-t border-slate-100 pt-2 first:border-t-0 first:pt-0" key={entry.half}>
              <p className="break-words text-sm font-bold leading-6 text-slate-900">
                <span className="font-black">{entry.half}</span>
                {` · ${entry.kindLabel}`}
                {entry.repName ? <> · with <bdi>{entry.repName}</bdi></> : null}
                {entry.detail ? <> · <bdi>{entry.detail}</bdi></> : null}
              </p>
              {entry.areaName ? (
                <p className="break-words text-xs font-semibold text-slate-500">
                  Area · <bdi>{entry.areaName}</bdi>
                </p>
              ) : null}
              {entry.customers.length > 0 ? (
                <ul className="grid min-w-0 gap-1 sm:grid-cols-2">
                  {entry.customers.map((customer) => (
                    <li className={`break-words text-xs font-semibold leading-5 ${customer.gone ? "text-slate-400 line-through" : "text-slate-700"}`} key={customer.key}>
                      <bdi>{customer.name}</bdi>
                      {customer.speciality ? ` · ${customer.speciality}` : ""}
                      {customer.grade ? ` · Grade ${customer.grade}` : ""}
                    </li>
                  ))}
                </ul>
              ) : entry.kindLabel !== "Admin" ? (
                <p className="break-words text-xs font-semibold text-slate-500">No customers chosen for this half.</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * With my manager or product manager (owner, 2026-10-23: "in district managers account make them able to put the
 * pm/gpm w regional manager … follow organogram"): the people the organogram puts above the district manager's
 * own seat — the regional manager where the line has one, then the national sales manager — and the line's
 * product managers, as the server offers them; then the areas of the district, a vacant one by its own name.
 * A regional, national or product manager's With a manager or product manager (owner, 2026-10-25) is the same
 * part, in the district he picked first, with the people the server offers him there.
 *
 * 🔴 THE DOCTORS ARE OPTIONAL (owner, 2026-10-27: "all the doctor list of this area appear, but he is not
 * required to choose. He may choose or he may press the next"): once an area is ticked its rep lists show, and
 * whatever he ticks there is on "My single visits" that day as planned visits — none is a valid half-day.
 */
function WithSeniorPart({
  canEdit,
  draft,
  idPrefix,
  onDraft,
  slot,
  test,
  view,
}: {
  canEdit: boolean;
  draft: HalfDraft;
  idPrefix: string;
  onDraft: (next: HalfDraft) => void;
  slot: ManagerBoardSlot | undefined;
  test: boolean;
  view: ManagerPlanBoardView;
}) {
  const [pickedArea, setPickedArea] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(AREA_PAGE);
  // Unticking an area, or Clear, that would take off customers he already chose asks first (owner walk,
  // 2026-10-28: one stray untick dropped six chosen doctors with no word). Null seat = Clear, every area.
  const [dropAsk, setDropAsk] = useState<{ seatId: string | null; count: number } | null>(null);
  // The list shown is one ticked area's at a time: the one he last ticked or picked, or the first he ticked.
  const listArea = pickedArea && draft.areaSeatIds.includes(pickedArea) ? pickedArea : (draft.areaSeatIds[0] ?? null);
  // The half's district or line rides along, so another line's reps in the same area never join the list.
  const area = useCrmGet<AreaCustomersView>(listArea && canEdit ? crmUrl(AREA, { area: listArea, scope: view.scope, test }) : null, "area");
  // A regional, national or product manager picks the district first (owner, 2026-10-25).
  const ownDistrict = view.writer?.kind === "dm";
  if (!ownDistrict && !draft.scope?.startsWith("dm:")) {
    return <CrmEmpty message="Choose a district manager above. Any rep in the line names no district to go in." title="Choose the district manager" />;
  }
  if (view.seniors.length === 0) {
    return (
      <CrmEmpty
        message={
          ownDistrict
            ? "Nobody holds a manager seat above yours, and your line has no product manager, right now."
            : "Nobody else holds a manager seat in this district's line, and it has no product manager, right now."
        }
        title="Nobody to go with"
      />
    );
  }
  const options: Array<CrmChoiceOption<string>> = view.seniors.map((senior) => ({ value: senior.hrId, label: senior.name, note: senior.title, disabled: !canEdit }));
  const ticked = new Set(draft.areaSeatIds);
  const dropArea = (seatId: string | null) => {
    setDropAsk(null);
    if (seatId === null) {
      onDraft({ ...draft, areaSeatIds: [], customers: [] });
      return;
    }
    onDraft({
      ...draft,
      areaSeatIds: draft.areaSeatIds.filter((id) => id !== seatId),
      customers: draft.customers.filter((customer) => customer.areaSeatId !== seatId),
    });
  };
  const askDrop = (seatId: string | null) => {
    const count = seatId === null ? draft.customers.length : draft.customers.filter((customer) => customer.areaSeatId === seatId).length;
    if (count > 0) setDropAsk({ seatId, count });
    else dropArea(seatId);
  };
  const toggleArea = (seatId: string, on: boolean) => {
    // Unticking an area takes off the customers chosen in it, so it asks first when there are some.
    if (!on) {
      askDrop(seatId);
      return;
    }
    // The area he ticks is the list he sees (owner, 2026-10-27: "every area he stands on its list appears").
    setPickedArea(seatId);
    setQuery("");
    setLimit(AREA_PAGE);
    onDraft({ ...draft, areaSeatIds: [...draft.areaSeatIds.filter((id) => id !== seatId), seatId] });
  };
  const dropAreaName = dropAsk?.seatId ? (view.areas.find((entry) => entry.seatId === dropAsk.seatId)?.areaName ?? "this area") : null;
  const chosen = new Set(draft.customers.map((customer) => customer.key));
  const listVacant = view.areas.some((entry) => entry.seatId === listArea && entry.vacant);
  // Arabic spellings read as one (مستشفى / مستشفي, أحمد / احمد), and the speciality and rep are searched too.
  const repList = (area.data && area.data.area?.seatId === listArea ? area.data.repList : [])
    .filter((customer) => foldedWordsMatch(query, [customer.name, customer.speciality, customer.repName]))
    .sort((left, right) => compareFoldedNames(left.name, right.name));
  const shown = repList.slice(0, limit);
  const areaChoices: Array<CrmChoiceOption<string>> = view.areas
    .filter((entry) => draft.areaSeatIds.includes(entry.seatId))
    .map((entry) => ({ value: entry.seatId, label: entry.areaName, note: entry.vacant ? VACANT_AREA_NOTE : (entry.repName ?? "No rep") }));
  return (
    <div className="grid min-w-0 gap-4">
      <CrmChoice columns={2} label="Who you go with" onChange={(seniorHrId) => onDraft({ ...draft, seniorHrId })} options={options} value={draft.seniorHrId} />
      {view.areas.length === 0 ? (
        <CrmEmpty message={ownDistrict ? "Your district has no area right now." : "This district manager has no area right now."} title="No areas" />
      ) : (
        <div className="grid min-w-0 gap-3 border border-slate-200 p-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-black text-slate-900">{`${countText(draft.areaSeatIds.length)} of ${plural(view.areas.length, "area", "areas")} ticked`}</p>
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <CrmButton onClick={() => onDraft({ ...draft, areaSeatIds: view.areas.map((area) => area.seatId) })} size="sm" variant="primary">
                  Mark all
                </CrmButton>
                <CrmButton disabled={draft.areaSeatIds.length === 0} onClick={() => askDrop(null)} size="sm">
                  Clear
                </CrmButton>
              </div>
            ) : null}
          </div>
          {dropAsk ? (
            <CrmNote
              title={
                dropAreaName
                  ? `Untick ${dropAreaName} and take off its ${plural(dropAsk.count, "chosen customer", "chosen customers")}?`
                  : `Clear every area and take off the ${plural(dropAsk.count, "chosen customer", "chosen customers")}?`
              }
              tone="warn"
            >
              <div className="mt-2 flex flex-wrap gap-2">
                <CrmButton onClick={() => dropArea(dropAsk.seatId)} size="sm" variant="primary">
                  Take them off
                </CrmButton>
                <CrmButton onClick={() => setDropAsk(null)} size="sm">
                  Keep them
                </CrmButton>
              </div>
            </CrmNote>
          ) : null}
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            {view.areas.map((area) => (
              <CrmCheck checked={ticked.has(area.seatId)} disabled={!canEdit} key={area.seatId} onChange={(on) => toggleArea(area.seatId, on)}>
                <span className="block break-words" dir="auto">
                  {area.areaName}
                </span>
                <span className={`block break-words text-xs font-semibold ${area.vacant ? "text-amber-700" : "text-slate-500"}`}>
                  {area.vacant ? "Vacant" : (area.repName ?? area.territoryName)}
                </span>
              </CrmCheck>
            ))}
          </div>
        </div>
      )}
      {!canEdit ? (
        (slot?.customers.length ?? 0) > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {(slot?.customers ?? []).map((customer) => (
              <CrmPill key={customer.customerId ?? customer.name} tone="neutral">
                <span className="break-words normal-case tracking-normal" dir="auto">
                  {customer.name}
                </span>
              </CrmPill>
            ))}
          </div>
        ) : null
      ) : draft.areaSeatIds.length > 0 ? (
        <div className="grid min-w-0 gap-4 border border-slate-200 p-3">
          <div className="grid min-w-0 gap-1">
            <p className="text-sm font-black text-slate-900">{`Customers (optional) · ${plural(draft.customers.length, "customer", "customers")} chosen`}</p>
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">
              Tick the customers you plan to see, or go on without them. The ones you tick are on My single visits that day.
            </p>
          </div>
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
          {areaChoices.length > 1 ? (
            <CrmChoice
              columns={3}
              label="Show the list of"
              onChange={(seatId) => {
                setPickedArea(seatId);
                setQuery("");
                setLimit(AREA_PAGE);
              }}
              options={areaChoices}
              value={listArea}
            />
          ) : null}
          {area.error ? <CrmLoadError message={area.error} onRetry={area.reload} /> : null}
          {!area.data && !area.error ? <CrmLoading label="Loading the area's customers" /> : null}
          {area.data ? (
            <>
              <CrmSearchField id={`${idPrefix}-senior-search`} label="Find a customer" onChange={setQuery} placeholder="Type a name" value={query} />
              <div className="grid min-w-0 gap-2">
                <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">
                  {listVacant ? `${VACANT_LIST_LABEL} · this area has no rep` : "The area's rep lists"}
                </p>
                {repList.length === 0 ? (
                  <p className="text-sm font-semibold text-slate-500">
                    {query.trim()
                      ? "No customer on these lists matches."
                      : listVacant
                        ? "The previous rep left no list in this area."
                        : "This area has no customers on its lists yet."}
                  </p>
                ) : null}
                <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                  {shown.map((customer) => (
                    <CustomerCard dimmed={false} grade={customer.grade} highlight={null} key={customer.customerId}>
                      <CrmCheck
                        checked={chosen.has(repRef(customer.customerId, customer.name).key)}
                        onChange={(on) => onDraft(toggle(draft, { ...repRef(customer.customerId, customer.name), areaSeatId: listArea }, on))}
                      >
                        <span className="block break-words" dir="auto">
                          {customer.name}
                        </span>
                        <span className="block break-words text-xs font-semibold text-slate-500">
                          {[customer.listType, customer.grade ? `Grade ${customer.grade}` : null, customer.speciality, customer.vacant ? VACANT_LIST_LABEL : (customer.repName ?? "No rep")]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </CrmCheck>
                    </CustomerCard>
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
  return (
    <div className="grid min-w-0 gap-4">
      {/* Ten activities, eleven with Office (everyone but a district manager): rows of four, never wider —
          inside the half-day panel a wider row squeezes "Admin work" to one word a line. */}
      <CrmChoice
        columns={4}
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
  date,
  draft,
  half,
  idPrefix,
  onDraft,
  slot,
  test,
  view,
}: {
  canEdit: boolean;
  date: string;
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
  const area = useCrmGet<AreaCustomersView>(draft.areaSeatId && canEdit ? crmUrl(AREA, { area: draft.areaSeatId, scope: view.scope, test }) : null, "area");
  // The marks on each customer of the area (owner, 2026-10-23), over every territory its lists come from, and
  // his own list's customers with his own visits.
  const areaSeats = area.data && area.data.area?.seatId === draft.areaSeatId ? [...new Set(area.data.repList.map((customer) => customer.seatId))] : [];
  const insight = useCustomerInsight({ seats: areaSeats, own: true, date, test });
  // "Show visit times" (owner, 2026-11-05): read only while the switch is on.
  const [showTimes] = useShowVisitTimes();
  const visitTimes = useCustomerVisitTimes({ seats: areaSeats, own: true, date, test, on: showTimes });
  const [group, setGroup] = useState<string | null>(null);
  if (view.areas.length === 0) {
    return <CrmEmpty message={choosesADistrict(view) ? "No area of this district is on file yet." : "No area of your district is on file yet."} title="No areas" />;
  }

  // 🔴 AT THE CAP THE AREA IS NOT OFFERED (owner walk, 2026-10-28): with his two free half-days spent and this
  // date not approved, he could still pick an area and tick doctors, and only the save refused the lot. A
  // half already saved as single visits is one of the two, so it stays open to change.
  const atCap =
    view.writer?.kind === "dm" &&
    (view.singleVisitHalvesUsed ?? 0) >= DM_SINGLE_VISIT_HALF_DAYS_MAX &&
    !(view.singleVisitDaysApproved ?? []).includes(date) &&
    slot?.kind !== "single_visit";
  // A vacant area is offered by its name like any other, and its list is the previous rep's (owner, 2026-10-19).
  const areaOptions: Array<CrmChoiceOption<string>> = view.areas.map((entry) => ({
    value: entry.seatId,
    label: entry.areaName,
    note: entry.vacant ? VACANT_AREA_NOTE : (entry.repName ?? "No rep"),
    disabled: !canEdit || atCap,
  }));
  const chosenVacant = view.areas.some((entry) => entry.seatId === draft.areaSeatId && entry.vacant);
  const ticked = new Set(draft.customers.map((customer) => customer.key));
  const matches = (...parts: Array<string | null>) => foldedWordsMatch(query, parts);
  const marks = insight.data?.insights ?? {};
  const allRep = area.data?.repList ?? [];
  const groupable: GroupableCustomer[] = allRep.map((customer) => ({
    id: customer.customerId,
    speciality: customer.speciality,
    // An area list carries no brick per customer; the speciality and the pharmacy are what a group shares here.
    place: null,
    pharmacy: marks[customer.customerId]?.pharmacy ?? null,
  }));
  const groups = insight.data ? customerGroups(groupable, marks, insight.data.monthName) : [];
  const suggested = suggestedCustomers(
    allRep.filter((customer) => customer.listType === half).map((customer) => customer.customerId),
    marks,
  );
  // This half's list first, the customers worth the visit most at its top, then by name.
  const repList = allRep
    .filter((customer) => matches(customer.name, customer.speciality, customer.repName))
    .sort(
      (left, right) =>
        Number(right.listType === half) - Number(left.listType === half) ||
        Number(suggested.has(right.customerId)) - Number(suggested.has(left.customerId)) ||
        (insight.data ? customerPriority(marks[right.customerId]) - customerPriority(marks[left.customerId]) : 0) ||
        compareFoldedNames(left.name, right.name),
    );
  const ownList = (area.data?.ownList ?? []).filter((customer) => customer.status === "active" && matches(customer.name, customer.speciality));
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

  // A district manager has one day of single visits a week without approval — two half-days (owner,
  // 2026-10-19). The count is the server's — his planned halves AND the visits he has logged — so it never
  // says "1 of 2" while the save refuses because a logged visit already holds the second half-day. A second
  // or third day is his managers' to approve, one named date at a time (owner, 2026-10-20), asked for here.

  return (
    <div className="grid min-w-0 gap-4">
      {view.writer?.kind === "dm" && view.singleVisitHalvesUsed !== null ? (
        <p className="break-words text-xs font-semibold leading-5 text-slate-500">
          {dmSingleVisitLimitLine(view.singleVisitHalvesUsed, view.singleVisitDaysApproved?.length ?? 0)}
        </p>
      ) : null}
      {/* Asked where it bites: once the free day is spent and this date is not one his managers approved. */}
      {view.writer?.kind === "dm" &&
      canEdit &&
      (view.singleVisitHalvesUsed ?? 0) >= DM_SINGLE_VISIT_HALF_DAYS_MAX &&
      !(view.singleVisitDaysApproved ?? []).includes(date) ? (
        <ManagerSingleVisitDayAsk preferDate={date} test={test} />
      ) : null}
      <CrmChoice
        columns={3}
        label="Area"
        onChange={(areaSeatId) => {
          setGroup(null);
          onDraft({ ...draft, areaSeatId, customers: [] });
        }}
        options={areaOptions}
        value={draft.areaSeatId}
      />

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
          <p className="text-sm font-black text-slate-900">{`${view.customersOptional ? "Customers (optional) · " : ""}${plural(draft.customers.length, "customer", "customers")} chosen`}</p>
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
              {allRep.length > 0 ? <CustomerGroupBar active={group} customers={groupable} insight={insight.data} onActive={setGroup} /> : null}
              <div>
                <VisitTimesToggle />
              </div>
              {ownList.length > 0 ? (
                <div className="grid min-w-0 gap-2">
                  <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Manager&apos;s own list</p>
                  <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                    {ownList.map((customer) => (
                      <CustomerCard dimmed={false} grade={customer.grade} highlight={null} key={customer.id}>
                        <CrmCheck checked={ticked.has(`m:${customer.id}`)} onChange={(on) => onDraft(toggle(draft, ownRef(customer.id, customer.name), on))}>
                          <span className="block break-words" dir="auto">
                            {customer.name}
                          </span>
                          <span className="block break-words text-xs font-semibold text-slate-500">
                            {[`Grade ${customer.grade}`, customer.potentialGrade, customer.speciality].filter(Boolean).join(" · ")}
                          </span>
                          <CustomerMarks insight={marks[ownInsightKey(customer.id)]} monthName={insight.data?.monthName ?? ""} suggested={false} />
                          {showTimes ? (
                            <CustomerVisitTimesLines customerKey={ownInsightKey(customer.id)} error={visitTimes.error} ownList today={date} view={visitTimes.data} />
                          ) : null}
                        </CrmCheck>
                      </CustomerCard>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="grid min-w-0 gap-2">
                <p className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">
                  {chosenVacant ? `${VACANT_LIST_LABEL} · this area has no rep` : "The area's rep lists"}
                </p>
                {chosenVacant ? (
                  <p className="break-words text-xs font-semibold leading-5 text-slate-500">
                    When you log the visit, type the customer&apos;s address or press Capture location — one of the two is needed in a vacant area.
                  </p>
                ) : null}
                {repList.length === 0 ? (
                  <p className="text-sm font-semibold text-slate-500">
                    {query.trim()
                      ? "No customer on these lists matches."
                      : chosenVacant
                        ? "The previous rep left no list in this area. Add a customer to Manager's own list instead."
                        : "This area has no customers on its lists yet."}
                  </p>
                ) : null}
                <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                  {shown.map((customer) => {
                    const look = groupLook(group, groups, customer.customerId);
                    return (
                      <CustomerCard dimmed={look.dimmed} grade={customer.grade} highlight={look.highlight} key={customer.customerId}>
                        <CrmCheck checked={ticked.has(`c:${customer.customerId}`)} onChange={(on) => onDraft(toggle(draft, repRef(customer.customerId, customer.name), on))}>
                          <span className="block break-words" dir="auto">
                            {customer.name}
                          </span>
                          <span className="block break-words text-xs font-semibold text-slate-500">
                            {[customer.listType, customer.grade ? `Grade ${customer.grade}` : null, customer.speciality, customer.vacant ? VACANT_LIST_LABEL : (customer.repName ?? "No rep")]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          <CustomerMarks insight={marks[customer.customerId]} monthName={insight.data?.monthName ?? ""} suggested={suggested.has(customer.customerId)} />
                          {showTimes ? <CustomerVisitTimesLines customerKey={customer.customerId} error={visitTimes.error} today={date} view={visitTimes.data} /> : null}
                        </CrmCheck>
                      </CustomerCard>
                    );
                  })}
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
  latestPlan,
  onChanged,
  onOpenHalf,
  problemOf,
  saveWaiting,
  test,
  view,
  waitingProblems,
}: {
  days: ManagerBoardDay[];
  drafts: Record<string, HalfDraft>;
  idPrefix: string;
  /** The week as the last save or read left it — newer than `view` the moment Send saves what was waiting. */
  latestPlan: () => ManagerPlanBoardView["plan"];
  onChanged: () => void;
  /** Opens a half-day that is not saved yet, to finish it. */
  onOpenHalf: (date: string, half: ManagerHalf) => void;
  problemOf: (waiting: HalfDraft) => string | null;
  saveWaiting: () => Promise<boolean>;
  test: boolean;
  view: ManagerPlanBoardView;
  waitingProblems: WaitingProblem[];
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [asked, setAsked] = useState(false);
  const plan = view.plan;
  const sendWord = sendWordOf(view);
  // A passed day is history, never a gap to fill: the count is of the days still to come (owner walk,
  // 2026-10-28: "2 of 11 planned" on a Tuesday counted Saturday to Monday against him).
  const comingDays = days.filter((day) => !day.passed);
  // A half-day on the page counts once it can be saved: a choice still missing something goes nowhere.
  const isPlanned = (day: ManagerBoardDay, half: ManagerHalf) => {
    const waiting = drafts[halfKey(day.date, half)];
    if (waiting) return waiting.kind !== null && !problemOf(waiting);
    return day.slots.some((slot) => slot.half === half && slot.kind);
  };
  const planned = comingDays.reduce((sum, day) => sum + day.halves.filter((half) => isPlanned(day, half)).length, 0);
  const fieldHalves = comingDays.reduce((sum, day) => sum + day.halves.length, 0);
  const emptyHalves = comingDays.flatMap((day) => (day.editable ? day.halves.filter((half) => !isPlanned(day, half)).map((half) => `${day.dateText} ${half}`) : []));
  const offRepDay = days.flatMap((day) => day.slots.flatMap((slot) => slot.customers.filter((customer) => customer.flag))).length;
  // Who decides it, in order — and, for everyone but a district manager, HR's own acknowledgement after.
  const route = [plan?.firstApproverName, plan?.secondApproverName].filter(Boolean).join(", then ");
  const hrAcknowledges = choosesADistrict(view);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      if (Object.keys(drafts).length > 0 && !(await saveWaiting())) {
        setError(waitingProblems[0] ? `Finish or clear ${waitingProblems[0].dayText} ${waitingProblems[0].half} first: ${waitingProblems[0].problem}.` : "A half-day could not be saved. Try again.");
        setBusy(false);
        return;
      }
      // Saving what was waiting moved the week's version (and may have made the week), so the send carries
      // the week as that save answered — never the one drawn before it, which the server refuses as
      // "changed on another screen".
      const current = latestPlan() ?? plan;
      if (!current?.planId) {
        setError("Plan at least one half-day first.");
        setBusy(false);
        return;
      }
      await crmPost<ManagerPlanTransitionResult>("/api/phoenix-crm/manager-plans/submit", { planId: current.planId, version: current.version, test }, "plan");
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
                const problem = waiting ? problemOf(waiting) : null;
                return (
                  <div className="grid min-w-0 gap-0.5 px-3 py-2" key={half}>
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{half}</span>
                      <span className={`min-w-0 break-words text-sm font-bold ${problem ? "text-amber-800" : "text-slate-900"}`}>
                        {problem ? `Not saved: ${problem}` : waiting ? "Not saved yet" : (slot?.summary ?? "Nothing planned")}
                      </span>
                      {problem ? (
                        <CrmButton onClick={() => onOpenHalf(day.date, half)} size="sm">
                          Finish it
                        </CrmButton>
                      ) : null}
                      {flags.length > 0 ? <CrmPill tone="warn">{`${countText(flags.length)} not on the rep's day`}</CrmPill> : null}
                    </div>
                    {/* What he is sending, by name: a count alone made him open every day to check it. */}
                    {!waiting && slot && slot.customers.length > 0 ? (
                      <p className="min-w-0 break-words text-xs font-semibold leading-5 text-slate-600" dir="auto">
                        {slot.customers.map((customer) => customer.name).join(" · ")}
                      </p>
                    ) : null}
                    {!waiting && slot?.note ? (
                      <p className="min-w-0 whitespace-pre-line break-words text-xs font-semibold leading-5 text-slate-500" dir="auto">
                        {slot.note}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
      </div>
      <p className="text-sm font-semibold text-slate-600">
        {`${countText(planned)} of ${plural(fieldHalves, "half-day", "half-days")} still to come planned`}
        {offRepDay > 0 ? ` · ${plural(offRepDay, "customer is", "customers are")} not on the rep's sent day` : ""}
      </p>
      {plan?.state === "plan" && view.canWrite && emptyHalves.length > 0 ? (
        view.customersOptional ? (
          <CrmNote tone="neutral">{`Left empty: ${emptyHalves.join(", ")}. AM and PM are each optional, so you can send it as it is.`}</CrmNote>
        ) : (
          <CrmNote tone="warn">{`Nothing planned yet on ${emptyHalves.join(", ")}. You can still send it; those half-days go empty.`}</CrmNote>
        )
      ) : null}
      {waitingProblems.length > 0 ? (
        <CrmNote tone="warn">{`${waitingProblems.map((entry) => `${entry.dayText} ${entry.half}`).join(", ")} ${waitingProblems.length === 1 ? "is" : "are"} not saved. Finish or clear ${waitingProblems.length === 1 ? "it" : "them"} before you send.`}</CrmNote>
      ) : null}
      {route ? (
        <p className="text-xs font-semibold leading-5 text-slate-500">
          {`It goes to ${route}.${hrAcknowledges ? " Once it is approved, HR acknowledges it automatically." : ""}`}
        </p>
      ) : null}

      {error ? <CrmNote tone="bad">{error}</CrmNote> : null}

      {plan?.state === "plan" && view.canWrite ? (
        confirming ? (
          <CrmNote title={`${sendWord} to ${plan.firstApproverName ?? "your manager"}?`} tone="info">
            <p>Once it is sent, a change needs that approval first.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <CrmButton busy={busy} onClick={() => void send()} variant="primary">
                {sendWord}
              </CrmButton>
              <CrmButton disabled={busy} onClick={() => setConfirming(false)}>
                Not yet
              </CrmButton>
            </div>
          </CrmNote>
        ) : (
          <div>
            <CrmButton disabled={waitingProblems.length > 0 || (planned === 0 && Object.keys(drafts).length === 0)} onClick={() => setConfirming(true)} variant="primary">
              {sendWord}
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
