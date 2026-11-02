// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHO MAY USE THE HR FORMS, AND WHICH PAPERS — the one server-side answer for every hiring-pack
// route and both HR Forms pages.
//
// Two kinds of viewer can reach these screens:
//
//   - A seat holding `employee_documents`: HR Operations, the Super Admin, and since 2026-11-02 the
//     HR Operations Specialist (`HR Administration`; owner: "OPEN HR FORMS FULL MODULE TO AYA").
//     Every helper below falls through to the plain `employee_documents` check for them.
//
//   - A seat named in SEAT_PRINTABLE_DOCUMENTS (document-registry.ts), which prints only its listed
//     papers on the business grant each paper belongs to. No seat is named today.
//
// THE SALARY-BLIND SEAT SEES AND PRINTS THE SALARY HERE, AND DOES NOT CHANGE IT. HR Forms is the one
// screen where the HR Operations Specialist sees a figure; `isSalaryBlindRole` still withholds it
// from her on the Employee Master, its import and export, the organogram and resignations. Changing
// pay was not part of what the owner opened, and payroll reads the field, so `factsInputForViewer`
// drops a salary she sends and `salaryReadOnly` locks the box and the paper's field on her screen.
// THE CONTRACT TERMS ARE THE SAME (owner, 2026-11-02: "lock contract terms for aya, she only prints
// them"): `profileInputForViewer` keeps the terms on record, and `contractTermsReadOnly` locks them.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import {
  assertPermission,
  canAccess,
  isHiringPaperworkRole,
  type AccessContext,
  type PermissionResource,
} from "@/lib/auth/permissions";
import { isPaperOpenToRole, seatPapersFor } from "@/lib/hiring-pack/document-registry";
import type { PaperIssue } from "@/lib/hiring-pack/paper-register-store";
import {
  HIRING_CONTRACT_TERM_FIELDS,
  isBuiltInDocument,
  type HiringPackData,
  type HiringPackDocument,
  type HiringPackEmployeeFactsInput,
  type HiringPackProfileInput,
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
 * else needs employee_documents.
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
 * table, and the salary-blind seat, also need employees:update for that — the Employee Master's own
 * grant — so the HR Forms screen is never a back door into a record they could not edit on the
 * Employee Master.
 */
export async function assertMaySaveEmployeeFacts(access: AccessContext): Promise<void> {
  await assertMayUseHrForms(access, "update");
  if (isSeatPaperViewer(access) || isSalaryBlindRole(access.role)) {
    await assertPermission(access, "employees", "update");
  }
}

/**
 * One paper. A seat in the table may use ONLY its listed built-in papers — never a company template
 * — and only while it holds the grant that paper belongs to. Everyone else needs employee_documents
 * (and a company template still checks its own role list in renderHiringPaper).
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
  /** True for the salary-blind seat: the salary shows and prints, and its box takes no change. */
  salaryReadOnly: boolean;
  /** True for the same seat: the contract terms show and print, and take no change. */
  contractTermsReadOnly: boolean;
};

/** The seat that prints the contract terms and does not change them. */
export function areContractTermsReadOnly(access: Pick<AccessContext, "role">): boolean {
  return isSalaryBlindRole(access.role);
}

export async function hrFormsAccessFor(access: AccessContext): Promise<HrFormsAccess> {
  const paperScope = seatPapersFor(access.role);
  const salaryReadOnly = isSalaryBlindRole(access.role);
  const contractTermsReadOnly = areContractTermsReadOnly(access);
  if (paperScope) {
    const [canRead, canManage] = await Promise.all([
      seatHoldsAny(access, "read"),
      seatHoldsAny(access, "update"),
    ]);
    return { canManage: canRead && canManage, canRead, contractTermsReadOnly, paperScope, salaryReadOnly };
  }
  const [read, canManage] = await Promise.all([
    canAccess(access, "employee_documents", "read"),
    canAccess(access, "employee_documents", "update"),
  ]);
  return {
    canManage,
    canRead: isHiringPaperworkRole(access.role) && read,
    contractTermsReadOnly,
    paperScope: null,
    salaryReadOnly,
  };
}

/**
 * The pack as this viewer may see it. For a seat in the table the gap list keeps only the papers it
 * prints. Everyone else gets the pack untouched — the same object, not a copy.
 */
export function packForViewer(access: Pick<AccessContext, "role">, pack: HiringPackData): HiringPackData {
  const scope = seatPapersFor(access.role);
  if (!scope) return pack;
  return {
    ...pack,
    gaps: pack.gaps
      .map((gap) => ({ ...gap, documents: gap.documents.filter((document) => scope.includes(document)) }))
      .filter((gap) => gap.documents.length > 0),
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

/**
 * What a hiring-profile save may carry from this viewer. The save writes every column, so leaving a
 * term out would blank it: for the read-only seat each term is put back to what is on record, whatever
 * was sent, and the rest of the profile (nationality, address, Form 1 codes) saves as usual.
 */
export function profileInputForViewer(
  access: Pick<AccessContext, "role">,
  input: HiringPackProfileInput,
  onRecord: HiringPackProfileInput,
): HiringPackProfileInput {
  if (!areContractTermsReadOnly(access)) return input;
  const kept: HiringPackProfileInput = { ...input };
  for (const field of HIRING_CONTRACT_TERM_FIELDS) {
    (kept as Record<string, unknown>)[field] = onRecord[field] ?? null;
  }
  return kept;
}

/** The register rows a viewer may read: a seat in the table sees only its own papers' issues. */
export function paperIssuesForViewer<T extends Pick<PaperIssue, "document">>(
  access: Pick<AccessContext, "role">,
  issues: readonly T[],
): T[] {
  if (!isSeatPaperViewer(access)) return [...issues];
  return issues.filter((issue) => isPaperOpenToRole(access.role, issue.document));
}
