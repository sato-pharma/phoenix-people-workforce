import { Suspense } from "react";
import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { DashboardSkeleton } from "@/components/employee-portal/skeleton-templates";
import { CrmMasterTable } from "@/components/crm/crm-master-table";
import { CrmSyncStatusPanel } from "@/components/crm/crm-sync-status-panel";
import { CrmTabBar } from "@/components/crm/crm-tab-bar";
import {
  getCrmMasterData,
  type CrmMasterAmpm,
  type CrmMasterData,
  type CrmMasterDataset,
  type CrmMasterMappingStatus,
} from "@/lib/crm/master";
import { CRM_MASTER_DATASETS } from "@/lib/crm/master-datasets";
import { isPortalCrmRole, resolvePortalCrmScope, toPortalCrmScopeView } from "@/lib/crm/portal-crm-scope";
import { getCrmCutoverSetting } from "@/lib/crm/cutover";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContextFromPage } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Portal-scoped CRM Master. The SAME grid and streaming export as /admin/crm, but every row is
// bounded server-side to the caller's own scope (Medical Rep = self, DSM = district, RM = region
// subtree, NSM = line subtree — see resolvePortalCrmScope). Deliberately does NOT implement a
// `view` param, so the four unscoped Super-Admin governance panels (?view=unmapped/recovered/…) are
// unreachable here even by hand-typed URL; CrmTabBar is passed extraTabs={[]} for the same reason.

function dateParam(value: string | string[] | undefined) {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function intParam(value: string | string[] | undefined, fallback: number) {
  const parsed = Number(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function stringParam(value: string | string[] | undefined) {
  return typeof value === "string" && value.trim() ? value : null;
}

function datasetParam(value: string | string[] | undefined): CrmMasterDataset {
  const raw = typeof value === "string" ? value : "";
  const match = CRM_MASTER_DATASETS.find((ds) => ds.id === raw);
  return match ? match.id : "visits";
}

async function PortalCrmContent({
  access,
  params,
}: {
  access: AccessContext;
  params: { [key: string]: string | string[] | undefined };
}) {
  const scope = await resolvePortalCrmScope(access);
  const scopeView = toPortalCrmScopeView(scope, access.role);

  const dataset = datasetParam(params.dataset);
  const minDurationRaw = params.minDuration;
  const minDuration =
    typeof minDurationRaw === "string" && Number.isFinite(Number(minDurationRaw)) ? Number(minDurationRaw) : null;

  let data: CrmMasterData | null = null;
  let loadError: string | null = null;
  try {
    data = await getCrmMasterData(
      {
        agentHrId: stringParam(params.agentHrId),
        ampm: (typeof params.ampm === "string" ? params.ampm : undefined) as CrmMasterAmpm | undefined,
        dataset,
        dateFrom: dateParam(params.dateFrom),
        dateTo: dateParam(params.dateTo),
        halfDaysOnly: params.halfDaysOnly === "1",
        hireFrom: dateParam(params.hireFrom),
        hireTo: dateParam(params.hireTo),
        line: stringParam(params.line),
        mappingStatus: (typeof params.mappingStatus === "string" ? params.mappingStatus : undefined) as
          | CrmMasterMappingStatus
          | undefined,
        minDuration,
        page: intParam(params.page, 1),
        pageSize: intParam(params.pageSize, 50),
        search: stringParam(params.search),
        visitType: stringParam(params.visitType),
      },
      scope,
    );
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Failed to load CRM.";
  }

  if (!data) {
    return <EmployeePortalEmptyState message={loadError ?? "No CRM data is available for your scope yet."} title="CRM unavailable" />;
  }

  // Freshness signal for the manager reading a decision surface. getCrmMasterData ALREADY fetches
  // these sync runs (data.latestSyncRuns) and the admin hub renders exactly this panel from them — the
  // portal fetched them and threw them away. Rendered read-only: the backfill control it carries hits
  // a Super-Admin-only endpoint, so a field manager must never see it. retiredAt drives the "iReports360
  // was retired" line; an unreadable setting leaves the panel exactly as it would be otherwise.
  const today = todayIso();
  const vendorSyncRetiredAt = await getCrmCutoverSetting()
    .then((setting) => setting.vendorSyncRetiredAt)
    .catch(() => null);

  const tableKey = `${dataset}:${data.dateFrom}:${data.dateTo}:${data.page}:${data.pageSize}`;
  return (
    <div className="space-y-4">
      <span className="inline-flex items-center gap-1.5 rounded border border-orange-200 bg-orange-50 px-2.5 py-1 text-phx-xs font-semibold uppercase tracking-[0.08em] text-orange-700">
        {scopeView.scopeSummary}
      </span>
      <CrmSyncStatusPanel
        configured={data.configured}
        dateFrom={addDaysIso(today, -30)}
        dateTo={today}
        latestSyncRuns={data.latestSyncRuns}
        readOnly
        retiredAt={vendorSyncRetiredAt}
      />
      <CrmTabBar active={data.dataset} extraTabs={[]} />
      <CrmMasterTable
        data={data}
        key={tableKey}
        exportPath="/api/employee-portals/crm/master-export"
        showMappingFilter={false}
      />
    </div>
  );
}

export default async function PortalCrmPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!isPortalCrmRole(access.role)) {
    redirect(resolveLandingPathForRole(access.role));
  }
  // assertPermission THROWS on denial. All four portal roles hold crm_visits:read today, but the
  // matrix is runtime-overridable via role_permission_overrides, so a revoked permission must land
  // the caller on their own role's page — the SAME graceful redirect the role gate above uses —
  // never as an uncaught 500. This runs before EmployeePortalPageShell, so its error boundary would
  // NOT catch the throw; the scoped export route (route.ts) already handles the identical case as a
  // 403. redirect() throws NEXT_REDIRECT, which must propagate — so it sits inside the catch, not the
  // try, and only a genuine ForbiddenError is swallowed; every other error re-throws.
  try {
    await assertPermission(access, "crm_visits", "read");
  } catch (error) {
    if (isForbiddenError(error)) {
      redirect(resolveLandingPathForRole(access.role));
    }
    throw error;
  }

  const params = await searchParams;

  return (
    <EmployeePortalPageShell
      badge="Fieldforce"
      description="Every field visit and GPS check-in across your scope — full detail, filters and export."
      errorBoundaryTitle="CRM unavailable"
      title="CRM"
    >
      <Suspense fallback={<DashboardSkeleton kpiCount={4} chartCount={2} />}>
        <PortalCrmContent access={access} params={params} />
      </Suspense>
    </EmployeePortalPageShell>
  );
}
