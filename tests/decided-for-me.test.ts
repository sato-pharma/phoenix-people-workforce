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

// Owner request 2026-09-07: "show what she wrote". Knowing a plan was Returned is not the same
// as reading the returner's actual words, and without them a returning manager still has to go
// and ask what was said — the very errand this feature exists to remove. Every module must
// therefore carry its decision comment through to the row, and the SELECT must ask for the
// column: a populate that reads row.manager_decision_comment from a select that never requested
// it yields undefined, renders nothing, and looks exactly like "they left no note".
function testEveryModuleCarriesTheDecidersWords() {
  const text = source();

  // Pin the SOURCE COLUMN each module reads, not the shape of the call — marketing routes its
  // note through a local so the reporting gate can see it, and an earlier version of this
  // assertion counted the literal `decidedNote: decisionNote(` and went red on that refactor
  // while the behaviour was still correct.
  const teamNotes = text.split("decisionNote(row.manager_decision_comment)").length - 1;
  assert.equal(
    teamNotes,
    3,
    `leave, excuse and weekly plan must each read manager_decision_comment; found ${teamNotes}`,
  );
  assert.ok(
    text.includes("decisionNote(row.decision_note)"),
    "the marketing step must read its decision_note",
  );
  // The district manager's Phoenix CRM week (owner, 2026-10-16) replaced the legacy plan once that
  // team went live, so its first-approver decision is a fifth row and carries its decider's words too.
  assert.ok(
    text.includes("decidedNote: decisionNote(decision.note)"),
    "the district manager's Phoenix CRM week must carry its decider's note",
  );
  const carried = text.split("decidedNote:").length - 1;
  assert.equal(
    carried,
    6,
    `expected 5 module rows (leave, excuse, weekly plan, the district manager's Phoenix CRM week, ` +
      `marketing) to carry decidedNote plus the type declaration; found ${carried}`,
  );

  // Each team-module SELECT must request the comment column it then reads.
  const teamSelectsWithComment = text.split("manager_decision_by_hr_id,manager_decision_comment").length - 1;
  assert.equal(
    teamSelectsWithComment,
    3,
    `each team-module select must request manager_decision_comment; found ${teamSelectsWithComment}`,
  );
  assert.ok(
    text.includes("decision_by_hr_id,decision_note"),
    "the marketing step select must request decision_note",
  );

  // Blank collapses to null, never "", so the UI can branch on absence rather than render an
  // empty quote block under a decision that carried no comment.
  assert.ok(
    text.includes("return text ? text : null;"),
    "an empty note must normalise to null, not to an empty string",
  );
}

// Measured against production 2026-09-07, and the reason all three of these exist: Hossam's tab
// returned 38 rows where only 8 were decisions taken on his behalf. 14 were legacy leave
// backfills and admin corrections, and 9 more had no decider recorded at all — they rendered as
// "Decided by" followed by nothing. A separate run of the same code returned ZERO, because a
// transient directory failure was being swallowed into an empty list.
function testTheListReportsOnlyRealStandInDecisions() {
  const text = source();

  // Both push paths (the three team modules share one, marketing has its own) go through the
  // same gate. A future module that skips it reintroduces exactly the noise this removed.
  const gated = text.split("shouldReport(").length - 1;
  assert.equal(gated, 2, `both push paths must go through shouldReport(); found ${gated}`);

  // A decider that cannot be resolved to a real person is not reported at all.
  assert.ok(
    text.includes("nameByHrId.has(key)"),
    "a decider must resolve to a real employee before the row is shown",
  );

  // Records being tidied are not decisions taken for you.
  for (const marker of ["historical import", "manual admin record update"]) {
    assert.ok(text.includes(marker), `system-record marker "${marker}" must be filtered out`);
  }

  // THE LOAD-BEARING ONE: a directory failure must propagate, never become [].
  assert.ok(
    !text.includes("getEmployeeDirectory().catch"),
    'getEmployeeDirectory must NOT be caught here — swallowing it renders as "nothing happened while you were away", which is indistinguishable from a real quiet period and is the one wrong answer this tab must never give',
  );
  assert.ok(
    text.includes("const directory = await getEmployeeDirectory();"),
    "the directory lookup must be allowed to throw so the page can show 'could not load'",
  );
}

export function runDecidedForMeTests() {
  testOutcomeVocabulary();
  testEveryModuleFiltersOutTheViewersOwnDecisions();
  testScopeAndSafetyRails();
  testEveryModuleCarriesTheDecidersWords();
  testTheListReportsOnlyRealStandInDecisions();
}
