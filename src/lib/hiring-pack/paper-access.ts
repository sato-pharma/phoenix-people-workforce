// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHO MAY USE THE HR FORMS, AND WHICH PAPERS — the one server-side answer for every hiring-pack
// route and both HR Forms pages.
//
// Two kinds of viewer reach these screens:
//
//   - Everyone who did before: an HR authority seat holding `employee_documents` (HR Operations,
//     the Super Admin). Nothing about them changes — every helper below falls through to the exact
//     `employee_documents` check the routes made before this file existed.
//
//   - A seat named in SEAT_PRINTABLE_DOCUMENTS (document-registry.ts). Today that is the HR
//     Operations Specialist (`HR Administration`, owner, 2026-10-20): she prepares the contract
//     renewal and follows a resignation through to the clearance, so she prints exactly those
//     papers. She is outside `hrAuthorityRoles`, which strips employee_documents from her on
//     purpose, so the key cannot be her door. Her door is the business grant each paper belongs to
//     — `contracts` for the renewal pair, `resignations` for the leaving papers — which the
//     access-control screen can still take away from her like any other grant.
//
// AND SHE IS SALARY-BLIND (`isSalaryBlindRole`). The pack these routes return carries the base
// salary, the gross and the insurance wage; `packForViewer` blanks all three for her, and
// `factsInputForViewer` drops a salary she might send. The one money exception the owner made is
// the renewal annex itself, which prints the salary — and that is rendered on the server from the
// full record, never from what her browser holds.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import {
  assertPermission,
  canAccess,
  isHrAuthorityRole,
  type AccessContext,
  type PermissionResource,
} from "@/lib/auth/permissions";
import { isPaperOpenToRole, seatPapersFor } from "@/lib/hiring-pack/document-registry";
import type { PaperIssue } from "@/lib/hiring-pack/paper-register-store";
import {
  isBuiltInDocument,
  type HiringPackData,
  type HiringPackDocument,
  type HiringPackEmployeeFactsInput,
} from "@/lib/hiring-pack/types";

type FormsAction = "read" | "update";

/**
 * The business grant a seat's paper rides on. A paper a seat lists but this table does not map is
 * refused — the safe direction for a table someone extended in one place and not the other.
 */
const SEAT_PAPER_RESOURCE: Readonly<Partial<Record<HiringPackDocument, PermissionResource>>> = {
  contractRenewal: "contracts",
  contractNonRenewal: "contracts",
  resignation: "resignations",
  mutualTermination: "resignations",
  deemedResignation: "resignations",
  clearanceEmployee: "resignations",
  clearanceCompany: "resignations",
  handoverRecord: "resignations",
};

/** The grants that open the HR Forms screen itself to a seat in the table. */
const SEAT_FORMS_RESOURCES: readonly PermissionResource[] = ["contracts", "resignations"];

/** True when the seat-paper table, not employee_documents, decides for this viewer. */
export function isSeatPaperViewer(access: Pick<AccessContext, "role">): boolean {
  return seatPapersFor(access.role) !== null;
}

async function seatHoldsAny(access: AccessContext, action: FormsAction): Promise<boolean> {
  for (const resource of SEAT_FORMS_RESOURCES) {
    if (await canAccess(access, resource, action)) return true;
  }
  return false;
}

/**
 * The HR Forms screen and the routes that serve it as a whole (the pack, the register, the facts and
 * exit-details saves). A seat in the table passes on its contracts or resignations grant; everyone
 * else needs employee_documents, exactly as before.
 */
export async function assertMayUseHrForms(access: AccessContext, action: FormsAction = "read"): Promise<void> {
  if (isSeatPaperViewer(access)) {
    if (await seatHoldsAny(access, action)) return;
    throw new Error(`Forbidden: ${access.role} cannot ${action} HR Forms.`);
  }
  await assertPermission(access, "employee_documents", action);
}

/**
 * The "What Phoenix already knows" save, which writes the `employees` row itself. A seat in the
 * table also needs employees:update for that — the Employee Master's own grant — so the HR Forms
 * screen is never a back door into a record the seat could not edit on the Employee Master.
 */
export async function assertMaySaveEmployeeFacts(access: AccessContext): Promise<void> {
  await assertMayUseHrForms(access, "update");
  if (isSeatPaperViewer(access)) await assertPermission(access, "employees", "update");
}

/**
 * One paper. A seat in the table may use ONLY its listed built-in papers — never a company template
 * — and only while it holds the grant that paper belongs to. Everyone else needs employee_documents,
 * exactly as before (and a company template still checks its own role list in renderHiringPaper).
 */
export async function assertMayPrintPaper(
  access: AccessContext,
  document: string,
  action: FormsAction = "read",
): Promise<void> {
  if (isSeatPaperViewer(access)) {
    const resource = isBuiltInDocument(document) ? SEAT_PAPER_RESOURCE[document] : undefined;
    if (!isPaperOpenToRole(access.role, document) || !resource) {
      throw new Error(`Forbidden: ${access.role} does not print this paper.`);
    }
    if (await canAccess(access, resource, action)) return;
    throw new Error(`Forbidden: ${access.role} cannot ${action} ${resource}.`);
  }
  await assertPermission(access, "employee_documents", action);
}

/** What the two HR Forms pages need to decide: may this viewer open it, edit on it, and which papers. */
export type HrFormsAccess = {
  canRead: boolean;
  canManage: boolean;
  /** The papers this viewer is limited to, or null for every paper (the employee_documents holders). */
  paperScope: readonly HiringPackDocument[] | null;
  /** True for the salary-blind seat: the screen hides the salary and insurance-wage boxes. */
  withholdSalary: boolean;
};

export async function hrFormsAccessFor(access: AccessContext): Promise<HrFormsAccess> {
  const paperScope = seatPapersFor(access.role);
  const withholdSalary = isSalaryBlindRole(access.role);
  if (paperScope) {
    const [canRead, canManage] = await Promise.all([
      seatHoldsAny(access, "read"),
      seatHoldsAny(access, "update"),
    ]);
    return { canManage: canRead && canManage, canRead, paperScope, withholdSalary };
  }
  const [read, canManage] = await Promise.all([
    canAccess(access, "employee_documents", "read"),
    canAccess(access, "employee_documents", "update"),
  ]);
  return {
    canManage,
    canRead: isHrAuthorityRole(access.role) && read,
    paperScope: null,
    withholdSalary,
  };
}

/**
 * The pack as this viewer may see it. For the salary-blind seat the three money fields are blanked;
 * for a seat in the table the gap list keeps only the papers it prints. Everyone else gets the pack
 * untouched — the same object, not a copy.
 */
export function packForViewer(access: Pick<AccessContext, "role">, pack: HiringPackData): HiringPackData {
  const scope = seatPapersFor(access.role);
  const blind = isSalaryBlindRole(access.role);
  if (!scope && !blind) return pack;
  return {
    ...pack,
    employee: blind
      ? { ...pack.employee, baseSalary: null, grossSalary: null, socialInsuranceWage: null }
      : pack.employee,
    gaps: scope
      ? pack.gaps
          .map((gap) => ({ ...gap, documents: gap.documents.filter((document) => scope.includes(document)) }))
          .filter((gap) => gap.documents.length > 0)
      : pack.gaps,
  };
}

/**
 * The facts a viewer may save. The salary-blind seat never sets a salary: the key is dropped, and
 * the save then keeps the salary already on record (resolveFactsCompensationFields treats a missing
 * base salary as "unchanged").
 */
export function factsInputForViewer(
  access: Pick<AccessContext, "role">,
  input: HiringPackEmployeeFactsInput,
): HiringPackEmployeeFactsInput {
  if (!isSalaryBlindRole(access.role) || !input || typeof input !== "object") return input;
  const { baseSalary: _dropped, ...rest } = input;
  return rest;
}

/** The register rows a viewer may read: a seat in the table sees only its own papers' issues. */
export function paperIssuesForViewer<T extends Pick<PaperIssue, "document">>(
  access: Pick<AccessContext, "role">,
  issues: readonly T[],
): T[] {
  if (!isSeatPaperViewer(access)) return [...issues];
  return issues.filter((issue) => isPaperOpenToRole(access.role, issue.document));
}
