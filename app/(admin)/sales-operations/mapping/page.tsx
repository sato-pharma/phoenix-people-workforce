import { redirect } from "next/navigation";

import { SalesOpsMappingEditor } from "@/components/sales-operations/sales-ops-mapping-editor";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function SalesOpsMappingPage() {
  const accessContext = await resolveAccessContextFromPage();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect("/employee-portals/sales");
  }
  // Mapping authority — Super Admin / system only, matching the other admin mapping surfaces.
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }
  await assertPermission(accessContext, "sales", "import");

  return (
    <div className="space-y-4 p-4">
      <header>
        <h1 className="text-lg font-black uppercase tracking-[0.08em] text-[#0F172A]">Sales Operations · Distributor Mapping</h1>
        <p className="text-sm text-[#64748B]">The unified header map per distributor. Product resolves by NAME first; the brick is looked up per column L. Changes take effect on the next upload.</p>
      </header>
      <SalesOpsMappingEditor />
    </div>
  );
}
