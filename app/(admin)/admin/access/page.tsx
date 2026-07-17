import { AccessControlManager } from "@/components/admin/access-control-manager";
import { getAccessControlDashboard } from "@/lib/admin/access-control";
import { assertPermission, canAccess } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";

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
  let capabilities = {
    canBulkImportUsers: false,
    canManagePermissions: false,
    canManageUsers: false,
    canReadUsers: false,
  };
  let initialData = null;
  let initialError: string | null = null;

  try {
    const access = await resolveAuthenticatedPageAccess();
    const [canReadUsers, canManageUsers, canImportUsers, canManagePermissions] = await Promise.all([
      canAccess(access, "user_admin", "read"),
      canAccess(access, "user_admin", "update"),
      canAccess(access, "imports", "import"),
      canAccess(access, "permission_admin", "update"),
    ]);
    capabilities = {
      canBulkImportUsers: canImportUsers && canManageUsers,
      canManagePermissions: access.role === "Super Admin" && canManagePermissions,
      canManageUsers,
      canReadUsers,
    };
    await assertPermission(access, "admin_access", "read");
    initialData = await withTimeout(getAccessControlDashboard(), 12000);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Access control failed to load.";
  }

  return (
    <AccessControlManager
      capabilities={capabilities}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
