import {
  PlanDoctorsTable,
  PlanListTable,
  PlanMissingRepsTable,
  PlanVerificationFilters,
} from "@/components/crm/plan-verification-tables";
// planPeriodText comes from the lib, NOT from plan-verification-tables above. That file is
// "use client" and this one is a server component, so importing a plain function from it hands the
// server a client reference rather than the function, and calling it throws on every render.
import { PLAN_DOCTORS_ANCHOR_ID, PLAN_STATUS_NEW, planPeriodText } from "@/lib/crm/plan-verification";
import type { PlanVerificationBoard } from "@/lib/crm/plan-board";

// Server half of Plan Verification. The Section/Tile vocabulary is copied verbatim from
// reps-list-board.tsx, its neighbour in the same shell — flat borders, slate-900 header bar, KPI
// tiles, orange accent. Never a one-off look (owner's standing rule).
//
// That reference used to be doctor-list-board.tsx, tab one of the same District Manager page. The
// board and the tab strip were retired on 2026-08-31 and Reps List carries the identical vocabulary
// forward, so the look is unchanged — only the file to copy it from moved.

function Section({
  action,
  children,
  description,
  title,
}: {
  action?: React.ReactNode;
  children: React.ReactNode;
  description?: string;
  title: string;
}) {
  return (
    <div className="border-b border-slate-200 bg-white last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 bg-slate-900 px-5 py-3.5">
        {/* flex-1 with a zero basis, NOT auto width — same measurement as the sibling tab: an
            auto-width title block measures wider than the row and pushes the filters onto a second
            line at every desktop size. */}
        <div className="min-w-0 flex-1">
          <h2 className="text-phx-xs font-black uppercase tracking-[0.14em] text-white">{title}</h2>
          {description ? <p className="mt-0.5 text-phx-sm text-slate-400">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Tile({
  label,
  sub,
  tone,
  value,
}: {
  label: string;
  sub?: string;
  tone?: "amber" | "emerald" | "rose";
  value: string;
}) {
  const valueClass =
    tone === "emerald"
      ? "text-emerald-700"
      : tone === "amber"
        ? "text-amber-700"
        : tone === "rose"
          ? "text-rose-700"
          : "text-slate-900";
  return (
    <div className="border border-slate-200 px-3 py-2.5">
      <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={`text-lg font-black ${valueClass}`}>{value}</p>
      {sub ? <p className="text-phx-sm text-slate-400">{sub}</p> : null}
    </div>
  );
}

/** Cairo wall-clock, per the owner's standing rule that no raw UTC is ever shown. */
function cairoStamp(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(iso));
}

export function PlanVerificationBoardView({
  basePath,
  board,
  canApprove,
  years,
}: {
  basePath: string;
  board: PlanVerificationBoard;
  /** `phoenix_crm:approve`. False for a read-only viewer (the CEO account): the button is not rendered,
   * and the decide route refuses it independently — the hidden button is UX, the route is the boundary. */
  canApprove: boolean;
  years: number[];
}) {
  const { kind, missingReps, month, plans, rosterKnown, scopeLabel, scopeReason, selected, year } = board;
  const filters = (
    <PlanVerificationFilters basePath={basePath} kind={kind} month={month} year={year} years={years} />
  );

  // A viewer who reaches nobody is told so in words. An empty list would read as "my reps have
  // filed nothing", which is a completely different statement and the one a manager would act on.
  if (scopeReason) {
    return (
      <div className="border border-slate-200">
        <Section description="Nobody's plans are in your reach." title="Plans">
          <div className="px-5 py-6">
            <p className="text-sm font-semibold text-slate-700">{scopeReason}</p>
            <p className="mt-1 text-phx-xs text-slate-500">
              This board shows the plans of the reps who report to you. Until the organogram places reps under
              your seat there is nothing here to verify — which is not the same as your reps having filed
              nothing.
            </p>
          </div>
        </Section>
      </div>
    );
  }

  const pending = plans.filter((plan) => plan.status === PLAN_STATUS_NEW);
  const verified = plans.length - pending.length;
  const reps = new Set(plans.map((plan) => plan.agentHrId ?? `crm:${plan.agentCrmId}`)).size;
  const plannedCalls = plans.reduce((total, plan) => total + plan.entries, 0);
  const syncedAt = plans.reduce<string | null>(
    (latest, plan) => (plan.syncedAt && (!latest || plan.syncedAt > latest) ? plan.syncedAt : latest),
    null,
  );

  const description = [
    kind === "weekly"
      ? "One plan per rep per week, as the rep filed it in the CRM"
      : "One plan per rep per month — a frequency per doctor, not a day-by-day schedule",
    `your reach: ${scopeLabel}`,
    syncedAt ? `last refreshed ${cairoStamp(syncedAt)} Cairo` : "never refreshed",
  ].join(" · ");

  return (
    <div className="border border-slate-200">
      <Section action={filters} description={description} title="Plans">
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile
              label="Awaiting you"
              sub={pending.length === 0 ? "nothing to verify" : "not verified yet"}
              tone={pending.length === 0 ? "emerald" : "amber"}
              value={String(pending.length)}
            />
            <Tile label="Verified" sub={`of ${plans.length} plans`} tone="emerald" value={String(verified)} />
            <Tile label="Reps with a plan" sub="in this period" value={String(reps)} />
            {/* The counterweight to the tile above it. "Reps with a plan: 12" reads as complete
                whether the true roster is 12 or 30, because a board built from plans cannot show a
                rep who filed none — he is absent, not flagged. A dash rather than a zero when the
                roster is unknown: a false all-clear is the one wrong answer here. */}
            <Tile
              label="Filed nothing"
              sub={
                !rosterKnown
                  ? "roster unavailable"
                  : missingReps.length === 0
                    ? "everyone filed"
                    : "reps in your reach"
              }
              tone={!rosterKnown ? undefined : missingReps.length === 0 ? "emerald" : "rose"}
              value={rosterKnown ? String(missingReps.length) : "—"}
            />
            <Tile label="Planned calls" sub="across every plan shown" value={String(plannedCalls)} />
            <Tile
              label="Plan type"
              sub={kind === "weekly" ? "a week per plan" : "a month per plan"}
              value={kind === "weekly" ? "Weekly" : "Monthly"}
            />
          </div>
          {/* A weekly plan that straddles a month is listed under the month it STARTS in. Said out
              loud because a manager looking for a 30 August plan in September would otherwise
              conclude it was lost. */}
          {kind === "weekly" ? (
            <p className="text-phx-sm text-slate-400">
              A week that crosses into the next month is listed under the month it starts in, and is always
              shown whole.
            </p>
          ) : null}
        </div>
      </Section>

      {/* Placed ABOVE the plans table on purpose. A manager reads this page top-down to clear a
          backlog, and the reps who filed nothing are the ones he will never be reminded of by
          anything else on it — there is no pending row for them to sit in. Below the table, on a
          manager with thirty reps, it would be off the bottom of the screen. */}
      <Section
        description={
          rosterKnown
            ? "Reps whose doctor list the CRM holds, but who filed no plan at all for this period. Nothing here can be verified — there is nothing to verify."
            : "The CRM's assigned-doctor mirror returned nobody, so this board cannot say who is missing."
        }
        title={rosterKnown ? `Filed nothing — ${missingReps.length}` : "Filed nothing"}
      >
        <PlanMissingRepsTable
          kind={kind}
          month={month}
          reps={missingReps}
          rosterKnown={rosterKnown}
          year={year}
        />
      </Section>

      <Section
        description={
          canApprove
            ? "A week sent in Phoenix CRM is approved here, exactly as on the Team tab. Old-CRM plans are read-only: iReports360 was retired on 6 November 2026."
            : "Read-only for your role — plan approvals are made by the manager the rep reports to."
        }
        title={`Plans — ${plans.length}`}
      >
        <PlanListTable
          basePath={basePath}
          canApprove={canApprove}
          kind={kind}
          month={month}
          plans={plans}
          selectedPlanId={selected?.plan.crmPlanId ?? null}
          year={year}
        />
      </Section>

      {/* The anchor the client half scrolls to when a plan opens. This section sits below the whole
          plans table, so on a manager with many reps it renders well past the bottom of the screen —
          without somewhere to aim at, pressing a rep changed the URL and moved nothing the manager
          could see. It wraps the SECTION rather than the table so the heading naming the plan lands
          on screen too. */}
      {selected ? (
        <div id={PLAN_DOCTORS_ANCHOR_ID}>
          <Section
            description={
              kind === "weekly"
                ? "Every doctor on this plan, on the day the rep planned to see them."
                : "Every doctor on this plan, with the number of calls the rep planned for the month."
            }
            title={`${selected.plan.repName} — ${planPeriodText(selected.plan)}`}
          >
            <PlanDoctorsTable kind={kind} plan={selected.plan} rows={selected.rows} />
          </Section>
        </div>
      ) : null}
    </div>
  );
}
