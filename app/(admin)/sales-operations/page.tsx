import Link from "next/link";
import { redirect } from "next/navigation";

import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { SALES_OPS_ROUTES } from "@/lib/sales-operations/routes";

export const dynamic = "force-dynamic";

// Placeholder dashboard. The rollup-backed dashboard (KPIs / trend / area×product / Office) reads the
// sales_ops rollup tables and is built in the next phase; this shows once an upload is committed.
export default async function SalesOpsDashboardPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  try {
    await assertPermission(accessContext, "sales", "read");
  } catch {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-lg font-black uppercase tracking-[0.08em] text-[#0F172A]">Sales Operations · Dashboard</h1>
        <p className="text-sm text-[#64748B]">Reads the pre-aggregated rollups (no live fact-row scans) for fast loads at scale.</p>
      </header>
      <div className="border border-[#D8E0EA] bg-white p-6 text-sm text-[#475569]">
        <p className="font-semibold text-[#0F172A]">Dashboard is being built (next step).</p>
        <p className="mt-1">The KPI strip, trend, rankings, area×product matrix and Office breakdown will populate from the rollup snapshot once the first distributor upload is committed.</p>
        <p className="mt-3">
          Start by{" "}
          <Link href={SALES_OPS_ROUTES.upload} className="font-semibold text-[#F97316] underline">uploading a distributor sheet</Link>{" "}
          or reviewing the{" "}
          <Link href={SALES_OPS_ROUTES.mapping} className="font-semibold text-[#F97316] underline">distributor mappings</Link>.
        </p>
      </div>
    </div>
  );
}
