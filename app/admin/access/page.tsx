import { AppShell } from "@/components/layout/app-shell";
import { AccessControlManager } from "@/components/admin/access-control-manager";
import { getAccessControlDashboard } from "@/lib/admin/access-control";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AccessControlPage() {
  let initialData = null;
  let initialError: string | null = null;

  try {
    const access = await resolveAccessContextFromPage();
    await assertPermission(access, "admin_access", "read");
    initialData = await getAccessControlDashboard();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Access control failed to load.";
  }

  return (
    <AppShell>
      <AccessControlManager
        initialData={initialData}
        initialError={initialError}
      />
    </AppShell>
  );
}
