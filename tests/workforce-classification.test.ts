import assert from "node:assert/strict";

import {
  buildSalesOwnershipContext,
  classifyEmployeeNode,
  classifySalesOwnership,
  deriveTeamKey,
  shouldFlagMissingAccessForEmployeeNode,
} from "../src/lib/workforce-classification.ts";

const employees = [
  {
    hrId: "B-101",
    fullName: "Mona Rep",
    employmentStatus: "active",
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Pedia",
    areaId: 11,
    managerHrId: "B-200",
  },
  {
    hrId: "B-102",
    fullName: "Yara Rep",
    employmentStatus: "active",
    jobTitle: "Medical Representative",
    lineId: 1,
    lineName: "Pedia",
    areaId: 12,
    managerHrId: "B-200",
  },
  {
    hrId: "B-103",
    fullName: "CNS Rep",
    employmentStatus: "active",
    jobTitle: "Medical Representative",
    lineId: 2,
    lineName: "CNS",
    managerHrId: "B-200",
  },
  {
    hrId: "B-200",
    fullName: "Dalia DSM",
    employmentStatus: "active",
    jobTitle: "District Sales Manager",
    lineId: 1,
    lineName: "Pedia",
    managerHrId: "B-900",
  },
  {
    hrId: "B-900",
    fullName: "Nour NSM",
    employmentStatus: "active",
    jobTitle: "National Sales Manager",
    lineId: 1,
    lineName: "Pedia",
  },
];

const context = buildSalesOwnershipContext({
  employees,
  lineIdByName: new Map([
    ["pedia", 1],
    ["cns", 2],
  ]),
  vacancies: [
    {
      vacancyId: 55,
      vacancyCode: "VAC-55",
      areaId: 30,
      areaName: "Nasr City",
      lineId: 1,
      lineName: "Pedia",
      managerHrId: "B-200",
      status: "open",
    },
  ],
});

export function runWorkforceClassificationTests() {
  const assigned = classifySalesOwnership(
    {
      employeeHrId: "B-101",
      line: "Pedia",
      managerHrId: "B-200",
      salesValue: 100,
    },
    context,
  );
  assert.equal(assigned.classification, "assigned_employee_sales");
  assert.equal(assigned.include_in_employee_total, true);
  assert.equal(assigned.include_in_manager_total, true);
  assert.equal(assigned.include_in_line_total, true);
  assert.equal(assigned.include_in_company_total, true);
  assert.equal(assigned.owner_employee_hr_id, "B-101");

  const nonAssignable = classifySalesOwnership(
    {
      employeeHrId: null,
      line: "Pedia",
      managerHrId: "B-200",
      territory: "Permanent Non-Assignable Area",
      salesValue: 250,
    },
    context,
  );
  assert.equal(nonAssignable.classification, "non_assignable_territory_sales");
  assert.equal(nonAssignable.include_in_employee_total, false);
  assert.equal(nonAssignable.include_in_manager_total, true);
  assert.equal(nonAssignable.include_in_line_total, true);
  assert.equal(nonAssignable.include_in_company_total, true);
  assert.equal(nonAssignable.include_in_vacancy_dashboard, false);
  assert.equal(nonAssignable.is_exception, false);

  const vacant = classifySalesOwnership(
    {
      employeeHrId: null,
      line: "Pedia",
      managerHrId: "B-200",
      territory: "Nasr City",
      salesValue: 300,
    },
    context,
  );
  assert.equal(vacant.classification, "vacant_territory_sales");
  assert.equal(vacant.include_in_employee_total, false);
  assert.equal(vacant.include_in_manager_total, true);
  assert.equal(vacant.include_in_line_total, true);
  assert.equal(vacant.include_in_company_total, true);
  assert.equal(vacant.include_in_vacancy_dashboard, true);
  assert.equal(vacant.is_exception, false);

  const lineLevel = classifySalesOwnership(
    {
      employeeHrId: null,
      managerHrId: null,
      lineId: 2,
      line: "CNS",
      salesValue: 125,
    },
    context,
  );
  assert.equal(lineLevel.classification, "line_level_sales");
  assert.equal(lineLevel.include_in_employee_total, false);
  assert.equal(lineLevel.include_in_manager_total, false);
  assert.equal(lineLevel.include_in_line_total, true);
  assert.equal(lineLevel.include_in_company_total, true);

  const others = classifySalesOwnership(
    {
      employeeHrId: null,
      employeeLookupKey: "Others",
      managerHrId: null,
      line: "Pedia",
      salesValue: 75,
    },
    context,
  );
  assert.equal(others.classification, "others_unassigned_sales");
  assert.equal(others.include_in_employee_total, false);
  assert.equal(others.include_in_vacancy_dashboard, false);
  assert.equal(others.include_in_company_total, true);

  const unresolved = classifySalesOwnership(
    {
      employeeHrId: null,
      managerHrId: null,
      line: null,
      salesValue: 50,
    },
    context,
  );
  assert.equal(unresolved.classification, "unresolved_sales_exception");
  assert.equal(unresolved.is_exception, true);
  assert.equal(unresolved.include_in_company_total, false);
  assert.equal(unresolved.derived_team_key, null);

  const activeNode = classifyEmployeeNode({
    hrId: "B-120",
    fullName: "Active Person",
    employmentStatus: "active",
    jobTitle: "Medical Representative",
  });
  assert.equal(activeNode.node_type, "active_employee");
  assert.equal(activeNode.eligible_for_login, true);
  assert.equal(shouldFlagMissingAccessForEmployeeNode({ hrId: "B-120", employmentStatus: "active" }, { hasAuthUser: true, hasAccessProfile: true }), false);
  assert.equal(shouldFlagMissingAccessForEmployeeNode({ hrId: "B-121", employmentStatus: "active" }, { hasAuthUser: true, hasAccessProfile: false }), true);

  const historical = classifyEmployeeNode({
    hrId: "H-1",
    fullName: "Historical Payroll Row",
    employmentStatus: "historical_payroll_record",
  });
  assert.equal(historical.node_type, "historical_record");
  assert.equal(historical.eligible_for_login, false);
  assert.equal(historical.eligible_for_headcount, false);
  assert.equal(shouldFlagMissingAccessForEmployeeNode({ hrId: "H-1", employmentStatus: "historical_payroll_record" }, { hasAuthUser: false, hasAccessProfile: false }), false);

  const system = classifyEmployeeNode({
    hrId: "SYS-1",
    fullName: "System Placeholder",
    nodeType: "system_placeholder",
  });
  assert.equal(system.node_type, "system_placeholder");
  assert.equal(system.eligible_for_login, false);
  assert.equal(system.eligible_for_headcount, false);

  const vacancyNode = classifyEmployeeNode({
    hrId: "VAC-1",
    fullName: "Vacant Medical Representative",
    employmentStatus: "vacant",
  });
  assert.equal(vacancyNode.node_type, "vacancy_node");
  assert.equal(vacancyNode.eligible_for_login, false);
  assert.equal(vacancyNode.eligible_for_vacancy_dashboard, true);

  const othersNode = classifyEmployeeNode({
    hrId: "O-1",
    fullName: "Others",
    lineName: "Pedia",
  });
  assert.equal(othersNode.node_type, "others_unassigned_node");
  assert.equal(othersNode.eligible_for_login, false);
  assert.equal(othersNode.eligible_for_sales_aggregation, true);

  assert.equal(
    deriveTeamKey({ managerHrId: "B-200", lineId: 1 }),
    "team:1:B-200",
  );
  assert.equal(
    deriveTeamKey({ managerHrId: "B-200", lineId: 1 }),
    deriveTeamKey({ managerHrId: "B-200", lineId: 1 }),
  );
  assert.notEqual(
    deriveTeamKey({ managerHrId: "B-200", lineId: 1 }),
    deriveTeamKey({ managerHrId: "B-200", lineId: 2 }),
  );
  assert.equal(
    deriveTeamKey({ lineId: 1 }),
    "team:1:line_level",
  );
  assert.equal(
    deriveTeamKey({ classification: "unresolved_sales_exception", lineId: 1 }),
    null,
  );
}

