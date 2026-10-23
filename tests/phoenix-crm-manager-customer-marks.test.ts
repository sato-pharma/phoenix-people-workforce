import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

import {
  customerGroups,
  customerPriority,
  frequencyPips,
  frequencyStanding,
  frequencyText,
  ownInsightKey,
  suggestedCustomers,
  type CustomerInsight,
} from "../src/lib/phoenix-crm/manager-customer-marks-rules.ts";

/**
 * The marks on each customer of a manager's plan board (owner, 2026-10-23: "give every customer a highlight
 * color … two dots as they are the two visits … color if the manager have visited this customer within the
 * month … a group of customers that have a common feature, also make them a color").
 */

function insight(overrides: Partial<CustomerInsight> = {}): CustomerInsight {
  return {
    grade: "A",
    listType: "PM",
    target: 3,
    repVisits: 0,
    lastRepVisit: null,
    withYou: 0,
    yourOwn: 0,
    pharmacy: null,
    marketing: [],
    ...overrides,
  };
}

const MARK = { requestId: "r1", code: "MR-1", status: "active", statusLabel: "Active", typeName: null, byName: false };

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

export function runPhoenixCrmManagerCustomerMarksTests(): void {
  // ── 1. Two of three is two filled pips and one open; over the number is drawn apart ──────────────
  assert.deepEqual(frequencyPips(2, 3), { pips: ["done", "done", "due"], more: 0 }, "an A customer seen twice of three");
  assert.deepEqual(frequencyPips(4, 3), { pips: ["done", "done", "done", "over"], more: 0 }, "a visit past the number is its own pip");
  assert.deepEqual(frequencyPips(2, null), { pips: ["done", "done"], more: 0 }, "with no number set, a visit is never 'over'");
  assert.deepEqual(frequencyPips(0, null), { pips: [], more: 0 }, "no number and no visit: nothing drawn");
  assert.equal(frequencyPips(9, 3).more, 3, "more than six pips are written as +n");

  assert.equal(frequencyStanding(2, 3), "behind");
  assert.equal(frequencyStanding(3, 3), "on");
  assert.equal(frequencyStanding(4, 3), "over", "over is a deviation, never 'on'");
  assert.equal(frequencyStanding(5, null), "none", "no grade target: no verdict at all");
  assert.equal(frequencyStanding(0, 0), "none", "a zero target is not set");

  assert.equal(frequencyText(2, 3, "October"), "2 of 3 in October");
  assert.equal(frequencyText(4, 3, "October"), "4 of 3 in October — 1 over");
  assert.equal(frequencyText(0, null, "October"), "No visits in October yet");
  assert.equal(frequencyText(1, null, "October"), "1 visit in October");

  // ── 2. "Go first": behind his number, or a marketing request on him — never just for his grade ─────
  const marks: Record<string, CustomerInsight> = {
    onTargetA: insight({ repVisits: 3 }),
    behindB: insight({ grade: "B", target: 2, repVisits: 0 }),
    marketingC: insight({ grade: "C", target: 1, repVisits: 1, marketing: [MARK] }),
    behindA: insight({ repVisits: 1 }),
    behindA2: insight({ repVisits: 2, withYou: 1 }),
    overA: insight({ repVisits: 5 }),
  };
  const suggested = suggestedCustomers(Object.keys(marks), marks);
  assert.equal(suggested.has("onTargetA"), false, "a customer on his number is never suggested for his grade alone");
  assert.equal(suggested.has("overA"), false, "an over-visited customer is never suggested");
  assert.equal(suggested.size, 3, "three at most");
  assert.ok(suggested.has("behindA"), "the A customer two visits short is first");
  assert.ok(customerPriority(marks.behindA) > customerPriority(marks.behindA2), "fewer visits and unseen by him ranks higher");
  assert.ok(customerPriority(marks.overA) < customerPriority(marks.onTargetA), "over the number goes down");
  assert.ok(
    customerPriority(insight({ grade: "C", target: 1, repVisits: 1, marketing: [MARK] })) > customerPriority(insight({ grade: "C", target: 1, repVisits: 1 })),
    "a live marketing request lifts him",
  );

  // ── 3. The groups: the fixed ones only when someone is in them, and a shared feature only when it sets a group APART ──
  const customers = [
    { id: "d1", speciality: "Pediatrics", place: "Smouha", pharmacy: "El Shifa" },
    { id: "d2", speciality: "Pediatrics", place: "Smouha", pharmacy: "El Shifa" },
    { id: "d3", speciality: "Pediatrics", place: "Smouha", pharmacy: "El Shifa" },
    { id: "d4", speciality: "ENT", place: "Smouha", pharmacy: null },
  ];
  const groupMarks: Record<string, CustomerInsight> = {
    d1: insight({ repVisits: 1, marketing: [MARK] }),
    d2: insight({ repVisits: 3, withYou: 1 }),
    d3: insight({ repVisits: 0 }),
    d4: insight({ repVisits: 3, yourOwn: 1 }),
  };
  const groups = customerGroups(customers, groupMarks, "October");
  const byKey = new Map(groups.map((group) => [group.key, group.ids]));
  assert.deepEqual(byKey.get("marketing"), ["d1"], "the marketing group holds the customer the request stands on");
  assert.deepEqual(byKey.get("behind"), ["d1", "d3"]);
  assert.deepEqual(byKey.get("unseen"), ["d3"], "not seen this month");
  assert.deepEqual(byKey.get("with-you"), ["d2", "d4"], "seen by him with the rep, or alone");
  assert.equal(byKey.has("over"), false, "an empty group is never offered");
  assert.deepEqual(byKey.get("speciality:pediatrics"), ["d1", "d2", "d3"], "three Pediatrics customers of four are a group");
  assert.equal(byKey.has("speciality:ent"), false, "one ENT customer is no group");
  assert.equal(byKey.has("place:smouha"), false, "a feature every customer shares tells him nothing");
  assert.deepEqual(byKey.get("pharmacy:el shifa"), ["d1", "d2", "d3"], "customers listed with one pharmacy are one stop");

  assert.equal(ownInsightKey("abc"), "m:abc", "Manager's own list is keyed apart from the rep lists");

  // ── 4. The read: his own territories only, the countable visits, and a name match only when it is unique ──
  const server = source("src/lib/phoenix-crm/server/manager-customer-marks.ts");
  assert.match(server, /const writer = assertManagerPlanWriter\(viewer\);/, "only a manager who plans a week reads the marks");
  assert.match(
    server,
    /if \(seatIds\.some\(\(seatId\) => !reachById\.has\(seatId\)\)\) throw forbiddenError\(/,
    "a territory outside the ones he plans in refuses the whole read",
  );
  assert.match(server, /\.from\("phoenix_crm_countable_visits"\)/, "the rep's visits are the countable ones");
  assert.equal(/\.from\("phoenix_crm_visits"\)/.test(server), false, "never the raw visits table — an unapproved off-plan visit counts nowhere");
  assert.match(server, /if \(hits\.length === 1\) \{/, "a name match lands only on a unique customer — namesakes are real");
  assert.match(server, /countsAsPlannersVisitWithRep\(/, "'with you' is the plan report's own rule");

  // ── 5. The board shows them, on both lists, and the rep's own screens never import them ─────────
  const board = source("src/components/phoenix-crm/manager-plan-board.tsx");
  assert.equal((board.match(/<CustomerMarks /g) ?? []).length, 3, "the rep's list, the area list and Manager's own list each carry the marks");
  assert.equal((board.match(/<CustomerGroupBar /g) ?? []).length, 2, "both customer lists carry the group bar");
  for (const repScreen of ["src/components/phoenix-crm/plan-board.tsx", "src/components/phoenix-crm/list-tab.tsx", "src/components/phoenix-crm/visit-log-form.tsx"]) {
    assert.equal(readFileSync(repScreen, "utf8").includes("manager-customer-marks"), false, `${repScreen} is the rep's — he never sees the manager's marks`);
  }
}
