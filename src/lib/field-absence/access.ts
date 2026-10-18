/**
 * Field Absence Calendar — who may open it, and how far each viewer reaches.
 *
 * The owner, 2026-10-18: *"appears for admin and national sales managers and SFE and CEO."* Four
 * roles, named here and nowhere else, ON TOP OF the `field_absence:read` grant — the matrix is the
 * security boundary, and this list stops an override that widens the grant from reaching anyone the
 * owner did not name. The page names people who logged nothing on a day, so a rep or a district
 * manager must never see it (Phoenix CRM's Golden Rule #1: the rep never sees anything that judges him).
 *
 * 🔒 AN NSM SEES ONLY HIS OWN LINE (owner, 2026-09-20, `.claude/rules/crm.md`). His line is the line
 * of the NSM seat he holds in the EU organogram; a National Sales Manager who holds no NSM seat
 * reaches NOTHING, never the whole company.
 */

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";

export const FIELD_ABSENCE_ROLES: readonly PhoenixRole[] = ["Super Admin", "CEO", "National Sales Manager", "SFE Manager"];

/** The roles that read every line. */
const COMPANY_ROLES: readonly PhoenixRole[] = ["Super Admin", "CEO", "SFE Manager"];

export function canReadFieldAbsence(access: Pick<AccessContext, "role">): boolean {
  return FIELD_ABSENCE_ROLES.includes(access.role);
}

export type FieldAbsenceScope =
  | { basis: "company" }
  | { basis: "line"; lineCodes: string[] }
  | { basis: "none" };

/** A seat as the scope needs it: its tier, its line and who holds it today. */
export type FieldAbsenceScopeSeat = {
  tier: string;
  lineCode: string | null;
  occupantHrId: string | null;
};

export function resolveFieldAbsenceScope(
  access: Pick<AccessContext, "hrId" | "role">,
  seats: readonly FieldAbsenceScopeSeat[],
): FieldAbsenceScope {
  if (COMPANY_ROLES.includes(access.role)) return { basis: "company" };
  if (access.role !== "National Sales Manager") return { basis: "none" };
  const viewer = canonicalHrIdKey(access.hrId);
  if (!viewer) return { basis: "none" };
  const lineCodes = [
    ...new Set(
      seats
        .filter((seat) => seat.tier === "NSM" && seat.lineCode && canonicalHrIdKey(seat.occupantHrId) === viewer)
        .map((seat) => seat.lineCode as string),
    ),
  ];
  return lineCodes.length > 0 ? { basis: "line", lineCodes } : { basis: "none" };
}

/** Whether a seat on `lineCode` is inside the scope. */
export function scopeAdmitsLine(scope: FieldAbsenceScope, lineCode: string | null): boolean {
  if (scope.basis === "company") return true;
  if (scope.basis === "none") return false;
  return lineCode !== null && scope.lineCodes.includes(lineCode);
}
