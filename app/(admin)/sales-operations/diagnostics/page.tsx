import { redirect } from "next/navigation";

import { SalesOpsUploadWorkspace } from "@/components/sales-operations/sales-ops-upload-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listDistributorTemplates } from "@/lib/sales-operations/dictionary";

export const dynamic = "force-dynamic";

export default async function SalesOpsDiagnosticsPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }
  await assertPermission(accessContext, "sales", "import");

  const distributors = listDistributorTemplates().map((t) => ({ code: t.code, name: t.name, hasDateColumn: t.hasDateColumn }));

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-lg font-black uppercase tracking-[0.08em] text-[#0F172A]">Sales Operations · Diagnostics</h1>
        <p className="text-sm text-[#64748B]">Dry-run any distributor sheet — recognition, coding, and the full strict validation report — without importing anything.</p>
      </header>
      <SalesOpsUploadWorkspace distributors={distributors} diagnosticsOnly />
    </div>
  );
}
