import assert from "node:assert/strict";

import { scopeBadgeLabels } from "../src/components/employee-portal/scope-badge-labels.ts";

export function runScopeBadgeTests() {
  // 1) Exact label mapping required by Workstream 6.
  assert.equal(scopeBadgeLabels.self.label, "My data");
  assert.equal(scopeBadgeLabels.team.label, "My team");
  assert.equal(scopeBadgeLabels.hierarchy.label, "My hierarchy");
  assert.equal(scopeBadgeLabels.line.label, "My line");
  assert.equal(scopeBadgeLabels.company.label, "Company");
  assert.equal(scopeBadgeLabels.none.label, "No scope");

  // 2) "Company" must ONLY be produced by the company scope — never leak from
  //    any other scope (the badge must not over-state visibility).
  const companyLabelScopes = Object.entries(scopeBadgeLabels)
    .filter(([, presentation]) => presentation.label === "Company")
    .map(([scope]) => scope);
  assert.deepEqual(companyLabelScopes, ["company"], "only 'company' scope may show the 'Company' label");

  // 3) Every scope has a non-empty label, description, and tone (no blank chips).
  for (const [scope, presentation] of Object.entries(scopeBadgeLabels)) {
    assert.ok(presentation.label.trim().length > 0, `${scope} must have a label`);
    assert.ok(presentation.description.trim().length > 0, `${scope} must have a description`);
    assert.ok(presentation.toneClass.trim().length > 0, `${scope} must have a tone class`);
  }
}
