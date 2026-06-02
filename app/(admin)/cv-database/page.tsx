import { redirect } from "next/navigation";

import { CvDatabaseManager } from "@/components/cv/cv-database-manager";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function CvDatabasePage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "vacancies", "read")) {
    redirect("/employee-portals");
  }

  return (
    <CvDatabaseManager />
  );
}
