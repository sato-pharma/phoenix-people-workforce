// Early Birds — admin twin of /employee-portals/early-birds, serving CEO, SFE Manager and Super
// Admin (the three roles in this module's audience that resolve to the admin shell). Same board
// component and same scope resolver as the portal page; only the shell differs.
//
// District is a URL search param so every switch re-runs the server-side scope gate.
import { redirect } from "next/navigation";
import { Sunrise } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { EarlyBirdsBoard } from "@/components/early-birds/early-birds-board";
import { EarlyBirdsDistrictSwitcher } from "@/components/early-birds/early-birds-district-switcher";
import { EarlyBirdsSyncButton } from "@/components/crm/early-birds-sync-button";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEarlyBirdsBoard } from "@/lib/early-birds/service";
import { assertDistrictInScope, resolveEarlyBirdsScope } from "@/lib/early-birds/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROLES = new Set(["Super Admin", "CEO", "SFE Manager"]);

type PageProps = { searchParams?: Promise<{ district?: string; period?: string }> };

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

  const data = await getEarlyBirdsBoard({
    managerHrId: district.hrId,
    managerName: district.name,
    periodKey: params.period,
    scopeLabel: district.name,
  });

  return (
    <div className="space-y-5">
      {hero}
      <EarlyBirdsDistrictSwitcher
        basePath="/admin/early-birds"
        districts={scope.districts}
        selectedHrIdKey={district.hrIdKey}
      />
      <EarlyBirdsBoard action={<EarlyBirdsSyncButton />} data={data} viewerHrIdKey={scope.viewerHrIdKey} />
    </div>
  );
}
