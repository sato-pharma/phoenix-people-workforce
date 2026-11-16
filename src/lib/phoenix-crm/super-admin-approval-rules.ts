/**
 * Phoenix CRM — what the Super Admin approved, only the Super Admin rejects.
 *
 * 🔴 Owner, 2026-11-16: "when super admin approve something sfe or whoever cannot reject it back bec its
 * approved by admin". On 2026-11-15 the SFE Manager refused the administrator's three trusted-point
 * validations on one rep's list for a missing signboard — a trusted point has no photograph by design — and
 * the three doctors went back to To validate.
 *
 * An approval is the Super Admin's when the place's review was decided `approved` by a Super Admin, or when
 * the place itself was created by a Super Admin (a trusted point, a seat he placed); a building is his when
 * a Super Admin approved it. Anybody else may still reject what the SFE Manager or the system approved. The
 * Super Admin himself is never blocked.
 *
 * The database refuses the same thing (`phoenix_crm_is_super_admin`, migration 20261116230741, code
 * `phoenix_crm:approved_by_super_admin`); this file is the screen's and the service's half, so a button that
 * cannot work is never drawn.
 */

/** What the SFE Manager reads where the Reject button would have been, and what the refusal says. */
export const SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT = "The administrator approved this, so only the administrator can take it back.";

/** Normalised as the database normalises an actor: trimmed and upper-case. */
export function hrIdKey(hrId: string | null | undefined): string | null {
  const key = typeof hrId === "string" ? hrId.trim().toUpperCase() : "";
  return key === "" ? null : key;
}

/**
 * Whether this viewer is refused a reject of this approval. `approvedBy` is who decided the review
 * `approved` (null when it is not an approval or nobody decided it); `placeCreatedBy` is who created the place.
 */
export function approvalLockedFor(input: {
  viewerIsSuperAdmin: boolean;
  approvedBy: string | null | undefined;
  placeCreatedBy?: string | null | undefined;
  superAdmins: ReadonlySet<string>;
}): boolean {
  if (input.viewerIsSuperAdmin) return false;
  const approvedBy = hrIdKey(input.approvedBy);
  const createdBy = hrIdKey(input.placeCreatedBy);
  return (approvedBy !== null && input.superAdmins.has(approvedBy)) || (createdBy !== null && input.superAdmins.has(createdBy));
}
