export const departmentRules: Record<string, string> = {
  active: "Active",
  marketing: "Marketing",
  sales: "Sales",
};

// Each VALUE must equal the exact `lines.name` stored in the DB. The employee-org import
// derives a line's code as createOrgCode(value) and upserts `lines` with onConflict:"code"
// (see app/api/imports/employees/confirm/route.ts → upsertLines), then links each employee to
// that same derived code. So a value whose slug diverges from the stored code does NOT update
// the canonical row — it MINTS A DUPLICATE `lines` row and splits the line across every
// downstream report. The canonical rows (single source of truth) are:
//   "Anti infective" → anti_infective (id 1) · "Pedia" → pedia (id 2)
//   "CNS" → cns (id 3)              · "Head Office" → head_office (id 4)
// This map was left at the pre-rename "Anti Inf"/"Office" labels after migration
// 20260621240000 renamed line id 1 to "Anti infective" — which is exactly how the duplicate
// "Anti Inf" line (deleted id 53) kept getting recreated on every employee import. Keep these
// values byte-identical to `lines.name`; verify against the DB before adding a new line.
export const lineRules: Record<string, string> = {
  anti_inf: "Anti infective",
  anti_infectious: "Anti infective",
  anti_infective: "Anti infective",
  cns: "CNS",
  head_office: "Head Office",
  office: "Head Office",
  pedia: "Pedia",
  pediatrics: "Pedia",
};

export const positionRules: Record<string, string> = {
  admin_assist: "Admin Assistant",
  admin_assistant: "Admin Assistant",
  district_manager: "District Sales Manager",
  district_sales_manager: "District Sales Manager",
  dsm: "District Sales Manager",
  group_product_manager: "Group Product Manager",
  medical_rep: "Medical Representative",
  medical_representative: "Medical Representative",
  mr: "Medical Representative",
  national_sales_manager: "National Sales Manager",
  nsm: "National Sales Manager",
  product_manager: "Product Manager",
};
