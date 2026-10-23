import { redirect } from "next/navigation";

import { SystemAuditPage, parseSystemAuditTab } from "@/components/admin/system-audit/system-audit-page";
import type { IncidentsInitial } from "@/components/admin/system-audit/incidents-workspace";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listAuditModuleLabels } from "@/lib/system-audit/incidents-lookup";
import { loadIntegrityOverview, type IntegrityOverview } from "@/lib/system-audit/integrity-runs";
import { parseSystemAuditQuery, type SystemAuditQuery } from "@/lib/system-audit/page-query";
import { loadSystemAuditPage } from "@/lib/system-audit/repository";

export const dynamic = "force-dynamic";

/**
 * /admin/system-audit — the System Error & Data Integrity Audit. SUPER ADMIN ONLY: the guard runs
 * before anything is read. An expired session resolves to the anonymous guest, which goes to
 * sign-in rather than to a "not allowed" bounce.
 *
 * The active tab's data is read here, on the server, for the first paint; the Incidents tab then
 * refetches through /api/admin/system-audit as the filters change. Nothing refreshes on a timer.
 */

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "the ledger did not answer";
}

async function loadIncidents(searchParams: Record<string, string | string[] | undefined>): Promise<IncidentsInitial> {
  let query: SystemAuditQuery;
  try {
    query = parseSystemAuditQuery(searchParams);
  } catch (error) {
    // A hand-edited address with a value the filters do not know: say so, and show the defaults
    // the person can start again from — never a silently widened list.
    return {
      query: parseSystemAuditQuery({}),
      page: null,
      error: `The address carries a filter this page does not recognise: ${describe(error)}`,
      modules: null,
      modulesError: null,
    };
  }

  const [pageResult, modulesResult] = await Promise.allSettled([
    loadSystemAuditPage({ filters: query.filters, sort: query.sort, limit: query.limit, offset: query.offset }),
    listAuditModuleLabels({ from: query.filters.from, to: query.filters.to, includeTest: query.filters.includeTest }),
  ]);

  return {
    query,
    page: pageResult.status === "fulfilled" ? pageResult.value : null,
    error: pageResult.status === "rejected" ? `Unavailable — ${describe(pageResult.reason)}` : null,
    modules: modulesResult.status === "fulfilled" ? modulesResult.value.labels : null,
    modulesError: modulesResult.status === "rejected" ? describe(modulesResult.reason) : null,
  };
}

async function loadIntegrity(): Promise<{ overview: IntegrityOverview | null; error: string | null }> {
  try {
    return { overview: await loadIntegrityOverview(), error: null };
  } catch (error) {
    return { overview: null, error: describe(error) };
  }
}

export default async function SystemAuditRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  // The expired-session fallback: no session resolves to the anonymous guest, which signs in again.
  if (access.source === "guest" || (!access.loginId && !access.hrId)) redirect("/login");

  let allowed = true;
  try {
    assertSystemAdministratorWorkspaceAccess(access, "the System Error & Data Integrity Audit");
  } catch {
    allowed = false;
  }
  // redirect() throws by design, so it stays outside the try.
  if (!allowed) redirect("/admin");

  const params = await searchParams;
  const activeTab = parseSystemAuditTab(params.tab);

  if (activeTab === "incidents") {
    return <SystemAuditPage activeTab={activeTab} incidents={await loadIncidents(params)} />;
  }
  if (activeTab === "integrity") {
    return <SystemAuditPage activeTab={activeTab} integrity={await loadIntegrity()} />;
  }
  return <SystemAuditPage activeTab={activeTab} />;
}
