import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { NativeVisitForRepWorkspace } from "@/components/employee-portal/native-visit-for-rep-workspace";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

// The Super Admin enters a visit for a rep and reads every rep's saved visits (the owner, 2026-09-14).
// The employee portal twin is /employee-portals/visits/for-reps.
export default async function AdminVisitEntryPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/visits/for-reps");
  if (!(await canAccess(access, "crm_visit_entry", "update"))) redirect("/admin");

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Visits for Reps"
        description="Enter a visit for a rep on any open day, to any doctor on the rep's list. It saves with no location, marked as entered by the Super Admin, and the rep is told in the app. Below it, every rep's saved visits."
        icon={<ClipboardList className="h-3.5 w-3.5" />}
      />
      <NativeVisitForRepWorkspace />
    </div>
  );
}
