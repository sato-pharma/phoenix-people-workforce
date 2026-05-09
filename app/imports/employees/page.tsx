import { AppShell } from "@/components/layout/app-shell";
import { EmployeeImportUpload } from "@/components/imports/employee-import-upload";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export default async function EmployeeImportPage() {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "imports", "read");
  return (
    <AppShell>
      <EmployeeImportUpload />
    </AppShell>
  );
}
