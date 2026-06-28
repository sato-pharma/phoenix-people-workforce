import { ScopeVisibilityManager } from "@/components/admin/scope-visibility-manager";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import type { ProductOption } from "@/lib/auth/scope-visibility";
import { listProducts, listUserScopeOverrides } from "@/lib/auth/scope-visibility";

export const dynamic = "force-dynamic";

export default async function ScopeVisibilityPage() {
  let initialData = null;
  let initialError: string | null = null;
  let initialProducts: ProductOption[] = [];

  try {
    const access = await resolveAccessContextFromPage();
    await assertPermission(access, "admin", "update");
    const [overrides, products] = await Promise.all([listUserScopeOverrides(), listProducts()]);
    initialData = overrides;
    initialProducts = products;
  } catch (error) {
    initialError = error instanceof Error ? error.message : "Scope visibility data failed to load.";
  }

  return (
    <ScopeVisibilityManager
      initialData={initialData}
      initialError={initialError}
      initialProducts={initialProducts}
    />
  );
}
