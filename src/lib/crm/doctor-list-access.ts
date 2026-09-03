/**
 * Who may open the Doctor List board, and whose reps they see.
 *
 * WIDENED 2026-08-28 from Super Admin only to the district managers the owner asked for. The note
 * this file carried until then set the condition for widening in plain words: "this stays on one
 * account until the reps-per-manager scope lands with tab two. Widening it is a change here plus a
 * nav entry plus a scope filter in the loader — in that order, and the scope filter is not
 * optional." That scope now exists in `manager-scope.ts`, and `getDoctorListBoard` filters the rep
 * picker through it. All three landed together, which is the only order that is safe.
 *
 * WHY THE SCOPE FILTER IS THE POINT. The fault the owner caught on Doctor Coverage on 2026-08-28 was
 * not that the data was wide — it was that the data was scoped and the PICKER was not, so a medical
 * rep was offered the names of all ~73 reps. A picker is never wider than its viewer. Here the same
 * scope that filters the rows filters the picker, from one call, so the two cannot drift.
 *
 * ## A longer list than the Plans tab, on purpose
 *
 * This board is READ-ONLY: a rep's assigned doctors, as the CRM holds them. The Plans tab beside it
 * carries a button that writes an approval into the customer's CRM. So the Plans tab's role list is
 * deliberately shorter, and the two lists are kept in separate files rather than shared — sharing
 * would grant the write by granting the read, silently, on the next edit.
 *
 * This is the SECOND gate, not the only one. Every entry point also asserts `crm_visits:read`
 * through the permission matrix, which is the actual security boundary — a role list is a fast
 * explicit guard, nothing more.
 */

import { getManagerScope, type CrmManagerScope } from "@/lib/crm/manager-scope";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import {
  canAccessDoctorList,
  doctorListBasisForRole,
  DOCTOR_LIST_ACCESS_ROLES,
  DOCTOR_LIST_PORTAL_ROLES,
  type DoctorListScopeBasis,
} from "@/lib/crm/doctor-list-roles";
import type { AccessContext } from "@/lib/auth/permissions";

/**
 * WHO may open the board now lives in doctor-list-roles.ts, which carries no server-only import so
 * the navigation config and the portal sidebar flag can read the same list this module enforces.
 * Re-exported here so every existing caller and test keeps its import path, and so "where is the
 * role list" has one obvious answer.
 */
export {
  canAccessDoctorList,
  doctorListBasisForRole,
  DOCTOR_LIST_ACCESS_ROLES,
  DOCTOR_LIST_PORTAL_ROLES,
  type DoctorListScopeBasis,
};

export function assertDoctorListAccess(context: Pick<AccessContext, "role" | "scope">): void {
  if (!canAccessDoctorList(context)) {
    throw new Error(`Forbidden: ${context.role} cannot read doctor lists.`);
  }
}

/**
 * Which reps' lists the viewer may see.
 *
 * Passed straight into `getDoctorListBoard`, which uses it for BOTH the rows and the picker.
 *
 * ## A `line` basis is DELEGATED, not reimplemented
 *
 * `manager-scope.ts` answers "which reps report to me", which is the wrong question for a Product
 * Manager — he owns brands, not people, so his reach is his product line and there is no subtree to
 * walk. That walk already exists, once, in `getDoctorCoverageScope`, complete with the multi-line
 * overrides (Ahmed Sharaf covers Pedia and Anti Infective both) and the empty-line handling. A
 * second copy here would be a fourth place that answers "which line is this viewer's", and the
 * copies would diverge on the first override the owner adds.
 *
 * `DoctorCoverageScope` is structurally a `CrmManagerScope` — same three kinds, plus a `basis` tag
 * this board does not read — so the delegation needs no adapter.
 *
 * THE GUARD BELOW FAILS CLOSED, and it is not decoration. The delegate resolves its basis from the
 * COVERAGE role map, not from this board's; today both call Product Manager and Group Product
 * Manager `line`, but nothing in the type system says they must. If that map ever calls one of them
 * `company`, delegating blindly would silently hand a line seat every rep in the company — the
 * widening nobody reviewed. An unexpected answer is refused instead.
 */
export async function getDoctorListScope(access: AccessContext): Promise<CrmManagerScope> {
  const basis = doctorListBasisForRole(access.role);
  if (!basis && access.scope !== "system") {
    return { kind: "none", reason: `Doctor lists are not available to the ${access.role} role.` };
  }

  if (basis === "line") {
    const scope = await getDoctorCoverageScope(access);
    if (scope.kind === "company") {
      return {
        kind: "none",
        reason: `A whole-line scope could not be resolved for the ${access.role} role, so no reps can be shown.`,
      };
    }
    return scope;
  }

  return getManagerScope({
    basis: basis === "team" ? "team" : "company",
    label: basis === "team" ? `${access.role} · own team` : `${access.role} · all reps`,
    viewerHrId: access.hrId,
  });
}
