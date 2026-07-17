import { redirect } from "next/navigation";

import { type AccessContext } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isGuestFallbackAccess } from "@/lib/auth/page-access-guard";

export { isGuestFallbackAccess };

/**
 * Page-only wrapper around resolveAccessContextFromPage that redirects an expired/guest session
 * to /login before the caller asserts a permission. Prevents the misleading
 * "Forbidden: Employee cannot read X" + broken render when a session lapses between the
 * layout's auth check and this page's (client-navigated) render.
 */
export async function resolveAuthenticatedPageAccess(): Promise<AccessContext> {
  const access = await resolveAccessContextFromPage();
  if (isGuestFallbackAccess(access)) {
    redirect("/login");
  }
  return access;
}
