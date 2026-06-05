import { normalizeRole, type PhoenixRole } from "@/lib/auth/permissions";

/**
 * Classify an employee's JOB FUNCTION from a descriptive job/position title.
 *
 * This is intentionally separate from `normalizeRole` (which parses an explicit
 * *app role* and is deliberately title-free for governance reasons). Job-function
 * classification is used ONLY for non-security business rules that legitimately
 * depend on what an employee *does* — outstation allowance tiers, employee-portal
 * routing, coaching portal mode. It must NEVER be used to grant permissions or to
 * decide notification recipients; those derive from the explicit app role and org
 * structure.
 *
 * It maps the descriptive sales/field title forms (e.g. "Medical Representative",
 * "District Sales Manager") to their PhoenixRole category, and falls back to the
 * explicit-role parser for canonical role-name titles ("Medical Rep",
 * "National Sales Manager", "Product Manager", …). Unknown titles classify as the
 * baseline "Employee" function.
 */
const JOB_FUNCTION_BY_TITLE: Record<string, PhoenixRole> = {
  "medical representative": "Medical Rep",
  "medical rep": "Medical Rep",
  "employee medical rep": "Medical Rep",
  "district sales manager": "District Manager",
  "district manager": "District Manager",
  dsm: "District Manager",
  "regional sales manager": "Regional Manager",
  "regional manager": "Regional Manager",
  "national sales manager": "National Sales Manager",
  nsm: "National Sales Manager",
  "product manager": "Product Manager",
  "group product manager": "Group Product Manager",
};

export function resolveJobFunctionRole(title: string | null | undefined): PhoenixRole {
  const raw = String(title ?? "").trim();
  if (!raw) return "Employee";

  const mapped = JOB_FUNCTION_BY_TITLE[raw.toLowerCase()];
  if (mapped) return mapped;

  // Canonical role-name titles (and any explicit role string) still resolve
  // through the role parser; everything else is the baseline Employee function.
  return normalizeRole(raw);
}
