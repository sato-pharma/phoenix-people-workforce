import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildMappedAgentKeySet,
  isCrmUnmapped,
} from "../src/lib/probation/intelligence/dashboard-crm-mapping.ts";

function src(p: string) { return readFileSync(p, "utf8"); }

export function runProbationCrmUnmappedTests() {
  // Mapped set is canonicalized (case + legacy alias folded).
  const mapped = buildMappedAgentKeySet(["B-155", "aaa", "  MR-9 ", null, undefined, ""]);
  assert.ok(mapped.has("b-155"), "lowercased hr-id is in the set");
  assert.ok(mapped.has("aa"), "legacy alias aaa->aa folded");
  assert.ok(mapped.has("mr-9"), "trimmed + lowercased");
  assert.equal(mapped.size, 3, "null/undefined/empty dropped");

  // A rep present as a CRM agent (any casing) is mapped.
  assert.equal(isCrmUnmapped("b-155", mapped), false, "exact lowercase match");
  assert.equal(isCrmUnmapped("B-155", mapped), false, "case-insensitive match");
  assert.equal(isCrmUnmapped("AAA", mapped), false, "alias resolves to mapped aa");

  // A rep never seen as an agent is unmapped (the data-gap badge).
  assert.equal(isCrmUnmapped("D-42", mapped), true, "absent hr-id is unmapped");
  // A case with no resolvable hr-id is itself a mapping gap.
  assert.equal(isCrmUnmapped("", mapped), true, "empty hr-id is unmapped");
  assert.equal(isCrmUnmapped(null, mapped), true, "null hr-id is unmapped");

  // Empty agent universe → everyone unmapped.
  const none = buildMappedAgentKeySet([]);
  assert.equal(isCrmUnmapped("b-155", none), true, "no agents → unmapped");

  // Wiring: dashboard exposes crmUnmapped + openActions, filters/queries by them, badge in UI.
  const dash = src("src/lib/probation/intelligence/dashboard.ts");
  assert.match(dash, /crmUnmapped: boolean/, "DashboardRow has crmUnmapped");
  assert.match(dash, /openActions: number/, "DashboardRow has openActions");
  assert.match(dash, /getMappedAgentHrIds\(/, "dashboard checks CRM presence via the CRM single-door reader");
  assert.doesNotMatch(dash, /\.from\(\s*["'`]ireports360_visits["'`]/, "dashboard no longer queries the CRM mirror directly");
  assert.match(dash, /isCrmUnmapped\(c\.employee_hr_id, mappedAgentKeys\)/, "row is classified");
  assert.match(dash, /crmUnmapped: rows\.filter\(\(r\) => r\.crmUnmapped\)\.length/, "summary counts unmapped");
  assert.match(dash, /probation_development_actions/, "dashboard counts open dev actions");

  const view = src("src/components/probation/probation-dashboard-view.tsx");
  assert.match(view, /CRM unmapped/, "badge text present");
  assert.match(view, /f === "crmUnmapped"/, "filter matches crmUnmapped rows");
  assert.match(view, /CRM Unmapped/, "filter chip + summary tile present");
}
