// Early Birds - admin twin of /employee-portals/early-birds, serving CEO, SFE Manager and Super
// Admin (the three roles in this module's audience that resolve to the admin shell). Same board
// component and same scope resolver as the portal page; only the shell differs.
//
// District, fortnight and open rep are all URL search params so every switch re-runs the
// server-side gates. The three guards and why they differ are documented on the portal twin.
import { redirect } from "next/navigation";
import { Sunrise } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { EarlyBirdsBoard } from "@/components/early-birds/early-birds-board";
import { EarlyBirdsControls } from "@/components/early-birds/early-birds-controls";
import { formatShownScopeLabel } from "@/components/early-birds/early-birds-format";
import { EarlyBirdsRepHistoryPanel } from "@/components/early-birds/early-birds-rep-history-panel";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getEarlyBirdsRepHistory } from "@/lib/early-birds/history";
import {
  currentEarlyBirdsPeriod,
  listSelectableEarlyBirdsPeriods,
  resolveEarlyBirdsPeriodParam,
} from "@/lib/early-birds/period";
import { getEarlyBirdsBoard } from "@/lib/early-birds/service";
import { assertDistrictInScope, assertRepInRoster, resolveEarlyBirdsScope } from "@/lib/early-birds/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HR Resourcing — the Talent Acquisition seat, ticked by the owner on 2026-10-08. Read only, like
// the CEO: confirming a fortnight stays with each District Manager.
const ALLOWED_ROLES = new Set(["Super Admin", "CEO", "SFE Manager", "HR Resourcing"]);
const BASE_PATH = "/admin/early-birds";

type PageProps = { searchParams?: Promise<{ district?: string; period?: string; rep?: string }> };

export default async function AdminEarlyBirdsPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (access.scope !== "system" && !ALLOWED_ROLES.has(access.role)) redirect("/admin");

  const params = (await searchParams) ?? {};
  const scope = await resolveEarlyBirdsScope(access);

  const hero = (
    <AdminPageHero
      description="Who starts the day first. Ranked every fortnight from real CRM visit times, confirmed by each District Manager."
      eyebrow="Field Discipline"
      icon={<Sunrise className="h-5 w-5" />}
      title="Early Birds"
    />
  );

  if (scope.directoryUnavailable) {
    // Distinct from "nothing to rank": the directory read failed, so we do not know what there is
    // to rank. An amber outage panel, never the grey empty state.
    return (
      <div className="space-y-5">
        {hero}
        <div className="border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-bold text-amber-900">The employee directory could not be loaded.</p>
          <p className="mt-1 text-sm text-amber-800">
            Districts cannot be resolved until it is readable again, so this board is showing nothing
            rather than showing an empty ranking that would look like a real result. Refresh in a
            minute; if it persists, check the database connection.
          </p>
        </div>
      </div>
    );
  }

  if (scope.districts.length === 0) {
    return (
      <div className="space-y-5">
        {hero}
        <div className="border border-slate-200 bg-white px-5 py-6">
          <p className="text-sm text-slate-500">
            No district has medical reps mapped to it yet, so there is nothing to rank.
          </p>
        </div>
      </div>
    );
  }

  const district = assertDistrictInScope(scope, params.district);
  if (!district) {
    return (
      <div className="space-y-5">
        {hero}
        <div className="border border-rose-200 bg-rose-50 px-5 py-4">
          <p className="text-sm font-bold text-rose-800">That district is not in your scope.</p>
        </div>
      </div>
    );
  }

  const todayIso = cairoTodayIso();
  const period = resolveEarlyBirdsPeriodParam(params.period, todayIso);

  const data = await getEarlyBirdsBoard({
    managerHrId: district.hrId,
    managerName: district.name,
    periodKey: period.periodKey,
    scopeLabel: formatShownScopeLabel({
      scopeLabel: scope.scopeLabel,
      districtCount: scope.districts.length,
      districtName: district.name,
    }),
  });

  const requestedRep = params.rep?.trim() ?? "";
  const rep = requestedRep ? assertRepInRoster(data.ranking.scores, requestedRep) : null;
  const repRefused = requestedRep.length > 0 && rep === null;
  const repScore = rep ? data.ranking.scores.find((score) => score.hrIdKey === rep.hrIdKey) ?? null : null;
  const history = rep ? await getEarlyBirdsRepHistory({ hrId: rep.hrId }) : null;

  return (
    <div className="space-y-5">
      {hero}

      <EarlyBirdsControls
        basePath={BASE_PATH}
        districts={scope.districts}
        livePeriodKey={currentEarlyBirdsPeriod(todayIso).periodKey}
        periods={listSelectableEarlyBirdsPeriods(todayIso)}
        repHrId={rep?.hrId ?? null}
        scopeLabel={scope.scopeLabel}
        selectedDistrict={district}
        selectedPeriodKey={period.periodKey}
      />

      {repRefused ? (
        <div className="border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="break-words text-sm font-bold text-amber-900">
            That rep is not in {district.name}&apos;s ranking for {period.label}.
          </p>
          <p className="mt-1 break-words text-sm text-amber-800">
            Switch district, or pick the fortnight they were ranked in. The board below is unaffected.
          </p>
        </div>
      ) : null}

      {rep && history ? (
        <EarlyBirdsRepHistoryPanel
          basePath={BASE_PATH}
          district={district.hrId}
          history={history}
          name={rep.name}
          period={data.period}
          profile={data.profiles.get(rep.hrIdKey) ?? null}
          score={repScore}
        />
      ) : null}

      <EarlyBirdsBoard
        data={data}
        openRepHrIdKey={rep?.hrIdKey ?? null}
        repLink={{ basePath: BASE_PATH, district: district.hrId, period: period.periodKey }}
        viewerHrIdKey={scope.viewerHrIdKey}
      />
    </div>
  );
}
