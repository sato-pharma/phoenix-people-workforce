import { ModulesControlManager } from "@/components/admin/modules-control-manager";
import { getModuleControlDashboard, type ModuleControlDashboard } from "@/lib/admin/modules-control";
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
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export default async function ModulesControlPage() {
  let canManage = false;
  let initialData: ModuleControlDashboard | null = null;
  let initialError: string | null = null;

  try {
    const access = await resolveAuthenticatedPageAccess();
    canManage = access.role === "Super Admin" && await canAccess(access, "module_control", "update");
    await assertPermission(access, "module_control", "read");
    if (access.role !== "Super Admin") {
      throw new Error("Forbidden: only Super Admin can use Modules Control.");
    }
    initialData = await withTimeout(getModuleControlDashboard(), 12000);
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Modules Control failed to load.";
  }

  return (
    <ModulesControlManager
      canManage={canManage}
      initialData={initialData}
      initialError={initialError}
    />
  );
}
