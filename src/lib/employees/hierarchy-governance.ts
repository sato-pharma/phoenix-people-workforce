import { canonicalHrIdForDisplay } from "@/lib/hr-id";

const managerOptionalHrIds = new Set(["AA", "ADMIN-HR"]);

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
