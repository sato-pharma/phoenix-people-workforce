/**
 * What to call an employee's lifecycle status on screen.
 *
 * WHY THIS EXISTS. `employees.employment_status` is a stored code, and the Hiring Documents
 * Control filter rendered it straight into its `<option>` list — so the dropdown read "active",
 * "resigned", "terminated" in raw lowercase while the table one column over read them correctly.
 * The table was never doing anything clever: `Badge` carries `uppercase` in its class, so the same
 * raw string simply arrived styled. An `<option>` cannot be styled that way in any browser, which
 * is exactly why a stored code has to be turned into words before it is rendered, not after.
 *
 * Confirmed live in production on 2026-08-24, so this is the real vocabulary rather than a
 * hypothetical one — `active` (112), `resigned` (44), `historical_payroll_record` (15),
 * `terminated` (2), `system_placeholder` (2). The last two of those five are bookkeeping states
 * that a person still has to read in a filter list, so they get labels too.
 *
 * `on_leave`, `inactive` and `not_renewed` are named across the lifecycle code
 * (src/lib/auth/session-lifecycle.ts, src/lib/employees/employee-directory.ts) and hold no rows
 * today. They are listed because a status arriving in the data before it arrives here should read
 * as words on its first day, not on the day someone notices.
 *
 * Sentence case, matching src/lib/recruitment/labels.ts: "On leave" reads as a phrase, "On Leave"
 * reads as a database value someone ran a regular expression over.
 */

export const employmentStatusLabels: Record<string, string> = {
  active: "Active",
  historical_payroll_record: "Historical payroll record",
  inactive: "Inactive",
  not_renewed: "Not renewed",
  on_leave: "On leave",
  resigned: "Resigned",
  system_placeholder: "System placeholder",
  terminated: "Terminated",
};

/**
 * An employment status as a person reads it.
 *
 * An unknown code degrades to readable words rather than to the raw value, so a status added to
 * the database before it is added here still never reaches a screen with an underscore in it.
 */
export function employmentStatusLabel(status: string | null | undefined): string {
  const raw = String(status ?? "").trim();
  if (!raw) return "";

  const key = raw.toLowerCase();
  const known = employmentStatusLabels[key];
  if (known) return known;

  const words = key.replace(/[_-]+/g, " ").split(/\s+/).filter(Boolean).join(" ");
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}
