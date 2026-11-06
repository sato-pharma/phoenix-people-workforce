// Early Birds - the fortnightly field-discipline board, portal shell.
//
// Serves every portal-mode role in the module's audience: Medical Rep, District Manager, Regional
// Manager, National Sales Manager, Marketing Manager, PM/GPM, Training Manager. The admin twin at
// /admin/early-birds renders the SAME board for CEO / SFE Manager / Super Admin, who resolve to the
// admin shell and can never reach this page.
//
// THREE URL parameters, and three different guards, because they carry different risks:
//
//   ?district= REFUSES when it is outside the viewer's subtree (assertDistrictInScope). Substituting
//              would show one manager another manager's reps under a heading he has no reason to
//              doubt.
//   ?period=   CLAMPS to the live fortnight (resolveEarlyBirdsPeriodParam). Safe only because every
//              surface names the fortnight it is showing, so a clamp is visible.
//   ?rep=      REFUSES when he is not in the district's roster (assertRepInRoster) - and the board
//              still renders, because the board itself is authorised and correct; it is the one
//              rep that is not available.
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { EarlyBirdsBoard } from "@/components/early-birds/early-birds-board";
import { EarlyBirdsControls } from "@/components/early-birds/early-birds-controls";
import { formatShownScopeLabel } from "@/components/early-birds/early-birds-format";
import { EarlyBirdsRepHistoryPanel } from "@/components/early-birds/early-birds-rep-history-panel";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
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

const BASE_PATH = "/employee-portals/early-birds";

type PageProps = { searchParams?: Promise<{ district?: string; period?: string; rep?: string }> };

export default async function PortalEarlyBirdsPage({ searchParams }: PageProps) {
  const access = await resolveAuthenticatedPageAccess();
  const params = (await searchParams) ?? {};

  const shell = (children: React.ReactNode) => (
    <EmployeePortalPageShell
      badge="Early Birds"
      description="Who starts the day first. Ranked every fortnight, confirmed by the District Manager."
      title="Early Birds"
    >
      {children}
    </EmployeePortalPageShell>
  );

  const scope = await resolveEarlyBirdsScope(access);
  if (scope.directoryUnavailable) {
    // The employee directory could not be read. Saying "no district reports to you" here would be a
    // confident lie to a manager who has six, so name the outage instead.
    return shell(
      <EmployeePortalEmptyState
        message="We could not load the employee directory, so your districts cannot be resolved right now. This is a temporary problem on our side, not a change to your team. Please refresh in a minute."
        title="Your team could not be loaded"
      />,
    );
  }
  if (scope.districts.length === 0) {
    return shell(
      <EmployeePortalEmptyState
        message="Early Birds ranks medical reps by district. No district reports to you, so there is nothing to show here."
        title="No district in your scope"
      />,
    );
  }

  const district = assertDistrictInScope(scope, params.district);
  if (!district) {
    // A district was named that is not in this viewer's subtree. Say so rather than silently
    // falling back to a different district's data.
    return shell(
      <EmployeePortalEmptyState
        message="That district is not in your scope."
        title="District not available"
      />,
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

  // The roster of the district and fortnight actually on screen is the only thing `?rep=` is
  // checked against, so the rep gate can never be wider than the district gate above it.
  const requestedRep = params.rep?.trim() ?? "";
  const rep = requestedRep ? assertRepInRoster(data.ranking.scores, requestedRep) : null;
  const repRefused = requestedRep.length > 0 && rep === null;
  const repScore = rep ? data.ranking.scores.find((score) => score.hrIdKey === rep.hrIdKey) ?? null : null;
  // One extra round trip, and only when a rep is actually open.
  const history = rep ? await getEarlyBirdsRepHistory({ hrId: rep.hrId }) : null;

  return shell(
    <div className="space-y-3">
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
        <div className="border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="break-words text-sm font-bold text-amber-900">
            That rep is not in this district&apos;s ranking for {period.label}.
          </p>
          <p className="mt-1 break-words text-sm text-amber-800">
            They may have moved district, or may not have been a medical rep in that fortnight. The
            board below is unaffected.
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
    </div>,
  );
}
