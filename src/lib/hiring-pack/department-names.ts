// The Arabic name of the department that employs someone, for the printed paper.
//
// THE DEPARTMENT IS NOT THE LINE (owner, 2026-08-31). The pack used to print `lines.name` here, so
// a medical rep's contract named his product line — CNS, Anti Infective, Pedia — in the box that
// asks which إدارة employs him. Those are two different facts about the same person: in production
// 140 of the 162 employees carrying a department are in Sales, spread across all three lines.
//
// `departments` has no Arabic column and the contract is an Arabic instrument, so the mapping lives
// here. It is a lookup, not a translation service: the department list is small, closed, and
// administered by HR, and every one of the eleven rows in production on 2026-08-31 is covered
// below — the fallback exists for a department created after this was written, not for a gap in it.

/**
 * Arabic for each department, keyed by the English name as `departments.name` stores it.
 *
 * Matched case-insensitively on a trimmed name, because these are typed by hand in the HR screens
 * and "Human Resources" has already been seen with different spacing.
 */
const DEPARTMENT_NAME_AR: Readonly<Record<string, string>> = {
  active: "الشؤون الإدارية",
  admins: "الشؤون الإدارية",
  executive: "الإدارة التنفيذية",
  finance: "الإدارة المالية",
  "human resources": "الموارد البشرية",
  marketing: "التسويق",
  qppv: "التيقظ الدوائي",
  "r&d": "البحث والتطوير",
  sales: "المبيعات",
  sfe: "فعالية القوة البيعية",
  "supply chain": "سلسلة الإمداد",
};

/**
 * The Arabic department name to print, or the English one when the department is not in the table.
 *
 * An unmapped department returns its English name rather than nothing. A blank إدارة on a signed
 * contract is a silent omission that nobody notices; the English word in an Arabic box is wrong in
 * a way HR sees immediately and can report. Neither should ever happen — add the department here
 * when one is created.
 */
export function arabicDepartmentName(name: string | null): string | null {
  if (name === null) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  return DEPARTMENT_NAME_AR[trimmed.toLowerCase()] ?? trimmed;
}
