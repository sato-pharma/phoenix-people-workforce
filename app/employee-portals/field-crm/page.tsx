import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { PhoenixCrmApp } from "@/components/phoenix-crm/phoenix-crm-app";
import { CrmEmpty, CrmPanel } from "@/components/phoenix-crm/ui";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import {
  loadPhoenixCrmPage,
  PHOENIX_CRM_ADMIN_PATH,
  PHOENIX_CRM_PORTAL_PATH,
  phoenixCrmPageDescription,
  phoenixCrmTabQuery,
  requestedPhoenixCrmTab,
} from "@/lib/phoenix-crm/server/page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phoenix CRM (the owner, 2026-09-16): the field force's customer lists, weekly plans, visits and
// reports, built clean in Phoenix. The admin shell twin is /admin/field-crm. The pilot at
// /employee-portals/phoenix-crm is a different, older module.
export default async function PhoenixCrmPortalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  const tab = requestedPhoenixCrmTab((await searchParams).tab);
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`${PHOENIX_CRM_ADMIN_PATH}${phoenixCrmTabQuery(tab)}`);
  }

  const load = await loadPhoenixCrmPage(access);

  if (load.kind === "ready") {
    return (
      <EmployeePortalPageShell badge="CRM" description={phoenixCrmPageDescription(load.overview)} title="Phoenix CRM">
        <PhoenixCrmApp initialOverview={load.overview} initialTab={tab} surface="portal" />
      </EmployeePortalPageShell>
    );
  }

  if (load.kind === "failed") {
    logPortalFailure({ hrId: access.hrId, module: "phoenix-crm", role: access.role, route: PHOENIX_CRM_PORTAL_PATH }, load.error);
  }

  return (
    <EmployeePortalPageShell badge="CRM" title="Phoenix CRM">
      <CrmPanel>
        {load.kind === "failed" ? (
          <CrmEmpty
            message="This is a load failure, not an empty module. Reload the page in a minute."
            title="Phoenix CRM could not load"
          />
        ) : (
          <CrmEmpty message={load.message} title="Phoenix CRM is not open for you" />
        )}
      </CrmPanel>
    </EmployeePortalPageShell>
  );
}
