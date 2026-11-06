import Link from "next/link";

import { PlanStatusPicker } from "@/components/crm/plan-status-picker";
import { PlanWeekPicker } from "@/components/crm/plan-week-picker";
import { PlanApproveButton } from "@/components/crm/plan-verify-button";
import { cairoStamp, Section, Tile } from "@/components/crm/reps-list-chrome";
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

function RepCard({ href, rep, weekIsFuture }: { href: string; rep: RepsWeeklyPlanRep; weekIsFuture: boolean }) {
  const plan = repPlanText(rep, weekIsFuture);
  return (
    <Link
      className="block border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-orange-400 hover:bg-orange-50"
      href={href}
    >
      <p className="text-sm font-black text-slate-900">{rep.name}</p>
      <p className="mt-0.5 text-phx-2xs font-semibold text-slate-500">
        {rep.areaNames.length > 0 ? rep.areaNames.join(" · ") : "No area on the seat"}
      </p>
      <p className={`mt-1 text-phx-2xs font-black uppercase tracking-[0.1em] ${plan.tone}`}>{plan.text}</p>
    </Link>
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

  return (
    <>
      <div className="grid grid-cols-2 gap-2 p-5 pb-0 sm:grid-cols-4">
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
        <Tile label="Days" sub="days they planned to work" value={String(days)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">
            {board.week.label}
          </p>
          <p className="mt-0.5 text-phx-2xs text-slate-500">
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
        <div className="flex flex-wrap gap-2 border-t border-slate-100 px-5 py-3">
          {board.plans.map((option) => (
            <Link
              className={
                option.crmPlanId === plan.crmPlanId
                  ? "border border-orange-500 bg-orange-50 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-900"
                  : "border border-slate-200 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500 hover:border-orange-400"
              }
              href={hrefWithPlan(basePath, board, option.crmPlanId)}
              key={option.crmPlanId}
            >
              {`${planStatusLabel(option.status)} · ${option.contacts} doctors`}
            </Link>
          ))}
        </div>
      ) : null}

      {board.entries.length === 0 ? (
        <div className="border-t border-slate-100 px-5 py-6">
          <p className="text-sm font-semibold text-slate-700">This plan lists no doctors.</p>
          <p className="mt-1 text-phx-xs text-slate-500">
            The CRM recorded a plan for {selected.name} this week but no doctors on it. That is a plan worth
            asking about rather than one to verify.
          </p>
        </div>
      ) : (
        // No padding around it: the day headings are full-bleed bars, exactly as the brick headings
        // are on tab one, and a padded box around them would make the two tabs stop matching at the
        // one place the owner asked for them to match most closely.
        <div className="border-t border-slate-100">
          <PlanDoctorsTable days={board.days} />
        </div>
      )}
    </>
  );
}

export function RepsWeeklyPlansBoardView({
  basePath,
  board,
  canApprove,
}: {
  basePath: string;
  board: RepsWeeklyPlansBoard;
  /** Whether this viewer holds `phoenix_crm:approve`. UX only — the decide route re-checks it server-side. */
  canApprove: boolean;
}) {
  const { counts, options, reps, scopeLabel, scopeReason, selected, selectedPlan, selection, statusFilter, syncedAt, week, weeks } =
    board;

  // A viewer who reaches nobody is told so in words. An empty picker would read as "no rep filed a
  // plan this week", which is a completely different statement and the one a manager would act on.
  if (scopeReason) {
    return (
      <div className="border border-slate-200">
        <Section description="No reps are in your reach." title="Reps Weekly Plans">
          <div className="px-5 py-6">
            <p className="text-sm font-semibold text-slate-700">{scopeReason}</p>
            <p className="mt-1 text-phx-xs text-slate-500">
              This tab shows the weekly plans of the reps who report to you, and lets you approve them. Approving a
              plan is a district or regional manager&apos;s decision, so it follows the organogram rather than the
              wider reach the contact list uses.
            </p>
          </div>
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
          <p className="self-end text-phx-2xs text-slate-500 sm:col-span-2 lg:col-span-2">
            {/* The field week runs Saturday to Friday, which is not the week a calendar control
                would assume. Saying it removes the doubt rather than leaving a manager to work out
                why "this week" starts on a Saturday. */}
            Field weeks run Saturday to Friday. Next week is at the top of the list — a plan is
            normally verified before the week it covers, not after it.
          </p>
        </div>
      </Section>

      {selected ? (
        <Section
          action={
            <Link
              className="border border-slate-600 px-3 py-1.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white transition-colors hover:border-orange-400 hover:text-orange-300"
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
          {selectedPlan == null ? (
            <div className="px-5 py-6">
              <p className="text-sm font-semibold text-slate-700">
                {selected.name} filed no weekly plan for {week.label}.
              </p>
              <p className="mt-1 text-phx-xs text-slate-500">
                {/* A future week with no plan is not yet a finding; a past one is. The board says
                    which, rather than printing one sentence that is wrong half the time. */}
                {week.offset > 0
                  ? "This week has not started yet, so there may be nothing to file. Reps normally file the coming week towards the end of the current one."
                  : "There is nothing to verify. A plan the rep never filed is not a plan awaiting your signature — it is a week they did not plan."}
              </p>
            </div>
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
        <Section description={copy.description} title={`${copy.heading} — ${reps.length}`}>
          {/* THE TILES RENDER EVEN WHEN THE GRID IS EMPTY, which is the whole reason they are drawn
              outside the branch below. They are the filter as well as the count, so hiding them on
              an empty slice would take away the only way back out of it — the manager would be
              looking at "nothing is waiting on you" with no control on screen to widen it. */}
          <div className="grid grid-cols-2 gap-2 p-5 pb-0 sm:grid-cols-4">
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
              sub={counts.awaiting > 0 ? "plans not yet verified" : "nothing to verify"}
              tone={counts.awaiting > 0 ? "amber" : "emerald"}
              value={String(counts.awaiting)}
            />
            <Tile
              active={statusFilter === "verified"}
              href={hrefWithStatus(basePath, board, "verified")}
              label="Verified"
              sub="signed off in the CRM"
              tone="emerald"
              value={String(counts.verified)}
            />
            <Tile
              active={statusFilter === "missing"}
              href={hrefWithStatus(basePath, board, "missing")}
              label="No plan filed"
              // A future week has filed nothing yet, which is normal — neither red nor a green
              // "everyone filed". Say it has not started, in the neutral tone (audit, 2026-09-21).
              sub={
                week.offset > 0
                  ? "the week hasn't started yet"
                  : counts.missing > 0
                    ? "nothing in the CRM this week"
                    : "everyone filed"
              }
              tone={week.offset > 0 ? undefined : counts.missing > 0 ? "rose" : "emerald"}
              value={String(counts.missing)}
            />
          </div>
          {reps.length === 0 ? (
            // WHICH emptiness this is decides the sentence. No reps at all means the CASCADE matched
            // nobody — a line and area no seated rep works — and the fix is to widen it. Reps that
            // exist but none in this slice is the opposite news, and usually means there is nothing
            // left to do; printing the cascade's sentence over it would send a manager hunting for a
            // filter to clear when the honest answer is that he is finished for the week.
            <div className="px-5 py-6">
              <p className="text-sm font-semibold text-slate-700">
                {(counts.all === 0 ? STATUS_COPY.all : copy).emptyTitle}
              </p>
              <p className="mt-1 text-phx-xs text-slate-500">
                {(counts.all === 0 ? STATUS_COPY.all : copy).emptyDetail}
              </p>
            </div>
          ) : (
            <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {reps.map((rep) => (
                <RepCard
                  href={hrefWithRep(basePath, board, rep.repKey)}
                  key={rep.repKey}
                  rep={rep}
                  weekIsFuture={week.offset > 0}
                />
              ))}
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
