"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  Clock,
  Download,
  Eye,
  FileText,
  Pencil,
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
import { CountUpNumber } from "@/components/ui/count-up";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { MovePlanPeriod } from "@/components/employee-portal/move-plan-period";
import { PlanConversationThread } from "@/components/weekly-planning/plan-conversation-thread";
import type { AccessContext } from "@/lib/auth/permissions";
import { hrIdsMatch } from "@/lib/hr-id";
import { downloadFromApiRoute } from "@/lib/navigation/browser-navigation";
import {
  approvedRegionsForSeats,
  canonicalPlanningRegionName,
  ownPlanningRegionForOwner,
  planningAreaOptions,
  planningAreasForRegion,
  type PlanningOwner,
} from "@/lib/weekly-planning/regions";
import { cairoDate } from "@/lib/format/cairo-datetime";
import {
  decisionActorLabel,
  planHeadingLabel,
  planRowPartLabel,
  summarizeBulkApprove,
  type BulkApproveRow,
} from "@/lib/weekly-planning/plan-labels";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { PlanAdherenceBadge } from "@/components/weekly-planning/plan-adherence-report";
import { sameLineBookingWarning, type SameLinePlanBooking } from "@/lib/weekly-planning/calendar";
import { stalePlanDraftKeys } from "@/lib/weekly-planning/plan-draft-retention";
import {
  findMarketingDoubleVisitPartner,
  isMarketingDoubleVisit,
  MARKETING_DOUBLE_VISIT_TITLE,
  type MarketingDoubleVisitPartner,
} from "@/lib/weekly-planning/marketing-double-visit";
import {
  incompleteDaysHeading,
  pickedPeriodIsShown,
  planCommentFor,
  pruneSelectedPlanIds,
  type PlanCommentDrafts,
  viewerMayEditPlan,
  withoutPlanComment,
  withPlanComment,
} from "@/lib/weekly-planning/plan-editor-state";
import { nextFreePlanDay, placeSourcedPlanRow, planDayMode, planDayRowsForMode } from "@/lib/weekly-planning/plan-slot-merge";
import type { EmployeePlanKind, EmployeePlanStatus, PlanSlot, PlanWorkweek } from "@/lib/weekly-planning/plan-v1";
import {
  buildEmployeePlanPeriod,
  employeePlanActionLabel,
  employeePlanActivityTypes,
  HEAD_OFFICE_WORKWEEK,
  isDistrictManagerPlanTitle,
  isPastPlanWeek,
  isPlanLeaveActivity,
  planDayGapText,
  planRequiredSlotsByDate,
  planWorkweekAllowsHalfDays,
} from "@/lib/weekly-planning/plan-v1";
import type {
  EmployeePlan,
  EmployeePlanDecision,
  EmployeePlanItemInput,
  EmployeePlansWorkspace,
  PlanPrefillItem,
  PlanPrefillSource,
  VisitDetailInput,
} from "@/lib/weekly-planning/service";
import {
  phxFieldClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";
import { adminChipDepthClassName, adminControlDepthClassName, adminPanelDepthClassName, adminRecessedDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";

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
// Everything the Area picker needs, bundled so it can be threaded to the mobile sheet as one
// prop. `seats` is the AU seat model and is authoritative; `roster` is only a fallback for the
// case where the seat map could not be loaded at all.
type AreaSource = {
  seats: EmployeePlansWorkspace["planningAreaSeats"];
  roster: MedicalRepOption[];
  /**
   * The plan owner's own employee row, verbatim. It answers two different questions — which
   * district narrows the seat-model list (PlanningOwner) and which area the roster fallback has
   * to add back, since the owner is never in their own rep roster — so it is held ONCE rather
   * than copied into two fields that can drift apart.
   */
  owner: (PlanningOwner & { regionName?: string | null }) | null;
  /**
   * The one region this plan owner may plan in, or null when they choose. A District Manager
   * never chooses: his region IS his district, so it is stated rather than picked and he is left
   * with the one question that is actually his — which area (owner, 2026-09-12).
   */
  lockedRegion: string | null;
};
// "am" / "pm" (AM only, PM only) are offered only to a workweek that allows half days — the Group
// Product Manager's (planWorkweekAllowsHalfDays). The day then holds that one half and nothing else.
type DayMode = "full" | "split" | "am" | "pm";
type PlanningActivityValue = EmployeePlanItemInput["activityType"] | "Coaching" | typeof MARKETING_DOUBLE_VISIT_TITLE;

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

const noGeographyActivities = new Set<EmployeePlanItemInput["activityType"]>([
  "Office",
  "Admin",
  "Remote",
  "Vacation",
  "National Vacation",
  "Excuse",
  // An internal team meeting, unlike a generic "Meeting" (which may be with an
  // external party and need a location) -- no region/area to plan around.
  "Meeting with Team",
]);

const dayModeOptions: ReadonlyArray<{ label: string; value: DayMode }> = [
  { label: "Full day", value: "full" },
  { label: "AM / PM split", value: "split" },
];

const halfDayModeOptions: ReadonlyArray<{ label: string; value: DayMode }> = [
  ...dayModeOptions,
  { label: "AM only", value: "am" },
  { label: "PM only", value: "pm" },
];

const dayModeButtonLabels: Record<DayMode, string> = { full: "Full day", split: "AM / PM", am: "AM only", pm: "PM only" };

/**
 * The day-mode button that is lit. For a planner who may plan half days, a day holding one lone AM
 * or PM row reads "AM only" / "PM only"; for everyone else that day is still "AM / PM" (a Field
 * Force Thursday's single AM row), exactly as planDayMode decides.
 */
function shownDayMode(group: Pick<DayGroup, "mode" | "rows">, allowHalfDays: boolean): DayMode {
  const [only] = group.rows;
  if (allowHalfDays && group.rows.length === 1 && only && only.slot !== "full") return only.slot;
  return group.mode;
}

const trainingFormatOptions = ["Zoom", "Physical", "Other"] as const;

export const statusLabels: Record<EmployeePlanStatus, string> = {
  cancelled: "Cancelled",
  ceo_approved: "CEO approved",
  ceo_rejected: "CEO rejected",
  ceo_returned: "CEO returned",
  details_requested: "Details Required",
  draft: "Draft",
  edit_requested: "Edit requested",
  final_approved: "Final approved",
  hr_acknowledged: "HR acknowledged",
  manager_approved: "Manager approved",
  manager_rejected: "Manager rejected",
  manager_returned: "Manager returned",
  submitted: "Submitted",
};

// ---------------------------------------------------------------------------
// F4 — Draft autosave key helpers.
// ---------------------------------------------------------------------------
const DRAFT_VERSION = "v1";
function draftKey(hrId: string, kind: string, startDate: string) {
  return `phoenix:plan-draft:${DRAFT_VERSION}:${hrId}:${kind}:${startDate}`;
}

// Premium field controls (square corners, slate-300 border, orange focus ring) -
// matched to the Report It module's design language.
const cin = cn(phxFieldClassName, "h-8 w-full px-2 disabled:text-slate-400");
const tableSelectClass = `${phxSelectClassName} min-w-0`;
const tableInputClass = `${phxFieldClassName} min-w-0`;
// Taller field controls for the touch-friendly mobile bottom-sheet editor.
const mobileField  = phxFieldClassName;

// RowEditSheet's entrance motion. Scoped here (rendered inline by RowEditSheet
// itself, see below) rather than enterprise-shell.tsx's shared <style> block,
// because that block isn't guaranteed present -- PlansWorkspace also renders
// under AdminPageHero (/admin/weekly-plans) and WorkspaceFrame (/workspace/plans),
// neither of which wraps with EmployeePortalPageShell.
const planSheetMotionStyle = `
@keyframes plan-sheet-slide-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}
@keyframes plan-sheet-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
`;

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
  // Leave is never hand-declared inside a plan. "Vacation" and "National Vacation"
  // are injected (locked) from an approved vacation request / HR-confirmed national
  // holiday, and "Excuse" from an approved excuse request — so an employee can only
  // ever pick real work here. "Other" is dropped in favour of the explicit
  // "Coaching" entry below (Coaching still persists as activity_type="Other").
  ...employeePlanActivityTypes
    .filter((type) => !(["Excuse", "Vacation", "National Vacation", "Other"] as readonly string[]).includes(type))
    .flatMap((type) => [
      { label: activityLabel(type), value: type },
      // Sits beside Double Visit; planningActivityOptionsFor hides it from everyone but PMs and GPMs.
      ...(type === "Double Visit" ? [{ label: MARKETING_DOUBLE_VISIT_TITLE, value: MARKETING_DOUBLE_VISIT_TITLE }] : []),
    ]),
  { label: "Coaching", value: "Coaching" },
];

// Marketing Double Visit is offered to Product Managers and Group Product Managers only. A row that
// already holds one keeps it in the list, so its select never renders blank for a reviewer.
function planningActivityOptionsFor(includeMarketingDoubleVisit: boolean) {
  return includeMarketingDoubleVisit
    ? planningActivityOptions
    : planningActivityOptions.filter((option) => option.value !== MARKETING_DOUBLE_VISIT_TITLE);
}

// A plan the employee is still actively editing — the only statuses into which we
// re-overlay cross-domain sync (approved leave, HR holidays, submitted weekly
// plans). Deliberately excludes final_approved / hr_acknowledged so re-opening an
// approved plan never silently rewrites it.
const planSyncEditableStatuses = new Set<string>(["draft", "manager_returned", "ceo_returned"]);

function activitySelectValue(row: Pick<DraftItem, "activityTitle" | "activityType">): PlanningActivityValue {
  if (isMarketingDoubleVisit(row.activityType, row.activityTitle)) return MARKETING_DOUBLE_VISIT_TITLE;
  return isCoachingActivity(row.activityType, row.activityTitle) ? "Coaching" : row.activityType;
}

function activityValue(value: string): { activityTitle: string; activityType: EmployeePlanItemInput["activityType"] } {
  if (value === "Single Visit") return { activityTitle: "Single Visit", activityType: "Field" };
  if (value === "Coaching") return { activityTitle: "Coaching", activityType: "Other" };
  if (value === MARKETING_DOUBLE_VISIT_TITLE) return { activityTitle: MARKETING_DOUBLE_VISIT_TITLE, activityType: "Other" };
  const activityType = (employeePlanActivityTypes as readonly string[]).includes(value)
    ? (value as EmployeePlanItemInput["activityType"])
    : "Other";
  return { activityTitle: activityLabel(activityType), activityType };
}

function trainingFormatValue(value: string | null | undefined) {
  const current = String(value ?? "").trim();
  return (trainingFormatOptions as readonly string[]).includes(current) ? current : "";
}

// Premium activity-type colour system — a left accent bar + dot per activity so
// each plan day is instantly scannable.
function activityAccent(
  value: EmployeePlanItemInput["activityType"],
  activityTitle?: string | null,
): { bar: string; dot: string } {
  // Coaching is stored as activityType "Other" (see activityValue), so it would
  // otherwise fall through to the grey default below despite already having a
  // dedicated violet identity elsewhere (its resolved-rep text, see
  // medicalRepStatus) — violet-400 keeps it a recognisable sibling of Double
  // Visit (violet-500) without reusing that exact shade.
  if (isCoachingActivity(value, activityTitle)) return { bar: "bg-violet-400", dot: "bg-violet-400" };
  // Also stored as "Other"; the deepest violet keeps it in the Double Visit family.
  if (isMarketingDoubleVisit(value, activityTitle)) return { bar: "bg-violet-700", dot: "bg-violet-700" };
  switch (value) {
    case "Field":
      return { bar: "bg-orange-500", dot: "bg-orange-500" };
    case "Double Visit":
      return { bar: "bg-violet-500", dot: "bg-violet-500" };
    case "Training":
      return { bar: "bg-sky-500", dot: "bg-sky-500" };
    case "Meeting":
      return { bar: "bg-indigo-500", dot: "bg-indigo-500" };
    case "Meeting with Team":
      return { bar: "bg-blue-500", dot: "bg-blue-500" };
    case "Event":
      return { bar: "bg-fuchsia-500", dot: "bg-fuchsia-500" };
    case "Travel":
      return { bar: "bg-cyan-500", dot: "bg-cyan-500" };
    case "Vacation":
      return { bar: "bg-emerald-500", dot: "bg-emerald-500" };
    case "National Vacation":
      return { bar: "bg-emerald-600", dot: "bg-emerald-600" };
    case "Excuse":
      return { bar: "bg-amber-500", dot: "bg-amber-500" };
    case "Remote":
      return { bar: "bg-teal-500", dot: "bg-teal-500" };
    default:
      return { bar: "bg-slate-400", dot: "bg-slate-400" };
  }
}

// AM / PM / Full-day pill styling.
function slotPillClass(slot: PlanSlot): string {
  if (slot === "am") return "border-amber-200 bg-amber-50 text-amber-700";
  if (slot === "pm") return "border-indigo-200 bg-indigo-50 text-indigo-700";
  return "border-slate-200 bg-slate-100 text-slate-600";
}

const LEGEND_ACTIVITIES: EmployeePlanItemInput["activityType"][] = [
  "Field",
  "Double Visit",
  "Office",
  "Admin",
  "Training",
  "Meeting",
  "Meeting with Team",
  "Event",
  "Travel",
  "Remote",
  "Vacation",
  "National Vacation",
  "Excuse",
];

// Self-explanatory key for the activity colour accents + AM/PM pills.
function PlanActivityLegend({ showMarketingDoubleVisit = false }: { showMarketingDoubleVisit?: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 border border-slate-200 bg-white px-3 py-2 ${adminSoftDepthClassName}`}>
      <span className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-400">Legend</span>
      {LEGEND_ACTIVITIES.map((type) => (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-phx-xs font-bold text-slate-600" key={type}>
          <span className={`inline-block h-2 w-2 rounded-full ${activityAccent(type).dot}`} aria-hidden="true" />
          {activityLabel(type)}
        </span>
      ))}
      {/* Coaching isn't a real activityType (it's "Other" + title "Coaching", see
          isCoachingActivity) so it can't live in the LEGEND_ACTIVITIES array above —
          mirrors how planningActivityOptions appends it after its own filtered map. */}
      <span className="inline-flex items-center gap-1 whitespace-nowrap text-phx-xs font-bold text-slate-600">
        <span className={`inline-block h-2 w-2 rounded-full ${activityAccent("Other", "Coaching").dot}`} aria-hidden="true" />
        Coaching
      </span>
      {showMarketingDoubleVisit ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-phx-xs font-bold text-slate-600">
          <span className={`inline-block h-2 w-2 rounded-full ${activityAccent("Other", MARKETING_DOUBLE_VISIT_TITLE).dot}`} aria-hidden="true" />
          {MARKETING_DOUBLE_VISIT_TITLE}
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-phx-3xs font-black uppercase ${slotPillClass("am")}`}>AM</span>
        <span className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-phx-3xs font-black uppercase ${slotPillClass("pm")}`}>PM</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// F8 — VirtualList: renders a plain list when items ≤ threshold, or a
// windowed scroll container when items > threshold. Keeps reviewers with
// large queues smooth while staying invisible for typical plan sizes.
// ---------------------------------------------------------------------------
function VirtualList<T>({
  estimateSize = 72,
  items,
  renderItem,
  threshold = 40,
}: {
  estimateSize?: number | ((index: number) => number);
  items: T[];
  renderItem: (item: T, index: number) => React.ReactNode;
  threshold?: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- useVirtualizer intentionally returns non-memoizable functions; this is expected TanStack Virtual behavior
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize: typeof estimateSize === "number" ? () => estimateSize : estimateSize,
    getScrollElement: () => parentRef.current,
    overscan: 5,
  });

  if (items.length <= threshold) {
    return <>{items.map((item, i) => renderItem(item, i))}</>;
  }

  return (
    <div ref={parentRef} className="overflow-auto" style={{ maxHeight: "640px" }}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((vRow) => (
          <div
            key={vRow.key}
            style={{ left: 0, position: "absolute", top: 0, transform: `translateY(${vRow.start}px)`, width: "100%" }}
          >
            {renderItem(items[vRow.index], vRow.index)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// F5 — PlanDecisionTimeline: renders the full decision history of a plan.
// ---------------------------------------------------------------------------
export function PlanDecisionTimeline({ decisions }: { decisions: EmployeePlanDecision[] }) {
  if (decisions.length === 0) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
      <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">Decision History</p>
      <ol className="space-y-2">
        {decisions.map((d) => (
          <li className="group flex items-start gap-2.5 rounded-sm transition-colors duration-150 hover:bg-orange-50/60" key={d.id}>
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-orange-400 ring-4 ring-transparent transition-colors duration-150 group-hover:bg-orange-500 group-hover:ring-orange-100" />
            <div className="min-w-0">
              <p className="text-xs font-black text-slate-800">
                {employeePlanActionLabel(d.action)}
                {/* The decider's NAME (else the role they acted in) — never their HR id, which is a code. */}
                {decisionActorLabel(d) ? (
                  <span className="ml-1.5 font-semibold text-slate-500">
                    by {decisionActorLabel(d)}
                  </span>
                ) : null}
              </p>
              <p className="text-phx-2xs text-slate-500">
                {statusLabels[d.fromStatus]} → {statusLabels[d.toStatus]}
                {" · "}
                {/*
                  THE SHARED HELPER, NOT `toLocaleDateString("en-GB", { month: "short" })`.

                  `d.createdAt` is an INSTANT, and this is a `"use client"` component, so this text
                  node is built twice — by Node when the HTML renders and by the browser when React
                  hydrates. `month: "short"` in en-GB is the one field those two can disagree on:
                  CLDR 42 (ICU 72) renamed abbreviated September from "Sep" to "Sept", so Railway's
                  Node 24 and an older mobile browser produce different bytes for the same instant
                  and React discards the server HTML — hydration error #418.

                  This route is where that was still landing. #3336 fixed the header clock and #3337
                  the remaining routes, both on 2026-09-06, and /employee-portals/plans went on
                  erroring afterwards — verified by resolving the `release` on each event back to a
                  commit and confirming all of them already contained both fixes. This call site is
                  what they missed.

                  `cairoDate` renders the same shape (`02 Sept 2026`), pins Cairo, and takes only the
                  NUMERIC month from Intl, mapping it through a hand-written month table so every
                  engine emits the same string.

                  The `formatDate`/`formatMonthYear` helpers further down are NOT this bug and must
                  not be "fixed" to match: they render DATE-ONLY values in locale "en", where the
                  September abbreviation never changed, and their UTC zone is what stops a calendar
                  day shifting. Their own comment says so.
                */}
                {cairoDate(d.createdAt)}
              </p>
              {d.comment ? <p className="mt-0.5 text-phx-2xs italic text-slate-500">&quot;{d.comment}&quot;</p> : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function activityRule(value: EmployeePlanItemInput["activityType"], activityTitle?: string | null) {
  const isSingleVisit = value === "Field";
  const isDoubleVisit = value === "Double Visit";
  const isTraining = value === "Training";
  const isCoaching = isCoachingActivity(value, activityTitle);
  // Region → Area → partner, like Coaching's cascade — but the partner is a marketing colleague
  // picked from a list, never an auto-assigned Medical Rep.
  const isMarketingVisit = !isCoaching && isMarketingDoubleVisit(value, activityTitle);
  const showGeography = isSingleVisit || isDoubleVisit || isCoaching || isMarketingVisit || (!isTraining && !noGeographyActivities.has(value));
  return {
    autoRep: isDoubleVisit || isCoaching,
    label: isCoaching ? "Coaching" : isMarketingVisit ? MARKETING_DOUBLE_VISIT_TITLE : activityLabel(value),
    requiresArea: isSingleVisit || isDoubleVisit || isCoaching || isMarketingVisit,
    requiresPartner: isMarketingVisit,
    requiresRegion: isSingleVisit || isDoubleVisit || isCoaching || isMarketingVisit,
    requiresRep: isDoubleVisit || isCoaching,
    showArea: showGeography,
    showPartner: isMarketingVisit,
    showRegion: showGeography,
    showRep: isDoubleVisit || isCoaching,
    showTrainingFormat: isTraining,
  };
}

// The UI wants "" rather than null for an unrecognised region, so it can feed a <select>
// value directly. Everything else is the shared canonicaliser.
function canonicalRegion(value: string | null | undefined) {
  return canonicalPlanningRegionName(value) ?? "";
}

// Which regions this line's AU seat model actually has areas in — never the flat approved list
// applied to every line alike. Anti Infective's Delta 3 has no CNS/Pedia counterpart, so a
// region list shared across lines offers a region that then hands those two lines zero areas:
// the same dead-end cascading dropdown this file's Area picker already had to be fixed for once.
/**
 * Every geography row rewritten to the plan owner's locked region, or the rows untouched when
 * nobody is locked. A locked row is left alone: it comes from an approved leave or holiday and is
 * not the owner's to place. Returns the SAME array identity when there is nothing to change, so
 * memos keyed on the result do not churn.
 */
function withLockedRegion(rows: DraftItem[], lockedRegion: string | null): DraftItem[] {
  if (!lockedRegion) return rows;
  let changed = false;
  const next = rows.map((row) => {
    if (row.locked) return row;
    const rule = activityRule(row.activityType, row.activityTitle);
    if (!rule.showRegion || row.locationText === lockedRegion) return row;
    changed = true;
    return { ...row, locationText: lockedRegion };
  });
  return changed ? next : rows;
}

function regionOptions(source: AreaSource, currentRegion?: string | null): string[] {
  const options: string[] = source.lockedRegion
    ? [source.lockedRegion]
    : [...approvedRegionsForSeats(source.seats)];
  const current = String(currentRegion ?? "").trim();
  // Keep whatever the row already holds selectable, canonical or not. A plan submitted before
  // Upper Egypt was split stores the bare "Upper Egypt", which IS canonical and yet is no longer
  // one of a split line's options — dropping it would blank the Region box mid-edit.
  if (current && !options.some((region) => region.toLowerCase() === current.toLowerCase())) {
    options.push(current);
  }
  return options;
}

function today() {
  return currentCairoDateOnlyIso();
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// A day still sitting at the default blank "Office" — no region/area/objective/
// notes, not locked, not sourced. Used to nudge the user before they submit a
// week of untouched placeholder days.
type PlanMessage = { text: string; tone: "error" | "info" };

function isUntouchedRow(row: DraftItem) {
  return (
    !row.locked &&
    !row.source &&
    row.activityType === "Office" &&
    !String(row.locationText ?? "").trim() &&
    !String(row.area ?? "").trim() &&
    !String(row.objective ?? "").trim() &&
    !String(row.notes ?? "").trim()
  );
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

// How many already-elapsed weeks back a user can pick from the Plan week dropdown, to enter
// a historical plan (e.g. pasting in past activity) the same way as any other week.
const HISTORICAL_PLAN_WEEKS_BACK = 4;

function weeklyPlanWeekOptions(anchorDate: string, workweek: PlanWorkweek = HEAD_OFFICE_WORKWEEK) {
  const starts = new Set<string>();
  starts.add(buildEmployeePlanPeriod("weekly", anchorDate, workweek).periodStartDate);
  const firstFutureWeek = nextWeeklyPlanStart(today(), workweek);
  for (let index = 0; index < 12; index += 1) {
    starts.add(addDays(firstFutureWeek, index * 7));
  }
  // The week currently in progress is itself missing otherwise — only used below as the
  // anchor to step backward from — leaving a gap between "4 weeks ago" and "next week".
  const currentWeekStart = addDays(firstFutureWeek, -7);
  starts.add(currentWeekStart);
  for (let index = 1; index <= HISTORICAL_PLAN_WEEKS_BACK; index += 1) {
    starts.add(addDays(currentWeekStart, -7 * index));
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

// formatDate, formatDayNumber, formatMonthYear and formatDayName below all render DATE-ONLY values (a
// plan row's `activity_date`, a `date` column), which `new Date` parses as UTC midnight. UTC here is
// CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. None of
// these is an instant — do not "fix" them to Cairo.
export function formatDate(value: string) {
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

export function formatDayName(value: string) {
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
    // A Field Force Thursday is one AM row; it must not light "Full day". See planDayMode.
    mode: planDayMode(groupRows),
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

// Overlay cross-domain prefill onto seeded rows. Locked rows (leave, holidays,
// the submitted weekly plan) replace every unlocked row they overlap on that
// day — a split AM + PM week day clears the seeded "Full day" row too; sourced
// unlocked rows only fill an untouched day. See placeSourcedPlanRow.
function mergePrefillIntoRows(base: DraftItem[], prefill: PlanPrefillItem[]): DraftItem[] {
  if (prefill.length === 0) return base;
  const slotFilled = (row: DraftItem) =>
    Boolean(
      (row.activityType && row.activityType !== "Office") ||
        String(row.locationText ?? "").trim() ||
        String(row.area ?? "").trim() ||
        String(row.objective ?? "").trim(),
    );
  let rows = [...base];

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
    rows = placeSourcedPlanRow(rows, row, slotFilled);
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

function validateDraftRow(
  row: DraftItem,
  medicalRepOptions: MedicalRepOption[] = [],
  marketingPartners: readonly MarketingDoubleVisitPartner[] = [],
) {
  const issues: string[] = [];
  const rule = activityRule(row.activityType, row.activityTitle);
  const label = `${formatDate(row.activityDate)} ${slotLabel(row)}`;
  if (rule.requiresRegion && !canonicalRegion(row.locationText)) {
    issues.push(`${label}: ${rule.label} needs a region.`);
  }
  if (rule.requiresArea && !String(row.area ?? "").trim()) {
    issues.push(`${label}: ${rule.label} needs an area.`);
  }
  if (rule.requiresPartner && !findMarketingDoubleVisitPartner(marketingPartners, row.attendees)) {
    issues.push(`${label}: ${rule.label} needs who you are visiting with.`);
  }
  if (rule.requiresRep && needsLineSelection(medicalRepOptions) && !String(row.lineFilter ?? "").trim()) {
    issues.push(`${label}: ${rule.label} needs a line selected first.`);
  } else if (
    rule.requiresRep &&
    !autoRepForArea(medicalRepOptions, row.area ?? "", row.lineFilter) &&
    areaHasAssignableRep(medicalRepOptions, row.area ?? "")
  ) {
    // Only a real gap (a rep exists here but couldn't be resolved) blocks submission — an
    // area with no rep at all (vacant seat or none) is a valid, submittable choice; see
    // areaHasAssignableRep and the matching server-side relaxation in normalizeItem.
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

export function statusTone(status: EmployeePlanStatus) {
  if (status.includes("rejected")) return "border-red-200 bg-red-50 text-red-700";
  if (status.includes("returned")) return "border-amber-200 bg-amber-50 text-amber-700";
  if (status === "details_requested") return "border-orange-300 bg-orange-50 text-orange-700";
  if (status === "final_approved" || status === "hr_acknowledged")
    return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "submitted" || status === "edit_requested" || status === "manager_approved")
    return "border-sky-200 bg-sky-50 text-sky-700";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function isVacantMedicalRep(rep: MedicalRepOption) {
  const text = `${rep.fullName ?? ""} ${rep.hrId ?? ""}`.toLowerCase();
  return /\bvacan(t|cy)\b/.test(text);
}

// Whether an area has any real (non-vacant) rep at all, regardless of line
// disambiguation — used to tell "this area genuinely has no medical rep"
// (fine to submit, just nothing to show) apart from "a rep exists here but
// couldn't be resolved yet" (needs a line pick, still a real gap to fix).
function areaHasAssignableRep(options: MedicalRepOption[], area: string): boolean {
  if (!area) return false;
  return options.some((rep) => rep.areaName?.toLowerCase() === area.toLowerCase() && !isVacantMedicalRep(rep));
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

// The third step of the Marketing Double Visit cascade. It only appears once an area is picked, and
// lists the partners the server resolved — active Product Managers, Group Product Managers and the
// Marketing Manager, never the plan owner. The stored value is the partner's name.
function MarketingPartnerSelect({
  area,
  className,
  disabled,
  onChange,
  partners,
  value,
}: {
  area: string | null | undefined;
  className: string;
  disabled: boolean;
  onChange: (value: string) => void;
  partners: readonly MarketingDoubleVisitPartner[];
  value: string | null | undefined;
}) {
  if (!String(area ?? "").trim()) return <DisabledFieldText>Select area first</DisabledFieldText>;
  const selected = findMarketingDoubleVisitPartner(partners, value);
  return (
    <SearchableSelect
      className={className}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      value={selected?.fullName ?? value ?? ""}
      wrapValue
    >
      <option value="">Select partner</option>
      {value && !selected ? <option value={value}>{value}</option> : null}
      {partners.map((partner) => (
        <option key={partner.hrId} value={partner.fullName}>
          {partner.jobTitle ? `${partner.fullName} · ${partner.jobTitle}` : partner.fullName}
        </option>
      ))}
    </SearchableSelect>
  );
}

function medicalRepStatus(params: {
  activityLabel: string;
  area: string;
  autoRep: MedicalRepOption | null;
  medicalRepOptions: MedicalRepOption[];
  needsLine: boolean;
  lineFilter: string | null | undefined;
  // Mobile prefers a stored/looked-up name over a freshly recomputed autoRep
  // (see MobileDayCard) — optional so desktop/RowEditSheet, which have no such
  // stored value, can omit it and fall back to autoRep.fullName unchanged.
  resolvedName?: string;
}): { tone: "amber" | "slate" | "violet"; text: string } {
  if (!params.area) return { tone: "slate", text: "Select area first" };
  if (params.needsLine && !params.lineFilter) return { tone: "slate", text: "Select line first" };
  if (params.autoRep) {
    const name = params.resolvedName || params.autoRep.fullName;
    return { tone: "violet", text: `${params.activityLabel} - ${name}` };
  }
  if (!areaHasAssignableRep(params.medicalRepOptions, params.area)) {
    return { tone: "slate", text: "This area has no medical rep currently" };
  }
  return { tone: "amber", text: `${params.activityLabel} needs an assigned Medical Rep` };
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

// The areas offered for a region. The AU seat model decides (planningAreaOptions): a rep gets
// their own DM district, so an Upper Egypt 1 rep sees Minia 1 / Minia 2 / Beni Suef and never
// Assuit or Qena. Vacant areas are included on purpose; areaHasAssignableRep handles the
// "no rep for this area" case separately once one is picked.
//
// The roster-derived list survives only as a fallback for when the seat map is unavailable —
// it cannot see an area whose occupant has a blank area_name (Beni Suef), and it cannot
// express the district split at all.
function areasForRegion(source: AreaSource, region: string): string[] {
  const fromSeatModel = planningAreaOptions(source.seats, region, source.owner);
  if (fromSeatModel.length > 0) return fromSeatModel;
  return planningAreasForRegion(source.roster, region, source.owner);
}

/** Map raw service/DB/workflow errors to short, friendly, action-oriented messages. UI-only. */
function friendlyError(message: string): string {
  const text = message || "Action failed.";
  // The server answers a collision on the plan indexes with a sentence that is true (see
  // translatePlanUniqueViolation) and it passes through untouched. This branch is only the safety
  // net for a raw database duplicate that reached the form, and it must not claim the employee has
  // an active plan: the old text said so even when the clash was an approved plan being revised.
  // "already exists" is left out on purpose: assertNoActivePlanForSamePeriod writes that sentence
  // itself, names the status, and tells the person what to do.
  if (/duplicate key|active_period_uidx|one_live_revision_uidx|23505/i.test(text)) {
    return "This plan clashes with another plan saved for the same period. Open My Plans to check it, then try again.";
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

// The "flag" half of the wrong-week guard (owner, 2026-09-26): a plan filed for a week that had
// already begun or elapsed carries this amber chip so the owner and reviewers can see it at a
// glance. It marks; it never blocks. Square edges — this card can portal to <body>, escaping the
// shell's square-corner sweep, so the chip must be square in its own right (square-edge golden rule,
// AGENTS.md §4; tests/square-edge-portal-ratchet.test.ts).
function OffWindowBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 border border-amber-300 bg-amber-50 px-2 py-1 text-phx-xs font-black text-amber-700"
      title="Filed for a week that had already started or passed — flagged for review, not blocked."
    >
      <TriangleAlert className="h-3 w-3" />
      Off-window
    </span>
  );
}

function PlanPeriodControl({
  activeKind,
  anchorDate,
  chosen,
  disabled,
  idPrefix,
  onAnchorChange,
  plannedWeekStarts,
  workweek,
}: {
  activeKind: EmployeePlanKind;
  anchorDate: string;
  // The weekly Plan-week dropdown no longer auto-selects (owner, 2026-09-26). `chosen` is false for
  // a fresh weekly plan until the person picks a week by hand — the field then shows a placeholder
  // and saving/submitting is blocked until they choose. Always true for monthly and for an existing
  // plan being edited (its week is fixed).
  chosen: boolean;
  disabled: boolean;
  idPrefix: string;
  onAnchorChange: (value: string) => void;
  // Week START dates the owner already has a live plan for — marked green in the list so they can
  // avoid double-filing a week.
  plannedWeekStarts: Set<string>;
  workweek: PlanWorkweek;
}) {
  const period = buildEmployeePlanPeriod(activeKind, anchorDate, workweek);
  const inputClass  = phxFieldClassName;

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
          placeholder="Select a week…"
          value={chosen ? period.periodStartDate : ""}
        >
          {weeklyPlanWeekOptions(anchorDate, workweek).map((weekStart) => {
            const optionPeriod = buildEmployeePlanPeriod("weekly", weekStart, workweek);
            const planned = plannedWeekStarts.has(weekStart);
            return (
              <option data-tone={planned ? "planned" : undefined} key={weekStart} value={weekStart}>
                {formatDate(optionPeriod.periodStartDate)} to {formatDate(optionPeriod.periodEndDate)} - {optionPeriod.periodKey}
                {planned ? " · already planned" : ""}
              </option>
            );
          })}
        </SearchableSelect>
        {!chosen ? (
          <p className="text-xs font-bold text-orange-600">
            Pick the plan week — it is not chosen for you.
          </p>
        ) : null}
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
  // The Plan week no longer auto-selects for a fresh weekly plan (owner, 2026-09-26): it starts
  // UNCHOSEN and the person picks it by hand, so a plan is never filed for a week nobody chose.
  // True immediately when an existing plan is opened (its week is already fixed).
  const [weekChosen, setWeekChosen] = useState<boolean>(Boolean(initialSelectedPlan));
  const [selectedPlan, setSelectedPlan] = useState<string | null>(initialSelectedPlan?.id ?? null);
  // A District Manager's region is his own AU district and nothing else — he is not asked for it
  // (owner, 2026-09-12). Null for everyone else, and null too when the seat model cannot name his
  // district: an unresolvable lock has to fall back to the picker rather than guess.
  const lockedRegion = useMemo(() => {
    if (!isDistrictManagerPlanTitle(workspace.currentEmployee?.jobTitle ?? null)) return null;
    return ownPlanningRegionForOwner(workspace.planningAreaSeats, workspace.currentEmployee);
  }, [workspace.currentEmployee, workspace.planningAreaSeats]);
  const [rawRows, setRows] = useState<DraftItem[]>(() =>
    initialSelectedPlan
      ? draftRowsFromPlan(initialSelectedPlan, initialWorkspace.medicalRepOptions)
      : defaultRows(initialKind, initialAnchorDate, initialWorkweek),
  );
  // Every geography row carries the locked region, wherever the row came from — a fresh week, a
  // prefill, an older plan reopened for edit. DERIVED, never written back into state: stamping it
  // from an effect is a cascading render (and a lint error), and this reaches exactly the same
  // rows without one. Everything downstream reads `rows`, so rendering, validation and the submit
  // payload all see it — which is what makes "hard-coded" true of every entry point at once.
  const rows = useMemo(() => withLockedRegion(rawRows, lockedRegion), [lockedRegion, rawRows]);
  const [message, setMessage] = useState<PlanMessage | null>(null);
  // A failed action and a successful one used to render in the SAME sky-blue box, so a
  // rejection ("a plan already exists for this week") was indistinguishable from a
  // confirmation and got read as success. Tone travels WITH the text so they cannot drift.
  const showInfo = (text: string) => setMessage({ text, tone: "info" });
  const showError = (text: string) => setMessage({ text, tone: "error" });
  // One comment draft PER PLAN under review: a single shared string was sent on whichever plan was
  // decided next, so text typed for one employee's plan landed on another's.
  const [comments, setComments] = useState<PlanCommentDrafts>({});
  const updateComment = (planId: string, value: string) =>
    setComments((current) => withPlanComment(current, planId, value));
  const [returnNotes, setReturnNotes] = useState<Record<string, Record<string, string>>>({});
  const [visitDetailsPlan, setVisitDetailsPlan] = useState<EmployeePlan | null>(null);
  // Cross-domain prefill (approved vacation/excuse + monthly weekly sync),
  // scoped to the active (kind, period) so a stale fetch never overwrites a
  // newer one. Re-fetched whenever the employee opens a new period.
  const [prefillState, setPrefillState] = useState<{
    items: PlanPrefillItem[];
    nationalHolidayDates: string[];
    scopeKey: string;
  }>({
    items: [],
    nationalHolidayDates: [],
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
  // "Add day" has a day to add only while some period day is still unused (mobile and desktop).
  const hasFreePlanDay = nextFreePlanDay(periodDays, selectedDateSet) !== null;
  const requiredSlotsByDate = useMemo(
    () => planRequiredSlotsByDate(period.periodStartDate, period.periodEndDate, workweek),
    [period.periodEndDate, period.periodStartDate, workweek],
  );
  const workingDayCount = requiredSlotsByDate.size;
  const allowHalfDays = planWorkweekAllowsHalfDays(workweek);
  const plans = workspace.plans;
  const plan = plans.find((item) => item.id === selectedPlan) ?? null;
  const ownPlans = plans.filter(
    (item) => hrIdsMatch(item.employeeHrId, workspace.currentEmployee?.hrId),
  );
  // Weeks the owner already has a LIVE weekly plan for — a draft/cancelled/rejected one lays no
  // claim on the week (it mirrors the server's duplicate rule), so it does not count. Marked green
  // in the Plan-week dropdown so a week is never double-filed by mistake.
  const plannedWeekStarts = useMemo(() => {
    const dead = new Set<EmployeePlanStatus>(["draft", "cancelled", "manager_rejected", "ceo_rejected"]);
    return new Set(
      ownPlans
        .filter((item) => item.planKind === "weekly" && !dead.has(item.status))
        .map((item) => item.periodStartDate),
    );
  }, [ownPlans]);
  // The employee's most recent earlier weekly plan, for one-tap "copy last week".
  const previousWeeklyPlan = useMemo(() => {
    if (activeKind !== "weekly") return null;
    return (
      ownPlans
        .filter((item) => item.planKind === "weekly" && item.periodStartDate < period.periodStartDate && item.items.length > 0)
        .sort((left, right) => right.periodStartDate.localeCompare(left.periodStartDate))[0] ?? null
    );
  }, [ownPlans, activeKind, period.periodStartDate]);
  // HR_IDs are stored uppercase on the plan but normalized lowercase on the access
  // context — compare canonical keys, never raw strings (CLAUDE.md).
  //
  // There is NO Super Admin god-mode at the decide stages. The owner-locked approver model is
  // enforced server-side by assertManagerReviewer (direct manager only; CEO only when the plan
  // has no manager) and assertCeoReviewer (CEO only) — neither has a Super Admin branch. This
  // filter used to admit Super Admin anyway "mirroring the server guards", which was the exact
  // opposite of what those guards do: every row it added rendered live Approve/Return/Reject
  // buttons whose every click came back 403, on the platform's most-watched account. The Action
  // Center already models this correctly (resolveApproverPlanStage returns null for Super Admin,
  // pinned by tests/action-center-weekly-plans.test.ts) — this now matches it.
  //
  // Super Admin's real step is HR acknowledgement, which is the hrQueue below and is unaffected.
  const managerQueue = plans.filter(
    (item) => item.status === "submitted" && hrIdsMatch(item.managerHrId, access.hrId),
  );
  const editRequestQueue = plans.filter(
    (item) => item.status === "edit_requested" && hrIdsMatch(item.managerHrId, access.hrId),
  );
  // District Manager plans never reach a CEO decision — their manager's approval cascades
  // straight to final_approved (service.ts decideEmployeePlan), so they must never populate
  // this decide queue even during the brief/legacy window a plan sits at manager_approved.
  //
  // The one exception is the DMs reporting to Hany Saad: their second stage is decided by the
  // named second approver (second-approver.ts), so a plan resting at manager_approved under that
  // manager IS in that viewer's — and only that viewer's — review queue. The server enforces the
  // same identity in decideEmployeePlan (assertSecondApprover); this only decides what is listed.
  const isSecondStagePlanForViewer = (item: { managerHrId: string | null }) =>
    workspace.secondApproverManagerHrIds.some((managerHrId) => hrIdsMatch(managerHrId, item.managerHrId));
  const ceoQueue = plans.filter(
    (item) =>
      item.status === "manager_approved" &&
      ((access.role === "CEO" && !isDistrictManagerPlanTitle(item.employeeJobTitle)) ||
        isSecondStagePlanForViewer(item)),
  );
  // Read-only oversight: the CEO can still see every District Manager plan past the draft
  // stage, just never with a decide action — HR is the real approver-of-record for these. The
  // second approver reads every plan of the DMs he decides for, at every status and period (the
  // ones awaiting his decision sit in the review queue above instead).
  const districtManagerReadOnlyQueue = plans.filter(
    (item) =>
      item.status !== "draft" &&
      isDistrictManagerPlanTitle(item.employeeJobTitle) &&
      (access.role === "CEO" ||
        (isSecondStagePlanForViewer(item) && item.status !== "manager_approved")),
  );
  const hrQueue = plans.filter(
    (item) =>
      ["final_approved", "hr_acknowledged"].includes(item.status) &&
      workspace.canAcknowledgeHr,
  );
  const isOwnPlan = plan != null && ownPlans.some((p) => p.id === plan.id);
  // The server lets only the plan's owner (or a Super Admin) save or submit it (assertPlanOwner), so a
  // manager who opens a report's plan reads it instead of getting live buttons that answer 403.
  const mayEditPlan =
    plan == null ||
    viewerMayEditPlan({ planOwnerHrId: plan.employeeHrId, viewerHrId: access.hrId, viewerRole: access.role });
  const canEdit = planCanEdit(plan) && workspace.canSubmitPlans && mayEditPlan;
  const periodLocked = Boolean(plan);
  const dayGroups = useMemo(() => groupDraftRows(rows), [rows]);
  const dayGroupByDate = useMemo(
    () => new Map(dayGroups.map((group) => [group.activityDate, group])),
    [dayGroups],
  );
  const submitValidationIssues = useMemo(
    // Locked rows come from a trusted source (approved leave, HR national holiday,
    // or an authoritative submitted weekly plan) and are read-only, so they can
    // never be "fixed" here — validating them would raise unfixable blockers.
    () =>
      rows
        .filter((row) => !row.locked)
        .flatMap((row) => validateDraftRow(row, workspace.medicalRepOptions, workspace.marketingDoubleVisitPartners)),
    [rows, workspace.marketingDoubleVisitPartners, workspace.medicalRepOptions],
  );
  // Client mirror of the server workday guard: every required working slot must
  // be filled before submit. A "full" day needs a full entry OR both AM + PM;
  // a Field Thursday needs only AM. Server re-enforces this on submit.
  const incompleteDays = useMemo(() => {
    const slotsByDate = new Map<string, Set<PlanSlot>>();
    // The halves held by work, not leave: a half-day vacation or excuse never completes a Group
    // Product Manager's day alone (planDayGapText, the same rule the server's submit check reads).
    const workSlotsByDate = new Map<string, Set<PlanSlot>>();
    for (const row of rows) {
      const set = slotsByDate.get(row.activityDate) ?? new Set<PlanSlot>();
      set.add(row.slot);
      slotsByDate.set(row.activityDate, set);
      if (!isPlanLeaveActivity(row.activityType)) {
        const work = workSlotsByDate.get(row.activityDate) ?? new Set<PlanSlot>();
        work.add(row.slot);
        workSlotsByDate.set(row.activityDate, work);
      }
    }
    const issues: string[] = [];
    for (const [date, requirement] of requiredSlotsByDate) {
      const gap = planDayGapText(
        requirement,
        slotsByDate.get(date) ?? new Set<PlanSlot>(),
        workSlotsByDate.get(date) ?? new Set<PlanSlot>(),
      );
      if (gap !== null) issues.push(`${formatDayName(date)} ${formatDate(date)}${gap}`);
    }
    return issues;
  }, [requiredSlotsByDate, rows]);
  const needsAssignedRep = rows.some((row) => activityRule(row.activityType, row.activityTitle).requiresRep);
  const noSameLineReps = needsAssignedRep && workspace.medicalRepOptions.filter((rep) => !isVacantMedicalRep(rep)).length === 0;
  const noPlanRows = rows.length === 0;
  // A fresh weekly plan cannot be saved or submitted until its week is picked by hand (owner,
  // 2026-09-26). Editing an existing plan (week fixed) and monthly plans are unaffected.
  const needsWeekPick = activeKind === "weekly" && !plan && !weekChosen;
  const lineOptions = useMemo(() => lineOptionsFromReps(workspace.medicalRepOptions), [workspace.medicalRepOptions]);

  // Everything the Area picker reads, assembled once. The AU seat model decides; the roster
  // below it is only reached when that map could not be loaded.
  const areaSource = useMemo<AreaSource>(
    () => ({
      lockedRegion,
      owner: workspace.currentEmployee,
      roster: workspace.medicalRepOptions,
      seats: workspace.planningAreaSeats,
    }),
    [lockedRegion, workspace.currentEmployee, workspace.medicalRepOptions, workspace.planningAreaSeats],
  );
  const tableNeedsLine = lineOptions.length > 1;
  const submitBlocked = !canEdit || submitValidationIssues.length > 0 || incompleteDays.length > 0 || noSameLineReps || noPlanRows || needsWeekPick;
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
        medicalRepHrId: row.doubleVisitMedicalRepHrId || autoRep?.hrId,
        medicalRepName: row.doubleVisitMedicalRepName || autoRep?.fullName,
      });
      if (warning) map.set(row.key, warning);
    }
    return map;
  }, [rows, sameLineBookings, workspace.medicalRepOptions]);
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

  // Fetch cross-domain prefill (approved/pending leave, HR national holidays, and
  // the monthly weekly sync) whenever the active period changes, then overlay it
  // onto a brand-new draft OR an editable saved plan (draft / manager_returned /
  // ceo_returned) so it re-syncs every time the editor opens — not just on a
  // first-time draft. mergePrefillIntoRows preserves user input and locked rows
  // always win, so re-running is safe (it can never blank the submitted week).
  const selectedPlanStatusForSync = plan?.status ?? null;
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
        const nationalHolidayDates: string[] = payload.success ? payload.data.nationalHolidayDates ?? [] : [];
        setPrefillState({ items, nationalHolidayDates, scopeKey });
        const mergeable = !selectedPlan
          || (selectedPlanStatusForSync ? planSyncEditableStatuses.has(selectedPlanStatusForSync) : false);
        if (mergeable && items.length > 0) {
          setRows((current) => mergePrefillIntoRows(current, items));
        }
      })
      .catch(() => {
        if (active) setPrefillState({ items: [], nationalHolidayDates: [], scopeKey });
      });
    return () => {
      active = false;
    };
  }, [activeKind, anchorDate, prefillScopeKey, selectedPlan, selectedPlanStatusForSync, workspace.currentEmployee?.hrId]);

  // ---------------------------------------------------------------------------
  // F4 — Draft autosave / restore. Persists only the user-editable (unlocked)
  // rows to localStorage so refreshing the page doesn't wipe draft work.
  // A hydratedRef guard prevents SSR / hydration mismatches.
  // ---------------------------------------------------------------------------
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const currentHrId = workspace.currentEmployee?.hrId ?? "";

  // On mount: forget drafts for periods long gone, then restore this period's draft if there's no
  // selected plan. Without the sweep a draft was removed only when that same period's plan was saved, so
  // every period left unsaved stayed in the browser for good (2026-10-26 cache audit, P3).
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    try {
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index) ?? "");
      for (const key of stalePlanDraftKeys(keys, { currentVersion: DRAFT_VERSION, today: new Date() })) {
        localStorage.removeItem(key);
      }
    } catch {
      // localStorage unavailable — nothing to sweep
    }
    if (selectedPlan || !currentHrId) return;
    const key = draftKey(currentHrId, activeKind, period.periodStartDate);
    void (async () => {
      try {
        const saved = localStorage.getItem(key);
        if (saved) {
          const parsed: DraftItem[] = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setRows((current) => {
              const lockedRows = current.filter((row) => row.locked);
              const lockedKeys = new Set(lockedRows.map((row) => `${row.activityDate}|${row.slot}`));
              const restoredUnlocked = parsed.filter((row) => !lockedKeys.has(`${row.activityDate}|${row.slot}`));
              return sortDraftRows([...lockedRows, ...restoredUnlocked]);
            });
          }
        }
      } catch {
        // localStorage unavailable or corrupt — silently ignore
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally run once on mount

  // Debounced save: 800ms after rows change, persist unlocked rows.
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (selectedPlan || !currentHrId) return;
    const key = draftKey(currentHrId, activeKind, period.periodStartDate);
    const timer = setTimeout(() => {
      try {
        const unlockedRows = rows.filter((row) => !row.locked);
        localStorage.setItem(key, JSON.stringify(unlockedRows));
        setDraftSavedAt(new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
      } catch {
        // localStorage quota or unavailability — silently ignore
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [rows, selectedPlan, currentHrId, activeKind, period.periodStartDate]);

  // Clear draft when a plan is saved/selected or period changes.
  useEffect(() => {
    if (!currentHrId || !selectedPlan) return;
    const key = draftKey(currentHrId, activeKind, period.periodStartDate);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    void (async () => { setDraftSavedAt(null); })();
  }, [selectedPlan, currentHrId, activeKind, period.periodStartDate]);

  function discardDraft() {
    const key = draftKey(currentHrId, activeKind, period.periodStartDate);
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    setDraftSavedAt(null);
    resetRows(activeKind, anchorDate);
  }

  function resetRows(kind: EmployeePlanKind, date: string) {
    const normalizedDate = normalizeAnchorForKind(kind, date, workweek);
    const fresh = defaultRows(kind, normalizedDate, workweek);
    // The prefill effect only re-runs when its inputs change, so a reset onto the period already on
    // screen (Reset working days, Discard draft) would otherwise drop the approved-leave and holiday
    // rows while the "Auto-synced into this plan" banner kept claiming they are there. Overlay the
    // prefill already fetched for this very period; a different period is refilled by the effect.
    const freshScopeKey = `${workspace.currentEmployee?.hrId ?? ""}|${kind}|${buildEmployeePlanPeriod(kind, normalizedDate, workweek).periodStartDate}`;
    setRows(prefillState.scopeKey === freshScopeKey ? mergePrefillIntoRows(fresh, prefillState.items) : fresh);
    setSheetKey(null);
  }

  // One-tap "copy my previous week": remap each prior-week item onto the same
  // weekday of the current week. Locked (approved leave) slots are preserved and
  // never overwritten; copied days land inside the current period only.
  function copyPreviousWeek() {
    if (!previousWeeklyPlan) return;
    const prevStart = previousWeeklyPlan.periodStartDate;
    const curStart = period.periodStartDate;
    const curEnd = period.periodEndDate;
    setRows((current) => {
      const lockedRows = current.filter((row) => row.locked);
      const lockedKeys = new Set(lockedRows.map((row) => `${row.activityDate}|${row.slot}`));
      const copied: DraftItem[] = [];
      previousWeeklyPlan.items.forEach((item, index) => {
        const newDate = addDays(curStart, daysBetween(prevStart, item.activityDate));
        if (newDate < curStart || newDate > curEnd) return;
        const slot = slotFromTimes(item.startTime, item.endTime);
        if (lockedKeys.has(`${newDate}|${slot}`)) return;
        copied.push({
          activityDate: newDate,
          activityTitle: item.activityTitle,
          activityType: item.activityType,
          area: item.area ?? "",
          attendees: item.attendees ?? "",
          doubleVisitMedicalRepHrId: item.doubleVisitMedicalRepHrId ?? "",
          doubleVisitMedicalRepName: item.doubleVisitMedicalRepName ?? "",
          endTime: item.endTime ?? "",
          key: `copy-${newDate}-${slot}-${index}`,
          lineFilter: "",
          locationText: item.locationText ?? "",
          notes: item.notes,
          objective: item.objective ?? "",
          slot,
          sortOrder: index,
          startTime: item.startTime ?? "",
        });
      });
      return sortDraftRows([...lockedRows, ...copied]);
    });
    showInfo("Copied your previous week — review and adjust before submitting.");
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
            attendees: rule.showPartner ? row.attendees ?? "" : "",
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
            // A new region restarts the whole cascade, the partner included.
            attendees: rule.showPartner ? "" : row.attendees,
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
      const otherRows = sorted.filter((row) => row.activityDate !== activityDate);
      // The transition itself is pure (planDayRowsForMode) so its row keys stay unique per mode.
      return sortDraftRows([
        ...otherRows,
        ...planDayRowsForMode(dayRows, mode, (slot) =>
          createDraftRow(activityDate, current.length, `row-${slot}-${Date.now()}`, slot),
        ),
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
      // Every period day already has a row: add nothing. The old fallback (the day after the last
      // row) always landed outside the period, and the server rejects a date outside it.
      const nextDate = nextFreePlanDay(periodDays, current.map((row) => row.activityDate));
      if (nextDate === null) return current;
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
        showError(friendlyError(error instanceof Error ? error.message : "Action failed."));
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
    showInfo(submit ? "Plan submitted for direct manager review." : "Plan draft saved.");
  }

  // Guard against an accidental "empty week" submit: if every day is still an
  // untouched blank Office placeholder (no activity, area, objective, or notes),
  // confirm before sending it to the manager. Deliberately a soft nudge, not a
  // block — a genuine all-office week is valid, the user just clicks through.
  function requestSubmit() {
    // Defensive only: Save/Submit are disabled and an orange hint is shown until a week is picked
    // (needsWeekPick). No banner here — a disabled button is never clicked, and the error banner is
    // reserved for a failed action (tests/weekly-plan-error-banner-tone.test.ts).
    if (needsWeekPick) return;
    const allBlank = rows.length > 0 && rows.every(isUntouchedRow);
    if (
      allBlank &&
      !window.confirm(
        "Every day in this plan is still a blank 'Office' placeholder: no activity, area, or notes have been added.\n\nSubmit it to your manager anyway?",
      )
    ) {
      return;
    }
    runAction(() => submitPlan(true));
  }

  async function decide(planId: string, action: string) {
    const rowNotes = action.includes("return")
      ? Object.entries(returnNotes[planId] ?? {})
          .map(([itemId, note]) => ({ itemId, note: note.trim() }))
          .filter((n) => n.note)
      : [];
    const response = await fetch(`/api/weekly-plans/${planId}/decision`, {
      body: JSON.stringify({ action, comment: planCommentFor(comments, planId), returnNotes: rowNotes }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Decision failed.");
    setComments((current) => withoutPlanComment(current, planId));
    if (action.includes("return")) setReturnNotes((c) => ({ ...c, [planId]: {} }));
    showInfo("Decision recorded.");
  }

  async function requestPlanEdit(planId: string) {
    const response = await fetch(`/api/weekly-plans/${planId}/request-edit`, {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Request failed.");
    showInfo("Edit request sent to your manager.");
  }

  async function decideEditRequestAction(planId: string, decision: "approve" | "reject") {
    const response = await fetch(`/api/weekly-plans/${planId}/edit-request-decision`, {
      body: JSON.stringify({ comment: planCommentFor(comments, planId), decision }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Decision failed.");
    setComments((current) => withoutPlanComment(current, planId));
    showInfo(decision === "approve" ? "Edit approved — employee can now revise." : "Edit request rejected.");
  }

  async function doBulkApprove(planIds: string[]) {
    const response = await fetch("/api/weekly-plans/decisions/batch", {
      body: JSON.stringify({ action: "manager_approve", planIds }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? "Bulk approve failed.");
    return payload;
  }

  // The batch call succeeds even when some plans in it fail, so the outcome is read plan by plan:
  // the manager is told how many were approved and WHICH ones were not, and only the approved ones
  // are un-ticked — the rest stay selected so one more click retries exactly them.
  async function approveSelectedPlans(planIds: string[], onApproved: (approvedIds: string[]) => void) {
    const result = await doBulkApprove(planIds);
    const rows: BulkApproveRow[] = Array.isArray(result.data)
      ? result.data
      : planIds.map((planId) => ({ ok: (result.failed ?? 0) === 0, planId }));
    const summary = summarizeBulkApprove(planIds, rows, managerQueue);
    onApproved(summary.approvedIds);
    if (summary.tone === "info") {
      showInfo(summary.message);
      return;
    }
    // A partial failure is reported through runAction's catch, the one place a failure is shown in the
    // error tone. The queue is reloaded first so the plans that WERE approved leave it.
    await reload();
    throw new Error(summary.message);
  }

  async function doRequestVisitDetails(planId: string) {
    const response = await fetch(`/api/weekly-plans/${planId}/request-visit-details`, {
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message ?? "Request failed.");
    showInfo("Visit details requested. Employee has been notified.");
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
    showInfo("Visit details submitted. Plan resubmitted for manager review.");
  }

  async function acknowledge(planId: string) {
    const response = await fetch(`/api/weekly-plans/${planId}/acknowledge`, {
      body: JSON.stringify({ comment: planCommentFor(comments, planId) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok || !result.success)
      throw new Error(result.message ?? "Acknowledgement failed.");
    setComments((current) => withoutPlanComment(current, planId));
    showInfo("HR acknowledgement recorded.");
  }

  function loadPlanForEdit(target: EmployeePlan) {
    setSelectedPlan(target.id);
    setActiveKind(target.planKind);
    setAnchorDate(target.periodStartDate);
    setWeekChosen(true);
    setSheetKey(null);
    setRows(draftRowsFromPlan(target, workspace.medicalRepOptions));
  }

  function startNewPlan(kind: EmployeePlanKind = activeKind) {
    const nextAnchorDate = defaultPlanAnchorDate(kind, workweek);
    setSelectedPlan(null);
    setActiveKind(kind);
    setAnchorDate(nextAnchorDate);
    // A fresh weekly plan starts with its week UNCHOSEN — the person must pick it (owner, 2026-09-26).
    setWeekChosen(kind !== "weekly");
    resetRows(kind, nextAnchorDate);
    setMessage(null);
  }

  function onKindChange(kind: EmployeePlanKind) {
    const nextAnchorDate = defaultPlanAnchorDate(kind, workweek);
    setActiveKind(kind);
    setSelectedPlan(null);
    setAnchorDate(nextAnchorDate);
    setWeekChosen(kind !== "weekly");
    resetRows(kind, nextAnchorDate);
  }

  function onAnchorChange(value: string) {
    const nextAnchorDate = normalizeAnchorForKind(activeKind, value, workweek);
    if (activeKind === "weekly") {
      const picked = buildEmployeePlanPeriod("weekly", nextAnchorDate, workweek);
      const past = isPastPlanWeek({
        periodStartDate: picked.periodStartDate,
        todayIso: currentCairoDateOnlyIso(),
        workweek,
      });
      // Owner rule (2026-09-26): picking a week that has already started or passed asks once, then
      // the plan is FLAGGED for review — never blocked. Cancelling keeps the previous choice.
      if (
        past &&
        !window.confirm(
          `The week ${formatDate(picked.periodStartDate)} to ${formatDate(picked.periodEndDate)} has already started or passed.\n\nFile the plan for that earlier week anyway? It will be flagged as an off-window plan for your manager and HR to see.`,
        )
      ) {
        return;
      }
    }
    // Picking the period already on screen only confirms the week: resetting would drop the rows the
    // person has filled in, and the approved-leave rows with them (the prefill effect does not re-run
    // because nothing it depends on changed).
    if (
      pickedPeriodIsShown({
        kind: activeKind,
        pickedAnchorDate: nextAnchorDate,
        shownPeriodStartDate: period.periodStartDate,
        workweek,
      })
    ) {
      setWeekChosen(true);
      return;
    }
    setAnchorDate(nextAnchorDate);
    setWeekChosen(true);
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
      <div className="flex min-w-0 items-center gap-2">
        <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600" />
        <p className="min-w-0 text-sm font-black text-amber-800">{incompleteDaysHeading(allowHalfDays)}</p>
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
  const syncEligible = !selectedPlan || (plan ? planSyncEditableStatuses.has(plan.status) : false);
  const syncedBanner = syncEligible && (lockedSyncCount > 0 || weeklySyncCount > 0) ? (
    <div className="flex flex-wrap items-center gap-2 border border-sky-200 bg-sky-50/70 px-3 py-2 text-xs font-bold text-sky-800">
      <ShieldCheck className="h-4 w-4 shrink-0 text-sky-600" />
      <span className="whitespace-nowrap">Auto-synced into this plan:</span>
      {lockedSyncCount > 0 ? (
        <span className="inline-flex items-center whitespace-nowrap rounded-full bg-phx-info px-2 py-0.5 text-phx-2xs font-black uppercase text-white">
          {lockedSyncCount} approved leave
        </span>
      ) : null}
      {weeklySyncCount > 0 ? (
        <span className="inline-flex items-center whitespace-nowrap rounded-full bg-phx-info px-2 py-0.5 text-phx-2xs font-black uppercase text-white">
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

  const untouchedCount = useMemo(() => rows.filter(isUntouchedRow).length, [rows]);
  // Soft-check: National Vacation days that aren't on the official Egyptian
  // holiday calendar. Warn (never block) — only when prefill for this scope has
  // loaded, so we don't false-flag before the holiday list arrives.
  const nationalVacationWarnings = useMemo(() => {
    if (prefillState.scopeKey !== prefillScopeKey) return [] as string[];
    const holidays = new Set(prefillState.nationalHolidayDates);
    return rows
      .filter((row) => row.activityType === "National Vacation" && !row.locked && !holidays.has(row.activityDate))
      .map((row) => `${formatDayName(row.activityDate)} ${formatDate(row.activityDate)}`);
  }, [rows, prefillState, prefillScopeKey]);
  // Editor toolbar: copy-last-week shortcut, untouched-day hint, colour legend.
  const editorToolbar = canEdit ? (
    <div className="space-y-2">
      {(previousWeeklyPlan && !selectedPlan && activeKind === "weekly") || untouchedCount > 0 || draftSavedAt ? (
        <div className="flex flex-wrap items-center gap-2">
          {previousWeeklyPlan && !selectedPlan && activeKind === "weekly" ? (
            <button
              className="inline-flex items-center gap-1.5 rounded-sm border border-slate-900 bg-slate-900 px-3 py-2 text-xs font-black uppercase tracking-wide text-white transition-colors hover:bg-slate-800 disabled:opacity-50"
              disabled={isPending}
              onClick={copyPreviousWeek}
              type="button"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Copy last week
            </button>
          ) : null}
          {untouchedCount > 0 ? (
            <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-slate-200 bg-slate-50 px-2 py-1 text-phx-xs font-bold text-slate-500 ${adminChipDepthClassName}`}>
              {untouchedCount} day{untouchedCount === 1 ? "" : "s"} still empty
            </span>
          ) : null}
          {draftSavedAt && !selectedPlan ? (
            <>
              <p className="text-phx-xs text-slate-400">Draft saved {draftSavedAt}</p>
              <button
                className="text-phx-xs font-bold text-red-500 underline hover:text-red-700"
                onClick={discardDraft}
                type="button"
              >
                Discard draft
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {nationalVacationWarnings.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border border-amber-200 bg-amber-50 px-3 py-2">
          <TriangleAlert className="h-4 w-4 shrink-0 text-amber-600" />
          <span className="whitespace-nowrap text-xs font-bold text-amber-800">
            Not on the official holiday calendar — double-check:
          </span>
          {nationalVacationWarnings.map((label) => (
            <span
              className="inline-flex items-center whitespace-nowrap rounded-sm border border-amber-300 bg-white px-2 py-0.5 text-phx-xs font-bold text-amber-800"
              key={label}
            >
              {label}
            </span>
          ))}
        </div>
      ) : null}
      <PlanActivityLegend showMarketingDoubleVisit={workspace.canPlanMarketingDoubleVisit} />
    </div>
  ) : null;

  // Red for a rejection, sky for a confirmation. role=alert makes a screen reader announce
  // the failure instead of leaving it as a silent colour change.
  const messageBanner = message ? (
    <div
      className={
        message.tone === "error"
          ? "flex items-start gap-2 border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800"
          : "flex items-start gap-2 border border-sky-200 bg-sky-50 p-3 text-sm font-semibold text-sky-800"
      }
      role={message.tone === "error" ? "alert" : "status"}
    >
      {message.tone === "error" ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : null}
      <span>{message.text}</span>
    </div>
  ) : null;

  return (
    <>
      {visitDetailsPlan && (
        <VisitDetailsModal
          isSubmitting={isPending}
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
        {editorToolbar}

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
              className={`shrink-0 rounded-full border px-2.5 py-1 text-phx-xs font-black shadow-sm ${statusTone(plan?.status ?? "draft")}`}
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
              chosen={!needsWeekPick}
              disabled={periodLocked || isPending || !workspace.canSubmitPlans}
              idPrefix="mobile"
              onAnchorChange={onAnchorChange}
              plannedWeekStarts={plannedWeekStarts}
              workweek={workweek}
            />
            {periodLocked && workspace.canSubmitPlans ? (
              <button
                className={`inline-flex h-10 items-center justify-center gap-1.5 border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 active:bg-slate-50 ${adminChipDepthClassName}`}
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
                className={`inline-flex h-11 items-center justify-center gap-1.5 border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 active:bg-slate-50 ${adminChipDepthClassName}`}
                onClick={() => downloadFromApiRoute("/api/weekly-plans/export?format=xlsx")}
                type="button"
              >
                <Download className="h-4 w-4" />
                XLSX
              </button>
              <button
                className={`inline-flex h-11 items-center justify-center gap-1.5 border border-slate-200 bg-white px-3 text-sm font-bold text-slate-700 active:bg-slate-50 ${adminChipDepthClassName}`}
                onClick={() => downloadFromApiRoute("/api/weekly-plans/export?format=pdf")}
                type="button"
              >
                <Download className="h-4 w-4" />
                PDF
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
        </div>

        {/* Mini KPIs */}
        <div className="grid grid-cols-3 gap-2">
          <Kpi label="Drafts" value={workspace.summary.drafts} />
          <Kpi label="Pending" value={workspace.summary.managerPending + workspace.summary.ceoPending} />
          <Kpi label="Approved" value={workspace.summary.finalApproved} />
          {/* Desktop's KPI row breaks Returned/Rejected out as their own tiles; mobile
              stays at 3 tiles normally, but a plan needing attention gets no above-the-
              fold signal otherwise -- surface a 4th tile only when one exists. */}
          {workspace.summary.returned + workspace.summary.rejected > 0 ? (
            <div className="col-span-3">
              <Kpi
                label="Needs attention (Returned + Rejected)"
                tone="red"
                value={workspace.summary.returned + workspace.summary.rejected}
              />
            </div>
          ) : null}
        </div>

        {messageBanner}

        {plan ? <WorkflowTimeline status={plan.status} /> : null}
        {plan ? <PlanConversationThread key={plan.id} planId={plan.id} /> : null}

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
              className="flex w-full items-center justify-center gap-1.5 border border-dashed border-orange-300 bg-orange-50/40 py-3 text-sm font-bold text-orange-600 active:bg-orange-50 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!hasFreePlanDay}
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
          <QueueCard onFillDetails={setVisitDetailsPlan} onOpen={loadPlanForEdit} plans={ownPlans} title="My Plans" />
          <ReviewCard
            comments={comments}
            isPending={isPending}
            onBulkApprove={(planIds, onApproved) => runAction(() => approveSelectedPlans(planIds, onApproved))}
            onComment={updateComment}
            onDecision={(planId, action) => runAction(() => decide(planId, action))}
            onRequestDetails={(p) => runAction(() => doRequestVisitDetails(p.id))}
            onReturnNote={updateReturnNote}
            plans={managerQueue}
            returnNotes={returnNotes}
            title="Manager Review"
            type="manager"
          />
          <ReviewCard
            comments={comments}
            isPending={isPending}
            onComment={updateComment}
            onDecision={(planId, decision) => runAction(() => decideEditRequestAction(planId, decision as "approve" | "reject"))}
            plans={editRequestQueue}
            title="Edit Requests"
            type="edit_request"
          />
          <ReviewCard
            comments={comments}
            isPending={isPending}
            onComment={updateComment}
            onDecision={(planId, action) => runAction(() => decide(planId, action))}
            onReturnNote={updateReturnNote}
            plans={ceoQueue}
            returnNotes={returnNotes}
            title={access.role === "CEO" ? "CEO Review" : "Final Review"}
            type="ceo"
          />
          <QueueCard
            onFillDetails={() => {}}
            onOpen={loadPlanForEdit}
            plans={districtManagerReadOnlyQueue}
            readOnly
            showEmployeeName
            title="District Manager Plans"
          />
          <ReviewCard
            comments={comments}
            isPending={isPending}
            onComment={updateComment}
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
              className="fixed inset-x-0 z-30 flex gap-2 border-t border-slate-200 bg-white/95 px-4 pb-3 pt-3 shadow-[0_-12px_28px_rgba(15,23,42,0.10)] backdrop-blur md:hidden"
              style={{ bottom: actionBarBottom }}
            >
              {isOwnPlan && plan?.status === "edit_requested" ? (
                <span className="flex flex-1 items-center justify-center gap-1.5 border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-700">
                  <Clock className="h-4 w-4 shrink-0" />
                  Edit request pending
                </span>
              ) : isOwnPlan && plan?.status === "submitted" ? (
                <Button
                  className="flex-1"
                  disabled={isPending}
                  onClick={() => runAction(() => requestPlanEdit(plan.id))}
                  variant="secondary"
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  Request to Edit
                </Button>
              ) : (
                <>
                  <Button
                    className="flex-1"
                    disabled={isPending || !canEdit || noPlanRows || needsWeekPick}
                    onClick={() => runAction(() => submitPlan(false))}
                    variant="secondary"
                  >
                    Save draft
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={isPending || submitBlocked}
                    onClick={requestSubmit}
                  >
                    <Send className="mr-2 h-4 w-4" />
                    Submit
                  </Button>
                </>
              )}
            </div>,
            document.body,
          )
        : null}

      {/* Mobile bottom-sheet row editor */}
      {mounted && sheetRow
        ? createPortal(
            <RowEditSheet
              canEdit={canEdit && !sheetRow.locked}
              locked={Boolean(sheetRow.locked)}
              lockedLabel={sheetRow.sourceLabel}
              canPlanMarketingDoubleVisit={workspace.canPlanMarketingDoubleVisit}
              marketingPartners={workspace.marketingDoubleVisitPartners}
              medicalRepOptions={workspace.medicalRepOptions}
              onClose={() => setSheetKey(null)}
              onDayMode={(mode) => setDayMode(sheetRow.activityDate, mode)}
              onDayNote={(value) => updateDayNotes(sheetRow.activityDate, value)}
              onDelete={() => deleteRow(sheetRow.key)}
              onUpdate={(field, value) => updateRow(sheetRow.key, field, value)}
              onUpdateLine={(value) => updateRowLine(sheetRow.key, value)}
              areaSource={areaSource}
              dayMode={sheetGroup ? shownDayMode(sheetGroup, allowHalfDays) : "full"}
              dayModeChoices={allowHalfDays ? halfDayModeOptions : dayModeOptions}
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
        {editorToolbar}

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
              <p className="text-phx-xs font-black uppercase tracking-[0.18em] text-orange-500">{headerLabel}</p>
              <h2 className="mt-1 text-base font-black text-slate-800">
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
                  <span className={`rounded-sm border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600 ${adminSoftDepthClassName}`}>
                  {workingDayCount} working days default
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-col gap-3 bg-white px-4 py-3 lg:flex-row lg:items-end lg:justify-between">
            <div className={`inline-flex w-full rounded-sm border border-slate-200 bg-slate-50 p-1 sm:w-auto ${adminSoftDepthClassName}`}>
              {(["weekly", "monthly"] as const).map((kind) => (
                <button
                  className={`min-h-10 flex-1 rounded-sm px-4 text-sm font-black transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/70 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-50 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none ${
                    activeKind === kind
                      ? "bg-slate-950 text-white shadow-[0_10px_22px_rgba(15,23,42,0.20)]"
                      : "text-slate-700 hover:bg-white hover:text-slate-900"
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
                chosen={!needsWeekPick}
                disabled={periodLocked || isPending || !workspace.canSubmitPlans}
                idPrefix="desktop"
                onAnchorChange={onAnchorChange}
                plannedWeekStarts={plannedWeekStarts}
                workweek={workweek}
              />
              {!needsWeekPick ? (
                <span className="inline-flex h-10 items-center rounded-sm border border-slate-200 bg-white px-3 text-sm font-black text-slate-700 shadow-sm">
                  {period.periodKey}
                </span>
              ) : null}
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
        {plan ? <PlanConversationThread key={plan.id} planId={plan.id} /> : null}

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
                  <p className="text-phx-xs font-black uppercase tracking-[0.2em] text-orange-400">Planning table</p>
                  <h3 className="mt-1 text-lg font-black leading-tight tracking-tight">
                    {activeKind === "weekly" ? "Weekly activities" : "Monthly activities"}
                  </h3>
                  <p className="mt-1 text-sm font-semibold text-slate-300">
                    Build each day with activity, geography, medical rep context, and notes.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-white/15 bg-white/10 px-3 text-xs font-black text-slate-100 transition hover:border-orange-400/70 hover:text-orange-200"
                    onClick={() => downloadFromApiRoute("/api/weekly-plans/export?format=xlsx")}
                    type="button"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Export XLSX
                  </button>
                  <button
                    className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-white/15 bg-white/10 px-3 text-xs font-black text-slate-100 transition hover:border-orange-400/70 hover:text-orange-200"
                    onClick={() => downloadFromApiRoute("/api/weekly-plans/export?format=pdf")}
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
                          downloadFromApiRoute(
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
                          downloadFromApiRoute(
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
                  disabled={!canEdit || !hasFreePlanDay}
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
                <span className="rounded-sm border border-slate-200 bg-white px-2.5 py-1.5 shadow-sm transition-colors duration-150 hover:border-slate-300 hover:bg-slate-50">
                  Rows: {rows.length}
                </span>
                <span className="rounded-sm border border-slate-200 bg-white px-2.5 py-1.5 shadow-sm transition-colors duration-150 hover:border-slate-300 hover:bg-slate-50">
                  Period days: {periodDays.length}
                </span>
              </div>
            </div>

            {/* Fits the screen with no horizontal scroll (AGENTS.md §4): Date and Actions hold fixed
                widths, the three field columns share what is left, and Region and Area stack in one
                cell. Never bring back a min-width over an overflow-x-auto wrapper. */}
            <div className="bg-white">
              <table className="w-full table-fixed border-collapse" data-portal-desktop-table>
                <colgroup>
                  <col className="w-[12rem]" />
                  <col />
                  <col />
                  <col />
                  {/* 5.5rem: the tracked uppercase "Actions" header is ~66px and overflows a 72px cell. */}
                  <col className="w-[5.5rem]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-slate-50">
                  <tr className="border-b border-slate-200 text-left text-phx-xs font-black uppercase tracking-[0.16em] text-slate-500">
                    <th className="px-4 py-3">Date</th>
                    <th className="px-3 py-3">Activity</th>
                    <th className="px-3 py-3">Region / Area</th>
                    <th className="px-3 py-3">
                      {workspace.canPlanMarketingDoubleVisit ? "Medical Rep / Partner" : "Medical Rep"}
                    </th>
                    <th className="px-3 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {dayGroups.map((group, groupIndex) => {
                    const groupWarnings = group.rows.flatMap((row) =>
                      validateDraftRow(row, workspace.medicalRepOptions, workspace.marketingDoubleVisitPartners),
                    );
                    const groupConflictWarnings = Array.from(
                      new Set(
                        group.rows
                          .map((row) => rowConflictWarning.get(row.key))
                          .filter((warning): warning is string => Boolean(warning)),
                      ),
                    );
                    const hasReturnNotes = group.rows.some((row) => row.returnNotes?.length);
                    const groupLocked = group.rows.some((row) => row.locked);
                    const rowTone = hasReturnNotes
                      ? "bg-amber-50/70"
                      : groupLocked
                        ? "bg-violet-50/40"
                        : groupIndex % 2 === 0
                          ? "bg-white"
                          : "bg-slate-50/45";

                    return (
                      <Fragment key={group.activityDate}>
                        {group.rows.map((row, slotIndex) => {
                          const rule = activityRule(row.activityType, row.activityTitle);
                          const availableAreas = areasForRegion(areaSource, row.locationText ?? "");
                          const autoRep = rule.autoRep ? autoRepForArea(workspace.medicalRepOptions, row.area ?? "", row.lineFilter) : null;
                          const currentRegionOptions = regionOptions(areaSource, row.locationText);
                          const showLineSelect = tableNeedsLine && rule.showRep;
                          const locked = Boolean(row.locked);

                          return (
                            <tr className={`align-middle transition-colors hover:bg-orange-50/35 ${rowTone}`} key={row.key}>
                              {slotIndex === 0 ? (
                                <td className="px-4 py-3 align-top" rowSpan={group.rows.length}>
                                  <time
                                    className="flex flex-wrap items-center gap-x-3 gap-y-2"
                                    dateTime={group.activityDate}
                                    title={group.activityDate}
                                  >
                                    <span className="flex h-16 w-20 shrink-0 flex-col items-center justify-center border border-orange-200 bg-gradient-to-b from-orange-50 to-white shadow-[0_6px_18px_rgba(249,115,22,0.08)]">
                                      <span className="text-phx-2xs font-black uppercase tracking-wide text-orange-500">
                                        {formatDayName(group.activityDate)}
                                      </span>
                                      <span className="mt-0.5 text-xl font-black leading-none text-slate-950">
                                        {formatDayNumber(group.activityDate)}
                                      </span>
                                      <span className="mt-1 text-phx-2xs font-black uppercase tracking-wide text-slate-500">
                                        {formatMonthYear(group.activityDate)}
                                      </span>
                                    </span>
                                    <div className="min-w-0">
                                      <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-400">
                                        Plan day
                                      </p>
                                      <p className="mt-1 text-sm font-black text-slate-900">Day {groupIndex + 1}</p>
                                    </div>
                                  </time>
                                  <div
                                    aria-label="Day mode"
                                    className={`mt-3 grid grid-cols-2 border border-slate-200 bg-slate-50 p-0.5 ${adminSoftDepthClassName}`}
                                    role="group"
                                  >
                                    {(allowHalfDays ? (["full", "split", "am", "pm"] as const) : (["full", "split"] as const)).map((mode) => (
                                      <button
                                        aria-pressed={shownDayMode(group, allowHalfDays) === mode}
                                        className={`h-8 px-2 text-phx-xs font-black transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/70 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-50 disabled:cursor-not-allowed disabled:opacity-50 ${
                                          shownDayMode(group, allowHalfDays) === mode
                                            ? "bg-slate-950 text-white shadow-[0_4px_10px_rgba(15,23,42,0.18)]"
                                            : "text-slate-600 hover:bg-white"
                                        }`}
                                        disabled={!canEdit || groupLocked}
                                        key={mode}
                                        onClick={() => setDayMode(group.activityDate, mode)}
                                        type="button"
                                      >
                                        {dayModeButtonLabels[mode]}
                                      </button>
                                    ))}
                                  </div>
                                </td>
                              ) : null}
                              <td className="px-3 py-3">
                                <div className="mb-1 flex items-center gap-1.5">
                                  <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${activityAccent(row.activityType, row.activityTitle).dot}`} aria-hidden="true" />
                                  <span
                                    className={`inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-wide ${slotPillClass(row.slot)}`}
                                  >
                                    {slotLabel(row)}
                                  </span>
                                  {row.sourceLabel ? (
                                    <span
                                      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-wide ${
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
                                  wrapValue
                                >
                                  {planningActivityOptionsFor(
                                    workspace.canPlanMarketingDoubleVisit || isMarketingDoubleVisit(row.activityType, row.activityTitle),
                                  ).map((option) => (
                                    <option key={option.value} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </SearchableSelect>
                              </td>
                              <td className="px-3 py-3">
                                {showLineSelect ? (
                                  // The margin sits on a wrapper, not in the className: a wrapping field
                                  // paints its box and its value as two items in one grid cell, and a
                                  // margin on both would take 6px off the field's own minimum height.
                                  <div className="mb-1.5">
                                    <SearchableSelect
                                      className={tableSelectClass}
                                      disabled={!canEdit}
                                      onChange={(e) => updateRowLine(row.key, e.target.value)}
                                      value={row.lineFilter ?? ""}
                                      wrapValue
                                    >
                                      <option value="">Select line</option>
                                      {lineOptions.map((line) => (
                                        <option key={line} value={line}>
                                          {line}
                                        </option>
                                      ))}
                                    </SearchableSelect>
                                  </div>
                                ) : null}
                                {rule.showTrainingFormat ? (
                                  <SearchableSelect
                                    className={tableSelectClass}
                                    disabled={!canEdit}
                                    onChange={(e) => updateRow(row.key, "locationText", e.target.value)}
                                    value={trainingFormatValue(row.locationText)}
                                    wrapValue
                                  >
                                    <option value="">Optional format</option>
                                    {trainingFormatOptions.map((format) => (
                                      <option key={format} value={format}>
                                        {format}
                                      </option>
                                    ))}
                                  </SearchableSelect>
                                ) : rule.showRegion ? (
                                  areaSource.lockedRegion ? (
                                    <StatedFieldText hint="Your own district — set from the organogram">
                                      {areaSource.lockedRegion}
                                    </StatedFieldText>
                                  ) : (
                                    <SearchableSelect
                                      className={tableSelectClass}
                                      disabled={!canEdit}
                                      onChange={(e) => updateRow(row.key, "locationText", e.target.value)}
                                      value={canonicalRegion(row.locationText) || row.locationText || ""}
                                      wrapValue
                                    >
                                      <option value="">{rule.requiresRegion ? "Select region" : "Optional region"}</option>
                                      {currentRegionOptions.map((region) => (
                                        <option key={region} value={region}>
                                          {region}
                                        </option>
                                      ))}
                                    </SearchableSelect>
                                  )
                                ) : (
                                  <DisabledFieldText>Not needed</DisabledFieldText>
                                )}
                                {rule.showArea ? (
                                  <div className="mt-1.5">
                                    <SearchableSelect
                                      className={tableSelectClass}
                                      disabled={!canEdit || !canonicalRegion(row.locationText)}
                                      onChange={(e) => updateRow(row.key, "area", e.target.value)}
                                      value={row.area ?? ""}
                                      wrapValue
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
                                  </div>
                                ) : rule.showRegion || rule.showTrainingFormat ? (
                                  // Region/format above is a real field, so say the area half is not needed.
                                  // When the region half already reads "Not needed", one box says it for both.
                                  <div className="mt-1.5">
                                    <DisabledFieldText>Area not needed</DisabledFieldText>
                                  </div>
                                ) : null}
                              </td>
                              <td className="px-3 py-3">
                                {rule.showPartner ? (
                                  <MarketingPartnerSelect
                                    area={row.area}
                                    className={tableSelectClass}
                                    disabled={!canEdit || locked}
                                    onChange={(value) => updateRow(row.key, "attendees", value)}
                                    partners={workspace.marketingDoubleVisitPartners}
                                    value={row.attendees}
                                  />
                                ) : rule.showRep ? (
                                  (() => {
                                    const repStatus = medicalRepStatus({
                                      activityLabel: rule.label,
                                      area: row.area ?? "",
                                      autoRep,
                                      medicalRepOptions: workspace.medicalRepOptions,
                                      needsLine: showLineSelect,
                                      lineFilter: row.lineFilter,
                                    });
                                    return <DisabledFieldText tone={repStatus.tone}>{repStatus.text}</DisabledFieldText>;
                                  })()
                                ) : (
                                  <DisabledFieldText>Not required</DisabledFieldText>
                                )}
                              </td>
                              <td className="px-3 py-3 text-right">
                                {locked ? (
                                  <div
                                    aria-label="Locked — read-only"
                                    className="inline-flex h-9 w-9 items-center justify-center text-violet-400"
                                    title="Locked — this day comes from an approved request"
                                  >
                                    <ShieldCheck className="h-4 w-4" />
                                  </div>
                                ) : (
                                  <button
                                    aria-label={`Remove ${formatDate(row.activityDate)} ${slotLabel(row)}`}
                                    className={`inline-flex h-9 w-9 items-center justify-center border border-slate-200 bg-white text-slate-400 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none ${adminControlDepthClassName}`}
                                    disabled={!canEdit || rows.length <= 1}
                                    onClick={() => deleteRow(row.key)}
                                    type="button"
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                        <tr className={`${rowTone} border-t border-orange-100/80`}>
                          <td className="px-4 pb-4 pt-0" colSpan={5}>
                            <div className="border border-orange-100 bg-orange-50/45 px-3 py-2">
                              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                                <span className="text-phx-xs font-black uppercase tracking-[0.14em] text-orange-600">
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
                              {groupLocked ? (
                                <div className="mt-2 flex items-start gap-2 text-xs font-bold text-violet-800">
                                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                  <span>
                                    {group.rows.find((row) => row.locked)?.sourceLabel ?? "Locked"} — read-only. This
                                    day comes from an approved request.
                                  </span>
                                </div>
                              ) : null}
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
                            <td className="px-4 py-2" colSpan={5}>
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
                <span className={`rounded-sm border px-2.5 py-1.5 shadow-sm ${statusTone(plan?.status ?? "draft")}`}>
                  {statusLabels[plan?.status ?? "draft"]}
                </span>
                <span className="rounded-sm border border-slate-200 bg-slate-50 px-2.5 py-1.5 shadow-sm">
                  {workspace.canSubmitPlans ? "Creator access" : "Review access only"}
                </span>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                {isOwnPlan && plan?.status === "edit_requested" ? (
                  <span className="inline-flex items-center gap-1.5 border border-sky-200 bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-700">
                    <Clock className="h-4 w-4" />
                    Edit request pending manager approval
                  </span>
                ) : null}
                {isOwnPlan && plan?.status === "submitted" ? (
                  <Button
                    disabled={isPending}
                    onClick={() => runAction(() => requestPlanEdit(plan.id))}
                    variant="secondary"
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Request to Edit
                  </Button>
                ) : null}
                {plan && workspace.canMovePlanPeriod ? (
                  <MovePlanPeriod
                    currentPeriodLabel={`${plan.periodKey} (${formatDate(plan.periodStartDate)} to ${formatDate(plan.periodEndDate)})`}
                    onMoved={() => runAction(async () => {
                      // The move already happened inside MovePlanPeriod; runAction is used purely
                      // for its reload, so the workspace re-reads the plan on its new period.
                    })}
                    planId={plan.id}
                    planKind={plan.planKind}
                  />
                ) : null}
                <Button
                  disabled={isPending || !canEdit || noPlanRows || needsWeekPick}
                  onClick={() => runAction(() => submitPlan(false))}
                  variant="secondary"
                >
                  Save draft
                </Button>
                <Button
                  disabled={isPending || submitBlocked}
                  onClick={requestSubmit}
                >
                  <Send className="mr-2 h-4 w-4" />
                  Submit
                </Button>
              </div>
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
            <QueueCard onFillDetails={setVisitDetailsPlan} onOpen={loadPlanForEdit} plans={ownPlans} title="My Plans" />
            <ReviewCard
              comments={comments}
              isPending={isPending}
              onBulkApprove={(planIds, onApproved) => runAction(() => approveSelectedPlans(planIds, onApproved))}
              onComment={updateComment}
              onDecision={(planId, action) => runAction(() => decide(planId, action))}
              onRequestDetails={(p) => runAction(() => doRequestVisitDetails(p.id))}
              onReturnNote={updateReturnNote}
              plans={managerQueue}
              returnNotes={returnNotes}
              title="Manager Review"
              type="manager"
            />
            <ReviewCard
              comments={comments}
              isPending={isPending}
              onComment={updateComment}
              onDecision={(planId, decision) => runAction(() => decideEditRequestAction(planId, decision as "approve" | "reject"))}
              plans={editRequestQueue}
              title="Edit Requests"
              type="edit_request"
            />
            <ReviewCard
              comments={comments}
              isPending={isPending}
              onComment={updateComment}
              onDecision={(planId, action) => runAction(() => decide(planId, action))}
              onReturnNote={updateReturnNote}
              plans={ceoQueue}
              returnNotes={returnNotes}
              title={access.role === "CEO" ? "CEO Review" : "Final Review"}
              type="ceo"
            />
            <QueueCard
              onFillDetails={() => {}}
              onOpen={loadPlanForEdit}
              plans={districtManagerReadOnlyQueue}
              readOnly
              showEmployeeName
              title="District Manager Plans"
            />
            <ReviewCard
              comments={comments}
              isPending={isPending}
              onComment={updateComment}
              onDecision={(planId) => runAction(() => acknowledge(planId))}
              plans={hrQueue}
              title="HR Acknowledgement"
              type="hr"
            />
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
    case "edit_requested":
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
                <span className="text-phx-xs font-black">{step.label}</span>
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
    <div className="min-w-0 rounded-sm border border-slate-200 bg-white px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,0.07)]">
      <span className="block text-phx-2xs font-bold uppercase tracking-[0.1em] text-slate-400">{label}</span>
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
  const selectedRep = medicalRepOptions.find((rep) => hrIdsMatch(rep.hrId, row.doubleVisitMedicalRepHrId));
  const autoRep = rule.autoRep ? autoRepForArea(medicalRepOptions, row.area ?? "", row.lineFilter) : null;
  const repName = row.doubleVisitMedicalRepName || selectedRep?.fullName || autoRep?.fullName || "";
  const hasReturnNotes = Boolean(row.returnNotes?.length);
  const region = canonicalRegion(row.locationText) || row.locationText || "";
  const geographySummary = rule.showTrainingFormat
    ? trainingFormatValue(row.locationText) || "Training format optional"
    : rule.showRegion
    ? [region, row.area].filter(Boolean).join(" - ") || (rule.requiresRegion ? "Region and area required" : "No region set")
    : "No geography needed";

  const locked = Boolean(row.locked);
  const accent = activityAccent(row.activityType, row.activityTitle);
  return (
    <button
      className={`relative block w-full overflow-hidden border bg-white p-3 pl-4 text-left shadow-sm transition-colors hover:border-slate-300 hover:shadow-[0_10px_24px_rgba(15,23,42,0.08)] active:bg-slate-50 ${
        locked ? "border-violet-300 bg-violet-50/40" : hasReturnNotes ? "border-amber-300" : "border-slate-200"
      }`}
      onClick={onOpen}
      type="button"
    >
      <span className={`absolute inset-y-0 left-0 w-1.5 ${accent.bar}`} aria-hidden="true" />
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-11 w-12 flex-col items-center justify-center border border-slate-200 bg-slate-900">
            <span className="text-phx-2xs font-black uppercase leading-none text-orange-400">
              {formatDayName(row.activityDate)}
            </span>
            <span className="mt-0.5 text-sm font-black leading-none text-white">
              {formatDate(row.activityDate).split(" ")[0]}
            </span>
          </div>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 whitespace-nowrap text-sm font-black text-slate-900">
              <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${accent.dot}`} aria-hidden="true" />
              {rule.label}
              <span
                className={`inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-wide ${slotPillClass(row.slot)}`}
              >
                {slotLabel(row)}
              </span>
            </p>
            <p className="mt-0.5 whitespace-nowrap text-xs font-semibold text-slate-500">{geographySummary}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {row.sourceLabel ? (
            <span
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-phx-3xs font-black uppercase ${
                locked ? "bg-violet-500 text-white" : "bg-sky-500 text-white"
              }`}
            >
              {row.sourceLabel}
            </span>
          ) : null}
          {hasReturnNotes ? (
            <span className="rounded-full bg-phx-warn px-1.5 py-0.5 text-phx-3xs font-black uppercase text-white">
              Feedback
            </span>
          ) : null}
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
        </div>
      </div>

      {rule.requiresRep || rule.showPartner || dayNote || conflictWarning ? (
        <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
          {rule.showPartner ? (
            row.attendees ? (
              <p className="text-xs font-semibold text-violet-700">
                {rule.label} - {row.attendees}
              </p>
            ) : (
              <p className="flex items-center gap-1 text-xs font-bold text-amber-700">
                <TriangleAlert className="h-3.5 w-3.5" />
                {row.area ? "Choose who you are visiting with" : "Select area first"}
              </p>
            )
          ) : null}
          {rule.requiresRep
            ? (() => {
                const repStatus = medicalRepStatus({
                  activityLabel: rule.label,
                  area: row.area ?? "",
                  autoRep,
                  medicalRepOptions,
                  needsLine: false,
                  lineFilter: row.lineFilter,
                  resolvedName: repName,
                });
                if (repStatus.tone === "amber") {
                  return (
                    <p className="flex items-center gap-1 text-xs font-bold text-amber-700">
                      <TriangleAlert className="h-3.5 w-3.5" />
                      {repStatus.text}
                    </p>
                  );
                }
                if (repStatus.tone === "violet") {
                  return <p className="text-xs font-semibold text-violet-700">{repStatus.text}</p>;
                }
                return <p className="text-xs font-semibold text-slate-500">{repStatus.text}</p>;
              })()
            : null}
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
  dayModeChoices,
  dayNote,
  locked = false,
  lockedLabel,
  canPlanMarketingDoubleVisit,
  marketingPartners,
  medicalRepOptions,
  onClose,
  onDayMode,
  onDayNote,
  onDelete,
  onUpdate,
  areaSource,
  onUpdateLine,
  row,
}: {
  canEdit: boolean;
  conflictWarning: string | null;
  dayMode: DayMode;
  dayModeChoices: ReadonlyArray<{ label: string; value: DayMode }>;
  dayNote: string;
  locked?: boolean;
  lockedLabel?: string;
  areaSource: AreaSource;
  canPlanMarketingDoubleVisit: boolean;
  marketingPartners: readonly MarketingDoubleVisitPartner[];
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
  const availableAreas = areasForRegion(areaSource, row.locationText ?? "");
  const autoRep = rule.autoRep ? autoRepForArea(medicalRepOptions, row.area ?? "", row.lineFilter) : null;
  const currentRegionOptions = regionOptions(areaSource, row.locationText);
  const lineOptions = lineOptionsFromReps(medicalRepOptions);
  const showLine = needsLineSelection(medicalRepOptions) && rule.showRep;
  const rowWarnings = validateDraftRow(row, medicalRepOptions, marketingPartners);
  const sheetRef = useDialogA11y({ open: true, onClose });

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <style dangerouslySetInnerHTML={{ __html: planSheetMotionStyle }} />
      <button
        aria-label="Close editor"
        className="absolute inset-0 animate-[plan-sheet-backdrop-in_200ms_ease-out_both] bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
        type="button"
      />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit day"
        className="absolute inset-x-0 bottom-0 max-h-[88vh] animate-[plan-sheet-slide-up_280ms_cubic-bezier(0.22,1,0.36,1)_both] overflow-y-auto border-t border-slate-200 bg-white shadow-2xl"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-4 py-3">
          <div>
            <p className="text-phx-xs font-black uppercase tracking-[0.08em] text-orange-500">
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
          {locked ? (
            <div className="flex items-center gap-2 border border-violet-300 bg-violet-50 px-3 py-2">
              <ShieldCheck className="h-4 w-4 shrink-0 text-violet-600" />
              <p className="text-xs font-bold text-violet-800">
                {lockedLabel ?? "Locked"} — read-only. This day comes from an approved request.
              </p>
            </div>
          ) : null}
          {/* Not a <Field>: that wraps its caption and control in a <label>, and a tap on the caption is
              forwarded to the first button inside it - "Full day" - which collapsed a split day to one
              row. The group is already named by its own aria-label. */}
          <div>
            <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
              Day Mode
            </span>
            <ChoiceGroup
              aria-label="Day mode"
              className="grid-cols-2"
              disabled={!canEdit}
              onChange={onDayMode}
              options={dayModeChoices}
              value={dayMode}
            />
          </div>

          <Field label="Activity Type">
            <SearchableSelect
              className={mobileField}
              disabled={!canEdit}
              onChange={(e) => onUpdate("activityType", e.target.value)}
              value={activitySelectValue(row)}
              wrapValue
            >
              {planningActivityOptionsFor(
                canPlanMarketingDoubleVisit || isMarketingDoubleVisit(row.activityType, row.activityTitle),
              ).map((option) => (
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
                wrapValue
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
                wrapValue
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
              {areaSource.lockedRegion ? (
                <StatedFieldText hint="Your own district — set from the organogram">
                  {areaSource.lockedRegion}
                </StatedFieldText>
              ) : (
                <SearchableSelect
                  className={mobileField}
                  disabled={!canEdit}
                  onChange={(e) => onUpdate("locationText", e.target.value)}
                  value={canonicalRegion(row.locationText) || row.locationText || ""}
                  wrapValue
                >
                  <option value="">{rule.requiresRegion ? "Select region" : "Optional region"}</option>
                  {currentRegionOptions.map((region) => (
                    <option key={region} value={region}>
                      {region}
                    </option>
                  ))}
                </SearchableSelect>
              )}
            </Field>
          ) : null}

          {rule.showArea ? (
            <Field label="Area">
              <SearchableSelect
                className={mobileField}
                disabled={!canEdit || !canonicalRegion(row.locationText)}
                onChange={(e) => onUpdate("area", e.target.value)}
                value={row.area ?? ""}
                wrapValue
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

          {rule.showPartner ? (
            <Field label="Visiting with">
              <MarketingPartnerSelect
                area={row.area}
                className={mobileField}
                disabled={!canEdit}
                onChange={(value) => onUpdate("attendees", value)}
                partners={marketingPartners}
                value={row.attendees}
              />
            </Field>
          ) : null}

          {rule.showRep
            ? (() => {
                const repStatus = medicalRepStatus({
                  activityLabel: rule.label,
                  area: row.area ?? "",
                  autoRep,
                  medicalRepOptions,
                  needsLine: showLine,
                  lineFilter: row.lineFilter,
                });
                return (
                  <Field label={showLine ? "Medical Rep" : "Medical Rep (same line)"}>
                    <DisabledFieldText tone={repStatus.tone}>{repStatus.text}</DisabledFieldText>
                  </Field>
                );
              })()
            : null}

          <Field label="Notes">
            <textarea
              className={cn(phxTextareaClassName, "min-h-20")}
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
              <p className="text-phx-xs font-black uppercase tracking-[0.08em] text-amber-700">
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
      <span className="mb-1 block text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function DisabledFieldText({
  children,
  tone = "slate",
}: {
  children: React.ReactNode;
  tone?: "amber" | "slate" | "violet";
}) {
  const textClass = {
    amber: "text-amber-700 font-bold",
    slate: "text-slate-400 font-semibold",
    violet: "text-violet-700 font-semibold",
  }[tone];
  return (
    // min-h, not h, and wrapping text: in a fitted table cell a long status ("Double Visit - <rep
    // name>") must wrap onto a second line, never run out of the cell and force a horizontal scroll.
    <div className={`flex min-h-10 min-w-0 items-center rounded-sm border border-slate-200 bg-slate-50 px-3 py-1 transition-colors duration-150 hover:border-slate-300 hover:bg-slate-100 ${adminControlDepthClassName}`}>
      <span className={`min-w-0 break-words text-xs ${textClass}`}>{children}</span>
    </div>
  );
}

/**
 * A field the app answers for you — the plan owner's own district, stated rather than picked.
 * Reads as a real value (not the greyed "Not needed" of DisabledFieldText), and keeps the same
 * height and square edge as the select it stands in for so a row does not jump.
 */
function StatedFieldText({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div
      className="flex h-10 min-w-0 items-center border border-orange-200 bg-orange-50/60 px-3"
      title={hint}
    >
      <span className="text-sm font-semibold text-slate-800">{children}</span>
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
      ? "border-l-orange-500 bg-[linear-gradient(180deg,#fff7ed_0%,#ffffff_100%)] hover:border-l-orange-600 hover:shadow-[0_20px_46px_rgba(249,115,22,0.14)]"
      : "border-l-slate-500 bg-[linear-gradient(180deg,#f8fafc_0%,#ffffff_100%)] hover:border-l-slate-700 hover:shadow-[0_20px_46px_rgba(15,23,42,0.12)]";
  return (
    <div className={`rounded-sm border border-slate-200 border-l-4 p-4 shadow-[0_14px_36px_rgba(15,23,42,0.07)] transition duration-150 ${accentCls}`}>
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
    amber: "border-amber-200 bg-amber-50 text-amber-800 hover:border-amber-300 hover:shadow-[0_14px_32px_rgba(217,119,6,0.14)]",
    red: "border-red-200 bg-red-50 text-red-800 hover:border-red-300 hover:shadow-[0_14px_32px_rgba(220,38,38,0.14)]",
    sky: "border-sky-200 bg-sky-50 text-sky-800 hover:border-sky-300 hover:shadow-[0_14px_32px_rgba(2,132,199,0.14)]",
    slate: "border-slate-200 bg-white text-slate-900 hover:border-slate-300 hover:shadow-[0_14px_32px_rgba(15,23,42,0.10)]",
  }[tone];
  return (
    <div className={`rounded-sm border p-3 shadow-[0_10px_26px_rgba(15,23,42,0.06)] transition duration-150 ${toneClass}`}>
      <p className="text-phx-2xs font-bold uppercase tracking-[0.1em] opacity-70">{label}</p>
      <p className="mt-1 text-xl font-black">
        <CountUpNumber durationSeconds={0.5} value={value} />
      </p>
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
  isSubmitting,
  onClose,
  onSubmit,
  plan,
}: {
  isSubmitting: boolean;
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
    if (details.length === 0 || isSubmitting) return;
    onSubmit(details);
  }

  const modalRef = useDialogA11y({ open: true, onClose });
  const isClient = useSyncExternalStore(emptySubscribe, () => true, () => false);
  if (!isClient) return null;

  const allFilled = fieldItems.every((item) =>
    (entries[item.id] ?? []).some((e) => e.doctorName.trim() && e.speciality && e.address.trim()),
  );

  const modal = (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Fill visit details"
        className="w-full max-w-xl overflow-hidden bg-white shadow-2xl sm:rounded-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between bg-slate-900 px-4 py-3">
          <div>
            <h2 className="text-sm font-black uppercase tracking-wide text-white">Fill Visit Details</h2>
            <p className="text-phx-xs text-slate-400">
              {planHeadingLabel(plan.planKind, plan.periodStartDate, plan.periodEndDate)} — required by your manager
            </p>
          </div>
          <button aria-label="Close" onClick={onClose} className="text-slate-400 hover:text-white" type="button">
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
                  <div key={entry.key} className={`border border-slate-200 bg-white p-3 space-y-2 ${adminPanelDepthClassName}`}>
                    <div className="flex items-center justify-between">
                      <p className="text-phx-xs font-black uppercase tracking-wide text-slate-500">Visit {idx + 1}</p>
                      {(entries[item.id] ?? []).length > 1 && (
                        <button
                          onClick={() => removeEntry(item.id, entry.key)}
                          className="text-phx-2xs font-bold text-red-500 hover:text-red-700"
                          type="button"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="col-span-2">
                        <label className="block text-phx-2xs font-bold uppercase tracking-wide text-slate-600 mb-0.5">
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
                        <label className="block text-phx-2xs font-bold uppercase tracking-wide text-slate-600 mb-0.5">
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
                        <label className="block text-phx-2xs font-bold uppercase tracking-wide text-slate-600 mb-0.5">
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
                        <label className="block text-phx-2xs font-bold uppercase tracking-wide text-slate-600 mb-0.5">
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
                  className="flex w-full items-center justify-center gap-1.5 border border-dashed border-orange-300 py-2 text-phx-xs font-bold text-orange-600 hover:border-orange-400 hover:bg-orange-50"
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
          <button
            className="text-xs font-bold text-slate-500 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isSubmitting}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <Button disabled={!allFilled || isSubmitting} onClick={handleSubmit}>
            <Send className="mr-2 h-4 w-4" />
            {isSubmitting ? "Submitting…" : "Submit Visit Details"}
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
  readOnly,
  showEmployeeName,
  title,
}: {
  onFillDetails: (plan: EmployeePlan) => void;
  onOpen: (plan: EmployeePlan) => void;
  plans: EmployeePlan[];
  readOnly?: boolean;
  showEmployeeName?: boolean;
  title: string;
}) {
  if (plans.length === 0) return null;
  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="flex items-center gap-2.5 bg-slate-900 px-4 py-3">
        <span aria-hidden className="h-4 w-1 bg-gradient-to-b from-orange-400 to-orange-600" />
        <h3 className="text-sm font-black uppercase tracking-wide text-white">{title}</h3>
        {readOnly ? (
          <span title="Read-only — decided by HR, not you">
            <Eye aria-label="View only" className="h-3.5 w-3.5 text-white/60" />
          </span>
        ) : null}
      </div>
      <div className="max-h-[360px] space-y-2 overflow-y-auto p-3">
        {plans.map((p) => (
          <div
            className="border border-slate-200 p-3 transition-colors duration-150 hover:border-orange-200 hover:bg-orange-50/40"
            key={p.id}
          >
            <button className="w-full text-left" onClick={() => onOpen(p)} type="button">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-black text-slate-900">
                  {showEmployeeName ? `${p.employeeDisplayName || p.employeeName} — ` : ""}
                  {planHeadingLabel(p.planKind, p.periodStartDate, p.periodEndDate)}
                </p>
                <span
                  className={`rounded-full border px-2 py-1 text-phx-xs font-black ${statusTone(p.status)}`}
                >
                  {statusLabels[p.status]}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold text-slate-500">Revision {p.revision}</p>
                {p.offWindowFlagged ? <OffWindowBadge /> : null}
                {/* His own plans carry their score here, so he sees it on the plan itself rather
                    than only after opening the approvals hub. Absent on other people's plans —
                    see EmployeePlan.adherence. */}
                {p.adherence ? <PlanAdherenceBadge score={p.adherence} /> : null}
              </div>
            </button>
            {/* F5 — Decision history */}
            <PlanDecisionTimeline decisions={p.decisions} />
            {p.status === "details_requested" && (
              <button
                className="mt-2 flex w-full items-center justify-center gap-1.5 border border-orange-300 bg-orange-50 py-1.5 text-phx-xs font-bold text-orange-700 hover:border-orange-400 hover:bg-orange-100"
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
  comments,
  isPending,
  onBulkApprove,
  onComment,
  onDecision,
  onRequestDetails,
  onReturnNote,
  plans,
  returnNotes,
  title,
  type,
}: {
  comments: PlanCommentDrafts;
  isPending: boolean;
  // `onApproved` un-ticks the plans the server approved (and only those) once it has answered.
  onBulkApprove?: (planIds: string[], onApproved: (approvedIds: string[]) => void) => void;
  onComment: (planId: string, value: string) => void;
  onDecision: (planId: string, action: string) => void;
  onRequestDetails?: (plan: EmployeePlan) => void;
  onReturnNote?: (planId: string, itemId: string, value: string) => void;
  plans: EmployeePlan[];
  returnNotes?: Record<string, Record<string, string>>;
  title: string;
  type: "ceo" | "edit_request" | "hr" | "manager";
}) {
  // F1 — bulk selection state (manager only)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // A plan decided one by one leaves the queue; drop it from the selection too, or "Approve selected"
  // counts it and sends the id of a plan that is no longer waiting. Adjusting state while rendering
  // (only when the queue's membership changed) is React's pattern for state derived from props.
  const queuePlanIds = plans.map((p) => p.id);
  const queueKey = queuePlanIds.join("|");
  const [seenQueueKey, setSeenQueueKey] = useState(queueKey);
  if (seenQueueKey !== queueKey) {
    setSeenQueueKey(queueKey);
    setSelectedIds((previous) => pruneSelectedPlanIds(previous, queuePlanIds));
  }
  const allSelected = plans.length > 0 && plans.every((p) => selectedIds.has(p.id));
  const toggleAll = () => setSelectedIds(allSelected ? new Set() : new Set(plans.map((p) => p.id)));
  const toggleOne = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (plans.length === 0) return null;
  return (
    <div className={`overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <div className="flex items-center justify-between gap-2.5 bg-slate-900 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="h-4 w-1 bg-orange-500" />
          <h3 className="text-sm font-black uppercase tracking-wide text-white">{title}</h3>
        </div>
        {type === "manager" ? (
          <label className="flex cursor-pointer items-center gap-2">
            <input
              checked={allSelected}
              className="h-4 w-4 accent-orange-500"
              onChange={toggleAll}
              type="checkbox"
            />
            <span className="text-xs font-semibold text-white/70">All</span>
          </label>
        ) : null}
      </div>
      <div className="space-y-3 p-3">
        <VirtualList
          estimateSize={200}
          items={plans}
          renderItem={(p) => {
          const comment = planCommentFor(comments, p.id);
          return (
            <div
              className="rounded-sm border border-slate-200 p-3 shadow-sm transition-colors duration-150 hover:border-slate-300 focus-within:border-orange-300 focus-within:bg-orange-50/20"
              key={p.id}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-black text-slate-900">{p.employeeDisplayName || p.employeeName}</p>
                  <p className="text-xs font-semibold text-slate-500">
                    {planHeadingLabel(p.planKind, p.periodStartDate, p.periodEndDate)} — {statusLabels[p.status]}
                  </p>
                  {p.offWindowFlagged ? (
                    <div className="mt-1">
                      <OffWindowBadge />
                    </div>
                  ) : null}
                </div>
                {type === "manager" ? (
                  <input
                    checked={selectedIds.has(p.id)}
                    className="mt-1 h-4 w-4 shrink-0 accent-orange-500"
                    onChange={() => toggleOne(p.id)}
                    type="checkbox"
                  />
                ) : null}
              </div>
              <textarea
                className={cn(phxTextareaClassName, "mt-3 min-h-20")}
                onChange={(e) => onComment(p.id, e.target.value)}
                placeholder={
                  type === "hr"
                    ? "Acknowledgement note"
                    : type === "edit_request"
                      ? "Reason (required if you are the direct manager rejecting)"
                      : "Comment for reject/return"
                }
                value={comment}
              />
              {type !== "hr" && type !== "edit_request" ? (
                <div className={`mt-3 max-h-44 space-y-2 overflow-y-auto border border-slate-200 bg-slate-50 p-2 ${adminRecessedDepthClassName}`}>
                  {p.items.map((item) => (
                    <label className="block" key={item.id}>
                      <span className="block text-xs font-black text-slate-600">
                        {formatDate(item.activityDate)} · {planRowPartLabel(item)} — {item.activityTitle}
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
              {type !== "hr" && type !== "edit_request" && comment.trim().length === 0 ? (
                <p className="mt-2 text-xs font-semibold text-amber-700">
                  A comment is required to return or reject a plan.
                </p>
              ) : null}
              {type === "edit_request" ? (
                <p className="mt-2 text-xs font-semibold text-slate-500">
                  A reason is required only if you are the direct manager and are rejecting.
                </p>
              ) : null}
              {/* F5 — Decision history */}
              <PlanDecisionTimeline decisions={p.decisions} />
              <div className="mt-3 flex flex-wrap gap-2">
                {type === "edit_request" ? (
                  <>
                    <Button disabled={isPending} onClick={() => onDecision(p.id, "approve")}>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Approve Edit
                    </Button>
                    <Button
                      disabled={isPending}
                      onClick={() => onDecision(p.id, "reject")}
                      variant="destructive"
                    >
                      <XCircle className="mr-2 h-4 w-4" />
                      Reject
                    </Button>
                  </>
                ) : null}
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
                {/* Acknowledgement is recorded automatically the moment a plan reaches
                    final_approved (weekly-planning/service.ts autoAcknowledgeFinalApprovedPlan),
                    so this card is normally a RECORD of what was acknowledged, not a queue of
                    work — a live Acknowledge button on every row would read as "these are all
                    waiting for you". The button stays for the one row that genuinely still needs
                    it: a plan the automatic step could not acknowledge, still at final_approved. */}
                {type === "hr" ? (
                  p.status === "hr_acknowledged" ? (
                    <span className="inline-flex items-center gap-2 px-1 text-sm font-black text-emerald-700">
                      <BadgeCheck className="h-4 w-4" />
                      Acknowledged
                    </span>
                  ) : (
                    <Button
                      disabled={isPending}
                      onClick={() => onDecision(p.id, "hr_acknowledge")}
                      variant="secondary"
                    >
                      <CircleAlert className="mr-2 h-4 w-4" />
                      Acknowledge
                    </Button>
                  )
                ) : null}
              </div>
            </div>
          );
          }}
        />
      </div>
      {/* F1 — Sticky bulk approve bar for manager type */}
      {type === "manager" && selectedIds.size > 0 && onBulkApprove ? (
        <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-orange-200 bg-orange-50 px-4 py-3">
          <span className="text-sm font-black text-orange-800">
            {selectedIds.size} plan{selectedIds.size > 1 ? "s" : ""} selected
          </span>
          <Button
            disabled={isPending}
            onClick={() => {
              const ids = Array.from(selectedIds);
              onBulkApprove(ids, (approvedIds) =>
                setSelectedIds((current) => {
                  const next = new Set(current);
                  for (const id of approvedIds) next.delete(id);
                  return next;
                }),
              );
            }}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Approve selected ({selectedIds.size})
          </Button>
        </div>
      ) : null}
    </div>
  );
}
