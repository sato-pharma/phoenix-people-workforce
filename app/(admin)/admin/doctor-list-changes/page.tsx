import { redirect } from "next/navigation";
import { ListChecks } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { ContactListWorkspace } from "@/components/employee-portal/contact-list-workspace";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertContactListAccess } from "@/lib/crm/contact-lists/service";

export const dynamic = "force-dynamic";

// Doctor lists maintained in Phoenix (CRM phase 7). The SFE Manager and the administrator change a
// rep's list directly on the admin shell; reps ask and managers answer on the employee portal twin at
// /employee-portals/visits/doctor-list.
export default async function AdminDoctorListChangesPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/visits/doctor-list");
  const allowed = await assertContactListAccess(access).then(
    () => true,
    () => false,
  );
  if (!allowed) redirect("/admin");

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Doctor List Changes"
        description="Add a doctor to a rep's AM or PM list, remove one or change a grade. Your change applies at once; a rep's own request waits for his manager."
        icon={<ListChecks className="h-3.5 w-3.5" />}
      />
      <ContactListWorkspace />
    </div>
  );
}
