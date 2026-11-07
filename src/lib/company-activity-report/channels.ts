/**
 * Whether each employee can be OBSERVED at all through the attendance/CRM systems — independent of
 * whether anything was recorded. This is what makes "no signal available" its own distinct day
 * state from "nothing happened" (see types.ts) — the report must never imply an employee did
 * nothing when the underlying systems simply cannot see them.
 *
 * The CRM channel is a PHOENIX CRM SEAT (owner, 2026-11-07: "ANY SINGLE SOURCE OF FIELD WORK IS NOW
 * THE PHOENIX CRM WIRE IT EVERY WHERE"): the person sits on a territory (REP) or a manager seat
 * (district, acting district, regional, national) in the organogram every Phoenix CRM scope decision
 * reads — `loadPhoenixCrmOrg`, through `ownTerritories` and `heldManagerSeats`, never a raw query. It
 * is no longer an iReports360 username on the employee row: a rep hired straight into Phoenix CRM has
 * none, and read "No Signal" on every silent day although the CRM could see him. The CEO seat is not
 * a CRM channel, exactly as scope.ts never treats it as a district. A seat that is vacant observes
 * nobody, and a pseudo "Others" bucket holds no one.
 *
 * Both readers are CURRENT state — the attendance channel is today's active device mapping, the CRM
 * channel today's organogram — so a leaver who no longer holds a seat reads as unobserved on his own
 * silent pre-exit days; a day with a real visit or punch is still shown as one (reconcile.ts checks
 * those first).
 *
 * The attendance device mapping keys its Set in its own casing; it is re-keyed through
 * canonicalHrIdKey at this module's boundary, and the seat readers normalize any casing themselves,
 * so a caller can pass an hrId as it has it.
 */

import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { heldManagerSeats, ownTerritories, type OrgIndex } from "@/lib/phoenix-crm/scope";
import { loadPhoenixCrmOrg } from "@/lib/phoenix-crm/server/org";

export type CompanyActivityChannels = {
  hasAttendanceChannel: (hrId: string) => boolean;
  hasCrmChannel: (hrId: string) => boolean;
};

/** Pure — the two sources already read, so the channel rule is testable without a database. */
export function buildCompanyActivityChannels(deviceMapped: Iterable<string>, org: OrgIndex): CompanyActivityChannels {
  const deviceCanonical = new Set<string>();
  for (const hrId of deviceMapped) {
    const key = canonicalHrIdKey(hrId);
    if (key) deviceCanonical.add(key);
  }

  return {
    hasAttendanceChannel: (hrId: string) => {
      const key = canonicalHrIdKey(hrId);
      return Boolean(key && deviceCanonical.has(key));
    },
    hasCrmChannel: (hrId: string) => ownTerritories(org, hrId).length > 0 || heldManagerSeats(org, hrId).length > 0,
  };
}

export async function loadCompanyActivityChannels(): Promise<CompanyActivityChannels> {
  const [deviceMapped, org] = await Promise.all([loadActiveDeviceMappedHrIds(), loadPhoenixCrmOrg()]);
  return buildCompanyActivityChannels(deviceMapped, org);
}
