/**
 * Whether each employee can be OBSERVED at all through the attendance/CRM systems — independent of
 * whether anything was recorded. This is what makes "no signal available" its own distinct day
 * state from "nothing happened" (see types.ts) — the report must never imply an employee did
 * nothing when the underlying systems simply cannot see them.
 *
 * Both underlying sources key their own Set/Map in whatever casing their own domain uses
 * (attendance device mapping vs. CRM identity resolution). Rather than reverse-engineer either
 * convention exactly, both are re-keyed through canonicalHrIdKey at this module's boundary — a
 * caller only has to normalize its own hrId the same way to get a correct answer, regardless of
 * what internal casing either source happens to use.
 */

import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { loadCrmIdentityMaps } from "@/lib/crm/identity";
import { canonicalHrIdKey } from "@/lib/hr-id";

export type CompanyActivityChannels = {
  hasAttendanceChannel: (hrId: string) => boolean;
  hasCrmChannel: (hrId: string) => boolean;
};

export async function loadCompanyActivityChannels(): Promise<CompanyActivityChannels> {
  const [deviceMapped, crmMaps] = await Promise.all([
    loadActiveDeviceMappedHrIds(),
    loadCrmIdentityMaps(),
  ]);

  const deviceCanonical = new Set<string>();
  for (const hrId of deviceMapped) {
    const key = canonicalHrIdKey(hrId);
    if (key) deviceCanonical.add(key);
  }

  const crmCanonical = new Set<string>();
  for (const hrId of crmMaps.crmUsernameByHrId.keys()) {
    const key = canonicalHrIdKey(hrId);
    if (key) crmCanonical.add(key);
  }

  return {
    hasAttendanceChannel: (hrId: string) => {
      const key = canonicalHrIdKey(hrId);
      return Boolean(key && deviceCanonical.has(key));
    },
    hasCrmChannel: (hrId: string) => {
      const key = canonicalHrIdKey(hrId);
      return Boolean(key && crmCanonical.has(key));
    },
  };
}
