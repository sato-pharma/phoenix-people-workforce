import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, ArrowRight, Hourglass, LayoutDashboard, ListChecks } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

const probationModules = [
  { href: "/probation", icon: ListChecks, label: "Probation Tracker", description: "Review every employee currently inside the probation window and open the full record." },
  { href: "/probation/dashboard", icon: LayoutDashboard, label: "Decision Dashboard", description: "See active cases, risk zones, and the probation decisions that need attention first." },
  { href: "/probation/analytics", icon: Activity, label: "Probation Analytics", description: "Review historical outcomes and the signals behind probation decisions." },
] as const;

export default async function CeoProbationPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  if (access.role !== "CEO" && access.role !== "Super Admin") redirect("/admin");
  if (!(await canAccess(access, "probation", "read"))) redirect("/employee-portals");

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="One executive entry point for the probation tracker, decision view, and historical outcomes."
        eyebrow="People Risk"
        icon={<Hourglass className="h-3.5 w-3.5" />}
        title="Probation"
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {probationModules.map((module) => {
          const Icon = module.icon;
          return (
            <Link
              className="group relative flex min-h-48 flex-col overflow-hidden border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.07)] transition duration-200 hover:-translate-y-1 hover:border-orange-300/70 hover:shadow-[0_16px_38px_rgba(15,23,42,0.13)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
              href={module.href}
              key={module.href}
            >
              <span aria-hidden="true" className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300 opacity-70 transition-opacity duration-200 group-hover:opacity-100" />
              <span className="flex h-11 w-11 items-center justify-center bg-orange-50 text-orange-700 ring-1 ring-orange-200/70">
                <Icon aria-hidden="true" className="h-5 w-5" />
              </span>
              <h2 className="mt-4 text-sm font-bold tracking-[-0.01em] text-slate-950">{module.label}</h2>
              <p className="mt-2 text-xs leading-5 text-slate-500">{module.description}</p>
              <span className="mt-auto inline-flex items-center gap-1 pt-5 text-xs font-bold text-orange-700">
                Open module
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
