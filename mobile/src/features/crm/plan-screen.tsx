import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CrmBackBar, CrmChoice, CrmNote, CrmPill, CrmSearch, CrmSection, type CrmChoiceOption } from "@/components/crm/crm-kit";
import { ErrorNotice, LoadingScreen, MicroLabel, PrimaryButton, SecondaryButton, StatTile } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { crmErrorCode, crmErrorMessage, crmPost, crmUrl, useCrm } from "@/lib/crm/client";
import { cairoStamp, countText, dayLabel, dayLabelLong, plural, weekLabel, weekdayOfIsoDay } from "@/lib/crm/format";
import { customerMetaText, monthStanding, monthVisitsText, PENDING_PILL, pendingVisitsText, territoryLine } from "@/lib/crm/labels";
import { coverageTier, exceptionLabel, gradeTarget, PLAN_EXCEPTION_TYPES, PLAN_NOTE_MAX, planStatusLabel } from "@/lib/crm/plan-rules";
import { CRM_WEEKDAY_NAMES, formatTimingWindow, windowsForWeekday } from "@/lib/crm/timings";
import { useSession } from "@/lib/session";
import { hairline, radius, space, type } from "@/theme/tokens";
import { usePalette } from "@/theme/use-palette";
import type { CrmTone } from "@/components/crm/crm-kit";
import type {
  CrmGrade,
  CrmListType,
  PlanDayView,
  PlanExceptionType,
  PlanItemDraft,
  PlanItemView,
  PlannerCustomer,
  PlannerPlace,
  PlannerView,
  PlanTransition,
  SavedPlan,
} from "@/lib/crm/types";

/**
 * Phoenix CRM — the Plan screen on the phone: a territory's weekly plan.
 *
 * The native counterpart of the web `PlanTab` (src/components/phoenix-crm/plan-tab.tsx), on the same
 * route (/api/phoenix-crm/plans). The rep places the customers and the system assists — every
 * customer's days and hours show, and a customer placed on a day it does not receive asks for a reason
 * rather than being refused. The week runs Saturday to Wednesday plus Thursday morning (accounts only);
 * a plan day holds at most 15 PM doctors and 5 AM accounts. The district manager approves; nothing
 * approves a plan by itself.
 *
 * This first screen is the rep's core: open a week, open a day, add and take off customers, give a
 * reason for an off-day placement, save the plan, send it for review, and take it back to change it.
 * The manager's approve/return, the far-apart spread flags and the geo-ranked suggestions are later
 * work; a manager viewing a plan here sees it read-only. The rep's changes stay on the phone as a draft
 * over the saved version until "Save the plan"; a save against an older version reloads the latest.
 */

type PlanScreenName = { name: "week" } | { name: "day"; date: string };

type PlanNotice = { tone: CrmTone; title: string; message?: string | null };

type PlanBusy = "save" | "send" | "reopen";

/** The rep's changes to one week, over the saved version they were started on. */
type Draft = {
  scope: string;
  basis: string;
  items: PlanItemDraft[];
  saved: { items: PlanItemDraft[]; planId: string; version: number } | null;
};

/** A refusal that means the plan on screen is out of date: the screen reads it again. */
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

const RELOADED_MESSAGES: Record<string, string> = {
  phoenix_crm_version_conflict: "This plan was changed on another screen. It now shows the latest version, so make your changes again.",
  phoenix_crm_not_editable: "This plan was sent for review or approved on another screen. It now shows the latest version.",
};

const STATUS_TONE: Record<string, CrmTone> = {
  none: "neutral",
  draft: "neutral",
  submitted: "warn",
  approved: "good",
  returned: "bad",
};

const EXCEPTION_OPTIONS: ReadonlyArray<CrmChoiceOption<PlanExceptionType>> = PLAN_EXCEPTION_TYPES.map((entry) => ({
  value: entry.key,
  label: entry.label,
}));

const SUGGESTION_PAGE = 25;

// ── Reading the plan ──────────────────────────────────────────────────────────────────────────────

function planUrl(seatId: string, test: boolean, weekStart: string | null): string {
  return crmUrl("/api/phoenix-crm/plans", { seatId, test, weekStart });
}

function asExceptionType(value: string | null): PlanExceptionType | null {
  return PLAN_EXCEPTION_TYPES.find((entry) => entry.key === value)?.key ?? null;
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

function normalizeArea(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.replace(/\s+/g, " ").trim().toLowerCase();
  return cleaned.length > 0 ? cleaned : null;
}

/** "Evening clinic · Faisal · Brick Haram", each part once; a place with none of them by its order. */
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

/** One customer on a plan day, as a row shows it. Geo (far-apart) is a later screen, so it is left out. */
type DayRow = {
  customerId: string;
  placeId: string | null;
  pending: boolean;
  name: string;
  listType: CrmListType;
  meta: string;
  where: string;
  hours: string;
  receives: boolean;
  noRamadanTime: boolean;
  exceptionType: PlanExceptionType | null;
  exceptionNote: string | null;
  gone: "customer" | "place" | null;
  standing: { label: string; tone: CrmTone } | null;
  visits: string | null;
  startMinute: number | null;
};

function compareRows(left: DayRow, right: DayRow): number {
  return (
    left.listType.localeCompare(right.listType) ||
    (left.startMinute ?? 9999) - (right.startMinute ?? 9999) ||
    left.name.localeCompare(right.name)
  );
}

function liveRow(entry: PlaceEntry, item: PlanItemDraft, day: PlanDayView, targets: PlannerView["rules"]["gradeTargets"]): DayRow {
  const { customer, place } = entry;
  const weekday = weekdayOfIsoDay(day.date);
  const { windows, noRamadanTime } = windowsForWeekday(place.timings, weekday, day.ramadan);
  const receives = windows.length > 0;
  const target = gradeTarget(targets, customer.listType, customer.grade);
  return {
    customerId: customer.customerId,
    placeId: place.placeId,
    pending: false,
    name: customer.name,
    listType: customer.listType,
    meta: customerMetaText(customer),
    where: placeLine(place, entry.position),
    hours: receives ? windows.map((window) => formatTimingWindow(window)).join(", ") : `Does not receive on ${CRM_WEEKDAY_NAMES[weekday]}`,
    receives,
    noRamadanTime: receives && noRamadanTime,
    exceptionType: receives ? null : item.exceptionType,
    exceptionNote: receives ? null : item.exceptionNote,
    gone: null,
    standing: monthStanding(customer.visitsThisMonth, target),
    visits: monthVisitsText(customer.visitsThisMonth, target),
    startMinute: receives ? windows[0].startMinute : null,
  };
}

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
    startMinute: null,
  };
}

function savedRow(item: PlanItemView, index: PlanIndex, targets: PlannerView["rules"]["gradeTargets"]): DayRow {
  const entry = item.placeId ? index.places.get(item.placeId) : undefined;
  const onList = entry !== undefined && entry.customer.customerId === item.customerId ? entry : null;
  const target = onList ? gradeTarget(targets, onList.customer.listType, onList.customer.grade) : null;
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
    visits: item.pending ? pendingVisitsText(listed?.visitsThisMonth ?? 0) : onList ? monthVisitsText(onList.customer.visitsThisMonth, target) : null,
    startMinute: item.startMinute,
  };
}

function draftRow(item: PlanItemDraft, day: PlanDayView, index: PlanIndex, targets: PlannerView["rules"]["gradeTargets"]): DayRow {
  if (item.placeId === null) {
    const pendingCustomer = index.byCustomer.get(item.customerId);
    if (pendingCustomer) return pendingRow(pendingCustomer);
  }
  const entry = item.placeId ? index.places.get(item.placeId) : undefined;
  if (entry && entry.customer.customerId === item.customerId) return liveRow(entry, item, day, targets);
  const gone: "customer" | "place" = index.customerIds.has(item.customerId) ? "place" : "customer";
  const saved = day.items.find((candidate) => candidate.customerId === item.customerId && candidate.placeId === item.placeId);
  if (saved) return { ...savedRow(saved, index, targets), gone };
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
    startMinute: null,
  };
}

function reasonComplete(row: DayRow): boolean {
  return row.exceptionType !== null && (row.exceptionType !== "other" || Boolean(row.exceptionNote?.trim()));
}

type DayState = {
  day: PlanDayView;
  editing: boolean;
  rows: DayRow[];
  counts: Record<CrmListType, number>;
  offDay: number;
  needsReason: number;
  gone: number;
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
    const rows = editing
      ? (draftByDay.get(day.date) ?? []).map((item) => draftRow(item, day, index, view.rules.gradeTargets))
      : day.items.map((item) => savedRow(item, index, view.rules.gradeTargets));
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
    };
  });
}

type PlanProblem = { date: string; message: string };

/** What the server would refuse, named before the save leaves the phone (mirrors resolvePlanItems). */
function planProblems(states: ReadonlyArray<DayState>, rules: PlannerView["rules"]): PlanProblem[] {
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
          message: `${row.name} does not receive on ${CRM_WEEKDAY_NAMES[weekdayOfIsoDay(date)]}. Choose a reason, or take the customer off ${label}.`,
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

// ── The screen ──────────────────────────────────────────────────────────────────────────────────

export function PlanScreen({
  onOpenList,
  onWorkChange,
  seatId,
  test,
}: {
  /** Jump to the List tab, for a rep whose list is not ready yet. */
  onOpenList?: () => void;
  /** True while a day is open, so the shell hides its chrome and the day fills the screen. */
  onWorkChange: (working: boolean) => void;
  seatId: string;
  test: boolean;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { handleExpiredSession, token } = useSession();

  const [weekStart, setWeekStart] = useState<string | null>(null);
  const resource = useCrm<PlannerView>(planUrl(seatId, test, weekStart), "planner");
  const [screen, setScreen] = useState<PlanScreenName>({ name: "week" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<PlanNotice | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  const [busy, setBusy] = useState<PlanBusy | null>(null);

  const view = resource.data;

  useEffect(() => {
    onWorkChange(screen.name === "day");
  }, [onWorkChange, screen.name]);

  const baseItems = view && view.canEdit ? savedDraftItems(view) : null;
  const activeDraft = view && view.canEdit && draftFits(draft, view) ? draft : null;
  const items = activeDraft ? activeDraft.items : baseItems;
  const savedItems = activeDraft?.saved?.items ?? baseItems ?? [];
  const dirty = activeDraft !== null && signatureOf(activeDraft.items) !== signatureOf(savedItems);
  const index = useMemo(() => (view ? indexCustomers(view.customers) : null), [view]);
  const states = view && index ? buildDayStates(view, items, index) : [];
  const problems = view ? planProblems(states, view.rules) : [];
  const goneOnOpenDays = states.reduce((sum, state) => sum + (state.editing ? state.gone : 0), 0);
  const locked = busy !== null || resource.loading;

  const change = useCallback(
    (update: (current: PlanItemDraft[]) => PlanItemDraft[]) => {
      if (!view || !view.canEdit || locked) return;
      setDraft((previous) =>
        draftFits(previous, view)
          ? { ...previous, items: update(previous.items) }
          : { scope: scopeOf(view), basis: viewBasis(view), items: update(savedDraftItems(view)), saved: null },
      );
    },
    [locked, view],
  );

  function addItems(date: string, additions: ReadonlyArray<PlanItemDraft>) {
    change((current) => {
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

  function chooseWeek(next: string) {
    if (!view || next === view.weekStart || locked) return;
    setWeekStart(next);
    setScreen({ name: "week" });
    setDraft(null);
    setShowProblems(false);
    setNotice(null);
  }

  function refused(error: unknown, title: string) {
    if (error instanceof ApiError && error.isSessionExpired) {
      void handleExpiredSession();
      return;
    }
    const code = crmErrorCode(error);
    const reload = code !== null && PLAN_RELOAD_CODES.has(code);
    setNotice({ tone: "bad", title, message: (reload && code !== null ? RELOADED_MESSAGES[code] : undefined) ?? crmErrorMessage(error) });
    if (reload) resource.reload();
  }

  function markSaved(current: PlannerView, saved: SavedPlan, payload: PlanItemDraft[]) {
    setDraft({
      scope: scopeOf(current),
      basis: viewBasis(current),
      items: payload,
      saved: { items: payload, planId: saved.planId, version: saved.version },
    });
  }

  async function postSave(current: PlannerView, payload: PlanItemDraft[]): Promise<SavedPlan> {
    return crmPost<SavedPlan>(
      "/api/phoenix-crm/plans",
      "plan",
      { seatId, test, weekStart: current.weekStart, expectedVersion: activeDraft?.saved?.version ?? current.plan?.version ?? null, items: payload },
      token,
    );
  }

  async function save(): Promise<boolean> {
    if (!view || !view.canEdit || locked) return false;
    if (problems.length > 0) {
      setShowProblems(true);
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
      setNotice({
        tone: "good",
        title: "Plan saved",
        message: gone > 0 ? `${plural(gone, "customer", "customers")} no longer on the list ${gone === 1 ? "was" : "were"} taken off the plan.` : null,
      });
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
      await crmPost<PlanTransition>("/api/phoenix-crm/plans/submit", "plan", { planId, action: "submit", expectedVersion: version }, token);
      setNotice({ tone: "good", title: "Plan sent for review", message: reviewerSentence(view) });
      resource.reload();
    } catch (error) {
      if (savedNow) {
        setNotice({ tone: "bad", title: "The plan was saved but not sent", message: crmErrorMessage(error) });
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
      await crmPost<PlanTransition>("/api/phoenix-crm/plans/submit", "plan", { planId: plan.planId, action: "reopen", expectedVersion: plan.version }, token);
      setNotice({ tone: "info", title: "Plan taken back", message: "Change it, save it, and send it for review again." });
      resource.reload();
    } catch (error) {
      refused(error, "The plan was not taken back");
    } finally {
      setBusy(null);
    }
  }

  if (!view) {
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1 }}>
        {resource.error ? (
          <View style={{ gap: space.lg, padding: space.lg }}>
            <ErrorNotice message={resource.error} />
            <SecondaryButton label="Try again" onPress={resource.reload} />
          </View>
        ) : (
          <LoadingScreen label="Opening the weekly plan" />
        )}
      </View>
    );
  }

  if (screen.name === "day") {
    const state = states.find((entry) => entry.day.date === screen.date);
    return (
      <DayView
        bottomInset={insets.bottom}
        loadError={resource.error}
        locked={locked}
        notice={notice}
        onAdd={addItems}
        onBack={() => setScreen({ name: "week" })}
        onReason={setReason}
        onRemove={removeItem}
        problems={showProblems ? problems : []}
        state={state ?? null}
        view={view}
      />
    );
  }

  return (
    <WeekView
      bottomInset={insets.bottom}
      busy={busy}
      changeSummaryText={dirty ? changeSummary(savedItems, items ?? []) : null}
      dirty={dirty}
      goneOnOpenDays={goneOnOpenDays}
      loadError={resource.error}
      locked={locked}
      notice={notice}
      onChooseWeek={chooseWeek}
      onDiscard={discard}
      onOpenDay={(date) => setScreen({ name: "day", date })}
      onOpenList={onOpenList}
      onReopen={() => void reopen()}
      onRetry={resource.reload}
      onSave={() => void save()}
      onSend={() => void send()}
      problems={showProblems ? problems : []}
      refreshing={resource.refreshing}
      states={states}
      view={view}
    />
  );
}

// ── The week ────────────────────────────────────────────────────────────────────────────────────

function pairText(counts: Record<CrmListType, number>, day: PlanDayView): string {
  const am = `${countText(counts.AM)} AM`;
  return day.listTypes.includes("PM") ? `${am} · ${countText(counts.PM)} PM` : am;
}

function ProblemNote({ problems }: { problems: ReadonlyArray<PlanProblem> }) {
  const palette = usePalette();
  if (problems.length === 0) return null;
  return (
    <CrmNote title={problems.length === 1 ? "Fix this before saving" : `Fix these ${problems.length} before saving`} tone="bad">
      <View style={{ gap: space.xs }}>
        {problems.map((problem, position) => (
          <Text key={`${problem.date}-${position}`} style={[type.meta, { color: palette.ink }]}>
            {problem.message}
          </Text>
        ))}
      </View>
    </CrmNote>
  );
}

function WeekView({
  bottomInset,
  busy,
  changeSummaryText,
  dirty,
  goneOnOpenDays,
  loadError,
  locked,
  notice,
  onChooseWeek,
  onDiscard,
  onOpenDay,
  onOpenList,
  onReopen,
  onRetry,
  onSave,
  onSend,
  problems,
  refreshing,
  states,
  view,
}: {
  bottomInset: number;
  busy: PlanBusy | null;
  changeSummaryText: string | null;
  dirty: boolean;
  goneOnOpenDays: number;
  loadError: string | null;
  locked: boolean;
  notice: PlanNotice | null;
  onChooseWeek: (weekStart: string) => void;
  onDiscard: () => void;
  onOpenDay: (date: string) => void;
  onOpenList?: () => void;
  onReopen: () => void;
  onRetry: () => void;
  onSave: () => void;
  onSend: () => void;
  problems: ReadonlyArray<PlanProblem>;
  refreshing: boolean;
  states: ReadonlyArray<DayState>;
  view: PlannerView;
}) {
  const palette = usePalette();
  const { plan } = view;
  const status = plan?.status ?? null;
  const totals = states.reduce((sum, state) => ({ AM: sum.AM + state.counts.AM, PM: sum.PM + state.counts.PM }), { AM: 0, PM: 0 });
  const liveTotal = totals.AM + totals.PM;
  const plannedDays = states.filter((state) => state.counts.AM + state.counts.PM > 0).length;
  const offDay = states.reduce((sum, state) => sum + state.offDay, 0);
  const needsReason = states.reduce((sum, state) => sum + state.needsReason, 0);

  const facts: Array<{ label: string; value: string }> = [
    { label: "Last change", value: plan ? cairoStamp(plan.updatedAt) : "Not saved yet" },
    { label: "Reviewer", value: view.isTest ? "You (test entries)" : (view.territory.reviewerName ?? "No manager above this territory") },
  ];
  if (plan?.submittedAt) facts.push({ label: "Last sent for review", value: `${cairoStamp(plan.submittedAt)}${plan.submittedByName ? ` · ${plan.submittedByName}` : ""}` });
  if (plan?.decidedAt && (status === "approved" || status === "returned")) {
    facts.push({
      label: status === "approved" ? "Approved" : "Returned",
      value: `${cairoStamp(plan.decidedAt)}${plan.decidedByName ? ` · ${plan.decidedByName}` : ""}${plan.decidedBySfe ? " (SFE Manager)" : ""}`,
    });
  }

  return (
    <View style={{ backgroundColor: palette.paper, flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ gap: space.lg, padding: space.lg, paddingBottom: space.lg + (dirty || goneOnOpenDays > 0 ? 132 : 0) + bottomInset }}
        refreshControl={<RefreshControl onRefresh={onRetry} refreshing={refreshing} tintColor={palette.accent} />}
      >
        <View style={{ gap: space.xs }}>
          <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>{view.isTest ? "Plan · test entries" : "Plan"}</Text>
          <Text style={[type.title, { color: palette.ink }]}>{weekLabel(view.weekStart)}</Text>
          <Text style={[type.meta, { color: palette.inkSoft }]}>{territoryLine(view.territory)}</Text>
        </View>

        {notice ? (
          <CrmNote title={notice.title} tone={notice.tone}>
            {notice.message}
          </CrmNote>
        ) : null}
        {loadError ? (
          <CrmNote title="The plan on screen may be out of date" tone="bad">
            {loadError}
          </CrmNote>
        ) : null}
        <ProblemNote problems={problems} />

        <CrmSection title="Week">
          <CrmChoice
            columns={1}
            onChange={onChooseWeek}
            options={view.weeks.map((week) => ({
              value: week.weekStart,
              label: weekLabel(week.weekStart),
              note: week.weekStart === view.weekStart ? `On screen · ${week.statusLabel}` : week.statusLabel,
              disabled: locked && week.weekStart !== view.weekStart,
            }))}
            value={view.weekStart}
          />
        </CrmSection>

        {view.blockedReason ? <CrmNote tone="warn">{view.blockedReason}</CrmNote> : null}

        {view.pendingCount > 0 ? (
          <CrmNote tone="info" title={`${countText(view.pendingCount)} not validated yet`}>
            <View style={{ gap: space.sm }}>
              <Text style={[type.body, { color: palette.ink }]}>
                They are on your list and can be planned now; validate each at the door and its visits start counting.
              </Text>
              {view.viewerIsRep && onOpenList ? <SecondaryButton label="Open the list" onPress={onOpenList} /> : null}
            </View>
          </CrmNote>
        ) : null}

        <CrmSection title="Status">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
            <CrmPill tone={STATUS_TONE[status ?? "none"] ?? "neutral"}>{plan?.statusLabel ?? planStatusLabel(null)}</CrmPill>
            {dirty ? <CrmPill tone="warn">Unsaved changes</CrmPill> : null}
          </View>
          <FactList facts={facts} />
          {plan?.decisionNote && (status === "returned" || status === "approved") ? (
            <CrmNote title={status === "returned" ? "What to change" : "Manager's note"} tone={status === "returned" ? "warn" : "good"}>
              {plan.decisionNote}
            </CrmNote>
          ) : null}
        </CrmSection>

        <CrmSection title="This week">
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <StatTile label="PM placed" value={countText(totals.PM)} />
            <StatTile label="AM placed" value={countText(totals.AM)} />
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
            <StatTile label="Days planned" value={`${plannedDays} of ${states.length}`} />
            <StatTile label={needsReason > 0 ? "On a day off · no reason" : "On a day off"} tone={needsReason > 0 ? "accent" : "default"} value={countText(offDay)} />
          </View>
        </CrmSection>

        <CrmSection title="Days">
          {view.canEdit && view.customers.length === 0 ? (
            <CrmNote tone="info">
              <View style={{ gap: space.sm }}>
                <Text style={[type.body, { color: palette.ink }]}>No validated customers yet. Customers validated on the List tab can be placed here.</Text>
                {onOpenList ? <SecondaryButton label="Open the list" onPress={onOpenList} /> : null}
              </View>
            </CrmNote>
          ) : null}
          <View style={{ gap: space.sm }}>
            {states.map((state) => (
              <DayCard key={state.day.date} onOpen={() => onOpenDay(state.day.date)} rules={view.rules} state={state} today={view.cairoToday} />
            ))}
          </View>
        </CrmSection>

        {view.canEdit ? (
          <CrmSection title="Send for review">
            <Text style={[type.body, { color: palette.inkSoft }]}>
              {status === "returned" ? "Change what the manager asked for, then send the plan again." : `When the week is ready, send it. ${reviewerSentence(view)}`}
            </Text>
            <PrimaryButton
              busy={busy === "send"}
              disabled={locked || liveTotal === 0}
              label={status === "returned" ? "Send the plan again" : "Send for review"}
              onPress={onSend}
            />
            {liveTotal === 0 ? <Text style={[type.meta, { color: palette.inkSoft }]}>Place at least one customer before sending the plan.</Text> : null}
          </CrmSection>
        ) : null}

        {view.canReopen && plan ? (
          <CrmSection title={status === "approved" ? "Approved plan" : "Waiting for review"}>
            <Text style={[type.body, { color: palette.inkSoft }]}>
              {status === "approved" ? "The plan is approved." : `The plan is waiting for review. ${reviewerSentence(view)}`} To change it, take it back first.
            </Text>
            <SecondaryButton label="Take the plan back to change it" onPress={onReopen} />
          </CrmSection>
        ) : null}
      </ScrollView>

      {dirty || goneOnOpenDays > 0 ? (
        <SaveBar
          busy={busy === "save"}
          changes={changeSummaryText}
          dirty={dirty}
          gone={goneOnOpenDays}
          locked={locked}
          onDiscard={onDiscard}
          onSave={onSave}
          paddingBottom={bottomInset}
        />
      ) : null}
    </View>
  );
}

function FactList({ facts }: { facts: ReadonlyArray<{ label: string; value: string }> }) {
  const palette = usePalette();
  return (
    <View style={{ borderColor: palette.line, borderWidth: hairline }}>
      {facts.map((fact, position) => (
        <View
          key={fact.label}
          style={{ borderTopColor: palette.line, borderTopWidth: position === 0 ? 0 : hairline, gap: 2, padding: space.md }}
        >
          <Text style={[type.micro, { color: palette.inkSoft, textTransform: "uppercase" }]}>{fact.label}</Text>
          <Text style={[type.bodyStrong, { color: palette.ink }]}>{fact.value}</Text>
        </View>
      ))}
    </View>
  );
}

function DayCard({ onOpen, rules, state, today }: { onOpen: () => void; rules: PlannerView["rules"]; state: DayState; today: string }) {
  const palette = usePalette();
  const { day } = state;
  const live = state.rows.filter((row) => row.gone === null);
  const morning = !day.listTypes.includes("PM");
  const over = state.counts.PM > rules.pmDailyCap || state.counts.AM > rules.amDailyCap;
  const names = live.slice(0, 3).map((row) => row.name);
  const more = live.length - names.length;
  const accent = over || state.needsReason > 0 ? palette.danger : state.gone > 0 || state.offDay > 0 ? palette.accent : live.length > 0 ? palette.accentLine : palette.line;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={{ backgroundColor: palette.surface, borderColor: palette.line, borderLeftColor: accent, borderLeftWidth: 3, borderWidth: hairline, gap: space.xs, padding: space.md }}
    >
      <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: space.sm, justifyContent: "space-between" }}>
        <Text style={[type.bodyStrong, { color: palette.ink }]}>{dayLabel(day.date)}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          {day.date === today ? <CrmPill tone="info">Today</CrmPill> : null}
          {!day.editable ? <CrmPill>Passed</CrmPill> : null}
          {day.ramadan ? <CrmPill tone="warn">Ramadan</CrmPill> : null}
          {morning ? <CrmPill>Morning · AM only</CrmPill> : null}
        </View>
      </View>
      <Text style={[type.bodyStrong, { color: palette.ink2 }]}>{pairText(state.counts, day)}</Text>
      <Text style={[type.meta, { color: palette.inkSoft }]}>{live.length === 0 ? "Nothing planned" : `${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}`}</Text>
      {over || state.needsReason > 0 || state.offDay > 0 || state.gone > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
          {over ? <CrmPill tone="bad">Over the day&apos;s limit</CrmPill> : null}
          {state.needsReason > 0 ? <CrmPill tone="bad">{`${countText(state.needsReason)} without a reason`}</CrmPill> : null}
          {state.offDay > 0 ? <CrmPill tone="warn">{`${countText(state.offDay)} on a day off`}</CrmPill> : null}
          {state.gone > 0 ? <CrmPill tone="warn">{`${countText(state.gone)} no longer on the list`}</CrmPill> : null}
        </View>
      ) : null}
    </Pressable>
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
  paddingBottom,
}: {
  busy: boolean;
  changes: string | null;
  dirty: boolean;
  gone: number;
  locked: boolean;
  onDiscard: () => void;
  onSave: () => void;
  paddingBottom: number;
}) {
  const palette = usePalette();
  const goneText = gone > 0 ? `${plural(gone, "planned customer", "planned customers")} no longer on the list ${gone === 1 ? "comes" : "come"} off when you save.` : null;
  return (
    <View
      style={{
        backgroundColor: palette.surface,
        borderTopColor: palette.accentLine,
        borderTopWidth: hairline,
        bottom: 0,
        gap: space.sm,
        left: 0,
        paddingBottom: space.md + paddingBottom,
        paddingHorizontal: space.lg,
        paddingTop: space.md,
        position: "absolute",
        right: 0,
      }}
    >
      <View style={{ gap: 2 }}>
        <Text style={[type.bodyStrong, { color: palette.ink }]}>{dirty ? "Unsaved changes" : "The plan needs saving"}</Text>
        {changes ? <Text style={[type.meta, { color: palette.inkSoft }]}>{changes}</Text> : null}
        {goneText ? <Text style={[type.meta, { color: palette.inkSoft }]}>{goneText}</Text> : null}
      </View>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {dirty ? (
          <View style={{ flex: 1 }}>
            <SecondaryButton label="Discard changes" onPress={onDiscard} />
          </View>
        ) : null}
        <View style={{ flex: 1 }}>
          <PrimaryButton busy={busy} disabled={locked} label="Save the plan" onPress={onSave} />
        </View>
      </View>
    </View>
  );
}

// ── One day ─────────────────────────────────────────────────────────────────────────────────────

function DayView({
  bottomInset,
  loadError,
  locked,
  notice,
  onAdd,
  onBack,
  onReason,
  onRemove,
  problems,
  state,
  view,
}: {
  bottomInset: number;
  loadError: string | null;
  locked: boolean;
  notice: PlanNotice | null;
  onAdd: (date: string, items: ReadonlyArray<PlanItemDraft>) => void;
  onBack: () => void;
  onReason: (date: string, customerId: string, exceptionType: PlanExceptionType | null, exceptionNote: string | null) => void;
  onRemove: (date: string, customerId: string) => void;
  problems: ReadonlyArray<PlanProblem>;
  state: DayState | null;
  view: PlannerView;
}) {
  const palette = usePalette();
  const insets = useSafeAreaInsets();

  if (!state) {
    return (
      <View style={{ backgroundColor: palette.paper, flex: 1, gap: space.lg, padding: space.lg, paddingTop: insets.top + space.lg }}>
        <CrmBackBar backLabel="Week" onBack={onBack} title="Day" />
        <CrmNote title="This day is not in the week on screen" tone="info">
          Go back to the week and open one of its days.
        </CrmNote>
      </View>
    );
  }

  const { day } = state;
  const { rules } = view;
  const weekdayName = CRM_WEEKDAY_NAMES[weekdayOfIsoDay(day.date)];
  const morning = !day.listTypes.includes("PM");
  const dayProblems = problems.filter((problem) => problem.date === day.date);

  return (
    <View style={{ backgroundColor: palette.paper, flex: 1, paddingTop: insets.top }}>
      <ScrollView contentContainerStyle={{ gap: space.lg, padding: space.lg, paddingBottom: space.lg + bottomInset }}>
        <CrmBackBar backLabel="Week" onBack={onBack} title={dayLabelLong(day.date)} />

        {notice ? (
          <CrmNote title={notice.title} tone={notice.tone}>
            {notice.message}
          </CrmNote>
        ) : null}
        {loadError ? (
          <CrmNote title="The plan on screen may be out of date" tone="bad">
            {loadError}
          </CrmNote>
        ) : null}
        <ProblemNote problems={dayProblems} />

        <Text style={[type.meta, { color: palette.inkSoft }]}>{territoryLine(view.territory)}</Text>

        {!day.editable ? <CrmNote>This day has passed. It shows what was planned.</CrmNote> : null}
        {morning ? <CrmNote>Thursday is a morning: it holds AM only.</CrmNote> : null}
        {day.ramadan ? <CrmNote tone="info">A Ramadan day: each customer&apos;s Ramadan hours are used.</CrmNote> : null}

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
          <StatTile label="AM · the day's limit" tone={state.counts.AM > rules.amDailyCap ? "accent" : "default"} value={`${countText(state.counts.AM)} of ${countText(rules.amDailyCap)}`} />
          {morning ? null : (
            <StatTile label="PM · the day's limit" tone={state.counts.PM > rules.pmDailyCap ? "accent" : "default"} value={`${countText(state.counts.PM)} of ${countText(rules.pmDailyCap)}`} />
          )}
          <StatTile label={state.needsReason > 0 ? "On a day off · no reason" : "On a day off"} tone={state.needsReason > 0 ? "accent" : "default"} value={countText(state.offDay)} />
        </View>

        <CrmSection title={`On this day · ${pairText(state.counts, day)}`}>
          {state.rows.length === 0 ? (
            <Text style={[type.body, { color: palette.inkSoft }]}>{state.editing ? "Nobody is placed on this day yet. Add customers below." : "Nothing was planned on this day."}</Text>
          ) : (
            <View style={{ gap: space.sm }}>
              {state.rows.map((row) => (
                <PlannedRow
                  editing={state.editing}
                  key={row.customerId}
                  locked={locked}
                  onReason={(exceptionType, exceptionNote) => onReason(day.date, row.customerId, exceptionType, exceptionNote)}
                  onRemove={() => onRemove(day.date, row.customerId)}
                  row={row}
                  weekdayName={weekdayName}
                />
              ))}
            </View>
          )}
        </CrmSection>

        {state.editing ? <AddCustomers counts={state.counts} day={day} locked={locked} onAdd={(items) => onAdd(day.date, items)} rows={state.rows} view={view} /> : null}
      </ScrollView>
    </View>
  );
}

function PlannedRow({
  editing,
  locked,
  onReason,
  onRemove,
  row,
  weekdayName,
}: {
  editing: boolean;
  locked: boolean;
  onReason: (exceptionType: PlanExceptionType | null, exceptionNote: string | null) => void;
  onRemove: () => void;
  row: DayRow;
  weekdayName: string;
}) {
  const palette = usePalette();
  const accent = row.gone !== null ? palette.danger : !row.receives ? palette.accent : palette.line;
  const details = [row.where, row.visits].filter((part): part is string => Boolean(part));

  return (
    <View style={{ backgroundColor: palette.surface, borderColor: palette.line, borderLeftColor: accent, borderLeftWidth: 3, borderWidth: hairline, gap: space.sm, padding: space.md }}>
      <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "space-between" }}>
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <Text style={[type.bodyStrong, { color: palette.ink }]}>{row.name}</Text>
          {row.meta ? <Text style={[type.meta, { color: palette.inkSoft }]}>{row.meta}</Text> : null}
          {row.hours ? <Text style={[type.bodyStrong, { color: palette.ink2 }]}>{row.hours}</Text> : null}
          {details.length > 0 ? <Text style={[type.meta, { color: palette.inkSoft }]}>{details.join(" · ")}</Text> : null}
        </View>
        {editing ? (
          <Pressable accessibilityRole="button" disabled={locked} hitSlop={8} onPress={onRemove} style={{ alignSelf: "flex-start", opacity: locked ? 0.5 : 1 }}>
            <Text style={[type.bodyStrong, { color: palette.danger }]}>Take off</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
        {row.gone === "customer" ? <CrmPill tone="bad">Left the list</CrmPill> : null}
        {row.gone === "place" ? <CrmPill tone="bad">Place removed</CrmPill> : null}
        {row.gone === null && row.pending ? <CrmPill tone="warn">{PENDING_PILL}</CrmPill> : null}
        {row.gone === null && row.standing ? <CrmPill tone={row.standing.tone}>{row.standing.label}</CrmPill> : null}
        {row.gone === null && !row.receives && row.exceptionType ? <CrmPill tone="warn">{exceptionLabel(row.exceptionType) ?? "Reason given"}</CrmPill> : null}
        {row.gone === null && !row.receives && !row.exceptionType ? <CrmPill tone={editing ? "bad" : "warn"}>No reason given</CrmPill> : null}
        {row.noRamadanTime ? <CrmPill tone="warn">No Ramadan hours</CrmPill> : null}
      </View>

      {row.gone !== null ? (
        <CrmNote tone="bad">
          {(row.gone === "customer" ? "This customer has left the list." : "This place was removed from the customer.") + (editing ? " It comes off the plan when you save." : "")}
        </CrmNote>
      ) : null}

      {row.gone === null && !row.receives ? (
        editing ? (
          <View style={{ borderTopColor: palette.line, borderTopWidth: hairline, gap: space.sm, paddingTop: space.md }}>
            <MicroLabel>{`Why on ${weekdayName}?`}</MicroLabel>
            <CrmChoice
              columns={2}
              disabled={locked}
              onChange={(exceptionType) => onReason(exceptionType, row.exceptionNote)}
              options={EXCEPTION_OPTIONS}
              value={row.exceptionType}
            />
            <NoteInput
              hint={row.exceptionType === "other" ? "Needed for Other." : "Optional."}
              label="Note"
              onChangeText={(text) => onReason(row.exceptionType, text)}
              value={row.exceptionNote ?? ""}
            />
          </View>
        ) : row.exceptionNote ? (
          <Text style={[type.body, { color: palette.ink }]}>
            <Text style={[type.bodyStrong, { color: palette.ink2 }]}>Rep&apos;s note: </Text>
            {row.exceptionNote}
          </Text>
        ) : null
      ) : null}
    </View>
  );
}

function NoteInput({ hint, label, onChangeText, value }: { hint: string; label: string; onChangeText: (text: string) => void; value: string }) {
  const palette = usePalette();
  return (
    <View style={{ gap: space.xs }}>
      <MicroLabel>{label}</MicroLabel>
      <TextInput
        maxLength={PLAN_NOTE_MAX}
        multiline
        onChangeText={onChangeText}
        placeholderTextColor={palette.inkFaint}
        style={[
          type.body,
          { backgroundColor: palette.surface, borderColor: palette.line, borderRadius: radius, borderWidth: hairline, color: palette.ink, minHeight: 64, padding: space.md, textAlignVertical: "top" },
        ]}
        value={value}
      />
      <Text style={[type.meta, { color: palette.inkSoft }]}>{hint}</Text>
    </View>
  );
}

// ── Adding customers to a day ──────────────────────────────────────────────────────────────────────

type Suggestion = {
  customerId: string;
  placeId: string | null;
  pending: boolean;
  name: string;
  listType: CrmListType;
  grade: CrmGrade | null;
  speciality: string | null;
  placeLabel: string | null;
  zone: string | null;
  brick: string | null;
  visitsThisMonth: number;
  target: number | null;
  receives: boolean;
  windows: string;
  noRamadanTime: boolean;
  tier: number;
};

/** One place per customer, as many as the day's limits still take, in the order shown. */
function pickWithinCaps(suggestions: ReadonlyArray<Suggestion>, remaining: Record<CrmListType, number>): Suggestion[] {
  const left = { ...remaining };
  const seen = new Set<string>();
  const picked: Suggestion[] = [];
  for (const suggestion of suggestions) {
    if (seen.has(suggestion.customerId)) continue;
    seen.add(suggestion.customerId);
    if (left[suggestion.listType] <= 0) continue;
    left[suggestion.listType] -= 1;
    picked.push(suggestion);
  }
  return picked;
}

function distinctCustomers(suggestions: ReadonlyArray<Suggestion>): number {
  return new Set(suggestions.map((suggestion) => suggestion.customerId)).size;
}

function AddCustomers({
  counts,
  day,
  locked,
  onAdd,
  rows,
  view,
}: {
  counts: Record<CrmListType, number>;
  day: PlanDayView;
  locked: boolean;
  onAdd: (items: ReadonlyArray<PlanItemDraft>) => void;
  rows: ReadonlyArray<DayRow>;
  view: PlannerView;
}) {
  const palette = usePalette();
  const [typeFilter, setTypeFilter] = useState<"all" | CrmListType>("all");
  const [query, setQuery] = useState("");
  const [showOff, setShowOff] = useState(false);
  const [limit, setLimit] = useState(SUGGESTION_PAGE);
  const [offLimit, setOffLimit] = useState(SUGGESTION_PAGE);

  const weekday = weekdayOfIsoDay(day.date);
  const weekdayName = CRM_WEEKDAY_NAMES[weekday];
  const dayName = dayLabel(day.date);
  const morning = !day.listTypes.includes("PM");
  const placedIds = new Set(rows.filter((row) => row.gone === null).map((row) => row.customerId));

  const all = useMemo(() => {
    const list: Suggestion[] = [];
    for (const customer of view.customers) {
      if (!day.listTypes.includes(customer.listType)) continue;
      if (placedIds.has(customer.customerId)) continue;
      const target = gradeTarget(view.rules.gradeTargets, customer.listType, customer.grade);
      const tier = customer.pending ? 0 : coverageTier(customer.visitsThisMonth, target);
      if (customer.pending) {
        list.push({
          customerId: customer.customerId,
          placeId: null,
          pending: true,
          name: customer.name,
          listType: customer.listType,
          grade: customer.grade,
          speciality: customer.speciality,
          placeLabel: null,
          zone: null,
          brick: null,
          visitsThisMonth: customer.visitsThisMonth,
          target,
          receives: true,
          windows: "No days and hours yet",
          noRamadanTime: false,
          tier,
        });
        continue;
      }
      for (const place of customer.places) {
        const { windows, noRamadanTime } = windowsForWeekday(place.timings, weekday, day.ramadan);
        const receives = windows.length > 0;
        list.push({
          customerId: customer.customerId,
          placeId: place.placeId,
          pending: false,
          name: customer.name,
          listType: customer.listType,
          grade: customer.grade,
          speciality: customer.speciality,
          placeLabel: place.label,
          zone: place.zone,
          brick: place.brick,
          visitsThisMonth: customer.visitsThisMonth,
          target,
          receives,
          windows: receives ? windows.map((window) => formatTimingWindow(window)).join(", ") : `Does not receive on ${weekdayName}`,
          noRamadanTime: receives && noRamadanTime,
          tier,
        });
      }
    }
    // Receiving first, then those not visited this month, then behind their grade, then by name.
    return list.sort(
      (left, right) =>
        Number(right.receives) - Number(left.receives) || left.tier - right.tier || left.name.localeCompare(right.name),
    );
  }, [day.date, day.listTypes, day.ramadan, placedIds, view.customers, view.rules.gradeTargets, weekday, weekdayName]);

  const remaining: Record<CrmListType, number> = { AM: Math.max(0, view.rules.amDailyCap - counts.AM), PM: Math.max(0, view.rules.pmDailyCap - counts.PM) };

  const needle = query.trim().toLowerCase();
  const shown = all.filter(
    (suggestion) =>
      (typeFilter === "all" || suggestion.listType === typeFilter) &&
      (!needle || [suggestion.name, suggestion.speciality, suggestion.placeLabel, suggestion.zone, suggestion.brick].some((part) => part !== null && part.toLowerCase().includes(needle))),
  );
  const receiving = shown.filter((suggestion) => suggestion.receives);
  const notReceiving = shown.filter((suggestion) => !suggestion.receives);
  const filtered = needle !== "" || typeFilter !== "all";
  const bulk = pickWithinCaps(receiving, remaining);
  const receivingCustomers = distinctCustomers(receiving);

  function reset() {
    setLimit(SUGGESTION_PAGE);
    setOffLimit(SUGGESTION_PAGE);
  }

  function addOne(suggestion: Suggestion, exceptionType: PlanExceptionType | null, exceptionNote: string | null) {
    onAdd([{ planDate: day.date, customerId: suggestion.customerId, placeId: suggestion.placeId, exceptionType, exceptionNote }]);
  }

  function addBulk() {
    onAdd(bulk.map((suggestion) => ({ planDate: day.date, customerId: suggestion.customerId, placeId: suggestion.placeId, exceptionType: null, exceptionNote: null })));
  }

  const typeOptions: ReadonlyArray<CrmChoiceOption<"all" | CrmListType>> = [
    { value: "all", label: "Everyone" },
    { value: "PM", label: "PM" },
    { value: "AM", label: "AM" },
  ];

  return (
    <CrmSection title="Add customers">
      <Text style={[type.body, { color: palette.inkSoft }]}>
        {morning ? `Room for ${countText(remaining.AM)} more AM on this morning.` : `Room for ${countText(remaining.AM)} more AM and ${countText(remaining.PM)} more PM.`} Customers who receive on {weekdayName} come first.
      </Text>

      {all.length === 0 ? (
        <Text style={[type.body, { color: palette.inkSoft }]}>
          {view.customers.length === 0 ? "Customers on your List tab show here." : "Every customer who can go on this day is already on it."}
        </Text>
      ) : (
        <>
          {morning ? null : (
            <CrmChoice
              columns={3}
              onChange={(next) => {
                setTypeFilter(next);
                reset();
              }}
              options={typeOptions}
              value={typeFilter}
            />
          )}
          <CrmSearch
            autoCorrect={false}
            onChangeText={(text) => {
              setQuery(text);
              reset();
            }}
            placeholder="Name, speciality, place, zone or brick"
            value={query}
          />

          {filtered && receivingCustomers > 0 ? (
            <PrimaryButton
              disabled={locked || bulk.length === 0}
              label={
                bulk.length === 0
                  ? "No room left for them on this day"
                  : bulk.length === receivingCustomers
                    ? `Add all ${countText(receivingCustomers)} found`
                    : `Add ${countText(bulk.length)} of the ${countText(receivingCustomers)} found`
              }
              onPress={addBulk}
            />
          ) : null}

          {receiving.length === 0 && notReceiving.length === 0 ? (
            <Text style={[type.body, { color: palette.inkSoft }]}>No customer matches. Clear the search or the filter.</Text>
          ) : (
            <>
              {receiving.length === 0 ? (
                <Text style={[type.body, { color: palette.inkSoft }]}>Nobody found receives on {weekdayName}.</Text>
              ) : (
                <View style={{ gap: space.sm }}>
                  {receiving.slice(0, limit).map((suggestion) => (
                    <SuggestionRow
                      dayName={dayName}
                      full={remaining[suggestion.listType] <= 0}
                      key={`${suggestion.customerId}|${suggestion.placeId ?? "pending"}`}
                      locked={locked}
                      onAdd={(exceptionType, exceptionNote) => addOne(suggestion, exceptionType, exceptionNote)}
                      suggestion={suggestion}
                      weekdayName={weekdayName}
                    />
                  ))}
                  {receiving.length > limit ? (
                    <SecondaryButton label={`Show ${countText(Math.min(SUGGESTION_PAGE, receiving.length - limit))} more`} onPress={() => setLimit((current) => current + SUGGESTION_PAGE)} />
                  ) : null}
                </View>
              )}

              {notReceiving.length > 0 ? (
                showOff ? (
                  <View style={{ gap: space.sm }}>
                    <MicroLabel>{`Do not receive on ${weekdayName}`}</MicroLabel>
                    {notReceiving.slice(0, offLimit).map((suggestion) => (
                      <SuggestionRow
                        dayName={dayName}
                        full={remaining[suggestion.listType] <= 0}
                        key={`${suggestion.customerId}|${suggestion.placeId ?? "pending"}`}
                        locked={locked}
                        onAdd={(exceptionType, exceptionNote) => addOne(suggestion, exceptionType, exceptionNote)}
                        suggestion={suggestion}
                        weekdayName={weekdayName}
                      />
                    ))}
                    {notReceiving.length > offLimit ? (
                      <SecondaryButton label={`Show ${countText(Math.min(SUGGESTION_PAGE, notReceiving.length - offLimit))} more`} onPress={() => setOffLimit((current) => current + SUGGESTION_PAGE)} />
                    ) : null}
                    <SecondaryButton label="Hide them" onPress={() => setShowOff(false)} />
                  </View>
                ) : (
                  <SecondaryButton label={`Show ${countText(distinctCustomers(notReceiving))} who do not receive on ${weekdayName}`} onPress={() => setShowOff(true)} />
                )
              ) : null}
            </>
          )}
        </>
      )}
    </CrmSection>
  );
}

function SuggestionRow({
  dayName,
  full,
  locked,
  onAdd,
  suggestion,
  weekdayName,
}: {
  dayName: string;
  full: boolean;
  locked: boolean;
  onAdd: (exceptionType: PlanExceptionType | null, exceptionNote: string | null) => void;
  suggestion: Suggestion;
  weekdayName: string;
}) {
  const palette = usePalette();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<PlanExceptionType | null>(null);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const standing = suggestion.pending ? null : monthStanding(suggestion.visitsThisMonth, suggestion.target);
  const where = suggestion.pending
    ? pendingVisitsText(suggestion.visitsThisMonth)
    : `${placeLine({ label: suggestion.placeLabel, zone: suggestion.zone, brick: suggestion.brick }, null)} · ${monthVisitsText(suggestion.visitsThisMonth, suggestion.target)}`;

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
    <View style={{ backgroundColor: palette.surface, borderColor: palette.line, borderWidth: hairline, gap: space.sm, padding: space.md }}>
      <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "space-between" }}>
        <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
          <Text style={[type.bodyStrong, { color: palette.ink }]}>{suggestion.name}</Text>
          <Text style={[type.meta, { color: palette.inkSoft }]}>{customerMetaText(suggestion)}</Text>
          <Text style={[type.bodyStrong, { color: palette.ink2 }]}>{suggestion.windows}</Text>
          <Text style={[type.meta, { color: palette.inkSoft }]}>{where}</Text>
        </View>
        {asking ? null : (
          <Pressable accessibilityRole="button" disabled={locked || full} hitSlop={8} onPress={add} style={{ alignSelf: "flex-start", opacity: locked || full ? 0.5 : 1 }}>
            <Text style={[type.bodyStrong, { color: suggestion.receives ? palette.accent : palette.ink2 }]}>{full ? "Day full" : "Add"}</Text>
          </Pressable>
        )}
      </View>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>
        {standing ? <CrmPill tone={standing.tone}>{standing.label}</CrmPill> : <CrmPill tone="warn">{PENDING_PILL}</CrmPill>}
        {suggestion.noRamadanTime ? <CrmPill tone="warn">No Ramadan hours</CrmPill> : null}
      </View>

      {asking ? (
        <View style={{ borderTopColor: palette.line, borderTopWidth: hairline, gap: space.sm, paddingTop: space.md }}>
          <Text style={[type.bodyStrong, { color: palette.ink2 }]}>
            {suggestion.name} does not receive on {weekdayName}. Why does the visit go on {dayName}?
          </Text>
          <CrmChoice
            columns={2}
            onChange={(next) => {
              setReason(next);
              setProblem(null);
            }}
            options={EXCEPTION_OPTIONS}
            value={reason}
          />
          <NoteInput
            hint={reason === "other" ? "Needed for Other." : "Optional."}
            label="Note"
            onChangeText={(text) => {
              setNote(text);
              setProblem(null);
            }}
            value={note}
          />
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <PrimaryButton disabled={locked || full} label={`Add to ${dayName}`} onPress={addWithReason} />
            </View>
            <View style={{ flex: 1 }}>
              <SecondaryButton
                label="Cancel"
                onPress={() => {
                  setAsking(false);
                  setProblem(null);
                }}
              />
            </View>
          </View>
          {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
        </View>
      ) : null}
    </View>
  );
}
