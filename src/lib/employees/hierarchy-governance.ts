import { sharedIdentityGroups } from "@/lib/auth/identity-aliases";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";

// The CEO reports to nobody, and the system-administrator console accounts sit outside the org
// chart entirely. The latter are expanded from the shared-identity groups so a new console alias
// never re-triggers the "missing manager" governance flag.
const managerOptionalHrIds = new Set(
  ["AA", ...sharedIdentityGroups.flatMap((group) => group.aliasHrIds)]
    .map((hrId) => canonicalHrIdForDisplay(hrId))
    .filter((hrId): hrId is string => Boolean(hrId)),
);

export function normalizeGovernanceHrId(value: string | null | undefined) {
  return canonicalHrIdForDisplay(value) ?? "";
}

export function isManagerOptionalHrId(value: string | null | undefined) {
  return managerOptionalHrIds.has(normalizeGovernanceHrId(value));
}

export function isMissingRequiredManager(input: {
  hrId?: string | null;
  managerHrId?: string | null;
}) {
  return !input.managerHrId && !isManagerOptionalHrId(input.hrId);
}
