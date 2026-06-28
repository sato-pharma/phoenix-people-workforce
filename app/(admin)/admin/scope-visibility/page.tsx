import { ScopeVisibilityManager } from "@/components/admin/scope-visibility-manager";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listUserScopeOverrides } from "@/lib/auth/scope-visibility";

export const dynamic = "force-dynamic";

export default async function ScopeVisibilityPage() {
  let initialData = null;
  let initialError: string | null = null;

  try {
    const access = await resolveAccessContextFromPage();
    await assertPermission(access, "admin", "update");
    initialData = await listUserScopeOverrides();
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Scope visibility data failed to load.";
  }

  return (
    <ScopeVisibilityManager
      initialData={initialData}
      initialError={initialError}
    />
  );
}
