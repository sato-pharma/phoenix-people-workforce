import { BrickReferenceUpload } from "@/components/imports/brick-reference-upload";
import { AppShell } from "@/components/layout/app-shell";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export default async function BrickReferenceImportPage() {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "imports", "read");

  return (
    <AppShell>
      <BrickReferenceUpload />
    </AppShell>
  );
}
