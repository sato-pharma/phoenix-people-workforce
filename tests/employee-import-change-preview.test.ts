import assert from "node:assert/strict";

import { buildImportChangePreview } from "../src/lib/employees/employee-import-change-preview.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import type { EmployeeImportRecord } from "../src/lib/imports/employee-import-types.ts";

// The confirm step used to say "247 to update" and offer a button. This is the diff that replaces
// that count, so its failure modes are the ones that make the number lie in a different way:
//
//   1. treating a BLANK cell as "change this to nothing" — the confirm route skips blanks, so
//      every unfilled cell on a partially completed sheet would appear as a change, and the three
//      real ones would be buried in three hundred invented ones
//   2. reporting a change where the value is the same in a different shape — "10000" vs 10000,
//      a date with a time on it, "yes" against true
//   3. dropping a person because their HR_ID was typed in a different case than it is stored,
//      which would hide their changes from the preview while the import still applied them
//   4. losing money changes among the rest

function employee(overrides: Partial<EmployeeDirectoryRow> = {}): EmployeeDirectoryRow {
  return {
    areaId: 1,
    areaName: "Delta (3)",
    bankAccount: "EG1",
    bankName: "CIB",
    baseSalary: 10000,
    basicSalary: 7000,
    birthDate: "1990-04-11T00:00:00Z",
    contractRenewalDate: null,
    contractType: "Full time",
    createdAt: "2024-01-01T00:00:00Z",
    crmId: "C-1",
    crmUsername: "user1",
    departmentId: 2,
    departmentName: "Sales",
    displayName: "Omar Gawish",
    education: "Pharmacy",
    employmentStatus: "active",
    extraCostOfLiving: 500,
    fuelAllowance: 800,
    fullName: "Omar Gawish",
    gender: "Male",
    grossSalary: 11500,
    hasBankAccount: "yes",
    hasCv: false,
    hasPhoto: false,
    healthCardStatus: null,
    healthCardNumber: null,
    healthCardReceivedDate: null,
    hireDate: "2022-06-01T00:00:00Z",
    hrId: "A-12",
    jobTitle: "Medical Rep",
    lastWorkingDate: null,
    lineId: 3,
    lineName: "CNS",
    managerHrId: "A-1",
    managerName: "Boss",
    medicalInsurance: 200,
    medicalInsuranceNumber: "M1",
    medicalInsuranceStatus: "yes",
    mobileNumber: "01000000000",
    nameAr: null,
    nationalId: "29004110100011",
    netSalary: 11300,
    nickname: null,
    organogramVisible: true,
    payrollEligible: true,
    pendingManagerReplacementForHrId: null,
    positionId: 5,
    positionTitle: "Medical Rep",
    regionName: "Delta",
    residenceAddress: "1 Street",
    residenceArea: "Dokki",
    residenceCity: "Giza",
    residenceGeocodeStatus: null,
    residenceLatitude: null,
    residenceLongitude: null,
    resignationDate: null,
    salaryPaymentMode: "two_parts",
    socialInsurance: 300,
    socialInsuranceNumber: "S1",
    socialInsuranceStatus: "yes",
    socialInsuranceWage: 6000,
    taxes: 400,
    teamId: 9,
    teamName: "Team A",
    updatedAt: "2026-09-01T00:00:00Z",
    workEmail: "omar@example.com",
    ...overrides,
  } as EmployeeDirectoryRow;
}

function record(overrides: Partial<EmployeeImportRecord> = {}): EmployeeImportRecord {
  return {
    compensation: {
      baseSalary: null,
      basicSalary: null,
      extraCostOfLiving: null,
      fuelAllowance: null,
      grossSalary: null,
      medicalInsurance: null,
      netSalary: null,
      paymentMode: null,
      socialInsurance: null,
      taxes: null,
      ...(overrides.compensation ?? {}),
    },
    hrId: "A-12",
    rowNumber: 6,
    rowType: "employee",
    ...overrides,
  } as EmployeeImportRecord;
}

export async function runEmployeeImportChangePreviewTests() {
  const directory = [employee()];

  // ── 1. a wholly blank row changes nothing ───────────────────────────────────
  const blank = buildImportChangePreview({ employees: directory, records: [record()] });
  assert.equal(
    blank.people.length,
    0,
    "a row of blank cells is not a row of changes — the confirm route skips blanks rather than writing them",
  );
  assert.equal(blank.unchangedPeopleCount, 1, "the person is matched, just unchanged");
  assert.equal(blank.fieldChangeCount, 0);

  // ── 2. values that are the same in a different shape are not changes ────────
  const sameShape = buildImportChangePreview({
    employees: directory,
    records: [
      record({
        birthDate: "1990-04-11T00:00:00Z",
        compensation: { baseSalary: 10000.001 } as never,
        fullName: "  Omar Gawish  ",
        organogramVisible: "Yes",
        payrollEligible: "yes",
      }),
    ],
  });
  assert.equal(
    sameShape.people.length,
    0,
    'no change should be reported for a trimmed name, a date with a time on it, "yes" against true, ' +
      "or a money value differing by a fraction of a piastre",
  );

  // ── 3. real changes, with money called out ──────────────────────────────────
  const changed = buildImportChangePreview({
    employees: directory,
    records: [
      record({
        compensation: { baseSalary: 12000 } as never,
        jobTitle: "District Manager",
        workEmail: "omar.gawish@example.com",
      }),
    ],
  });
  assert.equal(changed.people.length, 1);
  assert.equal(changed.fieldChangeCount, 3);
  assert.equal(changed.moneyChangeCount, 1, "the salary move is counted separately");

  const person = changed.people[0];
  assert.equal(person.hrId, "A-12");
  assert.equal(person.fullName, "Omar Gawish", "a change names the person, not just their id");
  assert.equal(person.rowNumber, 6, "the row number in the uploaded file is carried through");

  const salary = person.changes.find((change) => change.label === "Base Salary");
  assert.ok(salary, "the base salary change should be present");
  assert.equal(salary.before, "10,000.00");
  assert.equal(salary.after, "12,000.00");
  assert.equal(salary.isMoney, true);
  assert.equal(salary.group, "Payroll");

  const title = person.changes.find((change) => change.label === "Title");
  assert.equal(title?.before, "Medical Rep");
  assert.equal(title?.after, "District Manager");
  assert.equal(title?.isMoney, false);

  // ── 4. a value arriving where there was none reads as an em dash, never blank ──
  const filled = buildImportChangePreview({
    employees: directory,
    records: [record({ nameAr: "عمر جاويش" })],
  });
  const arabic = filled.people[0]?.changes.find((change) => change.label === "Full Arabic Name");
  assert.ok(arabic, "setting a previously empty field is a change");
  assert.equal(arabic.before, "—", "an empty current value renders as an em dash, not as nothing");
  assert.equal(arabic.after, "عمر جاويش");

  // ── 4b. total years of experience is a NUMBER on both sides ─────────────────
  const EXPERIENCE = "Total years of experience";
  const experienceOf = (stored: number | undefined, uploaded: number | null) =>
    buildImportChangePreview({
      employees: [employee({ totalExperienceYears: stored })],
      records: [record({ totalExperienceYears: uploaded })],
    }).people[0]?.changes.find((change) => change.label === EXPERIENCE);
  assert.equal(experienceOf(2, 2), undefined, "the same number HR exported is not a change");
  assert.equal(experienceOf(2, null), undefined, "a blank cell is not a change — the confirm step skips it");
  const firstFill = experienceOf(undefined, 0);
  assert.ok(firstFill, "0 years over nothing is a change — 0 is a value, not a blank");
  assert.equal(firstFill.before, "—");
  assert.equal(firstFill.after, "0");
  assert.equal(firstFill.isMoney, false, "years of experience is never counted as a pay move");
  assert.equal(experienceOf(2, 2.5)?.after, "2.5", "the one decimal is shown as typed");

  // ── 5. HR_IDs match case-insensitively, as the importer resolves them ───────
  const lowerCase = buildImportChangePreview({
    employees: directory,
    records: [record({ hrId: "a-12", jobTitle: "District Manager" })],
  });
  assert.equal(
    lowerCase.people.length,
    1,
    "a differently-cased HR_ID is the same person — matching exactly would hide their changes " +
      "from the preview while the import still applied them",
  );

  // ── 6. a row for somebody not in the directory is a creation, not a diff ────
  const unknown = buildImportChangePreview({
    employees: directory,
    records: [record({ fullName: "New Person", hrId: "Z-99" })],
  });
  assert.equal(unknown.people.length, 0);
  assert.equal(unknown.unchangedPeopleCount, 0, "an unmatched row is not an unchanged person either");

  // ── 7. the insurance job title, whose "before" comes from the route ──────────
  //
  // It is the one field in this diff that is NOT on the employee record — it lives in
  // `employee_hiring_profile` — so the dry-run route sends it and the builder takes it as a map.
  const LABEL = "Social Insurance Job Title";
  const retitled = buildImportChangePreview({
    employees: directory,
    records: [record({ socialInsuranceJobTitle: "مندوب دعاية طبية" })],
    socialInsuranceJobTitles: { "a-12": "مندوب مبيعات" },
  });
  const titleChange = retitled.people[0]?.changes.find((change) => change.label === LABEL);
  assert.ok(titleChange, "a different Arabic title is a change");
  assert.equal(titleChange.before, "مندوب مبيعات");
  assert.equal(titleChange.after, "مندوب دعاية طبية");
  assert.equal(titleChange.group, "Payroll");

  // The same title is NOT a change — and this is the common case, because HR downloads the sheet
  // with the titles already in it and uploads it back with two salaries edited.
  const sameTitle = buildImportChangePreview({
    employees: directory,
    records: [record({ socialInsuranceJobTitle: "مندوب مبيعات" })],
    socialInsuranceJobTitles: { "a-12": "مندوب مبيعات" },
  });
  assert.equal(sameTitle.people.length, 0, "an unchanged title must not be reported as a change");

  // An hr id MISSING from a map that WAS supplied means no profile row — genuinely blank.
  const firstTitle = buildImportChangePreview({
    employees: directory,
    records: [record({ socialInsuranceJobTitle: "مندوب مبيعات" })],
    socialInsuranceJobTitles: {},
  });
  assert.equal(firstTitle.people[0]?.changes.find((change) => change.label === LABEL)?.before, "—");

  // 🔴 AND AN ABSENT MAP IS NOT THE SAME THING. With no map the "before" is UNKNOWN, and rendering
  // unknown as blank would report every filled title cell as a change from nothing — on every
  // upload of a sheet that simply carries the titles it was exported with. The row is dropped.
  const noMap = buildImportChangePreview({
    employees: directory,
    records: [record({ socialInsuranceJobTitle: "مندوب مبيعات" })],
  });
  assert.equal(
    noMap.people.length,
    0,
    "with no titles loaded the insurance title row must be dropped, not invented from a blank",
  );
}
