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

/**
 * The section band labels, written EXACTLY as they appear on the sheet.
 *
 * They are not normalized and not upper-cased on the way out: HR rebuilt this sheet by hand in
 * September 2026 and the owner asked for that layout verbatim, mixed casing included. A band that
 * says "Personal Information" says it because that is what HR wrote above those columns.
 */
export type SectionName =
  | "CHECK"
  | "Personal Information"
  | "CONTACT & RESIDENCE"
  | "Educational Qualifications"
  | "Contract Data"
  | "ORGANIZATION"
  | "CRM Data"
  | "LIFECYCLE/SYSTEM"
  | "PAYROLL REFERENCE INFORMATION"
  | "Private Medical Insurance"
  | "Government Medical Insurance"
  | "Government Social Insurance"
  | "Registration certificate information"
  | "REFERENCE (READ-ONLY)"
  | "Required Employment Documents"
  | "Onboarding Documents"
  | "Offboarding Documents";

/** Drives number format, alignment and what the Field Guide says about the column. */
export type FieldKind = "text" | "money" | "date" | "choice" | "formula";

/**
 * A hiring-document column's key.
 *
 * The hiring-document columns are DATA, not contract: they come from `hiring_document_definitions`,
 * which HR adds to from the Hiring Documents screen, so they cannot be named in `MasterRow` the way
 * every other column is. They carry the document's id instead, and the builder resolves their value
 * from a per-employee map rather than from the row object.
 */
export type HiringDocumentColumnKey = `doc:${string}`;

export type MasterColumnKey = keyof MasterRow | HiringDocumentColumnKey;

export type MasterColumn = {
  /** The header text. For an imported column this MUST stay an alias — see constraint 4. */
  header: string;
  key: MasterColumnKey;
  section: SectionName;
  width: number;
  kind: FieldKind;
  /** Does `employee-column-map.ts` read this column back on upload? */
  imported: boolean;
  /**
   * Lock the cell, so nobody edits it expecting a save.
   *
   * AN EXPLICIT FLAG RATHER THAN A SECTION TEST. Until 2026-09-29 "read-only" was inferred from the
   * section name, which worked only while every locked column sat in a section called
   * "(read-only)". HR's layout puts Social Insurance Wage inside the payroll block and the document
   * columns inside three named blocks of their own, so the section no longer carries that fact and
   * the column has to say it itself.
   */
  readOnly?: boolean;
  /** A hiring-document checklist column — its value comes from the checklist, not from `MasterRow`. */
  documentColumn?: boolean;
  /**
   * What the section band prints above this column, when it is not the section name.
   *
   * ONE COLUMN USES IT. HR's sheet bands "REFERENCE (READ-ONLY)" over the Last Updated column
   * alone and leaves the band cell above "Hiring Documents Complete" filled but blank — the two are
   * not merged. The band is drawn from RUNS of equal labels, so an empty label is what splits that
   * run and reproduces her layout exactly; the section itself is unchanged, so the column is still
   * read-only reference for every other purpose.
   */
  bandLabel?: string;
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
  birthPlace: string | null;
  /**
   * THE COLLEGE, not the qualification — the sheet labels it "College Name".
   *
   * `employees.education` has always held the college (its live values are Science, Pharmacy, Vet,
   * Commerce, Dentist), which is also what the eligible-degree rule reads. The qualification itself
   * — بكالوريوس / ليسانس — is the separate `qualification` field below.
   */
  education: string | null;
  qualification: string | null;
  universityName: string | null;
  collegeMajor: string | null;
  seniorYear: string | null;
  /**
   * HR's total years of experience (owner, 2026-10-31) — a NUMBER, 0 to 60 with one decimal. Its
   * column is still kind "text": FieldKind has no number kind, and "money" would hide it from the
   * salary-blind seat, who fills it like any other HR record field.
   */
  totalExperienceYears: number | null;
  department: string | null;
  line: string | null;
  area: string | null;
  team: string | null;
  jobTitle: string | null;
  position: string | null;
  directManagerId: string | null;
  directManagerName: null;
  hireDate: string | null;
  probationEndDate: string | null;
  employmentStatus: string | null;
  contractType: string | null;
  contractDuration: string | null;
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
  medicalInsuranceCardReceivedDate: string | null;
  socialInsuranceStatus: string | null;
  socialInsuranceNumber: string | null;
  socialInsuranceJobTitle: string | null;
  socialInsuranceStartDate: string | null;
  kaabElamaalNumber: string | null;
  kaabElamaalIssuer: string | null;
  kaabElamaalIssueDate: string | null;
  kaabElamaalRefund: string | null;
  healthCardStatus: string | null;
  healthCardNumber: string | null;
  healthCardReceivedDate: string | null;
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
 * The columns, in sheet order — HR's own order, verbatim.
 *
 * WHOSE ORDER THIS IS. Yasmeena Elsafory (HR-009) rebuilt this sheet by hand in September 2026 and
 * the owner asked for her layout exactly: her column order, her headers, her section bands. It
 * reads as an HR file rather than a database dump — who the person is, how to reach them, what they
 * studied, what they signed, where they sit, what they are paid, then each insurance in its own
 * block, then the papers. Do not "tidy" it back towards the table order.
 *
 * Order is not cosmetic in two places: the nine IMPORTED money columns sit CONTIGUOUSLY so the row
 * check can COUNTA them as one range (see `resolveMoneyRange` — Social Insurance Wage is money too
 * but read-only, so it sits after the block and outside it), and Employee ID / Full English Name
 * sit at positions 2 and 3 so the frozen pane can hold "who is this row about" while you scroll
 * right through ninety-odd columns.
 */
export const columns: MasterColumn[] = [
  {
    header: "Row Check",
    key: "rowCheck",
    section: "CHECK",
    width: 34,
    kind: "formula",
    imported: false,
    guide: "Live check of this row against the rules the upload actually enforces. Blank means the row is empty; \"Ready\" means nothing here will block it.",
  },

  // ── Personal Information ────────────────────────────────────────────────────
  { header: "Employee ID", key: "employeeId", section: "Personal Information", width: 14, kind: "text", imported: true, guide: "HR_ID. The key the upload matches on: an existing HR_ID updates that employee, a new one creates a new active employee.", allowed: "Required. Must be unique in the file." },
  // "Full English Name", not "Full Name" — and `employee-upload-parse.ts` knows both, because the
  // header ROW is found by looking for this exact text. Renaming it here without teaching the
  // parser is what made HR's own rebuilt file unreadable to the importer in the first place.
  { header: "Full English Name", key: "fullName", section: "Personal Information", width: 28, kind: "text", imported: true, guide: "Legal name in English, used on payroll documents and contracts.", allowed: "Required." },
  { header: "Nickname", key: "nickname", section: "Personal Information", width: 20, kind: "text", imported: true, guide: "The name every screen shows when set. Blank means screens fall back to Full English Name.", allowed: "Must not be another employee's real name — the upload blocks that, because it would rename someone." },
  { header: "Full Arabic Name", key: "arabicName", section: "Personal Information", width: 24, kind: "text", imported: true, guide: "Name in Arabic, as it appears on official paperwork." },
  { header: "National ID", key: "nationalId", section: "Personal Information", width: 20, kind: "text", imported: true, guide: "Egyptian national ID number." },
  { header: "Gender", key: "gender", section: "Personal Information", width: 13, kind: "choice", imported: true, guide: "Used by HR reporting only.", allowed: `${GENDER_VALUES}, or blank` },
  { header: "Birth Date", key: "birthDate", section: "Personal Information", width: 13, kind: "date", imported: true, guide: "Date of birth.", allowed: "YYYY-MM-DD" },
  { header: "Birth Place", key: "birthPlace", section: "Personal Information", width: 20, kind: "text", imported: true, guide: "محل الميلاد — birth place as written on the national ID. Free text." },

  // ── Contact & residence ─────────────────────────────────────────────────────
  { header: "Email", key: "workEmail", section: "CONTACT & RESIDENCE", width: 30, kind: "text", imported: true, guide: "Company mailbox. Note that resetting a mailbox password does not revoke it — app passwords survive.", allowed: "Must be a valid address." },
  { header: "Phone", key: "mobileNumber", section: "CONTACT & RESIDENCE", width: 16, kind: "text", imported: true, guide: "Mobile number." },
  { header: "Residence Address", key: "residenceAddress", section: "CONTACT & RESIDENCE", width: 36, kind: "text", imported: true, guide: "Home address, as written. Used for outstation and commuting logic." },
  { header: "Residence City", key: "residenceCity", section: "CONTACT & RESIDENCE", width: 16, kind: "text", imported: true, guide: "Home city." },
  { header: "Residence Area", key: "residenceArea", section: "CONTACT & RESIDENCE", width: 16, kind: "text", imported: true, guide: "Home district. Free text — this is a residential district, not a sales area." },

  // ── Educational qualifications ──────────────────────────────────────────────
  //
  // FIVE COLUMNS WHERE THERE WAS ONE. "Education" always held the COLLEGE — Science, Pharmacy, Vet —
  // so it keeps its column and is simply labelled "College Name", which is what HR reads it as and
  // what the eligible-degree rule scores. Qualification, University, major and graduation year are
  // new, and were being kept in a private spreadsheet until 2026-09-29.
  { header: "Qualification (Bachelor - license)", key: "qualification", section: "Educational Qualifications", width: 26, kind: "text", imported: true, guide: "المؤهل — the qualification itself, e.g. \"Bachelor - license\". Not the college: that is the next column." },
  { header: "College Name", key: "education", section: "Educational Qualifications", width: 22, kind: "text", imported: true, guide: "الكلية — the college. This is the field the eligible-degree rule reads: pharmacy, science (chemistry counts), veterinary, medicine and dentistry are eligible; geology is not." },
  { header: "University Name", key: "universityName", section: "Educational Qualifications", width: 22, kind: "text", imported: true, guide: "الجامعة — the university the college belongs to." },
  { header: "College major", key: "collegeMajor", section: "Educational Qualifications", width: 22, kind: "text", imported: true, guide: "التخصص — the major read inside the college." },
  { header: "senior year", key: "seniorYear", section: "Educational Qualifications", width: 16, kind: "text", imported: true, guide: "سنة التخرج — graduation year. Free text, so \"2019/2020\" is fine." },
  { header: "Total years of experience", key: "totalExperienceYears", section: "Educational Qualifications", width: 18, kind: "text", imported: true, guide: "All years in the role, at Sato and before. Filled by HR; the Team Coaching Skills Survey reads it as Years in Role.", allowed: "A number from 0 to 60, for example 2 or 0.5." },

  // ── Contract data ───────────────────────────────────────────────────────────
  { header: "Hiring Date", key: "hireDate", section: "Contract Data", width: 13, kind: "date", imported: true, guide: "First working day. Changing it moves probation and re-dates seat history.", allowed: "YYYY-MM-DD" },
  { header: "End date of probation period", key: "probationEndDate", section: "Contract Data", width: 22, kind: "date", imported: true, guide: "The last day of probation. Leave it blank and the probation milestones keep running from the hiring date, exactly as they did before this column existed.", allowed: "YYYY-MM-DD" },
  { header: "Employment Status", key: "employmentStatus", section: "Contract Data", width: 17, kind: "choice", imported: true, guide: "Lifecycle state.", allowed: `${STATUS_VALUES}, or blank. Resigning or terminating someone is a workflow, never an upload.` },
  { header: "Contract Type", key: "contractType", section: "Contract Data", width: 16, kind: "choice", imported: true, guide: "Contract basis.", allowed: `${CONTRACT_VALUES}, or blank` },
  { header: "contract duration", key: "contractDuration", section: "Contract Data", width: 16, kind: "text", imported: true, guide: "مدة العقد — the term as HR writes it, e.g. \"1 Year\". Free text; the dated field is the next column." },
  { header: "Contract Renewal Date", key: "contractRenewalDate", section: "Contract Data", width: 20, kind: "date", imported: true, guide: "Next contract renewal.", allowed: "YYYY-MM-DD" },

  // ── Organization ────────────────────────────────────────────────────────────
  { header: "Department", key: "department", section: "ORGANIZATION", width: 22, kind: "choice", imported: true, guide: "Global department. Only currently active departments are offered.", allowed: "Must be an active department — the upload blocks an unknown one." },
  { header: "Line", key: "line", section: "ORGANIZATION", width: 18, kind: "choice", imported: true, guide: "Business line." },
  { header: "Area", key: "area", section: "ORGANIZATION", width: 22, kind: "choice", imported: true, guide: "Geographic territory. NOT filtered by Line — CNS, Anti-Infective and Pedia reps commonly share an area name.", allowed: "Must be a currently active area. Areas are never auto-created." },
  { header: "Region", key: "region", section: "ORGANIZATION", width: 16, kind: "text", imported: true, guide: "Company region. These are the company's regions, not geography — Beni Suef and Fayoum are Giza; Aswan and Luxor are Others." },
  { header: "Team", key: "team", section: "ORGANIZATION", width: 18, kind: "choice", imported: true, guide: "Cascades from Area: pick the Area first and this dropdown shows only that area's teams.", allowed: "Give Area too when a team name exists under more than one area, or the upload cannot tell them apart." },
  { header: "Title", key: "jobTitle", section: "ORGANIZATION", width: 24, kind: "text", imported: true, guide: "Job title. DSM and Medical Rep titles auto-provision the matching system role." },
  { header: "Position", key: "position", section: "ORGANIZATION", width: 24, kind: "choice", imported: true, guide: "Seat/position title. Optional — but leaving it blank lets Title silently create a new seat." },
  { header: "Manager HR_ID", key: "directManagerId", section: "ORGANIZATION", width: 16, kind: "text", imported: true, guide: "The HR_ID of this person's direct manager. Type the ID; the name beside it resolves itself.", allowed: "Cannot be this row's own Employee ID." },
  { header: "Direct Manager (auto)", key: "directManagerName", section: "ORGANIZATION", width: 26, kind: "formula", imported: false, readOnly: true, guide: "Live lookup of the Manager HR_ID against the current directory. Locked — correct the HR_ID, not the name." },

  // ── CRM ─────────────────────────────────────────────────────────────────────
  { header: "CRM ID", key: "crmId", section: "CRM Data", width: 12, kind: "text", imported: true, guide: "The rep's id in the CRM. Reusing a resigned rep's slot hides an active rep — never reassign one without checking." },
  { header: "CRM Username", key: "crmUsername", section: "CRM Data", width: 18, kind: "text", imported: true, guide: "CRM login name." },

  // ── Lifecycle / system ──────────────────────────────────────────────────────
  { header: "Organogram Visible", key: "organogramVisible", section: "LIFECYCLE/SYSTEM", width: 16, kind: "choice", imported: true, guide: "Whether the person appears on the organogram.", allowed: "Yes,No" },

  // ── Payroll reference information ───────────────────────────────────────────
  { header: "Basic Salary", key: "basicSalary", section: "PAYROLL REFERENCE INFORMATION", width: 14, kind: "money", imported: true, guide: `Derived from Base Salary at ${Math.round(BASIC_SALARY_RATE * 100)}%. The upload normalizes it back to policy and tells you it did.` },
  { header: "Base Salary", key: "baseSalary", section: "PAYROLL REFERENCE INFORMATION", width: 14, kind: "money", imported: true, guide: "The figure every other salary number is derived from." },
  { header: "Gross Salary", key: "grossSalary", section: "PAYROLL REFERENCE INFORMATION", width: 14, kind: "money", imported: true, guide: "Base plus social insurance and income tax. Normalized to policy on upload." },
  { header: "Net Salary", key: "netSalary", section: "PAYROLL REFERENCE INFORMATION", width: 14, kind: "money", imported: true, guide: "Base plus cost of living and fuel allowance. Normalized to policy on upload." },
  { header: "Fuel Allowance", key: "fuelAllowance", section: "PAYROLL REFERENCE INFORMATION", width: 14, kind: "money", imported: true, guide: "Standard allowance for the position. Normalized to payroll policy on upload." },
  { header: "Extra Cost Of Living", key: "extraCostOfLiving", section: "PAYROLL REFERENCE INFORMATION", width: 18, kind: "money", imported: true, guide: "Standard allowance for the position. Normalized to position policy on upload." },
  { header: "Medical Insurance", key: "medicalInsurance", section: "PAYROLL REFERENCE INFORMATION", width: 16, kind: "money", imported: true, guide: "Monthly medical insurance amount." },
  { header: "Social Insurance", key: "socialInsurance", section: "PAYROLL REFERENCE INFORMATION", width: 16, kind: "money", imported: true, guide: "Monthly social insurance amount. The company absorbs this — it does not reduce take-home pay." },
  { header: "Taxes", key: "taxes", section: "PAYROLL REFERENCE INFORMATION", width: 13, kind: "money", imported: true, guide: "Monthly income tax. Also absorbed — it does not reduce take-home pay." },
  // LOCKED ON PURPOSE, and the one place this sheet does not follow HR's layout to the letter. HR
  // moved it out of the reference block and dropped its "(reference)" suffix; it keeps the header
  // she gave it and the position she gave it, but it stays read-only, because this single figure
  // decides the statutory social-insurance filing and a spreadsheet upload is the wrong instrument
  // for it. It also has to sit AFTER the nine imported money columns so `resolveMoneyRange` still
  // sees one contiguous block.
  { header: "Social Insurance Wage", key: "socialInsuranceWage", section: "PAYROLL REFERENCE INFORMATION", width: 22, kind: "money", imported: false, readOnly: true, guide: "The figure that ALONE decides the statutory filing — payroll never reads the In Social Insurance status beside it. Shown so an audit can compare the two. Locked: the upload does not read this column, so change it on the employee record." },
  { header: "Payment Mode", key: "paymentMode", section: "PAYROLL REFERENCE INFORMATION", width: 15, kind: "choice", imported: true, guide: "Whether salary is paid in one part or two.", allowed: `${PAYMENT_MODE_VALUES}, or blank` },
  { header: "Has Bank Account", key: "hasBankAccount", section: "PAYROLL REFERENCE INFORMATION", width: 16, kind: "choice", imported: true, guide: "Whether payroll can pay this person by transfer.", allowed: `${YES_NO}, or blank` },
  { header: "Bank Name", key: "bankName", section: "PAYROLL REFERENCE INFORMATION", width: 20, kind: "text", imported: true, guide: "Bank the salary is transferred to." },
  { header: "Bank Account", key: "bankAccount", section: "PAYROLL REFERENCE INFORMATION", width: 24, kind: "text", imported: true, guide: "Account number or IBAN." },
  { header: "Payroll Eligible", key: "payrollEligible", section: "PAYROLL REFERENCE INFORMATION", width: 14, kind: "choice", imported: true, guide: "Whether this person is included in a payroll run. \"No\" is normal for executives.", allowed: "Yes,No" },

  // ── Private medical insurance — the COMPANY's policy ────────────────────────
  { header: "Medical Insurance Card Number", key: "medicalInsuranceNumber", section: "Private Medical Insurance", width: 22, kind: "text", imported: true, guide: "Membership number on the company's private medical insurance card." },
  { header: "Medical Insurance Card Receipt Date", key: "medicalInsuranceCardReceivedDate", section: "Private Medical Insurance", width: 22, kind: "date", imported: true, guide: "The day the employee received the private medical insurance card.", allowed: "YYYY-MM-DD" },
  { header: "Medical Insurance Card Received (Yes-No)", key: "medicalInsuranceStatus", section: "Private Medical Insurance", width: 22, kind: "choice", imported: true, guide: "Whether the employee has received the company's private medical insurance card.", allowed: `${YES_NO_PENDING}, or blank` },

  // ── Government medical insurance — the STATE booklet ────────────────────────
  //
  // Deliberately a separate block from the private policy above. The owner drew that line himself
  // on 2026-09-29: "استلام بطاقة صحية" is دفتر التأمين الصحى الحكومى, never the company's card, and
  // merging the two pairs would have somebody read a private policy number as a state one.
  { header: "Health Insurance Card Number", key: "healthCardNumber", section: "Government Medical Insurance", width: 20, kind: "text", imported: true, guide: "رقم البطاقة الصحية — the government health insurance booklet's number. Free text: the booklet is not numbered the same way in every governorate." },
  { header: "Health Insurance Card Receipt Date", key: "healthCardReceivedDate", section: "Government Medical Insurance", width: 20, kind: "date", imported: true, guide: "تاريخ الاستلام — the day the employee received the booklet.", allowed: "YYYY-MM-DD" },
  { header: "Health Insurance Card Received (Yes-No)", key: "healthCardStatus", section: "Government Medical Insurance", width: 22, kind: "choice", imported: true, guide: "استلام بطاقة صحية — whether the employee has received the GOVERNMENT health insurance booklet. This is the state booklet, NOT the company's private card in the block before it.", allowed: `${YES_NO_PENDING}, or blank` },

  // ── Government social insurance ─────────────────────────────────────────────
  { header: "In Social Insurance", key: "socialInsuranceStatus", section: "Government Social Insurance", width: 18, kind: "choice", imported: true, guide: "Display only. Payroll does not read this — the Social Insurance Wage column is what decides the statutory filing.", allowed: `${YES_NO_PENDING}, or blank` },
  { header: "Social Insurance Number", key: "socialInsuranceNumber", section: "Government Social Insurance", width: 22, kind: "text", imported: true, guide: "Social insurance number." },
  { header: "Social Insurance Job Title", key: "socialInsuranceJobTitle", section: "Government Social Insurance", width: 26, kind: "text", imported: true, guide: "المسمى الوظيفى فى التأمينات الاجتماعية — the Arabic job title this person is filed under with the Social Insurance Authority. It is the SAME value Phoenix already prints on the contract, Form 1, custody and clearance, so editing it here changes those papers too.", allowed: "Arabic, as it is written on the insurance paperwork." },
  { header: "Social insurance start date", key: "socialInsuranceStartDate", section: "Government Social Insurance", width: 20, kind: "date", imported: true, guide: "تاريخ بدء التأمين — the day social insurance cover started. A record only: no payroll figure is derived from it.", allowed: "YYYY-MM-DD" },

  // ── Registration certificate — كعب العمل ────────────────────────────────────
  { header: "Kaab Elamaal Number", key: "kaabElamaalNumber", section: "Registration certificate information", width: 20, kind: "text", imported: true, guide: "كعب العمل — the number on the labour registration stub." },
  { header: "Kaab Elamaal Issuer", key: "kaabElamaalIssuer", section: "Registration certificate information", width: 20, kind: "text", imported: true, guide: "The labour office that issued the stub." },
  { header: "Kaab Elamaal Issue Date", key: "kaabElamaalIssueDate", section: "Registration certificate information", width: 18, kind: "date", imported: true, guide: "The day the stub was issued.", allowed: "YYYY-MM-DD" },
  { header: "Kaab Elamaal refund (Yes-No)", key: "kaabElamaalRefund", section: "Registration certificate information", width: 20, kind: "choice", imported: true, guide: "Whether the stub's fee was refunded to the employee. A receipt fact HR records — it moves no money and no payroll run reads it.", allowed: `${YES_NO}, or blank` },

  // ── Reference (read-only) ───────────────────────────────────────────────────
  { header: "Last Updated (reference)", key: "lastUpdated", section: "REFERENCE (READ-ONLY)", width: 16, kind: "date", imported: false, readOnly: true, guide: "When this employee's record last changed. Not editable here." },
];

/** Columns holding a live formula — locked, so an overwrite cannot silently desync them. */
export const FORMULA_KEYS = new Set<MasterColumnKey>(["rowCheck", "directManagerName"]);

/** Reference columns the upload ignores — locked too, so nobody edits them expecting a save. */
export const READ_ONLY_KEYS = new Set<MasterColumnKey>(
  columns.filter((column) => column.readOnly === true).map((column) => column.key),
);

/**
 * Whether the upload ignores this column, so the sheet should lock it.
 *
 * A PREDICATE RATHER THAN THE KEY SET, because the hiring-document columns have no fixed keys — a
 * set built once at module load could never contain them, and they are precisely the columns it
 * would be most misleading to leave editable: ticking "Submitted" in the sheet must not look like
 * it files a document.
 *
 * IT READS THE COLUMN'S OWN FLAG, not its section. Until 2026-09-29 it tested the section name,
 * which held only while every locked column lived in a section with "(read-only)" in its title. HR's
 * layout ended that: Social Insurance Wage sits inside the payroll block and the document columns
 * sit in three bands of their own, so a section test would have quietly unlocked all of them.
 */
export function isReadOnlyMasterColumn(column: MasterColumn) {
  return column.readOnly === true;
}

/**
 * Which block of the personnel file a paper belongs to.
 *
 * HR reads the checklist as three lists, not one: the papers a candidate BRINGS, the papers signed
 * ON JOINING, and the papers signed ON LEAVING. They are collected by different people at different
 * times, so the sheet bands them separately.
 */
export type HiringDocumentGroup = "required" | "onboarding" | "offboarding";

export const HIRING_DOCUMENT_GROUP_SECTIONS: Record<HiringDocumentGroup, SectionName> = {
  offboarding: "Offboarding Documents",
  onboarding: "Onboarding Documents",
  required: "Required Employment Documents",
};

/** The order the three bands appear in, left to right. */
export const HIRING_DOCUMENT_GROUP_ORDER: HiringDocumentGroup[] = [
  "required",
  "onboarding",
  "offboarding",
];

/** One hiring-document definition, as the master sheet needs it. */
export type HiringDocumentColumnSpec = {
  id: string;
  name: string;
  group?: HiringDocumentGroup;
  /**
   * What the sheet prints as this document's header, when it differs from `<name> (document)`.
   *
   * HR's own sheet has exactly one: "Medical check (document) S 111", with the form number typed
   * after the suffix rather than before it. The owner asked for her sheet verbatim (2026-09-30),
   * and the two alternatives were worse — special-casing one header in the builder, or folding
   * "(document)" into the document's NAME, which would put it on the Hiring Documents screen.
   *
   * IT CANNOT DROP THE SUFFIX. See `documentColumnHeader`.
   */
  sheetHeader?: string | null;
};

/**
 * The header a document column prints.
 *
 * "(document)" IS LOAD-BEARING, not decoration, and that is why an override is CHECKED rather than
 * trusted. A document's name is typed by HR on the Hiring Documents screen, and a column header is
 * what the upload matches fields on — so a document one day named "Position" or "Status" would,
 * unsuffixed, be read back as that employee field and overwrite it with the word "Submitted". An
 * override that does not carry the suffix is therefore ignored, not honoured: the sheet falls back
 * to the computed header, which is the safe one. Pinned by `tests/employee-master-workbook.test.ts`.
 */
export function documentColumnHeader(document: HiringDocumentColumnSpec): string {
  const override = document.sheetHeader?.trim();
  if (override && override.includes("(document)")) return override;
  return `${document.name} (document)`;
}

/** The summary column that opens the hiring-documents block: "12 of 17". */
export const HIRING_DOCUMENTS_SUMMARY_KEY: HiringDocumentColumnKey = "doc:__summary__";

export const hiringDocumentColumnKey = (documentId: string): HiringDocumentColumnKey =>
  `doc:${documentId}`;

/** The document id a hiring-document column carries. */
export const hiringDocumentIdFromKey = (key: MasterColumnKey): string => key.slice("doc:".length);

/**
 * The hiring-document columns, appended after the static contract above.
 *
 * WHY THEY ARE BUILT RATHER THAN DECLARED. The owner asked for the Employee Master and the Hiring
 * Documents checklist to meet, so that one row holds everything known about a person (2026-09-29).
 * The checklist's columns are rows of `hiring_document_definitions` — HR adds one whenever a new
 * paper starts being collected — so the only honest way to put them on this sheet is to read them
 * at build time. They are READ-ONLY here: the sheet reports what the checklist says, and the
 * checklist stays the one place a document is filed.
 *
 * An empty list returns an empty array, so a workbook built before the tables existed, or by a
 * caller that chose not to pay for the lookup, is exactly the sheet it was before.
 *
 * THE THREE BANDS ARE GROUPED HERE, NOT LEFT TO THE CALLER'S ORDER. A definition carries its own
 * group, and the columns come out required → onboarding → offboarding, because the section band is
 * drawn from runs of equal section names: a definition out of group order would split its own band
 * into two and read as two different sections.
 */
export function buildHiringDocumentColumns(documents: HiringDocumentColumnSpec[]): MasterColumn[] {
  if (documents.length === 0) return [];

  const summary: MasterColumn = {
    header: "Hiring Documents Complete (reference)",
    key: HIRING_DOCUMENTS_SUMMARY_KEY,
    section: "REFERENCE (READ-ONLY)",
    width: 22,
    kind: "text",
    imported: false,
    readOnly: true,
    bandLabel: "",
    guide:
      "How many of this person's hiring documents are marked submitted, out of the documents the checklist tracks. Read-only — file a document on the Hiring Documents screen and this follows.",
  };

  const grouped = HIRING_DOCUMENT_GROUP_ORDER.flatMap((group) =>
    documents.filter((document) => (document.group ?? "required") === group),
  );

  return [
    summary,
    // Headers come from `documentColumnHeader`, which is where the "(document)" rule lives.
    ...grouped.map<MasterColumn>((document) => ({
      header: documentColumnHeader(document),
      key: hiringDocumentColumnKey(document.id),
      section: HIRING_DOCUMENT_GROUP_SECTIONS[document.group ?? "required"],
      width: 24,
      kind: "text",
      imported: false,
      readOnly: true,
      documentColumn: true,
      guide: `Checklist state for "${document.name}", with how many files are on file for it. Read-only — set it on the Hiring Documents screen.`,
      allowed: "Submitted, Pending, Missing — and \"Submitted · no file\" when the box is ticked but nothing is attached.",
    })),
  ];
}

/** The full sheet order: the fixed contract, then whatever hiring documents exist today. */
export function masterColumnsFor(documents: HiringDocumentColumnSpec[] = []): MasterColumn[] {
  return [...columns, ...buildHiringDocumentColumns(documents)];
}

/** Exported for the tests — the sheet contract a future edit must not break by accident. */
export const employeeMasterWorkbookContract = {
  columns,
  firstDataRow: FIRST_DATA_ROW,
  headerRow: HEADER_ROW,
  masterSheetName: "Employee Master",
  sectionRow: SECTION_ROW,
  spareRows: SPARE_ROWS,
};
