import assert from "node:assert/strict";
import { join } from "node:path";

import {
  OUTSTATION_CLAIM_CHANGED_CODE,
  OUTSTATION_CLAIM_CHANGED_MESSAGE,
  OUTSTATION_CLAIM_REVISION_MISSING_MESSAGE,
  OutstationClaimChangedError,
  assertOutstationClaimUnchanged,
  isOutstationClaimChangedError,
  outstationClaimRevision,
} from "../src/lib/outstation/claim-revision.ts";
import {
  JOURNEY_CHECK_MARKER,
  composeDecisionNote,
  journeyCheckSegment,
} from "../src/lib/outstation/decision-note.ts";
import { mapOutstationRequestRowToPayrollApproval } from "../src/lib/outstation/payroll-expense-mapping.ts";
import { stripComments } from "./support/comment-strip.ts";
import { cachedIsDirectory, cachedReadFile, cachedReaddir } from "./support/source-corpus.ts";

// Found by a risk review of the chained-journey PR, 2026-10-18. A claim keeps MOVING while it waits
// in Expense Approvals: the employee can add extra tickets, and on an undecided car trip a stop that
// re-prices the whole journey. The approver loads the queue showing fuel 853.78, the employee adds a
// stop, the approver clicks Approve on the old screen — and the approval pushed the row's CURRENT
// figures to payroll, ones he had never seen. His comment also replaced `approval_reason`, which
// erased the "Journey check:" sentence the system had written for him to read.
//
// The fix: an approve or a reject carries the version of the claim he saw (its `updated_at`), and is
// refused (409) when the claim has moved. This file pins it in three layers:
//   1. the token and the refusal, by behaviour (claim-revision.ts);
//   2. how his comment meets the system's journey sentence, by behaviour (decision-note.ts);
//   3. that EVERY entry point carries and checks the token, by reading the source — the service
//      needs Supabase, so the assertable surface is the wiring, the way outstation-expense-gate and
//      outstation-submission-waits-for-approval do it. A census of call sites keeps a new caller
//      from skipping the token without anyone noticing.

const ROOT = process.cwd();
const SERVICE = "src/lib/outstation/service.ts";

/** A source file with its comments blanked: prose that QUOTES a call must not satisfy a pin on it. */
function code(relative: string): string {
  return stripComments(cachedReadFile(join(ROOT, relative)));
}

/** One top-level function's body, from its signature to the next top-level async function. */
function functionSlice(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist — this test is pinned to it by name`);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n(?:export )?async function /);
  return rest.slice(0, next === -1 ? rest.length : next);
}

/** The text of every call whose opening matches `opening`, up to its balancing close paren. */
function callsMatching(source: string, opening: RegExp): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(new RegExp(opening.source, "g"))) {
    const start = match.index ?? 0;
    let depth = 0;
    let end = start;
    for (let i = source.indexOf("(", start); i < source.length; i += 1) {
      if (source[i] === "(") depth += 1;
      else if (source[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(start, end + 1));
  }
  return calls;
}

/** Every .ts/.tsx file under the named roots, as repo-relative paths. */
function sourceFiles(...roots: string[]): string[] {
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const name of cachedReaddir(join(ROOT, relative))) {
      const child = `${relative}/${name}`;
      if (cachedIsDirectory(join(ROOT, child))) {
        if (name !== "node_modules" && !name.startsWith(".")) walk(child);
      } else if (/\.(ts|tsx)$/.test(name)) {
        files.push(child);
      }
    }
  };
  roots.forEach(walk);
  return files;
}

/** What 6094 writes: the free text, then ONE "Journey check:" group. */
const WITH_JOURNEY =
  "Waiting for review. Journey check: Priced as a chain of drives: 475.66 km paid one way, " +
  "fuel 856.19 (home and back would be 1500.00).";
const JOURNEY_GROUP =
  "Journey check: Priced as a chain of drives: 475.66 km paid one way, fuel 856.19 (home and back would be 1500.00).";

export function runOutstationStaleApprovalTests() {
  // ═════════════════════════════════════════════════════════════════════════════════════════
  // 1. The token and the refusal
  // ═════════════════════════════════════════════════════════════════════════════════════════

  // The database prints "+00:00" with microseconds; the screens hold the millisecond "Z" form the
  // mapper made. They are the same instant and must compare equal, or every approval is refused.
  assert.equal(outstationClaimRevision("2026-10-18T22:10:11.123456+00:00"), "2026-10-18T22:10:11.123Z");
  assert.equal(outstationClaimRevision("2026-10-18T22:10:11.123Z"), "2026-10-18T22:10:11.123Z");
  assert.equal(outstationClaimRevision(new Date("2026-10-18T22:10:11.123Z")), "2026-10-18T22:10:11.123Z");
  assert.equal(outstationClaimRevision(null), "");
  assert.equal(outstationClaimRevision(undefined), "");
  assert.equal(outstationClaimRevision("   "), "");
  assert.equal(outstationClaimRevision("not a time"), "not a time", "an unparseable stamp is kept as written, never blanked");

  const seen = "2026-10-18T22:10:11.123Z";
  assert.doesNotThrow(
    () => assertOutstationClaimUnchanged({ current: "2026-10-18T22:10:11.123456+00:00", expected: seen }),
    "the same instant in the database's own format is the claim he saw",
  );

  // The scenario in the report: he loaded fuel 853.78, the employee added a stop a second later.
  assert.throws(
    () => assertOutstationClaimUnchanged({ current: "2026-10-18T22:10:12.456Z", expected: seen }),
    (error: unknown) =>
      error instanceof OutstationClaimChangedError &&
      error.kind === "changed" &&
      error.code === OUTSTATION_CLAIM_CHANGED_CODE &&
      error.message === OUTSTATION_CLAIM_CHANGED_MESSAGE,
    "a claim that moved after he loaded it must be refused with the 'changed since you opened it' message",
  );
  assert.match(OUTSTATION_CLAIM_CHANGED_MESSAGE, /changed since you opened it/);
  assert.match(OUTSTATION_CLAIM_CHANGED_MESSAGE, /Refresh/);

  // Fails CLOSED both ways: a screen that said nothing, and a claim whose own stamp is unreadable.
  for (const blank of [undefined, null, "", "   "]) {
    assert.throws(
      () => assertOutstationClaimUnchanged({ current: seen, expected: blank }),
      (error: unknown) =>
        error instanceof OutstationClaimChangedError &&
        error.kind === "missing" &&
        error.message === OUTSTATION_CLAIM_REVISION_MISSING_MESSAGE,
      `a decision that names no version (${JSON.stringify(blank)}) must be refused, never decided blind`,
    );
  }
  assert.throws(
    () => assertOutstationClaimUnchanged({ current: "", expected: seen }),
    (error: unknown) => error instanceof OutstationClaimChangedError && error.kind === "changed",
    "a claim with no readable version is never treated as unchanged",
  );

  const refused = new OutstationClaimChangedError("changed");
  assert.equal(isOutstationClaimChangedError(refused), true);
  assert.equal(isOutstationClaimChangedError(new Error("Outstation request was not found.")), false);
  const recreated = new Error("x");
  recreated.name = "OutstationClaimChangedError";
  assert.equal(isOutstationClaimChangedError(recreated), true, "recognised by name too, so a hot-reloaded class still maps to 409");

  // The token a screen receives IS the one the server compares: the queue row built from a stored
  // request carries the same normalised stamp the service reads back.
  const queueRow = mapOutstationRequestRowToPayrollApproval({
    allowance_amount: 300,
    claimed_total_amount: 1500,
    created_at: "2026-10-18T10:00:00.000Z",
    employee_hr_id: "A16",
    employee_name: "Account Admin",
    expected_total_amount: 1400,
    expense_type: "traveling",
    fuel_amount: 700,
    id: 42,
    status: "submitted",
    trip_end_date: "2026-10-18T00:00:00.000Z",
    trip_start_date: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T22:10:11.123456+00:00",
  });
  assert.equal(queueRow.requestRevision, "2026-10-18T22:10:11.123Z", "the Expense Approvals row must carry its claim's version");
  assert.equal(queueRow.tripId, "OUTSTATION-42");

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // 2. His comment meets the system's journey sentence
  // ═════════════════════════════════════════════════════════════════════════════════════════

  assert.equal(JOURNEY_CHECK_MARKER, "Journey check:");
  assert.equal(journeyCheckSegment(WITH_JOURNEY), JOURNEY_GROUP);
  assert.equal(journeyCheckSegment("Waiting for review."), "");
  assert.equal(journeyCheckSegment(null), "");

  // The reported defect: typing a comment used to REPLACE the whole reason and erase the sentence.
  assert.equal(
    composeDecisionNote(WITH_JOURNEY, "Approved from admin outstation review."),
    `Approved from admin outstation review. ${JOURNEY_GROUP}`,
    "his comment is appended to the journey sentence, which survives",
  );
  // The Expense Approvals comment box is pre-filled with the whole stored reason, so the same text
  // coming back must not stack a second group beside the first.
  assert.equal(composeDecisionNote(WITH_JOURNEY, WITH_JOURNEY), WITH_JOURNEY, "re-saving the untouched box changes nothing");
  assert.equal(
    composeDecisionNote(WITH_JOURNEY, `Looks right to me. ${JOURNEY_GROUP}`),
    `Looks right to me. ${JOURNEY_GROUP}`,
    "an edited box that still holds the group does not duplicate it",
  );
  // A stop re-priced the journey after the box loaded: the CURRENT group wins, the stale copy goes.
  assert.equal(
    composeDecisionNote(WITH_JOURNEY, "Fine. Journey check: Priced as a chain of drives: 300 km, fuel 540.00."),
    `Fine. ${JOURNEY_GROUP}`,
    "a stale copy of the group in the box is replaced by the current one",
  );
  assert.equal(composeDecisionNote(WITH_JOURNEY, ""), JOURNEY_GROUP, "clearing the box leaves the system's sentence");
  assert.equal(composeDecisionNote(WITH_JOURNEY, null), JOURNEY_GROUP);
  assert.equal(composeDecisionNote(WITH_JOURNEY, `${JOURNEY_GROUP}`), JOURNEY_GROUP);
  // No group on the claim: his words are his, exactly as typed (the column is NOT NULL, so "" not null).
  assert.equal(composeDecisionNote("Waiting for review.", "Approved."), "Approved.");
  assert.equal(composeDecisionNote("Waiting for review.", ""), "");
  assert.equal(composeDecisionNote(null, null), "");
  assert.equal(
    composeDecisionNote("Waiting for review.", "Journey check: I measured it myself."),
    "Journey check: I measured it myself.",
    "with no system group on the claim, his own text is never stripped",
  );

  // The marker equals the one the journey writer appends, as soon as that writer is in the tree
  // (chained-journey.ts arrives with the chained-journey PR; until then there is nothing to compare).
  const journeyWriter = "src/lib/outstation/chained-journey.ts";
  if (cachedReaddir(join(ROOT, "src/lib/outstation")).includes("chained-journey.ts")) {
    const written = /JOURNEY_REASON_MARKER\s*=\s*"([^"]+)"/.exec(cachedReadFile(join(ROOT, journeyWriter)));
    assert.ok(written, `${journeyWriter} must declare JOURNEY_REASON_MARKER`);
    assert.equal(written[1], JOURNEY_CHECK_MARKER, "the note composer must keep the marker the journey writer appends");
  }

  // ═════════════════════════════════════════════════════════════════════════════════════════
  // 3. Every entry point carries and checks the version
  // ═════════════════════════════════════════════════════════════════════════════════════════

  const service = code(SERVICE);

  // 3a. Approve — the check precedes the write, and the write is pinned to what was checked.
  const approve = functionSlice(service, "export async function approveOutstationRequestForPayroll");
  assert.match(approve, /expectedRevision: string;/, "approve must REQUIRE the version — a caller cannot omit it");
  assert.doesNotMatch(approve, /expectedRevision\?:/, "the version must never become optional on approve");
  const approveCheck = approve.indexOf("assertOutstationClaimUnchanged(");
  const approveWrite = approve.indexOf(".update(");
  assert.ok(approveCheck > -1 && approveWrite > -1, "approve must check the version and then write");
  assert.ok(approveCheck < approveWrite, "approve must check the version BEFORE it writes");
  assert.match(approve, /checkedUpdatedAt = await readOutstationRequestStoredUpdatedAt\(requestId\)/);
  assert.ok(
    approve.includes('.eq("updated_at", checkedUpdatedAt)'),
    "approve must pin its write to the exact stamp it checked, so a change landing in between leaves nothing to approve",
  );
  assert.match(
    approve,
    /if \(!data\) \{\s*throw new OutstationClaimChangedError\("changed"\);/,
    "a write that matched no row means the claim moved: it must say so, not 'state changed'",
  );
  assert.ok(
    approve.includes("composeDecisionNote(existing.approvalReason, typedComment)"),
    "approve must append his comment to the journey sentence",
  );
  assert.doesNotMatch(
    approve,
    /cleanText\(options\.comment\) \?\? existing\.approvalReason/,
    "the old overwrite of approval_reason by his comment must not return",
  );

  // 3b. Reject — checked before the payroll rows of an accepted claim are deleted.
  const reject = functionSlice(service, "export async function rejectOutstationRequestAsAdmin");
  assert.match(reject, /expectedRevision: string;/, "reject must REQUIRE the version too");
  const rejectCheck = reject.indexOf("assertOutstationClaimUnchanged(");
  const rejectDelete = reject.indexOf(".delete()");
  assert.ok(rejectCheck > -1 && rejectDelete > -1, "reject must check the version and delete the payroll rows");
  assert.ok(rejectCheck < rejectDelete, "reject must check the version BEFORE any payroll row is deleted");
  assert.ok(
    reject.includes("composeDecisionNote(existing.approvalReason, comment)"),
    "a rejection reason is appended to the journey sentence too",
  );
  assert.doesNotMatch(reject, /approval_reason: comment,/, "the old overwrite of approval_reason must not return");

  // 3c. The queue's comment-only save keeps the journey sentence.
  const noteWriter = functionSlice(service, "async function writeOutstationRequestDecisionNote");
  assert.ok(
    noteWriter.includes("composeDecisionNote(input.request.approvalReason"),
    "a comment saved from Expense Approvals must keep the journey sentence",
  );

  // 3d. The queue's Save — money-moving rows carry the version; a comment-only edit does not need it.
  const batch = functionSlice(service, "export async function applyOutstationRequestExpenseDecisions");
  const commentBranch = batch.indexOf('plan.action === "comment"');
  const seenCheck = batch.indexOf("const seenRevision");
  const amountCheck = batch.indexOf("assertOutstationClaimUnchanged(");
  assert.ok(commentBranch > -1 && seenCheck > -1 && amountCheck > -1, "the Save must read the row's version and check a trimmed amount");
  assert.ok(commentBranch < seenCheck, "a comment-only edit moves no money and is decided before the version is demanded");
  assert.ok(
    batch.includes("OUTSTATION_CLAIM_REVISION_MISSING_MESSAGE"),
    "a row that arrives with no version must be skipped by name, never decided blind",
  );
  assert.ok(
    seenCheck < batch.indexOf("rejectOutstationRequestAsAdmin(") &&
      seenCheck < batch.indexOf("approveOutstationRequestForPayroll("),
    "the version is demanded before approve or reject is reached",
  );
  assert.ok(
    amountCheck < batch.lastIndexOf("writeOutstationRequestDecisionNote("),
    "a trimmed amount is checked before its reason is written",
  );
  assert.equal(
    batch.split("expectedRevision: seenRevision").length - 1,
    2,
    "both the approve and the reject inside the Save must pass the version the row carried",
  );
  assert.ok(
    batch.includes("isOutstationClaimChangedError(error)") && batch.includes("code: OUTSTATION_CLAIM_CHANGED_CODE"),
    "a refused row is reported with the claim-changed code",
  );

  // 3e. The queue row and the request object both hand the screen the version.
  assert.ok(
    code("src/lib/outstation/payroll-expense-mapping.ts").includes("requestRevision: outstationClaimRevision(row.updated_at)"),
    "the Expense Approvals row must carry requestRevision",
  );
  assert.ok(
    service.includes("updatedAt: outstationClaimRevision(row.updated_at)"),
    "the request's updatedAt must be built by the same normalisation the server compares with",
  );
  assert.ok(
    code("src/lib/action-center/service.ts").includes("revision: request.updatedAt"),
    "the Action Center item must carry the claim's version",
  );
  assert.ok(
    code("app/api/approvals-hub/hub-data/route.ts").includes("revision: r.updatedAt"),
    "the view-as Action Center item must carry the claim's version",
  );
  assert.match(code("src/components/action-center/types.ts"), /requestId: number;\s*[^}]*revision: string;/);

  // 3f. The decision routes pass it through and answer a moved claim with 409.
  const route = code("app/api/admin/outstation/[id]/route.ts");
  const routeApprove = callsMatching(route, /approveOutstationRequestForPayroll\(/);
  const routeReject = callsMatching(route, /rejectOutstationRequestAsAdmin\(/);
  assert.equal(routeApprove.length, 1);
  assert.equal(routeReject.length, 1);
  assert.ok(routeApprove[0].includes("expectedRevision: expectedRevisionFrom(body)"), "POST must forward the version");
  assert.ok(routeReject[0].includes("expectedRevision: expectedRevisionFrom(body)"), "PATCH must forward the version");
  assert.match(
    route,
    /isOutstationClaimChangedError\(error\)\s*\)\s*\{\s*return 409;/,
    "a claim that moved after the reviewer loaded it must answer 409",
  );

  // 3g. CENSUS — every caller of the two decision functions, anywhere in the app, passes the version.
  // Counted, so a rename or a moved file cannot turn this into a loop over nothing.
  let decisionCalls = 0;
  for (const file of sourceFiles("src", "app", "scripts")) {
    const raw = cachedReadFile(join(ROOT, file));
    for (const name of ["approveOutstationRequestForPayroll", "rejectOutstationRequestAsAdmin"]) {
      if (!raw.includes(`${name}(`)) continue;
      const source = stripComments(raw);
      for (const call of callsMatching(source, new RegExp(`(?<!function )${name}\\(`))) {
        decisionCalls += 1;
        assert.ok(call.includes("expectedRevision"), `${file}: ${name}(…) must pass expectedRevision`);
      }
    }
  }
  assert.ok(decisionCalls >= 6, `expected to see at least 6 decision calls (route 2, Save 2, smokes 2); saw ${decisionCalls}`);

  // 3h. CENSUS — every screen that posts a decision to the single-claim route sends the version.
  let screenCalls = 0;
  const hub = code("src/components/action-center/action-center-hub.tsx");
  for (const call of callsMatching(hub, /callApi\(\s*`\/api\/admin\/outstation\//)) {
    screenCalls += 1;
    assert.ok(call.includes("expectedRevision"), `Action Center: ${call.slice(0, 80)} must send the claim version`);
  }
  for (const call of callsMatching(hub, /fetch\(`\/api\/admin\/outstation\/\$\{item\.id\}`/)) {
    screenCalls += 1;
    assert.ok(call.includes("expectedRevision"), "the Action Center bulk approve must send each claim's version");
  }
  const adminScreen = code("src/components/outstation/outstation-requests-admin.tsx");
  for (const call of callsMatching(adminScreen, /fetch\(`\/api\/admin\/outstation\/\$\{/)) {
    if (!/method: "(POST|PATCH)"/.test(call)) continue;
    if (/recalculate-distance|attachments|evidence|reminder|workload/.test(call)) continue;
    screenCalls += 1;
    assert.ok(call.includes("expectedRevision"), "the admin outstation screen must send the claim version with Approve and Reject");
  }
  assert.ok(screenCalls >= 6, `expected to see 6 decision posts from screens (hub 3 + bulk 1 + admin 2); saw ${screenCalls}`);

  // 3i. The Action Center bulk approve must not report a refusal as an approval. It used to count
  // only a network failure, so every 403/409/500 was "approved" — which would have hidden this fix.
  assert.ok(hub.includes("response.ok"), "the bulk approve must judge each response by its status");
  assert.doesNotMatch(hub, /results\.filter\(\(r\) => r\.status === "rejected"\)/, "a network failure is not the only failure");

  // 3j. The screens refresh on a moved claim instead of leaving the old figures up.
  assert.ok(hub.includes("OUTSTATION_CLAIM_CHANGED_CODE") && hub.includes("router.refresh()"));
  assert.ok(adminScreen.includes("reloadRequestAfterConflict"), "the admin outstation screen must reload the claim it refused");
}
