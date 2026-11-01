import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { Suspense, type ReactNode } from "react";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { IncidentsWorkspace, type IncidentsInitial } from "@/components/admin/system-audit/incidents-workspace";
import { IntegrityChecks } from "@/components/admin/system-audit/integrity-checks";
import { LoginSecuritySection } from "@/components/admin/system-audit/login-security-section";
import { RoleCoverageSection } from "@/components/admin/system-audit/role-coverage-section";
import { SalaryFlagsSection } from "@/components/admin/system-audit/salary-flags-section";
import { SlowPagesSection } from "@/components/admin/system-audit/slow-pages-section";
import { AppRouteLoadingState } from "@/components/ui/loading-state";
import type { IntegrityOverview } from "@/lib/system-audit/integrity-runs";

/**
 * /admin/system-audit — the System Error & Data Integrity Audit, Super Admin only.
 *
 * Six tabs, the active one in `?tab=`: Incidents (the 11-column ledger, default), Integrity checks
 * (the stored nightly reconciliation), the three sections moved here from the retired dashboards —
 * Login security, Salary flags, Role coverage — and, since 1 Nov 2026, Slowest pages (what the
 * browsers reported this week, from the page_timings table). Only the active tab is rendered, so
 * opening the page reads only what that tab needs. Nothing refreshes on a timer.
 *
 * A server component: the sections load their own data on the server, and each is rendered here
 * inside its own <Suspense> so a slow one never holds the tab bar.
 */

export const SYSTEM_AUDIT_TABS = [
  { key: "incidents", label: "Incidents" },
  { key: "integrity", label: "Integrity checks" },
  { key: "login-security", label: "Login security" },
  { key: "salary-flags", label: "Salary flags" },
  { key: "role-coverage", label: "Role coverage" },
  { key: "slow-pages", label: "Slowest pages" },
] as const;

export type SystemAuditTab = (typeof SYSTEM_AUDIT_TABS)[number]["key"];

export function parseSystemAuditTab(value: string | string[] | undefined): SystemAuditTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return (SYSTEM_AUDIT_TABS.find((tab) => tab.key === raw)?.key ?? "incidents") as SystemAuditTab;
}

function TabBar({ active }: { active: SystemAuditTab }) {
  return (
    <nav aria-label="System audit sections" className="flex flex-wrap gap-1 border-b border-slate-200 pb-px">
      {SYSTEM_AUDIT_TABS.map((tab) => {
        const selected = tab.key === active;
        return (
          <Link
            aria-current={selected ? "page" : undefined}
            className={[
              "px-3 py-2 text-phx-xs font-black uppercase tracking-[0.08em] transition",
              selected ? "border border-b-0 border-slate-200 bg-white text-orange-600" : "text-slate-500 hover:text-slate-800",
            ].join(" ")}
            href={tab.key === "incidents" ? "/admin/system-audit" : `/admin/system-audit?tab=${tab.key}`}
            key={tab.key}
            prefetch={false}
            scroll={false}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

function SectionFallback({ title }: { title: string }) {
  return <AppRouteLoadingState description="Reading the live data for this section." title={title} />;
}

function IntegrityTab({ overview, error }: { overview: IntegrityOverview | null; error: string | null }) {
  if (!overview) {
    return (
      <AdminCallout tone="danger">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="break-words">Unavailable — {error ?? "the integrity runs could not be read."}</p>
      </AdminCallout>
    );
  }
  return <IntegrityChecks overview={overview} />;
}

export function SystemAuditPage({
  activeTab,
  incidents,
  integrity,
}: {
  activeTab: SystemAuditTab;
  /** Present when the Incidents tab is active: the server-read first page. */
  incidents?: IncidentsInitial;
  /** Present when the Integrity checks tab is active. */
  integrity?: { overview: IntegrityOverview | null; error: string | null };
}) {
  let body: ReactNode = null;
  if (activeTab === "incidents" && incidents) {
    body = <IncidentsWorkspace initial={incidents} />;
  } else if (activeTab === "integrity") {
    body = <IntegrityTab error={integrity?.error ?? null} overview={integrity?.overview ?? null} />;
  } else if (activeTab === "login-security") {
    // The Login security section, moved from System Issues and Monitoring; it loads its own data.
    body = (
      <Suspense fallback={<SectionFallback title="Loading login security" />}>
        <LoginSecuritySection />
      </Suspense>
    );
  } else if (activeTab === "salary-flags") {
    // The Salary flags section, moved from Data Health; it loads its own data.
    body = (
      <Suspense fallback={<SectionFallback title="Loading salary flags" />}>
        <SalaryFlagsSection />
      </Suspense>
    );
  } else if (activeTab === "role-coverage") {
    // The Role coverage section, moved intact from Data Health.
    body = (
      <Suspense fallback={<SectionFallback title="Loading role coverage" />}>
        <RoleCoverageSection />
      </Suspense>
    );
  } else if (activeTab === "slow-pages") {
    // The Slowest pages section: the week's page timings as the browsers reported them, nobody in them.
    body = (
      <Suspense fallback={<SectionFallback title="Loading the slowest pages" />}>
        <SlowPagesSection />
      </Suspense>
    );
  }

  return (
    <div className="min-w-0 space-y-5">
      <AdminPageHero
        description="Every error a person saw and every silent data inconsistency, with who it hit, the exact sidebar module, the Cairo time, why it happened and whether the fix is verified."
        eyebrow="System Administration"
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
        title="System Error & Data Integrity Audit"
      />
      <TabBar active={activeTab} />
      <div className="min-w-0">{body}</div>
    </div>
  );
}
