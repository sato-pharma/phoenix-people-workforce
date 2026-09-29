import { strict as assert } from "node:assert";

import {
  getMissingEmployeeRecordFields,
  hasMissingEmployeeRecordData,
} from "../src/lib/employees/employee-record-health.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";

const completeEmployee: EmployeeDirectoryRow = {
  areaId: 1,
  areaName: "Cairo",
  bankAccount: "123456",
  bankName: "Bank",
  baseSalary: 1000,
  basicSalary: 1000,
  birthDate: "1990-01-01",
  contractRenewalDate: "2027-01-01",
  contractType: "full_time",
  createdAt: "2026-01-01T00:00:00.000Z",
  crmId: "CRM-1",
  crmUsername: "employee.one",
  departmentId: 1,
  departmentName: "Sales",
  education: "Bachelor",
  employmentStatus: "active",
  extraCostOfLiving: 100,
  fullName: "Employee One",
  displayName: "Employee One",
  nickname: null,
  fuelAllowance: 100,
  gender: "male",
  grossSalary: 1200,
  hasBankAccount: "yes",
  hasPhoto: false,
  healthCardStatus: null,
  healthCardNumber: null,
  healthCardReceivedDate: null,
  hireDate: "2024-01-01",
  hrId: "EMP-1",
  jobTitle: "Medical Representative",
  lastWorkingDate: null,
  lineId: 1,
  lineName: "Line A",
  managerHrId: "MGR-1",
  managerName: "Manager One",
  pendingManagerReplacementForHrId: null,
  medicalInsurance: 50,
  medicalInsuranceNumber: "MED-1",
  medicalInsuranceStatus: "yes",
  mobileNumber: "01000000000",
  nameAr: "Employee Arabic",
  nationalId: "12345678901234",
  netSalary: 1100,
  organogramVisible: true,
  payrollEligible: true,
  positionId: 1,
  positionTitle: "Medical Representative",
  regionName: "Greater Cairo",
  resignationDate: null,
  residenceAddress: "1 Main Street",
  residenceArea: "Maadi",
  residenceCity: "Cairo",
  residenceGeocodeStatus: "success",
  residenceLatitude: 30,
  residenceLongitude: 31,
  salaryPaymentMode: "two_parts",
  socialInsurance: 50,
  socialInsuranceWage: 4000,
  socialInsuranceNumber: "SOC-1",
  socialInsuranceStatus: "yes",
  taxes: 25,
  teamId: 1,
  teamName: "Team A",
  updatedAt: "2026-01-02T00:00:00.000Z",
  workEmail: "employee@example.com",
};

function employee(overrides: Partial<EmployeeDirectoryRow>) {
  return {
    ...completeEmployee,
    ...overrides,
  };
}

export function runEmployeeRecordHealthTests() {
  assert.equal(hasMissingEmployeeRecordData(completeEmployee), false);

  assert.deepEqual(getMissingEmployeeRecordFields(employee({ mobileNumber: null })), [
    "Mobile Number",
  ]);

  assert.equal(
    getMissingEmployeeRecordFields(
      employee({ bankAccount: null, bankName: null, hasBankAccount: "no" }),
    ).includes("Bank Account"),
    false,
  );

  assert.deepEqual(
    getMissingEmployeeRecordFields(
      employee({ bankAccount: null, bankName: null, hasBankAccount: "yes" }),
    ),
    ["Bank Name", "Bank Account"],
  );

  // The government health insurance booklet: received, with no number for it.
  assert.deepEqual(
    getMissingEmployeeRecordFields(employee({ healthCardNumber: null, healthCardStatus: "yes" })),
    ["Health Card Number"],
  );

  // AND NOTHING ELSE FIRES. The column shipped empty on every employee, so a rule on the STATUS
  // would flag the whole company on the day it landed — `completeEmployee` above carries a null
  // status and is asserted complete, which pins that. These three say the same for the number: it
  // is only ever asked for once somebody has said the booklet arrived.
  for (const healthCardStatus of [null, "no", "pending"]) {
    assert.equal(
      getMissingEmployeeRecordFields(employee({ healthCardNumber: null, healthCardStatus })).includes(
        "Health Card Number",
      ),
      false,
      `a health card status of ${String(healthCardStatus)} must not ask for a number`,
    );
  }
}
