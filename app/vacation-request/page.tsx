import { redirect } from "next/navigation";

import { AppShell } from "@/components/layout/app-shell";
import { VacationRequestModule } from "@/components/leave/vacation-request";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function VacationRequestPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "admin", "read")) {
    redirect("/employee-portals");
  }

  return (
    <AppShell navigationMode="admin">
      <VacationRequestModule />
    </AppShell>
  );
}
