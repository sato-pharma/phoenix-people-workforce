// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MONTHLY COST WORKBOOK (owner, 27 Nov 2026: "export XLX sheet with the employee and the monthly cost
// on him … cost for the company and for him, and the details").
//
// It is the Cost tab's "Who pays each month" as a file, built from the very same `MonthlySplit`, so the
// sheet and the tab can never disagree:
//   * "Monthly cost": one row per employee — what the company pays, what the employee pays, the two
//     together, and how the employee's figure is made (their 30% of their own cover, at least EGP 120;
//     their family in full; EGP 85 life insurance a person).
//   * "Details": one row per person covered — the employee and each spouse and child — with their plan,
//     age band, cover start and month of cover, and who carries it.
//
// 🔴 It carries amounts, so its route asserts medical_insurance_invoices (Super Admin only) before
// anything is read, like the Medical Cover Statement. It shows amounts, never the split's percentages
// beyond the heading that names the rule. Pure: the read is getMedicalInsuranceMonthlyCost in ./service.ts.
// Pinned by tests/medical-insurance.test.ts.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable, type CellValue } from "@/lib/export/house-table-workbook";
import { houseGeneratedRow } from "@/lib/export/house-xlsx-identity";
import { spreadsheetSafeText } from "@/lib/export/spreadsheet-safe";

import { EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY, LIFE_INSURANCE_PER_PERSON_MONTHLY, MONTHLY_SPLIT_ASSUMPTIONS, type MonthlySplit, type MonthlySplitPerson, type MonthlySplitRow } from "./monthly-split";
import { MEMBER_TYPE_WORDS } from "./view";

const MONEY = "#,##0.00";
const text = (value: string | null | undefined): string => spreadsheetSafeText(value ?? "");

function day(value: string | null | undefined): string {
  if (!value) return "";
  const [year, month, date] = value.slice(0, 10).split("-");
  return `${date}/${month}/${year}`;
}

const round = (value: number): number => Math.round(value * 100) / 100 || 0;

/** The employee's own row name, or, for a relative whose employee left the register, the relative's. */
function rowName(row: MonthlySplitRow): string {
  return row.employee?.name ?? row.family[0]?.name ?? "";
}

function rowNote(row: MonthlySplitRow): string {
  const notes: string[] = [];
  if (!row.employee) notes.push("Their employee is not on the register, so the cover is all on the family");
  if (row.raisedToMinimum) notes.push(`The employee's 30% was under EGP ${EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY}, so it was raised to EGP ${EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY}`);
  if (row.unpriced > 0) notes.push(`${row.unpriced === 1 ? "1 person" : `${row.unpriced} people`} cannot be priced, so this row is short by them`);
  if (row.employee?.startsOn) notes.push(`Cover starts ${day(row.employee.startsOn)}`);
  return notes.join(". ");
}

/** What a row costs the company and the employee together, a month. */
export function monthlyCostRowTotal(row: Pick<MonthlySplitRow, "companyPays" | "employeePays">): number {
  return round(row.companyPays + row.employeePays);
}

export async function buildMedicalInsuranceMonthlyCostWorkbook(input: {
  asOf: string;
  exportedByName: string;
  generatedAtIso: string;
  policy: { insurer: string; policyNumber: string | null; startsOn: string; endsOn: string };
  split: MonthlySplit;
}): Promise<ArrayBuffer> {
  const { split } = input;
  const rows = [...split.rows].sort((a, b) => rowName(a).localeCompare(rowName(b)));
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date(input.generatedAtIso);
  workbook.creator = "Phoenix Workforce";
  const policyWords = input.policy.policyNumber ? `Policy ${input.policy.policyNumber}` : "Policy number not recorded yet";

  buildHouseCoverSheet(workbook, {
    confidentialNote: "Confidential. This workbook names employees and their family members, with what each one costs a month.",
    rows: [
      ["Insurer", input.policy.insurer],
      ["Policy", policyWords],
      ["Policy year", `${day(input.policy.startsOn)} to ${day(input.policy.endsOn)}`],
      ["Figures as of", day(input.asOf)],
      ["Employees", String(split.totals.employees)],
      ["People covered", String(split.totals.people)],
      ["The company pays a month", `EGP ${split.totals.companyPays.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`],
      ["Employees pay a month", `EGP ${split.totals.employeesPay.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`],
      ["Cover and life insurance a month", `EGP ${split.totals.total.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`],
      ["Cannot be priced", split.unpriced === 0 ? "Nobody" : `${split.unpriced} ${split.unpriced === 1 ? "person" : "people"}, named on the sheets`],
      ["How it is split", `The company carries 70% of the employee's own cover and the employee 30%, never less than EGP ${EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY}. A spouse or child is the employee's in full, and EGP ${LIFE_INSURANCE_PER_PERSON_MONTHLY} of life insurance a month is added on the employee for every person covered.`],
      ...MONTHLY_SPLIT_ASSUMPTIONS.map((point, index): [string, string] => [index === 0 ? "How a month is priced" : "", point]),
      ["Exported by", input.exportedByName],
      houseGeneratedRow(input.generatedAtIso),
    ],
    subtitle: `${input.policy.insurer}, ${policyWords}`,
    title: "Medical insurance — monthly cost per employee",
  });

  const summary = workbook.addWorksheet("Monthly cost");
  summary.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  writeHouseTable(summary, 1, {
    columns: [
      { label: "HR ID", width: 10 },
      { label: "Employee", width: 32 },
      { label: "Plan", width: 7 },
      { label: "Age band", width: 11 },
      { label: "Own cover a month", numFmt: MONEY, right: true, width: 13 },
      { label: "Company pays", numFmt: MONEY, right: true, width: 13 },
      { label: `Employee's own share (30%, at least ${EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY})`, numFmt: MONEY, right: true, width: 16 },
      { label: "Family covered", right: true, width: 9 },
      { label: "Family a month (on the employee)", numFmt: MONEY, right: true, width: 14 },
      { label: "People covered", right: true, width: 9 },
      { label: `Life insurance (${LIFE_INSURANCE_PER_PERSON_MONTHLY} a person)`, numFmt: MONEY, right: true, width: 13 },
      { label: "Employee pays a month", numFmt: MONEY, right: true, width: 13 },
      { label: "Company and employee a month", numFmt: MONEY, right: true, width: 14 },
      { label: "Notes", width: 44 },
    ],
    rows: rows.map((row): CellValue[] => [
      text(row.hrId),
      text(rowName(row)),
      row.employee?.category ?? "",
      row.employee?.band ?? "",
      row.employee ? row.ownMonthly : null,
      row.employee ? row.companyPays : null,
      row.employee ? row.employeeOwnShare : null,
      row.family.length,
      row.familyMonthly,
      row.people,
      row.lifeInsurance,
      row.employeePays,
      monthlyCostRowTotal(row),
      text(rowNote(row)),
    ]),
    title: `${rows.length} ${rows.length === 1 ? "row" : "rows"}, as of ${day(input.asOf)}`,
    totals: [
      "",
      "Total a month",
      "",
      "",
      round(rows.reduce((sum, row) => sum + (row.employee ? row.ownMonthly : 0), 0)),
      split.totals.companyPays,
      round(rows.reduce((sum, row) => sum + (row.employee ? row.employeeOwnShare : 0), 0)),
      rows.reduce((sum, row) => sum + row.family.length, 0),
      round(rows.reduce((sum, row) => sum + row.familyMonthly, 0)),
      split.totals.people,
      split.totals.lifeInsurance,
      split.totals.employeesPay,
      split.totals.total,
      "",
    ],
  });

  const details = workbook.addWorksheet("Details");
  details.views = [{ showGridLines: false, state: "frozen", ySplit: 2 }];
  const people = rows.flatMap((row) => [
    ...(row.employee ? [{ person: row.employee, row }] : []),
    ...row.family.map((person) => ({ person, row })),
  ]);
  const whoCarries = (person: MonthlySplitPerson, row: MonthlySplitRow): string => {
    if (person.monthly === null) return `Cannot be priced: ${person.unpricedReason ?? "no reason recorded"}`;
    if (person.memberType !== "employee") return "The employee, in full";
    return row.raisedToMinimum ? `Shared; the employee's share raised to EGP ${EMPLOYEE_MINIMUM_OWN_SHARE_MONTHLY}` : "Shared, company 70% and employee 30%";
  };
  writeHouseTable(details, 1, {
    columns: [
      { label: "HR ID", width: 10 },
      { label: "Employee", width: 30 },
      { label: "Person covered", width: 30 },
      { label: "Relation", width: 10 },
      { label: "Plan", width: 7 },
      { label: "Age band", width: 11 },
      { label: "Cover starts (when later)", width: 13 },
      { label: "Cover a month", numFmt: MONEY, right: true, width: 13 },
      { label: "Company pays", numFmt: MONEY, right: true, width: 13 },
      { label: "On the employee", numFmt: MONEY, right: true, width: 13 },
      { label: "Life insurance", numFmt: MONEY, right: true, width: 12 },
      { label: "Who carries it", width: 40 },
    ],
    rows: people.map(({ person, row }): CellValue[] => {
      const own = person.memberType === "employee";
      return [
        text(row.hrId),
        text(row.employee?.name ?? "Not on the register"),
        text(person.name),
        MEMBER_TYPE_WORDS[person.memberType],
        person.category,
        person.band ?? "",
        day(person.startsOn),
        person.monthly,
        own ? row.companyPays : 0,
        person.monthly === null ? null : own ? row.employeeOwnShare : person.monthly,
        LIFE_INSURANCE_PER_PERSON_MONTHLY,
        text(whoCarries(person, row)),
      ];
    }),
    title: `${people.length} ${people.length === 1 ? "person" : "people"} covered`,
  });

  return workbook.xlsx.writeBuffer() as unknown as Promise<ArrayBuffer>;
}
