/**
 * Who may use Pharmacy Search.
 *
 * Owner decision, 2026-08-21: the same bar as the Customers Database hub — the page exposes the
 * customer directory, distributor codes and sales history, which is exactly what that hub already
 * gates. No new permission resource is introduced; `sales:import` or a system-scoped role is it.
 *
 * Server-side only. The sidebar hiding a link is UX; THIS is the security boundary.
 */

import { canAccess, type AccessContext } from "@/lib/auth/permissions";

export class PharmacySearchAccessError extends Error {
  constructor() {
    super("You do not have access to Pharmacy Search.");
    this.name = "PharmacySearchAccessError";
  }
}

export async function canAccessPharmacySearch(access: AccessContext): Promise<boolean> {
  if (access.role === "Super Admin" || access.role === "CEO") return true;
  return await canAccess(access, "sales", "import");
}

/** Throws `PharmacySearchAccessError` when the caller may not read pharmacy data. */
export async function assertPharmacySearchAccess(access: AccessContext): Promise<void> {
  if (!(await canAccessPharmacySearch(access))) {
    throw new PharmacySearchAccessError();
  }
}
