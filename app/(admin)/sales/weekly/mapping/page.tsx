import { redirect } from "next/navigation";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadMappingAdmin } from "@/lib/sales/weekly/mapping";
import { WeeklyMappingPanel } from "@/components/sales/weekly/weekly-mapping-panel";

export const dynamic = "force-dynamic";

export default async function WeeklyMappingPage() {
  const access = await resolveAccessContextFromPage();
  if (!access) redirect("/login");

  try {
    await assertPermission(access, "weekly_sales", "update");
  } catch {
    redirect("/sales/weekly");
  }

  const data = await loadMappingAdmin();

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="rounded-[6px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">
          <span className="h-2 w-2 rounded-full bg-[#F97316]" />
          Weekly Sales
        </div>
        <h1 className="text-xl font-black text-[#0F172A]">Weekly Mapping</h1>
        <p className="mt-1 text-sm font-medium text-[#64748B]">
          Teach the system how each distributor&apos;s raw weekly file translates to official Phoenix codes — once.
          Pick a distributor, <strong>Download Mapping</strong>, fill the official Product / Region code next to each
          raw value, then <strong>Upload Mapping</strong>. After that, you can upload that distributor&apos;s raw file
          directly with no manual coding.
        </p>
      </header>

      <WeeklyMappingPanel initialData={data} />
    </div>
  );
}
