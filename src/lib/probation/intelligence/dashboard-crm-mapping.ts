// Probation dashboard CRM-mapping classifier (Enhancement E6).
//
// A probation rep whose hr_id never appears as `agent_hr_id` in `ireports360_visits` has a CRM
// identity-mapping gap: they earn ZERO Double-Visit credit not because managers skipped them, but
// because the CRM feed can't be tied to them. That must be surfaced as a data problem (a badge), not
// misread as poor performance. This module is the pure classifier so it can be unit-tested without a DB.

import { canonicalHrIdKey } from "@/lib/hr-id";

// Build the set of canonical hr-id keys that DO appear as CRM agents.
export function buildMappedAgentKeySet(mappedAgentHrIds: Array<string | null | undefined>): Set<string> {
  const set = new Set<string>();
  for (const raw of mappedAgentHrIds) {
    const key = canonicalHrIdKey(raw);
    if (key) set.add(key);
  }
  return set;
}

// A case employee is CRM-unmapped when their canonical hr-id key is absent from the mapped-agent set.
export function isCrmUnmapped(employeeHrId: string | null | undefined, mappedAgentKeys: Set<string>): boolean {
  const key = canonicalHrIdKey(employeeHrId);
  if (!key) return true; // no resolvable hr-id at all is itself a mapping gap
  return !mappedAgentKeys.has(key);
}
