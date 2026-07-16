import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Database } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CrmControlPanel } from "@/components/crm/crm-control-panel";
import { crmPageItems } from "@/config/system-navigation";
import { getLatestVisitsSyncRuns } from "@/lib/crm/admin";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function CrmHubPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  // The CRM hub is the single Super-Admin home for all iReports360 data — matching every CRM
  // sub-page (Visits Report, CRM Integrity, Double Visit Data Integrity), which is Super-Admin only.
  if (access.role !== "Super Admin") {
    redirect(resolveLandingPathForRole(access.role));
  }

  const latestRuns = await getLatestVisitsSyncRuns(8);

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="The single source for CRM (iReports360) data — sync health, a manual pull, and every CRM tool in one place."
        eyebrow="CRM"
        icon={<Database className="h-3.5 w-3.5" />}
        title="CRM"
      />

      <CrmControlPanel latestRuns={latestRuns} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {crmPageItems.map((tool) => {
          const Icon = tool.icon;
          return (
            <Link
              className="group relative flex flex-col overflow-hidden border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.07)] transition duration-200 hover:-translate-y-1 hover:border-orange-300/70 hover:shadow-[0_16px_38px_rgba(15,23,42,0.13)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
              href={tool.href}
              key={tool.href}
            >
              <span
                aria-hidden="true"
                className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300 opacity-70 transition-opacity duration-200 group-hover:opacity-100"
              />
              <div className="flex items-start gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-gradient-to-br from-orange-100 to-orange-50 text-orange-700 ring-1 ring-orange-200/70">
                  <Icon aria-hidden="true" className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-bold tracking-[-0.01em] text-slate-950">{tool.label}</h3>
                  <p className="mt-1.5 text-xs leading-5 text-slate-500">{tool.description}</p>
                </div>
              </div>
              <div className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-orange-700">
                Open
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
