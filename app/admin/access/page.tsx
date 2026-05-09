import { AppShell } from "@/components/layout/app-shell";
import { AccessControlManager } from "@/components/admin/access-control-manager";
import { getAccessControlDashboard } from "@/lib/admin/access-control";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

async function withTimeout<T>(value: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Request timed out. Please refresh and try again."));
    }, timeoutMs);
  });

  try {
    return await Promise.race([value, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export default async function AccessControlPage() {
  let initialData = null;
  let initialError: string | null = null;

  try {
    const access = await resolveAccessContextFromPage();
    await assertPermission(access, "admin_access", "read");
    initialData = await withTimeout(getAccessControlDashboard(), 12000);
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
