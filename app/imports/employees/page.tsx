import { AppShell } from "@/components/layout/app-shell";
import { EmployeeImportUpload } from "@/components/imports/employee-import-upload";
import { redirect } from "next/navigation";

import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export default async function EmployeeImportPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "imports", "read")) {
    redirect("/employee-portals");
  }
  return (
    <AppShell navigationMode="admin">
      <EmployeeImportUpload />
    </AppShell>
  );
}
