import Link from "next/link";

import { PlanWeekPicker } from "@/components/crm/plan-week-picker";
import { VerifyButton } from "@/components/crm/plan-verify-button";
import { cairoStamp, Section, Tile } from "@/components/crm/reps-list-chrome";
import { RepsListFilters } from "@/components/crm/reps-list-filters";
import type { PlanEntryRow, PlanSummary } from "@/lib/crm/plan-board";
import {
  PLAN_STATUS_AREA_MANAGER_VERIFIED,
  PLAN_STATUS_NEW,
  planStatusClass,
  planStatusLabel,
} from "@/lib/crm/plan-verification";
import { formatPlanDay } from "@/lib/crm/plan-week";
import type { RepsWeeklyPlanRep, RepsWeeklyPlansBoard } from "@/lib/crm/reps-weekly-plans-board";

// Server half of Reps Weekly Plans — tab two of the Reps List board.
//
// It borrows nothing from plan-verification-tables.tsx and that is deliberate twice over. The look
// comes from reps-list-chrome.tsx, shared with tab one, because two tabs inside one border must be
// one screen (owner's standing rule: match the sibling pages, never a one-off). And the doctors
// table is written here rather than reused because all three tables next door render through
// `PortalDesktopTable` over a min-width floor of 720–1240px — a horizontal scroll, which is the one
// thing the fits-the-screen golden rule forbids outright.
//
// NOTHING HERE IS A CLIENT COMPONENT except the three controls that must be: the cascade, the week
// picker and the Verify button. Choosing a rep swaps the whole board, exactly as tab one does, so
// the doctors always land at the top of the page — the reason the period board needs a
// scroll-into-view effect does not exist on this one.

/** The current filters as a query string, with `rep` replaced (or dropped when null). */
function hrefWithRep(basePath: string, board: RepsWeeklyPlansBoard, repKey: string | null): string {
  const query = new URLSearchParams();
  query.set("tab", "plans");
  query.set("week", board.week.key);
  if (board.selection.line) query.set("line", board.selection.line);
  if (board.selection.region) query.set("region", board.selection.region);
  if (board.selection.area) query.set("area", board.selection.area);
  if (repKey) query.set("rep", repKey);
  return `${basePath}?${query.toString()}`;
}

/** The same URL with a different plan of the same rep opened. Only used when a rep filed two. */
function hrefWithPlan(basePath: string, board: RepsWeeklyPlansBoard, planId: number): string {
  const base = hrefWithRep(basePath, board, board.selection.rep ?? null);
  return `${base}&plan=${planId}`;
}

/**
 * What a rep's week says in one line.
 *
 * "Not filed" is its own answer and never folded into "Pending". A rep who has filed nothing and a
 * rep waiting on his manager are different facts, and only the second is the manager's move — a
 * board that prints them the same way turns "he hasn't planned his week" into "you haven't signed
 * it", which points the blame at the wrong person.
 */
function repPlanText(rep: RepsWeeklyPlanRep): { text: string; tone: string } {
  if (rep.plansFiled === 0) return { text: "No plan filed", tone: "text-rose-700" };
  const status = planStatusLabel(rep.planStatus);
  const suffix = rep.plansFiled > 1 ? ` · ${rep.plansFiled} plans` : "";
  return { text: `${status}${suffix}`, tone: planStatusClass(rep.planStatus) };
}

function RepCard({ href, rep }: { href: string; rep: RepsWeeklyPlanRep }) {
  const plan = repPlanText(rep);
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
 * The doctors on one plan.
 *
 * FIVE columns, not seven. Day and AM/PM are one cell and grade rides inside Specialty, because the
 * golden rule says fit by MERGING columns rather than shrinking the type — and seven columns at the
 * 768px breakpoint is where the min-width floor next door came from. Widths are shares of whatever
 * the viewport gives, so a long Arabic doctor name WRAPS. Wrapping is the permitted answer here;
 * the ellipsis ban is untouched, and nothing on this table is hidden.
 */
function PlanDoctors({ rows }: { rows: PlanEntryRow[] }) {
  const THEAD = "px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
  // Day, then AM before PM, then by name — the order a manager reads a route in. The plan arrives
  // in the vendor's own order, which is neither.
  const ordered = [...rows].sort((left, right) => {
    const byDay = (left.planDate ?? "").localeCompare(right.planDate ?? "");
    if (byDay !== 0) return byDay;
    const byShift = (left.ampm ?? "").localeCompare(right.ampm ?? "");
    if (byShift !== 0) return byShift;
    return left.contactName.localeCompare(right.contactName);
  });

  // A blank address says WHICH blank it is. "Not on his list" is a rep planning a doctor he was
  // never assigned — the more interesting of the two, and exactly what a verifying manager is
  // looking for — while "No address recorded" is a CRM gap. A dash would hide both.
  const address = (row: PlanEntryRow) => row.address ?? (row.onRepList ? "No address recorded" : "Not on his list");
  const addressTone = (row: PlanEntryRow) =>
    row.address ? "text-slate-600" : row.onRepList ? "text-slate-400" : "text-amber-700";
  const speciality = (row: PlanEntryRow) =>
    [row.grade ? `Grade ${row.grade}` : null, row.speciality].filter(Boolean).join(" · ") || "Not recorded";

  return (
    <>
      <div className="hidden md:block">
        <table className="w-full table-fixed border-collapse text-left text-sm">
          {/* Shares, never pixels. Address takes the largest because it is the only free-text column
              and the one a route is read from; Day is the narrowest because "Sun 30 Aug" over
              "AM" is two short lines whatever the viewport. */}
          <colgroup>
            <col className="w-[13%]" />
            <col className="w-[25%]" />
            <col className="w-[19%]" />
            <col className="w-[15%]" />
            <col className="w-[28%]" />
          </colgroup>
          <thead>
            <tr className="bg-slate-900 text-left">
              <th className={THEAD}>Day</th>
              <th className={THEAD}>Doctor</th>
              <th className={THEAD}>Specialty</th>
              <th className={THEAD}>Locality</th>
              <th className={THEAD}>Address</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ordered.map((row, index) => (
              <tr className="align-top" key={`${row.contactCrmId ?? "x"}-${row.planDate ?? "x"}-${index}`}>
                <td className="px-3 py-2 font-black text-slate-900">
                  {row.planDate ? formatPlanDay(row.planDate) : "No day"}
                  {row.ampm ? (
                    <span className="mt-0.5 block text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">
                      {row.ampm}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2 font-semibold text-slate-900">{row.contactName}</td>
                <td className="px-3 py-2 text-slate-600">{speciality(row)}</td>
                <td className="px-3 py-2 text-slate-600">{row.region ?? "No locality"}</td>
                <td className={`px-3 py-2 ${addressTone(row)}`}>{address(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile never gets the table — the owner's admin-shell rule, and the only honest way to
          hold five columns at 375px without either scrolling sideways or shrinking the type. */}
      <div className="space-y-2 md:hidden">
        {ordered.map((row, index) => (
          <div
            className="border border-slate-200 px-3 py-2.5"
            key={`${row.contactCrmId ?? "x"}-${row.planDate ?? "x"}-${index}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-black text-slate-900">{row.contactName}</p>
              <p className="text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-400">
                {row.planDate ? formatPlanDay(row.planDate) : "No day"}
                {row.ampm ? ` · ${row.ampm}` : ""}
              </p>
            </div>
            <p className="mt-0.5 text-phx-2xs text-slate-600">{speciality(row)}</p>
            <p className="mt-0.5 text-phx-2xs text-slate-500">{row.region ?? "No locality"}</p>
            <p className={`mt-0.5 text-phx-2xs ${addressTone(row)}`}>{address(row)}</p>
          </div>
        ))}
      </div>
    </>
  );
}

function PlanPanel({
  basePath,
  board,
  canVerify,
  plan,
  selected,
}: {
  basePath: string;
  board: RepsWeeklyPlansBoard;
  canVerify: boolean;
  plan: PlanSummary;
  selected: RepsWeeklyPlanRep;
}) {
  const pending = (plan.status ?? PLAN_STATUS_NEW) === PLAN_STATUS_NEW;
  const days = new Set(board.entries.map((row) => row.planDate).filter(Boolean)).size;

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
        <Tile label="Days" sub="days he planned to work" value={String(days)} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-900">
            {board.week.label}
          </p>
          <p className="mt-0.5 text-phx-2xs text-slate-500">
            {/* Said in words rather than left to the button's absence. A manager who cannot verify
                is told why here; the route refuses the write independently, which is the boundary. */}
            {pending
              ? canVerify
                ? "Verifying writes the status into the CRM itself and emails the rep. It cannot be undone from here."
                : "This plan is waiting for the rep's district or regional manager to verify it."
              : "Already verified in the CRM. There is no unverify."}
          </p>
        </div>
        <VerifyButton canVerify={canVerify} plan={plan} />
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
        <div className="border-t border-slate-100 p-5">
          <PlanDoctors rows={board.entries} />
        </div>
      )}
    </>
  );
}

export function RepsWeeklyPlansBoardView({
  basePath,
  board,
  canVerify,
}: {
  basePath: string;
  board: RepsWeeklyPlansBoard;
  /** Whether this viewer holds `crm_plans:approve`. UX only — the route re-checks it server-side. */
  canVerify: boolean;
}) {
  const { options, reps, scopeLabel, scopeReason, selected, selectedPlan, selection, syncedAt, week, weeks } = board;

  // A viewer who reaches nobody is told so in words. An empty picker would read as "no rep filed a
  // plan this week", which is a completely different statement and the one a manager would act on.
  if (scopeReason) {
    return (
      <div className="border border-slate-200">
        <Section description="No reps are in your reach." title="Reps Weekly Plans">
          <div className="px-5 py-6">
            <p className="text-sm font-semibold text-slate-700">{scopeReason}</p>
            <p className="mt-1 text-phx-xs text-slate-500">
              This tab shows the weekly plans of the reps who report to you, and lets you verify them. Verifying a
              plan is a district or regional manager&apos;s decision, so it follows the organogram rather than the
              wider reach the contact list uses.
            </p>
          </div>
        </Section>
      </div>
    );
  }

  const description = [
    "Pick a rep and a week, then read the plan he filed and verify it",
    "verifying writes the status into the CRM itself",
    `your reach: ${scopeLabel}`,
    syncedAt ? `last refreshed ${cairoStamp(syncedAt)} Cairo` : "never refreshed",
  ].join(" · ");

  const filed = reps.filter((rep) => rep.plansFiled > 0);
  const awaiting = filed.filter((rep) => (rep.planStatus ?? PLAN_STATUS_NEW) === PLAN_STATUS_NEW);

  return (
    <div className="border border-slate-200">
      <Section description={description} title="Reps Weekly Plans">
        <RepsListFilters
          basePath={basePath}
          options={options}
          preserve={{ tab: "plans", week: week.key }}
          selection={selection}
        />
        <div className="grid gap-3 border-t border-slate-100 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <PlanWeekPicker basePath={basePath} selection={selection} week={week} weeks={weeks} />
          <p className="self-end text-phx-2xs text-slate-500 sm:col-span-1 lg:col-span-3">
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
                  : "There is nothing to verify. A plan the rep never filed is not a plan awaiting your signature — it is a week he did not plan."}
              </p>
            </div>
          ) : (
            <PlanPanel
              basePath={basePath}
              board={board}
              canVerify={canVerify}
              plan={selectedPlan}
              selected={selected}
            />
          )}
        </Section>
      ) : (
        <Section
          description="Pick a rep to open the plan he filed for this week. Narrow with the filters above first if the list is long."
          title={`Medical reps — ${reps.length}`}
        >
          {reps.length === 0 ? (
            <div className="px-5 py-6">
              <p className="text-sm font-semibold text-slate-700">No reps match these filters.</p>
              <p className="mt-1 text-phx-xs text-slate-500">
                Clear a level of the cascade to widen it. An empty result here means no seated rep works that
                combination — not that nobody filed a plan.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 p-5 pb-0 sm:grid-cols-4">
                {/* The week in three numbers, which is the question a manager opens this tab with:
                    who is waiting on me, and who has not filed at all. They are counted apart for
                    the same reason the rep card prints them apart. */}
                <Tile label="Reps" sub="in your reach" value={String(reps.length)} />
                <Tile
                  label="Awaiting you"
                  sub={awaiting.length > 0 ? "plans not yet verified" : "nothing to verify"}
                  tone={awaiting.length > 0 ? "amber" : "emerald"}
                  value={String(awaiting.length)}
                />
                <Tile
                  label="Verified"
                  sub="signed off in the CRM"
                  tone="emerald"
                  value={String(filed.length - awaiting.length)}
                />
                <Tile
                  label="No plan filed"
                  sub={reps.length - filed.length > 0 ? "nothing in the CRM this week" : "everyone filed"}
                  tone={reps.length - filed.length > 0 ? "rose" : "emerald"}
                  value={String(reps.length - filed.length)}
                />
              </div>
              <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3">
                {reps.map((rep) => (
                  <RepCard href={hrefWithRep(basePath, board, rep.repKey)} key={rep.repKey} rep={rep} />
                ))}
              </div>
            </>
          )}
        </Section>
      )}
    </div>
  );
}
