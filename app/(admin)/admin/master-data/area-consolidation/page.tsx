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
        {/*
          nowrap + ellipsis is DESKTOP-ONLY here. Measured at 375px this sentence needs 567px in a
          303px slot, so a phone showed "Move everything off a legacy area onto the…" — the owner's
          rule is never truncate with an ellipsis AND never wrap, and both cannot hold at once for a
          97-character sentence on a phone. The repo's answer (PR #2268) is to wrap on mobile and
          keep one line from md: up, which hides nothing at either size.
        */}
        <p className="max-w-none text-[13px] font-medium leading-6 text-slate-600 md:overflow-hidden md:text-ellipsis md:whitespace-nowrap">
          Move everything off a legacy area onto the area it actually means — after you have read the list.
        </p>
      </div>
      <AreaConsolidationWorkspace />
    </div>
  );
}
