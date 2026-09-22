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

import { useId, useRef, useState } from "react";

import { crmUrl, useCrmGet } from "@/components/phoenix-crm/api";
import { cairoDayOf, cairoStamp, countText, dayLabel, dayLabelWithYear, plural, weekLabel } from "@/components/phoenix-crm/format";
import { matchesWords, PENDING_PILL } from "@/components/phoenix-crm/labels";
import { PlanTab } from "@/components/phoenix-crm/plan-tab";
import { RequestCard } from "@/components/phoenix-crm/request-card";
import {
  CrmBlock,
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
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
  CrmStat,
  CrmStatGrid,
  CrmTable,
  crmTdClassName,
  crmThClassName,
  type CrmChoiceOption,
  type NoteTone,
  type PillTone,
} from "@/components/phoenix-crm/ui";
import { fieldWeekStart, plannableWeeks } from "@/lib/phoenix-crm/calendar";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import type { PlanReviewRow, PlanReviewView, SeatReadiness, TeamRequest, TeamTerritoryRow, TeamView, TerritorySummary } from "@/lib/phoenix-crm/view-types";
import { cn } from "@/lib/utils";

type TeamSection = "plans" | "requests" | "lists";
type ReviewFilter = "waiting" | "not_sent" | "approved" | "all";
type ListFilter = "not_ready" | "ready" | "vacant" | "all";
type TeamNotice = { tone: NoteTone; title: string; message?: string | null };
type OpenPlan = { seatId: string; weekStart: string };

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

function reviewerText(territory: TerritorySummary): string {
  return territory.reviewerName ? `Reviewed by ${territory.reviewerName}` : "No manager above this territory";
}

// ── Plans ───────────────────────────────────────────────────────────────────────────────────────

function reviewFilterOf(row: PlanReviewRow): Exclude<ReviewFilter, "all"> {
  const status = row.plan?.status ?? null;
  if (status === "submitted") return "waiting";
  if (status === "approved") return "approved";
  return "not_sent";
}

/** "3 AM · 41 PM" — accounts and doctors side by side, never added together. */
function placedText(row: PlanReviewRow): string {
  if (!row.plan) return "No plan yet";
  return `${countText(row.accounts)} AM · ${countText(row.doctors)} PM`;
}

function planStamp(row: PlanReviewRow): string {
  const { plan } = row;
  if (!plan) return "The rep has not started this week's plan";
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
  if (!row.plan) return <span className="text-xs font-semibold text-slate-500">Nothing to look at yet</span>;
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
  const [openPlan, setOpenPlan] = useState<OpenPlan | null>(null);
  const [notice, setNotice] = useState<TeamNotice | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  function scrollToTop() {
    const top = topRef.current;
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: "start" });
  }

  function refresh() {
    team.reload();
    reviews.reload();
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

  function requestDecided(message: string) {
    setNotice({ tone: "info", title: message });
    refresh();
    scrollToTop();
  }

  const fallbackWeeks = plannableWeeks(cairoToday);
  const weeks: ReadonlyArray<{ weekStart: string; waiting: number | null }> =
    reviews.data?.weeks ?? fallbackWeeks.map((week) => ({ weekStart: week, waiting: null }));
  const selectedWeek = reviews.data?.weekStart ?? weekStart ?? fallbackWeeks[0];
  const plansWaiting = reviews.data ? reviews.data.weeks.reduce((sum, week) => sum + week.waiting, 0) : null;
  const summary = team.data?.summary ?? null;
  const settled = (team.data !== null || !team.loading) && (reviews.data !== null || !reviews.loading);
  const current: TeamSection | null =
    section ?? (settled ? ((plansWaiting ?? 0) === 0 && (summary?.waitingForYou ?? 0) > 0 ? "requests" : "plans") : null);

  const sectionOptions: Array<CrmChoiceOption<TeamSection>> = [
    {
      value: "plans",
      label: "Weekly plans",
      note: plansWaiting === null ? undefined : plansWaiting > 0 ? `${countText(plansWaiting)} waiting for you` : "Nothing waiting for you",
    },
    {
      value: "requests",
      label: "Grade and drop requests",
      note: summary
        ? summary.waitingForYou > 0
          ? `${countText(summary.waitingForYou)} waiting for you`
          : `${countText(summary.requestsWaiting)} waiting`
        : undefined,
    },
  ];
  if (!test) {
    sectionOptions.push({
      value: "lists",
      label: "Customer lists",
      note: summary ? `${countText(summary.ready)} of ${countText(summary.ready + summary.notReady)} ready` : undefined,
    });
  }

  return (
    <div className="min-w-0 scroll-mt-24" ref={topRef}>
      {openPlan ? (
        <PlanTab
          initialWeekStart={openPlan.weekStart}
          key={`${openPlan.seatId}|${openPlan.weekStart}`}
          onChanged={refresh}
          onClose={{ label: "Team", onClose: closePlan }}
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
              : "The territories beneath you: the weekly plans, grade and drop requests, and how far each customer list has come."
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

          {summary ? (
            <>
              {team.error ? <CrmLoadError message={team.error} onRetry={team.reload} /> : null}
              <CrmBlock>
                <CrmStatGrid>
                  <CrmStat
                    label="Plans waiting for you"
                    note="Sent by the rep for your approval"
                    tone={(plansWaiting ?? 0) > 0 ? "warn" : "neutral"}
                    value={countText(plansWaiting)}
                  />
                  <CrmStat
                    label="Requests waiting for you"
                    note={summary.requestsWaiting > summary.waitingForYou ? `${countText(summary.requestsWaiting)} waiting in all` : "Grade and drop requests"}
                    tone={summary.waitingForYou > 0 ? "warn" : "neutral"}
                    value={countText(summary.waitingForYou)}
                  />
                  {test ? null : (
                    <CrmStat
                      label="Lists ready"
                      note={summary.notReady > 0 ? `${countText(summary.notReady)} validating` : "Every list is ready"}
                      tone={summary.notReady > 0 ? "neutral" : "good"}
                      value={`${countText(summary.ready)} of ${countText(summary.ready + summary.notReady)}`}
                    />
                  )}
                  <CrmStat
                    label={test ? "Territories with test requests" : "Territories"}
                    note={test ? "Waiting for your decision" : summary.vacant > 0 ? `${countText(summary.vacant)} without a rep` : "Every territory has a rep"}
                    value={countText(summary.territories)}
                  />
                </CrmStatGrid>
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
              weeks={weeks}
            />
          ) : null}

          {current === "requests" && team.data ? <RequestsSection idPrefix={idPrefix} onChanged={requestDecided} team={team.data} test={test} /> : null}

          {current === "lists" && team.data ? <ListsSection idPrefix={idPrefix} onOpenList={onOpenList} team={team.data} /> : null}
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
  weeks: ReadonlyArray<{ weekStart: string; waiting: number | null }>;
}) {
  const [filter, setFilter] = useState<ReviewFilter | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);

  const weekBlock = (
    <CrmBlock className="border-t border-slate-100" title="Week">
      <CrmChoice
        columns={4}
        label="Week"
        onChange={onWeek}
        options={weeks.map((week) => ({
          value: week.weekStart,
          label: weekLabel(week.weekStart),
          note:
            [
              week.weekStart === thisWeek ? "This week" : null,
              week.waiting === null ? null : week.waiting > 0 ? `${countText(week.waiting)} waiting for you` : "Nothing waiting",
            ]
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
        <p className="mt-3 break-words text-xs font-semibold leading-5 text-slate-500">
          Far apart: two customers on the same day are more than {countText(view.farApartKm)} km from each other.
        </p>
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
              return (
                <CrmCard
                  accent={STATUS_ACCENT[status]}
                  actions={action(row)}
                  key={row.territory.seatId}
                  meta={test ? repText(row.territory) : `${repText(row.territory)} · ${reviewerText(row.territory)}`}
                  status={<CrmPill tone={STATUS_TONE[status]}>{row.plan?.statusLabel ?? "Not started"}</CrmPill>}
                  title={row.territory.name}
                >
                  <p className="break-words text-sm font-black text-slate-800">{placedText(row)}</p>
                  <p className="break-words text-xs font-semibold leading-5 text-slate-500">{planStamp(row)}</p>
                  <div className="mt-2">
                    <ReviewFlags row={row} />
                  </div>
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
                return (
                  <tr key={row.territory.seatId}>
                    <td className={crmTdClassName}>
                      <p className="font-black text-slate-950">{row.territory.name}</p>
                      <p className="mt-0.5 text-xs text-slate-500">{repText(row.territory)}</p>
                      {test ? null : <p className="text-xs text-slate-500">{reviewerText(row.territory)}</p>}
                    </td>
                    <td className={crmTdClassName}>
                      <CrmPill tone={STATUS_TONE[status]}>{row.plan?.statusLabel ?? "Not started"}</CrmPill>
                      <p className="mt-1 text-xs text-slate-500">{planStamp(row)}</p>
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

function RequestsSection({
  idPrefix,
  onChanged,
  team,
  test,
}: {
  idPrefix: string;
  onChanged: (message: string) => void;
  team: TeamView;
  test: boolean;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [othersLimit, setOthersLimit] = useState(PAGE);

  if (team.requests.length === 0) {
    return (
      <div className="border-t border-slate-100">
        <CrmEmpty
          message={
            test
              ? "Test grade and drop requests made on the List tab show here."
              : "Grade and drop requests from the territories beneath you show here while they wait for a decision."
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
  const others = requests.filter((request) => !request.canDecide);

  function card(request: TeamRequest) {
    return (
      <RequestCard
        canDecide={request.canDecide}
        canWithdraw={false}
        key={request.requestId}
        onChanged={onChanged}
        request={request}
        seatId={request.seatId}
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
            </p>
          </CrmBlock>
          <div className="divide-y divide-slate-100 border-t border-slate-100">{forYou.slice(0, limit).map(card)}</div>
          <CrmShowMore left={forYou.length - limit} onMore={() => setLimit((value) => value + PAGE)} page={PAGE} />
        </>
      ) : null}

      {others.length > 0 ? (
        <>
          <CrmBlock className="border-t border-slate-100" title={`Waiting for another manager · ${countText(others.length)}`}>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              {forYou.length === 0 && requests.length === team.requests.length ? "Nothing waits for your decision. " : ""}
              The district manager above each territory decides these.
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
          Every customer a rep carried over from iReports360 is on his list from the first day, and he plans and visits on all of them
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
                meta={`${repText(row.territory)} · ${reviewerText(row.territory)}`}
                status={<ReadinessPill readiness={row.readiness} />}
                title={row.territory.name}
              >
                {row.readiness ? <p className="break-words text-sm font-semibold leading-6 text-slate-700">{readinessLine(row.readiness)}</p> : null}
                {row.readiness && readySince(row.readiness) ? (
                  <p className="break-words text-xs font-semibold leading-5 text-slate-500">{readySince(row.readiness)}</p>
                ) : null}
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
                  Customer list
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
                    <p className="mt-0.5 text-xs text-slate-500">{reviewerText(row.territory)}</p>
                  </td>
                  <td className={crmTdClassName}>
                    {row.readiness ? (
                      <>
                        <ReadinessPill readiness={row.readiness} />
                        <p className="mt-1">{readinessLine(row.readiness)}</p>
                        {readySince(row.readiness) ? <p className="mt-0.5 text-xs text-slate-500">{readySince(row.readiness)}</p> : null}
                      </>
                    ) : (
                      "—"
                    )}
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
