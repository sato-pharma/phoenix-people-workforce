import { redirect } from "next/navigation";

import { PharmacyMasterWorkspace } from "@/components/pharmacy-master/pharmacy-master-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessPharmacyMaster } from "@/lib/pharmacy-master/pharmacy-matching";

export const dynamic = "force-dynamic";

// Standalone, read-only Phase 1 candidate-review report — detects pharmacies that may be the
// same physical location recorded separately under different distributors. Suggestion-only:
// no merge, no auto-create, no approve/reject action anywhere on this page.
export default async function PharmacyMasterPage() {
  const access = await resolveAccessContextFromPage();
  if (!canAccessPharmacyMaster(access)) {
    redirect("/");
  }

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Master Data</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Pharmacy Master</h1>
        <p className="max-w-3xl text-[13px] font-medium leading-6 text-slate-600">
          Read-only candidate review: pharmacies that may be the same physical location, recorded
          separately under different distributors. Nothing here merges, creates, or changes any
          record — every candidate needs human review before any action is taken.
        </p>
      </div>
      <PharmacyMasterWorkspace />
    </div>
  );
}
