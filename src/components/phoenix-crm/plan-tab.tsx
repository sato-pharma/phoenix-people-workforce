"use client";

/**
 * Phoenix CRM — the Plan tab: a territory's weekly plan.
 *
 * Owner, 2026-09-16:
 *   - the rep is asked for a weekly plan once the list is ready (every reference customer validated,
 *     or dropped with the district manager's approval);
 *   - the rep places the customers and the system only assists: every customer's days and hours
 *     show, a day's suggestions put uncovered customers first, and a customer placed on a day it does
 *     not receive asks for a reason instead of being refused;
 *   - a plan day holds at most 15 doctors and 5 accounts (settings) — the plan's only hard limit;
 *   - customers far apart on one day are highlighted to the manager who reviews the plan, not to the
 *     rep;
 *   - the district manager approves; the SFE Manager sees every plan and can return one; nothing
 *     approves a plan by itself.
 * The week runs Saturday to Wednesday, plus Thursday morning for accounts only.
 *
 * The rep's changes stay on the phone as a draft over the plan's saved version until "Save the plan".
 * The database refuses a save made against an older version (another screen saved first), and the tab
 * then shows the latest plan.
 */

import type { ReactNode } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, MapPin, Plus, Search } from "lucide-react";

import { crmPost, crmUrl, errorCodeOf, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoStamp, countText, dayLabel, dayLabelLong, plural, weekLabel } from "@/components/phoenix-crm/format";
import {
  customerMetaText,
  monthStanding,
  monthVisitsText,
  PENDING_PILL,
  pendingListNote,
  pendingVisitsText,
  territoryLine,
} from "@/components/phoenix-crm/labels";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmEmpty,
  CrmFacts,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSelect,
  CrmStat,
  CrmStatGrid,
  crmInputClassName,
  crmTextareaClassName,
  type CrmChoiceOption,
  type NoteTone,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { fieldWeekStart, weekdayOfIsoDay } from "@/lib/phoenix-crm/calendar";
import { gradeTarget } from "@/lib/phoenix-crm/coverage";
import { checkDaySpread } from "@/lib/phoenix-crm/geo";
import {
  exceptionLabel,
  PLAN_DECISION_NOTE_MAX,
  PLAN_EXCEPTION_TYPES,
  PLAN_NOTE_MAX,
  type PlanExceptionType,
  type PlanItemDraft,
} from "@/lib/phoenix-crm/plan-rules";
import { normalizeArea, suggestForDay, type DaySuggestion, type PlannerCustomer, type PlannerPlace } from "@/lib/phoenix-crm/suggestions";
import { formatTimingWindow, PHOENIX_CRM_WEEKDAY_NAMES, windowOverlapsRange, windowsForWeekday } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmGrade, PhoenixCrmListType, PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import type { PlanDayView, PlanItemView, PlannerView, SavedPlan } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

type PlanRules = PlannerView["rules"];

type PlanScreen = { name: "week" } | { name: "day"; date: string };

type PlanNotice = { tone: NoteTone; title: string; message?: string | null };

type PlanBusy = "save" | "send" | "reopen" | "approve" | "return";

type LeaveChoice = "save" | "discard" | "stay";

/**
 * The rep's changes to one week, over the saved version they were started on. Once saved, the draft
 * also stands over the version that save wrote, so it outlives the reload that follows (and a reload
 * that failed). A plan changed on another screen comes back as a version the draft does not know, and
 * the draft is set aside.
 */
type Draft = {
  /** Territory, test or live, week. */
  scope: string;
  /** The plan and version on screen when the draft started. */
  basis: string;
  items: PlanItemDraft[];
  /** What the last save wrote, and the version it made. */
  saved: { items: PlanItemDraft[]; planId: string; version: number } | null;
};

/** A refusal that means the plan on screen is out of date: the tab reads it again. */
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

/** What happened, said once the tab already shows the latest plan (the server's own words ask for a reload). */
const RELOADED_MESSAGES: Record<string, string> = {
  phoenix_crm_version_conflict: "This plan was changed on another screen. It now shows the latest version, so make your changes again.",
  phoenix_crm_not_editable: "This plan was sent for review or approved on another screen. It now shows the latest version.",
};

const STATUS_TONE: Record<PhoenixCrmPlanStatus | "none", PillTone> = {
  none: "neutral",
  draft: "neutral",
  submitted: "warn",
  approved: "good",
  returned: "bad",
};

const SUGGESTION_PAGE = 25;

const EXCEPTION_OPTIONS: ReadonlyArray<CrmChoiceOption<PlanExceptionType>> = PLAN_EXCEPTION_TYPES.map((type) => ({
  value: type.key,
  label: type.label,
}));

// ── Reading the plan ────────────────────────────────────────────────────────────────────────────

function asExceptionType(value: string | null): PlanExceptionType | null {
  return PLAN_EXCEPTION_TYPES.find((type) => type.key === value)?.key ?? null;
}

function scopeOf(view: PlannerView): string {
  return [view.territory.seatId, view.isTest ? "test" : "live", view.weekStart].join("|");
}

function basisOf(planId: string | null, version: number | null): string {
  return `${planId ?? "none"}|${version ?? 0}`;
}

function viewBasis(view: PlannerView): string {
  return basisOf(view.plan?.planId ?? null, view.plan?.version ?? null);
}

function draftFits(draft: Draft | null, view: PlannerView): draft is Draft {
  if (draft === null || draft.scope !== scopeOf(view)) return false;
  const current = viewBasis(view);
  return draft.basis === current || (draft.saved !== null && basisOf(draft.saved.planId, draft.saved.version) === current);
}

/** "2 of 5 AM · 9 of 15 PM"; a Thursday morning holds accounts only. */
function dayCountsText(counts: Record<PhoenixCrmListType, number>, day: PlanDayView, rules: PlanRules): string {
  const am = `${countText(counts.AM)} of ${countText(rules.amDailyCap)} AM`;
  return day.listTypes.includes("PM") ? `${am} · ${countText(counts.PM)} of ${countText(rules.pmDailyCap)} PM` : am;
}

/** "3 AM · 41 PM" — AM and PM side by side, never added together. */
function pairText(counts: Record<PhoenixCrmListType, number>, day: PlanDayView): string {
  const am = `${countText(counts.AM)} AM`;
  return day.listTypes.includes("PM") ? `${am} · ${countText(counts.PM)} PM` : am;
}

/** "Evening clinic · Faisal · Brick Haram", each part once; a place with none of them by its order on the customer. */
function placeLine(place: { label: string | null; zone: string | null; brick: string | null }, position: number | null): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const part of [
    { key: normalizeArea(place.label), text: place.label },
    { key: normalizeArea(place.zone), text: place.zone },
    { key: normalizeArea(place.brick), text: place.brick ? `Brick ${place.brick}` : null },
  ]) {
    if (part.key === null || part.text === null || seen.has(part.key)) continue;
    seen.add(part.key);
    parts.push(part.text);
  }
  if (parts.length > 0) return parts.join(" · ");
  return position === null ? "Place with no name" : `Place ${position + 1}`;
}

function roundKm(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

function reviewerSentence(view: PlannerView): string {
  if (view.isTest) return "This is a test plan: you review it yourself, and nobody is notified.";
  if (view.territory.reviewerName) return `${view.territory.reviewerName} reviews it.`;
  return "The manager above this territory reviews it.";
}

/** The saved items of the days the rep may still change, as a draft starts from them. */
function savedDraftItems(view: PlannerView): PlanItemDraft[] {
  return view.days
    .filter((day) => day.editable)
    .flatMap((day) =>
      day.items.map((item) => ({
        planDate: day.date,
        customerId: item.customerId,
        placeId: item.placeId,
        exceptionType: asExceptionType(item.exceptionType),
        exceptionNote: item.exceptionNote,
      })),
    );
}

function itemSignature(item: PlanItemDraft): string {
  return [item.planDate, item.customerId, item.placeId, item.exceptionType ?? "", (item.exceptionNote ?? "").trim()].join("|");
}

function signatureOf(items: ReadonlyArray<PlanItemDraft>): string {
  return items.map(itemSignature).sort().join("\n");
}

/** "2 added · 1 taken off · 1 reason changed", against what was last saved. */
function changeSummary(before: ReadonlyArray<PlanItemDraft>, after: ReadonlyArray<PlanItemDraft>): string {
  const keyOf = (item: PlanItemDraft) => `${item.planDate}|${item.customerId}`;
  const beforeByKey = new Map(before.map((item) => [keyOf(item), item]));
  const afterKeys = new Set<string>();
  let added = 0;
  let changed = 0;
  for (const item of after) {
    const key = keyOf(item);
    afterKeys.add(key);
    const previous = beforeByKey.get(key);
    if (!previous) added += 1;
    else if (itemSignature(previous) !== itemSignature(item)) changed += 1;
  }
  const removed = before.filter((item) => !afterKeys.has(keyOf(item))).length;
  const parts: string[] = [];
  if (added > 0) parts.push(`${countText(added)} added`);
  if (removed > 0) parts.push(`${countText(removed)} taken off`);
  if (changed > 0) parts.push(plural(changed, "reason or place changed", "reasons or places changed"));
  return parts.length > 0 ? parts.join(" · ") : "Save to keep them.";
}

type PlaceEntry = { customer: PlannerCustomer; place: PlannerPlace; position: number };

type PlanIndex = { places: Map<string, PlaceEntry>; byCustomer: Map<string, PlannerCustomer>; customerIds: Set<string> };

function indexCustomers(customers: ReadonlyArray<PlannerCustomer>): PlanIndex {
  const places = new Map<string, PlaceEntry>();
  const byCustomer = new Map<string, PlannerCustomer>();
  for (const customer of customers) {
    byCustomer.set(customer.customerId, customer);
    customer.places.forEach((place, position) => places.set(place.placeId, { customer, place, position }));
  }
  return { places, byCustomer, customerIds: new Set(customers.map((customer) => customer.customerId)) };
}

/** One customer on a plan day, as a screen shows it. */
type DayRow = {
  customerId: string;
  /** Null for a customer not validated yet: he is planned as he is, and validated at the door. */
  placeId: string | null;
  /** Carried over from iReports360 and not validated yet. */
  pending: boolean;
  name: string;
  listType: PhoenixCrmListType;
  meta: string;
  where: string;
  hours: string;
  receives: boolean;
  noRamadanTime: boolean;
  exceptionType: PlanExceptionType | null;
  exceptionNote: string | null;
  /** Planned before the customer left the list, or before this place was removed from it. */
  gone: "customer" | "place" | null;
  standing: { label: string; tone: PillTone } | null;
  visits: string | null;
  lat: number | null;
  lon: number | null;
  isolated: boolean;
  nearestKm: number | null;
  startMinute: number | null;
};

function compareRows(left: DayRow, right: DayRow): number {
  return (
    left.listType.localeCompare(right.listType) ||
    (left.startMinute ?? 9999) - (right.startMinute ?? 9999) ||
    left.name.localeCompare(right.name)
  );
}

/** A draft item whose customer and place are on the list, read with today's days and hours. */
function liveRow(entry: PlaceEntry, item: PlanItemDraft, day: PlanDayView, rules: PlanRules): DayRow {
  const { customer, place } = entry;
  const weekday = weekdayOfIsoDay(day.date);
  const { windows, noRamadanTime } = windowsForWeekday(place.timings, weekday, day.ramadan);
  const receives = windows.length > 0;
  const target = gradeTarget(rules, customer.listType, customer.grade);
  return {
    customerId: customer.customerId,
    placeId: place.placeId,
    pending: false,
    name: customer.name,
    listType: customer.listType,
    meta: customerMetaText(customer),
    where: placeLine(place, entry.position),
    hours: receives ? windows.map((window) => formatTimingWindow(window)).join(", ") : `Does not receive on ${PHOENIX_CRM_WEEKDAY_NAMES[weekday]}`,
    receives,
    noRamadanTime: receives && noRamadanTime,
    exceptionType: receives ? null : item.exceptionType,
    exceptionNote: receives ? null : item.exceptionNote,
    gone: null,
    standing: monthStanding(customer.visitsThisMonth, target),
    visits: monthVisitsText(customer.visitsThisMonth, target),
    lat: place.lat,
    lon: place.lon,
    isolated: false,
    nearestKm: null,
    startMinute: receives ? windows[0].startMinute : null,
  };
}

/**
 * A customer carried over from iReports360 and not validated yet. He has no place and no days and
 * hours, so there is nothing to say about where or when — and no month standing, because his visits
 * do not count yet.
 */
function pendingRow(customer: PlannerCustomer): DayRow {
  return {
    customerId: customer.customerId,
    placeId: null,
    pending: true,
    name: customer.name,
    listType: customer.listType,
    meta: customerMetaText(customer),
    where: "No place saved yet",
    hours: "No days and hours yet",
    receives: true,
    noRamadanTime: false,
    exceptionType: null,
    exceptionNote: null,
    gone: null,
    standing: null,
    visits: pendingVisitsText(customer.visitsThisMonth),
    lat: null,
    lon: null,
    isolated: false,
    nearestKm: null,
    startMinute: null,
  };
}

/** A saved item as the server answered it: a day that has passed, or a plan this viewer does not change. */
function savedRow(item: PlanItemView, index: PlanIndex, rules: PlanRules): DayRow {
  const entry = item.placeId ? index.places.get(item.placeId) : undefined;
  const onList = entry !== undefined && entry.customer.customerId === item.customerId ? entry : null;
  const target = onList ? gradeTarget(rules, onList.customer.listType, onList.customer.grade) : null;
  // A customer not validated yet is on the list with no place; his visits do not count yet, so there
  // is no month standing to show and saying "not visited this month" would be a lie.
  const listed = index.byCustomer.get(item.customerId) ?? null;
  return {
    customerId: item.customerId,
    placeId: item.placeId,
    pending: item.pending,
    name: item.name,
    listType: item.listType,
    meta: customerMetaText(item),
    where: item.placeId ? placeLine({ label: item.placeLabel, zone: item.zone, brick: item.brickName }, onList?.position ?? null) : "No place saved yet",
    hours: item.windowsText,
    receives: item.receives,
    noRamadanTime: false,
    exceptionType: asExceptionType(item.exceptionType),
    exceptionNote: item.exceptionNote,
    gone: item.stale ? (index.customerIds.has(item.customerId) ? "place" : "customer") : null,
    standing: item.pending || !onList ? null : monthStanding(onList.customer.visitsThisMonth, target),
    visits: item.pending
      ? pendingVisitsText(listed?.visitsThisMonth ?? 0)
      : onList
        ? monthVisitsText(onList.customer.visitsThisMonth, target)
        : null,
    lat: null,
    lon: null,
    isolated: item.isolated,
    nearestKm: item.nearestKm,
    startMinute: item.startMinute,
  };
}

function draftRow(item: PlanItemDraft, day: PlanDayView, index: PlanIndex, rules: PlanRules): DayRow {
  // No place means a customer carried over from iReports360 and not validated yet: he is on the list,
  // he is planned, and there is nothing to look up.
  if (item.placeId === null) {
    const pendingCustomer = index.byCustomer.get(item.customerId);
    if (pendingCustomer) return pendingRow(pendingCustomer);
  }
  const entry = item.placeId ? index.places.get(item.placeId) : undefined;
  if (entry && entry.customer.customerId === item.customerId) return liveRow(entry, item, day, rules);
  const gone = index.customerIds.has(item.customerId) ? "place" : "customer";
  const saved = day.items.find((candidate) => candidate.customerId === item.customerId && candidate.placeId === item.placeId);
  if (saved) return { ...savedRow(saved, index, rules), gone };
  return {
    customerId: item.customerId,
    placeId: item.placeId,
    pending: false,
    name: "A customer no longer on the list",
    listType: "PM",
    meta: "",
    where: "",
    hours: "",
    receives: true,
    noRamadanTime: false,
    exceptionType: null,
    exceptionNote: null,
    gone,
    standing: null,
    visits: null,
    lat: null,
    lon: null,
    isolated: false,
    nearestKm: null,
    startMinute: null,
  };
}

function reasonComplete(row: DayRow): boolean {
  return row.exceptionType !== null && (row.exceptionType !== "other" || Boolean(row.exceptionNote?.trim()));
}

type DayState = {
  day: PlanDayView;
  /** The rep is changing this day: its rows come from the draft. */
  editing: boolean;
  rows: DayRow[];
  /** Customers still on the list; a row planned before its customer or place left does not count. */
  counts: Record<PhoenixCrmListType, number>;
  offDay: number;
  needsReason: number;
  gone: number;
  spanKm: number;
  farApart: boolean;
};

function buildDayStates(view: PlannerView, items: ReadonlyArray<PlanItemDraft> | null, index: PlanIndex): DayState[] {
  const draftByDay = new Map<string, PlanItemDraft[]>();
  for (const item of items ?? []) {
    const list = draftByDay.get(item.planDate) ?? [];
    list.push(item);
    draftByDay.set(item.planDate, list);
  }

  return view.days.map((day) => {
    const editing = items !== null && view.canEdit && day.editable;
    let rows = editing
      ? (draftByDay.get(day.date) ?? []).map((item) => draftRow(item, day, index, view.rules))
      : day.items.map((item) => savedRow(item, index, view.rules));
    let spanKm = day.spanKm;
    let farApart = day.farApart;
    if (editing) {
      // The draft moves as the rep works, so its spread is measured here rather than read from the save.
      const points = rows.flatMap((row) =>
        row.gone === null && row.lat !== null && row.lon !== null ? [{ id: row.customerId, lat: row.lat, lon: row.lon }] : [],
      );
      const spread = checkDaySpread(points, view.rules.farApartKm);
      const isolated = new Set(spread.isolatedIds);
      rows = rows.map((row) =>
        row.gone === null ? { ...row, isolated: isolated.has(row.customerId), nearestKm: roundKm(spread.nearestKmById[row.customerId]) } : row,
      );
      spanKm = spread.spanKm;
      farApart = spread.spread;
    }
    rows.sort(compareRows);
    const live = rows.filter((row) => row.gone === null);
    return {
      day,
      editing,
      rows,
      counts: { AM: live.filter((row) => row.listType === "AM").length, PM: live.filter((row) => row.listType === "PM").length },
      offDay: live.filter((row) => !row.receives).length,
      needsReason: editing ? live.filter((row) => !row.receives && !reasonComplete(row)).length : 0,
      gone: rows.length - live.length,
      spanKm,
      farApart,
    };
  });
}

type PlanProblem = { date: string; message: string };

/** What the server would refuse, named before the save leaves the phone. */
function planProblems(states: ReadonlyArray<DayState>, rules: PlanRules): PlanProblem[] {
  const problems: PlanProblem[] = [];
  for (const state of states) {
    if (!state.editing) continue;
    const { date } = state.day;
    const label = dayLabel(date);
    for (const row of state.rows) {
      if (row.gone !== null) continue;
      if (!state.day.listTypes.includes(row.listType)) {
        problems.push({ date, message: `${label} is a morning for AM only. Take ${row.name} off it.` });
      } else if (!row.receives && row.exceptionType === null) {
        problems.push({
          date,
          message: `${row.name} does not receive on ${PHOENIX_CRM_WEEKDAY_NAMES[weekdayOfIsoDay(date)]}. Choose a reason, or take the customer off ${label}.`,
        });
      } else if (!row.receives && !reasonComplete(row)) {
        problems.push({ date, message: `Write a note on why ${row.name} is on ${label}.` });
      }
    }
    if (state.counts.PM > rules.pmDailyCap) {
      problems.push({ date, message: `${label} has ${state.counts.PM} PM. A day holds ${rules.pmDailyCap} PM at most.` });
    }
    if (state.counts.AM > rules.amDailyCap) {
      problems.push({ date, message: `${label} has ${state.counts.AM} AM. A day holds ${rules.amDailyCap} AM at most.` });
    }
  }
  return problems;
}

/** The days the rep may change, as /api/phoenix-crm/plans saves them. A row no longer on the list is left out. */
function payloadItems(states: ReadonlyArray<DayState>): PlanItemDraft[] {
  return states
    .filter((state) => state.editing)
    .flatMap((state) =>
      state.rows
        .filter((row) => row.gone === null)
        .map((row) => ({
          planDate: state.day.date,
          customerId: row.customerId,
          placeId: row.placeId,
          exceptionType: row.receives ? null : row.exceptionType,
          exceptionNote: row.receives ? null : row.exceptionNote?.trim() || null,
        })),
    );
}

// ── The tab ─────────────────────────────────────────────────────────────────────────────────────

export function PlanTab({
  initialWeekStart = null,
  onChanged,
  onClose,
  onDirtyChange,
  onOpenList,
  seatId,
  test,
}: {
  /** The week to open first; the planner's own first week when absent. */
  initialWeekStart?: string | null;
  /** A save, a send or a decision went through (a review list elsewhere reads itself again). */
  onChanged?: () => void;
  /** Opened from another screen (a manager's plans to review): the way back. */
  onClose?: { label: string; onClose: () => void };
  /** Unsaved changes appeared or went: the page around the tab asks before it swaps the territory. */
  onDirtyChange?: (dirty: boolean) => void;
  /** The List tab, for a rep whose list is not ready yet. */
  onOpenList?: () => void;
  seatId: string;
  test: boolean;
}) {
  const idPrefix = useId();
  const [weekStart, setWeekStart] = useState<string | null>(initialWeekStart);
  const resource = useCrmGet<PlannerView>(crmUrl("/api/phoenix-crm/plans", { seatId, test, weekStart }), "planner");
  const [screen, setScreen] = useState<PlanScreen>({ name: "week" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<PlanNotice | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [busy, setBusy] = useState<PlanBusy | null>(null);
  const [confirm, setConfirm] = useState<"send" | "reopen" | null>(null);
  const [leavingFor, setLeavingFor] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const topRef = useRef<HTMLDivElement>(null);

  const view = resource.data;
  const baseItems = view && view.canEdit ? savedDraftItems(view) : null;
  const activeDraft = view && view.canEdit && draftFits(draft, view) ? draft : null;
  const items = activeDraft ? activeDraft.items : baseItems;
  const savedItems = activeDraft?.saved?.items ?? baseItems ?? [];
  const dirty = activeDraft !== null && signatureOf(activeDraft.items) !== signatureOf(savedItems);
  const index = view ? indexCustomers(view.customers) : null;
  const states = view && index ? buildDayStates(view, items, index) : [];
  const problems = view ? planProblems(states, view.rules) : [];
  /** Planned customers who left the list since, on days still open: the next save takes them off. */
  const goneOnOpenDays = states.reduce((sum, state) => sum + (state.editing ? state.gone : 0), 0);
  const locked = busy !== null || resource.loading;

  // A full page unload is the one way out the draft cannot survive, so the browser asks first. Only
  // while something is unsaved: a listener left attached keeps the page out of the back/forward cache.
  useEffect(() => {
    if (!dirty) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function scrollToTop() {
    const top = topRef.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  }

  /** A failure is scrolled into view; a success leaves the rep where they were working. */
  function show(next: PlanNotice | null) {
    setNotice(next);
    if (next?.tone === "bad") scrollToTop();
  }

  function refused(error: unknown, title: string) {
    const code = errorCodeOf(error);
    const reload = code !== null && PLAN_RELOAD_CODES.has(code);
    show({ tone: "bad", title, message: (code !== null && reload ? RELOADED_MESSAGES[code] : undefined) ?? messageOf(error) });
    if (reload) resource.reload();
  }

  function change(update: (current: PlanItemDraft[]) => PlanItemDraft[]) {
    if (!view || !view.canEdit || locked) return;
    setDraft((previous) =>
      draftFits(previous, view)
        ? { ...previous, items: update(previous.items) }
        : { scope: scopeOf(view), basis: viewBasis(view), items: update(savedDraftItems(view)), saved: null },
    );
  }

  function addItems(date: string, additions: ReadonlyArray<PlanItemDraft>) {
    change((current) => {
      // A customer added again replaces the row planned before its place was removed.
      const addedIds = new Set(additions.map((item) => item.customerId));
      return [...current.filter((item) => !(item.planDate === date && addedIds.has(item.customerId))), ...additions];
    });
  }

  function removeItem(date: string, customerId: string) {
    change((current) => current.filter((item) => !(item.planDate === date && item.customerId === customerId)));
  }

  function setReason(date: string, customerId: string, exceptionType: PlanExceptionType | null, exceptionNote: string | null) {
    change((current) =>
      current.map((item) => (item.planDate === date && item.customerId === customerId ? { ...item, exceptionType, exceptionNote } : item)),
    );
  }

  function discard() {
    if (!view) return;
    setDraft((previous) => (draftFits(previous, view) && previous.saved ? { ...previous, items: previous.saved.items } : null));
    setShowProblems(false);
    setNotice(null);
  }

  function openDay(date: string) {
    setScreen({ name: "day", date });
    setConfirm(null);
    scrollToTop();
  }

  function openWeekScreen() {
    setScreen({ name: "week" });
    scrollToTop();
  }

  function openWeek(next: string, nextNotice: PlanNotice | null) {
    setWeekStart(next);
    setScreen({ name: "week" });
    setDraft(null);
    setLeavingFor(null);
    setConfirm(null);
    setShowProblems(false);
    setNotice(nextNotice);
  }

  function chooseWeek(next: string) {
    if (!view || next === view.weekStart || locked) return;
    if (dirty) {
      setLeavingFor(next);
      return;
    }
    openWeek(next, null);
  }

  function postSave(current: PlannerView, payload: PlanItemDraft[]): Promise<SavedPlan> {
    return crmPost<SavedPlan>(
      "/api/phoenix-crm/plans",
      {
        seatId,
        test,
        weekStart: current.weekStart,
        expectedVersion: activeDraft?.saved?.version ?? current.plan?.version ?? null,
        items: payload,
      },
      "plan",
    );
  }

  /** The draft now holds what the save wrote, over both the version on screen and the one the save made. */
  function markSaved(current: PlannerView, saved: SavedPlan, payload: PlanItemDraft[]) {
    setDraft({
      scope: scopeOf(current),
      basis: viewBasis(current),
      items: payload,
      saved: { items: payload, planId: saved.planId, version: saved.version },
    });
  }

  async function save(): Promise<boolean> {
    if (!view || !view.canEdit || locked) return false;
    if (problems.length > 0) {
      setShowProblems(true);
      scrollToTop();
      return false;
    }
    const payload = payloadItems(states);
    const gone = goneOnOpenDays;
    setBusy("save");
    setNotice(null);
    setShowProblems(false);
    try {
      const saved = await postSave(view, payload);
      markSaved(view, saved, payload);
      show({
        tone: "good",
        title: "Plan saved",
        message: gone > 0 ? `${plural(gone, "customer", "customers")} no longer on the list ${gone === 1 ? "was" : "were"} taken off the plan.` : null,
      });
      onChanged?.();
      resource.reload();
      return true;
    } catch (error) {
      refused(error, "The plan was not saved");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!view || !view.canEdit || locked) return;
    if (problems.length > 0) {
      setShowProblems(true);
      return;
    }
    const payload = payloadItems(states);
    const saveFirst = dirty || view.plan === null || goneOnOpenDays > 0;
    let planId = activeDraft?.saved?.planId ?? view.plan?.planId ?? null;
    let version = activeDraft?.saved?.version ?? view.plan?.version ?? null;
    let savedNow = false;
    setBusy("send");
    setNotice(null);
    try {
      if (saveFirst) {
        const saved = await postSave(view, payload);
        savedNow = true;
        markSaved(view, saved, payload);
        planId = saved.planId;
        version = saved.version;
      }
      if (planId === null || version === null) throw new Error("Reload the plan, then send it again.");
      await crmPost<unknown>("/api/phoenix-crm/plans/submit", { planId, action: "submit", expectedVersion: version }, "plan");
      setConfirm(null);
      show({ tone: "good", title: "Plan sent for review", message: reviewerSentence(view) });
      onChanged?.();
      resource.reload();
    } catch (error) {
      setConfirm(null);
      if (savedNow) {
        show({ tone: "bad", title: "The plan was saved but not sent", message: messageOf(error) });
        onChanged?.();
        resource.reload();
      } else {
        refused(error, "The plan was not sent");
      }
    } finally {
      setBusy(null);
    }
  }

  async function reopen() {
    const plan = view?.plan;
    if (!plan || locked) return;
    setBusy("reopen");
    setNotice(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/plans/submit", { planId: plan.planId, action: "reopen", expectedVersion: plan.version }, "plan");
      setConfirm(null);
      show({ tone: "info", title: "Plan taken back", message: "Change it, save it, and send it for review again." });
      onChanged?.();
      resource.reload();
    } catch (error) {
      setConfirm(null);
      refused(error, "The plan was not taken back");
    } finally {
      setBusy(null);
    }
  }

  async function decide(action: "approve" | "return", note: string): Promise<boolean> {
    if (!view?.plan || locked) return false;
    const { plan } = view;
    setBusy(action);
    setNotice(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/plans/decide", { planId: plan.planId, action, expectedVersion: plan.version, note: note || null }, "plan");
      show({
        tone: "good",
        title: action === "approve" ? "Plan approved" : "Plan returned for changes",
        message: view.isTest ? "This is a test plan, so nobody is notified." : "The rep is notified.",
      });
      onChanged?.();
      resource.reload();
      return true;
    } catch (error) {
      refused(error, action === "approve" ? "The plan was not approved" : "The plan was not returned");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function leave(choice: LeaveChoice) {
    const target = leavingFor;
    if (choice === "stay" || target === null || !view) {
      setLeavingFor(null);
      return;
    }
    if (choice === "discard") {
      openWeek(target, null);
      return;
    }
    const savedWeek = view.weekStart;
    if (await save()) openWeek(target, { tone: "good", title: "Plan saved", message: `${weekLabel(savedWeek)} is saved.` });
  }

  /** The way back to the screen that opened the plan; unsaved changes are asked about first. */
  function requestClose() {
    if (!onClose || locked) return;
    if (dirty) {
      setLeavingFor(null);
      setClosing(true);
      return;
    }
    onClose.onClose();
  }

  async function close(choice: LeaveChoice) {
    if (choice === "stay" || !onClose) {
      setClosing(false);
      return;
    }
    if (choice === "discard") {
      setClosing(false);
      setDraft(null);
      onClose.onClose();
      return;
    }
    if (await save()) {
      setClosing(false);
      onClose.onClose();
    }
  }

  let body: ReactNode;
  if (!view) {
    body = (
      <CrmPanel eyebrow="Plan" title="Weekly plan">
        {resource.error ? <CrmLoadError message={resource.error} onRetry={resource.reload} /> : <CrmLoading label="Loading the weekly plan" />}
      </CrmPanel>
    );
  } else if (screen.name === "day") {
    body = (
      <DayScreen
        date={screen.date}
        idPrefix={idPrefix}
        loadError={resource.error}
        locked={locked}
        notice={notice}
        onAdd={addItems}
        onBack={openWeekScreen}
        onOpenDay={openDay}
        onReason={setReason}
        onRemove={removeItem}
        onRetry={resource.reload}
        problems={problems}
        showProblems={showProblems}
        states={states}
        view={view}
      />
    );
  } else {
    body = (
      <WeekScreen
        busy={busy}
        closing={closing && dirty}
        confirm={confirm}
        dirty={dirty}
        idPrefix={idPrefix}
        leavingFor={leavingFor}
        loadError={resource.error}
        locked={locked}
        notice={notice}
        onChooseWeek={(next) => {
          setClosing(false);
          chooseWeek(next);
        }}
        onClose={onClose ? { label: onClose.label, onClose: requestClose } : undefined}
        onCloseChoice={(choice) => void close(choice)}
        onConfirm={setConfirm}
        onDecide={decide}
        onLeave={(choice) => void leave(choice)}
        onOpenDay={openDay}
        onOpenList={onOpenList}
        onReopen={() => void reopen()}
        onRetry={resource.reload}
        onSend={() => void send()}
        problems={problems}
        showProblems={showProblems}
        states={states}
        view={view}
      />
    );
  }

  return (
    <div className="min-w-0 scroll-mt-24" ref={topRef}>
      {body}
      {view && (dirty || goneOnOpenDays > 0) ? (
        <SaveBar
          busy={busy === "save"}
          changes={dirty ? changeSummary(savedItems, items ?? []) : null}
          dirty={dirty}
          gone={goneOnOpenDays}
          locked={locked}
          onDiscard={discard}
          onSave={() => void save()}
        />
      ) : null}
    </div>
  );
}

// ── Notices and the save bar ────────────────────────────────────────────────────────────────────

function ProblemList({ currentDate = null, onOpenDay, problems }: { currentDate?: string | null; onOpenDay: (date: string) => void; problems: ReadonlyArray<PlanProblem> }) {
  return (
    <ul className="mt-1 grid min-w-0 gap-1.5">
      {problems.map((problem, position) => (
        <li className="flex min-w-0 flex-wrap items-center gap-2" key={`${problem.date}-${position}`}>
          <span className="min-w-0 flex-1 basis-56 break-words">{problem.message}</span>
          {problem.date !== currentDate ? (
            <CrmButton onClick={() => onOpenDay(problem.date)} size="sm">
              Open {dayLabel(problem.date)}
            </CrmButton>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function NoticeArea({
  currentDate = null,
  loadError,
  notice,
  onOpenDay,
  onRetry,
  problems,
}: {
  currentDate?: string | null;
  /** A reload failed while the last plan stayed on screen. */
  loadError: string | null;
  notice: PlanNotice | null;
  onOpenDay: (date: string) => void;
  onRetry: () => void;
  problems: ReadonlyArray<PlanProblem>;
}) {
  if (!notice && !loadError && problems.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-2 px-4 pt-4 sm:px-5">
      {notice ? (
        <CrmNote title={notice.title} tone={notice.tone}>
          {notice.message}
        </CrmNote>
      ) : null}
      {loadError ? (
        <CrmNote title="The plan on screen may be out of date" tone="bad">
          <span className="block">{loadError}</span>
          <span className="mt-2 block">
            <CrmButton onClick={onRetry} size="sm">
              Try again
            </CrmButton>
          </span>
        </CrmNote>
      ) : null}
      {problems.length > 0 ? (
        <CrmNote title={problems.length === 1 ? "Fix this before saving" : `Fix these ${problems.length} before saving`} tone="bad">
          <ProblemList currentDate={currentDate} onOpenDay={onOpenDay} problems={problems} />
        </CrmNote>
      ) : null}
    </div>
  );
}

function SaveBar({
  busy,
  changes,
  dirty,
  gone,
  locked,
  onDiscard,
  onSave,
}: {
  busy: boolean;
  /** What changed since the last save; null when only customers who left the list are waiting to come off. */
  changes: string | null;
  dirty: boolean;
  gone: number;
  locked: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const [discarding, setDiscarding] = useState(false);
  const goneText =
    gone > 0 ? `${plural(gone, "planned customer", "planned customers")} no longer on the list ${gone === 1 ? "comes" : "come"} off when you save.` : null;

  return (
    // Held above the portal's bottom bar on phones (the app sets --crm-sticky-bottom to its height).
    <div className="sticky bottom-[var(--crm-sticky-bottom,0px)] z-20 mt-3 border border-orange-300 bg-white px-4 py-3 shadow-[0_-10px_30px_rgba(15,23,42,0.12)] sm:px-5 lg:bottom-0">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 basis-56">
          <p className="break-words text-sm font-black text-slate-950">
            {discarding ? "Discard your changes to this week?" : dirty ? "Unsaved changes" : "The plan needs saving"}
          </p>
          {discarding ? (
            <p className="break-words text-xs font-semibold leading-5 text-slate-500">The plan goes back to what was last saved.</p>
          ) : (
            <>
              {/* The itemised change list waits for a wider screen: on a phone this bar and the bottom
                  navigation already take a third of the height, and "Unsaved changes" says enough. */}
              {changes ? <p className="hidden break-words text-xs font-semibold leading-5 text-slate-500 sm:block">{changes}</p> : null}
              {goneText ? <p className="break-words text-xs font-semibold leading-5 text-slate-500">{goneText}</p> : null}
            </>
          )}
        </div>
        <div className={cn("grid w-full gap-2 sm:flex sm:w-auto", discarding || dirty ? "grid-cols-2" : undefined)}>
          {discarding ? (
            <>
              <CrmButton
                disabled={locked}
                onClick={() => {
                  setDiscarding(false);
                  onDiscard();
                }}
                variant="danger"
              >
                Discard
              </CrmButton>
              <CrmButton onClick={() => setDiscarding(false)}>Keep them</CrmButton>
            </>
          ) : (
            <>
              {dirty ? (
                <CrmButton disabled={locked} onClick={() => setDiscarding(true)}>
                  Discard changes
                </CrmButton>
              ) : null}
              <CrmButton busy={busy} disabled={locked} onClick={onSave} variant="primary">
                Save the plan
              </CrmButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── The week ────────────────────────────────────────────────────────────────────────────────────

function WeekScreen({
  busy,
  closing,
  confirm,
  dirty,
  idPrefix,
  leavingFor,
  loadError,
  locked,
  notice,
  onChooseWeek,
  onClose,
  onCloseChoice,
  onConfirm,
  onDecide,
  onLeave,
  onOpenDay,
  onOpenList,
  onReopen,
  onRetry,
  onSend,
  problems,
  showProblems,
  states,
  view,
}: {
  busy: PlanBusy | null;
  /** The way back was pressed with unsaved changes: save, leave them, or stay. */
  closing: boolean;
  confirm: "send" | "reopen" | null;
  dirty: boolean;
  idPrefix: string;
  leavingFor: string | null;
  loadError: string | null;
  locked: boolean;
  notice: PlanNotice | null;
  onChooseWeek: (weekStart: string) => void;
  onClose?: { label: string; onClose: () => void };
  onCloseChoice: (choice: LeaveChoice) => void;
  onConfirm: (next: "send" | "reopen" | null) => void;
  onDecide: (action: "approve" | "return", note: string) => Promise<boolean>;
  onLeave: (choice: LeaveChoice) => void;
  onOpenDay: (date: string) => void;
  onOpenList?: () => void;
  onReopen: () => void;
  onRetry: () => void;
  onSend: () => void;
  problems: ReadonlyArray<PlanProblem>;
  showProblems: boolean;
  states: ReadonlyArray<DayState>;
  view: PlannerView;
}) {
  const { plan } = view;
  const status = plan?.status ?? null;
  const thisWeek = fieldWeekStart(view.cairoToday);
  const showSpread = !view.viewerIsRep || view.viewerIsReviewer;
  const totals = states.reduce((sum, state) => ({ AM: sum.AM + state.counts.AM, PM: sum.PM + state.counts.PM }), { AM: 0, PM: 0 });
  const liveTotal = totals.AM + totals.PM;
  const plannedDays = states.filter((state) => state.counts.AM + state.counts.PM > 0).length;
  const offDay = states.reduce((sum, state) => sum + state.offDay, 0);
  const needsReason = states.reduce((sum, state) => sum + state.needsReason, 0);

  const facts: Array<{ label: string; value: string }> = [
    { label: "Last change", value: plan ? cairoStamp(plan.updatedAt) : "Not saved yet" },
    { label: "Reviewer", value: view.isTest ? "You (test entries)" : (view.territory.reviewerName ?? "No manager above this territory") },
  ];
  if (plan?.submittedAt) {
    facts.push({
      label: "Last sent for review",
      value: `${cairoStamp(plan.submittedAt)}${plan.submittedByName ? ` · ${plan.submittedByName}` : ""}`,
    });
  }
  if (plan?.decidedAt && (status === "approved" || status === "returned")) {
    facts.push({
      label: status === "approved" ? "Approved" : "Returned",
      value: `${cairoStamp(plan.decidedAt)}${plan.decidedByName ? ` · ${plan.decidedByName}` : ""}${plan.decidedBySfe ? " (SFE Manager)" : ""}`,
    });
  }

  return (
    <CrmPanel
      actions={
        onClose ? (
          <CrmButton onClick={onClose.onClose} size="sm" variant="ghost">
            <ArrowLeft aria-hidden className="h-4 w-4" />
            {onClose.label}
          </CrmButton>
        ) : null
      }
      description={territoryLine(view.territory)}
      eyebrow={view.isTest ? "Plan · test entries" : "Plan"}
      title={weekLabel(view.weekStart)}
    >
      <NoticeArea loadError={loadError} notice={notice} onOpenDay={onOpenDay} onRetry={onRetry} problems={showProblems ? problems : []} />

      {closing && onClose ? (
        <div className="px-4 pt-4 sm:px-5">
          <CrmNote title="Your changes to this week are not saved" tone="warn">
            <span className="block">Save them before going back, or leave them behind.</span>
            <span className="mt-2 grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton busy={busy === "save"} disabled={locked} onClick={() => onCloseChoice("save")} size="sm" variant="primary">
                Save, then go back
              </CrmButton>
              <CrmButton disabled={locked} onClick={() => onCloseChoice("discard")} size="sm" variant="danger">
                Leave them
              </CrmButton>
              <CrmButton disabled={busy === "save"} onClick={() => onCloseChoice("stay")} size="sm">
                Stay on this plan
              </CrmButton>
            </span>
          </CrmNote>
        </div>
      ) : null}

      <CrmBlock title="Week">
        <CrmChoice
          columns={4}
          label="Week"
          onChange={onChooseWeek}
          options={view.weeks.map((week) => ({
            value: week.weekStart,
            label: weekLabel(week.weekStart),
            note: week.weekStart === thisWeek ? `This week · ${week.statusLabel}` : week.statusLabel,
            disabled: locked && week.weekStart !== view.weekStart,
          }))}
          value={view.weekStart}
        />
        {leavingFor ? (
          <CrmNote className="mt-3" title="Your changes to this week are not saved" tone="warn">
            <span className="block">Save them before opening {weekLabel(leavingFor)}, or leave them behind.</span>
            <span className="mt-2 grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton busy={busy === "save"} disabled={locked} onClick={() => onLeave("save")} size="sm" variant="primary">
                Save, then open the week
              </CrmButton>
              <CrmButton disabled={locked} onClick={() => onLeave("discard")} size="sm" variant="danger">
                Leave them
              </CrmButton>
              <CrmButton disabled={busy === "save"} onClick={() => onLeave("stay")} size="sm">
                Stay on this week
              </CrmButton>
            </span>
          </CrmNote>
        ) : null}
      </CrmBlock>

      {view.blockedReason ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote tone="warn">
            <span className="block">{view.blockedReason}</span>
          </CrmNote>
        </CrmBlock>
      ) : null}

      {/* The days come straight after the week: they are what the rep opens this screen to work on,
          and on a phone the status and the totals below would otherwise push them a screen down. */}
      <CrmBlock className="border-t border-slate-100" title="Days">
        {view.canEdit && view.customers.length === 0 ? (
          <CrmNote className="mb-3" tone="info">
            <span className="block">No validated customers yet. Customers validated on the List tab can be placed here.</span>
            {onOpenList ? (
              <span className="mt-2 block">
                <CrmButton onClick={onOpenList} size="sm">
                  Open the list
                </CrmButton>
              </span>
            ) : null}
          </CrmNote>
        ) : null}
        <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {states.map((state) => (
            <DayCard
              key={state.day.date}
              onOpen={() => onOpenDay(state.day.date)}
              rules={view.rules}
              showSpread={showSpread}
              state={state}
              today={view.cairoToday}
            />
          ))}
        </div>
      </CrmBlock>

      {/* Owner, 2026-09-22: information, never a refusal — the week is planned whatever the list holds. */}
      {view.pendingCount > 0 ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote tone="info" title={`${countText(view.pendingCount)} not validated yet`}>
            <span className="block">{pendingListNote(view.pendingCount)}</span>
            {view.viewerIsRep && onOpenList ? (
              <span className="mt-2 block">
                <CrmButton onClick={onOpenList} size="sm">
                  Open the list
                </CrmButton>
              </span>
            ) : null}
          </CrmNote>
        </CrmBlock>
      ) : null}

      <CrmBlock className="border-t border-slate-100" title="Status">
        <div className="flex flex-wrap items-center gap-1.5">
          <CrmPill tone={STATUS_TONE[status ?? "none"]}>{plan?.statusLabel ?? "Not started"}</CrmPill>
          {dirty ? <CrmPill tone="orange">Unsaved changes</CrmPill> : null}
        </div>
        <div className="mt-3">
          <CrmFacts facts={facts} />
        </div>
        {plan?.decisionNote && (status === "returned" || status === "approved") ? (
          <CrmNote className="mt-3" title={status === "returned" ? "What to change" : "Manager's note"} tone={status === "returned" ? "warn" : "good"}>
            <span className="block whitespace-pre-line">{plan.decisionNote}</span>
          </CrmNote>
        ) : null}
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="This week">
        {/* AM first, as every sentence and the Day screen say it; the figures are unchanged. */}
        <CrmStatGrid>
          <CrmStat label="AM" note="Placed across the week" value={countText(totals.AM)} />
          <CrmStat label="PM" note="Placed across the week" value={countText(totals.PM)} />
          <CrmStat label="Days planned" note="Saturday to Thursday morning" value={`${plannedDays} of ${states.length}`} />
          <CrmStat
            label="On a day off"
            note={offDay === 0 ? "Everyone placed receives that day" : needsReason > 0 ? `${countText(needsReason)} without a reason` : "Each with a reason"}
            tone={needsReason > 0 ? "bad" : offDay > 0 ? "warn" : "neutral"}
            value={countText(offDay)}
          />
        </CrmStatGrid>
      </CrmBlock>

      {view.canEdit ? (
        <CrmBlock className="border-t border-slate-100" title="Send for review">
          {confirm === "send" ? (
            <SendConfirm
              busy={busy === "send"}
              locked={locked}
              onCancel={() => onConfirm(null)}
              onOpenDay={onOpenDay}
              onSend={onSend}
              problems={problems}
              states={states}
              view={view}
            />
          ) : (
            <div className="grid min-w-0 gap-2">
              <p className="break-words text-sm font-medium leading-6 text-slate-600">
                {status === "returned"
                  ? "Change what the manager asked for, then send the plan again."
                  : `When the week is ready, send it. ${reviewerSentence(view)}`}
              </p>
              <div className="grid gap-2 sm:flex sm:flex-wrap">
                <CrmButton disabled={locked || liveTotal === 0} onClick={() => onConfirm("send")} variant="primary">
                  {status === "returned" ? "Send the plan again" : "Send for review"}
                </CrmButton>
              </div>
              {liveTotal === 0 ? <p className="text-xs font-semibold leading-5 text-slate-500">Place at least one customer before sending the plan.</p> : null}
            </div>
          )}
        </CrmBlock>
      ) : null}

      {view.canReopen && plan ? (
        <CrmBlock className="border-t border-slate-100" title={status === "approved" ? "Approved plan" : "Waiting for review"}>
          {confirm === "reopen" ? (
            <div className="grid min-w-0 gap-2 border border-slate-200 bg-slate-50 px-3.5 py-3">
              <p className="text-sm font-black text-slate-950">Take the plan back?</p>
              <p className="break-words text-sm font-medium leading-6 text-slate-600">
                {status === "approved"
                  ? "It is approved. Taking it back makes it a draft again, and it needs a new approval once you send it."
                  : "It leaves the manager's review until you send it again."}
              </p>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                <CrmButton busy={busy === "reopen"} disabled={locked} onClick={onReopen} variant="danger">
                  Take it back
                </CrmButton>
                <CrmButton disabled={busy === "reopen"} onClick={() => onConfirm(null)}>
                  {status === "approved" ? "Keep it approved" : "Keep it sent"}
                </CrmButton>
              </div>
            </div>
          ) : (
            <div className="grid min-w-0 gap-2">
              <p className="break-words text-sm font-medium leading-6 text-slate-600">
                {status === "approved" ? "The plan is approved." : `The plan is waiting for review. ${reviewerSentence(view)}`} To change it, take it
                back first.
              </p>
              <div className="grid gap-2 sm:flex sm:flex-wrap">
                <CrmButton disabled={locked} onClick={() => onConfirm("reopen")}>
                  Take the plan back to change it
                </CrmButton>
              </div>
            </div>
          )}
        </CrmBlock>
      ) : null}

      {(view.canApprove || view.canReturn) && plan ? (
        <DecisionBlock
          busy={busy}
          canApprove={view.canApprove}
          canReturn={view.canReturn}
          idPrefix={idPrefix}
          key={`${plan.planId}|${plan.version}`}
          locked={locked}
          onDecide={onDecide}
          status={plan.status}
        />
      ) : null}
    </CrmPanel>
  );
}

function DayCard({
  onOpen,
  rules,
  showSpread,
  state,
  today,
}: {
  onOpen: () => void;
  rules: PlanRules;
  showSpread: boolean;
  state: DayState;
  today: string;
}) {
  const { day } = state;
  const live = state.rows.filter((row) => row.gone === null);
  const morning = !day.listTypes.includes("PM");
  const over = state.counts.PM > rules.pmDailyCap || state.counts.AM > rules.amDailyCap;
  const far = showSpread && state.farApart;
  const names = live.slice(0, 3).map((row) => row.name);
  const more = live.length - names.length;
  const accent =
    over || state.needsReason > 0
      ? "border-l-rose-500"
      : state.gone > 0 || state.offDay > 0 || far
        ? "border-l-amber-500"
        : live.length > 0
          ? "border-l-orange-400"
          : "border-l-slate-300";

  return (
    <button
      className={cn(
        "flex min-w-0 flex-col items-stretch gap-1.5 rounded-none border border-l-[3px] border-slate-200 bg-white px-3.5 py-3 text-left transition hover:bg-slate-50",
        accent,
      )}
      onClick={onOpen}
      type="button"
    >
      <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-black text-slate-950">{dayLabel(day.date)}</span>
        <span className="flex max-w-full flex-wrap gap-1">
          {day.date === today ? <CrmPill tone="info">Today</CrmPill> : null}
          {!day.editable ? <CrmPill>Passed</CrmPill> : null}
          {day.ramadan ? <CrmPill tone="orange">Ramadan</CrmPill> : null}
          {morning ? <CrmPill>Morning · AM only</CrmPill> : null}
        </span>
      </span>
      <span className="block break-words text-sm font-bold text-slate-800">{dayCountsText(state.counts, day, rules)}</span>
      <span className="block break-words text-xs font-semibold leading-5 text-slate-500">
        {live.length === 0 ? "Nothing planned" : `${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`}
      </span>
      {over || state.needsReason > 0 || state.offDay > 0 || state.gone > 0 || far ? (
        <span className="flex max-w-full flex-wrap gap-1">
          {over ? <CrmPill tone="bad">Over the day&apos;s limit</CrmPill> : null}
          {state.needsReason > 0 ? <CrmPill tone="bad">{countText(state.needsReason)} without a reason</CrmPill> : null}
          {state.offDay > 0 ? <CrmPill tone="warn">{countText(state.offDay)} on a day off</CrmPill> : null}
          {state.gone > 0 ? <CrmPill tone="warn">{countText(state.gone)} no longer on the list</CrmPill> : null}
          {far ? <CrmPill tone="warn">Far apart · {state.spanKm} km</CrmPill> : null}
        </span>
      ) : null}
    </button>
  );
}

function SendConfirm({
  busy,
  locked,
  onCancel,
  onOpenDay,
  onSend,
  problems,
  states,
  view,
}: {
  busy: boolean;
  locked: boolean;
  onCancel: () => void;
  onOpenDay: (date: string) => void;
  onSend: () => void;
  problems: ReadonlyArray<PlanProblem>;
  states: ReadonlyArray<DayState>;
  view: PlannerView;
}) {
  const planned = states.filter((state) => state.counts.AM + state.counts.PM > 0);
  const empty = states.filter((state) => state.day.editable && state.counts.AM + state.counts.PM === 0);
  const offDay = states.reduce((sum, state) => sum + state.offDay, 0);
  const gone = states.reduce((sum, state) => sum + (state.editing ? state.gone : 0), 0);

  return (
    <div className="grid min-w-0 gap-2.5 border border-orange-200 bg-orange-50/40 px-3.5 py-3">
      <p className="text-sm font-black text-slate-950">Send this plan for review?</p>
      {planned.length > 0 ? (
        <ul className="grid min-w-0 gap-1 text-sm font-semibold leading-6 text-slate-700">
          {planned.map((state) => (
            <li className="break-words" key={state.day.date}>
              <span className="font-black text-slate-900">{dayLabel(state.day.date)}:</span> {dayCountsText(state.counts, state.day, view.rules)}
            </li>
          ))}
        </ul>
      ) : null}
      {empty.length > 0 ? (
        <p className="break-words text-sm font-medium leading-6 text-slate-600">
          Nothing planned on {empty.map((state) => dayLabel(state.day.date)).join(", ")}.
        </p>
      ) : null}
      {offDay > 0 ? (
        <p className="break-words text-sm font-medium leading-6 text-slate-600">
          {plural(offDay, "customer is", "customers are")} placed on a day they do not receive, each with a reason.
        </p>
      ) : null}
      {gone > 0 ? (
        <p className="break-words text-sm font-medium leading-6 text-slate-600">
          {plural(gone, "customer", "customers")} no longer on the list {gone === 1 ? "comes" : "come"} off the plan first.
        </p>
      ) : null}
      <p className="break-words text-sm font-medium leading-6 text-slate-600">{reviewerSentence(view)} Until then, you can take it back to change it.</p>
      {problems.length > 0 ? (
        <CrmNote title="Fix these first" tone="bad">
          <ProblemList onOpenDay={onOpenDay} problems={problems} />
        </CrmNote>
      ) : null}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <CrmButton busy={busy} disabled={locked || problems.length > 0} onClick={onSend} variant="primary">
          Send
        </CrmButton>
        <CrmButton disabled={busy} onClick={onCancel}>
          Not yet
        </CrmButton>
      </div>
    </div>
  );
}

function DecisionBlock({
  busy,
  canApprove,
  canReturn,
  idPrefix,
  locked,
  onDecide,
  status,
}: {
  busy: PlanBusy | null;
  canApprove: boolean;
  canReturn: boolean;
  idPrefix: string;
  locked: boolean;
  onDecide: (action: "approve" | "return", note: string) => Promise<boolean>;
  status: PhoenixCrmPlanStatus;
}) {
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const noteId = `${idPrefix}-decision-note`;

  async function decide(action: "approve" | "return") {
    const trimmed = note.trim();
    if (action === "return" && !trimmed) {
      setProblem("Write a note for the rep on what to change.");
      return;
    }
    setProblem(null);
    if (await onDecide(action, trimmed)) setNote("");
  }

  return (
    <CrmBlock className="border-t border-slate-100" title="Your decision">
      <p className="break-words text-sm font-medium leading-6 text-slate-600">
        {canApprove
          ? "Approve the plan, or return it to the rep with a note on what to change."
          : status === "approved"
            ? "This plan is approved. You can still return it to the rep with a note on what to change."
            : "Return the plan to the rep with a note on what to change."}
      </p>
      <div className="mt-3 grid min-w-0 gap-2">
        <CrmField hint={canApprove ? "Needed to return the plan. The rep reads it." : "The rep reads it."} htmlFor={noteId} label="Note for the rep">
          <textarea
            className={crmTextareaClassName}
            disabled={locked}
            id={noteId}
            maxLength={PLAN_DECISION_NOTE_MAX}
            onChange={(event) => {
              setNote(event.target.value);
              setProblem(null);
            }}
            rows={3}
            value={note}
          />
        </CrmField>
        <div className={cn("grid gap-2 sm:flex sm:flex-wrap", canApprove && canReturn ? "grid-cols-2" : undefined)}>
          {canApprove ? (
            <CrmButton busy={busy === "approve"} disabled={locked} onClick={() => void decide("approve")} variant="success">
              Approve the plan
            </CrmButton>
          ) : null}
          {canReturn ? (
            <CrmButton busy={busy === "return"} disabled={locked} onClick={() => void decide("return")} variant="danger">
              Return for changes
            </CrmButton>
          ) : null}
        </div>
        {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
      </div>
    </CrmBlock>
  );
}

// ── One day ─────────────────────────────────────────────────────────────────────────────────────

function DayScreen({
  date,
  idPrefix,
  loadError,
  locked,
  notice,
  onAdd,
  onBack,
  onOpenDay,
  onReason,
  onRemove,
  onRetry,
  problems,
  showProblems,
  states,
  view,
}: {
  date: string;
  idPrefix: string;
  loadError: string | null;
  locked: boolean;
  notice: PlanNotice | null;
  onAdd: (date: string, items: ReadonlyArray<PlanItemDraft>) => void;
  onBack: () => void;
  onOpenDay: (date: string) => void;
  onReason: (date: string, customerId: string, exceptionType: PlanExceptionType | null, exceptionNote: string | null) => void;
  onRemove: (date: string, customerId: string) => void;
  onRetry: () => void;
  problems: ReadonlyArray<PlanProblem>;
  showProblems: boolean;
  states: ReadonlyArray<DayState>;
  view: PlannerView;
}) {
  const state = states.find((entry) => entry.day.date === date);
  if (!state) {
    return (
      <CrmPanel>
        <CrmBackBar backLabel="Week" onBack={onBack} title="Day" />
        <CrmEmpty message="Go back to the week and open one of its days." title="This day is not in the week on screen" />
      </CrmPanel>
    );
  }

  const { day } = state;
  const { rules } = view;
  const weekdayName = PHOENIX_CRM_WEEKDAY_NAMES[weekdayOfIsoDay(day.date)];
  const morning = !day.listTypes.includes("PM");
  const showSpread = !view.viewerIsRep || view.viewerIsReviewer;
  const live = state.rows.filter((row) => row.gone === null);
  const located = state.editing ? live.filter((row) => row.lat !== null).length : live.length;
  const repCannotChange = view.viewerIsRep && day.editable && !state.editing;

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Week" onBack={onBack} title={dayLabelLong(day.date)} />
      <NoticeArea
        currentDate={date}
        loadError={loadError}
        notice={notice}
        onOpenDay={onOpenDay}
        onRetry={onRetry}
        problems={showProblems ? problems : []}
      />

      <CrmBlock>
        <p className="break-words text-sm font-semibold text-slate-600">{territoryLine(view.territory)}</p>
        {!day.editable || morning || day.ramadan || repCannotChange ? (
          <div className="mt-3 grid min-w-0 gap-2">
            {!day.editable ? <CrmNote>This day has passed. It shows what was planned.</CrmNote> : null}
            {morning ? <CrmNote>Thursday is a morning: it holds AM only.</CrmNote> : null}
            {day.ramadan ? <CrmNote tone="info">A Ramadan day: each customer&apos;s Ramadan hours are used.</CrmNote> : null}
            {repCannotChange ? (
              <CrmNote>{view.blockedReason ?? "The plan is waiting for review or approved. Take it back on the week page to change it."}</CrmNote>
            ) : null}
          </div>
        ) : null}
        <CrmStatGrid className="mt-3">
          <CrmStat
            label="AM"
            note="The day's limit"
            tone={state.counts.AM > rules.amDailyCap ? "bad" : "neutral"}
            value={`${countText(state.counts.AM)} of ${countText(rules.amDailyCap)}`}
          />
          {morning ? null : (
            <CrmStat
              label="PM"
              note="The day's limit"
              tone={state.counts.PM > rules.pmDailyCap ? "bad" : "neutral"}
              value={`${countText(state.counts.PM)} of ${countText(rules.pmDailyCap)}`}
            />
          )}
          <CrmStat
            label="On a day off"
            note={state.offDay === 0 ? "Everyone placed receives that day" : state.needsReason > 0 ? `${countText(state.needsReason)} without a reason` : "Each with a reason"}
            tone={state.needsReason > 0 ? "bad" : state.offDay > 0 ? "warn" : "neutral"}
            value={countText(state.offDay)}
          />
          {showSpread ? (
            <CrmStat
              label="Farthest apart"
              note={`Flagged above ${rules.farApartKm} km`}
              tone={state.farApart ? "warn" : "neutral"}
              value={located < 2 ? "—" : `${state.spanKm} km`}
            />
          ) : null}
        </CrmStatGrid>
        {showSpread && state.farApart ? (
          <CrmNote className="mt-3" title="Far apart" tone="warn">
            The customers of this day are up to {state.spanKm} km apart, more than {rules.farApartKm} km.
          </CrmNote>
        ) : null}
      </CrmBlock>

      {/* From `md` the day and the customers to add sit side by side, so a tablet reads both at once
          rather than scrolling between them. Only while editing — a day read back is one column. */}
      <div className={cn("min-w-0", state.editing && "md:grid md:grid-cols-2")}>
        <CrmBlock className="border-t border-slate-100" title={`On this day · ${pairText(state.counts, day)}`}>
          {state.rows.length === 0 ? (
            <p className="text-sm font-medium text-slate-500">
              {state.editing ? "Nobody is placed on this day yet. Choose them under Add customers." : "Nothing was planned on this day."}
            </p>
          ) : (
            <div className="grid min-w-0 gap-2">
              {state.rows.map((row) => (
                <PlannedRow
                  editing={state.editing}
                  idPrefix={idPrefix}
                  key={row.customerId}
                  locked={locked}
                  onReason={(exceptionType, exceptionNote) => onReason(day.date, row.customerId, exceptionType, exceptionNote)}
                  onRemove={() => onRemove(day.date, row.customerId)}
                  row={row}
                  showSpread={showSpread}
                  weekdayName={weekdayName}
                />
              ))}
            </div>
          )}
        </CrmBlock>

        {state.editing ? (
          <AddCustomers
            counts={state.counts}
            day={day}
            idPrefix={idPrefix}
            key={day.date}
            locked={locked}
            onAdd={(items) => onAdd(day.date, items)}
            rows={state.rows}
            view={view}
          />
        ) : null}
      </div>
    </CrmPanel>
  );
}

function PlannedRow({
  editing,
  idPrefix,
  locked,
  onReason,
  onRemove,
  row,
  showSpread,
  weekdayName,
}: {
  editing: boolean;
  idPrefix: string;
  locked: boolean;
  onReason: (exceptionType: PlanExceptionType | null, exceptionNote: string | null) => void;
  onRemove: () => void;
  row: DayRow;
  showSpread: boolean;
  weekdayName: string;
}) {
  const noteId = `${idPrefix}-note-${row.customerId}`;
  const accent = row.gone !== null ? "border-l-rose-500" : !row.receives ? "border-l-amber-500" : "border-l-slate-300";
  const details = [row.where, row.visits].filter((part): part is string => Boolean(part));

  return (
    <article className={cn("min-w-0 border border-l-[3px] border-slate-200 bg-white px-3.5 py-3", accent)}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <h4 className="break-words text-sm font-black text-slate-950">{row.name}</h4>
          {row.meta ? <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{row.meta}</p> : null}
          {row.hours ? <p className="mt-1 break-words text-sm font-bold text-slate-800">{row.hours}</p> : null}
          {details.length > 0 ? <p className="break-words text-xs font-semibold leading-5 text-slate-600">{details.join(" · ")}</p> : null}
        </div>
        {editing ? (
          <CrmButton disabled={locked} onClick={onRemove} size="sm" variant="danger">
            Take off
          </CrmButton>
        ) : null}
      </div>

      <div className="mt-2 flex max-w-full flex-wrap gap-1">
        {row.gone === "customer" ? <CrmPill tone="bad">Left the list</CrmPill> : null}
        {row.gone === "place" ? <CrmPill tone="bad">Place removed</CrmPill> : null}
        {row.gone === null && row.pending ? <CrmPill tone="orange">{PENDING_PILL}</CrmPill> : null}
        {row.gone === null && row.standing ? <CrmPill tone={row.standing.tone}>{row.standing.label}</CrmPill> : null}
        {row.gone === null && !row.receives && row.exceptionType ? <CrmPill tone="warn">{exceptionLabel(row.exceptionType)}</CrmPill> : null}
        {row.gone === null && !row.receives && !row.exceptionType ? <CrmPill tone={editing ? "bad" : "warn"}>No reason given</CrmPill> : null}
        {row.noRamadanTime ? <CrmPill tone="warn">No Ramadan hours</CrmPill> : null}
        {showSpread && row.gone === null && row.isolated ? (
          <CrmPill tone="warn">{row.nearestKm !== null ? `${row.nearestKm} km from the nearest` : "Far from the others"}</CrmPill>
        ) : null}
      </div>

      {row.gone !== null ? (
        <CrmNote className="mt-2" tone="bad">
          {row.gone === "customer" ? "This customer has left the list." : "This place was removed from the customer."}
          {editing ? " It comes off the plan when you save." : null}
        </CrmNote>
      ) : null}

      {row.gone === null && !row.receives ? (
        editing ? (
          <div className="mt-3 grid min-w-0 gap-2 border-t border-slate-100 pt-3">
            <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">Why on {weekdayName}?</p>
            <CrmChoice
              columns={2}
              label={`Why ${row.name} is on ${weekdayName}`}
              onChange={(exceptionType) => onReason(exceptionType, row.exceptionNote)}
              options={EXCEPTION_OPTIONS.map((option) => ({ ...option, disabled: locked }))}
              value={row.exceptionType}
            />
            <CrmField hint={row.exceptionType === "other" ? "Needed for Other." : "Optional."} htmlFor={noteId} label="Note">
              <textarea
                className={crmTextareaClassName}
                disabled={locked}
                id={noteId}
                maxLength={PLAN_NOTE_MAX}
                onChange={(event) => onReason(row.exceptionType, event.target.value)}
                rows={2}
                value={row.exceptionNote ?? ""}
              />
            </CrmField>
          </div>
        ) : row.exceptionNote ? (
          <p className="mt-2 whitespace-pre-line break-words text-sm font-medium leading-6 text-slate-700">
            <span className="font-black text-slate-800">Rep&apos;s note: </span>
            {row.exceptionNote}
          </p>
        ) : null
      ) : null}
    </article>
  );
}

/** One place per customer, as many as the day's limits still take, in the order shown. */
function pickWithinCaps(suggestions: ReadonlyArray<DaySuggestion>, remaining: Record<PhoenixCrmListType, number>): DaySuggestion[] {
  const left = { ...remaining };
  const seen = new Set<string>();
  const picked: DaySuggestion[] = [];
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.customerId)) continue;
    seen.add(suggestion.customerId);
    if (left[suggestion.listType] <= 0) continue;
    left[suggestion.listType] -= 1;
    picked.push(suggestion);
  }
  return picked;
}

function distinctCustomers(suggestions: ReadonlyArray<DaySuggestion>): number {
  return new Set(suggestions.map((suggestion) => suggestion.customerId)).size;
}

/** "14:30" → minutes after midnight, or null for a blank or malformed field. */
function clockToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(minute) && minute >= 0 && minute <= 1439 ? minute : null;
}

function AddCustomers({
  counts,
  day,
  idPrefix,
  locked,
  onAdd,
  rows,
  view,
}: {
  counts: Record<PhoenixCrmListType, number>;
  day: PlanDayView;
  idPrefix: string;
  locked: boolean;
  onAdd: (items: ReadonlyArray<PlanItemDraft>) => void;
  rows: ReadonlyArray<DayRow>;
  view: PlannerView;
}) {
  const [typeFilter, setTypeFilter] = useState<"all" | PhoenixCrmListType>("all");
  const [query, setQuery] = useState("");
  const [brickFilter, setBrickFilter] = useState("");
  const [fromTime, setFromTime] = useState("");
  const [toTime, setToTime] = useState("");
  const [showOff, setShowOff] = useState(false);
  const [limit, setLimit] = useState(SUGGESTION_PAGE);
  const [offLimit, setOffLimit] = useState(SUGGESTION_PAGE);
  const [specialityFilter, setSpecialityFilter] = useState("");
  const [gradeFilter, setGradeFilter] = useState<"" | PhoenixCrmGrade>("");
  const [dayFilter, setDayFilter] = useState<ReadonlySet<number>>(() => new Set<number>());
  const [unvisitedOnly, setUnvisitedOnly] = useState(false);
  const [groupByBrick, setGroupByBrick] = useState(false);

  const weekday = weekdayOfIsoDay(day.date);
  const weekdayName = PHOENIX_CRM_WEEKDAY_NAMES[weekday];
  const dayName = dayLabel(day.date);
  const morning = !day.listTypes.includes("PM");
  const searchId = `${idPrefix}-search-${day.date}`;
  const brickId = `${idPrefix}-brick-${day.date}`;
  const placed = rows.filter((row) => row.gone === null).map((row) => ({ customerId: row.customerId, placeId: row.placeId }));
  // A customer not validated yet has no place, and is offered exactly like anyone else: the rep plans
  // him and validates him at the door. Only a validated customer whose places are all gone drops out.
  const eligible = view.customers.filter(
    (customer) => day.listTypes.includes(customer.listType) && (customer.pending || customer.places.length > 0),
  );
  const all = suggestForDay({ weekday, ramadan: day.ramadan, customers: eligible, placed, settings: view.rules }).filter(
    (suggestion) => !suggestion.alreadyOnDay,
  );
  const remaining: Record<PhoenixCrmListType, number> = {
    AM: Math.max(0, view.rules.amDailyCap - counts.AM),
    PM: Math.max(0, view.rules.pmDailyCap - counts.PM),
  };

  // A dedicated brick filter (owner, 2026-09-25): the rep narrows the list to one brick while he
  // plans. Only the bricks the offered customers actually sit in, each once, named as captured.
  const brickOptions: Array<{ value: string; label: string }> = [];
  for (const suggestion of all) {
    const value = normalizeArea(suggestion.brick);
    if (suggestion.brick !== null && value !== null && !brickOptions.some((option) => option.value === value)) {
      brickOptions.push({ value, label: `Brick ${suggestion.brick.trim()}` });
    }
  }
  brickOptions.sort((left, right) => left.label.localeCompare(right.label));

  // Every weekday each customer receives on, across all his places — so the "Receives on" filter can
  // narrow to doctors who receive on any chosen day even while one single day is being planned.
  const receivingDaysByCustomer = new Map<string, Set<number>>();
  for (const customer of view.customers) {
    const days = new Set<number>();
    for (const place of customer.places) for (const timing of place.timings) days.add(timing.weekday);
    receivingDaysByCustomer.set(customer.customerId, days);
  }
  // Saturday-first, and only the weekdays at least one offered doctor actually receives on.
  const dayOptions = [6, 0, 1, 2, 3, 4, 5].filter((weekday) => all.some((suggestion) => receivingDaysByCustomer.get(suggestion.customerId)?.has(weekday)));
  const specialityOptions = [...new Set(all.map((suggestion) => suggestion.speciality).filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
  const gradeOptions = (["A", "B", "C"] as const).filter((grade) => all.some((suggestion) => suggestion.grade === grade));
  const gradeChoiceOptions: ReadonlyArray<CrmChoiceOption<"" | PhoenixCrmGrade>> = [
    { value: "", label: "Any grade" },
    ...gradeOptions.map((grade) => ({ value: grade, label: `Grade ${grade}` })),
  ];

  const needle = query.trim().toLowerCase();
  // "Receives between X and Y" on this fixed day. A blank end runs to midnight, a blank start from
  // midnight; when either is set, a customer with no window on this day cannot match the range.
  const fromMinute = clockToMinutes(fromTime);
  const toMinute = clockToMinutes(toTime);
  const windowActive = fromMinute !== null || toMinute !== null;
  const rangeFrom = fromMinute ?? 0;
  const rangeTo = toMinute ?? 1440;
  const shown = all.filter(
    (suggestion) =>
      (typeFilter === "all" || suggestion.listType === typeFilter) &&
      (!needle ||
        [suggestion.name, suggestion.speciality, suggestion.placeLabel, suggestion.zone, suggestion.brick].some(
          (part) => part !== null && part.toLowerCase().includes(needle),
        )) &&
      (!brickFilter || normalizeArea(suggestion.brick) === brickFilter) &&
      (!specialityFilter || suggestion.speciality === specialityFilter) &&
      (gradeFilter === "" || suggestion.grade === gradeFilter) &&
      (dayFilter.size === 0 || [...(receivingDaysByCustomer.get(suggestion.customerId) ?? [])].some((weekday) => dayFilter.has(weekday))) &&
      (!unvisitedOnly || suggestion.visitsThisMonth === 0) &&
      (!windowActive || suggestion.windows.some((window) => windowOverlapsRange(window, rangeFrom, rangeTo))),
  );
  const receiving = shown.filter((suggestion) => suggestion.receives);
  const notReceiving = shown.filter((suggestion) => !suggestion.receives);
  const filtered =
    needle !== "" || brickFilter !== "" || typeFilter !== "all" || windowActive || specialityFilter !== "" || gradeFilter !== "" || dayFilter.size > 0 || unvisitedOnly;
  const bulk = pickWithinCaps(receiving, remaining);
  const receivingCustomers = distinctCustomers(receiving);

  // The other weekdays a doctor receives on (Saturday-first, the day being planned removed) — shown as
  // chips under his name so the rep can chain a visit across days without opening each one.
  const otherDaysOf = (customerId: string): number[] =>
    [6, 0, 1, 2, 3, 4, 5].filter((other) => other !== weekday && (receivingDaysByCustomer.get(customerId)?.has(other) ?? false));

  // Cluster a list by brick, so a day's candidates read in geographic groups and fewer visits land far
  // apart. A customer with no brick falls into one "No brick" group.
  const brickGroups = (list: ReadonlyArray<DaySuggestion>): Array<{ key: string; label: string; rows: DaySuggestion[] }> => {
    const groups = new Map<string, { label: string; rows: DaySuggestion[] }>();
    for (const suggestion of list) {
      const key = normalizeArea(suggestion.brick) ?? "—";
      const label = suggestion.brick?.trim() ? `Brick ${suggestion.brick.trim()}` : "No brick";
      const group = groups.get(key) ?? { label, rows: [] };
      group.rows.push(suggestion);
      groups.set(key, group);
    }
    return [...groups.entries()]
      .map(([key, group]) => ({ key, label: group.label, rows: group.rows }))
      .sort((left, right) => left.label.localeCompare(right.label));
  };

  function filterBy(update: () => void) {
    update();
    setLimit(SUGGESTION_PAGE);
    setOffLimit(SUGGESTION_PAGE);
  }

  function addOne(suggestion: DaySuggestion, exceptionType: PlanExceptionType | null, exceptionNote: string | null) {
    onAdd([{ planDate: day.date, customerId: suggestion.customerId, placeId: suggestion.placeId, exceptionType, exceptionNote }]);
  }

  function addBulk() {
    onAdd(bulk.map((suggestion) => ({ planDate: day.date, customerId: suggestion.customerId, placeId: suggestion.placeId, exceptionType: null, exceptionNote: null })));
  }

  const typeOptions: ReadonlyArray<CrmChoiceOption<"all" | PhoenixCrmListType>> = [
    { value: "all", label: "Everyone", note: `${countText(distinctCustomers(all))} to choose from` },
    { value: "PM", label: "PM", note: `${countText(distinctCustomers(all.filter((entry) => entry.listType === "PM")))} to choose from` },
    { value: "AM", label: "AM", note: `${countText(distinctCustomers(all.filter((entry) => entry.listType === "AM")))} to choose from` },
  ];

  const suggestionRow = (suggestion: DaySuggestion) => (
    <SuggestionRow
      dayName={dayName}
      full={remaining[suggestion.listType] <= 0}
      hasPlaced={placed.length > 0}
      idPrefix={idPrefix}
      key={`${suggestion.customerId}|${suggestion.placeId}`}
      locked={locked}
      onAdd={(exceptionType, exceptionNote) => addOne(suggestion, exceptionType, exceptionNote)}
      otherDays={otherDaysOf(suggestion.customerId)}
      suggestion={suggestion}
      weekdayName={weekdayName}
    />
  );

  // Beside "On this day" from `md` (see DayScreen), so the rule between them is drawn on this side.
  return (
    <CrmBlock className="border-t border-slate-100 md:border-l" title="Add customers">
      <p className="break-words text-sm font-semibold leading-6 text-slate-600">
        {morning
          ? `Room for ${countText(remaining.AM)} more AM on this morning.`
          : `Room for ${countText(remaining.AM)} more AM and ${countText(remaining.PM)} more PM on this day.`}{" "}
        Customers who receive on {weekdayName} come first, those not visited this month at the top.
      </p>

      {eligible.length === 0 ? (
        <p className="mt-3 text-sm font-medium text-slate-500">
          {morning ? "No AM to place yet." : "No customer to place yet."} Customers on your List tab show here.
        </p>
      ) : all.length === 0 ? (
        <p className="mt-3 text-sm font-medium text-slate-500">Every customer who can go on this day is already on it.</p>
      ) : (
        <>
          <div className="mt-3 grid min-w-0 gap-3">
            {morning ? null : (
              <CrmField label="Show">
                <CrmChoice columns={3} label="Show" onChange={(next) => filterBy(() => setTypeFilter(next))} options={typeOptions} value={typeFilter} />
              </CrmField>
            )}
            {/* Search and brick share a row only on the widest screens: from `md` this block is half
                the day screen, and an 18rem select beside the search would crush it. */}
            <div className={cn("grid min-w-0 gap-3", brickOptions.length > 1 ? "2xl:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] 2xl:items-end" : undefined)}>
              <CrmField htmlFor={searchId} label="Find a customer">
                <div className="relative min-w-0">
                  <Search aria-hidden className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-slate-400" />
                  <input
                    autoComplete="off"
                    className={cn(crmInputClassName, "appearance-none pl-9")}
                    id={searchId}
                    onChange={(event) => {
                      const next = event.target.value;
                      filterBy(() => setQuery(next));
                    }}
                    placeholder="Name, speciality, place, zone or brick"
                    type="search"
                    value={query}
                  />
                </div>
              </CrmField>
              {brickOptions.length > 1 ? (
                <CrmField htmlFor={brickId} label="Brick">
                  <CrmSelect
                    id={brickId}
                    onChange={(event) => {
                      const next = event.target.value;
                      filterBy(() => setBrickFilter(next));
                    }}
                    value={brickFilter}
                  >
                    <option value="">Every brick</option>
                    {brickOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </CrmSelect>
                </CrmField>
              ) : null}
            </div>
            {/* Receives on this day between X and Y — both optional; a blank end means to the day's close. */}
            <div className="grid min-w-0 grid-cols-2 gap-3 sm:max-w-md">
              <CrmField hint="Optional" htmlFor={`${idPrefix}-from-${day.date}`} label={`Receives on ${weekdayName} from`}>
                <input
                  className={crmInputClassName}
                  id={`${idPrefix}-from-${day.date}`}
                  onChange={(event) => {
                    const next = event.target.value;
                    filterBy(() => setFromTime(next));
                  }}
                  type="time"
                  value={fromTime}
                />
              </CrmField>
              <CrmField hint="Optional" htmlFor={`${idPrefix}-to-${day.date}`} label="To">
                <input
                  className={crmInputClassName}
                  id={`${idPrefix}-to-${day.date}`}
                  onChange={(event) => {
                    const next = event.target.value;
                    filterBy(() => setToTime(next));
                  }}
                  type="time"
                  value={toTime}
                />
              </CrmField>
            </div>
            {gradeOptions.length > 0 ? (
              <CrmField label="Grade">
                <CrmChoice columns={4} label="Grade" onChange={(next) => filterBy(() => setGradeFilter(next))} options={gradeChoiceOptions} value={gradeFilter} />
              </CrmField>
            ) : null}
            {specialityOptions.length > 1 ? (
              <CrmField htmlFor={`${idPrefix}-spec-${day.date}`} label="Speciality">
                <CrmSelect
                  id={`${idPrefix}-spec-${day.date}`}
                  onChange={(event) => {
                    const next = event.target.value;
                    filterBy(() => setSpecialityFilter(next));
                  }}
                  value={specialityFilter}
                >
                  <option value="">Every speciality</option>
                  {specialityOptions.map((speciality) => (
                    <option key={speciality} value={speciality}>
                      {speciality}
                    </option>
                  ))}
                </CrmSelect>
              </CrmField>
            ) : null}
            {dayOptions.length > 1 ? (
              <CrmField hint="Pick one or more — keeps customers who receive on any of them" label="Receives on">
                <div aria-label="Receives on" className="grid grid-cols-3 gap-1.5 sm:grid-cols-4" role="group">
                  {dayOptions.map((weekday) => {
                    const selected = dayFilter.has(weekday);
                    return (
                      <button
                        aria-pressed={selected}
                        className={cn(
                          "min-h-11 min-w-0 rounded-none border px-3 py-2 text-left text-sm font-black transition",
                          selected ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                        )}
                        key={weekday}
                        onClick={() =>
                          filterBy(() =>
                            setDayFilter((prev) => {
                              const next = new Set(prev);
                              if (next.has(weekday)) next.delete(weekday);
                              else next.add(weekday);
                              return next;
                            }),
                          )
                        }
                        type="button"
                      >
                        <span className="block break-words">{PHOENIX_CRM_WEEKDAY_NAMES[weekday]}</span>
                      </button>
                    );
                  })}
                </div>
              </CrmField>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              <button
                aria-pressed={unvisitedOnly}
                className={cn(
                  "min-h-11 rounded-none border px-3 py-2 text-sm font-black transition",
                  unvisitedOnly ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                )}
                onClick={() => filterBy(() => setUnvisitedOnly((on) => !on))}
                type="button"
              >
                Not visited this month
              </button>
              <button
                aria-pressed={groupByBrick}
                className={cn(
                  "min-h-11 rounded-none border px-3 py-2 text-sm font-black transition",
                  groupByBrick ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-700 hover:border-slate-300",
                )}
                onClick={() => setGroupByBrick((on) => !on)}
                type="button"
              >
                Group by brick
              </button>
            </div>
            {filtered && receivingCustomers > 0 ? (
              <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center">
                <CrmButton disabled={locked || bulk.length === 0} onClick={addBulk} variant="primary">
                  {bulk.length > 0 ? <Plus aria-hidden className="h-4 w-4" /> : null}
                  {bulk.length === 0
                    ? "No room left for them on this day"
                    : bulk.length === receivingCustomers
                      ? `Add all ${countText(receivingCustomers)} found`
                      : `Add ${countText(bulk.length)} of the ${countText(receivingCustomers)} found`}
                </CrmButton>
                {bulk.length > 0 && bulk.length < receivingCustomers ? (
                  <span className="text-xs font-semibold leading-5 text-slate-500">The day&apos;s limits leave room for {countText(bulk.length)} of them.</span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="mt-3 min-w-0">
            {receiving.length === 0 && notReceiving.length === 0 ? (
              <p className="text-sm font-medium text-slate-500">No customer matches. Clear the search or choose another zone or brick.</p>
            ) : (
              <>
                {receiving.length === 0 ? (
                  <p className="text-sm font-medium text-slate-500">Nobody found receives on {weekdayName}.</p>
                ) : (
                  groupByBrick ? (
                    <div className="grid gap-3">
                      {brickGroups(receiving).map((group) => (
                        <div className="min-w-0" key={group.key}>
                          <h4 className="mb-1.5 break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">
                            {group.label} · {countText(group.rows.length)}
                          </h4>
                          <div className="divide-y divide-slate-100 border border-slate-200">{group.rows.map(suggestionRow)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <div className="divide-y divide-slate-100 border border-slate-200">{receiving.slice(0, limit).map(suggestionRow)}</div>
                      {receiving.length > limit ? (
                        <div className="mt-2">
                          <CrmButton onClick={() => setLimit((current) => current + SUGGESTION_PAGE)} size="sm">
                            Show {countText(Math.min(SUGGESTION_PAGE, receiving.length - limit))} more of the {countText(receiving.length - limit)} left
                          </CrmButton>
                        </div>
                      ) : null}
                    </>
                  )
                )}

                {notReceiving.length > 0 ? (
                  showOff ? (
                    <div className="mt-4 min-w-0">
                      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-phx-2xs font-black uppercase tracking-[0.16em] text-slate-500">Do not receive on {weekdayName}</h4>
                        <CrmButton onClick={() => setShowOff(false)} size="sm" variant="ghost">
                          Hide them
                        </CrmButton>
                      </div>
                      <div className="divide-y divide-slate-100 border border-slate-200">{notReceiving.slice(0, offLimit).map(suggestionRow)}</div>
                      {notReceiving.length > offLimit ? (
                        <div className="mt-2">
                          <CrmButton onClick={() => setOffLimit((current) => current + SUGGESTION_PAGE)} size="sm">
                            Show {countText(Math.min(SUGGESTION_PAGE, notReceiving.length - offLimit))} more of the {countText(notReceiving.length - offLimit)} left
                          </CrmButton>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mt-3">
                      <CrmButton onClick={() => setShowOff(true)} size="sm">
                        Show {countText(distinctCustomers(notReceiving))} who do not receive on {weekdayName}
                      </CrmButton>
                    </div>
                  )
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </CrmBlock>
  );
}

function SuggestionRow({
  dayName,
  full,
  hasPlaced,
  idPrefix,
  locked,
  onAdd,
  otherDays,
  suggestion,
  weekdayName,
}: {
  /** "Sat 19 Sept" */
  dayName: string;
  /** The day holds as many of this customer's kind as it can. */
  full: boolean;
  /** Someone is already on the day, so the hours are compared with theirs. */
  hasPlaced: boolean;
  idPrefix: string;
  locked: boolean;
  onAdd: (exceptionType: PlanExceptionType | null, exceptionNote: string | null) => void;
  /** The other weekdays this doctor receives on, Saturday-first, so a rep can chain-plan him. */
  otherDays: number[];
  suggestion: DaySuggestion;
  weekdayName: string;
}) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<PlanExceptionType | null>(null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const standing = suggestion.pending ? null : monthStanding(suggestion.visitsThisMonth, suggestion.target);
  const hours = suggestion.pending
    ? "No days and hours yet"
    : suggestion.receives
      ? suggestion.windows.map((window) => formatTimingWindow(window)).join(", ")
      : `Does not receive on ${weekdayName}`;
  const noteId = `${idPrefix}-add-note-${suggestion.customerId}-${suggestion.placeId ?? "pending"}`;

  function add() {
    if (suggestion.receives) {
      onAdd(null, null);
      return;
    }
    setAsking(true);
  }

  function addWithReason() {
    if (!reason) {
      setProblem(`Choose why ${suggestion.name} goes on ${dayName}.`);
      return;
    }
    if (reason === "other" && !note.trim()) {
      setProblem("Write a note for Other.");
      return;
    }
    onAdd(reason, note.trim() || null);
  }

  return (
    <article className="min-w-0 bg-white px-3.5 py-3">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <h4 className="break-words text-sm font-black text-slate-950">{suggestion.name}</h4>
          <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{customerMetaText(suggestion)}</p>
          <p className="mt-1 break-words text-sm font-bold text-slate-800">{hours}</p>
          <p className="break-words text-xs font-semibold leading-5 text-slate-600">
            {suggestion.pending ? (
              pendingVisitsText(suggestion.visitsThisMonth)
            ) : (
              <>
                {placeLine({ label: suggestion.placeLabel, zone: suggestion.zone, brick: suggestion.brick }, null)} ·{" "}
                {monthVisitsText(suggestion.visitsThisMonth, suggestion.target)}
              </>
            )}
          </p>
          {!suggestion.pending && suggestion.address ? (
            <p className="mt-1 flex min-w-0 items-start gap-1 text-xs font-semibold leading-5 text-slate-600">
              <MapPin aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="min-w-0 break-words">{suggestion.address}</span>
            </p>
          ) : null}
          {!suggestion.pending && otherDays.length > 0 ? (
            <div className="mt-1.5 flex max-w-full flex-wrap items-center gap-1">
              <span className="text-xs font-semibold text-slate-500">Also receives</span>
              {otherDays.map((day) => (
                <span
                  key={day}
                  className="inline-flex min-h-6 items-center border border-slate-200 bg-slate-50 px-1.5 text-xs font-bold text-slate-700"
                >
                  {PHOENIX_CRM_WEEKDAY_NAMES[day].slice(0, 3)}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {asking ? null : (
          <CrmButton disabled={locked || full} onClick={add} size="sm" variant={suggestion.receives ? "primary" : "secondary"}>
            {full ? null : <Plus aria-hidden className="h-4 w-4" />}
            {full ? "Day full" : "Add"}
          </CrmButton>
        )}
      </div>

      <div className="mt-2 flex max-w-full flex-wrap gap-1">
        {standing ? <CrmPill tone={standing.tone}>{standing.label}</CrmPill> : <CrmPill tone="orange">{PENDING_PILL}</CrmPill>}
        {suggestion.sameBrick ? <CrmPill tone="info">Same brick</CrmPill> : suggestion.sameZone ? <CrmPill tone="info">Same zone</CrmPill> : null}
        {hasPlaced && suggestion.receives ? (
          suggestion.fitsTime ? (
            <CrmPill tone="good">Fits the day&apos;s hours</CrmPill>
          ) : (
            <CrmPill tone="warn">Outside the day&apos;s hours</CrmPill>
          )
        ) : null}
        {suggestion.nearestPlacedKm !== null ? <CrmPill>{suggestion.nearestPlacedKm} km from the nearest customer of the day</CrmPill> : null}
        {suggestion.noRamadanTime ? <CrmPill tone="warn">No Ramadan hours</CrmPill> : null}
      </div>

      {asking ? (
        <div className="mt-3 grid min-w-0 gap-2 border-t border-slate-100 pt-3">
          <p className="break-words text-sm font-bold text-slate-800">
            {suggestion.name} does not receive on {weekdayName}. Why does the visit go on {dayName}?
          </p>
          <CrmChoice
            columns={2}
            label={`Why ${suggestion.name} goes on ${dayName}`}
            onChange={(next) => {
              setReason(next);
              setProblem(null);
            }}
            options={EXCEPTION_OPTIONS}
            value={reason}
          />
          <CrmField hint={reason === "other" ? "Needed for Other." : "Optional."} htmlFor={noteId} label="Note">
            <textarea
              className={crmTextareaClassName}
              id={noteId}
              maxLength={PLAN_NOTE_MAX}
              onChange={(event) => {
                setNote(event.target.value);
                setProblem(null);
              }}
              rows={2}
              value={note}
            />
          </CrmField>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <CrmButton disabled={locked || full} onClick={addWithReason} variant="primary">
              Add to {dayName}
            </CrmButton>
            <CrmButton
              onClick={() => {
                setAsking(false);
                setProblem(null);
              }}
            >
              Cancel
            </CrmButton>
          </div>
          {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
        </div>
      ) : null}
    </article>
  );
}
