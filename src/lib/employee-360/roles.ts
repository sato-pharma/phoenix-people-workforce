// Employee 360 — role scoping.
//
// Employee 360 is a FIELD-FORCE report. It covers exactly six role families, each
// shown as its own tab on the landing page and each getting a report tailored to
// what that role actually does (a Medical Rep's own field performance vs. a
// manager's team roll-up + the coaching/double-visits they DELIVER). Every other
// job title — HR, Finance, CEO, admin, office, etc. — is deliberately excluded
// from the report entirely.
//
// Classification derives from the descriptive job title via resolveJobFunctionRole
// (the sanctioned job-FUNCTION source for non-security business rules), NOT the
// security role parser. Product Manager and Group Product Manager collapse into a
// single "product-manager" tab per the owner's spec.

import { resolveJobFunctionRole } from "@/lib/employees/job-function";

export type Employee360RoleCategory =
  | "medical-rep"
  | "district-manager"
  | "regional-manager"
  | "national-sales-manager"
  | "product-manager"
  | "training-manager";

// Tab order on the landing page — bottom-up through the field hierarchy
// (rep → DM → RM → NSM), then the two cross-cutting roles (Product, Training).
export const EMPLOYEE_360_ROLE_ORDER: Employee360RoleCategory[] = [
  "medical-rep",
  "district-manager",
  "regional-manager",
  "national-sales-manager",
  "product-manager",
  "training-manager",
];

export type Employee360RoleMeta = {
  /** Full label for headers. */
  label: string;
  /** Short label for the tab chip. */
  tab: string;
  /** One-line description of what this role's report emphasizes. */
  description: string;
};

export const EMPLOYEE_360_ROLE_META: Record<Employee360RoleCategory, Employee360RoleMeta> = {
  "medical-rep": {
    label: "Medical Reps",
    tab: "Medical Reps",
    description: "Individual field performance — visits, campaign balance, GPS timing, own sales, and coaching received.",
  },
  "district-manager": {
    label: "District Managers",
    tab: "District Mgrs",
    description: "Team leadership — their reps' sales roll-up, the coaching and double-visits they deliver, and their own field presence.",
  },
  "regional-manager": {
    label: "Regional Managers",
    tab: "Regional Mgrs",
    description: "Region leadership — the region's sales roll-up, coaching and double-visits delivered, field presence, and expenses.",
  },
  "national-sales-manager": {
    label: "National Sales Managers",
    tab: "National Mgrs",
    description: "Line leadership — whole-line sales roll-up, coaching and double-visits delivered, field presence, and expenses.",
  },
  "product-manager": {
    label: "Product & Group Product Managers",
    tab: "Product Mgrs",
    description: "Product performance — line sales and campaign activity, field double-visits joined, and expenses.",
  },
  "training-manager": {
    label: "Training Managers",
    tab: "Training Mgrs",
    description: "Coaching output — reports delivered and double-visits conducted, the reach across the field force, and their impact.",
  },
};

/**
 * Classify an employee into one of the six Employee 360 role tabs, or null when
 * the role is outside the report's scope (which means: hidden from Employee 360
 * entirely — not shown on any tab, and its detail page shows an out-of-scope
 * state).
 */
export function resolveEmployee360RoleCategory(
  title: string | null | undefined,
): Employee360RoleCategory | null {
  switch (resolveJobFunctionRole(title)) {
    case "Medical Rep":
      return "medical-rep";
    case "District Manager":
      return "district-manager";
    case "Regional Manager":
      return "regional-manager";
    case "National Sales Manager":
      return "national-sales-manager";
    case "Product Manager":
    case "Group Product Manager":
      return "product-manager";
    case "Training Manager":
      return "training-manager";
    default:
      return null;
  }
}

/** A field LEADER = anyone but a Medical Rep (they deliver coaching / double-visits
 *  and carry a team roll-up + expenses). Drives which report sections render. */
export function isFieldLeaderCategory(category: Employee360RoleCategory | null): boolean {
  return category != null && category !== "medical-rep";
}
