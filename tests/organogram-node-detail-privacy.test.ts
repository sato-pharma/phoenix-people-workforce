import { strict as assert } from "node:assert";

import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { canViewOrganogramSensitiveFields } from "../src/lib/reports/organogram.ts";
import { buildOrganogramEmployeeDetail } from "../src/lib/reports/organogram-employee-detail.ts";

// canViewOrganogramSensitiveFields reads only .scope and .role — build the smallest
// object that satisfies that, cast to the parameter type so the test does not depend
// on the full AccessContext shape.
type Access = Parameters<typeof canViewOrganogramSensitiveFields>[0];
function access(role: string, scope: "system" | "user" = "user"): Access {
  return { role, scope } as unknown as Access;
}

// A fully-populated directory row so the "hidden" assertions are meaningful: every
// sensitive value below is a distinctive sentinel we can grep the serialized payload
// for. Cast avoids restating all ~60 EmployeeDirectoryRow fields the builder ignores.
const EMPLOYEE = {
  hrId: "PD-0007",
  displayName: "Mona Adel",
  fullName: "Mona Adel Ibrahim",
  nameAr: "منى عادل",
  jobTitle: "District Sales Manager",
  positionTitle: "District Sales Manager",
  employmentStatus: "Active",
  departmentName: "Sales",
  lineName: "Pedia",
  areaName: "Cairo East",
  regionName: "Cairo",
  teamName: "Nasr City",
  managerName: "National Manager",
  managerHrId: "NSM-1",
  hireDate: "2020-03-12",
  contractType: "Permanent",
  contractRenewalDate: "2027-03-12",
  workEmail: "mona.adel@example.com",
  mobileNumber: "01000000001",
  crmUsername: "mona.crm",
  // Sentinels — each must NOT appear when canViewSensitive is false.
  nationalId: "SENTINEL_NATIONAL_ID",
  gender: "Female",
  birthDate: "1990-06-01",
  education: "Pharmacy",
  residenceCity: "SENTINEL_RESIDENCE_CITY",
  residenceArea: "SENTINEL_RESIDENCE_AREA",
  residenceAddress: "SENTINEL_RESIDENCE_ADDRESS",
  baseSalary: 12345,
  basicSalary: 8641,
  grossSalary: 13000,
  netSalary: 11000,
  fuelAllowance: 500,
  extraCostOfLiving: 250,
  medicalInsurance: 300,
  socialInsurance: 400,
  socialInsuranceWage: 9000,
  taxes: 700,
  salaryPaymentMode: "Bank Transfer",
  bankName: "SENTINEL_BANK_NAME",
  bankAccount: "SENTINEL_BANK_ACCOUNT",
} as unknown as EmployeeDirectoryRow;

const SENSITIVE_SENTINELS = [
  "SENTINEL_NATIONAL_ID",
  "SENTINEL_RESIDENCE_CITY",
  "SENTINEL_RESIDENCE_AREA",
  "SENTINEL_RESIDENCE_ADDRESS",
  "SENTINEL_BANK_NAME",
  "SENTINEL_BANK_ACCOUNT",
  "12345", // baseSalary, formatted as "EGP 12,345" — the raw digits must be absent
];

function sectionTitles(detail: { sections: Array<{ title: string }> }) {
  return detail.sections.map((section) => section.title);
}

function findItem(
  detail: { sections: Array<{ title: string; items: Array<{ label: string; value: string | null }> }> },
  sectionTitle: string,
  label: string,
): string | null | undefined {
  const section = detail.sections.find((candidate) => candidate.title === sectionTitle);
  return section?.items.find((item) => item.label === label)?.value;
}

export function runOrganogramNodeDetailPrivacyTests() {
  // ---- The allowlist: exactly HR / Finance / executive / system see everything ----
  // HR Advisory was on this list until the owner retired the seat on 2026-10-08 (now below).
  // HR Administration (the HR Operations Specialist, 2026-10-20) sees the personal and bank rows; the
  // organogram employee routes drop every money row for her with omitSalary (isSalaryBlindRole).
  for (const role of ["Super Admin", "CEO", "Finance Manager", "HR Operations", "HR Administration"]) {
    assert.equal(
      canViewOrganogramSensitiveFields(access(role)),
      true,
      `${role} must see sensitive organogram fields`,
    );
  }
  // System scope wins regardless of role string.
  assert.equal(canViewOrganogramSensitiveFields(access("Employee", "system")), true);

  // Every line-scoped manager, and every other non-HR role, must NOT.
  for (const role of [
    "National Sales Manager",
    "Regional Manager",
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
    "SFE Manager",
    "HR Specialist",
    // The retired HR Business Partner key, and the Talent Acquisition seat: she reads the company
    // chart to recruit against it, not the personal and pay fields behind each name.
    "HR Advisory",
    "HR Resourcing",
    "Employee",
  ]) {
    assert.equal(
      canViewOrganogramSensitiveFields(access(role)),
      false,
      `${role} must NOT see sensitive organogram fields`,
    );
  }

  // ---- Not allowed: Personal + Compensation are absent, and no sentinel leaks ----
  const gated = buildOrganogramEmployeeDetail(EMPLOYEE, {
    canViewSensitive: false,
    redactSalary: false,
  });
  assert.equal(gated.canViewSensitive, false);
  assert.deepEqual(sectionTitles(gated), [
    "Identity",
    "Placement",
    "Reporting & tenure",
    "Contact",
  ]);
  // Defense in depth: the sensitive values must never leave the server. Serialize the
  // whole payload (exactly what the route returns) and confirm no sentinel survives.
  const gatedJson = JSON.stringify(gated);
  for (const sentinel of SENSITIVE_SENTINELS) {
    assert.equal(
      gatedJson.includes(sentinel),
      false,
      `gated payload must not contain sensitive value ${sentinel}`,
    );
  }

  // ---- Allowed, salary NOT redacted: full record, money formatted ----
  const full = buildOrganogramEmployeeDetail(EMPLOYEE, {
    canViewSensitive: true,
    redactSalary: false,
  });
  assert.equal(full.canViewSensitive, true);
  assert.ok(sectionTitles(full).includes("Personal"), "Personal section present for HR/exec");
  assert.ok(sectionTitles(full).includes("Compensation"), "Compensation section present for HR/exec");
  assert.equal(findItem(full, "Personal", "National ID"), "SENTINEL_NATIONAL_ID");
  assert.equal(findItem(full, "Compensation", "Base salary"), "EGP 12,345");
  assert.equal(findItem(full, "Compensation", "Bank"), "SENTINEL_BANK_NAME");

  // ---- Allowed but salary redacted: money blanked, non-money kept ----
  const redacted = buildOrganogramEmployeeDetail(EMPLOYEE, {
    canViewSensitive: true,
    redactSalary: true,
  });
  assert.ok(sectionTitles(redacted).includes("Compensation"), "Compensation still present when redacted");
  assert.equal(
    findItem(redacted, "Compensation", "Base salary"),
    null,
    "salary must be blanked when redactSalary is true",
  );
  assert.equal(
    findItem(redacted, "Compensation", "Net salary"),
    null,
    "net salary must be blanked when redactSalary is true",
  );
  // Non-money compensation fields survive redaction — the carve-out blanks figures only.
  assert.equal(findItem(redacted, "Compensation", "Payment mode"), "Bank Transfer");
  assert.equal(findItem(redacted, "Compensation", "Bank"), "SENTINEL_BANK_NAME");
  // Personal (national ID, residence) is not salary, so it is still present when redacted.
  assert.equal(findItem(redacted, "Personal", "National ID"), "SENTINEL_NATIONAL_ID");
}
