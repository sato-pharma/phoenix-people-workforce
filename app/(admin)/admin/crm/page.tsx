import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TriangleAlert } from "lucide-react";

import { CrmMasterTable } from "@/components/crm/crm-master-table";
import { CrmSyncStatusPanel } from "@/components/crm/crm-sync-status-panel";
import { CrmTabBar, type CrmActiveTab } from "@/components/crm/crm-tab-bar";
import { CrmUnmappedIdentitiesPanel } from "@/components/crm/crm-unmapped-identities-panel";
import { CrmAccountSetupPanel } from "@/components/crm/crm-account-setup-panel";
import { CrmRecoveredChainsPanel } from "@/components/crm/crm-recovered-chains-panel";
import { CrmRegionMappingPanel } from "@/components/crm/crm-region-mapping-panel";
import { CrmCustomerMappingPanel } from "@/components/crm/crm-customer-mapping-panel";
import { CrmPhoenixTeamReadinessPanel } from "@/components/crm/crm-phoenix-team-readiness-panel";
import { CrmPhoenixTeamStartsPanel } from "@/components/crm/crm-phoenix-team-starts-panel";
import { getCrmMasterData, type CrmMasterAmpm, type CrmMasterDataset, type CrmMasterMappingStatus } from "@/lib/crm/master";
import { CRM_SCOPE_ALL } from "@/lib/crm/viewer-scope";
import { getCrmMappingEmployeeOptions, getLatestVisitsSyncRuns, getUnmappedCrmIdentities } from "@/lib/crm/admin";
import { getUnmappedCrmRegions } from "@/lib/crm/region-brick";
import { getCrmAccountSetupQueue } from "@/lib/crm/account-setup";
import { getCrmCustomerMappingPunchList } from "@/lib/crm/customer-brick";
import { getCrmCutoverSetting } from "@/lib/crm/cutover";
import { loadPhoenixTeamStartsPanel } from "@/lib/crm/phoenix-team-starts-server";
import { logError } from "@/lib/observability/log";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getDoubleVisitRecoveredChains } from "@/lib/double-visit-analytics/service";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { phoenixDetailViewer } from "@/lib/crm/phoenix-visit-detail";
import type { VisitsSyncRun } from "@/lib/visits-report/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HUB_PATHNAME = "/admin/crm";

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

function viewParam(value: string | string[] | undefined): "unmapped" | "recovered" | "region_mapping" | "customer_mapping" | "account_setup" | null {
  return value === "unmapped" || value === "recovered" || value === "region_mapping" || value === "customer_mapping" || value === "account_setup"
    ? value
    : null;
}

// Deeper, same-data tools over the CRM mirror — one click from the master table. Unmapped-identity
// resolution and the recovered-chains audit live on this same page now (see the tab bar below), not
// as separate routes — only the analysis that needs its own dedicated page stays linked out. CRM
// Integrity (/admin/crm-integrity) left this list on 2026-11-07: it compared iReports360 visits with
// iReports360 check-ins, and the vendor was retired on 6 Nov 2026.
const crmTools = [
  { description: "Data-integrity checks for double-visit records", href: "/admin/double-visit-data-integrity", icon: TriangleAlert, label: "Double Visit Data Integrity" },
] as const;

export default async function CrmHubPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  // Raw company-wide CRM mirror — Super Admin only, matching every CRM sub-tool.
  if (!canUseAdminCrmWorkspace(access)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const view = viewParam(params.view);
  const today = todayIso();
  const dateFrom = dateParam(params.dateFrom) ?? addDaysIso(today, -30);
  const dateTo = dateParam(params.dateTo) ?? today;

  let activeTab: CrmActiveTab;
  let latestSyncRuns: VisitsSyncRun[];
  let masterTable: ReactNode = null;
  let derivedView: ReactNode = null;

  if (view === "account_setup") {
    // Where the "an employee was added" notice landed. That notice and its reminder were retired on
    // 2026-11-07 with the vendor CRM, so no new task is opened; old notices still link here. The
    // hrId one carries only spotlights a card — it never filters the queue, so arriving from an
    // old notice still shows everyone else who is waiting.
    activeTab = "account_setup";
    const [queue, syncRuns] = await Promise.all([getCrmAccountSetupQueue(), getLatestVisitsSyncRuns()]);
    latestSyncRuns = syncRuns;
    derivedView = (
      <div className="space-y-3">
        <p className="border border-sky-200 bg-sky-50 px-4 py-2 text-xs font-semibold leading-5 text-sky-800">
          iReports360 was retired on 6 Nov 2026, so no new hire needs an account there and no new task opens. These
          are the tasks from before; a new hire&apos;s field work is recorded on a Phoenix CRM seat.
        </p>
        <CrmAccountSetupPanel
          pending={queue.pending}
          recentlyResolved={queue.recentlyResolved}
          schemaMissing={queue.schemaMissing}
          spotlightHrId={stringParam(params.hrId)}
        />
      </div>
    );
  } else if (view === "unmapped") {
    activeTab = "unmapped";
    const [identities, syncRuns, employeeOptions] = await Promise.all([
      getUnmappedCrmIdentities(),
      getLatestVisitsSyncRuns(),
      getCrmMappingEmployeeOptions(),
    ]);
    latestSyncRuns = syncRuns;
    derivedView = (
      <CrmUnmappedIdentitiesPanel employeeOptions={employeeOptions} identities={identities} pathname={HUB_PATHNAME} />
    );
  } else if (view === "region_mapping") {
    activeTab = "region_mapping";
    const [regions, syncRuns] = await Promise.all([getUnmappedCrmRegions(), getLatestVisitsSyncRuns()]);
    latestSyncRuns = syncRuns;
    derivedView = <CrmRegionMappingPanel pathname={HUB_PATHNAME} regions={regions} />;
  } else if (view === "customer_mapping") {
    activeTab = "customer_mapping";
    const [punchList, syncRuns] = await Promise.all([getCrmCustomerMappingPunchList(), getLatestVisitsSyncRuns()]);
    latestSyncRuns = syncRuns;
    derivedView = (
      <CrmCustomerMappingPanel
        customers={punchList.customers}
        ignoredCount={punchList.ignoredCount}
        localityCount={punchList.localityCount}
        mappedCount={punchList.mappedCount}
        pathname={HUB_PATHNAME}
      />
    );
  } else if (view === "recovered") {
    activeTab = "recovered";
    const [recoveredChains, syncRuns] = await Promise.all([
      getDoubleVisitRecoveredChains({ access, dateFrom, dateTo }),
      getLatestVisitsSyncRuns(),
    ]);
    latestSyncRuns = syncRuns;
    derivedView = <CrmRecoveredChainsPanel chains={recoveredChains} />;
  } else {
    // getCrmMasterData normalizes any unknown value back to "visits".
    const dataset = (typeof params.dataset === "string" ? params.dataset : "visits") as CrmMasterDataset;
    const search = stringParam(params.search);
    const page = intParam(params.page, 1);
    const pageSize = intParam(params.pageSize, 50);
    const agentHrId = stringParam(params.agentHrId);
    const ampm: CrmMasterAmpm | null = params.ampm === "AM" || params.ampm === "PM" ? params.ampm : null;
    const visitType = stringParam(params.visitType);
    const mappingStatus: CrmMasterMappingStatus | null =
      params.mappingStatus === "agent_mapped" || params.mappingStatus === "agent_unmapped" ? params.mappingStatus : null;
    const line = stringParam(params.line);
    const hireFrom = dateParam(params.hireFrom);
    const hireTo = dateParam(params.hireTo);
    const minDuration = typeof params.minDuration === "string" && Number.isFinite(Number(params.minDuration)) ? Number(params.minDuration) : null;
    const halfDaysOnly = params.halfDaysOnly === "1";

    const data = await getCrmMasterData({
      agentHrId,
      ampm,
      dataset,
      // The raw master table itself allows a fully open date range (no default) — only the
      // derived views above need a concrete default window.
      dateFrom: dateParam(params.dateFrom),
      dateTo: dateParam(params.dateTo),
      halfDaysOnly,
      hireFrom,
      hireTo,
      line,
      mappingStatus,
      minDuration,
      page,
      pageSize,
      search,
      visitType,
    },
    // This page is Super-Admin-only (see the redirect above), so it is one of exactly two places
    // allowed to construct the company-wide scope. A test pins that set.
    CRM_SCOPE_ALL,
    // Golden rule #1's tier, asked of his ROLE rather than assumed from the gate above: this page is
    // the Super Admin's, so it resolves to `full` — but a widened gate must not silently widen a
    // sight the owner narrowed himself.
    phoenixDetailViewer(access.role, access.hrId));

    activeTab = data.dataset;
    latestSyncRuns = data.latestSyncRuns;
    // Remount the client table when any URL-derived input changes so its filter inputs re-seed.
    const tableKey = `${dataset}:${data.dateFrom}:${data.dateTo}:${page}:${pageSize}:${search}:${agentHrId}:${ampm}:${visitType}:${mappingStatus}:${line}:${hireFrom}:${hireTo}:${minDuration}:${halfDaysOnly}`;
    masterTable = <CrmMasterTable data={data} key={tableKey} />;
  }

  // THE CRM CUTOVER. Once iReports360 is retired the sync panel says so above its run history. An
  // unreadable setting leaves the panel with the history alone.
  // Beside it, the teams every other screen counts from Phoenix CRM (owner, 2026-10-02) — read in the
  // same breath, and an unreadable list says so in its own panel rather than failing the page.
  const [vendorSyncRetiredAt, phoenixTeamStarts] = await Promise.all([
    getCrmCutoverSetting()
      .then((setting) => setting.vendorSyncRetiredAt)
      .catch(() => null),
    loadPhoenixTeamStartsPanel().catch((error: unknown) => {
      logError("Phoenix CRM team start dates unreadable on the CRM hub", {
        error,
        labels: { event: "phoenix_crm_team_starts_unreadable" },
      });
      return null;
    }),
  ]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-widest text-orange-600">CRM</p>
          <h1 className="text-xl font-bold tracking-[-0.01em] text-slate-950">CRM Master Data (iReports360)</h1>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            The exact mirror of the CRM — every visit and check-in pulled, with all columns and each record&apos;s
            full raw payload. The single source every other Phoenix module reads from.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {crmTools.map((tool) => {
            const Icon = tool.icon;
            return (
              <Link
                className="inline-flex items-center gap-2 border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-orange-300 hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
                href={tool.href}
                key={tool.href}
                title={tool.description}
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
                {tool.label}
              </Link>
            );
          })}
        </div>
      </div>

      <CrmSyncStatusPanel latestSyncRuns={latestSyncRuns} retiredAt={vendorSyncRetiredAt} />

      <CrmPhoenixTeamStartsPanel data={phoenixTeamStarts} />

      {/* Which of those teams is READY to start, immediately beside the Start button — the decision
          and its evidence in one glance. Read in the same call as the panel above it. */}
      <CrmPhoenixTeamReadinessPanel data={phoenixTeamStarts?.readiness ?? null} />

      <CrmTabBar active={activeTab} />

      {masterTable}
      {derivedView}
    </div>
  );
}
