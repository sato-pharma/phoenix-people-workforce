/**
 * An employee's line, department and area — read from the LINKS. The labels that used to sit beside
 * them on `employees` are gone.
 *
 * 🔴 THREE DENORMALIZED COPIES, ALL THREE DROPPED. Measured on production 2026-09-29, across all
 * 198 employees, before each one went:
 *
 *   | column            | populated | the link beside it | populated |
 *   | line_name         |     1     | line_id            |    181    |
 *   | department_name   |     0     | department_id      |    180    |
 *   | area_name         |   145     | area_id            |    174    |
 *
 * A read that took `line_name` reported 197 people as having no line, and one that took
 * `department_name` reported every single person as having no department. Both reported it as a
 * BLANK, which reads as a fact about the person rather than as a broken read — the same defect, on
 * the same table, that the organogram's Team column was burned by (`team_name`, 0 of 107).
 *
 * THE LINK, AND NOTHING ELSE. There is no label left to fall back to, and that is the point: a
 * label is a snapshot frozen at write time, while the link is what the rest of the system writes
 * and joins on. Ordering it the other way — which is how the reader in notifications/email.ts was
 * written — was harmless only until one row carried a stale label.
 *
 * OTHER TABLES HAVE THEIR OWN REAL `line_name` and `area_name`: vacation requests, probation rows,
 * calendar events, seats, `source_of_sales_areas`, `au_v_line_area_map`, the org-placement view.
 * None of this is about those, and a sweep that confused them with these would delete live data.
 * Anchor any search to `.from("employees")`.
 */

/**
 * The select fragment for the line alone, for a read that needs nothing else.
 *
 * 🔴 IT DOES NOT NAME `line_name`, AND THAT IS WHAT MADE THE DROP POSSIBLE. While any read still
 * asks for a column, that column cannot be dropped — PostgREST answers a missing column with an
 * error, so the DDL would turn every employee read in the app into a 42703 the moment it ran. The
 * code half has to be LIVE before the drop, never after it.
 */
export const EMPLOYEE_LINE_SELECT = "lines(name)";

/**
 * The area alone.
 *
 * 🔴 `area_name` WAS THE HALF-ALIVE ONE, AND THAT MADE IT THE MOST DECEPTIVE OF THE THREE: 145 of
 * 198 rows carried one, so a read that took it looked like it worked. Measured on production
 * 2026-09-29 against the `area_id` link, immediately before it was dropped:
 *
 *   29 people had a link and NO label    -> those reads showed a blank area
 *    4 people had both and they DISAGREED -> those reads showed a STALE area
 *    0 people had a label and no link     -> so the label could never answer where the link could not
 *
 * The four disagreements are what a label actually is. Two read "Fayoum-Beni Suef", the name of
 * that territory BEFORE the split, against the link's "Fayoum"; the other two were "ALEX-BHR"
 * against the canonical "Alex-BHR" — and a case-mismatched area string is what doubled a whole
 * line once before.
 *
 * The same column also drove a false signal in `au_v_employee_seat_drift`: `area_name_drifted`
 * fired on 16 of the 94 seated actives while `area_id_drifted` fired on 0 — every one of the 16 a
 * missing or stale label on a person whose seat and area link agree. Both that column and that flag
 * went with it.
 */
export const EMPLOYEE_AREA_SELECT = "areas(name)";

/**
 * The same for all three, for a read that shows a person's placement.
 *
 * Every name here is a LINK. Naming a column that no longer exists is not a blank field — PostgREST
 * fails the whole read, so one stale select takes the entire lookup down with it.
 */
export const EMPLOYEE_ORG_SELECT = "lines(name),departments(name),areas(name)";

type Embedded = { name?: string | null } | { name?: string | null }[] | null;

/**
 * The shape `EMPLOYEE_LINE_SELECT` produces. PostgREST returns an embed as an object or an array.
 *
 * `line_name` is gone from the type as well as from the select, on purpose: leaving it optional
 * would let a read quietly re-add it to its own select and still typecheck, which is how a dropped
 * column comes back as a runtime error nobody predicted.
 */
export type EmployeeLineFields = {
  lines?: Embedded;
};

/**
 * The shape `EMPLOYEE_ORG_SELECT` produces — three links and no labels.
 *
 * `area_name` is absent for the same reason as the other two: the column does not exist any more,
 * so a row cannot carry one, and a type that still offered it would invite a read to ask for it.
 */
export type EmployeeOrgFields = EmployeeLineFields & {
  areas?: Embedded;
  departments?: Embedded;
};

/**
 * The linked name, or null.
 *
 * Null rather than a placeholder: a caller showing this on screen decides what "none" looks like
 * there, and a helper inventing "—" would put that character into an export.
 */
function linkedName(embedded: Embedded): string | null {
  const relation = Array.isArray(embedded) ? embedded[0] : embedded;
  return String(relation?.name ?? "").trim() || null;
}

export function resolveEmployeeLineName(row: EmployeeLineFields | null | undefined): string | null {
  return linkedName(row?.lines ?? null);
}

export function resolveEmployeeDepartmentName(row: EmployeeOrgFields | null | undefined): string | null {
  return linkedName(row?.departments ?? null);
}

export function resolveEmployeeAreaName(row: EmployeeOrgFields | null | undefined): string | null {
  return linkedName(row?.areas ?? null);
}
