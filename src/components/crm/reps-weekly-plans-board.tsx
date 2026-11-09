import Link from "next/link";

import { PlanStatusPicker } from "@/components/crm/plan-status-picker";
import { PlanWeekPicker } from "@/components/crm/plan-week-picker";
import { PlanApproveButton } from "@/components/crm/plan-verify-button";
import {
  BackToAllReps,
  cairoStamp,
  countOf,
  EmptyNote,
  ExportRowBar,
  GroupedCardGrid,
  HelpLine,
  RepCardFrame,
  RepProfileBand,
  Section,
  ShareBar,
  StatusMark,
  Swatch,
  TeamRollup,
  TeamTable,
  TeamTableName,
  Tile,
  TileRow,
  TONE_LEFT_RULE,
  toneFromTextClass,
  type TeamColumn,
} from "@/components/crm/reps-list-chrome";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { RepsListFilters } from "@/components/crm/reps-list-filters";
import { PlanDoctorsTable } from "@/components/crm/reps-list-tables";
import type { PlanSummary } from "@/lib/crm/plan-board";
import type { PlanStatusFilter } from "@/lib/crm/plan-status-filter";
import {
  PLAN_STATUS_AREA_MANAGER_VERIFIED,
  PLAN_STATUS_NEW,
  planStatusClass,
  planStatusLabel,
} from "@/lib/crm/plan-verification";
import { planWeekMix } from "@/lib/crm/plan-week-mix";
import { groupRepsByTeam, teamHeading } from "@/lib/crm/reps-list-groups";
import type { RepsWeeklyPlanRep, RepsWeeklyPlansBoard } from "@/lib/crm/reps-weekly-plans-board";

// Server half of Reps Weekly Plans — tab two of the Reps List board.
//
// It borrows nothing from plan-verification-tables.tsx and that is deliberate: all three tables in
// there render through `PortalDesktopTable` over a min-width floor of 720–1240px, which is the
// horizontal scroll the fits-the-screen golden rule forbids outright. The look comes instead from
// reps-list-chrome.tsx, shared with tab one, because two tabs inside one border must read as one
// screen (owner's standing rule: match the sibling pages, never a one-off).
//
// THE DOCTORS TABLE IS TAB ONE'S OWN, IMPORTED. It was written here for the first build and moved
// into reps-list-tables.tsx on 2026-09-01, when the owner asked for it to be "exactly as the contact
// list": the brick, the polished bilingual address with its check-in stamp, the confidence chip, the
// neighbourhood tints and the measured column widths all live in that file, and a second table here
// could match them on the day it was written and silently stop matching on the next change to any
// one of them. See `PlanDoctorsTable` there for what differs — days instead of bricks, and the shift.
//
// EVERYTHING ELSE HERE IS A SERVER COMPONENT. The four client pieces are the ones that must be: the
// cascade, the week picker, the Approve button and that doctors table. Choosing a rep swaps
// the whole board, exactly as tab one does, so the doctors always land at the top of the page — the
// reason the period board needs a scroll-into-view effect does not exist on this one.

/**
 * The current filters as a query string, with `rep` replaced (or dropped when null).
 *
 * The status filter is carried. "Back to all reps" is the link that needs it most: a manager who
 * narrowed to the three plans waiting on him, opened one and signed it expects to come back to the
 * other two, not to all seventy.
 */
function hrefWithRep(basePath: string, board: RepsWeeklyPlansBoard, repKey: string | null): string {
  const query = new URLSearchParams();
  query.set("tab", "plans");
  query.set("week", board.week.key);
  if (board.selection.line) query.set("line", board.selection.line);
  if (board.selection.region) query.set("region", board.selection.region);
  if (board.selection.area) query.set("area", board.selection.area);
  if (board.statusFilter !== "all") query.set("status", board.statusFilter);
  if (repKey) query.set("rep", repKey);
  return `${basePath}?${query.toString()}`;
}

/**
 * The same URL narrowed to one status — what the tiles link to.
 *
 * The rep is dropped, exactly as the select does it: narrowing the grid is a browsing action, and a
 * rep left selected keeps his plan on screen and the grid hidden, so the tile would appear to do
 * nothing at all. `all` drops the parameter rather than writing `status=all`, so the plain board and
 * the cleared board are the same URL.
 */
function hrefWithStatus(basePath: string, board: RepsWeeklyPlansBoard, status: PlanStatusFilter): string {
  const query = new URLSearchParams();
  query.set("tab", "plans");
  query.set("week", board.week.key);
  if (board.selection.line) query.set("line", board.selection.line);
  if (board.selection.region) query.set("region", board.selection.region);
  if (board.selection.area) query.set("area", board.selection.area);
  if (status !== "all") query.set("status", status);
  return `${basePath}?${query.toString()}`;
}

/** The Vacant Areas tab under the same cascade — where the "Vacant seats" key card opens. */
function hrefToVacant(basePath: string, board: RepsWeeklyPlansBoard): string {
  const query = new URLSearchParams();
  query.set("tab", "vacant");
  if (board.selection.line) query.set("line", board.selection.line);
  if (board.selection.region) query.set("region", board.selection.region);
  if (board.selection.area) query.set("area", board.selection.area);
  return `${basePath}?${query.toString()}`;
}

/** The same URL with a different plan of the same rep opened. Only used when a rep filed two. */
function hrefWithPlan(basePath: string, board: RepsWeeklyPlansBoard, planId: number): string {
  const base = hrefWithRep(basePath, board, board.selection.rep ?? null);
  return `${base}&plan=${planId}`;
}

/**
 * What the rep grid says about itself once a status is chosen, and what it says when that leaves it
 * empty.
 *
 * An empty grid has TWO causes and they need different sentences. "No reps match these filters"
 * belongs to the cascade — no seated rep works that line and area. An empty STATUS slice is the
 * opposite kind of news: it usually means there is nothing left to do, and printing the cascade's
 * sentence over it would send a manager hunting for a filter to clear when the honest answer is
 * that he is finished for the week.
 */
const STATUS_COPY: Record<
  PlanStatusFilter,
  { description: string; emptyDetail: string; emptyTitle: string; heading: string }
> = {
  all: {
    description:
      "Pick a rep to open the plan they filed for this week. Narrow with the filters above first if the list is long.",
    emptyDetail:
      "Clear a level of the cascade to widen it. An empty result here means no seated rep works that combination — not that nobody filed a plan.",
    emptyTitle: "No reps match these filters.",
    heading: "Medical reps",
  },
  awaiting: {
    description: "The reps whose plans are filed and waiting on your signature. Pick one to read it and approve it.",
    emptyDetail:
      "Every rep in your reach who filed a plan this week has been verified. Reps who filed nothing are counted separately — check the No plan filed tile before calling the week done.",
    emptyTitle: "Nothing is waiting on you this week.",
    heading: "Awaiting your verification",
  },
  missing: {
    description: "The reps with no plan in the CRM for this week at all. There is nothing here to verify.",
    emptyDetail: "Every rep in your reach has a plan in the CRM for this week.",
    emptyTitle: "Everyone filed a plan this week.",
    heading: "No plan filed",
  },
  verified: {
    description: "The reps whose plans are already signed off in the CRM.",
    emptyDetail:
      "No plan has been signed off for this week yet. That is normal for a week that has not started — plans are usually verified in the days before it.",
    emptyTitle: "No plan has been verified this week.",
    heading: "Verified plans",
  },
};

/**
 * What a rep's week says in one line.
 *
 * "Not filed" is its own answer and never folded into "Pending". A rep who has filed nothing and a
 * rep waiting on his manager are different facts, and only the second is the manager's move — a
 * board that prints them the same way turns "he hasn't planned his week" into "you haven't signed
 * it", which points the blame at the wrong person.
 */
function repPlanText(rep: RepsWeeklyPlanRep, weekIsFuture: boolean): { text: string; tone: string } {
  // A week that has not begun is not a week anyone has failed to plan — plans are filed in the days
  // just before it. Saying "No plan filed" in red for every rep on next week's board turns "the week
  // hasn't started" into "66 reps let you down". Say it plainly and neutrally instead (audit, 2026-09-21).
  if (rep.plansFiled === 0) {
    return weekIsFuture
      ? { text: "Not filed yet", tone: "text-slate-500" }
      : { text: "No plan filed", tone: "text-rose-700" };
  }
  const status = planStatusLabel(rep.planStatus);
  const suffix = rep.plansFiled > 1 ? ` · ${rep.plansFiled} plans` : "";
  return { text: `${status}${suffix}`, tone: planStatusClass(rep.planStatus) };
}

/**
 * One rep's week as a card: his monogram, name and areas, then the plan's status — in words, led by its swatch, and
 * repeated on the card's 3px left rule so a column of cards can be read for its colours before a word is read.
 */
function RepCard({ href, rep, weekIsFuture }: { href: string; rep: RepsWeeklyPlanRep; weekIsFuture: boolean }) {
  const plan = repPlanText(rep, weekIsFuture);
  const tone = toneFromTextClass(plan.tone);
  return (
    <RepCardFrame
      href={href}
      monogramMuted={rep.plansFiled === 0}
      name={rep.name}
      places={rep.areaNames.length > 0 ? rep.areaNames.join(" · ") : "No area on the seat"}
      tone={tone}
    >
      <StatusMark text={plan.text} tone={tone} />
    </RepCardFrame>
  );
}

/**
 * The team table's columns on the Weekly Plans tab — the card's facts, one column each, with the plan's status
 * spoken in the same words and colour the card wears.
 */
function planColumns(basePath: string, board: RepsWeeklyPlansBoard, weekIsFuture: boolean): TeamColumn<RepsWeeklyPlanRep>[] {
  return [
    {
      cell: (rep) => (
        <TeamTableName href={hrefWithRep(basePath, board, rep.repKey)} muted={rep.plansFiled === 0} name={rep.name} />
      ),
      key: "rep",
      label: "Medical rep",
      width: "w-[32%]",
    },
    {
      cell: (rep) => (
        <span className="text-phx-xs font-semibold text-slate-600 [overflow-wrap:anywhere]">
          {rep.areaNames.length > 0 ? rep.areaNames.join(" · ") : "No area on the seat"}
        </span>
      ),
      key: "area",
      label: "Area",
      width: "w-[26%]",
    },
    {
      cell: (rep) => {
        const plan = repPlanText(rep, weekIsFuture);
        return <StatusMark text={plan.text} tone={toneFromTextClass(plan.tone)} />;
      },
      key: "plan",
      label: "This week's plan",
      width: "w-[26%]",
    },
    {
      align: "right",
      cell: (rep) => <span className="font-black text-slate-900 tabular-nums">{rep.contactCount}</span>,
      key: "contacts",
      label: "Contacts on the list",
      width: "w-[16%]",
    },
  ];
}

/**
 * A region's own week, beside its heading: how many of its reps are verified, waiting and missing. Counted from the
 * cards in the group — the same reps the heading says it holds — so the heading and its line can never disagree.
 */
function RegionWeekLine({ members, weekIsFuture }: { members: readonly RepsWeeklyPlanRep[]; weekIsFuture: boolean }) {
  const filed = members.filter((member) => member.plansFiled > 0);
  const waiting = filed.filter((member) => (member.planStatus ?? PLAN_STATUS_NEW) === PLAN_STATUS_NEW).length;
  const verified = filed.length - waiting;
  const missing = members.length - filed.length;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="inline-flex items-center gap-1.5">
        <Swatch tone="emerald" />
        <span className="font-black text-slate-900 tabular-nums">{verified}</span> verified
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Swatch tone="amber" />
        <span className="font-black text-slate-900 tabular-nums">{waiting}</span> waiting
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Swatch tone={weekIsFuture ? "slate" : "rose"} />
        <span className="font-black text-slate-900 tabular-nums">{missing}</span> {weekIsFuture ? "not filed yet" : "not filed"}
      </span>
    </span>
  );
}

/**
 * The sentence beside the button. iReports360 was retired on 6 November 2026, so an old-CRM plan
 * (positive id) is read-only and says so; a plan filed in Phoenix CRM is spoken of by its own status.
 */
function planPanelSentence(plan: PlanSummary, canApprove: boolean): string {
  if (plan.crmPlanId > 0) {
    return plan.status === PLAN_STATUS_AREA_MANAGER_VERIFIED
      ? "Verified by an area manager in the old CRM, which closed on 6 November 2026. It is read-only here."
      : "Filed in the old CRM, which closed on 6 November 2026. Its status is the one the old CRM last held, read-only here.";
  }
  switch (plan.phoenixStatus) {
    case "submitted":
      return canApprove
        ? "Sent in Phoenix CRM. Approving here approves the week exactly as the Team tab does; a return is made there."
        : "This week is waiting for the rep's district or regional manager to approve it in Phoenix CRM.";
    case "approved":
      return "Approved in Phoenix CRM.";
    case "returned":
      return "Returned to the rep in Phoenix CRM. It comes back here when the rep sends it again.";
    case "draft":
      return "The rep has not sent this week in Phoenix CRM yet.";
    default:
      return "Filed in Phoenix CRM. Its review is on the Team tab.";
  }
}

/**
 * The tone a plan's status reads in on the panel: amber while it waits on a manager, sky for an old-CRM area manager's
 * sign-off, emerald for an approved week. Taken from the plan module's own colour, never decided twice.
 */
function planTone(plan: PlanSummary): "amber" | "emerald" | "sky" {
  const tone = toneFromTextClass(planStatusClass(plan.status));
  return tone === "amber" || tone === "sky" ? tone : "emerald";
}

/**
 * The week's days as a strip of jump links above the table — one square cell per day with its planned calls and, once
 * the day has ended, how it went — so a manager reading a five-day plan reaches Thursday without scrolling past
 * Saturday to Wednesday. A day with no date (a plan row the CRM saved without one) is not offered: there is no day to
 * jump to. The cell's left rule is the day's own result — emerald kept, rose missed, slate not yet judged.
 */
function DayStrip({ days }: { days: RepsWeeklyPlansBoard["days"] }) {
  const dated = days.filter((day) => day.date != null);
  if (dated.length < 2) return null;
  return (
    <nav aria-label="Days on this plan" className="border-t border-slate-100 px-5 py-3">
      <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">Days on this plan</p>
      <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {dated.map((day) => {
          const tone = dayTone(day);
          return (
            <li key={day.date}>
              <a
                className={`flex min-h-11 flex-col justify-center border border-l-[3px] border-slate-200 ${TONE_LEFT_RULE[tone]} bg-white px-3 py-1.5 transition-colors hover:border-y-orange-400 hover:border-r-orange-400 hover:bg-orange-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400`}
                href={`#plan-day-${day.date}`}
              >
                <span className="text-phx-sm font-black uppercase tracking-[0.1em] text-slate-900">{day.label}</span>
                <span className="text-phx-xs font-semibold text-slate-500 tabular-nums">{dayStripLine(day)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A day's tone on the strip: judged only once it has ended and its visits could be read. */
function dayTone(day: RepsWeeklyPlansBoard["days"][number]): "emerald" | "rose" | "slate" {
  if (!day.actual || day.actual.upcoming) return "slate";
  return day.actual.missed > 0 ? "rose" : "emerald";
}

/** "6 calls" ahead of the day; "5 of 6 kept" once it has ended — the same figures the day's own heading prints. */
function dayStripLine(day: RepsWeeklyPlansBoard["days"][number]): string {
  if (!day.actual || day.actual.upcoming) return countOf(day.rows.length, "call");
  return `${day.actual.visited + day.actual.moved} of ${day.actual.planned} kept`;
}

/**
 * What the plan is made of, as charts above its doctors (`planWeekMix`): whether its doctors are the rep's own, the
 * grades it spends the week on, and — once a day has ended — how much of it was kept. Doctors are counted once each;
 * kept is counted in calls, the day headings' own figures added up. A chart with nothing to say is not drawn.
 */
function PlanWeekCharts({ days }: { days: RepsWeeklyPlansBoard["days"] }) {
  const mix = planWeekMix(days);
  const kept = mix.kept.visited + mix.kept.moved + mix.kept.missed;
  const gradeTone = (grade: string): "emerald" | "sky" | "slate" | "amber" =>
    grade === "A" ? "emerald" : grade === "B" ? "sky" : grade === "No grade" ? "amber" : "slate";
  return (
    <>
      {mix.onList + mix.offList > 0 ? (
        <ShareBar
          caption="The plan's doctors"
          segments={[
            { key: "on", label: "On their list", tone: "slate", value: mix.onList },
            { key: "off", label: "Not on their list", tone: "amber", value: mix.offList },
          ]}
        />
      ) : null}
      {mix.grades.length > 1 ? (
        <ShareBar
          caption="The plan's doctors by grade"
          segments={mix.grades.map((entry) => ({
            key: entry.grade,
            label: entry.grade === "No grade" ? "No grade" : `Grade ${entry.grade}`,
            tone: gradeTone(entry.grade),
            value: entry.count,
          }))}
        />
      ) : null}
      {kept > 0 ? (
        <ShareBar
          caption="The ended days so far, in calls"
          segments={[
            { key: "visited", label: "Kept on the day", tone: "emerald", value: mix.kept.visited },
            { key: "moved", label: "Kept another day", tone: "amber", value: mix.kept.moved },
            { key: "missed", label: "Not seen", tone: "rose", value: mix.kept.missed },
          ]}
        />
      ) : null}
    </>
  );
}

function PlanPanel({
  basePath,
  board,
  canApprove,
  plan,
  selected,
}: {
  basePath: string;
  board: RepsWeeklyPlansBoard;
  canApprove: boolean;
  plan: PlanSummary;
  selected: RepsWeeklyPlanRep;
}) {
  const pending = (plan.status ?? PLAN_STATUS_NEW) === PLAN_STATUS_NEW;
  // A plan whose rows carry no date at all still has a block on screen, but it is not a day he
  // planned to work — so it is excluded here rather than counted as one.
  const days = board.days.filter((day) => day.date != null).length;
  const tone = planTone(plan);

  return (
    <>
      <TileRow count={4}>
        {/* The status is the tile this tab exists for, so it leads and it is the one that carries a
            colour. The three beside it are the size of what is being signed — a manager asked to
            verify a week is entitled to see it is a real week's work before he does. */}
        <Tile
          label="Status"
          sub={pending ? "waiting on you" : "signed off in the CRM"}
          tone={pending ? "amber" : plan.status === PLAN_STATUS_AREA_MANAGER_VERIFIED ? "sky" : "emerald"}
          value={planStatusLabel(plan.status)}
        />
        <Tile label="Doctors" sub="distinct on this plan" value={String(plan.contacts)} />
        <Tile label="Planned calls" sub="rows on the plan" value={String(plan.entries)} />
        <Tile
          label="Days"
          sub={days > 0 ? `about ${Math.round(plan.entries / days)} calls a day` : "days they planned to work"}
          value={String(days)}
        />
      </TileRow>

      {/* The decision band: the week, what the plan's status means in words, and the one control. Its left rule
          carries the status tone, so the band and the Status tile above can never read differently. */}
      <div
        className={`mx-5 mt-4 flex flex-wrap items-center justify-between gap-3 border border-l-[3px] border-slate-200 ${TONE_LEFT_RULE[tone]} bg-white px-4 py-3`}
      >
        <div className="min-w-0 flex-1">
          <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">{board.week.label}</p>
          <p className="mt-0.5 text-phx-sm leading-relaxed text-slate-600">
            {/* Said in words rather than left to the button's absence. A manager who cannot approve
                is told why here; the decide route refuses the write independently, which is the boundary. */}
            {planPanelSentence(plan, canApprove)}
          </p>
        </div>
        <PlanApproveButton canApprove={canApprove} plan={plan} />
      </div>

      {/* Two plans for one rep in one week is rare and worth seeing rather than silently picking
          one — it usually means the week was re-filed. Both are offered by name. */}
      {board.plans.length > 1 ? (
        <div className="mt-4 border-t border-slate-100 px-5 py-3">
          <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
            {board.plans.length} plans filed for this week
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {board.plans.map((option) => (
              <Link
                className={
                  option.crmPlanId === plan.crmPlanId
                    ? "inline-flex min-h-11 items-center border border-orange-500 bg-orange-50 px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-slate-900 md:min-h-0"
                    : "inline-flex min-h-11 items-center border border-slate-200 px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-slate-500 hover:border-orange-400 md:min-h-0"
                }
                href={hrefWithPlan(basePath, board, option.crmPlanId)}
                key={option.crmPlanId}
              >
                {`${planStatusLabel(option.status)} · ${option.contacts} doctors`}
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <div aria-hidden className="h-4" />
      )}

      {board.entries.length === 0 ? (
        <EmptyNote
          detail={`The CRM recorded a plan for ${selected.name} this week but no doctors on it. That is a plan worth asking about rather than one to verify.`}
          title="This plan lists no doctors."
        />
      ) : (
        // No padding around the table: the day headings are full-bleed bars, exactly as the brick headings
        // are on tab one, and a padded box around them would make the two tabs stop matching at the
        // one place the owner asked for them to match most closely.
        <>
          <PlanWeekCharts days={board.days} />
          <DayStrip days={board.days} />
          <div className="border-t border-slate-100">
            <PlanDoctorsTable days={board.days} />
          </div>
        </>
      )}
    </>
  );
}

export function RepsWeeklyPlansBoardView({
  basePath,
  board,
  canApprove,
  vacantSeats,
}: {
  basePath: string;
  board: RepsWeeklyPlansBoard;
  /** Whether this viewer holds `phoenix_crm:approve`. UX only — the decide route re-checks it server-side. */
  canApprove: boolean;
  /**
   * The vacant areas the Vacant Areas tab lists under this cascade (`countVacantAreas`); null when that read
   * failed, which the card says in words rather than printing a zero (owner, 2026-11-09).
   */
  vacantSeats: number | null;
}) {
  const { counts, options, reps, scopeLabel, scopeReason, selected, selectedPlan, selection, statusFilter, syncedAt, week, weeks } =
    board;

  // A viewer who reaches nobody is told so in words. An empty picker would read as "no rep filed a
  // plan this week", which is a completely different statement and the one a manager would act on.
  if (scopeReason) {
    return (
      <div className="border border-slate-200">
        <Section description="No reps are in your reach." title="Reps Weekly Plans">
          <EmptyNote
            detail="This tab shows the weekly plans of the reps who report to you, and lets you approve them. Approving a plan is a district or regional manager's decision, so it follows the organogram rather than the wider reach the contact list uses."
            title={scopeReason}
          />
        </Section>
      </div>
    );
  }

  const description = [
    "Pick a rep and a week, then read the plan they filed and approve it",
    "a week sent in Phoenix CRM is approved here, exactly as on the Team tab",
    `your reach: ${scopeLabel}`,
    syncedAt ? `last refreshed ${cairoStamp(syncedAt)} Cairo` : "never refreshed",
  ].join(" · ");

  // The tile counts come from the board, NOT from `reps` — `reps` is the filtered list, so counting
  // it here would zero every tile the manager is not currently looking at, including the one he has
  // to click to get back. `countRepPlanStatuses` is the single arithmetic behind both.
  const copy = STATUS_COPY[statusFilter];
  const weekIsFuture = week.offset > 0;

  const share = (value: number) => (counts.all > 0 ? Math.round((value / counts.all) * 100) : 0);
  const groups = groupRepsByTeam(reps);

  return (
    <div className="border border-slate-200">
      <Section description={description} title="Reps Weekly Plans">
        <RepsListFilters
          basePath={basePath}
          options={options}
          preserve={{
            status: statusFilter === "all" ? undefined : statusFilter,
            tab: "plans",
            week: week.key,
          }}
          selection={selection}
        />
        <div className="grid gap-3 border-t border-slate-100 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <PlanWeekPicker basePath={basePath} selection={selection} status={statusFilter} week={week} weeks={weeks} />
          {/* The status filter takes the second cell of a grid that already had four, so the row
              still fits at every width and the help text simply spans two instead of three. Adding
              a fifth column here is what would break the fits-the-screen rule — a native select is
              the one control that cannot be shrunk to make room. */}
          <PlanStatusPicker
            basePath={basePath}
            counts={counts}
            selection={selection}
            status={statusFilter}
            week={week.key}
          />
          <div className="flex sm:col-span-2 lg:col-span-2">
            <HelpLine>
              {/* The field week runs Saturday to Friday, which is not the week a calendar control
                  would assume. Saying it removes the doubt rather than leaving a manager to work out
                  why "this week" starts on a Saturday. */}
              Field weeks run Saturday to Friday. Next week is at the top of the list — a plan is
              normally verified before the week it covers, not after it.
            </HelpLine>
          </div>
        </div>
      </Section>

      {selected ? <BackToAllReps href={hrefWithRep(basePath, board, null)} /> : null}
      {selected ? (
        <Section
          action={
            <Link
              className="border border-slate-600 px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.12em] text-white transition-colors hover:border-orange-400 hover:text-orange-300"
              href={hrefWithRep(basePath, board, null)}
            >
              Back to all reps
            </Link>
          }
          description={
            selected.areaNames.length > 0
              ? `${selected.areaNames.join(" · ")} · ${week.label}`
              : week.label
          }
          title={`Weekly plan — ${selected.name}`}
        >
          <RepProfileBand
            facts={[
              selectedPlan == null
                ? {
                    label: "This week",
                    tone: weekIsFuture ? undefined : "rose",
                    value: weekIsFuture ? "Not filed yet" : "No plan filed",
                  }
                : { label: "This week", tone: planTone(selectedPlan), value: planStatusLabel(selectedPlan.status) },
              { label: "Doctors planned", value: selectedPlan == null ? "–" : String(selectedPlan.contacts) },
              { label: "Contacts on the list", value: String(selected.contactCount) },
            ]}
            name={selected.name}
            places={selected.areaNames.length > 0 ? selected.areaNames.join(" · ") : "No area on the seat"}
            team={teamHeading(selected.team)}
          />
          {selectedPlan == null ? (
            <EmptyNote
              detail={
                // A future week with no plan is not yet a finding; a past one is. The board says
                // which, rather than printing one sentence that is wrong half the time.
                week.offset > 0
                  ? "This week has not started yet, so there may be nothing to file. Reps normally file the coming week towards the end of the current one."
                  : "There is nothing to verify. A plan the rep never filed is not a plan awaiting your signature — it is a week they did not plan."
              }
              title={`${selected.name} filed no weekly plan for ${week.label}.`}
            />
          ) : (
            <PlanPanel
              basePath={basePath}
              board={board}
              canApprove={canApprove}
              plan={selectedPlan}
              selected={selected}
            />
          )}
        </Section>
      ) : (
        <Section description={copy.description} meta={week.label} title={`${copy.heading} — ${reps.length}`}>
          {/* THE TILES RENDER EVEN WHEN THE GRID IS EMPTY, which is the whole reason they are drawn
              outside the branch below. They are the filter as well as the count, so hiding them on
              an empty slice would take away the only way back out of it — the manager would be
              looking at "nothing is waiting on you" with no control on screen to widen it. */}
          <TileRow count={5}>
            {/* The week in four numbers, which is the question a manager opens this tab with: who is
                waiting on me, and who has not filed at all. They are counted apart for the same
                reason the rep card prints them apart — and each one now narrows the grid to itself,
                the owner's 2026-09-02 ask to "filter by verified plan and non-verified plan". */}
            <Tile
              active={statusFilter === "all"}
              href={hrefWithStatus(basePath, board, "all")}
              label="Reps"
              sub={statusFilter === "all" ? "in your reach" : "in your reach · show all"}
              value={String(counts.all)}
            />
            <Tile
              active={statusFilter === "awaiting"}
              href={hrefWithStatus(basePath, board, "awaiting")}
              label="Awaiting you"
              share={share(counts.awaiting)}
              sub={counts.awaiting > 0 ? "plans not yet verified" : "nothing to verify"}
              tone={counts.awaiting > 0 ? "amber" : "emerald"}
              value={String(counts.awaiting)}
            />
            <Tile
              active={statusFilter === "verified"}
              href={hrefWithStatus(basePath, board, "verified")}
              label="Verified"
              share={share(counts.verified)}
              sub="signed off in the CRM"
              tone="emerald"
              value={String(counts.verified)}
            />
            <Tile
              active={statusFilter === "missing"}
              href={hrefWithStatus(basePath, board, "missing")}
              label="No plan filed"
              share={share(counts.missing)}
              // A future week has filed nothing yet, which is normal — neither red nor a green
              // "everyone filed". Say it has not started, in the neutral tone (audit, 2026-09-21).
              sub={
                weekIsFuture
                  ? "the week hasn't started yet"
                  : counts.missing > 0
                    ? "nothing in the CRM this week"
                    : "everyone filed"
              }
              tone={weekIsFuture ? undefined : counts.missing > 0 ? "rose" : "emerald"}
              value={String(counts.missing)}
            />
            {/* The fifth card: the seats with nobody in them, so "13 reps" is read against the structure
                and not mistaken for it. It opens the Vacant Areas tab, which lists exactly these. */}
            <Tile
              href={hrefToVacant(basePath, board)}
              label="Vacant seats"
              sub={vacantSeats == null ? "could not be read just now" : vacantSeats > 0 ? "no rep in the seat · open the list" : "every seat is filled"}
              tone={vacantSeats == null ? undefined : vacantSeats > 0 ? "amber" : "emerald"}
              value={vacantSeats == null ? "–" : String(vacantSeats)}
            />
          </TileRow>
          {/* The same week as one bar, so the split is seen before it is read. Counted from the board's own
              totals — the tiles' figures — never from the filtered grid. */}
          {counts.all > 0 ? (
            <ShareBar
              caption="The week at a glance"
              segments={[
                { key: "verified", label: "Verified", tone: "emerald", value: counts.verified },
                { key: "awaiting", label: "Awaiting you", tone: "amber", value: counts.awaiting },
                {
                  key: "missing",
                  label: weekIsFuture ? "Not filed yet" : "No plan filed",
                  tone: weekIsFuture ? "slate" : "rose",
                  value: counts.missing,
                },
              ]}
            />
          ) : null}
          {/* Every team's week on one screen, in the tones of the bar above — which team is waiting on him, which
              has not filed. Counted from the filtered grid's own groups, so it says what the cards below say. */}
          <TeamRollup
            caption="The teams at a glance"
            groups={groups}
            noun="rep"
            segments={(members) => {
              const filed = members.filter((member) => member.plansFiled > 0);
              const waiting = filed.filter((member) => (member.planStatus ?? PLAN_STATUS_NEW) === PLAN_STATUS_NEW).length;
              return [
                { key: "verified", label: "Verified", tone: "emerald", value: filed.length - waiting },
                { key: "awaiting", label: "Awaiting you", tone: "amber", value: waiting },
                {
                  key: "missing",
                  label: weekIsFuture ? "Not filed yet" : "Not filed",
                  tone: weekIsFuture ? "slate" : "rose",
                  value: members.length - filed.length,
                },
              ];
            }}
          />
          {reps.length > 0 ? (
            <ExportRowBar note={`The reps in these filters and the plan each filed for ${week.label}, by region and district manager.`}>
              <ExportXlsxButton
                columns={[
                  { key: "region", label: "Region" },
                  { key: "manager", label: "District manager" },
                  { key: "rep", label: "Medical rep" },
                  { key: "area", label: "Area" },
                  { key: "plan", label: "Plan" },
                  { excludeFromTotal: true, key: "plans", label: "Plans filed", numeric: true },
                ]}
                label="Download the week"
                rows={groups.flatMap((group) =>
                  group.reps.map((rep) => ({
                    area: rep.areaNames.join(" · "),
                    manager: rep.team.managerName ?? "",
                    plan: repPlanText(rep, weekIsFuture).text,
                    plans: rep.plansFiled,
                    region: rep.team.regionName,
                    rep: rep.name,
                  })),
                )}
                sheetName="Weekly Plans"
                subtitle={`${week.label} · your reach: ${scopeLabel}`}
                title="Reps Weekly Plans — the team"
              />
            </ExportRowBar>
          ) : null}
          {reps.length === 0 ? (
            // WHICH emptiness this is decides the sentence. No reps at all means the CASCADE matched
            // nobody — a line and area no seated rep works — and the fix is to widen it. Reps that
            // exist but none in this slice is the opposite news, and usually means there is nothing
            // left to do; printing the cascade's sentence over it would send a manager hunting for a
            // filter to clear when the honest answer is that he is finished for the week.
            <EmptyNote
              detail={(counts.all === 0 ? STATUS_COPY.all : copy).emptyDetail}
              title={(counts.all === 0 ? STATUS_COPY.all : copy).emptyTitle}
            />
          ) : (
            // Grouped by region and district manager (owner, 2026-11-09: "group reps by district manager") — a
            // regional manager reads his week team by team, each heading with its own verified, waiting and missing.
            <>
              <GroupedCardGrid
                groups={groups}
                noun="rep"
                phoneOnly
                renderCard={(rep) => (
                  <RepCard
                    href={hrefWithRep(basePath, board, rep.repKey)}
                    key={rep.repKey}
                    rep={rep}
                    weekIsFuture={weekIsFuture}
                  />
                )}
                renderGroupMeta={(members) => <RegionWeekLine members={members} weekIsFuture={weekIsFuture} />}
              />
              {/* A desktop reads the week as a table, a phone as cards (owner's standing rule). */}
              <TeamTable
                caption={`The medical reps in these filters and their plan for ${week.label}, by region and district manager`}
                columns={planColumns(basePath, board, weekIsFuture)}
                groups={groups}
                noun="rep"
                renderGroupMeta={(members) => <RegionWeekLine members={members} weekIsFuture={weekIsFuture} />}
                rowKey={(rep) => rep.repKey}
              />
            </>
          )}
        </Section>
      )}
    </div>
  );
}
