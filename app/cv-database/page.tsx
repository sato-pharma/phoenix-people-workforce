import { redirect } from "next/navigation";

import { CvDatabaseManager } from "@/components/cv/cv-database-manager";
import { AppShell } from "@/components/layout/app-shell";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function CvDatabasePage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "vacancies", "read")) {
    redirect("/employee-portals");
  }

  return (
    <AppShell navigationMode="admin">
      <CvDatabaseManager />
    </AppShell>
  );
}
