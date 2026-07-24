/**
 * Pure, dependency-light vacancy selection used when auto-closing a position
 * vacancy after a hire. Kept separate from vacancy-closer.ts (which is env-bound
 * via the Supabase client) so the department-safety rule is unit-testable.
 */

export type VacancyDepartmentCandidate = {
  id: number;
  department_id?: number | null;
};

/**
 * Department-safe vacancy selection. When several open vacancies share the same
 * line / area / position (e.g. Sales and Marketing both on the Pedia line), pick
 * the one whose department matches the hire so a hire into one department never
 * closes another department's vacancy.
 *
 * Rules:
 *  - No candidates -> nothing to close.
 *  - No department on the hire -> legacy behavior (first candidate).
 *  - A candidate in the hire's department -> close that one.
 *  - Otherwise, only close a SINGLE departmentless legacy candidate; never close a
 *    candidate that belongs to a DIFFERENT department.
 */
export function pickDepartmentSafeVacancy<T extends VacancyDepartmentCandidate>(
  candidates: T[],
  departmentId: number | null | undefined,
): T | undefined {
  if (candidates.length === 0) return undefined;
  if (departmentId === null || departmentId === undefined) return candidates[0];

  const sameDepartment = candidates.filter((candidate) => candidate.department_id === departmentId);
  if (sameDepartment.length > 0) return sameDepartment[0];

  const departmentless = candidates.filter(
    (candidate) => candidate.department_id === null || candidate.department_id === undefined,
  );
  if (departmentless.length === candidates.length && candidates.length === 1) {
    return candidates[0];
  }

  return undefined;
}
