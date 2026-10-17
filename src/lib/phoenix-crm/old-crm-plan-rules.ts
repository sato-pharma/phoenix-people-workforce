/**
 * Phoenix CRM — a rep who still works in the OLD CRM, as the district manager sees his week (owner,
 * 2026-10-17): "if the district manager's reps are still working on the old CRM … their weekly plans on
 * the CRM must appear to the district manager when he is making his weekly plan in Phoenix", and "make
 * sure the district manager can validate the reps' plans — Phoenix CRM and the old CRM."
 *
 * The rules only, with no I/O. The reads are server/manager-old-crm-weeks.ts; the approval is the
 * vendor's own (`crm/plan-verification.ts`, the one write into iReports360), asked here so the Phoenix
 * screen and the admin Plan Verification board can never disagree about what may be pressed.
 *
 * 🔴 THE OLD PLAN CARRIES A DAY PER CONTACT AND NO MORNING OR AFTERNOON — `appm`, `startAM` and `startPM`
 * are empty on every weekly row (measured 2026-10-17, 16,544 rows). A contact is therefore placed by the
 * half of the LIST he sits on, exactly as the rep's own Phoenix plan places him (`halfOfListType`): AM
 * accounts the morning, doctors the afternoon. A contact who is not on the rep's Phoenix list is shown and
 * cannot be ticked; a pharmacy is never planned with a rep (owner, 2026-10-02) and is left out.
 */

import { decidePlanVerification, PLAN_STATUS_AREA_MANAGER_VERIFIED, PLAN_STATUS_NEW, PLAN_STATUS_SUPERVISOR_VERIFIED } from "@/lib/crm/plan-verification";
import { halfOfListType, type ManagerHalf } from "@/lib/phoenix-crm/manager-plan-rules";

/** The vendor's catch-all contact — a bucket for unplanned calls, not a customer (plan-history.ts). */
export const OLD_CRM_CATCH_ALL_CONTACT = 100000;

/** The speciality the vendor prints on a pharmacy. */
function isPharmacySpeciality(speciality: string | null | undefined): boolean {
  return (speciality ?? "").trim().toLowerCase() === "pharmacy";
}

/**
 * The half an old-plan contact is placed in, or null when he is not placed at all.
 *
 * A contact on the rep's Phoenix list goes where that list puts him; a pharmacy there is left out, as the
 * rep's own Phoenix plan leaves it out of the district manager's board. A contact NOT on the list has no
 * list to read, so a pharmacy is left out by his speciality and anyone else is shown in the afternoon,
 * where the doctors sit (plan-history.ts places an unmatched doctor the same way).
 */
export function oldCrmHalfOf(input: { matched: boolean; listType: string | null; speciality: string | null }): ManagerHalf | null {
  if (input.matched) {
    if (input.listType === "Pharmacy") return null;
    return halfOfListType(input.listType);
  }
  if (isPharmacySpeciality(input.speciality)) return null;
  return "PM";
}

/** A planned call of the old plan, as far as choosing the plan needs to know. */
export type OldCrmEntryShape = { crmPlanId: number; status: number | null };

/**
 * The plan a rep's week stands on: the newest plan id with a planned call in the field week. A week that
 * straddles a month end can hold two (265 of 2,388 plans did, measured 2026-08-28), and the newer one is
 * the one the rep last worked on. Its status is the LOWEST its rows carry — the status is constant within
 * a plan (2,388 of 2,388), so this only matters if the vendor ever breaks that, and then a half-approved
 * plan reads as waiting rather than as signed.
 */
export function oldCrmPlanOf<T extends OldCrmEntryShape>(entries: ReadonlyArray<T>): { crmPlanId: number; status: number | null; entries: T[] } | null {
  if (entries.length === 0) return null;
  const crmPlanId = Math.max(...entries.map((entry) => entry.crmPlanId));
  const own = entries.filter((entry) => entry.crmPlanId === crmPlanId);
  const statuses = own.map((entry) => entry.status).filter((status): status is number => typeof status === "number");
  return { crmPlanId, status: statuses.length > 0 ? Math.min(...statuses) : null, entries: own };
}

/** The word on the screen for the old plan's status, in Phoenix's own vocabulary (never "Verified"/"Pending"). */
export function oldCrmStatusLabel(status: number | null | undefined): string {
  if (status === PLAN_STATUS_NEW) return "Waiting for approval";
  if (status === PLAN_STATUS_SUPERVISOR_VERIFIED) return "Approved";
  if (status === PLAN_STATUS_AREA_MANAGER_VERIFIED) return "Approved by an area manager";
  return "Status unknown";
}

/** approve / take back — the two things a district manager does to a rep's old-CRM week. */
export type OldCrmPlanAction = "approve" | "take_back";

export function isOldCrmPlanAction(value: unknown): value is OldCrmPlanAction {
  return value === "approve" || value === "take_back";
}

/** The vendor's name for each direction — "verify" and "unverify" — which is what `decidePlanVerification` speaks. */
export function oldCrmActionToVerification(action: OldCrmPlanAction): "verify" | "unverify" {
  return action === "approve" ? "verify" : "unverify";
}

/** What the screen may offer for a rep's old-CRM week, from the plan's status alone — the vendor's own rule. */
export function oldCrmApprovalOptions(status: number | null): { canApprove: boolean; canTakeBack: boolean } {
  return {
    canApprove: decidePlanVerification({ action: "verify", currentStatus: status }).allowed,
    canTakeBack: decidePlanVerification({ action: "unverify", currentStatus: status }).allowed,
  };
}
