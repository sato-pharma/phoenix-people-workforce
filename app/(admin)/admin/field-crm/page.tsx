import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CrmFirstReadProvider } from "@/components/phoenix-crm/first-read";
import { PhoenixCrmApp } from "@/components/phoenix-crm/phoenix-crm-app";
import { CrmEmpty, CrmPanel } from "@/components/phoenix-crm/ui";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";
import { startPhoenixCrmFirstRead } from "@/lib/phoenix-crm/server/first-read";
import {
  loadPhoenixCrmPage,
  PHOENIX_CRM_ADMIN_PATH,
  phoenixCrmPageDescription,
  phoenixCrmTabQuery,
  requestedPhoenixCrmTab,
} from "@/lib/phoenix-crm/server/page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HERO_ICON = <ClipboardList className="h-3.5 w-3.5" />;

/** Only the tab crosses to the portal page, matching the twin rule in src/lib/navigation/portal-twins.ts. */
function preservedQuery(params: Record<string, string | string[] | undefined>) {
  return phoenixCrmTabQuery(requestedPhoenixCrmTab(params.tab));
}

// Phoenix CRM in the admin shell (the owner, 2026-09-16). The employee portal twin is
// /employee-portals/field-crm. The retired pilot at /admin/phoenix-crm forwards here.
export default async function AdminPhoenixCrmFieldPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  const params = await searchParams;
  // The admin layout already sends a portal viewer to this twin; the literal path is what
  // tests/portal-twin-forwarding.test.ts reads to keep that table honest.
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect(`/employee-portals/field-crm${preservedQuery(params)}`);
  }
  const tab = requestedPhoenixCrmTab(params.tab);

  const load = await loadPhoenixCrmPage(access);

  if (load.kind === "ready") {
    // The opening tab's first read, started now and never awaited: it rides in this page's stream (first-read.ts).
    const firstRead = await startPhoenixCrmFirstRead(access, load.overview, tab, "admin");
    return (
      <div className="space-y-5">
        <AdminPageHero description={phoenixCrmPageDescription(load.overview)} eyebrow="CRM" icon={HERO_ICON} title="Phoenix CRM" />
        <CrmFirstReadProvider firstRead={firstRead}>
          <PhoenixCrmApp initialOverview={load.overview} initialTab={tab} surface="admin" />
        </CrmFirstReadProvider>
      </div>
    );
  }

  if (load.kind === "failed") {
    logError("Phoenix CRM page failed to load", {
      error: load.error,
      labels: { event: "phoenix_crm_page_failed", route: PHOENIX_CRM_ADMIN_PATH },
    });
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="The field force's customer lists, weekly plans, visits and reports, entered in Phoenix."
        eyebrow="CRM"
        icon={HERO_ICON}
        title="Phoenix CRM"
      />
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
    </div>
  );
}
