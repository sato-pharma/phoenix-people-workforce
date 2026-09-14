import Link from "next/link";

import { NativePlanReviewsWorkspace } from "@/components/employee-portal/native-plan-reviews-workspace";
import { NativePlanWorkspace } from "@/components/employee-portal/native-plan-workspace";
import { NativeVisitConfirmationsWorkspace } from "@/components/employee-portal/native-visit-confirmations-workspace";
import { NativeVisitEntryWorkspace } from "@/components/employee-portal/native-visit-entry-workspace";
import { NativeVisitForRepWorkspace } from "@/components/employee-portal/native-visit-for-rep-workspace";
import { PhoenixCrmKpiBoard } from "@/components/employee-portal/phoenix-crm-kpi-board";
import { PhoenixCrmPilotRosterWorkspace } from "@/components/employee-portal/phoenix-crm-pilot-roster-workspace";
import { PhoenixCrmPlansOverview } from "@/components/employee-portal/phoenix-crm-plans-overview";
import { PhoenixCrmTeamVisits } from "@/components/employee-portal/phoenix-crm-team-visits";
import { PortalSegmentedTabs } from "@/components/employee-portal/portal-primitives";
import { Button } from "@/components/ui/button";
import type { AccessContext } from "@/lib/auth/permissions";
import { getPhoenixCrmKpis, getPhoenixCrmPlanOverview } from "@/lib/crm/native-visits/phoenix-crm";
import type { PhoenixCrmSeat, PhoenixCrmTab } from "@/lib/crm/native-visits/phoenix-crm-types";
import { listPilotTeamNativeVisits } from "@/lib/crm/native-visits/service";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";

/**
 * Phoenix CRM's own space (the owner, 2026-09-14): Visits, Planning and KPIs, plus the pilot roster for
 * the Super Admin. What each tab holds depends on who is looking:
 *   · a pilot rep enters their visits and weekly plan, and reads their own KPIs;
 *   · a manager confirms double visits, verifies plans and reads their own pilot reps' visits and KPIs;
 *   · the Super Admin enters visits for reps, reads every pilot rep and picks who is in the pilot.
 * Every number and every list comes from the services, which check access again.
 */

const MONTH_FORMAT = stableEnGbFormatter({ month: "long", year: "numeric", timeZone: "Africa/Cairo" });

const TAB_LABELS: Record<PhoenixCrmTab, string> = {
  visits: "Visits",
  planning: "Planning",
  kpis: "KPIs",
  "pilot-reps": "Pilot reps",
};

export function phoenixCrmTabsFor(seat: PhoenixCrmSeat): PhoenixCrmTab[] {
  return seat === "admin" ? ["visits", "planning", "kpis", "pilot-reps"] : ["visits", "planning", "kpis"];
}

export function parsePhoenixCrmTab(value: string | string[] | undefined, seat: PhoenixCrmSeat): PhoenixCrmTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return phoenixCrmTabsFor(seat).find((tab) => tab === raw) ?? "visits";
}

function LoadError({ message }: { message: string }) {
  return <p className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{message}</p>;
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function VisitsTab({ access, seat }: { access: AccessContext; seat: PhoenixCrmSeat }) {
  if (seat === "rep") return <NativeVisitEntryWorkspace />;
  if (seat === "admin") return <NativeVisitForRepWorkspace />;
  let team: Awaited<ReturnType<typeof listPilotTeamNativeVisits>> | null = null;
  let failure: string | null = null;
  try {
    team = await listPilotTeamNativeVisits(access, {});
  } catch (error) {
    failure = errorText(error, "Could not load your pilot reps' visits.");
  }
  return (
    <div className="space-y-4">
      <NativeVisitConfirmationsWorkspace />
      {team ? <PhoenixCrmTeamVisits view={team} /> : <LoadError message={failure ?? "Could not load your pilot reps' visits."} />}
    </div>
  );
}

async function PlanningTab({ access, seat }: { access: AccessContext; seat: PhoenixCrmSeat }) {
  if (seat === "rep") return <NativePlanWorkspace />;
  let overview: Awaited<ReturnType<typeof getPhoenixCrmPlanOverview>> | null = null;
  let failure: string | null = null;
  try {
    overview = await getPhoenixCrmPlanOverview(access);
  } catch (error) {
    failure = errorText(error, "Could not load the week plans.");
  }
  const board = overview ? (
    <PhoenixCrmPlansOverview
      description={
        seat === "admin"
          ? "Each pilot rep's plan for this week and the next. Only the manager a plan was sent to verifies or returns it."
          : "Each of your pilot reps' plans for this week and the next. The plans sent to you are verified in the list above."
      }
      overview={overview}
      title={seat === "admin" ? "Every pilot rep's plans" : "Your pilot reps' plans"}
    />
  ) : (
    <LoadError message={failure ?? "Could not load the week plans."} />
  );
  if (seat === "admin") return board;
  return (
    <div className="space-y-4">
      <NativePlanReviewsWorkspace />
      {board}
    </div>
  );
}

async function KpisTab({ access, basePath, month }: { access: AccessContext; basePath: string; month: string | undefined }) {
  let view: Awaited<ReturnType<typeof getPhoenixCrmKpis>> | null = null;
  let failure: string | null = null;
  try {
    view = await getPhoenixCrmKpis(access, { month });
  } catch (error) {
    failure = errorText(error, "Could not load the KPIs.");
  }
  if (!view) return <LoadError message={failure ?? "Could not load the KPIs."} />;
  return (
    <div className="space-y-4">
      {view.months.length > 1 ? (
        <form action={basePath} className="flex flex-wrap items-end gap-2" method="get">
          <input name="tab" type="hidden" value="kpis" />
          <label className="grid gap-1 text-xs font-bold text-slate-600">
            Month
            <select
              className="h-10 min-w-0 rounded border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700"
              defaultValue={view.month}
              name="month"
            >
              {view.months.map((option) => (
                <option key={option} value={option}>
                  {MONTH_FORMAT.format(new Date(`${option}-15T12:00:00Z`))}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline">
            Show
          </Button>
        </form>
      ) : null}
      <PhoenixCrmKpiBoard view={view} />
    </div>
  );
}

export async function PhoenixCrmSpace({
  access,
  basePath,
  month,
  seat,
  tab,
}: {
  access: AccessContext;
  basePath: string;
  month: string | undefined;
  seat: PhoenixCrmSeat;
  tab: PhoenixCrmTab;
}) {
  return (
    <div className="space-y-4">
      <PortalSegmentedTabs>
        {phoenixCrmTabsFor(seat).map((option) => (
          <Link
            aria-current={option === tab ? "page" : undefined}
            className={cn(
              "flex-1 whitespace-nowrap rounded px-3 py-2 text-center text-sm font-bold transition",
              option === tab ? "bg-white text-orange-700 shadow-sm" : "text-slate-600 hover:bg-white/70",
            )}
            href={`${basePath}?tab=${option}`}
            key={option}
          >
            {TAB_LABELS[option]}
          </Link>
        ))}
      </PortalSegmentedTabs>
      {tab === "visits" ? <VisitsTab access={access} seat={seat} /> : null}
      {tab === "planning" ? <PlanningTab access={access} seat={seat} /> : null}
      {tab === "kpis" ? <KpisTab access={access} basePath={basePath} month={month} /> : null}
      {tab === "pilot-reps" && seat === "admin" ? <PhoenixCrmPilotRosterWorkspace /> : null}
    </div>
  );
}
