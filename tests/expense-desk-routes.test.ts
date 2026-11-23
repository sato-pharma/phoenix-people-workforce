/**
 * Expense Approvals, rebuilt 2026-11-23 — WHO MAY READ, WHO MAY DECIDE, AND WHAT A PRESS MAY CARRY.
 *
 * The audit scored Permissions 5 / 10: the decide route took each row whole, figures included, and
 * a development preview session could post a decision. Pinned here:
 *
 *   1. The decide route's order: same-origin, signed in, the Super Admin's workspace, a REAL
 *      session, the body — and only then the write. Nothing is read from the body before the guards.
 *   2. Every read asserts the review permission before it reads; a preview session never sees
 *      buttons it could not use.
 *   3. A press is six fields. An unknown key (a figure smuggled beside it), a batch over the limit
 *      or an amount of zero is refused before anything runs.
 *   4. Each route has its own access-registry entry, never the /api/admin/outstation/** blanket.
 *   5. The reviewer's one read: photos and Phoenix CRM stay the approver's; a reader without that
 *      gate gets the claim and is told the rest was withheld; a failed source names itself.
 */
import assert from "node:assert/strict";
import fs from "node:fs";

import { DESK_DECISION_LIMIT, DeskDecideBodySchema } from "@/lib/outstation/approvals/decision-body";
import { composeTripFile, TRIP_FILE_SOURCES } from "@/lib/outstation/approvals/trip-file";
import type { DeskClaim } from "@/lib/outstation/approvals/types";
import type { CrmTripEvidenceResult } from "@/lib/outstation/crm-trip-evidence-reader";
import type { TripAttachmentsPayload } from "@/lib/outstation/trip-attachments-data";
import { findAccessRegistryEntry } from "@/lib/security/access-registry";

const code = (path: string) => fs.readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

function handler(source: string, method: "GET" | "POST"): string {
  const start = source.indexOf(`export async function ${method}(`);
  assert.ok(start >= 0, `the route exports ${method}`);
  const next = source.indexOf("export async function ", start + 10);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

/** Each step must appear, and in this order. */
function assertOrder(block: string, steps: string[], what: string) {
  let from = 0;
  for (const step of steps) {
    const at = block.indexOf(step, from);
    assert.ok(at >= 0, `${what}: "${step}" must come after the step before it`);
    from = at + step.length;
  }
}

const press = { action: "approve", requestId: 293, revision: "2026-11-22T10:00:00.000Z" };

export function runExpenseDeskRoutesTests() {
  const desk = code("app/api/admin/outstation/approvals/route.ts");
  const history = code("app/api/admin/outstation/approvals/history/route.ts");
  const trip = code("app/api/admin/outstation/approvals/[requestId]/route.ts");

  // 1. The decide route's order.
  const post = handler(desk, "POST");
  assertOrder(
    post,
    [
      "assertSameOriginMutation(request)",
      "resolveAccessContext(request)",
      "unauthenticatedSessionResponse(access)",
      'assertSystemAdministratorWorkspaceAccess(access, "expense approvals")',
      'assertRealSessionForDecision(access, "decide an expense claim")',
      "parseJsonBody(request, DeskDecideBodySchema)",
      "decideDeskClaims(access, parsed.data.decisions)",
    ],
    "the decide route",
  );
  assert.ok(!post.includes("assertOutstationExpenseApprovalReviewAccess"), "deciding is never opened by the READ permission: the CEO reads and decides nothing");
  assert.ok(!/request\.(json|text|formData)\(/.test(post), "the body is read only through parseJsonBody, after the guards");
  assert.equal(post.split("parseJsonBody(").length - 1, 1, "the body is parsed once, and the order above puts that one parse after every guard");
  // The domain function refuses a preview session too, so a second caller cannot skip it.
  const decide = code("src/lib/outstation/approvals/decide.ts");
  assertOrder(decide, ['assertRealSessionForDecision(access, "decide an expense claim")', "loadDeskClaims("], "decideDeskClaims");

  // 2. Every read asserts the review permission before it reads.
  assertOrder(handler(desk, "GET"), ["unauthenticatedSessionResponse(access)", "assertOutstationExpenseApprovalReviewAccess(access", "loadDeskQueue("], "the queue read");
  assertOrder(handler(history, "GET"), ["unauthenticatedSessionResponse(access)", "assertOutstationExpenseApprovalReviewAccess(access", "loadSheetHistory(", "loadDeskHistory("], "the history read");
  assertOrder(
    handler(trip, "GET"),
    ["unauthenticatedSessionResponse(access)", "assertOutstationExpenseApprovalReviewAccess(access", "let includeEvidence = false;", 'assertOutstationAdminAccess(access, "approve")', "includeEvidence = true;", "loadDeskTripFile("],
    "the trip read",
  );
  assert.equal(trip.split("includeEvidence = true").length - 1, 1, "the photos and Phoenix CRM are switched on in one place only: after the approver's own gate passed");
  assert.ok(desk.includes("canDecideOutstationExpenseApprovals(access) && !isPreviewSession(access)"), "a preview session is shown no button it could not use");
  for (const [name, source] of [["history", history], ["trip", trip]] as const) {
    assert.ok(!/export async function (POST|PUT|PATCH|DELETE)/.test(source), `the ${name} route only reads`);
  }

  // 3. A press is six fields.
  assert.ok(DeskDecideBodySchema.safeParse({ decisions: [press] }).success);
  const kept = DeskDecideBodySchema.safeParse({ decisions: [{ ...press, keepFull: true }] });
  assert.ok(kept.success && kept.data.decisions[0].keepFull === true, "HEADLINE: keep-full reaches the server: without it a stale page's Approve is not paid in full");
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [{ ...press, keepFull: "yes" }] }).success, "and it is a plain yes or no");
  assert.ok(DeskDecideBodySchema.safeParse({ decisions: [{ ...press, action: "reduce", approvedAmount: 300, comment: "One idle day" }] }).success);
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [{ ...press, total: 1 }] }).success, "a figure beside the press is refused: every paid figure is read on the server");
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [{ ...press, hrApproved: true }] }).success);
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [press], reportId: "x" }).success);
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [] }).success, "an empty press is refused");
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [{ ...press, action: "delete" }] }).success);
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [{ ...press, approvedAmount: 0 }] }).success, "to pay nothing is a rejection, never an amount of zero");
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [{ ...press, approvedAmount: -5 }] }).success);
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [{ ...press, requestId: "293" }] }).success);
  assert.ok(!DeskDecideBodySchema.safeParse({ decisions: [{ ...press, revision: "" }] }).success, "a press with no version is refused");
  const many = (count: number) => ({ decisions: Array.from({ length: count }, (_, index) => ({ ...press, requestId: index + 1 })) });
  assert.equal(DESK_DECISION_LIMIT, 100);
  assert.ok(DeskDecideBodySchema.safeParse(many(DESK_DECISION_LIMIT)).success);
  assert.ok(!DeskDecideBodySchema.safeParse(many(DESK_DECISION_LIMIT + 1)).success, "one request never decides more than the limit");

  // The opened-trip route takes its id through the one outstation parser (tests/outstation-request-id-parse.test.ts).
  const tripRoute = code("app/api/admin/outstation/approvals/[requestId]/route.ts");
  assert.match(tripRoute, /const requestId = parseOutstationRequestId\(\(await params\)\.requestId\);\s*if \(requestId === null\)/, "a malformed id answers 400 before any read");

  // 4. Its own registry entries.
  const decideEntry = findAccessRegistryEntry("/api/admin/outstation/approvals", "POST");
  assert.equal(decideEntry?.pattern, "/api/admin/outstation/approvals", "the decide route has its own entry, not the outstation blanket");
  assert.equal(decideEntry?.csrf.required, true);
  assert.equal(decideEntry?.audit.classification, "mutation");
  for (const route of ["/api/admin/outstation/approvals", "/api/admin/outstation/approvals/history", "/api/admin/outstation/approvals/293"]) {
    const entry = findAccessRegistryEntry(route, "GET");
    assert.ok(entry && !entry.pattern.includes("**"), `${route} GET resolves to its own entry`);
    assert.equal(entry?.audit.classification, "access-read");
  }
  assert.equal(findAccessRegistryEntry("/api/admin/outstation/approvals/history", "GET")?.pattern, "/api/admin/outstation/approvals/history");

  // 5. The reviewer's one read.
  const claim = { requestId: 293 } as DeskClaim;
  const photos = { found: true, photos: [], tickets: [] } as unknown as TripAttachmentsPayload;
  const crm: CrmTripEvidenceResult = { found: true, reading: null, unavailable: ["Day activities"] };
  const ok = <T,>(value: T): PromiseSettledResult<T> => ({ status: "fulfilled", value });
  const failed = <T,>(): PromiseSettledResult<T> => ({ reason: new Error("down"), status: "rejected" });

  const withheld = composeTripFile({ attachments: null, claim, crm: null });
  assert.deepEqual(
    { attachments: withheld.attachments, crm: withheld.crm, evidenceWithheld: withheld.evidenceWithheld, unavailable: withheld.unavailable },
    { attachments: null, crm: null, evidenceWithheld: true, unavailable: [] },
    "a reader without the approver's gate gets the claim and is told the rest was withheld",
  );
  assert.equal(withheld.claim, claim);

  const whole = composeTripFile({ attachments: ok(photos), claim, crm: ok(crm) });
  assert.equal(whole.evidenceWithheld, false);
  assert.equal(whole.attachments, photos);
  assert.deepEqual(whole.unavailable, ["Day activities"], "what Phoenix CRM itself could not read is carried up");

  const partial = composeTripFile({ attachments: failed(), claim, crm: ok({ ...crm, unavailable: [] }) });
  assert.equal(partial.evidenceWithheld, false, "a failed read is not a withheld one");
  assert.equal(partial.attachments, null);
  assert.deepEqual(partial.unavailable, [TRIP_FILE_SOURCES.attachments], "a source that failed names itself; the trip still opens");
  assert.deepEqual(composeTripFile({ attachments: failed(), claim, crm: failed() }).unavailable, [TRIP_FILE_SOURCES.attachments, TRIP_FILE_SOURCES.crm]);

  const file = code("src/lib/outstation/approvals/trip-file.ts");
  assertOrder(file, ["if (!claim) return null;", "composeTripFile("], "a claim off the caller's list returns nothing, evidence included");
  assert.ok(!/\.(insert|update|upsert|delete|rpc)\(/.test(file), "the trip read writes nothing");
}
