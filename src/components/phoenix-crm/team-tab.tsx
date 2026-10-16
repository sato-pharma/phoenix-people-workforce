"use client";

/**
 * Phoenix CRM — the Team tab: what a manager looks after in the territories beneath them.
 *
 * Owner, 2026-09-16:
 *   - the district manager approves the weekly plans; the SFE Manager sees every plan and can return
 *     one; nothing approves a plan by itself;
 *   - customers far apart on one plan day are highlighted to the manager who reviews the plan;
 *   - a new doctor's grade, a grade change and a drop are proposed by the rep and decided by the
 *     district manager;
 *   - a rep plans and visits freely on a customer he has not validated yet (owner, 2026-09-22), so
 *     readiness is progress through the carried-over list and nothing waits on it: it is shown as
 *     information, never as a warning and never as the default filter.
 *
 * The server lists only the territories beneath the viewer (scope runs downward only). The Super
 * Admin's Team tab holds test plans and test requests, which the Super Admin decides.
 */

import { useId, useRef, useState, type ReactNode } from "react";

import { AdministratorReversalsPanel } from "@/components/phoenix-crm/administrator-reversals-panel";
import { crmPost, crmUrl, errorCodeOf, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoDayOf, cairoStamp, countText, dayLabel, dayLabelWithYear, plural, weekLabel } from "@/components/phoenix-crm/format";
import { ManagerOwnListSection, ManagerPlansSection } from "@/components/phoenix-crm/manager-plan-team";
import { matchesWords, PENDING_PILL } from "@/components/phoenix-crm/labels";
import { PlanBoard } from "@/components/phoenix-crm/plan-board";
import { PlanEditCard } from "@/components/phoenix-crm/plan-edit-card";
import { RequestCard } from "@/components/phoenix-crm/request-card";
import { OffPlanDayCard, type OffPlanDayNotice } from "@/components/phoenix-crm/unplanned-visit-card";
import { VisitAskInbox } from "@/components/phoenix-crm/visit-asks";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmCheck,
  CrmChoice,
  CrmEmpty,
  CrmField,
  CrmLoadError,
  CrmLoading,
  CrmNote,
  CrmPanel,
  CrmPill,
  CrmSearchField,
  CrmShowMore,
  CrmTable,
  crmTdClassName,
  crmThClassName,
  type CrmChoiceOption,
  type NoteTone,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import {
  BULK_DROP_FROM,
  bulkDropDecisionBody,
  bulkDropFailureText,
  bulkDropNotice,
  bulkDropTargets,
  repeatOfDropped,
  pruneSelection,
  type BulkDropOutcome,
} from "@/lib/phoenix-crm/bulk-drop";
import { fieldWeekStart, plannableWeeks } from "@/lib/phoenix-crm/calendar";
import { splitOffPlanDays, type OffPlanDay } from "@/lib/phoenix-crm/offplan-day";
import { planStatusLine, withPlanDeadline } from "@/lib/phoenix-crm/plan-rules";
import { teamTodayLine, teamTodayTone } from "@/lib/phoenix-crm/team-today";
import { vendorLeftoverNote, VENDOR_LEFTOVER_TITLE } from "@/lib/phoenix-crm/vendor-leftovers";
import { teamWaitingLine, teamWeeksToShow } from "@/lib/phoenix-crm/team-waiting";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import type {
  MonthlyReviewRow,
  MonthlyReviewView,
  PlanReviewRow,
  PlanReviewView,
  SeatReadiness,
  TeamPlanEdit,
  TeamRequest,
  TeamTerritoryRow,
  TeamUnplannedVisit,
  TeamView,
  TerritorySummary,
} from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

type TeamSection = "plans" | "edits" | "months" | "unplanned" | "requests" | "lists" | "own_list" | "manager_plans" | "double" | "decided";
type ReviewFilter = "waiting" | "not_sent" | "approved" | "all";
type ListFilter = "not_ready" | "ready" | "vacant" | "all";
type TeamNotice = { tone: NoteTone; title: string; message?: ReactNode };
type OpenPlan = { seatId: string; weekStart: string };
/** A rep’s month opened from the review board — the plan board, read only, with Approve and Return on it. */
type OpenMonth = { seatId: string; month: string };

const PAGE = 25;

/** Search shows once a section holds more rows than this. */
const SEARCH_FROM = 8;

const STATUS_TONE: Record<PhoenixCrmPlanStatus | "none", PillTone> = {
  none: "neutral",
  draft: "neutral",
  submitted: "warn",
  approved: "good",
  returned: "bad",
};

const STATUS_ACCENT: Record<PhoenixCrmPlanStatus | "none", string> = {
  none: "border-l-slate-300",
  draft: "border-l-slate-300",
  submitted: "border-l-amber-500",
  approved: "border-l-emerald-500",
  returned: "border-l-rose-500",
};

// ── Words ───────────────────────────────────────────────────────────────────────────────────────

function territoryWords(territory: TerritorySummary): Array<string | null> {
  return [territory.name, territory.repName, territory.reviewerName, territory.areaName, territory.regionName, territory.lineName];
}

function repText(territory: TerritorySummary): string {
  return territory.repName ?? "No rep in this territory";
}

/**
 * Who reviews this territory — named only when it is SOMEONE ELSE.
 *
 * A district manager reviews every territory beneath her, so this printed her own name on every row:
 * five times on a five-territory team (measured 2026-10-02). The SFE Manager and the Super Admin look
 * across several managers, so they still read it on every row, and a territory with nobody above it
 * still says so — that one is a gap worth seeing.
 */
function reviewerText(territory: TerritorySummary, viewerHrId: string | null): string | null {
  if (!territory.reviewerName) return "No manager above this territory";
  if (viewerHrId && territory.reviewerHrId === viewerHrId) return null;
  return `Reviewed by ${territory.reviewerName}`;
}

/** A card's one-line meta: the rep, and the reviewer when he is not the person reading. */
function metaText(territory: TerritorySummary, viewerHrId: string | null, test: boolean): string {
  return [repText(territory), test ? null : reviewerText(territory, viewerHrId)].filter(Boolean).join(" · ");
}

/**
 * A switcher note, or nothing at all. "Nothing waiting for you" and "0 waiting" are a note that says
 * nothing: the owner counted ten of them on one screen (2026-10-02), so a zero now prints no note.
 */
function waitingNote(forYou: number | null | false, inAll: number | null | false): string | undefined {
  if (typeof forYou !== "number" || typeof inAll !== "number") return undefined;
  if (forYou > 0) return `${countText(forYou)} waiting for you`;
  return inAll > 0 ? `${countText(inAll)} waiting` : undefined;
}

// ── Plans ───────────────────────────────────────────────────────────────────────────────────────

function reviewFilterOf(row: PlanReviewRow): Exclude<ReviewFilter, "all"> {
  const status = row.plan?.status ?? null;
  if (status === "submitted") return "waiting";
  if (status === "approved") return "approved";
  return "not_sent";
}

/**
 * "3 AM · 41 PM" — AM and PM side by side, never added together.
 *
 * Null when there is no plan: the row already carries a NOT STARTED pill, and "No plan yet" beside
 * it was the third way one row said the same thing (owner, 2026-10-02).
 */
function placedText(row: PlanReviewRow): string | null {
  if (!row.plan) return null;
  return `${countText(row.accounts)} AM · ${countText(row.doctors)} PM`;
}

function planStamp(row: PlanReviewRow): string | null {
  const { plan } = row;
  // Nothing yet: the NOT STARTED pill sits right beside this, and saying it again in a sentence is
  // half of why the page ran four phone screens (owner, 2026-10-02).
  if (!plan) return null;
  if (plan.status === "submitted") return `Sent ${cairoStamp(plan.submittedAt)}${plan.submittedByName ? ` by ${plan.submittedByName}` : ""}`;
  if ((plan.status === "approved" || plan.status === "returned") && plan.decidedAt) {
    const who = plan.decidedByName ? ` by ${plan.decidedByName}${plan.decidedBySfe ? " (SFE Manager)" : ""}` : "";
    return `${plan.status === "approved" ? "Approved" : "Returned"} ${cairoStamp(plan.decidedAt)}${who}`;
  }
  return `Last changed ${cairoStamp(plan.updatedAt)}`;
}

/** What the reviewer looks at before deciding. */
function reviewFlags(row: PlanReviewRow): Array<{ key: string; label: string }> {
  const flags: Array<{ key: string; label: string }> = [];
  if (row.exceptions > 0) flags.push({ key: "off", label: `${plural(row.exceptions, "customer", "customers")} on a day they do not receive` });
  if (row.staleItems > 0) flags.push({ key: "gone", label: `${plural(row.staleItems, "customer", "customers")} no longer on the list` });
  if (row.farApartDays.length > 0) flags.push({ key: "far", label: `Far apart on ${row.farApartDays.map((day) => dayLabel(day)).join(", ")}` });
  return flags;
}

function ReviewFlags({ row }: { row: PlanReviewRow }) {
  // No plan, nothing to look at: the row already carries a NOT STARTED pill and an Open button.
  if (!row.plan) return null;
  const flags = reviewFlags(row);
  if (flags.length === 0) return <span className="text-xs font-semibold text-slate-500">Nothing flagged</span>;
  return (
    <span className="flex max-w-full flex-wrap gap-1">
      {flags.map((flag) => (
        <CrmPill key={flag.key} tone="warn">
          {flag.label}
        </CrmPill>
      ))}
    </span>
  );
}

function reviewAction(row: PlanReviewRow): { label: string; primary: boolean } {
  if (row.plan?.status === "submitted" && (row.canApprove || row.canReturn)) return { label: "Review the plan", primary: row.canApprove };
  return { label: "Open the plan", primary: false };
}

// ── Lists ───────────────────────────────────────────────────────────────────────────────────────

function listFilterMatches(row: TeamTerritoryRow, filter: ListFilter): boolean {
  if (filter === "vacant") return !row.territory.repHrId;
  if (filter === "ready") return row.readiness?.ready === true;
  if (filter === "not_ready") return row.readiness !== null && !row.readiness.ready;
  return true;
}

function readinessLine(readiness: SeatReadiness): string {
  if (readiness.total === 0) return "No reference list: the list holds the customers the rep adds";
  const parts = [`${countText(readiness.validated)} of ${countText(readiness.total)} validated`];
  if (readiness.dropped > 0) parts.push(`${countText(readiness.dropped)} dropped`);
  if (readiness.dropPending > 0) parts.push(`${plural(readiness.dropPending, "drop", "drops")} waiting for a decision`);
  // The rep's own word for the same customers (PENDING_PILL), so a manager and his rep read one
  // vocabulary. It is how far the rep has got, not a shortfall: nothing of his is waiting on it.
  if (readiness.open > 0) parts.push(`${countText(readiness.open)} ${PENDING_PILL.toLowerCase()}`);
  return parts.join(" · ");
}

function readySince(readiness: SeatReadiness): string | null {
  const day = readiness.ready ? cairoDayOf(readiness.readyAt) : null;
  return day ? `Ready since ${dayLabelWithYear(day)}` : null;
}

function ReadinessPill({ readiness }: { readiness: SeatReadiness | null }) {
  if (!readiness) return null;
  // Not `warn`: nothing is wrong with a territory part-way through its list, and validating a whole
  // carried-over list takes months. `good` still marks a finished one.
  return readiness.ready ? <CrmPill tone="good">List ready</CrmPill> : <CrmPill tone="info">Validating</CrmPill>;
}

/**
 * The rep's day so far, as his managers read it (owner, 2026-09-30: "easiest CRM, yet controlled"):
 * his sent plan's progress AM and PM apart, and what he logged. His own work — never a check on his
 * honesty, which stays with the Super Admin and the SFE Manager.
 */
const TODAY_TONE_SQUARE: Record<ReturnType<typeof teamTodayTone>, string> = {
  good: "bg-emerald-500",
  progress: "bg-orange-500",
  idle: "bg-amber-400",
  none: "bg-slate-300",
};

function TodayLine({ row }: { row: TeamTerritoryRow }) {
  if (!row.territory.repHrId) return <p className="break-words text-xs font-semibold leading-5 text-slate-500">Vacant — no rep</p>;
  return (
    <p className="flex min-w-0 items-start gap-2 text-xs font-semibold leading-5 text-slate-700">
      <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0", TODAY_TONE_SQUARE[teamTodayTone(row.today)])} />
      {/* The start opens the line when he pressed it, and is absent when he did not — never a
          "not started" flag on a row at seven in the morning (`team-today.ts`). */}
      <span className="min-w-0 break-words">{teamTodayLine(row.today, row.today.lastVisitClock, row.today.startedClock)}</span>
    </p>
  );
}

/**
 * Where the work is being RECORDED, never a word about the rep: one still logging in iReports360 is
 * following the habit he was trained in, and since his team moved those visits land in no figure at
 * all. It sits on a vacant row too — the work still happened and still counts nowhere.
 *
 * The server leaves it empty on the rep's OWN row (Golden Rule #1, `isLocationBlind` in
 * server/team.ts); this screen decides nothing of its own and must never start.
 */
function VendorLeftoverLine({ row }: { row: TeamTerritoryRow }) {
  const note = vendorLeftoverNote(row.stillOnVendor);
  if (!note) return null;
  return (
    <p className="break-words text-xs font-semibold leading-5 text-amber-700">
      {VENDOR_LEFTOVER_TITLE}: {note}
    </p>
  );
}

function requestsText(row: TeamTerritoryRow): string {
  if (row.pendingRequests === 0) return "No request waiting";
  return `${plural(row.pendingRequests, "request", "requests")} waiting${row.canReview ? " · you decide them" : ""}`;
}

// ── The tab ─────────────────────────────────────────────────────────────────────────────────────

export function TeamTab({
  cairoToday,
  onChanged,
  onDirtyChange,
  onOpenList,
  test,
}: {
  cairoToday: string;
  /** A decision went through: the page's "waiting for you" counts read again. */
  onChanged?: () => void;
  /** A plan opened from here has unsaved changes; the page asks before it swaps what is on screen. */
  onDirtyChange?: (dirty: boolean) => void;
  /** A territory's List tab. */
  onOpenList?: (seatId: string) => void;
  test: boolean;
}) {
  const idPrefix = useId();
  const team = useCrmGet<TeamView>(crmUrl("/api/phoenix-crm/team", { test }), "team");
  const [weekStart, setWeekStart] = useState<string | null>(null);
  const reviews = useCrmGet<PlanReviewView>(crmUrl("/api/phoenix-crm/plans/reviews", { test, weekStart }), "reviews");
  const [section, setSection] = useState<TeamSection | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const months = useCrmGet<MonthlyReviewView>(crmUrl("/api/phoenix-crm/monthly-plans/reviews", { test, month }), "months");
  const [openPlan, setOpenPlan] = useState<OpenPlan | null>(null);
  const [openMonth, setOpenMonth] = useState<OpenMonth | null>(null);
  const [notice, setNotice] = useState<TeamNotice | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  function scrollToTop() {
    const top = topRef.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  }

  function refresh() {
    team.reload();
    reviews.reload();
    months.reload();
    onChanged?.();
  }

  function chooseSection(next: TeamSection) {
    setSection(next);
    setNotice(null);
  }

  function chooseWeek(next: string) {
    setSection("plans");
    setNotice(null);
    setWeekStart(next);
  }

  function openReview(seatId: string, week: string) {
    setNotice(null);
    setOpenPlan({ seatId, weekStart: week });
    scrollToTop();
  }

  function closePlan() {
    // The plan asked before letting unsaved changes go, so nothing is left unsaved here.
    onDirtyChange?.(false);
    setOpenPlan(null);
    scrollToTop();
  }

  function openMonthReview(seatId: string, monthStart: string) {
    setNotice(null);
    setOpenMonth({ seatId, month: monthStart });
    scrollToTop();
  }

  function closeMonth() {
    onDirtyChange?.(false);
    setOpenMonth(null);
    months.reload();
    scrollToTop();
  }

  function chooseMonth(next: string) {
    setSection("months");
    setNotice(null);
    setMonth(next.slice(0, 7));
  }

  function showNotice(next: TeamNotice) {
    setNotice(next);
    refresh();
    scrollToTop();
  }

  function requestDecided(message: string) {
    showNotice({ tone: "info", title: message });
  }

  const fallbackWeeks = plannableWeeks(cairoToday);
  const weeks: ReadonlyArray<{ weekStart: string; waiting: number | null }> =
    reviews.data?.weeks ?? fallbackWeeks.map((week) => ({ weekStart: week, waiting: null }));
  const selectedWeek = reviews.data?.weekStart ?? weekStart ?? fallbackWeeks[0];
  const plansWaiting = reviews.data ? reviews.data.weeks.reduce((sum, week) => sum + week.waiting, 0) : null;
  const summary = team.data?.summary ?? null;
  const settled = (team.data !== null || !team.loading) && (reviews.data !== null || !reviews.loading);
  const current: TeamSection | null =
    section ??
    (settled
      ? (plansWaiting ?? 0) > 0
        ? "plans"
        : (summary?.planEditsWaitingForYou ?? 0) > 0
          ? "edits"
          : (summary?.unplannedWaitingForYou ?? 0) > 0
            ? "unplanned"
            : (summary?.waitingForYou ?? 0) > 0
              ? "requests"
              : (summary?.visitAsksWaitingForYou ?? 0) > 0
                ? "double"
                : "plans"
      : null);

  const monthsWaiting = months.data ? months.data.rows.filter((row) => row.canApprove).length : null;
  // A rep sends a week at a time since 2026-10-01 (owner), so a month only reaches a manager from
  // before that day. The section stays while one is still there to read, and leaves once none is.
  const anyMonthSent = months.data ? months.data.rows.some((row) => row.plan !== null) : false;
  // One sentence where six tiles used to be. They repeated, word for word, the notes on the switcher
  // one block below them, and both said "Nothing waiting" when nothing was (owner, 2026-10-02).
  const waiting = summary
    ? teamWaitingLine(
        {
          plans: plansWaiting,
          months: anyMonthSent ? monthsWaiting : null,
          planEdits: summary.planEditsWaitingForYou,
          unplanned: summary.unplannedWaitingForYou,
          requests: summary.waitingForYou,
          // A viewer who answers no asks is not told "nothing": the kind is left out of the sentence.
          visitAsks: team.data?.visitAsks?.canAnswer ? summary.visitAsksWaitingForYou : null,
        },
        {
          territories: summary.territories,
          vacant: summary.vacant,
          ready: summary.ready,
          notReady: summary.notReady,
          elsewhere:
            summary.requestsWaiting -
            summary.waitingForYou +
            (summary.unplannedWaiting - summary.unplannedWaitingForYou) +
            (summary.planEditsWaiting - summary.planEditsWaitingForYou),
          test,
        },
      )
    : null;
  const sectionOptions: Array<CrmChoiceOption<TeamSection>> = [
    {
      value: "plans",
      label: "Weekly plans",
      note: plansWaiting !== null && plansWaiting > 0 ? `${countText(plansWaiting)} waiting for you` : undefined,
    },
    {
      value: "edits",
      label: "Plan edits",
      note: waitingNote(summary && summary.planEditsWaitingForYou, summary && summary.planEditsWaiting),
    },
  ];
  if (anyMonthSent || section === "months") {
    sectionOptions.push({
      value: "months",
      label: "Monthly plans",
      note: monthsWaiting !== null && monthsWaiting > 0 ? `${countText(monthsWaiting)} waiting for you` : undefined,
    });
  }
  sectionOptions.push(
    {
      value: "unplanned",
      label: "Off-plan visits",
      note: waitingNote(summary && summary.unplannedWaitingForYou, summary && summary.unplannedWaiting),
    },
    {
      value: "requests",
      label: "List requests",
      note: waitingNote(summary && summary.waitingForYou, summary && summary.requestsWaiting),
    },
  );
  // The Administrator alone (owner, 2026-10-08): the decisions he can still take back, fourteen days.
  const reversible = team.data?.reversible ?? null;
  if (reversible) {
    sectionOptions.push({
      value: "decided",
      label: "Decided · reverse",
      note: reversible.length > 0 ? `${countText(reversible.length)} you can take back` : undefined,
    });
  }
  if (!test) {
    sectionOptions.push({
      value: "lists",
      label: "Customer lists",
      note: summary ? `${countText(summary.ready)} of ${countText(summary.ready + summary.notReady)} ready` : undefined,
    });
  }
  // The district manager's weekly plan (owner, 2026-10-16), which REPLACED the double-visit planner this
  // section held since 2026-10-02: "Manager plans" — his week planned against done — and "Manager's own
  // list", beside Customer lists. Offered to the district manager himself, his RSM/NSM, SFE, the CEO and
  // the Super Admin, by the server's own reach (`managerPlanReach`). Never the rep.
  const managerPlans = team.data?.managerPlans ?? null;
  if (managerPlans) {
    sectionOptions.push(
      {
        value: "own_list",
        label: "Manager's own list",
        note: managerPlans.mode === "own" ? "The customers you visit alone" : "Each district manager's own customers",
      },
      {
        value: "manager_plans",
        label: "Manager plans",
        note: managerPlans.mode === "own" ? "Your week, planned against done" : "The district managers' weeks",
      },
    );
  }
  // A rep's asks for a visit with somebody (owner, 2026-10-02): "Asked by your reps" for the people asked
  // and told, every ask for SFE and the Super Admin. The double-visit planner that sat below them was
  // retired for the weekly plan above (owner, 2026-10-16); the asks stay here.
  const visitAsks = team.data?.visitAsks ?? null;
  const asksWaiting = visitAsks?.waitingForYou ?? 0;
  if (visitAsks?.anyToRead) {
    sectionOptions.push({
      value: "double",
      label: "Double visits",
      note: asksWaiting > 0 ? `${countText(asksWaiting)} asked of you` : "Asked by your reps",
    });
  }

  return (
    <div className="min-w-0 scroll-mt-24" ref={topRef}>
      {openMonth ? (
        <PlanBoard
          initialMonth={openMonth.month}
          key={`${openMonth.seatId}|${openMonth.month}`}
          onBack={{ label: "Team", onBack: closeMonth }}
          onChanged={refresh}
          onDirtyChange={onDirtyChange}
          onOpenList={onOpenList ? () => onOpenList(openMonth.seatId) : undefined}
          seatId={openMonth.seatId}
          test={test}
        />
      ) : openPlan ? (
        <PlanBoard
          initialWeekStart={openPlan.weekStart}
          key={`${openPlan.seatId}|${openPlan.weekStart}`}
          onBack={{ label: "Team", onBack: closePlan }}
          onChanged={refresh}
          onDirtyChange={onDirtyChange}
          onOpenList={onOpenList ? () => onOpenList(openPlan.seatId) : undefined}
          seatId={openPlan.seatId}
          test={test}
        />
      ) : (
        <CrmPanel
          description={
            test
              ? "Test plans and test requests from any territory. You decide them yourself, and nobody is notified."
              : "The territories beneath you: the plans, the list requests, and how far each customer list has come."
          }
          eyebrow={test ? "Team · test entries" : "Team"}
          title="Your team"
        >
          {notice ? (
            <div className="px-4 pt-4 sm:px-5">
              <CrmNote title={notice.title} tone={notice.tone}>
                {notice.message}
              </CrmNote>
            </div>
          ) : null}

          {summary && waiting ? (
            <>
              {team.error ? <CrmLoadError message={team.error} onRetry={team.reload} /> : null}
              <CrmBlock>
                <CrmNote title={waiting.title} tone={waiting.tone}>
                  {waiting.detail}
                </CrmNote>
              </CrmBlock>
            </>
          ) : team.error ? (
            <CrmLoadError message={team.error} onRetry={team.reload} />
          ) : (
            <CrmLoading label="Loading your team" />
          )}

          {current ? (
            <CrmBlock className="border-t border-slate-100" title="Look at">
              <CrmChoice columns={test ? 2 : 3} label="Look at" onChange={chooseSection} options={sectionOptions} value={current} />
            </CrmBlock>
          ) : null}

          {current === "plans" ? (
            <PlansSection
              error={reviews.error}
              idPrefix={idPrefix}
              key={selectedWeek}
              onOpen={(row) => openReview(row.territory.seatId, selectedWeek)}
              onRetry={reviews.reload}
              onWeek={chooseWeek}
              selectedWeek={selectedWeek}
              test={test}
              thisWeek={fieldWeekStart(cairoToday)}
              view={reviews.data}
              viewerHrId={team.data?.viewerHrId ?? null}
              weeks={weeks}
            />
          ) : null}

          {current === "months" ? (
            <MonthsSection
              error={months.error}
              onMonth={chooseMonth}
              onOpen={(row) => openMonthReview(row.territory.seatId, months.data?.monthStart ?? row.plan?.monthStart ?? cairoToday)}
              onRetry={months.reload}
              test={test}
              view={months.data}
            />
          ) : null}

          {current === "edits" && team.data ? (
            <PlanEditsSection
              idPrefix={idPrefix}
              onChanged={requestDecided}
              onOpenWeek={(edit) => openReview(edit.seatId, edit.weekStart)}
              team={team.data}
              test={test}
            />
          ) : null}

          {current === "unplanned" && team.data ? (
            <UnplannedSection idPrefix={idPrefix} onBatchDone={showNotice} onChanged={requestDecided} team={team.data} test={test} />
          ) : null}

          {current === "requests" && team.data ? (
            <RequestsSection idPrefix={idPrefix} onBatchDone={showNotice} onChanged={requestDecided} team={team.data} test={test} />
          ) : null}

          {current === "decided" && reversible ? <AdministratorReversalsPanel items={reversible} onChanged={requestDecided} /> : null}

          {current === "lists" && team.data ? <ListsSection idPrefix={idPrefix} onOpenList={onOpenList} team={team.data} /> : null}

          {current === "own_list" && managerPlans ? <ManagerOwnListSection test={test} /> : null}

          {current === "manager_plans" && managerPlans ? <ManagerPlansSection test={test} /> : null}

          {/* What the reps asked of this manager. Answering one refreshes the counts on the page. */}
          {current === "double" && visitAsks ? <VisitAskInbox cairoToday={cairoToday} onChanged={refresh} place="team" test={test} /> : null}
        </CrmPanel>
      )}
    </div>
  );
}

// ── Sections ────────────────────────────────────────────────────────────────────────────────────

function PlansSection({
  error,
  idPrefix,
  onOpen,
  onRetry,
  onWeek,
  selectedWeek,
  test,
  thisWeek,
  view,
  viewerHrId,
  weeks,
}: {
  error: string | null;
  idPrefix: string;
  onOpen: (row: PlanReviewRow) => void;
  onRetry: () => void;
  onWeek: (weekStart: string) => void;
  selectedWeek: string;
  test: boolean;
  thisWeek: string;
  view: PlanReviewView | null;
  viewerHrId: string | null;
  weeks: ReadonlyArray<{ weekStart: string; waiting: number | null }>;
}) {
  const [filter, setFilter] = useState<ReviewFilter | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [showAllWeeks, setShowAllWeeks] = useState(false);

  // Nine buttons, nine of them reading "Nothing waiting" (owner, 2026-10-02). The strip now carries
  // the weeks with something in them, this week and the one he is on; the rest are one press away,
  // because planning a month ahead still has to be reachable.
  const shownWeeks = teamWeeksToShow(weeks, { selectedWeek, thisWeek, showAll: showAllWeeks });
  const weekBlock = (
    <CrmBlock
      actions={
        weeks.length > shownWeeks.length || showAllWeeks ? (
          <CrmButton onClick={() => setShowAllWeeks((value) => !value)} size="sm" variant="ghost">
            {showAllWeeks ? "Fewer weeks" : `Every week · ${countText(weeks.length)}`}
          </CrmButton>
        ) : undefined
      }
      className="border-t border-slate-100"
      title="Week"
    >
      <CrmChoice
        columns={4}
        label="Week"
        onChange={onWeek}
        options={shownWeeks.map((week) => ({
          value: week.weekStart,
          label: weekLabel(week.weekStart),
          // A week with nothing in it carries no note: "Nothing waiting" printed nine times said
          // nothing nine times.
          note:
            [week.weekStart === thisWeek ? "This week" : null, (week.waiting ?? 0) > 0 ? `${countText(week.waiting ?? 0)} waiting for you` : null]
              .filter(Boolean)
              .join(" · ") || undefined,
        }))}
        value={selectedWeek}
      />
    </CrmBlock>
  );

  if (!view) {
    return (
      <>
        {weekBlock}
        <div className="border-t border-slate-100">
          {error ? <CrmLoadError message={error} onRetry={onRetry} /> : <CrmLoading label="Loading the week's plans" />}
        </div>
      </>
    );
  }

  if (view.rows.length === 0) {
    return (
      <>
        {weekBlock}
        {error ? <CrmLoadError message={error} onRetry={onRetry} /> : null}
        <div className="border-t border-slate-100">
          <CrmEmpty
            message={test ? "Test plans saved on the Plan tab show here, by week." : "A territory shows here once its line opens in Phoenix CRM."}
            title={test ? "No test plan for this week" : "No territories to show"}
          />
        </div>
      </>
    );
  }

  const counts: Record<Exclude<ReviewFilter, "all">, number> = { waiting: 0, not_sent: 0, approved: 0 };
  for (const row of view.rows) counts[reviewFilterOf(row)] += 1;
  const currentFilter: ReviewFilter = filter ?? (counts.waiting > 0 ? "waiting" : "all");
  const searchable = view.rows.length > SEARCH_FROM;
  const rows = view.rows.filter(
    (row) => (currentFilter === "all" || reviewFilterOf(row) === currentFilter) && (!searchable || matchesWords(query, territoryWords(row.territory))),
  );
  const shown = rows.slice(0, limit);
  const filterOptions: Array<CrmChoiceOption<ReviewFilter>> = [
    { value: "waiting", label: "Waiting for review", note: countText(counts.waiting) },
    { value: "not_sent", label: "Not sent yet", note: countText(counts.not_sent) },
    { value: "approved", label: "Approved", note: countText(counts.approved) },
    { value: "all", label: "Every territory", note: countText(view.rows.length) },
  ];

  function filterBy(update: () => void) {
    update();
    setLimit(PAGE);
  }

  function action(row: PlanReviewRow) {
    const { label, primary } = reviewAction(row);
    return (
      <CrmButton onClick={() => onOpen(row)} size="sm" variant={primary ? "primary" : "secondary"}>
        {label}
      </CrmButton>
    );
  }

  return (
    <>
      {weekBlock}
      {error ? <CrmLoadError message={error} onRetry={onRetry} /> : null}
      <CrmBlock className="border-t border-slate-100" title={`Plans for ${weekLabel(view.weekStart)}`}>
        <div className={cn("grid min-w-0 gap-3", searchable ? "md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-end" : undefined)}>
          <CrmField label="Show">
            <CrmChoice columns={4} label="Show" onChange={(next) => filterBy(() => setFilter(next))} options={filterOptions} value={currentFilter} />
          </CrmField>
          {searchable ? (
            <CrmSearchField
              id={`${idPrefix}-plans-search`}
              label="Find a territory"
              onChange={(next) => filterBy(() => setQuery(next))}
              placeholder="Territory, rep or manager"
              value={query}
            />
          ) : null}
        </div>
        {/* What the FAR APART flag means — printed only when a plan on this week actually carries
            one, rather than explaining a flag nobody on screen can see. */}
        {view.rows.some((row) => row.farApartDays.length > 0) ? (
          <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-500">
            Far apart: two customers on the same day are more than {countText(view.farApartKm)} km from each other.
          </p>
        ) : null}
      </CrmBlock>

      {rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Clear the search or choose another filter." title="No plan matches" />
        </div>
      ) : (
        <div className="border-t border-slate-100">
          <CrmCardsOnPhone>
            {shown.map((row) => {
              const status = row.plan?.status ?? "none";
              const stamp = planStamp(row);
              const placed = placedText(row);
              return (
                <CrmCard
                  accent={STATUS_ACCENT[status]}
                  actions={action(row)}
                  key={row.territory.seatId}
                  meta={metaText(row.territory, viewerHrId, test)}
                  status={<CrmPill tone={STATUS_TONE[status]}>{row.plan?.statusLabel ?? planStatusLine({ status: null, repName: row.territory.repName })}</CrmPill>}
                  title={row.territory.name}
                >
                  {placed ? <p className="break-words text-sm font-black text-slate-800">{placed}</p> : null}
                  {stamp ? <p className="break-words text-xs font-semibold leading-5 text-slate-500">{stamp}</p> : null}
                  {row.plan ? (
                    <div className="mt-2">
                      <ReviewFlags row={row} />
                    </div>
                  ) : null}
                </CrmCard>
              );
            })}
          </CrmCardsOnPhone>
          <CrmTable columns={["26%", "22%", "13%", null, "15%"]}>
            <thead>
              <tr>
                <th className={crmThClassName} scope="col">
                  Territory
                </th>
                <th className={crmThClassName} scope="col">
                  Plan
                </th>
                <th className={crmThClassName} scope="col">
                  Placed
                </th>
                <th className={crmThClassName} scope="col">
                  To look at
                </th>
                <th className={crmThClassName} scope="col">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const status = row.plan?.status ?? "none";
                const stamp = planStamp(row);
                const reviewer = test ? null : reviewerText(row.territory, viewerHrId);
                return (
                  <tr key={row.territory.seatId}>
                    <td className={crmTdClassName}>
                      <p className="font-black text-slate-950">{row.territory.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{repText(row.territory)}</p>
                      {reviewer ? <p className="text-xs text-slate-500">{reviewer}</p> : null}
                    </td>
                    <td className={crmTdClassName}>
                      <CrmPill tone={STATUS_TONE[status]}>{row.plan?.statusLabel ?? planStatusLine({ status: null, repName: row.territory.repName })}</CrmPill>
                      {stamp ? <p className="mt-1 text-xs text-slate-500">{stamp}</p> : null}
                    </td>
                    <td className={crmTdClassName}>{placedText(row)}</td>
                    <td className={crmTdClassName}>
                      <ReviewFlags row={row} />
                    </td>
                    <td className={crmTdClassName}>
                      <div className="flex flex-wrap gap-2">{action(row)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </CrmTable>
          <CrmShowMore left={rows.length - limit} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
        </div>
      )}
    </>
  );
}

/**
 * The MONTHS a rep has sent for review — the screen that was missing.
 *
 * Every other half of monthly approval already shipped: the rule, the RPC, the API and the Approve and
 * Return buttons on the month itself. What did not exist was a way for a real manager to REACH a rep’s
 * month: the Plan tab offers a viewer only his OWN territory, so `canApprove` was true and unreachable,
 * and only the Super Admin, on a test plan, could press it. This opens the plan board on that month,
 * read only, with Approve and Return on it — exactly as a weekly plan opens the board on its week.
 */
function MonthsSection({
  error,
  onMonth,
  onOpen,
  onRetry,
  test,
  view,
}: {
  error: string | null;
  onMonth: (monthStart: string) => void;
  onOpen: (row: MonthlyReviewRow) => void;
  onRetry: () => void;
  test: boolean;
  view: MonthlyReviewView | null;
}) {
  if (!view) {
    return (
      <div className="border-t border-slate-100">
        {error ? <CrmLoadError message={error} onRetry={onRetry} /> : <CrmLoading label="Loading the monthly plans" />}
      </div>
    );
  }

  const waiting = view.rows.filter((row) => row.canApprove);
  const rest = view.rows.filter((row) => !row.canApprove);

  function card(row: MonthlyReviewRow) {
    const status = row.plan?.status ?? "none";
    const late = row.plan?.submittedLate === true;
    return (
      <CrmCard
        accent={STATUS_ACCENT[status]}
        key={row.territory.seatId}
        meta={[row.territory.name, repText(row.territory)].filter(Boolean).join(" · ")}
        status={
          <>
            <CrmPill tone={STATUS_TONE[status]}>{row.plan?.statusLabel ?? planStatusLine({ status: null, repName: row.territory.repName })}</CrmPill>
            {/* His ruling: a late month is accepted and STAMPED, never blocked. The stamp is the
                whole enforcement, so it has to be visible where he reviews. */}
            {late ? <CrmPill tone="warn">Sent late</CrmPill> : null}
          </>
        }
        title={row.territory.name}
      >
        <div className="grid min-w-0 gap-1.5 text-sm leading-6">
          <p className="break-words font-medium text-slate-700">
            {countText(row.doctors)} PM · {countText(row.accounts)} AM placed
            {row.exceptions > 0 ? ` · ${countText(row.exceptions)} on a day the customer does not receive` : ""}
          </p>
          {row.plan?.dueOn ? (
            <p className="break-words text-xs font-semibold text-slate-500">
              {/* The hour as well as the day (owner, 2026-10-02): a reviewer judging "Sent late" has to
                  be able to see the line that decided it. Its own compact date, the shared deadline. */}
              Due {withPlanDeadline(dayLabelWithYear(row.plan.dueOn))}
              {row.plan.submittedAt ? ` · sent ${cairoStamp(row.plan.submittedAt)}` : ""}
            </p>
          ) : null}
          {row.farApartDays.length > 0 ? (
            <p className="break-words text-xs font-semibold text-amber-800">
              {plural(row.farApartDays.length, "day", "days")} with customers far apart.
            </p>
          ) : null}
          <div>
            <CrmButton onClick={() => onOpen(row)} size="sm" variant={row.canApprove ? "primary" : undefined}>
              {row.canApprove ? "Review the month" : "Open the month"}
            </CrmButton>
          </div>
        </div>
      </CrmCard>
    );
  }

  return (
    <>
      <CrmBlock className="border-t border-slate-100" title="Month">
        <CrmChoice
          columns={3}
          label="Month"
          onChange={onMonth}
          options={view.months.map((entry) => ({
            value: entry.monthStart,
            label: entry.label,
            note: entry.waiting > 0 ? `${countText(entry.waiting)} waiting` : undefined,
          }))}
          value={view.monthStart}
        />
      </CrmBlock>

      {view.rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty
            message={test ? "Test monthly plans from any territory show here." : "The monthly plans of the territories beneath you show here."}
            title="No monthly plan this month"
          />
        </div>
      ) : null}

      {waiting.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`Waiting for your decision · ${countText(waiting.length)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              Open the month to read it, then approve it or return it with a note. Approving the month approves its weeks with it.
            </p>
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{waiting.map(card)}</div>
        </>
      ) : null}

      {rest.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`The rest · ${countText(rest.length)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              {waiting.length === 0 ? "Nothing waits for your decision. " : ""}
              Months not sent yet, already decided, or another manager’s.
            </p>
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{rest.map(card)}</div>
        </>
      ) : null}
    </>
  );
}

/**
 * A rep's requests to edit a week he already sent (owner, 2026-10-01): the district manager decides
 * first, then SFE — and SFE's approval opens the week again for him. The Administrator may decline.
 */
function PlanEditsSection({
  idPrefix,
  onChanged,
  onOpenWeek,
  team,
  test,
}: {
  idPrefix: string;
  onChanged: (message: string) => void;
  onOpenWeek: (edit: TeamPlanEdit) => void;
  team: TeamView;
  test: boolean;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [othersLimit, setOthersLimit] = useState(PAGE);

  if (team.planEdits.length === 0) {
    return (
      <div className="border-t border-slate-100">
        <CrmEmpty
          message={
            test
              ? "Test requests to edit a sent week show here while they wait."
              : "When a rep asks to change a week they already sent, the request shows here until the district manager and SFE have each taken their step."
          }
          title="No request to edit a plan waiting"
        />
      </div>
    );
  }

  const searchable = team.planEdits.length > SEARCH_FROM;
  const edits = searchable ? team.planEdits.filter((edit) => matchesWords(query, [edit.repName, edit.territoryName, edit.weekLabel])) : team.planEdits;
  const forYou = edits.filter((edit) => edit.canDecide);
  const others = edits.filter((edit) => !edit.canDecide);

  function card(edit: TeamPlanEdit) {
    return <PlanEditCard edit={edit} key={edit.requestId} onChanged={onChanged} onOpenWeek={() => onOpenWeek(edit)} />;
  }

  return (
    <>
      {searchable ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmSearchField
            id={`${idPrefix}-edits-search`}
            label="Find a request"
            onChange={(next) => {
              setQuery(next);
              setLimit(PAGE);
              setOthersLimit(PAGE);
            }}
            placeholder="Rep, territory or week"
            value={query}
          />
        </CrmBlock>
      ) : null}

      {edits.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Clear the search to see every request." title="No request matches" />
        </div>
      ) : null}

      {forYou.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`Waiting for your step · ${countText(forYou.length)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              The longest waiting first. Open the week to see it as it was sent, then take your step. A refusal needs a note the rep reads.
            </p>
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{forYou.slice(0, limit).map(card)}</div>
          <CrmShowMore left={forYou.length - limit} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
        </>
      ) : null}

      {others.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`Waiting for somebody else · ${countText(others.length)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              {forYou.length === 0 && edits.length === team.planEdits.length ? "Nothing waits for your step. " : ""}
              A request sits with the district manager first, then with SFE.
            </p>
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{others.slice(0, othersLimit).map(card)}</div>
          <CrmShowMore left={others.length - othersLimit} onMore={() => setOthersLimit((value) => value + PAGE)} page={PAGE} />
        </>
      ) : null}
    </>
  );
}

/**
 * Off-plan visits waiting for a decision. Two steps in order (owner, 2026-09-26): the territory’s own
 * manager, then the SFE. Everyone else in scope reads them and decides nothing — scope is sight, not
 * authority — which is why the split below is by `canDecide` and not by territory.
 *
 * One card per rep per visit day, the oldest day first (owner, 2026-10-02: "Off-plan day in one
 * place"). Every visit on a card is still decided on its own; "Approve all" on a card is that same
 * decision, once per visit, behind a confirm (unplanned-visit-card.tsx).
 */
function UnplannedSection({
  idPrefix,
  onBatchDone,
  onChanged,
  team,
  test,
}: {
  idPrefix: string;
  /** "Approve all" ran on a card: what went through, and by name what did not. */
  onBatchDone: (notice: OffPlanDayNotice) => void;
  onChanged: (message: string) => void;
  team: TeamView;
  test: boolean;
}) {
  const [query, setQuery] = useState("");
  // A page is a number of CARDS — one rep's day each.
  const [limit, setLimit] = useState(PAGE);
  const [othersLimit, setOthersLimit] = useState(PAGE);

  if (team.unplannedVisits.length === 0) {
    return (
      <div className="border-t border-slate-100">
        <CrmEmpty
          message={
            test
              ? "Test off-plan visits show here while they wait for a decision."
              : "A visit to a customer who was not on the rep’s sent plan for that day shows here, with what they wrote, until it is decided. Until then it counts in nothing."
          }
          title="No off-plan visit waiting"
        />
      </div>
    );
  }

  const searchable = team.unplannedVisits.length > SEARCH_FROM;
  const visits = searchable
    ? team.unplannedVisits.filter((visit) => matchesWords(query, [visit.customerName, visit.territoryName, visit.repName, visit.clarification]))
    : team.unplannedVisits;
  const { forYou, others } = splitOffPlanDays(visits);
  const forYouVisits = visits.filter((visit) => visit.canDecide).length;
  const othersVisits = visits.length - forYouVisits;

  function card(day: OffPlanDay<TeamUnplannedVisit>) {
    return <OffPlanDayCard day={day} key={day.key} onBatchDone={onBatchDone} onChanged={onChanged} />;
  }

  return (
    <>
      {searchable ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmSearchField
            id={`${idPrefix}-unplanned-search`}
            label="Find an off-plan visit"
            onChange={(next) => {
              setQuery(next);
              setLimit(PAGE);
              setOthersLimit(PAGE);
            }}
            placeholder="Customer, territory, rep or reason"
            value={query}
          />
        </CrmBlock>
      ) : null}

      {visits.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Clear the search to see every off-plan visit." title="No off-plan visit matches" />
        </div>
      ) : null}

      {forYou.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`Waiting for your decision · ${countText(forYouVisits)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              One card for each rep’s day, the oldest first. Each visit shows what they wrote and, when it was moved from another day of their sent
              plan, the day it was planned for. Approve or refuse each visit — a refusal needs a note they read — or approve the whole day at once.
              It counts in nothing until both steps approve it.
            </p>
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{forYou.slice(0, limit).map(card)}</div>
          <CrmShowMore left={forYou.length - limit} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
        </>
      ) : null}

      {others.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`Waiting for somebody else · ${countText(othersVisits)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              {forYou.length === 0 && visits.length === team.unplannedVisits.length ? "Nothing waits for your decision. " : ""}
              A visit sits with the territory’s own manager first, then with SFE.
            </p>
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{others.slice(0, othersLimit).map(card)}</div>
          <CrmShowMore left={others.length - othersLimit} onMore={() => setOthersLimit((value) => value + PAGE)} page={PAGE} />
        </>
      ) : null}
    </>
  );
}

function RequestsSection({
  idPrefix,
  onBatchDone,
  onChanged,
  team,
  test,
}: {
  idPrefix: string;
  /** The bulk drop has run: what went through, and by name what did not. */
  onBatchDone: (notice: TeamNotice) => void;
  onChanged: (message: string) => void;
  team: TeamView;
  test: boolean;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [othersLimit, setOthersLimit] = useState(PAGE);
  // The drops ticked for the bulk drop. Read through `pruneSelection` below, so a tick on a request that
  // left the screen (decided elsewhere, filtered out by the search) is never acted on.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  // How many of the selected drops are finished, while the bulk runs; null when it is not running.
  const [done, setDone] = useState<number | null>(null);
  const running = done !== null;

  if (team.requests.length === 0) {
    return (
      <div className="border-t border-slate-100">
        <CrmEmpty
          message={
            test
              ? "Test list requests made on the List tab show here: a grade change, a drop, a new customer to add, or one to bring back."
              : "List requests from the territories beneath you show here while they wait for a decision: a grade change, a drop, a new customer to add, or one to bring back from the Archive."
          }
          title="No requests waiting"
        />
      </div>
    );
  }

  const searchable = team.requests.length > SEARCH_FROM;
  const requests = searchable
    ? team.requests.filter((request) =>
        matchesWords(query, [
          request.customerName,
          request.territoryName,
          request.requestedByName,
          request.dropReasonLabel,
          request.proposedGrade ? `grade ${request.proposedGrade}` : null,
        ]),
      )
    : team.requests;
  const forYou = requests.filter((request) => request.canDecide);
  // Returned to the rep for a comment: it waits for HIM, so it is neither yours to decide nor another manager's.
  const withRep = requests.filter((request) => request.withRep);
  const others = requests.filter((request) => !request.canDecide && !request.withRep);

  // Bulk drop (owner, 2026-10-12): every drop waiting at this viewer's step can be ticked, or all at once.
  // Each is approved through the one decide route its own Approve uses, one at a time.
  const droppable = bulkDropTargets(requests);
  const bulkOffered = droppable.length >= BULK_DROP_FROM;
  const chosen = pruneSelection(selected, requests);
  const chosenRequests = droppable.filter((request) => chosen.has(request.requestId));
  const allChosen = droppable.length > 0 && chosen.size === droppable.length;
  const chosenCount = countText(chosen.size);
  const chosenStep = chosenRequests.every((request) => request.stage === "sfe")
    ? "sfe"
    : chosenRequests.every((request) => request.stage === "manager")
      ? "manager"
      : "mixed";

  function toggle(requestId: string, next: boolean) {
    const copy = new Set(chosen);
    if (next) copy.add(requestId);
    else copy.delete(requestId);
    setSelected(copy);
    setConfirming(false);
  }

  function chooseAll(next: boolean) {
    setSelected(next ? new Set(droppable.map((request) => request.requestId)) : new Set());
    setConfirming(false);
  }

  async function dropChosen() {
    const batch = [...chosenRequests];
    setConfirming(false);
    setDone(0);
    const outcomes: BulkDropOutcome[] = [];
    // One at a time, longest waiting first: each is its own decision through its own route, and a refusal
    // of one is named while the rest go on.
    // Dropping a customer closes every other request waiting on him, so a rep's repeat ask for the same
    // customer is not sent after the first one went through: it would only come back "already decided".
    const dropped = new Set<string>();
    for (const request of batch) {
      if (repeatOfDropped(request, dropped)) {
        outcomes.push({ customerName: request.customerName, ok: true, final: true, repeat: true });
        setDone(outcomes.length);
        continue;
      }
      try {
        const result = await crmPost<{ final: boolean }>("/api/phoenix-crm/list/requests/decide", bulkDropDecisionBody(request), "request");
        if (result.final && request.customerKey) dropped.add(request.customerKey);
        outcomes.push({ customerName: request.customerName, ok: true, final: result.final });
      } catch (error) {
        outcomes.push({ customerName: request.customerName, ok: false, why: bulkDropFailureText(errorCodeOf(error), messageOf(error)) });
      }
      setDone(outcomes.length);
    }
    setDone(null);
    setSelected(new Set());
    const notice = bulkDropNotice(outcomes);
    onBatchDone({
      tone: notice.tone,
      title: notice.title,
      message:
        notice.failures.length > 0 ? (
          <span className="grid gap-0.5">
            <span className="block">Not approved:</span>
            {notice.failures.map((line, index) => (
              <span className="block" dir="auto" key={index}>
                {line}
              </span>
            ))}
          </span>
        ) : null,
    });
  }

  function card(request: TeamRequest) {
    return (
      <RequestCard
        canDecide={request.canDecide}
        canOverride={request.canOverride}
        canWithdraw={false}
        key={request.requestId}
        onChanged={onChanged}
        request={request}
        seatId={request.seatId}
        selection={
          bulkOffered && droppable.includes(request)
            ? { checked: chosen.has(request.requestId), disabled: running, onChange: (next) => toggle(request.requestId, next) }
            : undefined
        }
        territoryName={request.territoryName}
        test={test}
      />
    );
  }

  return (
    <>
      {searchable ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmSearchField
            id={`${idPrefix}-requests-search`}
            label="Find a request"
            onChange={(next) => {
              setQuery(next);
              setLimit(PAGE);
              setOthersLimit(PAGE);
            }}
            placeholder="Customer, territory or rep"
            value={query}
          />
        </CrmBlock>
      ) : null}

      {requests.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Clear the search to see every request." title="No request matches" />
        </div>
      ) : null}

      {forYou.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`Waiting for your decision · ${countText(forYou.length)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              The longest waiting first. Approve a request, or refuse it with a note the rep reads.
              {bulkOffered ? " Tick the drops you want gone, or select them all, and approve them in one go." : ""}
            </p>
            {bulkOffered ? (
              <div className="mt-3 grid min-w-0 gap-2">
                <CrmCheck checked={allChosen} disabled={running} onChange={chooseAll}>
                  {`Select all ${countText(droppable.length)} drop requests`}
                </CrmCheck>
                {chosen.size > 0 ? (
                  confirming ? (
                    <div className="grid min-w-0 gap-2 border border-orange-200 bg-orange-50/40 px-3.5 py-3">
                      <p className="break-words text-sm font-black text-slate-950">{`Approve ${chosenCount} drop ${chosen.size === 1 ? "request" : "requests"}?`}</p>
                      <p className="break-words text-sm font-medium leading-6 text-slate-600">
                        Each one is approved on its own, as your decision, exactly as its own Approve does, and the rep is told of each.{" "}
                        {chosenStep === "manager"
                          ? "They go on to SFE, who decides the last step."
                          : chosenStep === "sfe"
                            ? "Each customer leaves the rep’s list for the Archive."
                            : "Those at SFE’s step leave the list for the Archive; the others go on to SFE."}{" "}
                        One that cannot be approved is named, and the others stand.
                      </p>
                      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                        <CrmButton onClick={() => void dropChosen()} variant="danger">
                          {`Approve ${chosenCount}`}
                        </CrmButton>
                        <CrmButton onClick={() => setConfirming(false)}>Not yet</CrmButton>
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <CrmButton busy={running} disabled={running} onClick={() => setConfirming(true)} variant="danger">
                        {running
                          ? `Approving ${countText(Math.min((done ?? 0) + 1, chosen.size))} of ${chosenCount}…`
                          : `Drop the ${chosenCount} selected`}
                      </CrmButton>
                      <CrmButton disabled={running} onClick={() => chooseAll(false)} size="sm">
                        Clear selection
                      </CrmButton>
                    </div>
                  )
                ) : null}
              </div>
            ) : null}
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{forYou.slice(0, limit).map(card)}</div>
          <CrmShowMore left={forYou.length - limit} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
        </>
      ) : null}

      {withRep.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`With the rep for a comment · ${countText(withRep.length)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              SFE asked the rep to explain. Each comes back to SFE the moment the rep answers.
            </p>
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{withRep.map(card)}</div>
        </>
      ) : null}

      {others.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`Waiting for another manager · ${countText(others.length)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              {forYou.length === 0 && requests.length === team.requests.length ? "Nothing waits for your decision. " : ""}
              Each one sits with the territory’s own manager first; a drop, an addition or a bring-back then goes on to SFE.
            </p>
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{others.slice(0, othersLimit).map(card)}</div>
          <CrmShowMore left={others.length - othersLimit} onMore={() => setOthersLimit((value) => value + PAGE)} page={PAGE} />
        </>
      ) : null}
    </>
  );
}

function ListsSection({ idPrefix, onOpenList, team }: { idPrefix: string; onOpenList?: (seatId: string) => void; team: TeamView }) {
  const [filter, setFilter] = useState<ListFilter | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  if (team.territories.length === 0) {
    return (
      <div className="border-t border-slate-100">
        <CrmEmpty message="A territory shows here once its line opens in Phoenix CRM." title="No territories to show" />
      </div>
    );
  }

  const counts: Record<Exclude<ListFilter, "all">, number> = { not_ready: 0, ready: 0, vacant: 0 };
  for (const row of team.territories) {
    if (listFilterMatches(row, "not_ready")) counts.not_ready += 1;
    if (listFilterMatches(row, "ready")) counts.ready += 1;
    if (listFilterMatches(row, "vacant")) counts.vacant += 1;
  }
  // Every territory, always. Defaulting to "not_ready" opened this section on a filtered subset for as
  // long as any list was part-way through — which, now that nothing waits on validation, is every
  // territory for months. He chooses the filter; the page does not choose one for him.
  const currentFilter: ListFilter = filter ?? "all";
  const searchable = team.territories.length > SEARCH_FROM;
  const rows = team.territories.filter(
    (row) => listFilterMatches(row, currentFilter) && (!searchable || matchesWords(query, territoryWords(row.territory))),
  );
  const shown = rows.slice(0, limit);
  const filterOptions: Array<CrmChoiceOption<ListFilter>> = [
    { value: "not_ready", label: "Validating", note: countText(counts.not_ready) },
    { value: "ready", label: "Ready", note: countText(counts.ready) },
    { value: "vacant", label: "Without a rep", note: countText(counts.vacant) },
    { value: "all", label: "Every territory", note: countText(team.territories.length) },
  ];

  function filterBy(update: () => void) {
    update();
    setLimit(PAGE);
  }

  function openListButton(seatId: string) {
    if (!onOpenList) return null;
    return (
      <CrmButton onClick={() => onOpenList(seatId)} size="sm">
        Open the list
      </CrmButton>
    );
  }

  return (
    <>
      <CrmBlock className="border-t border-slate-100" title="Customer lists">
        <p className="break-words text-sm font-medium leading-6 text-slate-600">
          Every customer a rep carried over from iReports360 is on their list from the first day, and they plan and visit on all of them
          from the first day. Validating each one at the door is what makes those visits count. Nothing here is waiting on you.
        </p>
        <div className={cn("mt-3 grid min-w-0 gap-3", searchable ? "md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-end" : undefined)}>
          <CrmField label="Show">
            <CrmChoice columns={4} label="Show" onChange={(next) => filterBy(() => setFilter(next))} options={filterOptions} value={currentFilter} />
          </CrmField>
          {searchable ? (
            <CrmSearchField
              id={`${idPrefix}-lists-search`}
              label="Find a territory"
              onChange={(next) => filterBy(() => setQuery(next))}
              placeholder="Territory, rep or manager"
              value={query}
            />
          ) : null}
        </div>
      </CrmBlock>

      {rows.length === 0 ? (
        <div className="border-t border-slate-100">
          <CrmEmpty message="Clear the search or choose another filter." title="No territory matches" />
        </div>
      ) : (
        <div className="border-t border-slate-100">
          <CrmCardsOnPhone>
            {shown.map((row) => (
              <CrmCard
                accent={row.readiness?.ready ? "border-l-emerald-500" : row.readiness ? "border-l-amber-500" : "border-l-slate-300"}
                actions={openListButton(row.territory.seatId)}
                key={row.territory.seatId}
                meta={[row.territory.regionName, metaText(row.territory, team.viewerHrId, false)].filter(Boolean).join(" · ")}
                status={<ReadinessPill readiness={row.readiness} />}
                title={row.territory.name}
              >
                {row.readiness ? <p className="break-words text-sm font-semibold leading-6 text-slate-700">{readinessLine(row.readiness)}</p> : null}
                {row.readiness && readySince(row.readiness) ? (
                  <p className="break-words text-xs font-semibold leading-5 text-slate-500">{readySince(row.readiness)}</p>
                ) : null}
                <TodayLine row={row} />
                <VendorLeftoverLine row={row} />
                <p className="break-words text-xs font-semibold leading-5 text-slate-500">{requestsText(row)}</p>
              </CrmCard>
            ))}
          </CrmCardsOnPhone>
          <CrmTable columns={["26%", "22%", null, "18%"]}>
            <thead>
              <tr>
                <th className={crmThClassName} scope="col">
                  Territory
                </th>
                <th className={crmThClassName} scope="col">
                  Rep and manager
                </th>
                <th className={crmThClassName} scope="col">
                  Customer list and today
                </th>
                <th className={crmThClassName} scope="col">
                  Requests
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.territory.seatId}>
                  <td className={crmTdClassName}>
                    <p className="font-black text-slate-950">{row.territory.name}</p>
                    {row.territory.regionName ? <p className="mt-0.5 text-xs text-slate-500">{row.territory.regionName}</p> : null}
                    {onOpenList ? <div className="mt-2">{openListButton(row.territory.seatId)}</div> : null}
                  </td>
                  <td className={crmTdClassName}>
                    <p>{repText(row.territory)}</p>
                    {reviewerText(row.territory, team.viewerHrId) ? (
                      <p className="mt-0.5 text-xs text-slate-500">{reviewerText(row.territory, team.viewerHrId)}</p>
                    ) : null}
                  </td>
                  <td className={crmTdClassName}>
                    {row.readiness ? (
                      <>
                        <ReadinessPill readiness={row.readiness} />
                        <p className="mt-1">{readinessLine(row.readiness)}</p>
                        {readySince(row.readiness) ? <p className="mt-0.5 text-xs text-slate-500">{readySince(row.readiness)}</p> : null}
                      </>
                    ) : null}
                    {/* The day rides in the list's own cell — the fits-the-screen rule merges columns rather
                        than squeezing a fifth into the table. */}
                    <div className="mt-2">
                      <TodayLine row={row} />
                      <VendorLeftoverLine row={row} />
                    </div>
                  </td>
                  <td className={crmTdClassName}>{requestsText(row)}</td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <CrmShowMore left={rows.length - limit} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
        </div>
      )}
    </>
  );
}
