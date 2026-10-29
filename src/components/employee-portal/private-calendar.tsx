"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  FileSearch,
  ListFilter,
  RefreshCw,
  Search,
} from "lucide-react";


import { currentCairoDateOnlyIso, currentCairoDateParts } from "@/lib/i18n/format";
import { formatVisitCountSplit, visitCountSplitTotal } from "@/lib/crm/visit-count-buckets";
import { managerVisitLine } from "@/lib/phoenix-crm/manager-visit-detail";
import {
  PRIVATE_CALENDAR_CATEGORY_LABELS,
  PRIVATE_CALENDAR_COMPANION_LABELS,
  privateCalendarDayTile,
  privateCalendarPlanText,
  type PrivateCalendarDayTile,
} from "@/lib/private-calendar/day-tile";
import {
  privateCalendarActivityKindLabels,
  isPrivateCalendarVisitKind,
  privateCalendarActivityKinds,
  privateCalendarItemKind,
  privateCalendarVisitKinds,
  type PrivateCalendarActivityKind,
} from "@/lib/private-calendar/activity-kinds";
import {
  privateCalendarHrIdKey,
  privateCalendarItemOccursOn,
  privateCalendarSourceLabels,
  type PrivateCalendarException,
  type PrivateCalendarItem,
  type PrivateCalendarSource,
  type PrivateCalendarViewMode,
  type PrivateCalendarWorkspace,
} from "@/lib/private-calendar/logic";
import { ManagerPlanActual } from "@/components/phoenix-crm/manager-plan-actual-table";
import { PrivateCalendarReviewRequestThread } from "@/components/private-calendar/review-request-thread";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { requestStatusLabel } from "@/lib/approvals-hub/request-status-label";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxFieldClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import {
  adminChipDepthClassName,
  adminControlDepthClassName,
  adminPanelDepthClassName,
  adminPanelHeaderClassName,
  adminSoftDepthClassName,
} from "@/components/admin/admin-design-tokens";


const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const allValue = "__all__";

// Where a Super Admin can actually go verify a request-review / no-activity
// clarification claim — a closed, real list of the systems this app already
// has, plus an escape hatch for anything else.
const verificationSourceOptions = [
  "CRM / iReports360 (Double Visit)",
  "Fingerprint / Attendance Device",
  "Manager Confirmation",
  "HR Records (Vacation / Excuse Approval)",
  "Other",
] as const;

function todayIso() {
  return currentCairoDateOnlyIso();
}

// Cairo local clock time — the app's operating timezone — so "Synced at" reads as
// the employee's own wall-clock time, not a raw UTC/ISO timestamp.
function formatSyncedAt(date: Date) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    second: "2-digit",
    timeZone: "Africa/Cairo",
  }).format(date);
}

// monthLabel, dayLabel and reportDateLabel below all render DATE-ONLY values (a month off a synthetic
// `Date.UTC`, and calendar-item `date` columns), which `new Date` parses as UTC midnight. UTC here is
// CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. None of
// these is an instant — do not "fix" them to Cairo.
// (formatSyncedAt above IS an instant, which is why it alone renders in Africa/Cairo.)
function monthLabel(year: number, month: number) {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

function dayLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    weekday: "long",
  }).format(new Date(`${value}T00:00:00Z`));
}

function shortMonthLabel(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function reportDateLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00Z`));
}

function monthDateIso(year: number, month: number, preferredDay = 1) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(Math.max(preferredDay, 1), lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ONE colour per kind of day, everywhere on this screen — the grid, the phone markers, the
// timeline, the agenda, the key figures and the legend (owner, 2026-09-21). A CRM visit is
// coloured by WHO went: single is blue, double fuchsia, chain teal. Within a family a REGULAR
// visit wears the colour solid, on a tinted card, and a CAMPAIGN visit wears it hatched, on a
// white card with a dashed frame — so the family reads first and the kind of visit second, even
// on a phone's 8px marker. Attendance emerald, vacation sky (an HR vacation and one logged in CRM
// alike), excuse amber, national holiday violet and other CRM activity (meetings, training, admin
// work) slate each keep a hue of their own. No Activity Recorded is the one solid red block, see
// exceptionChipTone. Orange stays the selection and warning colour and indigo the review-update
// colour, so no kind wears either. Severity never repaints a kind (a late punch used to turn the
// same amber as an excuse): it is an outline round the card instead, see severityOutline.
//
// Every class is spelled out in full: Tailwind only generates a class it finds written out.
const kindTones: Record<PrivateCalendarActivityKind, { accent: string; chip: string; swatch: string }> = {
  attendance: {
    accent: "border-l-emerald-600",
    chip: "border-l-[3px] border-l-emerald-600 bg-emerald-50",
    swatch: "bg-emerald-600",
  },
  vacation: {
    accent: "border-l-sky-500",
    chip: "border-l-[3px] border-l-sky-500 bg-sky-50",
    swatch: "bg-sky-500",
  },
  excuse: {
    accent: "border-l-amber-500",
    chip: "border-l-[3px] border-l-amber-500 bg-amber-50",
    swatch: "bg-amber-500",
  },
  holiday: {
    accent: "border-l-violet-600",
    chip: "border-l-[3px] border-l-violet-600 bg-violet-50",
    swatch: "bg-violet-600",
  },
  // An approved plan is an INTENTION, not a record, so it wears the hatched treatment the campaign
  // visits already use for "read me second", in neutral stone — no recorded source's hue, and visibly
  // not one of them at a glance on a phone marker.
  plan: {
    accent: "border-dashed border-l-stone-500",
    chip: "border border-l-[3px] border-dashed border-stone-300 border-l-stone-500 bg-white",
    swatch: "bg-[repeating-linear-gradient(135deg,var(--color-stone-500)_0_2px,var(--color-stone-200)_2px_4px)]",
  },
  single_regular: {
    accent: "border-l-blue-700",
    chip: "border-l-[3px] border-l-blue-700 bg-blue-50",
    swatch: "bg-blue-700",
  },
  single_campaign: {
    accent: "border-dashed border-l-blue-700",
    chip: "border border-l-[3px] border-dashed border-blue-300 border-l-blue-700 bg-white",
    swatch: "bg-[repeating-linear-gradient(135deg,var(--color-blue-700)_0_2px,var(--color-blue-100)_2px_4px)]",
  },
  double_regular: {
    accent: "border-l-fuchsia-700",
    chip: "border-l-[3px] border-l-fuchsia-700 bg-fuchsia-50",
    swatch: "bg-fuchsia-700",
  },
  double_campaign: {
    accent: "border-dashed border-l-fuchsia-700",
    chip: "border border-l-[3px] border-dashed border-fuchsia-300 border-l-fuchsia-700 bg-white",
    swatch: "bg-[repeating-linear-gradient(135deg,var(--color-fuchsia-700)_0_2px,var(--color-fuchsia-100)_2px_4px)]",
  },
  chain_regular: {
    accent: "border-l-teal-700",
    chip: "border-l-[3px] border-l-teal-700 bg-teal-50",
    swatch: "bg-teal-700",
  },
  chain_campaign: {
    accent: "border-dashed border-l-teal-700",
    chip: "border border-l-[3px] border-dashed border-teal-300 border-l-teal-700 bg-white",
    swatch: "bg-[repeating-linear-gradient(135deg,var(--color-teal-700)_0_2px,var(--color-teal-100)_2px_4px)]",
  },
  other_crm: {
    accent: "border-l-slate-500",
    chip: "border-l-[3px] border-l-slate-500 bg-slate-100",
    swatch: "bg-slate-500",
  },
  // An outstation trip claimed in Phoenix Expenses (2026-10-29) — cyan, the "away on the road" hue no other source wears.
  outstation: {
    accent: "border-l-cyan-700",
    chip: "border-l-[3px] border-l-cyan-700 bg-cyan-50",
    swatch: "bg-cyan-700",
  },
  // A day an admin verified on the employee's review request (2026-10-29) — lime, a hue no source and no exception wears.
  correction: {
    accent: "border-l-lime-700",
    chip: "border-l-[3px] border-l-lime-700 bg-lime-50",
    swatch: "bg-lime-700",
  },
};

function kindAccentColor(kind: PrivateCalendarActivityKind) {
  return kindTones[kind].accent;
}

function kindChipTone(kind: PrivateCalendarActivityKind) {
  return kindTones[kind].chip;
}

// Solid (or hatched) swatch per kind for legend squares, phone markers, agenda markers and the
// key figures.
function kindSwatchColor(kind: PrivateCalendarActivityKind) {
  return kindTones[kind].swatch;
}

// No Activity Recorded — a working day with nothing logged anywhere — is the one exception that
// wears a solid block rather than a tinted card, so it reads as its own colour on the key.
const NO_ACTIVITY_CODE = "no_activity_recorded";
const noActivitySwatch = "bg-red-700";

// A problem on an item is an outline round the source's own card — orange for something to
// check, red for a real problem — so the card still says WHICH source it is.
function severityOutline(severity: PrivateCalendarItem["severity"]) {
  if (severity === "danger") return "ring-1 ring-inset ring-red-500";
  if (severity === "warning") return "ring-1 ring-inset ring-orange-500";
  return "";
}

// An item's flag is good news (an approved exception), a real problem (absence) or something
// to check (everything else). It used to paint every flag red, the approved one included.
function flagTone(flag: string) {
  if (flag === "Approved attendance exception") return "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200";
  if (flag === "Absence risk") return "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200";
  return "bg-orange-50 text-orange-800 ring-1 ring-inset ring-orange-200";
}

// Every private calendar exception is a real problem (danger), something to check (warning, e.g.
// a late arrival) or news about a review the employee asked for (info) — shared tone lookup for
// the day-cell chip, the actionable strip, the agenda, and the detail panel. Three hues of their
// own, none of them a source's: red, orange, indigo. Info used to fall into the warning amber.
function exceptionChipTone(exception: PrivateCalendarException) {
  if (exception.code === NO_ACTIVITY_CODE) return "border-l-[3px] border-l-red-950 bg-red-700 text-white";
  return exceptionTone(exception.severity).chip;
}

function exceptionTone(severity: string) {
  if (severity === "danger") {
    return {
      badge: "bg-red-600 text-white",
      border: "border-l-red-600",
      chip: "border-l-[3px] border-l-red-600 bg-red-50 text-red-800",
      dot: "bg-red-600",
      label: "Needs review",
      panel: "bg-red-50/50",
      panelStrong: "bg-red-50 ring-red-200",
      text: "text-red-800",
      title: "text-red-900",
    };
  }
  if (severity === "warning") {
    return {
      badge: "bg-orange-600 text-white",
      border: "border-l-orange-500",
      chip: "border-l-[3px] border-l-orange-500 bg-orange-50 text-orange-800",
      dot: "bg-orange-500",
      label: "Needs review",
      panel: "bg-orange-50/50",
      panelStrong: "bg-orange-50 ring-orange-200",
      text: "text-orange-800",
      title: "text-orange-900",
    };
  }
  return {
    badge: "bg-indigo-600 text-white",
    border: "border-l-indigo-500",
    chip: "border-l-[3px] border-l-indigo-500 bg-indigo-50 text-indigo-800",
    dot: "bg-indigo-500",
    label: "Update",
    panel: "bg-indigo-50/40",
    panelStrong: "bg-indigo-50 ring-indigo-200",
    text: "text-indigo-800",
    title: "text-indigo-900",
  };
}

// The team snapshot's day counts, in the calendar's canonical order. Visits are not letters here:
// they are one AM · PM · Pharmacies line under these, see TeamSummaryPanel.
const teamSummarySources = [
  { letter: "A", source: "attendance" },
  { letter: "V", source: "vacation" },
  { letter: "E", source: "excuse" },
] as const satisfies ReadonlyArray<{ letter: string; source: Exclude<PrivateCalendarSource, "double_visit" | "field_visit" | "holiday"> }>;

// Collapsed/expanded choices a viewer makes on this screen, remembered in THEIR browser only. A
// private window or blocked storage throws — the screen then simply opens with the defaults.
function readStoredOpen(key: string): boolean | null {
  try {
    const value = window.localStorage.getItem(key);
    return value === "1" ? true : value === "0" ? false : null;
  } catch {
    return null;
  }
}

function storeOpen(key: string, open: boolean) {
  try {
    window.localStorage.setItem(key, open ? "1" : "0");
  } catch {
    // Storage unavailable: the choice lasts until the page reloads, which is all it can do.
  }
}

const KEY_FIGURES_OPEN_KEY = "phx.privateCalendar.keyFiguresOpen";
const FILTERS_OPEN_KEY = "phx.privateCalendar.filtersOpen";

// An item's status as words: src/lib/approvals-hub/request-status-label.ts owns the map.
const statusLabel = requestStatusLabel;

function itemSearchText(item: PrivateCalendarItem) {
  return [
    item.title,
    item.status,
    item.status ? statusLabel(item.status) : null,
    item.time,
    item.description,
    item.employeeHrId,
    item.employeeName,
    item.employeeDepartmentName,
    item.employeeLineName,
    item.managerName,
    item.sourceLabel,
    item.sourceRecordId,
    item.sourceSystem,
    item.sourceTable,
    item.approvalImpact,
    item.exceptionFlags.join(" "),
    item.detailLines.join(" "),
  ].join(" ").toLowerCase();
}

function exceptionSearchText(exception: PrivateCalendarException) {
  return [
    exception.title,
    exception.description,
    exception.employeeHrId,
    exception.employeeName,
    exception.code,
  ].join(" ").toLowerCase();
}

function uniqueSorted(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function timelineRank(item: PrivateCalendarItem) {
  if (item.source === "holiday") return 0;
  if (item.source === "vacation") return 1;
  if (item.source === "excuse") return 2;
  return 4;
}

function sortTimelineItems(items: PrivateCalendarItem[]) {
  return [...items].sort((left, right) => {
    const rank = timelineRank(left) - timelineRank(right);
    if (rank !== 0) return rank;
    return `${left.time ?? ""}-${left.employeeName ?? ""}-${left.title}`.localeCompare(`${right.time ?? ""}-${right.employeeName ?? ""}-${right.title}`);
  });
}

/** A recorded entry of any type — everything but an approved plan, which is an intention and never a record of work. */
function isRecordedEntry(item: PrivateCalendarItem) {
  return privateCalendarItemKind(item) !== "plan";
}

/**
 * A district manager's day carries ONE table — his plan against what was recorded — so the plan's own half-day
 * entries, which that table already draws, are left out of the detail instead of repeating under it. Only a table that
 * DRAWS a plan does this: a rep's visits in full (owner, 2026-10-21) carry no manager plan, so his approved plan entries
 * stay where they are.
 */
function withoutPlanDrawnByATable(items: PrivateCalendarItem[]) {
  const drawn = new Set(
    items
      .filter((item) => item.managerVisits && item.managerVisits.length > 0 && (item.managerPlan || item.managerPlanUnread) && item.employeeHrId)
      .map((item) => privateCalendarHrIdKey(item.employeeHrId as string)),
  );
  if (drawn.size === 0) return items;
  return items.filter((item) => isRecordedEntry(item) || !item.employeeHrId || !drawn.has(privateCalendarHrIdKey(item.employeeHrId)));
}

type PrivateCalendarSurface = "employee" | "workspace";

function chipTitle(item: PrivateCalendarItem, viewMode: PrivateCalendarViewMode) {
  if (viewMode === "team" && item.employeeName) return `${item.employeeName} - ${item.title}`;
  return item.title;
}

// A person as the calendar prints them: the name, and the HR ID beside it only where the surface
// asks for IDs (see showHrIds).
function personLabel(name: string, hrId: string | null | undefined, showHrId: boolean) {
  return showHrId && hrId ? `${name} (${hrId})` : name;
}

// A person in the employee list: the name, then the line and the title. The HR ID rides beside the name only on a
// desk (`showHrId`) — on the employee surface a person is their name, never a code (owner rule: names, never codes).
function employeeOptionLabel(employee: { fullName: string; hrId: string; jobTitle: string | null; lineName: string | null }, showHrId: boolean) {
  return `${employee.fullName}${showHrId ? ` (${employee.hrId})` : ""}${employee.lineName ? ` - ${employee.lineName}` : ""}${employee.jobTitle ? ` - ${employee.jobTitle}` : ""}`;
}

/**
 * A visit entry inside a month cell — a SUMMARY, never a list (owner, 2026-10-23: "in the calendar tile itself show the
 * count of the AM and the count of PM and the count of pharmacies, and if it is double or single … the area … don't
 * mention names … when I press on the day, the details appear down"). It prints the kind, the category, the plan state,
 * the three figures apart (a pharmacy in the violet of the Phoenix CRM calendar, never inside PM), who the visits were
 * made with, and the brick and the area. Every customer, address and per-visit card is the Daily Timeline's.
 * Every name that may be Arabic sits in a `bdi`, so the browser's bidirectional rules never reorder it across a dot.
 */
function VisitDayTile({ item, tile, viewMode }: { item: PrivateCalendarItem; tile: PrivateCalendarDayTile; viewMode: PrivateCalendarViewMode }) {
  const planText = privateCalendarPlanText(tile.plan);
  const figures: Array<{ label: string; value: number; violet?: boolean }> = [
    { label: "AM", value: tile.split.am },
    { label: "PM", value: tile.split.pm },
    { label: "Pharmacies", value: tile.split.pharmacies, violet: true },
  ];
  // Plain lines, no boxes (owner, 2026-10-29: "this is a mess … make it simple when I look at the calendar"): the kind on
  // one line, the plan state under it, the three figures side by side, then who and where. It used to box every tag and
  // stack the figures as a three-row table, which made a visit the tallest thing on the page.
  const kindText = [PRIVATE_CALENDAR_COMPANION_LABELS[tile.companion], PRIVATE_CALENDAR_CATEGORY_LABELS[tile.category]].join(" · ");
  const places = [...tile.bricks, ...tile.areas];
  return (
    <span
      className={[
        "block space-y-1 px-1.5 py-1 text-phx-2xs font-semibold leading-tight text-slate-600 [overflow-wrap:anywhere]",
        kindChipTone(privateCalendarItemKind(item)),
        severityOutline(item.severity),
      ].join(" ")}
      title={chipTitle(item, viewMode)}
    >
      {viewMode === "team" && item.employeeName ? <bdi className="block font-black text-slate-900">{item.employeeName}</bdi> : null}
      <span className="block font-black uppercase tracking-[0.08em] text-slate-900">{kindText}</span>
      {planText ? <span className="block text-slate-600">{planText}</span> : null}
      <span className="flex flex-wrap gap-x-1.5 gap-y-0.5">
        {figures.map((figure) => (
          <span
            className={[
              "inline-flex flex-wrap items-baseline gap-x-1",
              figure.violet && figure.value > 0 ? "px-1 bg-violet-600 text-white" : figure.value === 0 ? "text-slate-400" : "text-slate-900",
            ].join(" ")}
            key={figure.label}
          >
            <span className="whitespace-nowrap font-black uppercase tracking-[0.08em]">{figure.label}</span>
            <span className="text-xs font-black tabular-nums">{figure.value}</span>
          </span>
        ))}
      </span>
      {tile.withNames.length > 0 ? (
        <span className="block">
          <span className="text-slate-500">With </span>
          <bdi className="font-black text-slate-900">{tile.withNames.join(", ")}</bdi>
        </span>
      ) : null}
      {places.length > 0 ? (
        <span className="block text-slate-500">
          {places.map((place, index) => (
            <span key={`${place}-${index}`}>
              {index > 0 ? " · " : null}
              <bdi>{place}</bdi>
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export function PrivateCalendar({
  initialWorkspace,
  showDeskDetail,
  surface = "employee",
  todayIso: todayIsoProp,
  viewerHrId = null,
}: {
  initialWorkspace: PrivateCalendarWorkspace;
  /**
   * The desk's technical detail — HR IDs beside names, and each entry's source system, table and
   * record ID. Defaults to on for the admin-shell workspace surface and off everywhere else, so an
   * employee sees names and the source's own name only. A desk page on the employee surface can
   * pass `true` to keep them.
   */
  showDeskDetail?: boolean;
  surface?: PrivateCalendarSurface;
  /** Today's date as YYYY-MM-DD, computed once on the server to prevent SSR/hydration mismatch. */
  todayIso: string;
  // Whoever is actually logged in and looking at this screen — NOT necessarily
  // the employee whose calendar is displayed (a manager/admin can view someone
  // else's calendar here too). Flag-day and no-activity-clarification are
  // self-service actions, so they only render when this matches
  // selectedEmployee.hrId — viewing your OWN calendar.
  viewerHrId?: string | null;
}) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [selectedDate, setSelectedDate] = useState(todayIsoProp);
  const [kindFilter, setKindFilter] = useState<string>(allValue);
  const [statusFilter, setStatusFilter] = useState<string>(allValue);
  const [employeeFilter, setEmployeeFilter] = useState<string>(allValue);
  const [departmentFilter, setDepartmentFilter] = useState<string>(allValue);
  const [lineFilter, setLineFilter] = useState<string>(allValue);
  const [exceptionOnly, setExceptionOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [calendarView, setCalendarView] = useState<"month" | "list">("month");
  const [hiddenKinds, setHiddenKinds] = useState<Set<PrivateCalendarActivityKind>>(() => new Set());
  // Both panels open on the server's render; after mount a remembered choice wins, and with none
  // remembered a phone starts with the filters folded away so the month is on screen first.
  const [keyFiguresOpen, setKeyFiguresOpen] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(true);
  useEffect(() => {
    // Read after mount, never in the initial state: the server has no storage, so reading it
    // there would hand the browser a different first render than the server sent.
    const storedFigures = readStoredOpen(KEY_FIGURES_OPEN_KEY);
    const filtersStartOpen = readStoredOpen(FILTERS_OPEN_KEY) ?? !window.matchMedia("(max-width: 767px)").matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (storedFigures !== null) setKeyFiguresOpen(storedFigures);
    setFiltersOpen(filtersStartOpen);
  }, []);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Every source this calendar reads (attendance, CRM double visits, vacation,
  // excuse) is queried live server-side on every fetch — there is no cache layer
  // to invalidate. "Sync Now" re-runs that same live fetch on demand instead of
  // requiring a month/employee change to force a refresh; lastSyncedAt tracks
  // every successful fetch (nav or explicit sync) so the timestamp is always
  // honest about how current the data on screen actually is.
  // Starts null (the initial view came from the server-rendered page load, not a
  // client fetch, so there is no honest client-side timestamp for it) and is set
  // the moment any real fetch completes — nav, employee switch, or Sync Now.
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const {
    exceptions,
    items,
    month,
    reviewRequests,
    selectedEmployee,
    sourceReadiness,
    summary,
    teamSummary,
    viewMode,
    visibleEmployees,
    visitSummary,
    weeks,
    year,
  } = workspace;
  const today = todayIsoProp;
  const isTeamView = viewMode === "team";
  const isWorkspaceSurface = surface === "workspace";
  // View/Employee/Line/Department/Search only mean anything when the viewer can
  // actually see more than themselves — a self-scoped viewer (e.g. a regular
  // employee) has exactly one employee, one line, one department in their data,
  // so those controls would be dead UI that filters nothing. Source/Status/
  // Exceptions still filter within one person's own items and stay for everyone.
  const canFilterAcrossEmployees = workspace.access.canSelectEmployee;
  // Every private calendar source is already an actually recorded/verified event
  // (attendance, leave, CRM double visits) — there is no separate "planned" view
  // to distinguish anymore, so this flag currently has no effect on what renders.
  const actualOnly = surface === "employee";
  // One flat, bordered panel on both surfaces. The employee surface used to add a gradient band
  // and floating / ring panels directly under the portal's own navy page header — two
  // dark bands stacked, in a look no other portal page uses.
  const panelClass = `overflow-hidden border border-slate-200 bg-white ${adminPanelDepthClassName}`;
  const secondaryPanelClass = `overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`;
  // Raw HR IDs and source tables/record IDs are for a desk, which resolves people and records by
  // ID. On the employee surface a person is their name — a rep never needs his own ID beside it.
  const deskDetail = showDeskDetail ?? isWorkspaceSurface;
  const showHrIds = deskDetail;
  const inputClass = isWorkspaceSurface
    ? `h-9 w-full border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-500/15 disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none ${adminControlDepthClassName}`
    : "h-9 w-full border-0 bg-slate-100 px-3 text-sm font-semibold text-slate-800 outline-none ring-1 ring-transparent transition focus:bg-white focus:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-60";
  const searchInputClass = isWorkspaceSurface
    ? `h-9 w-full border border-slate-300 bg-white pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-500/15 ${adminControlDepthClassName}`
    : "h-9 w-full border-0 bg-slate-100 pl-9 pr-3 text-sm font-semibold text-slate-800 outline-none ring-1 ring-transparent transition focus:bg-white focus:ring-orange-300";
  const controlRadiusClass = "";

  const employeeByHrId = useMemo(
    () => new Map(visibleEmployees.map((employee) => [privateCalendarHrIdKey(employee.hrId), employee])),
    [visibleEmployees],
  );
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const statusOptions = useMemo(() => uniqueSorted(items.map((item) => item.status)), [items]);
  const departmentOptions = useMemo(() => uniqueSorted(visibleEmployees.map((employee) => employee.departmentName)), [visibleEmployees]);
  const lineOptions = useMemo(() => uniqueSorted(visibleEmployees.map((employee) => employee.lineName)), [visibleEmployees]);

  const filteredItems = useMemo(() => {
    const search = query.trim().toLowerCase();
    return items.filter((item) => {
      const employee = item.employeeHrId ? employeeByHrId.get(privateCalendarHrIdKey(item.employeeHrId)) : null;
      const kind = privateCalendarItemKind(item);
      if (hiddenKinds.has(kind)) return false;
      if (kindFilter !== allValue && kind !== kindFilter) return false;
      if (statusFilter !== allValue && item.status !== statusFilter) return false;
      if (employeeFilter !== allValue && item.employeeHrId && privateCalendarHrIdKey(item.employeeHrId) !== privateCalendarHrIdKey(employeeFilter)) return false;
      if (departmentFilter !== allValue && item.employeeHrId && employee?.departmentName !== departmentFilter) return false;
      if (lineFilter !== allValue && item.employeeHrId && employee?.lineName !== lineFilter) return false;
      if (exceptionOnly && item.exceptionFlags.length === 0) return false;
      if (search && !itemSearchText(item).includes(search)) return false;
      return true;
    });
  }, [departmentFilter, employeeByHrId, employeeFilter, exceptionOnly, hiddenKinds, items, kindFilter, lineFilter, query, statusFilter]);

  const filteredExceptions = useMemo(() => {
    const search = query.trim().toLowerCase();
    return exceptions.filter((exception) => {
      const employee = exception.employeeHrId ? employeeByHrId.get(privateCalendarHrIdKey(exception.employeeHrId)) : null;
      if (employeeFilter !== allValue && privateCalendarHrIdKey(exception.employeeHrId) !== privateCalendarHrIdKey(employeeFilter)) return false;
      if (departmentFilter !== allValue && employee?.departmentName !== departmentFilter) return false;
      if (lineFilter !== allValue && employee?.lineName !== lineFilter) return false;
      if (kindFilter !== allValue) {
        const relatedKinds = exception.relatedItemIds
          .map((id) => itemById.get(id))
          .filter((item): item is PrivateCalendarItem => Boolean(item))
          .map(privateCalendarItemKind);
        if (relatedKinds.length === 0 && kindFilter !== "attendance") return false;
        if (relatedKinds.length > 0 && !relatedKinds.includes(kindFilter as PrivateCalendarActivityKind)) return false;
      }
      if (search && !exceptionSearchText(exception).includes(search)) return false;
      return true;
    });
  }, [departmentFilter, employeeByHrId, employeeFilter, exceptions, itemById, kindFilter, lineFilter, query]);

  const itemsByDay = useMemo(() => {
    const map = new Map<string, PrivateCalendarItem[]>();
    for (const week of weeks) {
      for (const day of week) {
        const date = day.date;
        if (!date) continue;
        const dayItems = filteredItems.filter((item) => privateCalendarItemOccursOn(item, date));
        const hasException = filteredExceptions.some((exception) => exception.date === date);
        if (exceptionOnly && !hasException) continue;
        if (dayItems.length) map.set(date, dayItems);
      }
    }
    return map;
  }, [exceptionOnly, filteredExceptions, filteredItems, weeks]);

  // The weeks the grid draws: a week with no day of THIS month (the sixth row, when a month ends on a Saturday and
  // the next begins on a Sunday) is a whole row of greyed next-month cells that says nothing, so it is not drawn.
  const shownWeeks = useMemo(() => weeks.filter((week) => week.some((day) => day.inMonth)), [weeks]);

  const exceptionsByDay = useMemo(() => {
    const map = new Map<string, PrivateCalendarException[]>();
    for (const exception of filteredExceptions) {
      map.set(exception.date, [...(map.get(exception.date) ?? []), exception]);
    }
    return map;
  }, [filteredExceptions]);

  // Agenda (List view): every in-month day that has items or exceptions, sorted,
  // each fully readable. Antidote to the cramped month grid.
  const agendaDays = useMemo(() => {
    const dates = new Set<string>();
    for (const date of itemsByDay.keys()) dates.add(date);
    for (const date of exceptionsByDay.keys()) dates.add(date);
    return Array.from(dates)
      .filter((date) => Number(date.slice(5, 7)) === month)
      .sort()
      .map((date) => ({
        date,
        dayExceptions: exceptionsByDay.get(date) ?? [],
        dayItems: sortTimelineItems(withoutPlanDrawnByATable(itemsByDay.get(date) ?? [])),
      }));
  }, [exceptionsByDay, itemsByDay, month]);

  // Kinds actually present in the (unfiltered-by-hide) data, in canonical order.
  const presentKinds = useMemo(() => {
    const present = new Set(items.map(privateCalendarItemKind));
    return privateCalendarActivityKinds.filter((kind) => present.has(kind));
  }, [items]);
  const noActivityDays = useMemo(
    () => new Set(exceptions.filter((exception) => exception.code === NO_ACTIVITY_CODE).map((exception) => exception.date)).size,
    [exceptions],
  );
  const otherCrmDays = useMemo(
    () => new Set(items.filter((item) => privateCalendarItemKind(item) === "other_crm").map((item) => `${item.employeeHrId ?? ""}|${item.startDate}`)).size,
    [items],
  );
  const activeFilterCount = [
    query.trim() !== "",
    kindFilter !== allValue,
    statusFilter !== allValue,
    employeeFilter !== allValue,
    departmentFilter !== allValue,
    lineFilter !== allValue,
    exceptionOnly,
    hiddenKinds.size > 0,
  ].filter(Boolean).length;

  const selectedItems = useMemo(
    () => filteredItems.filter((item) => privateCalendarItemOccursOn(item, selectedDate)),
    [filteredItems, selectedDate],
  );
  const selectedExceptions = useMemo(() => filteredExceptions.filter((exception) => exception.date === selectedDate), [filteredExceptions, selectedDate]);
  const timelineItems = useMemo(() => sortTimelineItems(withoutPlanDrawnByATable(selectedItems)), [selectedItems]);
  // "Exceptions" and "Days w/ Issues" count what needs review only. An info exception is a review
  // request's own status (pending, verified) — news for the employee, never an issue; counting it
  // made a verified correction read as one more problem day.
  const reviewExceptions = useMemo(() => exceptions.filter((exception) => exception.severity !== "info"), [exceptions]);
  const daysWithIssues = useMemo(
    () => new Set(reviewExceptions.map((ex) => ex.date)).size,
    [reviewExceptions],
  );
  const filteredReviewExceptions = useMemo(
    () => filteredExceptions.filter((exception) => exception.severity !== "info"),
    [filteredExceptions],
  );
  const [showAllExceptions, setShowAllExceptions] = useState(false);
  const stripExceptions = showAllExceptions ? filteredExceptions : filteredExceptions.slice(0, 8);
  const stripHeading = filteredReviewExceptions.length > 0
    ? `${filteredReviewExceptions.length} ${filteredReviewExceptions.every((exception) => exception.title === "No Activity Recorded")
      ? `No Activity Day${filteredReviewExceptions.length === 1 ? "" : "s"}`
      : `Exception${filteredReviewExceptions.length === 1 ? "" : "s"}`} Need${filteredReviewExceptions.length === 1 ? "s" : ""} Review`
    : `${filteredExceptions.length} Review Update${filteredExceptions.length === 1 ? "" : "s"}`;

  // Flag-this-day is a self-service action — only the employee whose calendar
  // this is can act on it, never a manager/admin paging through someone else's
  // calendar from the admin surface.
  const canActOnOwnDay = viewerHrId != null && privateCalendarHrIdKey(viewerHrId) === privateCalendarHrIdKey(selectedEmployee.hrId);

  // The review requests raised on the day in view, for the person whose calendar this is, each with
  // its reply thread. `?? []` because a browser still holding the previous bundle mid-deploy would
  // otherwise crash the whole calendar over a field that simply is not there yet.
  const selectedDayReviewRequests = useMemo(
    () => (reviewRequests ?? []).filter(
      (request) => request.date === selectedDate
        && privateCalendarHrIdKey(request.employeeHrId) === privateCalendarHrIdKey(selectedEmployee.hrId),
    ),
    [reviewRequests, selectedDate, selectedEmployee.hrId],
  );

  const [disputeFormOpen, setDisputeFormOpen] = useState(false);
  const [disputeClaimText, setDisputeClaimText] = useState("");
  const [disputeSourceOptions, setDisputeSourceOptions] = useState<string[]>([]);
  const [disputeSourceDetail, setDisputeSourceDetail] = useState("");
  const [disputeSubmitting, setDisputeSubmitting] = useState(false);
  const [disputeMessage, setDisputeMessage] = useState<string | null>(null);


  async function submitDayDispute() {
    setDisputeMessage(null);
    if (!disputeClaimText.trim() || disputeSourceOptions.length === 0) {
      setDisputeMessage("Tell us what actually happened, and where a Super Admin can verify it.");
      return;
    }
    if (disputeSourceOptions.includes("Other") && !disputeSourceDetail.trim()) {
      setDisputeMessage("Tell us where a Super Admin can verify this.");
      return;
    }
    setDisputeSubmitting(true);
    try {
      const claimSourceText = disputeSourceDetail.trim()
        ? `${disputeSourceOptions.join(", ")}: ${disputeSourceDetail.trim()}`
        : disputeSourceOptions.join(", ");
      const displayedSummary = timelineItems.length > 0
        ? timelineItems.map((item) => item.title).join(" | ")
        : selectedExceptions.length > 0
          ? selectedExceptions.map((exception) => exception.title).join(" | ")
          : "Nothing was shown for this day.";
      const response = await fetch("/api/private-calendar/disputes", {
        body: JSON.stringify({
          claimSourceText,
          claimText: disputeClaimText,
          displayedSummary,
          disputeDate: selectedDate,
          employeeName: selectedEmployee.fullName,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to submit this dispute.");
      setDisputeClaimText("");
      setDisputeSourceOptions([]);
      setDisputeSourceDetail("");
      setDisputeMessage("Request submitted — a Super Admin will review it.");
      // Re-read the month so the day shows its "Review Requested — Pending" status now, not
      // only after the next navigation. A failed refresh must not turn a sent request into an
      // error message, so it is swallowed here; Sync Now retries it.
      await loadWorkspace(year, month, selectedEmployee.hrId, selectedDate, viewMode).catch(() => undefined);
    } catch (error) {
      setDisputeMessage(error instanceof Error ? error.message : "Unable to submit this dispute.");
    } finally {
      setDisputeSubmitting(false);
    }
  }

  async function loadWorkspace(
    nextYear: number,
    nextMonth: number,
    employeeHrId: string,
    nextSelectedDate: string,
    nextViewMode: PrivateCalendarViewMode = viewMode,
  ) {
    const params = new URLSearchParams({
      employeeHrId,
      month: String(nextMonth),
      view: nextViewMode,
      year: String(nextYear),
      ...(actualOnly ? { actualOnly: "1" } : {}),
    });
    const response = await fetch(`/api/private-calendar?${params.toString()}`, { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(payload.message ?? "Unable to load private calendar.");
    setWorkspace(payload.data);
    setSelectedDate(nextSelectedDate);
    setLastSyncedAt(new Date());
  }

  // Re-runs the exact same live fetch as month/employee navigation, for the
  // CURRENTLY viewed month/employee — every source it reads (attendance,
  // vacation, excuse, CRM double visits) is queried straight from Phoenix's own
  // database with no cache in between, so this always reflects whatever is
  // currently there. It does not (and cannot) reach out to iReports360 itself —
  // that external pull is the scheduled cron's job.
  function syncNow() {
    setMessage(null);
    startTransition(async () => {
      try {
        await loadWorkspace(year, month, selectedEmployee.hrId, selectedDate, viewMode);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to sync private calendar.");
      }
    });
  }

  function shiftMonth(delta: number) {
    const base = new Date(Date.UTC(year, month - 1 + delta, 1));
    const nextYear = base.getUTCFullYear();
    const nextMonth = base.getUTCMonth() + 1;
    const preferredDay = Number(selectedDate.slice(8, 10)) || 1;
    const nextSelectedDate = monthDateIso(nextYear, nextMonth, preferredDay);
    setMessage(null);
    startTransition(async () => {
      try {
        await loadWorkspace(nextYear, nextMonth, selectedEmployee.hrId, nextSelectedDate);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load private calendar.");
      }
    });
  }

  function goToday() {
    const { year: todayYear, month: todayMonth } = currentCairoDateParts();
    setMessage(null);
    startTransition(async () => {
      try {
        await loadWorkspace(todayYear, todayMonth, selectedEmployee.hrId, todayIso());
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load private calendar.");
      }
    });
  }

  function changeEmployee(employeeHrId: string) {
    setMessage(null);
    setEmployeeFilter(allValue);
    startTransition(async () => {
      try {
        await loadWorkspace(year, month, employeeHrId, selectedDate, "employee");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load private calendar.");
      }
    });
  }

  function changeViewMode(nextViewMode: PrivateCalendarViewMode) {
    setMessage(null);
    setEmployeeFilter(allValue);
    setDepartmentFilter(allValue);
    setLineFilter(allValue);
    startTransition(async () => {
      try {
        await loadWorkspace(year, month, selectedEmployee.hrId, selectedDate, nextViewMode);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load private calendar.");
      }
    });
  }

  function resetFilters() {
    setKindFilter(allValue);
    setStatusFilter(allValue);
    setEmployeeFilter(allValue);
    setDepartmentFilter(allValue);
    setLineFilter(allValue);
    setExceptionOnly(false);
    setQuery("");
    setHiddenKinds(new Set());
  }

  function toggleKind(kind: PrivateCalendarActivityKind) {
    setHiddenKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  function toggleKeyFigures() {
    setKeyFiguresOpen((open) => {
      storeOpen(KEY_FIGURES_OPEN_KEY, !open);
      return !open;
    });
  }

  function toggleFilters() {
    setFiltersOpen((open) => {
      storeOpen(FILTERS_OPEN_KEY, !open);
      return !open;
    });
  }

  function focusException(date: string) {
    setSelectedDate(date);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      setCalendarView("list");
    }
  }

  return (
    <div className={isWorkspaceSurface ? "space-y-5" : "space-y-6"}>
      {!workspace.schemaReady ? (
        <div className="flex items-center gap-3 border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          Some private calendar sources are temporarily unavailable.
        </div>
      ) : null}

      {/* ── Header + Metrics ── */}
      <section className={panelClass}>
        <div className={[adminPanelHeaderClassName, "px-5 py-5"].join(" ")}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center gap-2 empty:hidden">
                {/* The portal page header above already names the page, so the employee surface
                    does not say "Private Calendar" a third time. */}
                {isWorkspaceSurface ? (
                  <span className="inline-flex items-center gap-1.5 bg-white/10 px-2.5 py-1 text-phx-xs font-black uppercase tracking-[0.14em] text-white/80 ring-1 ring-white/20">
                    Private Calendar
                  </span>
                ) : null}
                {workspace.access.isGlobalViewer ? (
                  <span className="inline-flex items-center gap-1.5 bg-phx-info/20 px-2.5 py-1 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-info-bg ring-1 ring-phx-info-line/30">
                    Global view
                  </span>
                ) : null}
                {isTeamView ? (
                  <span className="inline-flex items-center gap-1.5 bg-indigo-500/20 px-2.5 py-1 text-phx-xs font-black uppercase tracking-[0.14em] text-indigo-200 ring-1 ring-indigo-400/30">
                    Team mode
                  </span>
                ) : null}
              </div>
              <h2 className="text-3xl font-black leading-none tracking-tight text-white">{monthLabel(year, month)}</h2>
              <p className="mt-2 text-sm font-semibold text-slate-300">
                {isTeamView
                  ? `${teamSummary.length} visible employee${teamSummary.length === 1 ? "" : "s"}`
                  : selectedEmployee.fullName}{" "}
                {!isTeamView && showHrIds ? <span className="font-mono text-xs text-slate-400">{selectedEmployee.hrId}</span> : null}
              </p>
              <p className="mt-1 text-xs font-semibold text-slate-400">
                {isPending ? "Syncing" : lastSyncedAt ? `Synced at ${formatSyncedAt(lastSyncedAt)}` : null}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex border border-white/20 bg-white/10 p-0.5">
                {(["month", "list"] as const).map((mode) => (
                  <button
                    className={[
                      "h-9 px-3.5 text-xs font-black uppercase tracking-[0.1em] transition-colors",
                      calendarView === mode ? "bg-slate-900 text-white" : "text-white/70 hover:bg-white/15",
                    ].join(" ")}
                    key={mode}
                    onClick={() => setCalendarView(mode)}
                    type="button"
                  >
                    {mode === "month" ? "Month" : "List"}
                  </button>
                ))}
              </div>
              <button
                aria-label="Sync Now — refresh this calendar with whatever is currently recorded in Phoenix"
                className={["inline-flex h-9 items-center gap-1.5 bg-white/10 px-3 text-xs font-black text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-50", controlRadiusClass].join(" ")}
                disabled={isPending}
                onClick={syncNow}
                type="button"
              >
                <RefreshCw className={["h-3.5 w-3.5", isPending ? "animate-spin" : ""].join(" ")} />
                Sync Now
              </button>
              <a
                className={["inline-flex h-9 items-center gap-1.5 bg-white/10 px-3 text-xs font-black text-white/80 ring-1 ring-white/20 transition hover:bg-white/20", controlRadiusClass].join(" ")}
                href={`/api/private-calendar/export?format=xlsx&year=${year}&month=${month}&employeeHrId=${encodeURIComponent(selectedEmployee.hrId)}&view=${viewMode}${actualOnly ? "&actualOnly=1" : ""}`}
                download
              >
                <Download className="h-3.5 w-3.5" />
                XLSX
              </a>
              <a
                className={["inline-flex h-9 items-center gap-1.5 bg-white/10 px-3 text-xs font-black text-white/80 ring-1 ring-white/20 transition hover:bg-white/20", controlRadiusClass].join(" ")}
                href={`/api/private-calendar/export?format=pdf&year=${year}&month=${month}&employeeHrId=${encodeURIComponent(selectedEmployee.hrId)}&view=${viewMode}${actualOnly ? "&actualOnly=1" : ""}`}
                download
              >
                <Download className="h-3.5 w-3.5" />
                PDF
              </a>
              <div className="inline-flex items-center gap-2">
                <button
                  aria-label="Previous month"
                  className={["inline-flex h-9 w-9 items-center justify-center bg-white/10 text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-40", controlRadiusClass].join(" ")}
                  disabled={isPending}
                  onClick={() => shiftMonth(-1)}
                  type="button"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  className={["h-9 bg-orange-500 px-4 text-sm font-black text-white transition hover:bg-orange-400 disabled:opacity-50", controlRadiusClass].join(" ")}
                  disabled={isPending}
                  onClick={goToday}
                  type="button"
                >
                  Today
                </button>
                <button
                  aria-label="Next month"
                  className={["inline-flex h-9 w-9 items-center justify-center bg-white/10 text-white/80 ring-1 ring-white/20 transition hover:bg-white/20 disabled:opacity-40", controlRadiusClass].join(" ")}
                  disabled={isPending}
                  onClick={() => shiftMonth(1)}
                  type="button"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* KEY FIGURES — two narrow rows, folded away with one click (owner, 2026-09-21). Row one is
            every visit, per colour, AM · PM · Pharmacies apart — never a pharmacy inside PM; row
            two is every other kind of day. The eight tall cards this replaces took a screen of
            their own and counted a double visit twice across a team. */}
        <KeyFigures
          daysWithIssues={daysWithIssues}
          exceptionCount={reviewExceptions.length}
          noActivityDays={noActivityDays}
          onToggle={toggleKeyFigures}
          open={keyFiguresOpen}
          otherCrmDays={otherCrmDays}
          sourceReadiness={sourceReadiness}
          summary={summary}
          visitSummary={visitSummary}
        />
      </section>

      {message ? (
        <div className="flex items-center gap-3 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {message}
        </div>
      ) : null}

      {/* ── Filters — at most two narrow rows, folded away with one click (owner, 2026-09-21) ── */}
      <section className={secondaryPanelClass}>
        <button
          aria-controls="private-calendar-filters"
          aria-expanded={filtersOpen}
          className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-slate-50"
          onClick={toggleFilters}
          type="button"
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Filter &amp; Search</span>
            {activeFilterCount > 0 ? (
              <span className="bg-orange-500 px-1.5 py-0.5 text-phx-2xs font-black text-white">
                {activeFilterCount} active
              </span>
            ) : null}
          </span>
          <span className="inline-flex items-center gap-1 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
            {filtersOpen ? "Hide" : "Show"}
            {filtersOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </span>
        </button>
        {filtersOpen ? (
          <div
            className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-slate-100 px-4 py-3 lg:grid-cols-4 lg:items-end"
            id="private-calendar-filters"
          >
            {canFilterAcrossEmployees ? (
              <>
                <label className="col-span-2 block lg:col-span-1">
                  <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Search</span>
                  <span className="relative block">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <input
                      className={searchInputClass}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search calendar"
                      value={query}
                    />
                  </span>
                </label>

                <label className="block">
                  <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">View</span>
                  <SearchableSelect
                    className={inputClass}
                    wrapValue
                    disabled={isPending}
                    onChange={(event) => changeViewMode(event.target.value as PrivateCalendarViewMode)}
                    value={viewMode}
                  >
                    <option value="employee">Employee</option>
                    <option value="team">Team</option>
                  </SearchableSelect>
                </label>

                {!isTeamView ? (
                  <label className="block">
                    <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Employee</span>
                    <SearchableSelect
                      className={inputClass}
                      wrapValue
                      disabled={isPending}
                      onChange={(event) => changeEmployee(event.target.value)}
                      value={selectedEmployee.hrId}
                    >
                      {visibleEmployees.map((employee) => (
                        <option key={employee.hrId} value={employee.hrId}>
                          {employeeOptionLabel(employee, showHrIds)}
                        </option>
                      ))}
                    </SearchableSelect>
                  </label>
                ) : (
                  <label className="block">
                    <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Employee</span>
                    <SearchableSelect
                      className={inputClass}
                      wrapValue
                      onChange={(event) => setEmployeeFilter(event.target.value)}
                      value={employeeFilter}
                    >
                      <option value={allValue}>All visible</option>
                      {visibleEmployees.map((employee) => (
                        <option key={employee.hrId} value={employee.hrId}>
                          {employee.fullName} ({employee.hrId})
                        </option>
                      ))}
                    </SearchableSelect>
                  </label>
                )}

                <label className="block">
                  <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Line</span>
                  <SearchableSelect
                    className={inputClass}
                    wrapValue
                    onChange={(event) => setLineFilter(event.target.value)}
                    value={lineFilter}
                  >
                    <option value={allValue}>All lines</option>
                    {lineOptions.map((line) => <option key={line} value={line}>{line}</option>)}
                  </SearchableSelect>
                </label>

                <label className="block">
                  <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Department</span>
                  <SearchableSelect
                    className={inputClass}
                    wrapValue
                    onChange={(event) => setDepartmentFilter(event.target.value)}
                    value={departmentFilter}
                  >
                    <option value={allValue}>All departments</option>
                    {departmentOptions.map((department) => <option key={department} value={department}>{department}</option>)}
                  </SearchableSelect>
                </label>
              </>
            ) : null}

            <label className="block">
              <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Kind</span>
              <SearchableSelect
                className={inputClass}
                wrapValue
                onChange={(event) => setKindFilter(event.target.value)}
                value={kindFilter}
              >
                <option value={allValue}>All kinds</option>
                {presentKinds.map((kind) => (
                  <option key={kind} value={kind}>{privateCalendarActivityKindLabels[kind]}</option>
                ))}
              </SearchableSelect>
            </label>

            <label className="block">
              <span className="mb-1 block text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Status</span>
              <SearchableSelect
                className={inputClass}
                wrapValue
                onChange={(event) => setStatusFilter(event.target.value)}
                value={statusFilter}
              >
                <option value={allValue}>All statuses</option>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>{statusLabel(status)}</option>
                ))}
              </SearchableSelect>
            </label>

            <div className="col-span-2 flex flex-wrap items-end gap-2 lg:col-span-1">
              <button
                className={[
                  "inline-flex h-9 items-center gap-2 px-3 text-sm font-black ring-1 transition",
                  controlRadiusClass,
                  exceptionOnly
                    ? "bg-red-50 text-red-700 ring-red-200 hover:bg-red-100"
                    : "bg-slate-100 text-slate-700 ring-slate-200/60 hover:bg-slate-200",
                ].join(" ")}
                onClick={() => setExceptionOnly((value) => !value)}
                type="button"
              >
                <ListFilter className="h-4 w-4" />
                Exceptions
              </button>
              <button
                className={["h-9 bg-slate-100 px-3 text-sm font-black text-slate-600 ring-1 ring-slate-200/60 transition hover:bg-slate-200 disabled:opacity-50", controlRadiusClass].join(" ")}
                disabled={isPending}
                onClick={resetFilters}
                type="button"
              >
                Reset
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {isTeamView ? <TeamSummaryPanel rows={teamSummary} /> : null}

      {/* ── Colour key — one toggle per RECORDED kind (the day slot never draws a plan), plus No Activity Recorded ── */}
      {presentKinds.some((kind) => kind !== "plan") || noActivityDays > 0 ? (
        <section className={[secondaryPanelClass, "px-4 py-3"].join(" ")}>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">Key</span>
            {presentKinds.filter((kind) => kind !== "plan").map((kind) => {
              const hidden = hiddenKinds.has(kind);
              return (
                <button
                  aria-pressed={!hidden}
                  className={[
                    "inline-flex items-center gap-1.5 border px-2.5 py-1 text-phx-xs font-black transition",
                    controlRadiusClass,
                    hidden
                      ? "border-slate-200 bg-slate-50 text-slate-400 line-through"
                      : "border-slate-300 bg-white text-slate-800 hover:border-slate-500",
                  ].join(" ")}
                  key={kind}
                  onClick={() => toggleKind(kind)}
                  type="button"
                >
                  <span className={["h-3 w-3 shrink-0", hidden ? "bg-slate-300" : kindSwatchColor(kind)].join(" ")} />
                  <span>{privateCalendarActivityKindLabels[kind]}</span>
                </button>
              );
            })}
            {noActivityDays > 0 ? (
              <span className={`inline-flex items-center gap-1.5 border border-slate-300 bg-white px-2.5 py-1 text-phx-xs font-black text-slate-800 ${adminChipDepthClassName}`}>
                <span className={["h-3 w-3 shrink-0", noActivitySwatch].join(" ")} />
                <span>No Activity Recorded</span>
              </span>
            ) : null}
            {hiddenKinds.size > 0 ? (
              <button
                className={["inline-flex items-center px-2.5 py-1 text-phx-xs font-black text-orange-600 transition hover:text-orange-700", controlRadiusClass].join(" ")}
                onClick={() => setHiddenKinds(new Set())}
                type="button"
              >
                Show all
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Actionable exceptions strip ── */}
      {filteredExceptions.length > 0 ? (
        <section className={["border-l-4", filteredReviewExceptions.length > 0 ? "border-l-red-600" : "border-l-indigo-500", secondaryPanelClass].join(" ")}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
            <span className={["text-phx-xs font-black uppercase tracking-[0.14em]", filteredReviewExceptions.length > 0 ? "text-red-700" : "text-indigo-700"].join(" ")}>
              {stripHeading}
            </span>
            {filteredExceptions.length > 8 ? (
              <button
                className="text-phx-xs font-black uppercase tracking-[0.12em] text-orange-600 transition hover:text-orange-700"
                onClick={() => setShowAllExceptions((value) => !value)}
                type="button"
              >
                {showAllExceptions ? "Show the first 8" : `Show all ${filteredExceptions.length}`}
              </button>
            ) : null}
          </div>
          <div className="divide-y divide-slate-100">
            {stripExceptions.map((exception) => {
              const tone = exceptionTone(exception.severity);
              return (
                <button
                  className={["flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-5 py-3 text-left transition hover:bg-orange-50/60", tone.panel].join(" ")}
                  key={exception.id}
                  onClick={() => focusException(exception.date)}
                  type="button"
                >
                  <span aria-hidden="true" className={["h-2 w-2 shrink-0", tone.dot].join(" ")} />
                  <span className="whitespace-nowrap text-phx-xs font-bold tabular-nums text-slate-500">{reportDateLabel(exception.date)}</span>
                  <span className="text-sm font-black text-slate-900">{exception.title}</span>
                  {exception.employeeName ? (
                    <span className="inline-flex items-center bg-white px-1.5 py-0.5 text-phx-xs font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
                      {personLabel(exception.employeeName, exception.employeeHrId, showHrIds)}
                    </span>
                  ) : null}
                  <span className="w-full pl-4 text-phx-xs font-semibold leading-relaxed text-slate-600">
                    {exception.description}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {calendarView === "list" ? (
        <PrivateCalendarAgenda
          agendaDays={agendaDays}
          onSelectDate={setSelectedDate}
          showHrIds={showHrIds}
          viewMode={viewMode}
        />
      ) : (
      <div className="space-y-6">
        {/* ── Calendar Grid ── */}
        <section className={panelClass}>
          {/* FRIDAY is the only narrow column — do not shrink Saturday back.
              Friday is off for everyone (isFieldWorkforceFriday is unconditional), so it
              stays empty almost every week and gets a fixed minimal width. SATURDAY is
              NOT the weekend for the population this calendar reports on: Medical Rep and
              District (Sales) Manager have a Friday-only weekend
              (isFieldWorkforceFridayOnlyTitle) and work Sat-Wed as full days, so Saturday
              carries real activity chips AND is the day `no_activity_recorded` exceptions
              fire on — see the weekly-off note in src/lib/private-calendar/logic.ts. It
              needs an equal 1fr share like Sun-Thu. Keep this template identical on the
              header row and the day grid below or the columns misalign. */}
          <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_56px_minmax(0,1fr)] bg-slate-950">
            {weekdays.map((weekday) => (
              <div
                className={["px-1 py-3 text-center text-phx-2xs font-black uppercase tracking-[0.14em]", weekday === "Fri" ? "text-slate-500" : "text-slate-300"].join(" ")}
                key={weekday}
              >
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[repeat(5,minmax(0,1fr))_56px_minmax(0,1fr)] divide-x divide-y divide-slate-100">
            {shownWeeks.flatMap((week) => week).map((day, index) => {
              const date = day.date;
              // The day slot draws what was RECORDED, of every type (attendance, leave, holiday, visits, other CRM) and never
              // the plan: an approved plan is an intention, and it reads in the day's detail below, against the actual
              // (owner, 2026-10-20).
              const dayItems = (date ? itemsByDay.get(date) ?? [] : []).filter(isRecordedEntry);
              const dayExceptions = date ? exceptionsByDay.get(date) ?? [] : [];
              const selected = date === selectedDate;
              const isToday = date === today;
              // Three entries a day at most, findings first; the rest is "+ N more" and reads in full in the Daily
              // Timeline. The entries are compact (owner, 2026-10-29: "make it simple"), so a busy day shows three
              // where it used to show one beside a finding.
              const visibleExceptionCount = Math.min(dayExceptions.length, 2);
              const visibleItemCount = Math.min(dayItems.length, Math.max(1, 3 - visibleExceptionCount));
              const hiddenCount = dayItems.length + dayExceptions.length - visibleExceptionCount - visibleItemCount;
              // Friday — everyone's day off — is a quiet shade, so the working week reads at a glance.
              const isFriday = index % 7 === 5;
              const dayReviewCount = dayExceptions.filter((exception) => exception.severity !== "info").length;
              const dayNeedsReview = dayReviewCount > 0;
              const dayHasNoActivity = dayExceptions.some((exception) => exception.code === NO_ACTIVITY_CODE);
              // One marker per kind present that day, for the phone's compact month.
              const dayKinds = [...new Set(dayItems.map(privateCalendarItemKind))];
              return (
                <button
                  aria-current={isToday ? "date" : undefined}
                  aria-label={
                    date
                      ? `${dayLabel(date)}${isToday ? ", today" : ""}: ${dayItems.length} entr${dayItems.length === 1 ? "y" : "ies"}${dayExceptions.length > 0 ? `, ${dayExceptions.length} to review` : ""}`
                      : undefined
                  }
                  aria-pressed={selected}
                  className={[
                    // PHONE: a day column is ~49px wide, where the entries wrapped one letter per
                    // line down a 600px-tall cell. Below md the cell is a compact square — the date
                    // and one colour marker per source — and the day's entries read in full in
                    // the Daily Timeline under the grid. From md up the entries show in the cell.
                    // flex-col keeps the date at the TOP: a <button> centres its content
                    // vertically, which floated every date to the middle of a tall cell.
                    "flex min-h-[60px] flex-col items-center justify-start gap-1 px-0.5 py-1.5 text-left transition-colors md:min-h-[150px] md:items-stretch md:gap-0 md:p-2",
                    !day.inMonth
                      ? "bg-slate-50/60 text-slate-300 hover:bg-orange-50/30"
                      : isFriday
                        ? "bg-slate-50 text-slate-900 hover:bg-orange-50/60"
                        : "bg-white text-slate-900 hover:bg-orange-50/60",
                    selected ? "bg-orange-50/50 ring-2 ring-inset ring-orange-500" : "",
                  ].join(" ")}
                  disabled={!date}
                  key={`${date ?? "blank"}-${index}`}
                  onClick={() => date && setSelectedDate(date)}
                  type="button"
                >
                  <span className="flex items-center justify-between gap-1">
                    <span
                      className={[
                        "flex h-6 w-6 items-center justify-center text-xs font-black",
                        isToday ? "bg-orange-500 text-white" : "",
                      ].join(" ")}
                    >
                      {date ? Number(date.slice(8, 10)) : ""}
                    </span>
                    {/* ONE corner figure, and only for a day that needs review (owner, 2026-10-29: "chaos"). The two
                        counters it replaced — findings in indigo or red, entries in grey — sat side by side on every
                        day and said nothing the entries under them did not. */}
                    {dayNeedsReview ? (
                      <span
                        className="hidden bg-red-600 px-1.5 py-0.5 text-phx-2xs font-black text-white md:inline"
                        title={`${dayReviewCount} to review`}
                      >
                        {dayReviewCount}
                      </span>
                    ) : null}
                  </span>
                  {dayItems.length > 0 || dayExceptions.length > 0 ? (
                    <span className="flex flex-wrap justify-center gap-0.5 md:hidden">
                      {dayExceptions.length > 0 ? (
                        <span
                          aria-hidden="true"
                          className={["h-2 w-3.5", dayHasNoActivity ? noActivitySwatch : dayNeedsReview ? "bg-red-600" : "bg-indigo-500"].join(" ")}
                        />
                      ) : null}
                      {dayKinds.map((kind) => (
                        <span aria-hidden="true" className={["h-2 w-2", kindSwatchColor(kind)].join(" ")} key={kind} />
                      ))}
                      <span className="sr-only">
                        {dayItems.length} entr{dayItems.length === 1 ? "y" : "ies"}
                        {dayExceptions.length > 0 ? `, ${dayExceptions.length} to review` : ""}
                      </span>
                    </span>
                  ) : null}
                  <span className="mt-1.5 hidden space-y-1 md:block">
                    {dayExceptions.slice(0, visibleExceptionCount).map((exception) => (
                      <span
                        className={["block px-1.5 py-1 text-phx-2xs font-black leading-tight [overflow-wrap:anywhere]", exceptionChipTone(exception)].join(" ")}
                        key={exception.id}
                        title={exception.description}
                      >
                        {exception.title}
                      </span>
                    ))}
                    {dayItems.slice(0, visibleItemCount).map((item) => {
                      const tile = privateCalendarDayTile(item);
                      if (tile) return <VisitDayTile item={item} key={item.id} tile={tile} viewMode={viewMode} />;
                      // Every other entry keeps its short chip. A visit entry that cannot make a tile still never lists customers
                      // here: its first two lines are the kind and the counts, the rest is the Daily Timeline's.
                      const isVisit = isPrivateCalendarVisitKind(privateCalendarItemKind(item));
                      const baseLines = item.chipLines ?? [item.title];
                      const headLines = isVisit ? baseLines.slice(0, 2) : baseLines;
                      const lines = viewMode === "team" && item.employeeName ? [item.employeeName, ...headLines] : headLines;
                      return (
                        <span
                          className={[
                            // The first line names the entry (Office, the vacation type) in strong ink; the lines
                            // under it are its detail in a softer one. No rule between the lines: a short entry
                            // drawn as a ruled table is what made the month read as a mess.
                            "block space-y-0.5 px-1.5 py-1 text-phx-2xs font-semibold leading-tight text-slate-600 [&>span:first-child]:font-black [&>span:first-child]:text-slate-900",
                            kindChipTone(privateCalendarItemKind(item)),
                            severityOutline(item.severity),
                          ].join(" ")}
                          key={item.id}
                          title={chipTitle(item, viewMode)}
                        >
                          {lines.map((line, lineIndex) => (
                            <span className="block [overflow-wrap:anywhere]" key={lineIndex}>{line}</span>
                          ))}
                        </span>
                      );
                    })}
                    {hiddenCount > 0 ? (
                      <span className="block bg-slate-100 px-1.5 py-0.5 text-phx-2xs font-bold text-slate-600">
                        + {hiddenCount} more
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="border-t border-slate-100 bg-slate-50/60 px-4 py-2 text-phx-xs font-semibold text-slate-500">
            Each day shows its counts and tags. Press a day to read its visits in full in the Daily Timeline below.
          </p>
        </section>

        {/* ── Daily Timeline ── */}
        <section className={panelClass}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
            <div className="flex items-center gap-4">
              <div className="flex h-14 w-14 shrink-0 flex-col items-center justify-center bg-slate-950 text-white">
                <span className="text-xl font-black leading-none tabular-nums">{Number(selectedDate.slice(8, 10))}</span>
                <span className="mt-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-white/70">{shortMonthLabel(selectedDate)}</span>
              </div>
              <div>
                <div className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">
                  Daily Timeline
                </div>
                <h3 className="mt-1 text-xl font-black text-slate-950">{dayLabel(selectedDate)}</h3>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="bg-phx-paper px-4 py-1.5 text-xs font-black text-phx-ink-soft">
                {timelineItems.length} item{timelineItems.length === 1 ? "" : "s"} · {selectedExceptions.length} exception{selectedExceptions.length === 1 ? "" : "s"}
              </span>
              {canActOnOwnDay ? (
                <button
                  className="inline-flex h-8 items-center gap-1.5 border border-sky-300 bg-sky-50 px-3 text-xs font-black text-sky-700 transition hover:bg-sky-100"
                  onClick={() => { setDisputeFormOpen((open) => !open); setDisputeMessage(null); }}
                  type="button"
                >
                  <FileSearch className="h-3.5 w-3.5" />
                  Request review
                </button>
              ) : null}
            </div>
          </div>

          {disputeFormOpen ? (
            <div className="border-b border-sky-200 bg-sky-50/60 px-4 py-4 sm:px-6">
              <p className="text-xs font-black uppercase tracking-[0.1em] text-sky-700">Request a Review — {dayLabel(selectedDate)}</p>
              <p className="mt-1 text-xs font-semibold text-sky-800">
                If something here doesn&apos;t look right, let us know what actually happened and where a Super Admin can check.
              </p>
              <textarea
                className={`${phxTextareaClassName} mt-3`}
                onChange={(event) => setDisputeClaimText(event.target.value)}
                placeholder="What actually happened this day"
                rows={3}
                value={disputeClaimText}
              />
              <VerificationSourceMultiSelect
                borderClass="border-sky-200"
                focusRingClass="focus:border-sky-400"
                onChange={setDisputeSourceOptions}
                selected={disputeSourceOptions}
              />
              {disputeSourceOptions.length > 0 ? (
                <input
                  className={`${phxFieldClassName} mt-2`}
                  onChange={(event) => setDisputeSourceDetail(event.target.value)}
                  placeholder={disputeSourceOptions.includes("Other") ? "Describe the source" : "Additional details (optional)"}
                  type="text"
                  value={disputeSourceDetail}
                />
              ) : null}
              {disputeMessage ? <p className="mt-2 text-xs font-bold text-sky-900">{disputeMessage}</p> : null}
              <div className="mt-3 flex items-center gap-2">
                <button
                  className={phxButtonAccentClassName}
                  disabled={disputeSubmitting}
                  onClick={submitDayDispute}
                  type="button"
                >
                  {disputeSubmitting ? "Submitting" : "Submit"}
                </button>
                <button className={phxButtonGhostClassName} onClick={() => setDisputeFormOpen(false)} type="button">
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {/* The conversation on this day's review request. Shown to the person whose calendar this
              is — a reply is the other half of what he asked for, and it belongs beside the day it is
              about rather than in a separate inbox he would have to go and find. */}
          {canActOnOwnDay && selectedDayReviewRequests.length > 0 ? (
            <div className="space-y-3 border-b border-slate-100 bg-slate-50/60 px-4 py-4 sm:px-6">
              {selectedDayReviewRequests.map((request) => (
                <PrivateCalendarReviewRequestThread
                  canReply
                  claimAuthorLabel="You"
                  key={request.id}
                  onPosted={() => loadWorkspace(year, month, selectedEmployee.hrId, selectedDate, viewMode).catch(() => undefined)}
                  request={request}
                  viewerHrIdKey={viewerHrId ? privateCalendarHrIdKey(viewerHrId) : null}
                />
              ))}
            </div>
          ) : null}

          <div className="grid gap-6 p-4 sm:p-6 xl:grid-cols-[minmax(260px,360px)_minmax(0,1fr)]">
            {selectedExceptions.length > 0 ? (
              <section>
                <div className="mb-3 flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-red-600">
                  <AlertTriangle className="h-4 w-4" />
                  Exception Warnings
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                  {selectedExceptions.map((exception) => <ExceptionItem exception={exception} key={exception.id} showHrIds={showHrIds} />)}
                </div>
              </section>
            ) : null}

            <section className={selectedExceptions.length > 0 ? "min-w-0" : "min-w-0 xl:col-span-2"}>
              {timelineItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 border border-dashed border-slate-200 bg-slate-50/60 py-10 text-center">
                  <p className="text-sm font-semibold text-slate-400">No calendar items for this day.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <SourceNotesLegend items={timelineItems} />
                  <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                    {timelineItems.map((item) => (
                      <TimelineItem item={item} key={item.id} showHrIds={showHrIds} showSourceTrace={deskDetail} viewMode={viewMode} />
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        </section>
      </div>
      )}
    </div>
  );
}

function PrivateCalendarAgenda({
  agendaDays,
  onSelectDate,
  showHrIds,
  viewMode,
}: {
  agendaDays: { date: string; dayExceptions: PrivateCalendarException[]; dayItems: PrivateCalendarItem[] }[];
  onSelectDate: (date: string) => void;
  showHrIds: boolean;
  viewMode: PrivateCalendarViewMode;
}) {
  if (agendaDays.length === 0) {
    return (
      <div className={`border border-slate-200 bg-white p-10 text-center ${adminSoftDepthClassName}`}>
        <p className="text-sm font-bold text-slate-500">No calendar items this month.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <SourceNotesLegend items={agendaDays.flatMap((day) => day.dayItems)} />
      {agendaDays.map(({ date, dayExceptions, dayItems }) => (
        <div className={`overflow-hidden border border-slate-200 bg-white ${adminPanelDepthClassName}`} key={date}>
          <button
            className="flex w-full items-center justify-between gap-2 bg-slate-900 px-4 py-2.5 text-left transition-colors hover:bg-slate-800"
            onClick={() => onSelectDate(date)}
            type="button"
          >
            <span className="text-sm font-black text-white">{dayLabel(date)}</span>
            <span className="text-right text-phx-xs font-bold text-slate-300">
              {dayItems.length} item{dayItems.length === 1 ? "" : "s"}
              {dayExceptions.length > 0 ? ` · ${dayExceptions.length} exception${dayExceptions.length === 1 ? "" : "s"}` : ""}
            </span>
          </button>
          <div className="divide-y divide-slate-100">
            {dayExceptions.map((exception) => {
              const tone = exceptionTone(exception.severity);
              return (
                <div className={["border-l-[3px] px-4 py-3", tone.border, tone.panel].join(" ")} key={exception.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={["inline-block h-2.5 w-2.5 shrink-0", tone.dot].join(" ")} />
                    <span className="text-sm font-black text-slate-900">{exception.title}</span>
                    <span className={["ml-auto inline-flex items-center whitespace-nowrap px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em]", tone.badge].join(" ")}>
                      {tone.label}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px]">
                    {exception.employeeName ? (
                      <span className="inline-flex items-center bg-white px-1.5 py-0.5 text-phx-xs font-semibold text-slate-600 ring-1 ring-inset ring-slate-200">
                        {personLabel(exception.employeeName, exception.employeeHrId, showHrIds)}
                      </span>
                    ) : null}
                    <span className="w-full text-phx-xs font-semibold leading-relaxed text-slate-600">
                      {exception.description}
                    </span>
                  </div>
                </div>
              );
            })}
            {dayItems.map((item) => {
              const meta = [
                viewMode === "team" ? item.employeeName : null,
                item.time,
                ...plainDetailLines(item),
                item.description,
              ].filter((value): value is string => Boolean(value));
              return (
                <div className={["px-4 py-3", severityOutline(item.severity)].join(" ")} key={item.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={["inline-block h-2.5 w-2.5 shrink-0", kindSwatchColor(privateCalendarItemKind(item))].join(" ")} />
                    <span className="text-sm font-black text-slate-900">{item.title}</span>
                    <span className={["inline-flex items-center gap-1 whitespace-nowrap px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-800", kindChipTone(privateCalendarItemKind(item))].join(" ")}>
                      {privateCalendarActivityKindLabels[privateCalendarItemKind(item)]}
                    </span>
                    {item.status ? (
                      <span className="ml-auto inline-flex items-center whitespace-nowrap bg-phx-paper px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-phx-ink-soft">
                        {statusLabel(item.status)}
                      </span>
                    ) : null}
                  </div>
                  {meta.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px]">
                      {meta.map((value, index) => (
                        <span
                          className="inline-flex items-center bg-slate-50 px-1.5 py-0.5 text-phx-xs font-semibold text-slate-600 ring-1 ring-inset ring-slate-200/70"
                          key={`${item.id}-meta-${index}`}
                        >
                          {value}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {item.managerVisits && item.managerVisits.length > 0 ? (
                    <div className="mt-2.5 pl-[18px]">
                      <ManagerPlanActual plan={item.managerPlan ?? null} planUnread={item.managerPlanUnread === true} visits={item.managerVisits} />
                    </div>
                  ) : null}
                  {item.exceptionFlags.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5 pl-[18px]">
                      {item.exceptionFlags.map((flag) => (
                        <span className={["inline-flex items-center px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em]", flagTone(flag)].join(" ")} key={flag}>
                          {flag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

type KeyFiguresProps = {
  daysWithIssues: number;
  exceptionCount: number;
  noActivityDays: number;
  onToggle: () => void;
  open: boolean;
  otherCrmDays: number;
  sourceReadiness: PrivateCalendarWorkspace["sourceReadiness"];
  summary: PrivateCalendarWorkspace["summary"];
  visitSummary: PrivateCalendarWorkspace["visitSummary"];
};

// One narrow cell: the kind's swatch, its name, and its figure. A source that could not be read
// says so instead of showing a zero it never measured.
// One figure as a tile: the colour swatch and the label on top, the number under it. Tiles sit in a grid, so the
// figures line up in columns instead of running on in one ragged sentence, and a long value wraps inside its tile.
function KeyFigure({
  alert = false,
  big = false,
  label,
  ready = true,
  strong = false,
  swatch,
  value,
}: {
  alert?: boolean;
  /** A single number (a count of days) reads larger than a split ("AM 1 · PM 4"). */
  big?: boolean;
  label: string;
  ready?: boolean;
  /** The total tile: a darker frame so it reads as the sum of the colours beside it. */
  strong?: boolean;
  swatch?: string;
  value: string;
}) {
  return (
    <div className={["min-w-0 border bg-white px-3 py-2", strong ? "border-slate-900" : "border-slate-200"].join(" ")}>
      <p className="flex items-center gap-1.5">
        {swatch ? <span aria-hidden="true" className={["h-2.5 w-2.5 shrink-0", swatch].join(" ")} /> : null}
        <span className="min-w-0 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500 [overflow-wrap:anywhere]">{label}</span>
      </p>
      <p
        className={[
          "mt-1 font-black tabular-nums leading-tight [overflow-wrap:anywhere]",
          big ? "text-lg" : "text-sm",
          !ready ? "text-amber-700" : alert ? "text-red-700" : "text-slate-900",
        ].join(" ")}
      >
        {ready ? value : "Unavailable"}
      </p>
    </div>
  );
}

function KeyFigures({
  daysWithIssues,
  exceptionCount,
  noActivityDays,
  onToggle,
  open,
  otherCrmDays,
  sourceReadiness,
  summary,
  visitSummary,
}: KeyFiguresProps) {
  // A workspace from before the visit summary existed (an old cached response) reads as none.
  const visits = visitSummary ?? null;
  const visitsReady = sourceReadiness.double_visit !== false && sourceReadiness.field_visit !== false;
  const allVisits = visits ? formatVisitCountSplit(visits.all) : "AM 0 · PM 0 · Pharmacies 0";
  return (
    <div className="border-t border-slate-200">
      <button
        aria-controls="private-calendar-key-figures"
        aria-expanded={open}
        className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2 text-left transition hover:bg-slate-50"
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Key figures</span>
          {!open ? (
            <span className="text-xs font-bold text-slate-700">
              Visits {allVisits}
              {exceptionCount > 0 ? ` · ${exceptionCount} to review` : ""}
            </span>
          ) : null}
        </span>
        <span className="inline-flex items-center gap-1 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
          {open ? "Hide" : "Show"}
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </span>
      </button>
      {open ? (
        <div id="private-calendar-key-figures">
          {/* Row one — every visit, per colour, AM · PM · Pharmacies apart. */}
          <div className="border-t border-slate-100 bg-white px-4 py-3">
            <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Visits · AM, PM and Pharmacies counted apart</p>
            <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {privateCalendarVisitKinds.map((kind) => {
              const split = visits?.[kind];
              return (
                <KeyFigure
                  key={kind}
                  label={privateCalendarActivityKindLabels[kind]}
                  ready={visitsReady}
                  swatch={kindSwatchColor(kind)}
                  value={split && visitCountSplitTotal(split) > 0 ? formatVisitCountSplit(split, { compact: true }) : "None"}
                />
              );
            })}
            <KeyFigure label="All visits" ready={visitsReady} strong value={allVisits} />
            </div>
          </div>
          {/* Row two — every other kind of day. */}
          <div className="border-t border-slate-100 bg-slate-50 px-4 py-3">
            <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Days</p>
            <div className="grid grid-cols-2 gap-2 min-[560px]:grid-cols-3 lg:grid-cols-5 xl:grid-cols-10">
            <KeyFigure big label="Attendance" ready={sourceReadiness.attendance} swatch={kindSwatchColor("attendance")} value={String(summary.attendance)} />
            <KeyFigure big label="Vacations" ready={sourceReadiness.vacation} swatch={kindSwatchColor("vacation")} value={String(summary.vacation)} />
            <KeyFigure big label="Excuses" ready={sourceReadiness.excuse} swatch={kindSwatchColor("excuse")} value={String(summary.excuse)} />
            <KeyFigure big label="National" ready={sourceReadiness.holiday} swatch={kindSwatchColor("holiday")} value={String(summary.holiday)} />
            <KeyFigure big label="Trips" ready={sourceReadiness.outstation} swatch={kindSwatchColor("outstation")} value={String(summary.outstation ?? 0)} />
            <KeyFigure big label="Planned" ready={sourceReadiness.plan} swatch={kindSwatchColor("plan")} value={String(summary.plan ?? 0)} />
            <KeyFigure big label="Other CRM" ready={sourceReadiness.field_visit} swatch={kindSwatchColor("other_crm")} value={String(otherCrmDays)} />
            <KeyFigure alert={noActivityDays > 0} big label="No activity" swatch={noActivitySwatch} value={String(noActivityDays)} />
            <KeyFigure alert={exceptionCount > 0} big label="Exceptions" value={String(exceptionCount)} />
            <KeyFigure alert={daysWithIssues > 0} big label="Days with issues" value={String(daysWithIssues)} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TeamSummaryPanel({ rows }: { rows: PrivateCalendarWorkspace["teamSummary"] }) {
  const sortedRows = [...rows].sort((left, right) => right.exceptionCount - left.exceptionCount || left.fullName.localeCompare(right.fullName));
  return (
    <section className={`overflow-hidden border border-slate-200 bg-white ${adminPanelDepthClassName}`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-6 py-4">
        <div>
          <div className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">
            Manager Team Calendar
          </div>
          <h3 className="mt-1 text-lg font-black text-slate-950">Visible employees snapshot</h3>
        </div>
        <span className="bg-slate-100 px-4 py-1.5 text-xs font-black text-slate-600">
          {rows.length} employee{rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="grid max-h-72 gap-3 overflow-y-auto p-5 md:grid-cols-2 xl:grid-cols-3">
        {sortedRows.slice(0, 18).map((row) => (
          <article key={row.hrId} className={`border border-slate-200 bg-white p-4 ${adminPanelDepthClassName}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-sm font-black text-slate-900">{row.fullName}</h4>
                <p className="mt-0.5 text-phx-xs font-semibold text-slate-500">
                  {row.hrId}{row.lineName ? ` · ${row.lineName}` : ""}
                </p>
              </div>
              <span className={["shrink-0 px-2.5 py-0.5 text-phx-2xs font-black", row.exceptionCount ? "bg-red-600 text-white" : "bg-emerald-50 text-emerald-700"].join(" ")}>
                {row.exceptionCount} warn{row.exceptionCount === 1 ? "" : "s"}
              </span>
            </div>
            {/* The day kinds in the grid's own colours, then every visit AM · PM · Pharmacies
                apart — a pharmacy is never counted among the PM doctors. */}
            <div className="mt-3 grid grid-cols-3 gap-1.5 text-center text-phx-2xs font-black text-slate-800">
              {teamSummarySources.map(({ letter, source }) => (
                <span
                  aria-label={`${privateCalendarSourceLabels[source]}: ${row.sourceCounts[source]}`}
                  className={["px-1 py-1.5", kindChipTone(source)].join(" ")}
                  key={source}
                  title={privateCalendarSourceLabels[source]}
                >
                  {letter} {row.sourceCounts[source]}
                </span>
              ))}
            </div>
            <p className="mt-2 text-phx-xs font-bold text-slate-700">
              <span className="font-black uppercase tracking-[0.1em] text-slate-500">Visits </span>
              {row.visitCounts ? formatVisitCountSplit(row.visitCounts) : "AM 0 · PM 0 · Pharmacies 0"}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

// Multi-select "where can a Super Admin verify this" dropdown used by the
// Request Review form — a day's claim can point to more than one source at
// once (e.g. both CRM and a manager confirmation).
function VerificationSourceMultiSelect({
  borderClass,
  focusRingClass,
  onChange,
  selected,
}: {
  borderClass: string;
  focusRingClass: string;
  onChange: (next: string[]) => void;
  selected: string[];
}) {
  const [open, setOpen] = useState(false);

  function toggle(option: string) {
    onChange(selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option]);
  }

  return (
    <div className="relative mt-2">
      <button
        className={["flex w-full items-center justify-between border bg-white px-3 py-2 text-left text-sm text-slate-900 focus:outline-none", borderClass, focusRingClass].join(" ")}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className={selected.length > 0 ? "text-slate-900" : "text-slate-400"}>
          {selected.length > 0 ? selected.join(", ") : "Where can a Super Admin verify this?"}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      </button>
      {open ? (
        <div className={`absolute z-10 mt-1 w-full border border-slate-200 bg-white p-1.5 ${adminPanelDepthClassName}`}>
          {verificationSourceOptions.map((option) => (
            <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-50" key={option}>
              <input checked={selected.includes(option)} onChange={() => toggle(option)} type="checkbox" />
              {option}
            </label>
          ))}
          <button
            className="mt-1 w-full bg-slate-100 px-2 py-1.5 text-xs font-black text-slate-600 hover:bg-slate-200"
            onClick={() => setOpen(false)}
            type="button"
          >
            Done
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ExceptionItem({ exception, showHrIds }: { exception: PrivateCalendarException; showHrIds: boolean }) {
  const tone = exceptionTone(exception.severity);
  return (
    <article className={["border-l-4 p-4 ring-1", tone.border, tone.panelStrong].join(" ")}>
      <div className="min-w-0">
        <h4 className={["text-sm font-black", tone.title].join(" ")}>
          {exception.title}
        </h4>
        {exception.employeeName ? (
          <p className={["mt-1 text-xs font-semibold", tone.text].join(" ")}>
            {personLabel(exception.employeeName, exception.employeeHrId, showHrIds)}
          </p>
        ) : null}
      </div>
      <p className={["mt-2.5 text-xs font-semibold leading-relaxed", tone.text].join(" ")}>
        {exception.description}
      </p>
    </article>
  );
}

/**
 * The lines an item prints as text. An item that carries its visits in full (`managerVisits`) draws them as cards,
 * so the one-line versions of the same visits are held back here — they exist for the surfaces that print text
 * only (the dispute view, the search box).
 */
function plainDetailLines(item: PrivateCalendarItem): string[] {
  if (!item.managerVisits || item.managerVisits.length === 0) return item.detailLines;
  const cards = new Set(item.managerVisits.map((visit) => managerVisitLine(visit)));
  return item.detailLines.filter((line) => !cards.has(line));
}

/**
 * Where the entries on screen come from, once per source: the source's name and what it does and does not
 * change (the "read-only activity context" note). An entry never repeats either.
 */
function SourceNotesLegend({ items }: { items: PrivateCalendarItem[] }) {
  const sources = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.sourceLabel) continue;
    const notes = sources.get(item.sourceLabel) ?? new Set<string>();
    if (item.approvalImpact) notes.add(item.approvalImpact);
    sources.set(item.sourceLabel, notes);
  }
  if (sources.size === 0) return null;
  return (
    <section aria-label="Where these entries come from" className="border-y border-slate-200 px-4 py-3">
      <div className="flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
        <FileSearch className="h-3 w-3" />
        Recorded in
      </div>
      <ul className="mt-2 space-y-1.5 text-xs font-semibold text-slate-600">
        {Array.from(sources.entries()).map(([label, notes]) => (
          <li className="min-w-0 break-words" key={label}>
            <span className="font-black text-slate-800">{label}</span>
            {Array.from(notes).map((note) => (
              <span className="block text-slate-500" key={note}>{note}</span>
            ))}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TimelineItem({
  item,
  showHrIds,
  showSourceTrace,
  viewMode,
}: {
  item: PrivateCalendarItem;
  showHrIds: boolean;
  /** The admin-shell desk sees the system, table and record ID; everyone else sees only the source's name. */
  showSourceTrace: boolean;
  viewMode: PrivateCalendarViewMode;
}) {
  return (
    <article
      className={[
        "overflow-hidden border-l-4 bg-white ring-1",
        item.severity === "danger" ? "ring-red-300" : item.severity === "warning" ? "ring-orange-300" : "ring-slate-200/70",
        kindAccentColor(privateCalendarItemKind(item)),
        // A day that carries a table (a manager's plan against his visits) takes the whole row, so the table gets a
        // desk's width instead of a third of it.
        item.managerVisits && item.managerVisits.length > 0 ? "lg:col-span-full" : "",
      ].join(" ")}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={["inline-flex items-center gap-1.5 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-800", kindChipTone(privateCalendarItemKind(item))].join(" ")}>
                {privateCalendarActivityKindLabels[privateCalendarItemKind(item)]}
              </span>
              {item.time ? (
                <span className="bg-slate-100 px-2 py-0.5 text-phx-2xs font-black text-slate-600">
                  {item.time}
                </span>
              ) : null}
            </div>
            <h4 className="mt-2 text-sm font-black text-slate-950">{item.title}</h4>
            {viewMode === "team" && item.employeeName ? (
              <p className="mt-1 text-xs font-semibold text-slate-500">
                {personLabel(item.employeeName, item.employeeHrId, showHrIds)}
              </p>
            ) : null}
          </div>
          {item.status ? (
            <span className="max-w-[45%] shrink-0 break-words bg-phx-paper px-2.5 py-0.5 text-right text-phx-2xs font-black uppercase tracking-[0.1em] text-phx-ink-soft">
              {statusLabel(item.status)}
            </span>
          ) : null}
        </div>

        {item.exceptionFlags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {item.exceptionFlags.map((flag) => (
              <span key={flag} className={["px-2.5 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em]", flagTone(flag)].join(" ")}>
                {flag}
              </span>
            ))}
          </div>
        ) : null}

        {plainDetailLines(item).length > 0 ? (
          <ul className="mt-3 space-y-1 text-xs font-semibold text-slate-600">
            {plainDetailLines(item).map((line) => <li key={line} className="flex items-start gap-1.5"><span className="mt-1 h-1 w-1 shrink-0 bg-slate-400" />{line}</li>)}
          </ul>
        ) : null}

        {/* A district manager's day as ONE table — the plan, the actual, and the detail of every visit in the actual
            (owner, 2026-10-20). The same table the Phoenix CRM manager's day page draws. */}
        {item.managerVisits && item.managerVisits.length > 0 ? (
          <div className="mt-3">
            <ManagerPlanActual plan={item.managerPlan ?? null} planUnread={item.managerPlanUnread === true} visits={item.managerVisits} />
          </div>
        ) : null}

        {item.description ? (
          <p className="mt-3 text-xs font-semibold leading-relaxed text-slate-500">{item.description}</p>
        ) : null}

        {/* The note about what a source does and does not change, and the source's name, are said ONCE per
            source in the legend above the entries (SourceNotesLegend) - never on every entry. Database
            table names and record IDs (`ireports360_visits`, `v2_vacation_requests`, a UUID) are
            for the desk and stay per entry, because they differ per entry. */}
        {showSourceTrace ? (
          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">
              <FileSearch className="h-3 w-3" />
              Source trace
            </div>
            <p className="mt-1 break-words text-phx-xs font-semibold text-slate-400">{item.sourceSystem}{item.sourceTable ? ` · ${item.sourceTable}` : ""}</p>
            {item.sourceRecordId ? <p className="break-all font-mono text-phx-xs text-slate-400">ID: {item.sourceRecordId}</p> : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
