// Early Birds — the fortnightly field-discipline board, portal shell.
//
// Serves every portal-mode role in the module's audience: Medical Rep, District Manager, Regional
// Manager, National Sales Manager, Marketing Manager, PM/GPM, Training Manager. The admin twin at
// /admin/early-birds renders the SAME board for CEO / SFE Manager / Super Admin, who resolve to the
// admin shell and can never reach this page.
//
// Scope is resolved server-side from the real reporting chain (resolveEarlyBirdsScope) and a
// district passed in the URL is validated against it, so switching ?district= can never read a
// district outside the viewer's own subtree.
import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { EarlyBirdsBoard } from "@/components/early-birds/early-birds-board";
import { EarlyBirdsDistrictSwitcher } from "@/components/early-birds/early-birds-district-switcher";
import { EarlyBirdsSyncButton } from "@/components/crm/early-birds-sync-button";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { getEarlyBirdsBoard } from "@/lib/early-birds/service";
import { assertDistrictInScope, resolveEarlyBirdsScope } from "@/lib/early-birds/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = { searchParams?: Promise<{ district?: string; period?: string }> };

/** Mirrors the role gate in app/api/crm/early-birds/sync/route.ts. */
const SYNC_ROLES = new Set(["District Manager", "Regional Manager", "National Sales Manager"]);

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

  const data = await getEarlyBirdsBoard({
    managerHrId: district.hrId,
    managerName: district.name,
    periodKey: params.period,
    scopeLabel: scope.scopeLabel,
  });

  // Only the roles that may spend a vendor login see the button. A Medical Rep reads the board;
  // the route rejects him anyway, but offering a button that always fails is worse than no button.
  const canSync = SYNC_ROLES.has(access.role) || access.scope === "system";

  return shell(
    <div className="space-y-3">
      <EarlyBirdsDistrictSwitcher
        basePath="/employee-portals/early-birds"
        districts={scope.districts}
        selectedHrIdKey={district.hrIdKey}
      />
      <EarlyBirdsBoard
        action={canSync ? <EarlyBirdsSyncButton /> : undefined}
        data={data}
        viewerHrIdKey={scope.viewerHrIdKey}
      />
    </div>,
  );
}
