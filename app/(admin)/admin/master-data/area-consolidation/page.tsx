import { redirect } from "next/navigation";

import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canRunAreaConsolidation } from "@/lib/territory-management/area-consolidation";
import { AreaConsolidationWorkspace } from "@/components/territory-management/area-consolidation-workspace";

export const dynamic = "force-dynamic";

/**
 * The Super Admin's own hands on the lever.
 *
 * Owner, 2026-08-22: "I want me to be able to, in the system itself, I check if confirmed, I press
 * the button, and it goes. I don't want you to do any of this critical sensitive work."
 */
export default async function AreaConsolidationPage() {
  const access = await resolveAccessContextFromPage();
  if (!canRunAreaConsolidation(access)) redirect("/admin/master-data");

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Master Data</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Area Consolidation</h1>
        <p className="max-w-none overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium leading-6 text-slate-600">
          Move everything off a legacy area onto the area it actually means — after you have read the list.
        </p>
      </div>
      <AreaConsolidationWorkspace />
    </div>
  );
}
