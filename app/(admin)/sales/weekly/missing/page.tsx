import { redirect } from "next/navigation";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadMissingAdmin } from "@/lib/sales/weekly/missing";
import { WeeklyMissingPanel } from "@/components/sales/weekly/weekly-missing-panel";

export const dynamic = "force-dynamic";

export default async function WeeklyMissingPage() {
  const access = await resolveAccessContextFromPage();
  if (!access) redirect("/login");

  try {
    await assertPermission(access, "weekly_sales", "update");
  } catch {
    redirect("/sales/weekly");
  }

  const data = await loadMissingAdmin();

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="rounded-[6px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">
          <span className="h-2 w-2 rounded-full bg-[#F97316]" />
          Weekly Sales
        </div>
        <h1 className="text-xl font-black text-[#0F172A]">Weekly Missing Data</h1>
        <p className="mt-1 text-sm font-medium text-[#64748B]">
          Raw labels from uploaded files that the mapping doesn&apos;t recognise yet. Pick a distributor,{" "}
          <strong>Download Missing Sheet</strong>, fill the official Product / Region code next to each one, then{" "}
          <strong>Upload</strong>. Each label drops off this list once mapped — re-upload the raw file and it imports
          normally.
        </p>
      </header>

      <WeeklyMissingPanel initialData={data} />
    </div>
  );
}
