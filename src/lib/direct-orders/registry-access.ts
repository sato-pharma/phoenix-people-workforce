import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";

/**
 * Who may manage the direct-order venue registry.
 *
 * Lifted out of `service.ts` on 2026-09-03 so that BOTH the registry itself and the CRM contact
 * picker can ask the same question. It could not stay in `service.ts`: that module already imports
 * `assertVenueContactInScope` from `venue-contact-options.ts`, so having the picker import the gate
 * back out of `service.ts` would close an import cycle. A three-line predicate in its own file is
 * the cheap way out, and it also means there is exactly ONE definition of the registry roles rather
 * than a copy that can drift.
 *
 * Behaviour is unchanged from the original — same roles, same `scope === "system"` bypass, same
 * message string (`isForbiddenError` keys off the `Forbidden:` prefix, so the wording is load
 * bearing and must not be "improved").
 */

/** Who may open the registry and register venues (owner's choice, 2026-08-04). */
export const PHARMACY_REGISTRY_ROLES = new Set<PhoenixRole>(["Super Admin", "SFE Manager"]);

export function canManagePharmacyRegistry(access: AccessContext): boolean {
  return access.scope === "system" || PHARMACY_REGISTRY_ROLES.has(access.role);
}

export function assertPharmacyRegistryAccess(access: AccessContext): void {
  if (!canManagePharmacyRegistry(access)) {
    throw new Error("Forbidden: only a System Admin or the SFE Manager can manage the venue registry.");
  }
}
