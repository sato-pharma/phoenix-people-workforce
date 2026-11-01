import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { CrmFirstReadProvider } from "@/components/phoenix-crm/first-read";
import { PhoenixCrmNewNotices } from "@/components/phoenix-crm/new-badge";
import { PhoenixCrmNoticesSeen } from "@/components/phoenix-crm/notices-seen";
import { PhoenixCrmApp } from "@/components/phoenix-crm/phoenix-crm-app";
import { CrmEmpty, CrmPanel } from "@/components/phoenix-crm/ui";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { startPhoenixCrmFirstRead } from "@/lib/phoenix-crm/server/first-read";
import { loadPhoenixCrmUnreadByModule } from "@/lib/phoenix-crm/server/unread-notices";
import type { PhoenixCrmUnreadByModule } from "@/lib/phoenix-crm/notice-badge-rules";
import type { PhoenixCrmModuleKey } from "@/lib/phoenix-crm/modules";
import { phoenixCrmModuleForSlug } from "@/lib/phoenix-crm/modules";
import {
  loadPhoenixCrmPage,
  PHOENIX_CRM_ADMIN_PATH,
  PHOENIX_CRM_PORTAL_PATH,
  phoenixCrmTabQuery,
} from "@/lib/phoenix-crm/server/page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 🔴 NO `generateMetadata` HERE, DELIBERATELY. The app already has ONE title resolver
// (src/lib/navigation/module-title.ts) used by both the layout's metadata and the client
// DocumentTitleSync, precisely so a tab's name does not change as a page settles. A local
// generateMetadata FIGHTS it and loses on client navigation: it produced "Phoenix CRM · List" on
// first paint and "Doctors · Phoenix Workforce" a moment later. The slug is what makes the shared
// resolver say the right thing, because it names a page from its own segments.

/** The module's new notices, once the unread read is in — streamed, so the page never waits for them. */
async function ModuleNotices({
  moduleKey,
  unreadRead,
}: {
  moduleKey: PhoenixCrmModuleKey;
  unreadRead: Promise<PhoenixCrmUnreadByModule | null>;
}) {
  const unread = await unreadRead;
  return (
    <>
      <PhoenixCrmNewNotices entry={unread?.[moduleKey]} />
      <PhoenixCrmNoticesSeen moduleKey={moduleKey} pending={(unread?.[moduleKey]?.count ?? 0) > 0} />
    </>
  );
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
  const { module: slug } = await params;
  const entry = phoenixCrmModuleForSlug(slug);
  if (!entry) notFound();
  const moduleKey = entry.key;

  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect(`${PHOENIX_CRM_ADMIN_PATH}${phoenixCrmTabQuery(moduleKey)}`);
  }

  const label = entry.label;
  // 🔴 THE UNREAD NOTICES NO LONGER HOLD THE PAGE (2026-10-31, "fix the slowest five pages"). They only decorate it, and
  // on every Phoenix CRM open the page waited for whichever of the two reads was slower — usually these. They start beside
  // the page load, are never awaited by it, and fill in under their own Suspense. The read never rejects (a failed read is
  // null, a card without a pulse), so it is safe to leave running when the page answers without it.
  const unreadRead = loadPhoenixCrmUnreadByModule(access);
  const load = await loadPhoenixCrmPage(access);
  // `?add=visit` / `?add=week` still arrive here from the portal's "+", and the shell reads them.
  void (await searchParams);

  if (load.kind === "ready") {
    if (!load.overview.tabs[moduleKey]) {
      return (
        <EmployeePortalPageShell badge="CRM" description={`Phoenix CRM · ${label}`} title={label}>
          <CrmPanel>
            <CrmEmpty message={`${label} is not open for you in Phoenix CRM.`} title={`${label} is not yours to open`} />
          </CrmPanel>
        </EmployeePortalPageShell>
      );
    }
    // The tab's first read, started now and never awaited: it rides in this page's stream (first-read.ts).
    const firstRead = await startPhoenixCrmFirstRead(access, load.overview, moduleKey, "portal");
    return (
      <EmployeePortalPageShell badge="CRM" description={`Phoenix CRM · ${label}`} title={label}>
        <div className="grid min-w-0 gap-3">
          {/* The way back, because a separated page carries no bar of the others. */}
          <p className="min-w-0">
            <Link className="text-xs font-black text-slate-600 underline underline-offset-2 hover:text-orange-700" href={PHOENIX_CRM_PORTAL_PATH}>
              ← All of Phoenix CRM
            </Link>
          </p>
          {/* What is new for him here (owner, 2026-10-08), cleared once this page is really on his screen. */}
          <Suspense fallback={null}>
            <ModuleNotices moduleKey={moduleKey} unreadRead={unreadRead} />
          </Suspense>
          <CrmFirstReadProvider firstRead={firstRead}>
            <PhoenixCrmApp initialOverview={load.overview} initialTab={moduleKey} single surface="portal" />
          </CrmFirstReadProvider>
        </div>
      </EmployeePortalPageShell>
    );
  }

  if (load.kind === "failed") {
    logPortalFailure(
      { hrId: access.hrId, module: "phoenix-crm", role: access.role, route: `${PHOENIX_CRM_PORTAL_PATH}/${slug}` },
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
