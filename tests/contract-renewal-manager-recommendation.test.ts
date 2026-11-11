import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  contractRecommendHref,
  isInManagerChain,
  managerChainOf,
  parseRecommendationInput,
  teamRenewalsFor,
} from "../src/lib/contracts/manager-recommendation.ts";
import type { ContractRow } from "../src/lib/contracts/types.ts";
import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import { resolvePortalTwin } from "../src/lib/navigation/portal-twins.ts";

// The contract renewal reminder asks the manager chain for a "manager recommendation". Until
// 2026-11-11 its button opened /contracts — the board only HR and the Super Admin can open — so every
// district manager and the National Sales Manager was dropped on the portal home: "people are
// redirected to nothing" (owner). These pin where the button goes, who may answer, and that a
// portal-shell manager reaches the portal pages instead of the portal home.

function person(hrId: string, managerHrId: string | null, name = hrId): EmployeeDirectoryRow {
  return { displayName: name, fullName: name, hrId, managerHrId } as unknown as EmployeeDirectoryRow;
}

// CEO AA → NSM B-122 → DM B-119 → rep B-500; B-501 reports to another DM, B-118.
const directory = [
  person("AA", null),
  person("B-122", "AA"),
  person("B-119", "B-122"),
  person("B-118", "B-122"),
  person("B-500", "B-119", "Rep One"),
  person("B-501", "B-118", "Rep Two"),
];

function contractRow(hrId: string, renewalDate: string): ContractRow {
  return {
    area: "Giza",
    contract_id: null,
    contract_renewal_date: renewalDate,
    contract_signed_date: "2025-01-01",
    crm_id: null,
    full_name: hrId,
    hr_id: hrId,
    job_title: "Medical Representative",
    line: "CNS",
    manager_hr_id: null,
    manager_recommendations: [],
    renewal_day: Number(renewalDate.slice(8, 10)),
    workflow: null,
  };
}

export function runContractRenewalManagerRecommendationTests() {
  // ── Who may answer: everyone ABOVE the employee, the whole chain, never a peer or the person ──
  const rep = directory.find((row) => row.hrId === "B-500")!;
  assert.deepEqual(
    managerChainOf(rep, directory).map((row) => row.hrId),
    ["B-119", "B-122", "AA"],
    "the chain is followed to the top, nearest manager first",
  );
  assert.equal(isInManagerChain("B-119", rep, directory), true, "the direct manager may recommend");
  assert.equal(isInManagerChain("b-122", rep, directory), true, "the manager's manager may recommend (and HR ids match case-blind)");
  assert.equal(isInManagerChain("AA", rep, directory), true, "the top of the chain may recommend");
  assert.equal(isInManagerChain("B-118", rep, directory), false, "a peer district manager may not recommend on another DM's rep");
  assert.equal(isInManagerChain("B-500", rep, directory), false, "nobody recommends on their own renewal");
  assert.equal(isInManagerChain(null, rep, directory), false, "a viewer with no HR id is in nobody's chain");

  // A bad manager link must not hang the page.
  const loop = [person("X-1", "X-2"), person("X-2", "X-1")];
  assert.deepEqual(managerChainOf(loop[0], loop).map((row) => row.hrId), ["X-2"], "a manager loop stops instead of spinning");

  // ── The answer ──
  assert.deepEqual(
    parseRecommendationInput({ employeeHrId: " B-500 ", note: "  strong year  ", recommendation: "renew" }),
    { employeeHrId: "B-500", note: "strong year", recommendation: "renew" },
  );
  assert.equal(parseRecommendationInput({ employeeHrId: "B-500", note: "   ", recommendation: "do_not_renew" }).note, null);
  assert.throws(() => parseRecommendationInput({ employeeHrId: "B-500", recommendation: "maybe" }), /Renew or Do not renew/);
  assert.throws(() => parseRecommendationInput({ recommendation: "renew" }), /Choose the employee/);
  assert.throws(() => parseRecommendationInput({ employeeHrId: "B-500", note: "x".repeat(1001), recommendation: "renew" }), /under 1000/);

  // ── The manager's own list: his team, the next 90 days, soonest first ──
  const today = new Date(2026, 10, 11);
  const team = teamRenewalsFor(
    "B-119",
    [contractRow("B-500", "2026-12-01"), contractRow("B-501", "2026-11-20"), contractRow("B-119", "2026-11-15")],
    directory,
    today,
  );
  assert.deepEqual(team.map((item) => item.hrId), ["B-500"], "a DM sees only his own team, never a peer's rep or himself");
  assert.equal(team[0].href, "/contracts/recommend/B-500");
  assert.equal(team[0].daysUntil, 20);
  assert.deepEqual(
    teamRenewalsFor("B-122", [contractRow("B-500", "2027-06-01"), contractRow("B-501", "2026-11-20")], directory, today).map((item) => item.hrId),
    ["B-501"],
    "a renewal beyond 90 days waits; the NSM sees both his DMs' teams",
  );

  // ── Where the reminder's button goes ──
  assert.equal(contractRecommendHref("B-500"), "/contracts/recommend/B-500");
  const route = readFileSync("app/api/notifications/contract-renewals/route.ts", "utf8").replace(/\s+/g, " ");
  assert.match(
    route,
    /const actionUrl = contractRecommendHref\(employee\.hrId\);/,
    "the renewal reminder opens the recommend page, not the HR-only /contracts board",
  );
  assert.ok(!/const actionUrl = "\/contracts";/.test(route), "the reminder must never point back at the bare /contracts board");

  // ── A portal-shell manager reaches the portal pages, not the portal home ──
  assert.equal(
    resolvePortalTwin("/contracts/recommend/B-500", "District Manager"),
    "/employee-portals/contracts/recommend/B-500",
    "a district manager following the reminder lands on the portal recommend page",
  );
  assert.equal(
    resolvePortalTwin("/contracts", "National Sales Manager"),
    "/employee-portals/contracts",
    "the reminders already sent with the old /contracts button land on the manager's team renewals",
  );
}
