import { redirect } from "next/navigation";
import { Suspense } from "react";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { PhoenixCrmModuleChooser } from "@/components/phoenix-crm/module-chooser";
import { CrmEmpty, CrmPanel } from "@/components/phoenix-crm/ui";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { loadPhoenixCrmUnreadByModule } from "@/lib/phoenix-crm/server/unread-notices";
import type { PhoenixCrmUnreadByModule } from "@/lib/phoenix-crm/notice-badge-rules";
import { isPhoenixCrmModuleKey, phoenixCrmModulePath } from "@/lib/phoenix-crm/modules";
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

// Phoenix CRM — THE CHOOSER (owner, 2026-09-30: "make the Phoenix CRM a button in the sidebar that
// does not direct me into what it directs me today — it directs me to a page that has the SPLIT
// modules"). This address used to open Today with every other module mounted beside it in one screen;
// it now lists the modules, and each one is its own page at /employee-portals/field-crm/<module>.
//
// `?tab=` is kept and FORWARDED, never dropped: the portal's "+" actions, in-app notification links
// and any address he has saved still carry it, and `?add=` rides along so "+ Add visit" still opens
// the form on arrival. The admin shell twin is /admin/field-crm, which keeps its one-screen shape.
export default async function PhoenixCrmPortalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  const params = await searchParams;
  const tab = requestedPhoenixCrmTab(params.tab);
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`${PHOENIX_CRM_ADMIN_PATH}${phoenixCrmTabQuery(tab)}`);
  }
  // A named module goes straight to its own page, carrying `?add=` with it.
  if (isPhoenixCrmModuleKey(tab)) {
    const add = requestedPhoenixCrmTab(params.add);
    redirect(`${phoenixCrmModulePath(PHOENIX_CRM_PORTAL_PATH, tab)}${add ? `?add=${add}` : ""}`);
  }

  // The unread notices ride beside the page load: they only decorate the cards, and a failed read is a
  // card without a pulse (null), never a broken chooser.
  // 🔴 THE UNREAD NOTICES NO LONGER HOLD THE PAGE (2026-10-31, "fix the slowest five pages"). They only decorate it, and
  // on every Phoenix CRM open the page waited for whichever of the two reads was slower — usually these. They start beside
  // the page load, are never awaited by it, and fill in under their own Suspense. The read never rejects (a failed read is
  // null, a card without a pulse), so it is safe to leave running when the page answers without it.
  const unreadRead = loadPhoenixCrmUnreadByModule(access);
  const load = await loadPhoenixCrmPage(access);

  if (load.kind === "ready") {
    return (
      <EmployeePortalPageShell badge="CRM" description={phoenixCrmPageDescription(load.overview)} title="Phoenix CRM">
        <CrmPanel title="Phoenix CRM">
          {/* The chooser draws at once with no pulses, and again with them once the unread read is in. */}
          <Suspense fallback={<PhoenixCrmModuleChooser base={PHOENIX_CRM_PORTAL_PATH} overview={load.overview} unread={null} />}>
            <ChooserWithUnread load={load} unreadRead={unreadRead} />
          </Suspense>
        </CrmPanel>
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

/** The chooser with its new-notice pulses, once the unread read is in. */
async function ChooserWithUnread({
  load,
  unreadRead,
}: {
  load: Extract<Awaited<ReturnType<typeof loadPhoenixCrmPage>>, { kind: "ready" }>;
  unreadRead: Promise<PhoenixCrmUnreadByModule | null>;
}) {
  const unread = await unreadRead;
  return <PhoenixCrmModuleChooser base={PHOENIX_CRM_PORTAL_PATH} overview={load.overview} unread={unread} />;
}
