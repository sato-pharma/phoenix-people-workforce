import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { PhoenixCrmApp } from "@/components/phoenix-crm/phoenix-crm-app";
import { CrmEmpty, CrmPanel } from "@/components/phoenix-crm/ui";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { isPhoenixCrmModuleKey, PHOENIX_CRM_MODULES } from "@/lib/phoenix-crm/modules";
import {
  loadPhoenixCrmPage,
  PHOENIX_CRM_ADMIN_PATH,
  PHOENIX_CRM_PORTAL_PATH,
  phoenixCrmTabQuery,
} from "@/lib/phoenix-crm/server/page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One shape for every module's tab title, so the split reads as one module and not eight pages that
// happened to land together. Without it the shared DocumentTitleSync guesses from the address and the
// titles disagree — "Phoenix CRM List" on one page, plain "Visits" on the next.
export async function generateMetadata({ params }: { params: Promise<{ module: string }> }): Promise<Metadata> {
  const { module } = await params;
  const label = isPhoenixCrmModuleKey(module) ? (PHOENIX_CRM_MODULES.find((entry) => entry.key === module)?.label ?? null) : null;
  return { title: label ? `Phoenix CRM · ${label}` : "Phoenix CRM" };
}

// ONE Phoenix CRM module, on its own page (owner, 2026-09-30: "a page that has the SPLIT modules").
// The chooser at /employee-portals/field-crm lists them; this renders the one he picked, at its own
// address, so he can keep the link and the browser's Back works between them.
//
// A module his role cannot reach is NOT a 404 — the sentence names it, exactly as the chooser omits it,
// because a rep following a shared link should read why rather than meet a dead page. An unknown
// segment IS a 404: nothing in the app produces one.
export default async function PhoenixCrmModulePage({
  params,
  searchParams,
}: {
  params: Promise<{ module: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { module } = await params;
  if (!isPhoenixCrmModuleKey(module)) notFound();

  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`${PHOENIX_CRM_ADMIN_PATH}${phoenixCrmTabQuery(module)}`);
  }

  const label = PHOENIX_CRM_MODULES.find((entry) => entry.key === module)?.label ?? "Phoenix CRM";
  const load = await loadPhoenixCrmPage(access);
  // `?add=visit` / `?add=week` still arrive here from the portal's "+", and the shell reads them.
  void (await searchParams);

  if (load.kind === "ready") {
    if (!load.overview.tabs[module]) {
      return (
        <EmployeePortalPageShell badge="CRM" description={`Phoenix CRM · ${label}`} title={label}>
          <CrmPanel>
            <CrmEmpty message={`${label} is not open for you in Phoenix CRM.`} title={`${label} is not yours to open`} />
          </CrmPanel>
        </EmployeePortalPageShell>
      );
    }
    return (
      <EmployeePortalPageShell badge="CRM" description={`Phoenix CRM · ${label}`} title={label}>
        <PhoenixCrmApp initialOverview={load.overview} initialTab={module} surface="portal" />
      </EmployeePortalPageShell>
    );
  }

  if (load.kind === "failed") {
    logPortalFailure(
      { hrId: access.hrId, module: "phoenix-crm", role: access.role, route: `${PHOENIX_CRM_PORTAL_PATH}/${module}` },
      load.error,
    );
  }

  return (
    <EmployeePortalPageShell badge="CRM" title={label}>
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
