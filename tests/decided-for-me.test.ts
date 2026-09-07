import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { normalizeDecidedForMeOutcome } from "../src/lib/action-center/decided-for-me.ts";

// "Decided for you" lists decisions somebody ELSE took on your team and your lines. Two things
// make it either useful or actively misleading, and both are guarded here.
//
// 1. The outcome label. Four modules spell their outcomes four different ways, and getting one
//    wrong prints "Approved" beside a request that was rejected — worse than showing nothing,
//    because the reader has no reason to doubt it.
//
// 2. The self-decision filter. Without it the list shows the viewer his OWN decisions back to
//    him under the heading "decided for you", which is exactly the opposite of what the feature
//    claims. That guard is one `if (isMe(...)) continue;` per module and nothing else forces it
//    to exist, so it is pinned by source: reaching it behaviourally needs a live database, and
//    the regression to catch is a FIFTH module added later without the guard.

const SOURCE_PATH = new URL("../src/lib/action-center/decided-for-me.ts", import.meta.url);

function source(): string {
  return readFileSync(SOURCE_PATH, "utf8");
}

function testOutcomeVocabulary() {
  // Real stored values, one per module, taken from production columns.
  const rejected = [
    "rejected", // v2_excuse_requests.manager_decision, marketing step status
    "ceo_rejected", // employee_plan_headers.status
    "manager_rejected",
    "declined", // marketing decision_labels spell reject as "Decline"
  ];
  for (const value of rejected) {
    assert.equal(
      normalizeDecidedForMeOutcome(value),
      "rejected",
      `${value} must read as rejected, never as approved`,
    );
  }

  const returned = [
    "returned_to_employee", // v2_excuse_requests
    "manager_returned", // employee_plan_headers
    "returned", // marketing step
  ];
  for (const value of returned) {
    assert.equal(
      normalizeDecidedForMeOutcome(value),
      "returned",
      `${value} must read as returned, never as approved`,
    );
  }

  const approved = ["approved", "hr_acknowledged", "manager_approved"];
  for (const value of approved) {
    assert.equal(normalizeDecidedForMeOutcome(value), "approved", `${value} must read as approved`);
  }

  // A rejected-and-returned compound must never soften into "approved".
  assert.notEqual(normalizeDecidedForMeOutcome("ceo_rejected_returned"), "approved");

  // Null/blank is the only case that legitimately falls through to the default.
  assert.equal(normalizeDecidedForMeOutcome(null), "approved");
  assert.equal(normalizeDecidedForMeOutcome(undefined), "approved");
}

function testEveryModuleFiltersOutTheViewersOwnDecisions() {
  const text = source();

  // The three team-scoped modules read manager_decision_by_hr_id; marketing reads
  // decision_by_hr_id. Each must be passed through isMe() and skipped.
  const guards = [
    "if (isMe(row.manager_decision_by_hr_id)) continue;",
    "if (isMe(row.decision_by_hr_id)) continue;",
  ];
  for (const guard of guards) {
    assert.ok(
      text.includes(guard),
      `decided-for-me.ts must skip the viewer's own decisions with: ${guard}`,
    );
  }

  // Three team modules (leave, excuse, plan) each carry their own copy of the manager guard.
  const teamGuards = text.split("if (isMe(row.manager_decision_by_hr_id)) continue;").length - 1;
  assert.equal(
    teamGuards,
    3,
    `expected exactly 3 team-module self-decision guards (leave, excuse, weekly plan), found ${teamGuards} — a module was added without one, or one was removed`,
  );

  // Identity, not login: a decision taken under the viewer's second login is still his own.
  assert.ok(
    text.includes("sharedIdentityKeys") && text.includes("isSamePerson"),
    "self-decision matching must go through the identity aliases, not a raw string compare",
  );
}

function testScopeAndSafetyRails() {
  const text = source();

  // Every .in() list is chunked — a PostgREST .in() carrying several hundred ids returns ZERO
  // rows with no error, which here would silently render "nothing happened while you were away".
  const inCalls = text.split(".in(").length - 1;
  const chunkedLoops = text.split("of chunk(").length - 1;
  assert.ok(inCalls > 0, "expected at least one .in() filter");
  assert.ok(
    chunkedLoops >= 2,
    `every unbounded id list must be chunked before .in(); found ${chunkedLoops} chunk loops for ${inCalls} .in() calls`,
  );

  // The window is bounded, so a long-tenured manager never pulls his whole history.
  assert.ok(
    text.includes("gte(\"manager_decision_at\", since)") && text.includes("gte(\"decision_at\", since)"),
    "every module query must be bounded by the lookback window",
  );

  // Line ownership is read from the routing table, never hardcoded — the same row the marketing
  // workflow reads, so a cover that flips it moves this list with it.
  assert.ok(
    text.includes("marketing_review_routing"),
    "line ownership must be resolved from marketing_review_routing",
  );

  // HR ids are mixed case in storage; both sides must be canonicalised before comparison.
  assert.ok(
    text.includes("canonicalHrIdKey(employee.managerHrId)"),
    "team membership must compare canonical HR id keys on both sides",
  );
}

export function runDecidedForMeTests() {
  testOutcomeVocabulary();
  testEveryModuleFiltersOutTheViewersOwnDecisions();
  testScopeAndSafetyRails();
}
