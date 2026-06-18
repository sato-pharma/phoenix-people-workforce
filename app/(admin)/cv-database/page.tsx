import { redirect } from "next/navigation";

import { CvDatabaseManager } from "@/components/cv/cv-database-manager";
import { canAccess, isHrAuthorityRole } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function CvDatabasePage() {
  const access = await resolveAccessContextFromPage();
  if (!isHrAuthorityRole(access.role) || !await canAccess(access, "vacancies", "read")) {
    redirect("/employee-portals");
  }

  return (
    <CvDatabaseManager />
  );
}
