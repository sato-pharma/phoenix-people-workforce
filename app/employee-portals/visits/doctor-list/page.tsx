import { redirect } from "next/navigation";

import { ContactListWorkspace } from "@/components/employee-portal/contact-list-workspace";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertContactListAccess } from "@/lib/crm/contact-lists/service";

export const dynamic = "force-dynamic";

export default async function DoctorListPage() {
  const access = await resolveAccessContextFromPage();
  const allowed = await assertContactListAccess(access).then(
    () => true,
    () => false,
  );
  if (!allowed) redirect("/employee-portals/visits");

  return (
    <EmployeePortalPageShell
      badge="Field Activity"
      description="A rep's AM and PM doctor lists. A rep asks for a change and his manager approves or refuses it."
      title="Doctor List"
    >
      <ContactListWorkspace />
    </EmployeePortalPageShell>
  );
}
