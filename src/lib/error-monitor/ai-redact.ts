// Redacts error text before it is sent to an external AI provider for triage.
//
// This is an HR platform: error messages, routes, and stacks routinely contain employee
// identifiers (e.g. `/employee-360/B-59`, an hr_id in a "Forbidden" message). None of that
// is needed to explain a bug, so we strip it here — conservatively (over-redact rather than
// leak). hr_id/login_id fields are never passed in at all; this covers what's embedded in
// free text. Pure + unit-tested.

// Order matters: emails and UUIDs first (they contain digit/letter runs the later, broader
// patterns would otherwise mangle), then route params, then bare identifier shapes.
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Employee-code shapes like B-59, A-12, PHX-1, b-28 — the dominant PII in these errors.
// The second block must LEAD WITH A DIGIT so ordinary hyphenated technical words
// (client-side, server-rendered, pre-render) are left intact — masking those would badly
// degrade the AI's understanding of the error.
const EMPLOYEE_CODE = /\b[A-Za-z]{1,6}-\d[A-Za-z0-9]*\b/g;
// Long bare digit runs (ids, phone-ish) — 5+ digits.
const LONG_DIGITS = /\b\d{5,}\b/g;

/**
 * Collapse an employee/entity id embedded in a URL path segment to `:id`, e.g.
 * `/employee-360/B-59` → `/employee-360/:id`, `/admin/users/42` → `/admin/users/:id`.
 * Runs before the bare-identifier masking so the path stays readable.
 */
function collapseRouteParams(text: string): string {
  return text
    .replace(/(\/(?:employee-360|users|employees|payroll|expenses)\/)[A-Za-z0-9%._-]+/gi, "$1:id");
}

export function redactForAi(text: string | null | undefined): string {
  if (!text) return "";
  return collapseRouteParams(text)
    .replace(EMAIL, "[email]")
    .replace(UUID, "[uuid]")
    .replace(EMPLOYEE_CODE, "[id]")
    .replace(LONG_DIGITS, "[num]");
}
