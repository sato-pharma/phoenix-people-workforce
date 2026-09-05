/**
 * The Employee Master sheet's COLUMN CONTRACT — pure data, no renderer.
 *
 * WHY IT IS SEPARATE FROM THE WORKBOOK. Three things need this list: the builder that writes the
 * workbook, the report that names the column a finding belongs to, and the browser, which shows the
 * import review before anyone confirms it. The builder imports ExcelJS. If the other two reached
 * the column list through the builder, every one of them would drag ExcelJS along — into the client
 * bundle, for a component that only ever needed forty-odd strings.
 *
 * So the contract lives here, importing nothing but the payroll rate it quotes, and the renderer
 * imports the contract rather than the other way round.
 *
 * A COLUMN HEADER IS AN API. `src/lib/imports/employee-column-map.ts` matches uploaded columns by
 * header text against an alias list, so renaming one of the `imported: true` headers below does not
 * fail — the column simply stops being read, and the upload silently stops writing that field.
 * `tests/employee-master-workbook.test.ts` pins every header against the alias table for exactly
 * this reason, and the `imported: false` ones are deliberately named so they match NO alias.
 */

import { BASIC_SALARY_RATE } from "@/lib/payroll/policy";

/** Masthead rows 1-3, section band row 4, headers row 5. Constraint 2 above caps this at 10. */
export const SECTION_ROW = 4;
export const HEADER_ROW = 5;
export const FIRST_DATA_ROW = 6;

/**
 * Blank rows below the data that still carry dropdowns, formats and the row check, so a new hire
 * typed at the bottom behaves like an existing row.
 *
 * 250 rather than the 1000 this template used to buffer: every spare row carries two formulas and
 * roughly twenty validations, and 250 already exceeds the largest joining cohort this company has
 * ever had in one month by an order of magnitude.
 */
export const SPARE_ROWS = 250;

export type SectionName =
  | "Check"
  | "Identity"
  | "Organization"
  | "Contact & Residence"
  | "CRM"
  | "Payroll Reference Information"
  | "Lifecycle/System"
  | "Reference (read-only)";

/** Drives number format, alignment and what the Field Guide says about the column. */
export type FieldKind = "text" | "money" | "date" | "choice" | "formula";

export type MasterColumn = {
  /** The header text. For an imported column this MUST stay an alias — see constraint 4. */
  header: string;
  key: keyof MasterRow;
  section: SectionName;
  width: number;
  kind: FieldKind;
  /** Does `employee-column-map.ts` read this column back on upload? */
  imported: boolean;
  /** What the field is, in the owner's terms. Printed on the Field Guide sheet. */
  guide: string;
  /** Accepted values, when the set is closed. Printed on the Field Guide sheet. */
  allowed?: string;
};

export type MasterRow = {
  rowCheck: null;
  employeeId: string;
  fullName: string;
  nickname: string | null;
  arabicName: string | null;
  nationalId: string | null;
  gender: string | null;
  birthDate: string | null;
  education: string | null;
  department: string | null;
  line: string | null;
  area: string | null;
  team: string | null;
  jobTitle: string | null;
  position: string | null;
  directManagerId: string | null;
  directManagerName: null;
  hireDate: string | null;
  employmentStatus: string | null;
  contractType: string | null;
  workEmail: string | null;
  mobileNumber: string | null;
  residenceAddress: string | null;
  residenceCity: string | null;
  residenceArea: string | null;
  crmId: string | null;
  crmUsername: string | null;
  basicSalary: number | null;
  baseSalary: number | null;
  grossSalary: number | null;
  netSalary: number | null;
  fuelAllowance: number | null;
  extraCostOfLiving: number | null;
  medicalInsurance: number | null;
  socialInsurance: number | null;
  taxes: number | null;
  paymentMode: string;
  hasBankAccount: string | null;
  bankName: string | null;
  bankAccount: string | null;
  medicalInsuranceStatus: string | null;
  medicalInsuranceNumber: string | null;
  socialInsuranceStatus: string | null;
  socialInsuranceNumber: string | null;
  payrollEligible: string;
  organogramVisible: string;
  region: string | null;
  socialInsuranceWage: number | null;
  contractRenewalDate: string | null;
  lastUpdated: string;
};

export const GENDER_VALUES = "Male,Female,Other,Not specified";
export const CONTRACT_VALUES = "Full time,Semi-full time,Part time";
export const STATUS_VALUES = "active,on_leave";
export const PAYMENT_MODE_VALUES = "two_parts,one_part";
export const YES_NO = "yes,no";
export const YES_NO_PENDING = "yes,no,pending";

/**
 * The columns, in sheet order.
 *
 * Order is not cosmetic in two places: the nine money columns sit CONTIGUOUSLY so the row check can
 * COUNTA them as one range (see `resolveMoneyRange`), and Employee ID / Full Name sit at positions
 * 2 and 3 so the frozen pane can hold "who is this row about" while you scroll right through
 * forty-odd columns.
 */
export const columns: MasterColumn[] = [
  {
    header: "Row Check",
    key: "rowCheck",
    section: "Check",
    width: 34,
    kind: "formula",
    imported: false,
    guide: "Live check of this row against the rules the upload actually enforces. Blank means the row is empty; \"Ready\" means nothing here will block it.",
  },

  { header: "Employee ID", key: "employeeId", section: "Identity", width: 14, kind: "text", imported: true, guide: "HR_ID. The key the upload matches on: an existing HR_ID updates that employee, a new one creates a new active employee.", allowed: "Required. Must be unique in the file." },
  { header: "Full Name", key: "fullName", section: "Identity", width: 28, kind: "text", imported: true, guide: "Legal name, used on payroll documents and contracts.", allowed: "Required." },
  { header: "Nickname", key: "nickname", section: "Identity", width: 20, kind: "text", imported: true, guide: "The name every screen shows when set. Blank means screens fall back to Full Name.", allowed: "Must not be another employee's real name — the upload blocks that, because it would rename someone." },
  { header: "Arabic Name", key: "arabicName", section: "Identity", width: 24, kind: "text", imported: true, guide: "Name in Arabic, as it appears on official paperwork." },
  { header: "National ID", key: "nationalId", section: "Identity", width: 20, kind: "text", imported: true, guide: "Egyptian national ID number." },
  { header: "Gender", key: "gender", section: "Identity", width: 13, kind: "choice", imported: true, guide: "Used by HR reporting only.", allowed: `${GENDER_VALUES}, or blank` },
  { header: "Birth Date", key: "birthDate", section: "Identity", width: 13, kind: "date", imported: true, guide: "Date of birth.", allowed: "YYYY-MM-DD" },
  { header: "Education", key: "education", section: "Identity", width: 26, kind: "text", imported: true, guide: "Degree or qualification. Chemistry counts as an eligible science; geology does not." },

  { header: "Department", key: "department", section: "Organization", width: 22, kind: "choice", imported: true, guide: "Global department. Only currently active departments are offered.", allowed: "Must be an active department — the upload blocks an unknown one." },
  { header: "Line", key: "line", section: "Organization", width: 18, kind: "choice", imported: true, guide: "Business line." },
  { header: "Area", key: "area", section: "Organization", width: 22, kind: "choice", imported: true, guide: "Geographic territory. NOT filtered by Line — CNS, Anti-Infective and Pedia reps commonly share an area name.", allowed: "Must be a currently active area. Areas are never auto-created." },
  { header: "Team", key: "team", section: "Organization", width: 18, kind: "choice", imported: true, guide: "Cascades from Area: pick the Area first and this dropdown shows only that area's teams.", allowed: "Give Area too when a team name exists under more than one area, or the upload cannot tell them apart." },
  { header: "Title", key: "jobTitle", section: "Organization", width: 24, kind: "text", imported: true, guide: "Job title. DSM and Medical Rep titles auto-provision the matching system role." },
  { header: "Position", key: "position", section: "Organization", width: 24, kind: "choice", imported: true, guide: "Seat/position title. Optional — but leaving it blank lets Title silently create a new seat." },
  { header: "Manager HR_ID", key: "directManagerId", section: "Organization", width: 16, kind: "text", imported: true, guide: "The HR_ID of this person's direct manager. Type the ID; the name beside it resolves itself.", allowed: "Cannot be this row's own Employee ID." },
  { header: "Direct Manager (auto)", key: "directManagerName", section: "Organization", width: 26, kind: "formula", imported: false, guide: "Live lookup of the Manager HR_ID against the current directory. Locked — correct the HR_ID, not the name." },
  { header: "Hiring Date", key: "hireDate", section: "Organization", width: 13, kind: "date", imported: true, guide: "First working day. Changing it moves probation and re-dates seat history.", allowed: "YYYY-MM-DD" },
  { header: "Employment Status", key: "employmentStatus", section: "Organization", width: 17, kind: "choice", imported: true, guide: "Lifecycle state.", allowed: `${STATUS_VALUES}, or blank. Resigning or terminating someone is a workflow, never an upload.` },
  { header: "Contract Type", key: "contractType", section: "Organization", width: 16, kind: "choice", imported: true, guide: "Contract basis.", allowed: `${CONTRACT_VALUES}, or blank` },

  { header: "Email", key: "workEmail", section: "Contact & Residence", width: 30, kind: "text", imported: true, guide: "Company mailbox. Note that resetting a mailbox password does not revoke it — app passwords survive.", allowed: "Must be a valid address." },
  { header: "Phone", key: "mobileNumber", section: "Contact & Residence", width: 16, kind: "text", imported: true, guide: "Mobile number." },
  { header: "Residence Address", key: "residenceAddress", section: "Contact & Residence", width: 36, kind: "text", imported: true, guide: "Home address, as written. Used for outstation and commuting logic." },
  { header: "Residence City", key: "residenceCity", section: "Contact & Residence", width: 16, kind: "text", imported: true, guide: "Home city." },
  { header: "Residence Area", key: "residenceArea", section: "Contact & Residence", width: 16, kind: "text", imported: true, guide: "Home district. Free text — this is a residential district, not a sales area." },

  { header: "CRM ID", key: "crmId", section: "CRM", width: 12, kind: "text", imported: true, guide: "The rep's id in the CRM. Reusing a resigned rep's slot hides an active rep — never reassign one without checking." },
  { header: "CRM Username", key: "crmUsername", section: "CRM", width: 18, kind: "text", imported: true, guide: "CRM login name." },

  { header: "Basic Salary", key: "basicSalary", section: "Payroll Reference Information", width: 14, kind: "money", imported: true, guide: `Derived from Base Salary at ${Math.round(BASIC_SALARY_RATE * 100)}%. The upload normalizes it back to policy and tells you it did.` },
  { header: "Base Salary", key: "baseSalary", section: "Payroll Reference Information", width: 14, kind: "money", imported: true, guide: "The figure every other salary number is derived from." },
  { header: "Gross Salary", key: "grossSalary", section: "Payroll Reference Information", width: 14, kind: "money", imported: true, guide: "Base plus social insurance and income tax. Normalized to policy on upload." },
  { header: "Net Salary", key: "netSalary", section: "Payroll Reference Information", width: 14, kind: "money", imported: true, guide: "Base plus cost of living and fuel allowance. Normalized to policy on upload." },
  { header: "Fuel Allowance", key: "fuelAllowance", section: "Payroll Reference Information", width: 14, kind: "money", imported: true, guide: "Standard allowance for the position. Normalized to payroll policy on upload." },
  { header: "Extra Cost Of Living", key: "extraCostOfLiving", section: "Payroll Reference Information", width: 18, kind: "money", imported: true, guide: "Standard allowance for the position. Normalized to position policy on upload." },
  { header: "Medical Insurance", key: "medicalInsurance", section: "Payroll Reference Information", width: 16, kind: "money", imported: true, guide: "Monthly medical insurance amount." },
  { header: "Social Insurance", key: "socialInsurance", section: "Payroll Reference Information", width: 16, kind: "money", imported: true, guide: "Monthly social insurance amount. The company absorbs this — it does not reduce take-home pay." },
  { header: "Taxes", key: "taxes", section: "Payroll Reference Information", width: 13, kind: "money", imported: true, guide: "Monthly income tax. Also absorbed — it does not reduce take-home pay." },
  { header: "Payment Mode", key: "paymentMode", section: "Payroll Reference Information", width: 15, kind: "choice", imported: true, guide: "Whether salary is paid in one part or two.", allowed: `${PAYMENT_MODE_VALUES}, or blank` },
  { header: "Has Bank Account", key: "hasBankAccount", section: "Payroll Reference Information", width: 16, kind: "choice", imported: true, guide: "Whether payroll can pay this person by transfer.", allowed: `${YES_NO}, or blank` },
  { header: "Bank Name", key: "bankName", section: "Payroll Reference Information", width: 20, kind: "text", imported: true, guide: "Bank the salary is transferred to." },
  { header: "Bank Account", key: "bankAccount", section: "Payroll Reference Information", width: 24, kind: "text", imported: true, guide: "Account number or IBAN." },
  { header: "In Medical Insurance", key: "medicalInsuranceStatus", section: "Payroll Reference Information", width: 18, kind: "choice", imported: true, guide: "Registration status with the medical insurer.", allowed: `${YES_NO_PENDING}, or blank` },
  { header: "Medical Insurance Number", key: "medicalInsuranceNumber", section: "Payroll Reference Information", width: 22, kind: "text", imported: true, guide: "Medical insurance membership number." },
  { header: "In Social Insurance", key: "socialInsuranceStatus", section: "Payroll Reference Information", width: 18, kind: "choice", imported: true, guide: "Display only. Payroll does not read this — the Social Insurance Wage column is what decides the statutory filing.", allowed: `${YES_NO_PENDING}, or blank` },
  { header: "Social Insurance Number", key: "socialInsuranceNumber", section: "Payroll Reference Information", width: 22, kind: "text", imported: true, guide: "Social insurance number." },

  { header: "Payroll Eligible", key: "payrollEligible", section: "Lifecycle/System", width: 14, kind: "choice", imported: true, guide: "Whether this person is included in a payroll run. \"No\" is normal for executives.", allowed: "Yes,No" },
  { header: "Organogram Visible", key: "organogramVisible", section: "Lifecycle/System", width: 16, kind: "choice", imported: true, guide: "Whether the person appears on the organogram.", allowed: "Yes,No" },
  { header: "Region", key: "region", section: "Lifecycle/System", width: 16, kind: "text", imported: true, guide: "Company region. These are the company's regions, not geography — Beni Suef and Fayoum are Giza; Aswan and Luxor are Others." },

  { header: "Social Insurance Wage (reference)", key: "socialInsuranceWage", section: "Reference (read-only)", width: 22, kind: "money", imported: false, guide: "The figure that ALONE decides the statutory filing. Shown so an audit can compare it against the status column. Not editable here — the upload does not read it." },
  { header: "Contract Renewal Date (reference)", key: "contractRenewalDate", section: "Reference (read-only)", width: 20, kind: "date", imported: false, guide: "Next contract renewal. Not editable here — the upload does not read it." },
  { header: "Last Updated (reference)", key: "lastUpdated", section: "Reference (read-only)", width: 16, kind: "date", imported: false, guide: "When this employee's record last changed. Not editable here." },
];

/** Columns holding a live formula — locked, so an overwrite cannot silently desync them. */
export const FORMULA_KEYS = new Set<keyof MasterRow>(["rowCheck", "directManagerName"]);

/** Reference columns the upload ignores — locked too, so nobody edits them expecting a save. */
export const READ_ONLY_KEYS = new Set<keyof MasterRow>(
  columns.filter((column) => column.section === "Reference (read-only)").map((column) => column.key),
);

/** Exported for the tests — the sheet contract a future edit must not break by accident. */
export const employeeMasterWorkbookContract = {
  columns,
  firstDataRow: FIRST_DATA_ROW,
  headerRow: HEADER_ROW,
  masterSheetName: "Employee Master",
  sectionRow: SECTION_ROW,
  spareRows: SPARE_ROWS,
};
