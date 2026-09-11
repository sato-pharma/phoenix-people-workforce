import { Users } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DistributionListsCenter } from "@/components/admin/distribution-lists-center";
import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getCompanyEmailAliasesWithDrift,
  getDistributionListSpecs,
  resolveAllDistributionLists,
} from "@/lib/distribution-lists/service";

// Distribution Lists — one named audience Phoenix resolves from the live directory at send time,
// beside a register of the company aliases that live on Turbify.
//
// Super Admin only, matching /admin/notification-recipients: editing a list changes who receives
// company mail, which is routing plumbing rather than something the CEO has an oversight story for.
//
// This screen sends NOTHING. It decides who an existing email would reach and, for an alias, what
// somebody must change by hand in a control panel Phoenix cannot reach.

export const dynamic = "force-dynamic";

export default async function DistributionListsPage() {
  const access = await resolveAccessContextFromPage();

  if (!canAccessSystemAdministratorWorkspace(access)) {
    redirect("/admin");
  }

  // The deploy reaches production before the migration does, and a missing table answers PGRST205
  // rather than 42P01 — so a page that let this throw would 500 for the whole window. Empty state
  // says so plainly instead of rendering a confident, wrong "no lists".
  let lists: Awaited<ReturnType<typeof resolveAllDistributionLists>> = [];
  let specs: Awaited<ReturnType<typeof getDistributionListSpecs>> = [];
  let aliases: Awaited<ReturnType<typeof getCompanyEmailAliasesWithDrift>>["aliases"] = [];
  let loadError: string | null = null;

  try {
    const [loadedSpecs, loadedLists, loadedAliases] = await Promise.all([
      getDistributionListSpecs(),
      resolveAllDistributionLists(),
      getCompanyEmailAliasesWithDrift(),
    ]);
    specs = loadedSpecs;
    lists = loadedLists;
    aliases = loadedAliases.aliases;
  } catch (error) {
    loadError = error instanceof Error ? error.message : "Distribution lists could not be loaded.";
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-phx-line bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
        <AdminPageHero
          description="Named recipient groups resolved from the live employee directory, plus the register of company email aliases on Turbify. Editing a list changes who future emails reach — nothing on this page sends mail. Super Admin only."
          eyebrow="Email routing"
          icon={<Users className="h-3.5 w-3.5" />}
          title="Distribution Lists"
        />

        {loadError ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm font-semibold text-amber-900">
            Distribution lists are not readable yet: {loadError}
            <span className="mt-1 block font-normal">
              If this deploy landed before its migration, the tables appear once the migration is applied.
            </span>
          </div>
        ) : (
          <DistributionListsCenter initialAliases={aliases} initialLists={lists} initialSpecs={specs} />
        )}
      </div>
    </div>
  );
}
