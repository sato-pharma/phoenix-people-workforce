/**
 * An employee's line, department and area — read from the LINKS, not from the dead labels beside
 * them.
 *
 * 🔴 THREE DENORMALIZED COPIES, TWO OF THEM COMPLETELY DEAD. Measured on production 2026-09-29,
 * across all 198 employees:
 *
 *   | column            | populated | the link beside it | populated |
 *   | line_name         |     1     | line_id            |    181    |
 *   | department_name   |     0     | department_id      |    180    |
 *   | area_name         |   145     | area_id            |    174    |
 *
 * So a read that takes `line_name` reports 197 people as having no line, and one that takes
 * `department_name` reports every single person as having no department. Both report it as a BLANK,
 * which reads as a fact about the person rather than as a broken read — the same defect, on the same
 * table, that the organogram's Team column was burned by (`team_name`, 0 of 107).
 *
 * THE LINK FIRST, THE LABEL ONLY AS A FALLBACK. `area_name` is the one with real content in it, and
 * it is still second: the link is what the rest of the system writes and joins on, and a label that
 * disagrees with it is stale by definition. Ordering it the other way — which is how the reader in
 * notifications/email.ts was written — is harmless only until one row carries a stale label.
 *
 * NOT A MIGRATION. Dropping these columns is a separate decision with its own blast radius: several
 * OTHER tables have their own real `line_name` (vacation requests, probation rows, calendar events,
 * the org-placement view), and a sweep that confused them with these would delete live data. This is
 * only about what the EMPLOYEE reads ask for.
 */

/**
 * The select fragment for the line alone, for a read that needs nothing else.
 *
 * The dead label is carried as well as the embed on purpose: it costs nothing, and it keeps the one
 * row that has a label working if its `line_id` is ever missing.
 */
export const EMPLOYEE_LINE_SELECT = "line_name,lines(name)";

/** The same for all three, for a read that shows a person's placement. */
export const EMPLOYEE_ORG_SELECT =
  "line_name,lines(name),department_name,departments(name),area_name,areas(name)";

type Embedded = { name?: string | null } | { name?: string | null }[] | null;

/** The shape `EMPLOYEE_LINE_SELECT` produces. PostgREST returns an embed as an object or an array. */
export type EmployeeLineFields = {
  line_name?: string | null;
  lines?: Embedded;
};

/** The shape `EMPLOYEE_ORG_SELECT` produces. */
export type EmployeeOrgFields = EmployeeLineFields & {
  area_name?: string | null;
  areas?: Embedded;
  department_name?: string | null;
  departments?: Embedded;
};

/**
 * The linked name if there is one, else the label, else null.
 *
 * Null rather than a placeholder: a caller showing this on screen decides what "none" looks like
 * there, and a helper inventing "—" would put that character into an export.
 */
function preferLink(embedded: Embedded, label: string | null | undefined): string | null {
  const relation = Array.isArray(embedded) ? embedded[0] : embedded;
  const linked = String(relation?.name ?? "").trim();
  if (linked) return linked;
  return String(label ?? "").trim() || null;
}

export function resolveEmployeeLineName(row: EmployeeLineFields | null | undefined): string | null {
  return preferLink(row?.lines ?? null, row?.line_name);
}

export function resolveEmployeeDepartmentName(row: EmployeeOrgFields | null | undefined): string | null {
  return preferLink(row?.departments ?? null, row?.department_name);
}

export function resolveEmployeeAreaName(row: EmployeeOrgFields | null | undefined): string | null {
  return preferLink(row?.areas ?? null, row?.area_name);
}
