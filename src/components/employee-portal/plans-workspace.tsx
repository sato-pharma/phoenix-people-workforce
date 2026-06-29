"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { createPortal } from "react-dom";
import { SearchableSelect } from "@/components/ui/searchable-select";


// Client-only flag without setState-in-effect: false on the server/during
// hydration, true on the client. Used to gate document.body portals.
const emptySubscribe = () => () => {};
import {
  BadgeCheck,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Download,
  FileText,
  Plus,
  RotateCcw,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { sameLineBookingWarning, type SameLinePlanBooking } from "@/lib/weekly-planning/calendar";
import type { EmployeePlanKind, EmployeePlanStatus, PlanSlot, PlanWorkweek } from "@/lib/weekly-planning/plan-v1";
import {
  buildEmployeePlanPeriod,
  employeePlanActivityTypes,
  HEAD_OFFICE_WORKWEEK,
  planRequiredSlotsByDate,
} from "@/lib/weekly-planning/plan-v1";
import type {
  EmployeePlan,
  EmployeePlanItemInput,
  EmployeePlansWorkspace,
  PlanPrefillItem,
  PlanPrefillSource,
  VisitDetailInput,
} from "@/lib/weekly-planning/service";

type PlansWorkspaceProps = {
  access: AccessContext;
  basePath?: "/admin/weekly-plans" | "/employee-portals/plans" | "/workspace/plans";
  initialWorkspace: EmployeePlansWorkspace;
  selectedPlanId?: string | null;
};

type DraftItem = EmployeePlanItemInput & {
  key: string;
  // Explicit half-day slot. This is the source of truth for AM/PM (NOT derived
  // from start/end times) — deriving it from times caused rows to reclassify and
  // re-sort mid-keystroke, stealing input focus. Times are only synthesised at
  // save time for storage. "Office full day" is the sole entry where a clock
  // concept matters and even there it stays implicit.
  slot: PlanSlot;
  // Client-only disambiguation axis: only meaningful for org-wide roles (e.g.
  // Training Manager) whose medicalRepOptions span more than one line. Never
  // sent to the server - the resolved doubleVisitMedicalRepHrId carries the
  // outcome instead.
  lineFilter?: string | null;
  returnNotes?: EmployeePlan["items"][number]["returnNotes"];
  // Cross-domain provenance. Locked rows (approved vacation/excuse) are
  // read-only; sourced weekly rows (monthly sync) are editable but badged.
  locked?: boolean;
  source?: PlanPrefillSource;
  sourceLabel?: string;
};

type MedicalRepOption = EmployeePlansWorkspace["medicalRepOptions"][number];
type DayMode = "full" | "split";
type PlanningActivityValue = EmployeePlanItemInput["activityType"] | "Coaching";

type DayGroup = {
  activityDate: string;
  dayNote: string;
  mode: DayMode;
  rows: DraftItem[];
};

const AM_START = "09:00";
const AM_END = "13:00";
const PM_START = "13:00";
const PM_END = "17:00";

const approvedPlanningRegions = [
  "ALEX-BHR",
  "Cairo",
  "Delta 1",
  "Delta 2",
  "Giza",
  "Upper Egypt",
] as const;

const noGeographyActivities = new Set<EmployeePlanItemInput["activityType"]>([
  "Office",
  "Admin",
  "Remote",
  "Vacation",
  "National Vacation",
  "Excuse",
]);

const dayModeOptions = [
  { label: "Full day", value: "full" },
  { label: "AM / PM split", value: "split" },
] as const;

const trainingFormatOptions = ["Zoom", "Physical", "Other"] as const;

const statusLabels: Record<EmployeePlanStatus, string> = {
  cancelled: "Cancelled",
  ceo_approved: "CEO approved",
  ceo_rejected: "CEO rejected",
  ceo_returned: "CEO returned",
  details_requested: "Details Required",
  draft: "Draft",
  final_approved: "Final approved",
  hr_acknowledged: "HR acknowledged",
  manager_approved: "Manager approved",
  manager_rejected: "Manager rejected",
  manager_returned: "Manager returned",
  submitted: "Submitted",
};

// Premium field controls (square corners, slate-300 border, orange focus ring) -
// matched to the Report It module's design language.
const cin = "h-8 w-full border border-slate-300 bg-white px-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 transition-colors duration-150 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed";
const tableSelectClass = "h-10 w-full min-w-0 cursor-pointer rounded-sm border border-slate-200 bg-slate-50 px-3 text-sm font-semibold text-slate-800 shadow-inner transition-colors duration-150 hover:bg-white focus:border-orange-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400";
const tableInputClass = "h-10 w-full min-w-0 rounded-sm border border-orange-200 bg-orange-50/50 px-3 text-sm font-semibold text-slate-800 placeholder:text-orange-400 shadow-inner transition-colors duration-150 focus:border-orange-500 focus:bg-orange-50 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:opacity-60";
// Taller field controls for the touch-friendly mobile bottom-sheet editor.
const mobileField = "h-11 w-full border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 transition-colors duration-150 disabled:bg-slate-50 disabled:text-slate-400 disabled:cursor-not-allowed";

function normalizeTime(value: string | null | undefined) {
  return String(value ?? "").slice(0, 5);
}

// Derive the explicit slot from stored times (only used once, on load).
function slotFromTimes(start: string | null | undefined, end: string | null | undefined): PlanSlot {
  const s = normalizeTime(start);
  const e = normalizeTime(end);
  if (s === AM_START && e === AM_END) return "am";
  if (s === PM_START && e === PM_END) return "pm";
  return "full";
}

// Synthesise storage times from the explicit slot (only used at save time).
function timesForSlot(slot: PlanSlot): { startTime: string; endTime: string } {
  if (slot === "am") return { startTime: AM_START, endTime: AM_END };
  if (slot === "pm") return { startTime: PM_START, endTime: PM_END };
  return { startTime: "", endTime: "" };
}

function slotSortValue(row: Pick<DraftItem, "slot">) {
  if (row.slot === "pm") return 1;
  return 0; // am + full sort first
}

function slotLabel(row: Pick<DraftItem, "slot">) {
  if (row.slot === "am") return "AM";
  if (row.slot === "pm") return "PM";
  return "Full day";
}

function isCoachingActivity(value: string | null | undefined, activityTitle?: string | null) {
  return value === "Coaching" || (value === "Other" && String(activityTitle ?? "").trim().toLowerCase() === "coaching");
}

function activityLabel(value: PlanningActivityValue) {
  if (value === "Coaching") return "Coaching";
  return value === "Field" ? "Single Visit" : value;
}

const planningActivityOptions: Array<{ label: string; value: PlanningActivityValue }> = [
  // "Excuse" is auto-filled (locked) from approved excuse requests only — never
  // manually selectable. "National Vacation" stays a manual choice.
  ...employeePlanActivityTypes
    .filter((type) => type !== "Excuse")
    .map((type) => ({ label: activityLabel(type), value: type })),
  { label: "Coaching", value: "Coaching" },
];

function activitySelectValue(row: Pick<DraftItem, "activityTitle" | "activityType">): PlanningActivityValue {
  return isCoachingActivity(row.activityType, row.activityTitle) ? "Coaching" : row.activityType;
}

function activityValue(value: string): { activityTitle: string; activityType: EmployeePlanItemInput["activityType"] } {
  if (value === "Single Visit") return { activityTitle: "Single Visit", activityType: "Field" };
  if (value === "Coaching") return { activityTitle: "Coaching", activityType: "Other" };
  const activityType = (employeePlanActivityTypes as readonly string[]).includes(value)
    ? (value as EmployeePlanItemInput["activityType"])
    : "Other";
  return { activityTitle: activityLabel(activityType), activityType };
}

function trainingFormatValue(value: string | null | undefined) {
  const current = String(value ?? "").trim();
  return (trainingFormatOptions as readonly string[]).includes(current) ? current : "";
}

function activityRule(value: EmployeePlanItemInput["activityType"], activityTitle?: string | null) {
  const isSingleVisit = value === "Field";
  const isDoubleVisit = value === "Double Visit";
  const isTraining = value === "Training";
  const isCoaching = isCoachingActivity(value, activityTitle);
  const showGeography = isSingleVisit || isDoubleVisit || isCoaching || (!isTraining && !noGeographyActivities.has(value));
  return {
    autoRep: isDoubleVisit || isCoaching,
    label: isCoaching ? "Coaching" : activityLabel(value),
    requiresArea: isSingleVisit || isDoubleVisit || isCoaching,
    requiresRegion: isSingleVisit || isDoubleVisit || isCoaching,
    requiresRep: isDoubleVisit || isCoaching,
    showArea: showGeography,
    showRegion: showGeography,
    showRep: isDoubleVisit || isCoaching,
    showTrainingFormat: isTraining,
  };
}

function canonicalRegion(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const normalized = raw.toLowerCase().replace(/[()]/g, "").replace(/\s+/g, " ").trim();
  if (["alex-bhr", "alex bhr", "alex/bhr", "alex", "alexandria", "bhr", "beheira"].includes(normalized)) {
    return "ALEX-BHR";
  }
  if (normalized === "cairo") return "Cairo";
  if (normalized === "delta 1" || normalized === "delta-1") return "Delta 1";
  if (normalized === "delta 2" || normalized === "delta-2") return "Delta 2";
  if (normalized === "giza") return "Giza";
  if (normalized === "upper egypt") return "Upper Egypt";
  return "";
}

function regionOptions(currentRegion?: string | null) {
  const options = [...approvedPlanningRegions];
  const current = String(currentRegion ?? "").trim();
  if (current && !canonicalRegion(current) && !options.some((region) => region.toLowerCase() === current.toLowerCase())) {
    options.push(current as (typeof approvedPlanningRegions)[number]);
  }
  return options;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function isDateInput(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function nextWeeklyPlanStart(referenceDate = today(), workweek: PlanWorkweek = HEAD_OFFICE_WORKWEEK) {
  const currentWeekStart = buildEmployeePlanPeriod("weekly", referenceDate, workweek).periodStartDate;
  return addDays(currentWeekStart, 7);
}

function defaultPlanAnchorDate(kind: EmployeePlanKind, workweek: PlanWorkweek = HEAD_OFFICE_WORKWEEK) {
  return kind === "weekly" ? nextWeeklyPlanStart(today(), workweek) : today();
}

function normalizeAnchorForKind(kind: EmployeePlanKind, value: string, workweek: PlanWorkweek = HEAD_OFFICE_WORKWEEK) {
  if (!isDateInput(value)) return defaultPlanAnchorDate(kind, workweek);
  const period = buildEmployeePlanPeriod(kind, value, workweek);
  return kind === "weekly" ? period.periodStartDate : value;
}

function weeklyPlanWeekOptions(anchorDate: string, workweek: PlanWorkweek = HEAD_OFFICE_WORKWEEK) {
  const starts = new Set<string>();
  starts.add(buildEmployeePlanPeriod("weekly", anchorDate, workweek).periodStartDate);
  const firstFutureWeek = nextWeeklyPlanStart(today(), workweek);
  for (let index = 0; index < 12; index += 1) {
    starts.add(addDays(firstFutureWeek, index * 7));
  }
  return Array.from(starts).sort();
}

function dateRange(startDate: string, endDate: string) {
  const result: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDayNumber(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatMonthYear(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDayName(value: string) {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function createDraftRow(activityDate: string, index: number, keySeed = "row", slot: PlanSlot = "full"): DraftItem {
  return {
    activityDate,
    activityTitle: "",
    activityType: "Office",
    area: "",
    attendees: "",
    doubleVisitMedicalRepHrId: "",
    doubleVisitMedicalRepName: "",
    endTime: "",
    key: `${keySeed}-${activityDate}-${index}`,
    lineFilter: "",
    locationText: "",
    notes: "",
    objective: "",
    slot,
    sortOrder: index,
    startTime: "",
  };
}

// Sort by (date, slot) only. Crucially this never depends on the value being
// typed, so editing a field can't reorder rows and steal input focus.
function sortDraftRows(rows: DraftItem[]) {
  return [...rows]
    .sort((left, right) => {
      const dateSort = left.activityDate.localeCompare(right.activityDate);
      if (dateSort !== 0) return dateSort;
      const slotSort = slotSortValue(left) - slotSortValue(right);
      if (slotSort !== 0) return slotSort;
      return (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
    })
    .map((row, index) => ({ ...row, sortOrder: index }));
}

function groupDraftRows(rows: DraftItem[]): DayGroup[] {
  const groups = new Map<string, DraftItem[]>();
  for (const row of sortDraftRows(rows)) {
    groups.set(row.activityDate, [...(groups.get(row.activityDate) ?? []), row]);
  }
  return Array.from(groups.entries()).map(([activityDate, groupRows]) => ({
    activityDate,
    dayNote: groupRows.find((row) => row.notes?.trim())?.notes ?? "",
    mode: groupRows.length > 1 ? "split" : "full",
    rows: groupRows,
  }));
}

// Seed the editor with one row per required working slot, per the employee's
// role-aware workweek (Head Office Sun–Thu full; Field Force Sat–Wed full +
// Thu AM only). Field Thursday seeds a single AM-slot row.
function defaultRows(kind: EmployeePlanKind, anchorDate: string, workweek: PlanWorkweek): DraftItem[] {
  const period = buildEmployeePlanPeriod(kind, anchorDate, workweek);
  const required = planRequiredSlotsByDate(period.periodStartDate, period.periodEndDate, workweek);
  let index = 0;
  const rows: DraftItem[] = [];
  for (const [date, requirement] of required) {
    rows.push(createDraftRow(date, index, "row", requirement === "am" ? "am" : "full"));
    index += 1;
  }
  return rows;
}

function draftRowsFromPlan(plan: EmployeePlan, medicalRepOptions: MedicalRepOption[]): DraftItem[] {
  const repByHrId = new Map(medicalRepOptions.map((rep) => [rep.hrId, rep]));
  return plan.items.map((item, index) => ({
    activityDate: item.activityDate,
    activityTitle: item.activityTitle,
    activityType: item.activityType,
    area: item.area ?? "",
    attendees: item.attendees ?? "",
    doubleVisitMedicalRepHrId: item.doubleVisitMedicalRepHrId ?? "",
    doubleVisitMedicalRepName: item.doubleVisitMedicalRepName ?? "",
    endTime: item.endTime ?? "",
    key: item.id,
    lineFilter: (item.doubleVisitMedicalRepHrId && repByHrId.get(item.doubleVisitMedicalRepHrId)?.lineName) || "",
    locationText: item.locationText ?? "",
    notes: item.notes,
    objective: item.objective ?? "",
    returnNotes: item.returnNotes,
    slot: slotFromTimes(item.startTime, item.endTime),
    sortOrder: index,
    startTime: item.startTime ?? "",
  }));
}

// Overlay cross-domain prefill onto seeded rows. Locked vacation/excuse rows
// replace any seeded row in the same (date, slot); sourced weekly rows fill
// empty seeded slots. Existing user-entered content is never clobbered.
function mergePrefillIntoRows(base: DraftItem[], prefill: PlanPrefillItem[]): DraftItem[] {
  if (prefill.length === 0) return base;
  const slotFilled = (row: DraftItem) =>
    Boolean(
      (row.activityType && row.activityType !== "Office") ||
        String(row.locationText ?? "").trim() ||
        String(row.area ?? "").trim() ||
        String(row.objective ?? "").trim(),
    );
  const rows = [...base];
  const indexOf = (date: string, slot: PlanSlot) =>
    rows.findIndex((row) => row.activityDate === date && row.slot === slot);

  prefill.forEach((item, prefillIndex) => {
    const row: DraftItem = {
      activityDate: item.activityDate,
      activityTitle: item.activityTitle,
      activityType: item.activityType,
      area: item.area ?? "",
      attendees: "",
      doubleVisitMedicalRepHrId: "",
      doubleVisitMedicalRepName: "",
      endTime: "",
      key: `${item.source}-${item.activityDate}-${item.slot}-${prefillIndex}`,
      lineFilter: "",
      locationText: item.locationText ?? "",
      locked: item.locked,
      notes: item.notes ?? "",
      objective: item.objective ?? "",
      slot: item.slot,
      sortOrder: rows.length + prefillIndex,
      source: item.source,
      sourceLabel: item.sourceLabel,
      startTime: "",
    };
    const existingIndex = indexOf(item.activityDate, item.slot);
    if (existingIndex === -1) {
      rows.push(row);
      return;
    }
    const existing = rows[existingIndex];
    // Locked sources always win; sourced weekly only fills an untouched slot.
    if (item.locked || !slotFilled(existing)) {
      rows[existingIndex] = { ...row, key: existing.key };
    }
  });
  return sortDraftRows(rows);
}

function rowPayload(rows: DraftItem[], medicalRepOptions: MedicalRepOption[]): EmployeePlanItemInput[] {
  const result: EmployeePlanItemInput[] = [];
  for (const group of groupDraftRows(rows)) {
    group.rows.forEach((row, slotIndex) => {
      const rule = activityRule(row.activityType, row.activityTitle);
      const region = canonicalRegion(row.locationText) || row.locationText || "";
      const autoRep = rule.autoRep ? autoRepForArea(medicalRepOptions, row.area ?? "", row.lineFilter) : null;
      const medicalRepHrId = row.doubleVisitMedicalRepHrId || autoRep?.hrId || "";
      const medicalRepName = row.doubleVisitMedicalRepName || autoRep?.fullName || "";
      // Persist the explicit slot as storage times (am/pm windows, or none for
      // a full day). The editor itself never reads these back as slot truth.
      const slotTimes = timesForSlot(row.slot);
      result.push({
        activityDate: row.activityDate,
        activityTitle: rule.label,
        activityType: row.activityType,
        area: rule.showArea ? row.area : "",
        attendees: row.attendees,
        doubleVisitMedicalRepHrId: rule.requiresRep ? medicalRepHrId : null,
        doubleVisitMedicalRepName: rule.requiresRep ? medicalRepName : null,
        endTime: slotTimes.endTime,
        locationText: rule.showTrainingFormat ? trainingFormatValue(row.locationText) : rule.showRegion ? region : "",
        notes: slotIndex === 0 ? group.dayNote : "",
        objective: row.objective,
        sortOrder: result.length,
        startTime: slotTimes.startTime,
      });
    });
  }
  return result;
}

function validateDraftRow(row: DraftItem, medicalRepOptions: MedicalRepOption[] = []) {
  const issues: string[] = [];
  const rule = activityRule(row.activityType, row.activityTitle);
  const label = `${formatDate(row.activityDate)} ${slotLabel(row)}`;
  if (rule.requiresRegion && !canonicalRegion(row.locationText)) {
    issues.push(`${label}: ${rule.label} needs a region.`);
  }
  if (rule.requiresArea && !String(row.area ?? "").trim()) {
    issues.push(`${label}: ${rule.label} needs an area.`);
  }
  if (rule.requiresRep && needsLineSelection(medicalRepOptions) && !String(row.lineFilter ?? "").trim()) {
    issues.push(`${label}: ${rule.label} needs a line selected first.`);
  } else if (rule.requiresRep && !autoRepForArea(medicalRepOptions, row.area ?? "", row.lineFilter)) {
    issues.push(`${label}: ${rule.label} needs an assigned Medical Rep for the selected area.`);
  }
  return issues;
}

function planCanEdit(plan: EmployeePlan | null) {
  return (
    !plan ||
    ["draft", "manager_returned", "ceo_returned", "final_approved", "hr_acknowledged"].includes(
      plan.status,
    )
  );
}

function statusTone(status: EmployeePlanStatus) {
  if (status.includes("rejected")) return "border-red-200 bg-red-50 text-red-700";
  if (status.includes("returned")) return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "details_requested") return "border-orange-300 bg-orange-50 text-orange-700";
  if (status === "final_approved" || status === "hr_acknowledged")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "submitted" || status === "manager_approved")
    return "border-sky-200 bg-sky-50 text-sky-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function isVacantMedicalRep(rep: MedicalRepOption) {
  const text = `${rep.fullName ?? ""} ${rep.hrId ?? ""}`.toLowerCase();
  return /\bvacan(t|cy)\b/.test(text);
}

// Line is a client-only disambiguation axis (see DraftItem.lineFilter): most
// roles only ever see one line's reps, so `line` is omitted and this behaves
// exactly as before. Org-wide roles (Training Manager) see every line's reps,
// so when an area is staffed by more than one line and no line was chosen
// yet, we deliberately return no match rather than guessing - the caller
// (validateDraftRow) surfaces that as "needs a line selected first".
function eligibleRepsForArea(options: MedicalRepOption[], area: string, line?: string | null): MedicalRepOption[] {
  if (!area) return [];
  const matches = options
    .filter((rep) => rep.areaName?.toLowerCase() === area.toLowerCase())
    .filter((rep) => !isVacantMedicalRep(rep));
  if (line) {
    return matches.filter((rep) => (rep.lineName ?? "").toLowerCase() === line.toLowerCase());
  }
  const distinctLines = new Set(matches.map((rep) => (rep.lineName ?? "").toLowerCase()));
  return distinctLines.size > 1 ? [] : matches;
}

function autoRepForArea(options: MedicalRepOption[], area: string, line?: string | null): MedicalRepOption | null {
  return eligibleRepsForArea(options, area, line)[0] ?? null;
}

function lineOptionsFromReps(options: MedicalRepOption[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rep of options) {
    const name = (rep.lineName ?? "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    result.push(name);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function needsLineSelection(options: MedicalRepOption[]): boolean {
  return lineOptionsFromReps(options).length > 1;
}

function areasForRegion(options: MedicalRepOption[], region: string, requireAssignedRep = false): string[] {
  const targetRegion = canonicalRegion(region);
  if (!targetRegion) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rep of options) {
    if (requireAssignedRep && isVacantMedicalRep(rep)) continue;
    if (canonicalRegion(rep.regionName) === targetRegion && rep.areaName) {
      const k = rep.areaName.toLowerCase();
      if (!seen.has(k)) {
        seen.add(k);
        result.push(rep.areaName);
      }
    }
  }
  return result.sort((a, b) => a.localeCompare(b));
}

/** Map raw service/DB/workflow errors to short, friendly, action-oriented messages. UI-only. */
function friendlyError(message: string): string {
  const text = message || "Action failed.";
  if (/duplicate key|already exists|active_period_uidx|23505/i.test(text)) {
    return "You already have an active plan for this period.";
  }
  if (/comment.*requires|requires a comment|COMMENT_REQUIRED/i.test(text)) {
    return "Please add a comment explaining the return or rejection.";
  }
  if (/Double Visit requires|Coaching requires|not available for this employee line|not assigned to the selected area|assigned same-line Medical Rep/i.test(text)) {
    return "Double Visit and Coaching need an assigned same-line Medical Rep from the selected area.";
  }
  if (/position is not eligible to submit weekly\/monthly plans/i.test(text)) {
    return "This account is not eligible to submit weekly/monthly plans. Check the signed-in HR ID, title, and plan permissions.";
  }
  if (/Direct manager is missing from employee profile/i.test(text)) {
    return "Direct manager is missing from this employee profile. Add the manager before submitting the plan.";
  }
  if (/^forbidden/i.test(text)) {
    return text.replace(/^Forbidden:\s*/i, "") || "You do not have permission to perform this action.";
  }
  return text;
}

function PlanPeriodControl({
  activeKind,
  anchorDate,
  disabled,
  idPrefix,
  onAnchorChange,
  workweek,
}: {
  activeKind: EmployeePlanKind;
  anchorDate: string;
  disabled: boolean;
  idPrefix: string;
  onAnchorChange: (value: string) => void;
  workweek: PlanWorkweek;
}) {
  const period = buildEmployeePlanPeriod(activeKind, anchorDate, workweek);
  const inputClass =
    "h-10 w-full border border-slate-300 bg-white px-3 text-sm font-bold text-slate-800 focus:border-orange-500 focus:outline-none focus:ring-2 focus:ring-orange-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400";

  if (activeKind === "weekly") {
    return (
      <div className="w-full min-w-0 space-y-1.5 sm:w-72">
        <label
          className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500"
          htmlFor={`${idPrefix}-plan-week`}
        >
          Plan week
        </label>
        <SearchableSelect
          className={inputClass}
          disabled={disabled}
          id={`${idPrefix}-plan-week`}
          onChange={(event) => onAnchorChange(event.target.value)}
          value={period.periodStartDate}
        >
          {weeklyPlanWeekOptions(anchorDate, workweek).map((weekStart) => {
            const optionPeriod = buildEmployeePlanPeriod("weekly", weekStart, workweek);
            return (
              <option key={weekStart} value={weekStart}>
                {formatDate(optionPeriod.periodStartDate)} to {formatDate(optionPeriod.periodEndDate)} - {optionPeriod.periodKey}
              </option>
            );
          })}
        </SearchableSelect>
      </div>
    );
  }

  return (
    <div className="w-full min-w-0 space-y-1.5 sm:w-72">
      <label
        className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500"
        htmlFor={`${idPrefix}-plan-month`}
      >
        Plan month
      </label>
      <input
        className={inputClass}
        disabled={disabled}
        id={`${idPrefix}-plan-month`}
        onChange={(event) => onAnchorChange(event.target.value)}
        type="date"
        value={anchorDate}
      />
    </div>
  );
}

export function PlansWorkspace({
  access,
  basePath,
  initialWorkspace,
  selectedPlanId,
}: PlansWorkspaceProps) {
  const initialWorkweek = initialWorkspace.currentEmployee?.workweek ?? HEAD_OFFICE_WORKWEEK;
  const initialSelectedPlan = selectedPlanId
    ? initialWorkspace.plans.find((item) => item.id === selectedPlanId) ?? null
    : null;
  const initialKind = initialSelectedPlan?.planKind ?? "weekly";
  const initialAnchorDate = initialSelectedPlan?.periodStartDate ?? defaultPlanAnchorDate(initialKind, initialWorkweek);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [activeKind, setActiveKind] = useState<EmployeePlanKind>(initialKind);
  const [anchorDate, setAnchorDate] = useState(initialAnchorDate);
  const [selectedPlan, setSelectedPlan] = useState<string | null>(initialSelectedPlan?.id ?? null);
  const [rows, setRows] = useState<DraftItem[]>(() =>
    initialSelectedPlan
      ? draftRowsFromPlan(initialSelectedPlan, initialWorkspace.medicalRepOptions)
      : defaultRows(initialKind, initialAnchorDate, initialWorkweek),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [returnNotes, setReturnNotes] = useState<Record<string, Record<string, string>>>({});
  const [visitDetailsPlan, setVisitDetailsPlan] = useState<EmployeePlan | null>(null);
  // Cross-domain prefill (approved vacation/excuse + monthly weekly sync),
  // scoped to the active (kind, period) so a stale fetch never overwrites a
  // newer one. Re-fetched whenever the employee opens a new period.
  const [prefillState, setPrefillState] = useState<{ items: PlanPrefillItem[]; scopeKey: string }>({
    items: [],
    scopeKey: "",
  });
  const [sameLineBookingState, setSameLineBookingState] = useState<{
    bookings: SameLinePlanBooking[];
    scopeKey: string;
  }>({ bookings: [], scopeKey: "" });
  const [sheetKey, setSheetKey] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // The fixed mobile bars and sheet are portalled to document.body so they escape
  // the employee-portal page-transition wrapper's CSS transform (which would
  // otherwise re-anchor position:fixed to that scrolling container).
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  // The global portal bottom nav (≈56px + safe area) only exists on the employee
  // portal surface, not the admin review page. Offset the action bar accordingly.
  const onAdminSurface = basePath === "/admin/weekly-plans" || basePath === "/workspace/plans";
  const calendarHref = basePath === "/admin/weekly-plans"
    ? "/admin/weekly-plans/calendar"
    : basePath === "/workspace/plans"
      ? "/workspace/plans/calendar"
      : "/employee-portals/plans/calendar";
  const actionBarBottom = onAdminSurface
    ? "env(safe-area-inset-bottom)"
    : "calc(56px + env(safe-area-inset-bottom))";
  const headerLabel = onAdminSurface ? "Review Workspace" : "My Plan";
  const compactHeaderTitle = onAdminSurface
    ? activeKind === "weekly"
      ? "Weekly plans review"
      : "Monthly plans review"
    : activeKind === "weekly"
      ? "Weekly Plan"
      : "Monthly Plan";

  const workweek = workspace.currentEmployee?.workweek ?? HEAD_OFFICE_WORKWEEK;
  const period = useMemo(
    () => buildEmployeePlanPeriod(activeKind, anchorDate, workweek),
    [activeKind, anchorDate, workweek],
  );
  const sameLineBookingScopeKey = `${workspace.currentEmployee?.hrId ?? ""}|${period.periodStartDate}|${period.periodEndDate}`;
  const sameLineBookings = useMemo(
    () => (sameLineBookingState.scopeKey === sameLineBookingScopeKey ? sameLineBookingState.bookings : []),
    [sameLineBookingScopeKey, sameLineBookingState],
  );
  const periodDays = useMemo(
    () => dateRange(period.periodStartDate, period.periodEndDate),
    [period.periodEndDate, period.periodStartDate],
  );
  const selectedDateSet = useMemo(
    () => new Set(rows.map((row) => row.activityDate)),
    [rows],
  );
  const requiredSlotsByDate = useMemo(
    () => planRequiredSlotsByDate(period.periodStartDate, period.periodEndDate, workweek),
    [period.periodEndDate, period.periodStartDate, workweek],
  );
  const workingDayCount = requiredSlotsByDate.size;
  const plans = workspace.plans;
  const plan = plans.find((item) => item.id === selectedPlan) ?? null;
  const ownPlans = plans.filter(
    (item) => item.employeeHrId === workspace.currentEmployee?.hrId,
  );
  // HR_IDs are stored uppercase on the plan but normalized lowercase on the access
  // context — compare canonical keys, never raw strings (CLAUDE.md). Super Admin is
  // the god-mode reviewer at every stage, mirroring the server guards
  // (assertManagerReviewer / assertCeoReviewer) so the UI never hides an action the
  // API would actually allow.
  const isSuperAdminReviewer = access.role === "Super Admin" || access.scope === "system";
  const sameHrId = (a: string | null | undefined, b: string | null | undefined) => {
    const left = canonicalHrIdKey(a);
    return Boolean(left && left === canonicalHrIdKey(b));
  };
  const managerQueue = plans.filter(
    (item) =>
      item.status === "submitted" &&
      (isSuperAdminReviewer || sameHrId(item.managerHrId, access.hrId)),
  );
  const ceoQueue = plans.filter(
    (item) =>
      item.status === "manager_approved" &&
      (access.role === "CEO" || isSuperAdminReviewer),
  );
  const hrQueue = plans.filter(
    (item) =>
      ["final_approved", "hr_acknowledged"].includes(item.status) &&
      workspace.canAcknowledgeHr,
  );
  const canEdit = planCanEdit(plan) && workspace.canSubmitPlans;
  const periodLocked = Boolean(plan);
  const dayGroups = useMemo(() => groupDraftRows(rows), [rows]);
  const dayGroupByDate = useMemo(
    () => new Map(dayGroups.map((group) => [group.activityDate, group])),
    [dayGroups],
  );
  const submitValidationIssues = useMemo(
    () => rows.flatMap((row) => validateDraftRow(row, workspace.medicalRepOptions)),
    [rows, workspace.medicalRepOptions],
  );
  // Client mirror of the server workday guard: every required working slot must
  // be filled before submit. A "full" day needs a full entry OR both AM + PM;
  // a Field Thursday needs only AM. Server re-enforces this on submit.
  const incompleteDays = useMemo(() => {
    const slotsByDate = new Map<string, Set<PlanSlot>>();
    for (const row of rows) {
      const set = slotsByDate.get(row.activityDate) ?? new Set<PlanSlot>();
      set.add(row.slot);
      slotsByDate.set(row.activityDate, set);
    }
    const issues: string[] = [];
    for (const [date, requirement] of requiredSlotsByDate) {
      const present = slotsByDate.get(date) ?? new Set<PlanSlot>();
      const hasFull = present.has("full");
      const label = `${formatDayName(date)} ${formatDate(date)}`;
      if (requirement === "am") {
        if (!hasFull && !present.has("am")) issues.push(`${label} (morning)`);
        continue;
      }
      if (hasFull) continue;
      const hasAm = present.has("am");
      const hasPm = present.has("pm");
      if (hasAm && hasPm) continue;
      if (!hasAm && !hasPm) issues.push(label);
      else issues.push(`${label} (${hasAm ? "afternoon" : "morning"} missing)`);
    }
    return issues;
  }, [requiredSlotsByDate, rows]);
  const needsAssignedRep = rows.some((row) => activityRule(row.activityType, row.activityTitle).requiresRep);
  const noSameLineReps = needsAssignedRep && workspace.medicalRepOptions.filter((rep) => !isVacantMedicalRep(rep)).length === 0;
  const noPlanRows = rows.length === 0;
  const lineOptions = useMemo(() => lineOptionsFromReps(workspace.medicalRepOptions), [workspace.medicalRepOptions]);
  const tableNeedsLine = lineOptions.length > 1;
  const submitBlocked = !canEdit || submitValidationIssues.length > 0 || incompleteDays.length > 0 || noSameLineReps || noPlanRows;
  const prefillScopeKey = `${workspace.currentEmployee?.hrId ?? ""}|${activeKind}|${period.periodStartDate}`;
  const rowConflictWarning = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) {
      const rule = activityRule(row.activityType, row.activityTitle);
      if (!rule.requiresRep) continue;
      const autoRep = autoRepForArea(workspace.medicalRepOptions, row.area ?? "", row.lineFilter);
      const warning = sameLineBookingWarning({
        activityDate: row.activityDate,
        bookings: sameLineBookings,
        currentEmployeeHrId: workspace.currentEmployee?.hrId,
        medicalRepHrId: row.doubleVisitMedicalRepHrId || autoRep?.hrId,
        medicalRepName: row.doubleVisitMedicalRepName || autoRep?.fullName,
      });
      if (warning) map.set(row.key, warning);
    }
    return map;
  }, [rows, sameLineBookings, workspace.currentEmployee?.hrId, workspace.medicalRepOptions]);
  const firstConflictWarning = Array.from(rowConflictWarning.values())[0] ?? null;

  const sheetRow = rows.find((row) => row.key === sheetKey) ?? null;
  const sheetGroup = sheetRow ? dayGroupByDate.get(sheetRow.activityDate) ?? null : null;

  // Lock body scroll while the mobile bottom sheet is open.
  useEffect(() => {
    if (!sheetRow) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [sheetRow]);

  useEffect(() => {
    let active = true;
    if (!workspace.currentEmployee?.hrId) return () => {
      active = false;
    };
    fetch(`/api/weekly-plans/conflicts?start=${period.periodStartDate}&end=${period.periodEndDate}`, {
      cache: "no-store",
    })
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        setSameLineBookingState({
          bookings: payload.success ? payload.data.bookings ?? [] : [],
          scopeKey: sameLineBookingScopeKey,
        });
      })
      .catch(() => {
        if (active) {
          setSameLineBookingState({ bookings: [], scopeKey: sameLineBookingScopeKey });
        }
      });
    return () => {
      active = false;
    };
  }, [period.periodEndDate, period.periodStartDate, sameLineBookingScopeKey, workspace.currentEmployee?.hrId]);

  // Fetch cross-domain prefill (approved vacation/excuse + monthly weekly sync)
  // whenever the active period changes, then overlay it onto a NEW draft only
  // (never a saved plan being edited). mergePrefillIntoRows preserves user
  // input, so re-running is safe. setRows here runs inside the async callback.
  useEffect(() => {
    let active = true;
    if (!workspace.currentEmployee?.hrId) return () => {
      active = false;
    };
    const scopeKey = prefillScopeKey;
    fetch(`/api/weekly-plans/prefill?kind=${activeKind}&anchor=${encodeURIComponent(anchorDate)}`, {
      cache: "no-store",
    })
      .then((response) => response.json())
      .then((payload) => {
        if (!active) return;
        const items: PlanPrefillItem[] = payload.success ? payload.data.items ?? [] : [];
        setPrefillState({ items, scopeKey });
        if (!selectedPlan && items.length > 0) {
          setRows((current) => mergePrefillIntoRows(current, items));
        }
      })
      .catch(() => {
        if (active) setPrefillState({ items: [], scopeKey });
      });
    return () => {
      active = false;
    };
  }, [activeKind, anchorDate, prefillScopeKey, selectedPlan, workspace.currentEmployee?.hrId]);

  function resetRows(kind: EmployeePlanKind, date: string) {
    const normalizedDate = normalizeAnchorForKind(kind, date, workweek);
    setRows(defaultRows(kind, normalizedDate, workweek));
    setSheetKey(null);
  }

  function updateRow(key: string, field: keyof EmployeePlanItemInput, value: string) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row;
        if (row.locked) return row; // approved vacation/excuse rows are read-only
        if (field === "activityType") {
          const nextActivity = activityValue(value);
          const rule = activityRule(nextActivity.activityType, nextActivity.activityTitle);
          const locationText = rule.showTrainingFormat
            ? trainingFormatValue(row.locationText)
            : rule.showRegion
              ? canonicalRegion(row.locationText)
              : "";
          const area = rule.showArea && canonicalRegion(locationText) ? row.area : "";
          const autoRep = rule.autoRep ? autoRepForArea(workspace.medicalRepOptions, area ?? "", row.lineFilter) : null;
          return {
            ...row,
            activityTitle: nextActivity.activityTitle,
            activityType: nextActivity.activityType,
            area,
            doubleVisitMedicalRepHrId: rule.requiresRep ? autoRep?.hrId ?? "" : "",
            doubleVisitMedicalRepName: rule.requiresRep ? autoRep?.fullName ?? "" : "",
            locationText,
          };
        }
        if (field === "locationText") {
          const rule = activityRule(row.activityType, row.activityTitle);
          return {
            ...row,
            area: "",
            doubleVisitMedicalRepHrId: "",
            doubleVisitMedicalRepName: "",
            locationText: rule.showTrainingFormat ? trainingFormatValue(value) : canonicalRegion(value),
          };
        }
        if (field === "area") {
          const rule = activityRule(row.activityType, row.activityTitle);
          const autoRep = rule.autoRep ? autoRepForArea(workspace.medicalRepOptions, value, row.lineFilter) : null;
          return {
            ...row,
            area: value,
            doubleVisitMedicalRepHrId: rule.requiresRep ? autoRep?.hrId ?? "" : "",
            doubleVisitMedicalRepName: rule.requiresRep ? autoRep?.fullName ?? "" : "",
          };
        }
        return { ...row, [field]: value };
      }),
    );
  }

  function updateRowLine(key: string, value: string) {
    setRows((current) =>
      current.map((row) => {
        if (row.key !== key) return row;
        if (row.locked) return row;
        const rule = activityRule(row.activityType, row.activityTitle);
        const autoRep = rule.autoRep ? autoRepForArea(workspace.medicalRepOptions, row.area ?? "", value) : null;
        return {
          ...row,
          doubleVisitMedicalRepHrId: rule.requiresRep ? autoRep?.hrId ?? "" : "",
          doubleVisitMedicalRepName: rule.requiresRep ? autoRep?.fullName ?? "" : "",
          lineFilter: value,
        };
      }),
    );
  }

  function updateDayNotes(activityDate: string, value: string) {
    setRows((current) => {
      const sortedDayRows = sortDraftRows(current.filter((row) => row.activityDate === activityDate));
      const noteKey = sortedDayRows[0]?.key;
      return current.map((row) =>
        row.activityDate === activityDate
          ? { ...row, notes: row.key === noteKey ? value : "" }
          : row,
      );
    });
  }

  function setDayMode(activityDate: string, mode: DayMode) {
    setRows((current) => {
      const sorted = sortDraftRows(current);
      const dayRows = sorted.filter((row) => row.activityDate === activityDate);
      if (dayRows.length === 0) return current;
      // Locked (approved vacation/excuse) days can't switch modes.
      if (dayRows.some((row) => row.locked)) return current;
      const dayNote = dayRows.find((row) => row.notes?.trim())?.notes ?? "";
      const otherRows = sorted.filter((row) => row.activityDate !== activityDate);
      const first = { ...dayRows[0], notes: dayNote };
      if (mode === "full") {
        return sortDraftRows([...otherRows, { ...first, slot: "full" as PlanSlot, startTime: "", endTime: "" }]);
      }
      const am = dayRows.find((row) => row.slot === "am") ?? first;
      const pm = dayRows.find((row) => row.slot === "pm") ?? createDraftRow(activityDate, current.length, `row-pm-${Date.now()}`, "pm");
      return sortDraftRows([
        ...otherRows,
        { ...am, slot: "am" as PlanSlot, notes: dayNote },
        { ...pm, activityDate, slot: "pm" as PlanSlot, notes: "" },
      ]);
    });
  }

  function deleteRow(key: string) {
    setRows((current) => {
      const target = current.find((row) => row.key === key);
      if (target?.locked) return current; // can't delete approved vacation/excuse
      const filtered = current.filter((row) => row.key !== key);
      if (!target?.notes?.trim()) return sortDraftRows(filtered);

      const remainingDayRows = sortDraftRows(filtered.filter((row) => row.activityDate === target.activityDate));
      const nextNoteKey = remainingDayRows[0]?.key;
      if (!nextNoteKey) return sortDraftRows(filtered);

      return sortDraftRows(
        filtered.map((row) =>
          row.key === nextNoteKey ? { ...row, notes: target.notes } : row,
        ),
      );
    });
    setSheetKey(null);
  }

  function addRow() {
    setRows((current) => {
      const used = new Set(current.map((row) => row.activityDate));
      const nextDate =
        periodDays.find((date) => !used.has(date)) ??
        addDays(current[current.length - 1]?.activityDate ?? period.periodEndDate, 1);
      return sortDraftRows([...current, createDraftRow(nextDate, current.length, `row-add-${Date.now()}`)]);
    });
  }

  function updateReturnNote(planId: string, itemId: string, value: string) {
    setReturnNotes((current) => ({
      ...current,
      [planId]: { ...(current[planId] ?? {}), [itemId]: value },
    }));
  }

  async function reload() {
    const response = await fetch("/api/weekly-plans", { cache: "no-store" });
    const payload = await response.json();
    if (payload.success) setWorkspace(payload.data);
  }

  function runAction(action: () => Promise<void>) {
    setMessage(null);
    startTransition(async () => {
      try {
        await action();
        await reload();
      } catch (error) {
        setMessage(friendlyError(error instanceof Error ? error.message : "Action failed."));
      }
    });
  }

  async function submitPlan(submit: boolean) {
    const payload = { anchorDate, items: rowPayload(rows, workspace.medicalRepOptions), planKind: activeKind, submit };
    const endpoint = plan ? `/api/weekly-plans/${plan.id}` : "/api/weekly-plans";
    const response = await fetch(endpoint, {
      body: JSON.stringify(payload),
      headers: { "Content-Type": "application/json" },
      method: plan ? "PATCH" : "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Unable to save plan.");
    setSelectedPlan(result.data.id);
    setMessage(submit ? "Plan submitted for direct manager review." : "Plan draft saved.");
  }

  async function decide(planId: string, action: string) {
    const rowNotes = action.includes("return")
      ? Object.entries(returnNotes[planId] ?? {})
          .map(([itemId, note]) => ({ itemId, note: note.trim() }))
          .filter((n) => n.note)
      : [];
    const response = await fetch(`/api/weekly-plans/${planId}/decision`, {
      body: JSON.stringify({ action, comment, returnNotes: rowNotes }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Decision failed.");
    setComment("");
    if (action.includes("return")) setReturnNotes((c) => ({ ...c, [planId]: {} }));
    setMessage("Decision recorded.");
  }

  async function doRequestVisitDetails(planId: string) {
    const response = await fetch(`/api/weekly-plans/${planId}/request-visit-details`, {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Request failed.");
    setMessage("Visit details requested. Employee has been notified.");
  }

  async function doSubmitVisitDetails(planId: string, details: VisitDetailInput[]) {
    const response = await fetch(`/api/weekly-plans/${planId}/visit-details`, {
      body: JSON.stringify({ details }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Submission failed.");
    setVisitDetailsPlan(null);
    setMessage("Visit details submitted. Plan resubmitted for manager review.");
  }

  async function acknowledge(planId: string) {
    const response = await fetch(`/api/weekly-plans/${planId}/acknowledge`, {
      body: JSON.stringify({ comment }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success)
      throw new Error(result.message ?? "Acknowledgement failed.");
    setComment("");
    setMessage("HR acknowledgement recorded.");
  }

  function loadPlanForEdit(target: EmployeePlan) {
    setSelectedPlan(target.id);
    setActiveKind(target.planKind);
    setAnchorDate(target.periodStartDate);
    setSheetKey(null);
    setRows(draftRowsFromPlan(target, workspace.medicalRepOptions));
  }

  function startNewPlan(kind: EmployeePlanKind = activeKind) {
    const nextAnchorDate = defaultPlanAnchorDate(kind, workweek);
    setSelectedPlan(null);
    setActiveKind(kind);
    setAnchorDate(nextAnchorDate);
    resetRows(kind, nextAnchorDate);
    setMessage(null);
  }

  function onKindChange(kind: EmployeePlanKind) {
    const nextAnchorDate = defaultPlanAnchorDate(kind, workweek);
    setActiveKind(kind);
    setSelectedPlan(null);
    setAnchorDate(nextAnchorDate);
    resetRows(kind, nextAnchorDate);
  }

  function onAnchorChange(value: string) {
    const nextAnchorDate = normalizeAnchorForKind(activeKind, value, workweek);
    setAnchorDate(nextAnchorDate);
    resetRows(activeKind, nextAnchorDate);
  }

  const validationWarning = noSameLineReps
    ? "No same-line Medical Rep is available for Double Visit or Coaching. Please contact your manager or change the activity type."
    : submitValidationIssues[0] ?? null;

  const schemaBanner = !workspace.schemaReady ? (
    <div className="border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-800">
      Planning database migration is not applied yet.
    </div>
  ) : null;

  // Mobile-first stacked banner naming exactly which day-slots still block
  // submit. Chips never wrap their own text (whitespace-nowrap); the chip row
  // wraps as layout so there is no horizontal scroll.
  const incompleteBanner = canEdit && incompleteDays.length > 0 ? (
    <div className="border border-amber-300 bg-amber-50 p-3">
      <div className="flex items-center gap-2">
        <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600" />
        <p className="text-sm font-black text-amber-800 whitespace-nowrap">Finish every working day before submitting</p>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {incompleteDays.map((label) => (
          <span
            key={label}
            className="inline-flex items-center whitespace-nowrap rounded-sm border border-amber-300 bg-white px-2 py-1 text-xs font-bold text-amber-800"
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  ) : null;

  // Subtle confirmation that approved leave / weekly plans were auto-pulled in.
  const lockedSyncCount = prefillState.scopeKey === prefillScopeKey
    ? prefillState.items.filter((item) => item.locked).length
    : 0;
  const weeklySyncCount = prefillState.scopeKey === prefillScopeKey
    ? prefillState.items.filter((item) => item.source === "weekly").length
    : 0;
  const syncedBanner = !selectedPlan && (lockedSyncCount > 0 || weeklySyncCount > 0) ? (
    <div className="flex flex-wrap items-center gap-2 border border-sky-200 bg-sky-50/70 px-3 py-2 text-xs font-bold text-sky-800">
      <ShieldCheck className="h-4 w-4 shrink-0 text-sky-600" />
      <span className="whitespace-nowrap">Auto-synced into this plan:</span>
      {lockedSyncCount > 0 ? (
        <span className="inline-flex items-center whitespace-nowrap rounded-full bg-violet-500 px-2 py-0.5 text-[10px] font-black uppercase text-white">
          {lockedSyncCount} approved leave
        </span>
      ) : null}
      {weeklySyncCount > 0 ? (
        <span className="inline-flex items-center whitespace-nowrap rounded-full bg-sky-500 px-2 py-0.5 text-[10px] font-black uppercase text-white">
          {weeklySyncCount} from weekly plan
        </span>
      ) : null}
    </div>
  ) : null;

  const cappedResultsBanner = workspace.hasMorePlans ? (
    <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Showing the latest {workspace.loadedPlanCount} of at least {workspace.planLimit} plans. Older records may be hidden; use export or narrow the review period before making audit decisions.
      </span>
    </div>
  ) : null;

  const messageBanner = message ? (
    <div className="border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-800">
      {message}
    </div>
  ) : null;

  return (
    <>
      {visitDetailsPlan && (
        <VisitDetailsModal
          onClose={() => setVisitDetailsPlan(null)}
          onSubmit={(details) => runAction(() => doSubmitVisitDetails(visitDetailsPlan.id, details))}
          plan={visitDetailsPlan}
        />
      )}

      {/* ===================== MOBILE (< md) ===================== */}
      <div className="space-y-4 pb-28 md:hidden">
        {schemaBanner}
        {cappedResultsBanner}
        {syncedBanner}
        {incompleteBanner}

        {/* Compact header */}
        <div className="border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="whitespace-nowrap text-lg font-black text-slate-900">{compactHeaderTitle}</h2>
              <p className="mt-0.5 text-xs font-semibold text-slate-500">
                {formatDate(period.periodStartDate)} – {formatDate(period.periodEndDate)} · {period.periodKey}
              </p>
            </div>
            <span
              className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-black ${statusTone(plan?.status ?? "draft")}`}
            >
              {statusLabels[plan?.status ?? "draft"]}
            </span>
          </div>

          <div className="mt-3">
            <ChoiceGroup
              aria-label="Plan type"
              className="grid-cols-2"
              disabled={periodLocked || isPending || !workspace.canSubmitPlans}
              onChange={onKindChange}
              options={[
                { label: "Weekly Plan", value: "weekly" },
                { label: "Monthly Plan", value: "monthly" },
              ]}
              value={activeKind}
            />
          </div>

          <div className="mt-3 flex flex-col gap-2">
            <PlanPeriodControl
              activeKind={activeKind}
              anchorDate={anchorDate}
              disabled={periodLocked || isPending || !workspace.canSubmitPlans}
              idPrefix="mobile"
              onAnchorChange={onAnchorChange}
              workweek={workweek}
            />
            {periodLocked && workspace.canSubmitPlans ? (
              <button
                className="inline-flex h-10 items-center justify-center gap-1.5 border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 active:bg-slate-50"
                onClick={() => startNewPlan(activeKind)}
                type="button"
              >
                <Plus className="h-4 w-4" />
                New plan
              </button>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Link
                aria-label="Open calendar"
                className="inline-flex h-11 items-center justify-center gap-1.5 border border-orange-200 bg-orange-50 px-3 text-sm font-black text-orange-700 active:bg-orange-100"
                href={calendarHref}
              >
                <CalendarDays className="h-4 w-4" />
                Calendar
              </Link>
              <button
                className="inline-flex h-11 items-center justify-center gap-1.5 border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 active:bg-slate-50"
                onClick={() => window.location.assign("/api/weekly-plans/export?format=xlsx")}
                type="button"
              >
                <Download className="h-4 w-4" />
                Export
              </button>
            </div>
          </div>
        </div>

        {/* Info chips */}
        <div className="grid grid-cols-2 gap-2">
          <InfoChip
            label="HR ID"
            value={workspace.currentEmployee?.hrId ?? access.hrId ?? "Unknown"}
          />
          <InfoChip
            label="Eligibility"
            value={workspace.canSubmitPlans ? "Can submit" : "Review only"}
          />
          <InfoChip
            label="Manager"
            value={workspace.currentEmployee?.managerName ?? "Not assigned"}
          />
          <InfoChip label="Secured" value="RLS · service-role only" />
        </div>

        {/* Mini KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <Kpi label="Drafts" value={workspace.summary.drafts} />
          <Kpi label="Pending" value={workspace.summary.managerPending + workspace.summary.ceoPending} />
          <Kpi label="Approved" value={workspace.summary.finalApproved} />
        </div>

        {messageBanner}

        {plan ? <WorkflowTimeline status={plan.status} /> : null}

        {validationWarning ? (
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{validationWarning}</span>
          </div>
        ) : null}

        {firstConflictWarning ? (
          <div className="flex items-start gap-2 border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{firstConflictWarning}</span>
          </div>
        ) : null}

        {noPlanRows ? (
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Add at least one planning day before saving or submitting.</span>
          </div>
        ) : null}

        {/* Day cards */}
        <div className="space-y-2.5">
          {rows.map((row) => (
            <MobileDayCard
              conflictWarning={rowConflictWarning.get(row.key) ?? null}
              dayNote={dayGroupByDate.get(row.activityDate)?.dayNote ?? row.notes ?? ""}
              key={row.key}
              medicalRepOptions={workspace.medicalRepOptions}
              onOpen={() => setSheetKey(row.key)}
              row={row}
            />
          ))}
          {canEdit ? (
            <button
              className="flex w-full items-center justify-center gap-1.5 border border-dashed border-orange-300 bg-orange-50/40 py-3 text-sm font-bold text-orange-600 active:bg-orange-50"
              onClick={addRow}
              type="button"
            >
              <Plus className="h-4 w-4" />
              Add day
            </button>
          ) : null}
        </div>

        {/* My plans + review queues */}
        <div className="space-y-3">
          {ownPlans.length > 0 ? (
            <QueueCard onFillDetails={setVisitDetailsPlan} onOpen={loadPlanForEdit} plans={ownPlans} title="My Plans" />
          ) : null}
          <ReviewCard
            comment={comment}
            isPending={isPending}
            onComment={setComment}
            onDecision={(planId, action) => runAction(() => decide(planId, action))}
            onRequestDetails={(p) => runAction(() => doRequestVisitDetails(p.id))}
            onReturnNote={updateReturnNote}
            plans={managerQueue}
            returnNotes={returnNotes}
            title="Manager Review"
            type="manager"
          />
          <ReviewCard
            comment={comment}
            isPending={isPending}
            onComment={setComment}
            onDecision={(planId, action) => runAction(() => decide(planId, action))}
            onReturnNote={updateReturnNote}
            plans={ceoQueue}
            returnNotes={returnNotes}
            title="CEO Review"
            type="ceo"
          />
          <ReviewCard
            comment={comment}
            isPending={isPending}
            onComment={setComment}
            onDecision={(planId) => runAction(() => acknowledge(planId))}
            plans={hrQueue}
            title="HR Acknowledgement"
            type="hr"
          />
        </div>
      </div>

      {/* Mobile sticky action bar (sits above the global bottom nav, clears safe area) */}
      {mounted && workspace.canSubmitPlans
        ? createPortal(
            <div
              className="fixed inset-x-0 z-30 flex gap-2 border-t border-slate-200 bg-white/95 px-4 pb-3 pt-3 backdrop-blur md:hidden"
              style={{ bottom: actionBarBottom }}
            >
              <Button
                className="flex-1"
                disabled={isPending || !canEdit || noPlanRows}
                onClick={() => runAction(() => submitPlan(false))}
                variant="secondary"
              >
                Save draft
              </Button>
              <Button
                className="flex-1"
                disabled={isPending || submitBlocked}
                onClick={() => runAction(() => submitPlan(true))}
              >
                <Send className="mr-2 h-4 w-4" />
                Submit
              </Button>
            </div>,
            document.body,
          )
        : null}

      {/* Mobile bottom-sheet row editor */}
      {mounted && sheetRow
        ? createPortal(
            <RowEditSheet
              canEdit={canEdit}
              medicalRepOptions={workspace.medicalRepOptions}
              onClose={() => setSheetKey(null)}
              onDayMode={(mode) => setDayMode(sheetRow.activityDate, mode)}
              onDayNote={(value) => updateDayNotes(sheetRow.activityDate, value)}
              onDelete={() => deleteRow(sheetRow.key)}
              onUpdate={(field, value) => updateRow(sheetRow.key, field, value)}
              onUpdateLine={(value) => updateRowLine(sheetRow.key, value)}
              dayMode={sheetGroup?.mode ?? "full"}
              dayNote={sheetGroup?.dayNote ?? sheetRow.notes ?? ""}
              conflictWarning={rowConflictWarning.get(sheetRow.key) ?? null}
              row={sheetRow}
            />,
            document.body,
          )
        : null}

      {/* ===================== DESKTOP / TABLET (>= md) ===================== */}
      <div className="hidden min-w-0 space-y-4 md:block">
        {schemaBanner}
        {cappedResultsBanner}
        {syncedBanner}
        {incompleteBanner}

        {/* Context tiles */}
        <div className="grid gap-3 sm:grid-cols-2">
          <ContextTile
            accent="orange"
            label="Eligibility"
            sub={workspace.currentEmployee?.jobTitle ?? access.role ?? ""}
            value={workspace.canSubmitPlans ? "Can submit plans" : "Review access only"}
          />
          <ContextTile
            accent="slate"
            label="Direct manager"
            sub={workspace.currentEmployee?.managerHrId ?? "Manager HR ID missing"}
            value={workspace.currentEmployee?.managerName ?? "Not assigned"}
          />
        </div>

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          <Kpi label="Drafts" value={workspace.summary.drafts} />
          <Kpi label="Mgr pending" value={workspace.summary.managerPending} />
          <Kpi label="CEO pending" value={workspace.summary.ceoPending} />
          <Kpi label="Approved" value={workspace.summary.finalApproved} />
          <Kpi label="HR ack'd" value={workspace.summary.hrAcknowledged} />
          <Kpi label="Returned" tone="amber" value={workspace.summary.returned} />
          <Kpi label="Rejected" tone="red" value={workspace.summary.rejected} />
        </div>

        {/* Kind toggle + date picker */}
        <div className="overflow-hidden rounded-sm border border-slate-200/90 bg-white/95 shadow-[0_24px_62px_rgba(15,23,42,0.10)] ring-1 ring-white/80">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 bg-[linear-gradient(180deg,#ffffff_0%,#f8fafc_100%)] px-4 py-3">
            <div className="min-w-0">
              <p className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-500">{headerLabel}</p>
              <h2 className="mt-1 text-xl font-black text-slate-950">
                {onAdminSurface
                  ? activeKind === "weekly"
                    ? "Weekly review queue"
                    : "Monthly review queue"
                  : activeKind === "weekly"
                    ? "Weekly plan table"
                    : "Monthly plan table"}
              </h2>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                {formatDate(period.periodStartDate)} to {formatDate(period.periodEndDate)} - {period.periodKey}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-sm border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-black uppercase tracking-wide text-orange-700">
                {dayGroups.length} selected day{dayGroups.length === 1 ? "" : "s"}
              </span>
              {activeKind === "monthly" ? (
                  <span className="rounded-sm border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600">
                  {workingDayCount} working days default
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-3 bg-white px-4 py-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="inline-flex w-full rounded-sm border border-slate-200 bg-slate-50 p-1 sm:w-auto">
              {(["weekly", "monthly"] as const).map((kind) => (
                <button
                  className={`min-h-10 flex-1 px-4 text-sm font-black transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none ${
                    activeKind === kind
                      ? "bg-slate-950 text-white shadow-[0_8px_18px_rgba(15,23,42,0.16)]"
                      : "text-slate-700 hover:bg-white"
                  }`}
                  disabled={periodLocked || isPending || !workspace.canSubmitPlans}
                  key={kind}
                  onClick={() => onKindChange(kind)}
                  type="button"
                >
                  {kind === "weekly" ? "Weekly Plan" : "Monthly Plan"}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PlanPeriodControl
                activeKind={activeKind}
                anchorDate={anchorDate}
                disabled={periodLocked || isPending || !workspace.canSubmitPlans}
                idPrefix="desktop"
                onAnchorChange={onAnchorChange}
                workweek={workweek}
              />
              <span className="inline-flex h-10 items-center rounded-sm border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 shadow-sm">
                {period.periodKey}
              </span>
              {periodLocked && workspace.canSubmitPlans ? (
                <button
                  className="inline-flex h-10 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
                  onClick={() => startNewPlan(activeKind)}
                  type="button"
                >
                  <Plus className="h-4 w-4" />
                  New plan
                </button>
              ) : null}
              <Link
                aria-label="Open calendar"
                className="inline-flex h-10 items-center gap-1.5 rounded-sm border border-orange-200 bg-orange-50 px-3 text-sm font-black text-orange-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-100"
                href={calendarHref}
              >
                <CalendarDays className="h-4 w-4" />
                Calendar
              </Link>
            </div>
          </div>
        </div>

        {messageBanner}

        {plan ? <WorkflowTimeline status={plan.status} /> : null}

        {validationWarning ? (
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{validationWarning}</span>
          </div>
        ) : null}

        {noPlanRows ? (
          <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-3 text-sm font-semibold text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Add at least one planning day before saving or submitting.</span>
          </div>
        ) : null}

        {/* Full-width plan table */}
        <div className="min-w-0 space-y-5">
          <section className="min-w-0 overflow-hidden rounded-sm border border-slate-200/90 bg-white shadow-[0_28px_72px_rgba(15,23,42,0.13)] ring-1 ring-white/80">
            <div className="employee-portal-command-grid border-b border-slate-800 bg-[#08111f] px-4 py-4 text-white sm:px-5">
              <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <p className="text-[11px] font-black uppercase tracking-[0.2em] text-orange-400">Planning table</p>
                  <h3 className="mt-1 text-lg font-black">
                    {activeKind === "weekly" ? "Weekly activities" : "Monthly activities"}
                  </h3>
                  <p className="mt-1 text-sm font-semibold text-slate-300">
                    Build each day with activity, geography, medical rep context, and notes.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-white/15 bg-white/10 px-3 text-xs font-black text-slate-100 transition hover:border-orange-400/70 hover:text-orange-200"
                    onClick={() => window.location.assign("/api/weekly-plans/export?format=xlsx")}
                    type="button"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export XLSX
                  </button>
                  <button
                    className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-white/15 bg-white/10 px-3 text-xs font-black text-slate-100 transition hover:border-orange-400/70 hover:text-orange-200"
                    onClick={() => window.location.assign("/api/weekly-plans/export?format=pdf")}
                    type="button"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export PDF
                  </button>
                  {plan ? (
                    <>
                      <button
                        className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-orange-400/45 bg-orange-500/15 px-3 text-xs font-black text-orange-100 transition hover:border-orange-300"
                        onClick={() =>
                          window.location.assign(
                            `/api/weekly-plans/export?format=xlsx&planId=${encodeURIComponent(plan.id)}`,
                          )
                        }
                        type="button"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Selected XLSX
                      </button>
                      <button
                        className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-orange-400/45 bg-orange-500/15 px-3 text-xs font-black text-orange-100 transition hover:border-orange-300"
                        onClick={() =>
                          window.location.assign(
                            `/api/weekly-plans/export?format=pdf&planId=${encodeURIComponent(plan.id)}`,
                          )
                        }
                        type="button"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Selected PDF
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50/90 px-4 py-3 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2">
                <button
                  className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canEdit || selectedDateSet.size >= periodDays.length}
                  onClick={addRow}
                  type="button"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Add day
                </button>
                <button
                  className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-slate-300 bg-white px-3 text-xs font-black text-slate-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={!canEdit}
                  onClick={() => resetRows(activeKind, anchorDate)}
                  type="button"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset working days
                </button>
              </div>
              <div className="flex flex-wrap gap-2 text-xs font-bold text-slate-500">
                <span className="rounded-sm border border-slate-200 bg-white px-2.5 py-1.5">Rows: {rows.length}</span>
                <span className="rounded-sm border border-slate-200 bg-white px-2.5 py-1.5">Period days: {periodDays.length}</span>
              </div>
            </div>

            <div className="overflow-x-auto bg-white">
              <table className="w-full min-w-[1040px] table-fixed border-collapse" data-portal-desktop-table>
                <thead className="sticky top-0 z-10 bg-slate-50">
                  <tr className="border-b border-slate-200 text-left text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
                    <th className="w-[18%] px-4 py-3">Date</th>
                    <th className="w-[15%] px-3 py-3">Activity</th>
                    <th className="w-[18%] px-3 py-3">Region</th>
                    <th className="w-[18%] px-3 py-3">Area</th>
                    <th className="w-[23%] px-3 py-3">Medical Rep</th>
                    <th className="w-[72px] px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dayGroups.map((group, groupIndex) => {
                    const groupWarnings = group.rows.flatMap((row) => validateDraftRow(row, workspace.medicalRepOptions));
                    const groupConflictWarnings = Array.from(
                      new Set(
                        group.rows
                          .map((row) => rowConflictWarning.get(row.key))
                          .filter((warning): warning is string => Boolean(warning)),
                      ),
                    );
                    const hasReturnNotes = group.rows.some((row) => row.returnNotes?.length);
                    const rowTone = hasReturnNotes
                      ? "bg-amber-50/70"
                      : groupIndex % 2 === 0
                        ? "bg-white"
                        : "bg-slate-50/45";

                    return (
                      <Fragment key={group.activityDate}>
                        {group.rows.map((row, slotIndex) => {
                          const rule = activityRule(row.activityType, row.activityTitle);
                          const availableAreas = areasForRegion(workspace.medicalRepOptions, row.locationText ?? "", rule.requiresRep);
                          const autoRep = rule.autoRep ? autoRepForArea(workspace.medicalRepOptions, row.area ?? "", row.lineFilter) : null;
                          const currentRegionOptions = regionOptions(row.locationText);
                          const showLineSelect = tableNeedsLine && rule.showRep;
                          const locked = Boolean(row.locked);
                          const dayLocked = group.rows.some((r) => r.locked);

                          return (
                            <tr className={`align-middle transition-colors hover:bg-orange-50/35 ${rowTone}`} key={row.key}>
                              {slotIndex === 0 ? (
                                <td className="px-4 py-3 align-top" rowSpan={group.rows.length}>
                                  <time
                                    className="flex items-center gap-3"
                                    dateTime={group.activityDate}
                                    title={group.activityDate}
                                  >
                                    <span className="flex h-16 w-20 shrink-0 flex-col items-center justify-center border border-orange-200 bg-gradient-to-b from-orange-50 to-white shadow-[0_6px_18px_rgba(249,115,22,0.08)]">
                                      <span className="text-[10px] font-black uppercase tracking-wide text-orange-500">
                                        {formatDayName(group.activityDate)}
                                      </span>
                                      <span className="mt-0.5 text-xl font-black leading-none text-slate-950">
                                        {formatDayNumber(group.activityDate)}
                                      </span>
                                      <span className="mt-1 text-[10px] font-black uppercase tracking-wide text-slate-500">
                                        {formatMonthYear(group.activityDate)}
                                      </span>
                                    </span>
                                    <div className="min-w-0">
                                      <p className="text-[11px] font-black uppercase tracking-[0.12em] text-slate-400">
                                        Plan day
                                      </p>
                                      <p className="mt-1 text-sm font-black text-slate-900">Day {groupIndex + 1}</p>
                                    </div>
                                  </time>
                                  <div className="mt-3 grid grid-cols-2 border border-slate-200 bg-slate-50 p-0.5">
                                    {(["full", "split"] as const).map((mode) => (
                                      <button
                                        className={`h-8 px-2 text-[11px] font-black ${
                                          group.mode === mode ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-white"
                                        }`}
                                        disabled={!canEdit || dayLocked}
                                        key={mode}
                                        onClick={() => setDayMode(group.activityDate, mode)}
                                        type="button"
                                      >
                                        {mode === "full" ? "Full day" : "AM / PM"}
                                      </button>
                                    ))}
                                  </div>
                                </td>
                              ) : null}
                              <td className="px-3 py-3">
                                <div className="mb-1 flex items-center gap-1.5">
                                  <span className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
                                    {slotLabel(row)}
                                  </span>
                                  {row.sourceLabel ? (
                                    <span
                                      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide ${
                                        locked
                                          ? "border-violet-300 bg-violet-50 text-violet-700"
                                          : "border-sky-300 bg-sky-50 text-sky-700"
                                      }`}
                                    >
                                      {locked ? <ShieldCheck className="h-2.5 w-2.5" /> : null}
                                      {row.sourceLabel}
                                    </span>
                                  ) : null}
                                </div>
                                <SearchableSelect
                                  className={tableSelectClass}
                                  disabled={!canEdit || locked}
                                  onChange={(e) => updateRow(row.key, "activityType", e.target.value)}
                                  value={activitySelectValue(row)}
                                >
                                  {planningActivityOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </SearchableSelect>
                              </td>
                              <td className="px-3 py-3">
                                {showLineSelect ? (
                                  <SearchableSelect
                                    className={`${tableSelectClass} mb-1.5`}
                                    disabled={!canEdit}
                                    onChange={(e) => updateRowLine(row.key, e.target.value)}
                                    value={row.lineFilter ?? ""}
                                  >
                                    <option value="">Select line</option>
                                    {lineOptions.map((line) => (
                                      <option key={line} value={line}>
                                        {line}
                                      </option>
                                    ))}
                                  </SearchableSelect>
                                ) : null}
                                {rule.showTrainingFormat ? (
                                  <SearchableSelect
                                    className={tableSelectClass}
                                    disabled={!canEdit}
                                    onChange={(e) => updateRow(row.key, "locationText", e.target.value)}
                                    value={trainingFormatValue(row.locationText)}
                                  >
                                    <option value="">Optional format</option>
                                    {trainingFormatOptions.map((format) => (
                                      <option key={format} value={format}>
                                        {format}
                                      </option>
                                    ))}
                                  </SearchableSelect>
                                ) : rule.showRegion ? (
                                  <SearchableSelect
                                    className={tableSelectClass}
                                    disabled={!canEdit}
                                    onChange={(e) => updateRow(row.key, "locationText", e.target.value)}
                                    value={canonicalRegion(row.locationText) || row.locationText || ""}
                                  >
                                    <option value="">{rule.requiresRegion ? "Select region" : "Optional region"}</option>
                                    {currentRegionOptions.map((region) => (
                                      <option key={region} value={region}>
                                        {region}
                                      </option>
                                    ))}
                                  </SearchableSelect>
                                ) : (
                                  <DisabledFieldText>Not needed</DisabledFieldText>
                                )}
                              </td>
                              <td className="px-3 py-3">
                                {rule.showArea ? (
                                  <SearchableSelect
                                    className={tableSelectClass}
                                    disabled={!canEdit || !canonicalRegion(row.locationText)}
                                    onChange={(e) => updateRow(row.key, "area", e.target.value)}
                                    value={row.area ?? ""}
                                  >
                                    <option value="">
                                      {canonicalRegion(row.locationText) ? (rule.requiresArea ? "Select area" : "Optional area") : "Choose region first"}
                                    </option>
                                    {row.area &&
                                    !availableAreas.some((area) => area.toLowerCase() === (row.area ?? "").toLowerCase()) ? (
                                      <option value={row.area}>{row.area}</option>
                                    ) : null}
                                    {availableAreas.map((area) => (
                                      <option key={area} value={area}>
                                        {area}
                                      </option>
                                    ))}
                                  </SearchableSelect>
                                ) : (
                                  <DisabledFieldText>Not needed</DisabledFieldText>
                                )}
                              </td>
                              <td className="px-3 py-3">
                                {rule.showRep ? (
                                  <DisabledFieldText>
                                    {!row.area
                                      ? "Select area first"
                                      : showLineSelect && !row.lineFilter
                                        ? "Select line first"
                                        : autoRep?.fullName ?? "No assigned rep"}
                                  </DisabledFieldText>
                                ) : (
                                  <DisabledFieldText>Not required</DisabledFieldText>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <button
                                  aria-label={`Remove ${formatDate(row.activityDate)} ${slotLabel(row)}`}
                                  className="inline-flex h-9 w-9 items-center justify-center border border-slate-200 bg-white text-slate-400 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                                  disabled={!canEdit || locked || rows.length <= 1}
                                  onClick={() => deleteRow(row.key)}
                                  type="button"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                        <tr className={`${rowTone} border-t border-orange-100/80`}>
                          <td className="px-4 pb-4 pt-0" colSpan={6}>
                            <div className="border border-orange-100 bg-orange-50/45 px-3 py-2">
                              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                                <span className="text-[11px] font-black uppercase tracking-[0.14em] text-orange-600">
                                  Notes
                                </span>
                                <input
                                  className={tableInputClass}
                                  disabled={!canEdit}
                                  onChange={(e) => updateDayNotes(group.activityDate, e.target.value)}
                                  placeholder="Notes for this day..."
                                  value={group.dayNote}
                                />
                              </div>
                              {groupWarnings.length > 0 ? (
                                <div className="mt-2 flex items-start gap-2 text-xs font-bold text-amber-800">
                                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                  <span>{groupWarnings[0]}</span>
                                </div>
                              ) : null}
                              {groupConflictWarnings.map((warning) => (
                                <div className="mt-2 flex items-start gap-2 text-xs font-bold text-red-800" key={warning}>
                                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                  <span>{warning}</span>
                                </div>
                              ))}
                            </div>
                          </td>
                        </tr>
                        {hasReturnNotes ? (
                          <tr className="bg-amber-50/80">
                            <td className="px-4 py-2" colSpan={6}>
                              <div className="space-y-1 border border-amber-200 bg-amber-50 p-2 text-xs font-semibold text-amber-900">
                                {group.rows.flatMap((row) => row.returnNotes ?? []).map((note) => (
                                  <p key={note.id}>
                                    {note.actorRole ?? "Reviewer"}: {note.note}
                                  </p>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer actions */}
            <div className="flex flex-col gap-3 border-t border-slate-200 bg-white px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap gap-2 text-xs font-bold text-slate-500">
                <span className={`border px-2.5 py-1.5 ${statusTone(plan?.status ?? "draft")}`}>
                  {statusLabels[plan?.status ?? "draft"]}
                </span>
                <span className="border border-slate-200 bg-slate-50 px-2.5 py-1.5">
                  {workspace.canSubmitPlans ? "Creator access" : "Review access only"}
                </span>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  disabled={isPending || !canEdit || noPlanRows}
                  onClick={() => runAction(() => submitPlan(false))}
                  variant="secondary"
                >
                  Save draft
                </Button>
                <Button
                  disabled={isPending || submitBlocked}
                  onClick={() => runAction(() => submitPlan(true))}
                >
                  <Send className="mr-2 h-4 w-4" />
                  Submit
                </Button>
              </div>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            {ownPlans.length > 0 ? (
              <QueueCard onFillDetails={setVisitDetailsPlan} onOpen={loadPlanForEdit} plans={ownPlans} title="My Plans" />
            ) : null}
            {managerQueue.length > 0 ? (
              <ReviewCard
                comment={comment}
                isPending={isPending}
                onComment={setComment}
                onDecision={(planId, action) => runAction(() => decide(planId, action))}
                onRequestDetails={(p) => runAction(() => doRequestVisitDetails(p.id))}
                onReturnNote={updateReturnNote}
                plans={managerQueue}
                returnNotes={returnNotes}
                title="Manager Review"
                type="manager"
              />
            ) : null}
            {ceoQueue.length > 0 ? (
              <ReviewCard
                comment={comment}
                isPending={isPending}
                onComment={setComment}
                onDecision={(planId, action) => runAction(() => decide(planId, action))}
                onReturnNote={updateReturnNote}
                plans={ceoQueue}
                returnNotes={returnNotes}
                title="CEO Review"
                type="ceo"
              />
            ) : null}
            {hrQueue.length > 0 ? (
              <ReviewCard
                comment={comment}
                isPending={isPending}
                onComment={setComment}
                onDecision={(planId) => runAction(() => acknowledge(planId))}
                plans={hrQueue}
                title="HR Acknowledgement"
                type="hr"
              />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

const TIMELINE_STEPS: Array<{ icon: typeof FileText; label: string }> = [
  { icon: FileText, label: "Draft" },
  { icon: Send, label: "Submitted" },
  { icon: CheckCircle2, label: "Manager" },
  { icon: ShieldCheck, label: "Final" },
  { icon: BadgeCheck, label: "HR Ack" },
];

function timelineReachedIndex(status: EmployeePlanStatus): number {
  switch (status) {
    case "submitted":
      return 1;
    case "manager_approved":
      return 2;
    case "ceo_approved":
    case "final_approved":
      return 3;
    case "hr_acknowledged":
      return 4;
    default:
      // draft, *_returned, *_rejected, cancelled
      return 0;
  }
}

function WorkflowTimeline({ status }: { status: EmployeePlanStatus }) {
  const reached = timelineReachedIndex(status);
  const alt = status.includes("rejected")
    ? { cls: "border-red-200 bg-red-50 text-red-700", icon: XCircle, text: statusLabels[status] }
    : status.includes("returned")
      ? { cls: "border-amber-200 bg-amber-50 text-amber-700", icon: RotateCcw, text: `${statusLabels[status]} — needs edits` }
      : status === "cancelled"
        ? { cls: "border-slate-200 bg-slate-50 text-slate-600", icon: X, text: "Cancelled" }
        : null;

  return (
    <div className="border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-1 overflow-x-auto">
        {TIMELINE_STEPS.map((step, index) => {
          const done = index <= reached && !alt;
          const current = index === reached && !alt;
          const Icon = step.icon;
          const tone = current
            ? "border-orange-300 bg-orange-50 text-orange-700"
            : done
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : "border-slate-200 bg-white text-slate-400";
          return (
            <div className="flex shrink-0 items-center" key={step.label}>
              <div className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${tone}`}>
                <Icon className="h-3.5 w-3.5" />
                <span className="text-[11px] font-black">{step.label}</span>
              </div>
              {index < TIMELINE_STEPS.length - 1 ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300" />
              ) : null}
            </div>
          );
        })}
      </div>
      {alt ? (
        <div className={`mt-2 flex items-center gap-1.5 border px-2.5 py-1.5 text-xs font-bold ${alt.cls}`}>
          <alt.icon className="h-3.5 w-3.5" />
          {alt.text}
        </div>
      ) : null}
    </div>
  );
}

function InfoChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-sm border border-slate-200 bg-white px-3 py-2 shadow-[0_10px_24px_rgba(15,23,42,0.06)]">
      <span className="block text-[10px] font-bold uppercase tracking-[0.1em] text-slate-400">{label}</span>
      <span className="mt-0.5 block whitespace-nowrap text-xs font-black text-slate-700">{value}</span>
    </div>
  );
}

function MobileDayCard({
  conflictWarning,
  dayNote,
  medicalRepOptions,
  onOpen,
  row,
}: {
  conflictWarning: string | null;
  dayNote: string;
  medicalRepOptions: MedicalRepOption[];
  onOpen: () => void;
  row: DraftItem;
}) {
  const rule = activityRule(row.activityType, row.activityTitle);
  const selectedRep = medicalRepOptions.find((rep) => rep.hrId === row.doubleVisitMedicalRepHrId);
  const autoRep = rule.autoRep ? autoRepForArea(medicalRepOptions, row.area ?? "", row.lineFilter) : null;
  const repName = row.doubleVisitMedicalRepName || selectedRep?.fullName || autoRep?.fullName || "";
  const needsRep = rule.requiresRep && !autoRep;
  const hasReturnNotes = Boolean(row.returnNotes?.length);
  const region = canonicalRegion(row.locationText) || row.locationText || "";
  const geographySummary = rule.showTrainingFormat
    ? trainingFormatValue(row.locationText) || "Training format optional"
    : rule.showRegion
    ? [region, row.area].filter(Boolean).join(" - ") || (rule.requiresRegion ? "Region and area required" : "No region set")
    : "No geography needed";

  const locked = Boolean(row.locked);
  return (
    <button
      className={`block w-full border bg-white p-3 text-left shadow-sm transition-colors active:bg-slate-50 ${
        locked ? "border-violet-300 bg-violet-50/40" : hasReturnNotes ? "border-amber-300" : "border-slate-200"
      }`}
      onClick={onOpen}
      type="button"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-12 flex-col items-center justify-center border border-orange-200 bg-orange-50">
            <span className="text-[10px] font-black uppercase leading-none text-orange-500">
              {formatDayName(row.activityDate)}
            </span>
            <span className="mt-0.5 text-xs font-black leading-none text-slate-800">
              {formatDate(row.activityDate).split(" ")[0]}
            </span>
          </div>
          <div className="min-w-0">
            <p className="whitespace-nowrap text-sm font-black text-slate-900">
              {rule.label} - {slotLabel(row)}
            </p>
            <p className="whitespace-nowrap text-xs font-semibold text-slate-500">{geographySummary}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {row.sourceLabel ? (
            <span
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase ${
                locked ? "bg-violet-500 text-white" : "bg-sky-500 text-white"
              }`}
            >
              {row.sourceLabel}
            </span>
          ) : null}
          {hasReturnNotes ? (
            <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[9px] font-black uppercase text-white">
              Feedback
            </span>
          ) : null}
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
        </div>
      </div>

      {rule.requiresRep || dayNote || conflictWarning ? (
        <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
          {rule.requiresRep ? (
            rule.label === "Coaching" ? (
              needsRep ? (
                <p className="flex items-center gap-1 text-xs font-bold text-amber-700">
                  <TriangleAlert className="h-3.5 w-3.5" />
                  Coaching needs an assigned Medical Rep
                </p>
              ) : (
                <p className="text-xs font-semibold text-violet-700">Coaching - {repName}</p>
              )
            ) :
            needsRep ? (
              <p className="flex items-center gap-1 text-xs font-bold text-amber-700">
                <TriangleAlert className="h-3.5 w-3.5" />
                Double Visit - select a Medical Rep
              </p>
            ) : (
              <p className="text-xs font-semibold text-violet-700">Double Visit - {repName}</p>
            )
          ) : null}
          {dayNote ? (
            <p className="whitespace-nowrap text-xs text-slate-500">{dayNote}</p>
          ) : null}
          {conflictWarning ? (
            <p className="flex items-start gap-1 text-xs font-bold text-red-700">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{conflictWarning}</span>
            </p>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}

function RowEditSheet({
  canEdit,
  conflictWarning,
  dayMode,
  dayNote,
  medicalRepOptions,
  onClose,
  onDayMode,
  onDayNote,
  onDelete,
  onUpdate,
  onUpdateLine,
  row,
}: {
  canEdit: boolean;
  conflictWarning: string | null;
  dayMode: DayMode;
  dayNote: string;
  medicalRepOptions: MedicalRepOption[];
  onClose: () => void;
  onDayMode: (mode: DayMode) => void;
  onDayNote: (value: string) => void;
  onDelete: () => void;
  onUpdate: (field: keyof EmployeePlanItemInput, value: string) => void;
  onUpdateLine: (value: string) => void;
  row: DraftItem;
}) {
  const rule = activityRule(row.activityType, row.activityTitle);
  const availableAreas = areasForRegion(medicalRepOptions, row.locationText ?? "", rule.requiresRep);
  const autoRep = rule.autoRep ? autoRepForArea(medicalRepOptions, row.area ?? "", row.lineFilter) : null;
  const currentRegionOptions = regionOptions(row.locationText);
  const lineOptions = lineOptionsFromReps(medicalRepOptions);
  const showLine = needsLineSelection(medicalRepOptions) && rule.showRep;
  const rowWarnings = validateDraftRow(row, medicalRepOptions);

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button
        aria-label="Close editor"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
        type="button"
      />
      <div
        className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto border-t border-slate-200 bg-white shadow-2xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-3">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.08em] text-orange-500">
              {formatDayName(row.activityDate)}
            </p>
            <p className="text-sm font-black text-slate-900">Edit · {formatDate(row.activityDate)}</p>
          </div>
          <button
            aria-label="Close"
            className="rounded-full p-1.5 text-slate-400 active:bg-slate-100"
            onClick={onClose}
            type="button"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <Field label="Day Mode">
            <ChoiceGroup
              aria-label="Day mode"
              className="grid-cols-2"
              disabled={!canEdit}
              onChange={onDayMode}
              options={dayModeOptions}
              value={dayMode}
            />
          </Field>

          <Field label="Activity Type">
            <SearchableSelect
              className={mobileField}
              disabled={!canEdit}
              onChange={(e) => onUpdate("activityType", e.target.value)}
              value={activitySelectValue(row)}
            >
              {planningActivityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </SearchableSelect>
          </Field>

          {showLine ? (
            <Field label="Line">
              <SearchableSelect
                className={mobileField}
                disabled={!canEdit}
                onChange={(e) => onUpdateLine(e.target.value)}
                value={row.lineFilter ?? ""}
              >
                <option value="">Select line</option>
                {lineOptions.map((line) => (
                  <option key={line} value={line}>
                    {line}
                  </option>
                ))}
              </SearchableSelect>
            </Field>
          ) : null}

          {rule.showTrainingFormat ? (
            <Field label="Training Format">
              <SearchableSelect
                className={mobileField}
                disabled={!canEdit}
                onChange={(e) => onUpdate("locationText", e.target.value)}
                value={trainingFormatValue(row.locationText)}
              >
                <option value="">Optional format</option>
                {trainingFormatOptions.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </SearchableSelect>
            </Field>
          ) : rule.showRegion ? (
            <Field label="Region">
              <SearchableSelect
                className={mobileField}
                disabled={!canEdit}
                onChange={(e) => onUpdate("locationText", e.target.value)}
                value={canonicalRegion(row.locationText) || row.locationText || ""}
              >
                <option value="">{rule.requiresRegion ? "Select region" : "Optional region"}</option>
                {currentRegionOptions.map((region) => (
                  <option key={region} value={region}>
                    {region}
                  </option>
                ))}
              </SearchableSelect>
            </Field>
          ) : null}

          {rule.showArea ? (
            <Field label="Area">
              <SearchableSelect
                className={mobileField}
                disabled={!canEdit || !canonicalRegion(row.locationText)}
                onChange={(e) => onUpdate("area", e.target.value)}
                value={row.area ?? ""}
              >
                <option value="">
                  {canonicalRegion(row.locationText) ? (rule.requiresArea ? "Select area" : "Optional area") : "Choose region first"}
                </option>
                {row.area &&
                !availableAreas.some((area) => area.toLowerCase() === (row.area ?? "").toLowerCase()) ? (
                  <option value={row.area}>{row.area}</option>
                ) : null}
                {availableAreas.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </SearchableSelect>
            </Field>
          ) : null}

          {rule.showRep ? (
            <Field label={showLine ? "Medical Rep" : "Medical Rep (same line)"}>
              <DisabledFieldText>
                {!row.area
                  ? "Select area first"
                  : showLine && !row.lineFilter
                    ? "Select line first"
                    : autoRep?.fullName ?? "No assigned rep"}
              </DisabledFieldText>
            </Field>
          ) : null}

          <Field label="Notes">
            <textarea
              className="min-h-20 w-full border border-orange-200 bg-orange-50/50 p-2.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none focus:ring-2 focus:ring-orange-400/20 disabled:opacity-60"
              disabled={!canEdit}
              onChange={(e) => onDayNote(e.target.value)}
              placeholder="Notes for this day..."
              value={dayNote}
            />
          </Field>

          {rowWarnings.length > 0 ? (
            <div className="flex items-start gap-2 border border-amber-200 bg-amber-50 p-2.5 text-xs font-bold text-amber-800">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{rowWarnings[0]}</span>
            </div>
          ) : null}

          {conflictWarning ? (
            <div className="flex items-start gap-2 border border-red-200 bg-red-50 p-2.5 text-xs font-bold text-red-800">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{conflictWarning}</span>
            </div>
          ) : null}

          {row.returnNotes?.length ? (
            <div className="space-y-1 border border-amber-200 bg-amber-50 p-3">
              <p className="text-[11px] font-black uppercase tracking-[0.08em] text-amber-700">
                Reviewer feedback
              </p>
              {row.returnNotes.map((note) => (
                <p className="text-xs font-semibold text-amber-900" key={note.id}>
                  {note.actorRole ?? "Reviewer"}: {note.note}
                </p>
              ))}
            </div>
          ) : null}

          <div className="flex gap-2 pt-1">
            {canEdit ? (
              <Button
                className="flex-1"
                onClick={onDelete}
                variant="destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {dayMode === "split" ? "Delete slot" : "Delete day"}
              </Button>
            ) : null}
            <Button className="flex-1" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.08em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function DisabledFieldText({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-10 min-w-0 items-center rounded-sm border border-slate-200 bg-slate-50 px-3">
      <span className="whitespace-nowrap text-xs font-semibold text-slate-400">{children}</span>
    </div>
  );
}

function ContextTile({
  accent,
  label,
  sub,
  value,
}: {
  accent: "orange" | "slate";
  label: string;
  sub: string;
  value: string;
}) {
  const accentCls =
    accent === "orange"
      ? "border-l-orange-500 bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_100%)]"
      : "border-l-slate-500 bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_100%)]";
  return (
    <div className={`rounded-sm border border-slate-200 border-l-4 p-4 shadow-[0_14px_36px_rgba(15,23,42,0.07)] ${accentCls}`}>
      <p className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-2 text-base font-black text-slate-900">{value}</p>
      {sub ? <p className="mt-0.5 text-sm text-slate-600">{sub}</p> : null}
    </div>
  );
}

function Kpi({
  label,
  tone = "slate",
  value,
}: {
  label: string;
  tone?: "amber" | "red" | "sky" | "slate";
  value: number;
}) {
  const toneClass = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    red: "border-red-200 bg-red-50 text-red-800",
    sky: "border-sky-200 bg-sky-50 text-sky-800",
    slate: "border-slate-200 bg-white text-slate-900",
  }[tone];
  return (
    <div className={`rounded-sm border p-3 shadow-[0_10px_26px_rgba(15,23,42,0.06)] ${toneClass}`}>
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] opacity-70">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
    </div>
  );
}

const VISIT_SPECIALITIES = [
  "ENT",
  "Chest",
  "IM",
  "GP",
  "Neuro",
  "NeuroPedia",
  "Psychiatry",
  "Urology",
  "Gynecology",
  "Ortho",
  "Pedia",
] as const;

type VisitEntry = { key: string; doctorName: string; speciality: string; address: string; objective: string };
type VisitEntriesState = Record<string, VisitEntry[]>;

function makeEntry(): VisitEntry {
  return { key: crypto.randomUUID(), doctorName: "", speciality: "", address: "", objective: "" };
}

function VisitDetailsModal({
  onClose,
  onSubmit,
  plan,
}: {
  onClose: () => void;
  onSubmit: (details: VisitDetailInput[]) => void;
  plan: EmployeePlan;
}) {
  const fieldItems = plan.items.filter((item) => item.activityType === "Field");
  const [entries, setEntries] = useState<VisitEntriesState>(() => {
    const initial: VisitEntriesState = {};
    for (const item of fieldItems) {
      if (item.visitDetails.length > 0) {
        initial[item.id] = item.visitDetails.map((d) => ({
          key: d.id,
          doctorName: d.doctorName,
          speciality: d.speciality,
          address: d.address,
          objective: d.objective,
        }));
      } else {
        initial[item.id] = [makeEntry()];
      }
    }
    return initial;
  });

  function updateEntry(itemId: string, key: string, field: keyof Omit<VisitEntry, "key">, value: string) {
    setEntries((cur) => ({
      ...cur,
      [itemId]: (cur[itemId] ?? []).map((e) => e.key === key ? { ...e, [field]: value } : e),
    }));
  }

  function addEntry(itemId: string) {
    setEntries((cur) => ({ ...cur, [itemId]: [...(cur[itemId] ?? []), makeEntry()] }));
  }

  function removeEntry(itemId: string, key: string) {
    setEntries((cur) => ({
      ...cur,
      [itemId]: (cur[itemId] ?? []).filter((e) => e.key !== key).length > 0
        ? (cur[itemId] ?? []).filter((e) => e.key !== key)
        : [makeEntry()],
    }));
  }

  function handleSubmit() {
    const details: VisitDetailInput[] = [];
    let sortOrder = 0;
    for (const item of fieldItems) {
      for (const entry of entries[item.id] ?? []) {
        if (!entry.doctorName.trim() || !entry.speciality || !entry.address.trim()) continue;
        details.push({
          itemId: item.id,
          doctorName: entry.doctorName.trim(),
          speciality: entry.speciality,
          address: entry.address.trim(),
          objective: entry.objective.trim(),
          sortOrder: sortOrder++,
        });
      }
    }
    if (details.length === 0) return;
    onSubmit(details);
  }

  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false);
  if (!isClient) return null;

  const allFilled = fieldItems.every((item) =>
    (entries[item.id] ?? []).some((e) => e.doctorName.trim() && e.speciality && e.address.trim()),
  );

  const modal = (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div className="w-full max-w-xl overflow-hidden bg-white shadow-2xl sm:rounded-none">
        {/* Header */}
        <div className="flex items-center justify-between bg-slate-900 px-4 py-3">
          <div>
            <h2 className="text-sm font-black uppercase tracking-wide text-white">Fill Visit Details</h2>
            <p className="text-[11px] text-slate-400">{plan.planKind} {plan.periodKey} — required by your manager</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white" type="button">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto p-4 space-y-5">
          {fieldItems.length === 0 && (
            <p className="text-sm text-slate-500">No Single Visit days found in this plan.</p>
          )}
          {fieldItems.map((item) => (
            <div key={item.id} className="border border-orange-200 bg-orange-50/30">
              <div className="flex items-center gap-2 border-b border-orange-200 bg-orange-100/60 px-3 py-2">
                <span className="h-3 w-1 bg-orange-500" />
                <p className="text-xs font-black text-slate-800">
                  {formatDate(item.activityDate)} — Single Visit
                </p>
              </div>
              <div className="space-y-3 p-3">
                {(entries[item.id] ?? []).map((entry, idx) => (
                  <div key={entry.key} className="border border-slate-200 bg-white p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <p className="text-[11px] font-black uppercase tracking-wide text-slate-500">Visit {idx + 1}</p>
                      {(entries[item.id] ?? []).length > 1 && (
                        <button
                          onClick={() => removeEntry(item.id, entry.key)}
                          className="text-[10px] font-bold text-red-500 hover:text-red-700"
                          type="button"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="col-span-2">
                        <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-600 mb-0.5">
                          Dr. Name <span className="text-red-500">*</span>
                        </label>
                        <input
                          className={tableInputClass}
                          onChange={(e) => updateEntry(item.id, entry.key, "doctorName", e.target.value)}
                          placeholder="Dr. Ahmed Mostafa"
                          value={entry.doctorName}
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-600 mb-0.5">
                          Speciality <span className="text-red-500">*</span>
                        </label>
                        <select
                          className={tableSelectClass}
                          onChange={(e) => updateEntry(item.id, entry.key, "speciality", e.target.value)}
                          value={entry.speciality}
                        >
                          <option value="">— select —</option>
                          {VISIT_SPECIALITIES.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-600 mb-0.5">
                          Address <span className="text-red-500">*</span>
                        </label>
                        <input
                          className={tableInputClass}
                          onChange={(e) => updateEntry(item.id, entry.key, "address", e.target.value)}
                          placeholder="Clinic / hospital address"
                          value={entry.address}
                        />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-600 mb-0.5">
                          Objective of Visit
                        </label>
                        <input
                          className={cin}
                          onChange={(e) => updateEntry(item.id, entry.key, "objective", e.target.value)}
                          placeholder="Product introduction, follow-up…"
                          value={entry.objective}
                        />
                      </div>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => addEntry(item.id)}
                  className="flex w-full items-center justify-center gap-1.5 border border-dashed border-orange-300 py-2 text-[11px] font-bold text-orange-600 hover:border-orange-400 hover:bg-orange-50"
                  type="button"
                >
                  <Plus className="h-3.5 w-3.5" /> Add another visit
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-4 py-3">
          <button onClick={onClose} className="text-xs font-bold text-slate-500 hover:text-slate-800" type="button">
            Cancel
          </button>
          <Button disabled={!allFilled} onClick={handleSubmit}>
            <Send className="mr-2 h-4 w-4" />
            Submit Visit Details
          </Button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function QueueCard({
  onFillDetails,
  onOpen,
  plans,
  title,
}: {
  onFillDetails: (plan: EmployeePlan) => void;
  onOpen: (plan: EmployeePlan) => void;
  plans: EmployeePlan[];
  title: string;
}) {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center gap-2.5 bg-slate-900 px-4 py-3">
        <span aria-hidden className="h-4 w-1 bg-orange-500" />
        <h3 className="text-sm font-black uppercase tracking-wide text-white">{title}</h3>
      </div>
      <div className="max-h-[360px] space-y-2 overflow-y-auto p-3">
        {plans.length === 0 ? (
          <p className="text-sm font-semibold text-slate-500">No plans yet.</p>
        ) : null}
        {plans.map((p) => (
          <div className="border border-slate-200 p-3 hover:bg-slate-50" key={p.id}>
            <button className="w-full text-left" onClick={() => onOpen(p)} type="button">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-black text-slate-900">
                  {p.planKind} {p.periodKey}
                </p>
                <span
                  className={`rounded-full border px-2 py-1 text-[11px] font-black ${statusTone(p.status)}`}
                >
                  {statusLabels[p.status]}
                </span>
              </div>
              <p className="mt-1 text-xs font-semibold text-slate-500">Revision {p.revision}</p>
            </button>
            {p.status === "details_requested" && (
              <button
                className="mt-2 flex w-full items-center justify-center gap-1.5 border border-orange-300 bg-orange-50 py-1.5 text-[11px] font-bold text-orange-700 hover:border-orange-400 hover:bg-orange-100"
                onClick={() => onFillDetails(p)}
                type="button"
              >
                <Plus className="h-3.5 w-3.5" />
                Fill Visit Details
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewCard({
  comment,
  isPending,
  onComment,
  onDecision,
  onRequestDetails,
  onReturnNote,
  plans,
  returnNotes,
  title,
  type,
}: {
  comment: string;
  isPending: boolean;
  onComment: (value: string) => void;
  onDecision: (planId: string, action: string) => void;
  onRequestDetails?: (plan: EmployeePlan) => void;
  onReturnNote?: (planId: string, itemId: string, value: string) => void;
  plans: EmployeePlan[];
  returnNotes?: Record<string, Record<string, string>>;
  title: string;
  type: "ceo" | "hr" | "manager";
}) {
  if (plans.length === 0) return null;
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <div className="flex items-center gap-2.5 bg-slate-900 px-4 py-3">
        <span aria-hidden className="h-4 w-1 bg-orange-500" />
        <h3 className="text-sm font-black uppercase tracking-wide text-white">{title}</h3>
      </div>
      <div className="space-y-3 p-3">
        {plans.map((p) => (
          <div className="border border-slate-200 p-3" key={p.id}>
            <p className="font-black text-slate-900">{p.employeeName}</p>
            <p className="text-xs font-semibold text-slate-500">
              {p.planKind} {p.periodKey} — {statusLabels[p.status]}
            </p>
            <textarea
              className="mt-3 min-h-20 w-full border border-slate-200 p-2 text-sm"
              onChange={(e) => onComment(e.target.value)}
              placeholder={type === "hr" ? "Acknowledgement note" : "Comment for reject/return"}
              value={comment}
            />
            {type !== "hr" ? (
              <div className="mt-3 max-h-44 space-y-2 overflow-y-auto border border-slate-200 bg-slate-50 p-2">
                {p.items.map((item) => (
                  <label className="block" key={item.id}>
                    <span className="block text-xs font-black text-slate-600">
                      {formatDate(item.activityDate)} — {item.activityTitle}
                    </span>
                    <input
                      className={cin}
                      onChange={(e) => onReturnNote?.(p.id, item.id, e.target.value)}
                      placeholder="Optional row return note"
                      value={returnNotes?.[p.id]?.[item.id] ?? ""}
                    />
                  </label>
                ))}
              </div>
            ) : null}
            {type !== "hr" && comment.trim().length === 0 ? (
              <p className="mt-2 text-xs font-semibold text-amber-700">
                A comment is required to return or reject a plan.
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              {type === "manager" ? (
                <>
                  <Button disabled={isPending} onClick={() => onDecision(p.id, "manager_approve")}>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Approve
                  </Button>
                  {p.items.some((i) => i.activityType === "Field") && onRequestDetails && (
                    <Button
                      disabled={isPending}
                      onClick={() => onRequestDetails(p)}
                      variant="secondary"
                    >
                      <FileText className="mr-2 h-4 w-4" />
                      Request Visit Details
                    </Button>
                  )}
                  <Button
                    disabled={isPending || comment.trim().length === 0}
                    onClick={() => onDecision(p.id, "manager_return")}
                    variant="secondary"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Return
                  </Button>
                  <Button
                    disabled={isPending || comment.trim().length === 0}
                    onClick={() => onDecision(p.id, "manager_reject")}
                    variant="destructive"
                  >
                    <XCircle className="mr-2 h-4 w-4" />
                    Reject
                  </Button>
                </>
              ) : null}
              {type === "ceo" ? (
                <>
                  <Button disabled={isPending} onClick={() => onDecision(p.id, "ceo_approve")}>
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    Approve
                  </Button>
                  <Button
                    disabled={isPending || comment.trim().length === 0}
                    onClick={() => onDecision(p.id, "ceo_return")}
                    variant="secondary"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Return
                  </Button>
                  <Button
                    disabled={isPending || comment.trim().length === 0}
                    onClick={() => onDecision(p.id, "ceo_reject")}
                    variant="destructive"
                  >
                    <XCircle className="mr-2 h-4 w-4" />
                    Reject
                  </Button>
                </>
              ) : null}
              {type === "hr" ? (
                <Button
                  disabled={isPending}
                  onClick={() => onDecision(p.id, "hr_acknowledge")}
                  variant="secondary"
                >
                  <CircleAlert className="mr-2 h-4 w-4" />
                  Acknowledge
                </Button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
