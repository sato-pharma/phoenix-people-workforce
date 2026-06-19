import { redirect } from "next/navigation";

import { SalesOpsUploadWorkspace } from "@/components/sales-operations/sales-ops-upload-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listDistributorTemplates } from "@/lib/sales-operations/dictionary";

export const dynamic = "force-dynamic";

export default async function SalesOpsUploadPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  try {
    await assertPermission(accessContext, "sales", "import");
  } catch {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  const distributors = listDistributorTemplates().map((t) => ({ code: t.code, name: t.name }));

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-lg font-black uppercase tracking-[0.08em] text-[#0F172A]">Sales Operations · Upload</h1>
        <p className="text-sm text-[#64748B]">Analyze a raw distributor sheet, review the strict validation, then import. Re-uploading a month replaces it (no double-count).</p>
      </header>
      <SalesOpsUploadWorkspace distributors={distributors} />
    </div>
  );
}
