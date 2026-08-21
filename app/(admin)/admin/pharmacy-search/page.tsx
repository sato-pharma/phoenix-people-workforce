import { Search } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { PharmacySearchWorkspace } from "@/components/pharmacy-search/pharmacy-search-workspace";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canAccessPharmacySearch } from "@/lib/pharmacy-search/access";

export const dynamic = "force-dynamic";

// One search box over every pharmacy Phoenix holds — by name, by a distributor's own code for it,
// or by distributor. When nothing matches, the same box falls through to Google Maps and snaps the
// result back onto a Phoenix brick. The page gate mirrors the Customers Database hub exactly
// (owner decision, 2026-08-21); the API routes assert it again, which is the real boundary.
export default async function PharmacySearchPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals");
  if (!(await canAccessPharmacySearch(access))) redirect("/employee-portals");

  return (
    <div className="space-y-6">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>Brick · Area · Region</AdminInsightChip>
            <AdminInsightChip>Distributor codes</AdminInsightChip>
            <AdminInsightChip tone="orange">Doctors nearby with speciality</AdminInsightChip>
            <AdminInsightChip tone="slate">Google fallback</AdminInsightChip>
          </>
        )}
        description="Type a pharmacy name, a distributor, or any code. Everything the database holds appears — and when it holds nothing, Google Maps is searched and the result is placed on a Phoenix brick."
        eyebrow="Master Data"
        icon={<Search className="h-3.5 w-3.5" />}
        title="Pharmacy Search"
      />
      <PharmacySearchWorkspace />
    </div>
  );
}
