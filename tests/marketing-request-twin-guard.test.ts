import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeTwinForApprover,
  findMarketingRequestTwins,
  MARKETING_REQUEST_TWIN_STATUSES,
  twinRefusalMessage,
  twinSubmittedDay,
  type TwinCandidate,
  type TwinSubject,
} from "../src/lib/marketing-requests/twin-request.ts";

// Guards the double-PAYMENT refusal. On 26 Oct 2026 production held one live pair: the same
// requester, customer, request type and EGP cost submitted two minutes apart, one copy active and
// the other still waiting at Finance Execution, one click from paying the same activity twice.
// A second non-draft request with all four keys equal is refused while the first is live.

const subject: TwinSubject = {
  customerId: "cust-1",
  estimatedCost: 4500,
  requestId: null,
  requestTypeId: 3,
  requesterHrId: "P-101",
};

function candidate(over: Partial<TwinCandidate>): TwinCandidate {
  return {
    currentStepCode: null,
    customerId: "cust-1",
    estimatedCost: 4500,
    requestCode: "MKT-REQ-20260822-5A6786CD",
    requestId: "req-first",
    requestTypeId: 3,
    requesterHrId: "P-101",
    status: "pending_approval",
    submittedAt: "2026-08-22T09:00:00Z",
    ...over,
  };
}

function testFindsTheLiveTwin() {
  const [twin] = findMarketingRequestTwins(subject, [candidate({})]);
  assert.ok(twin, "same requester + customer + type + cost while the earlier one is pending must be a twin");
  assert.equal(twin.requestId, "req-first");
}

function testEveryKeyMustMatch() {
  const differing: Array<[string, Partial<TwinCandidate>]> = [
    ["cost", { estimatedCost: 4501 }],
    ["request type", { requestTypeId: 4 }],
    ["customer", { customerId: "cust-2" }],
    ["requester", { requesterHrId: "P-102" }],
  ];
  for (const [key, over] of differing) {
    assert.equal(findMarketingRequestTwins(subject, [candidate(over)]).length, 0, `a different ${key} is a different activity`);
  }
  assert.equal(
    findMarketingRequestTwins(subject, [candidate({ estimatedCost: 4500.001 })]).length,
    1,
    "costs equal to the piastre are the same cost — a float round-trip must not split a twin",
  );
  assert.equal(
    findMarketingRequestTwins(subject, [candidate({ requesterHrId: " p-101 " })]).length,
    1,
    "HR ids compare case- and space-insensitively",
  );
}

function testOnlyLiveStatusesBlock() {
  for (const status of MARKETING_REQUEST_TWIN_STATUSES) {
    assert.equal(findMarketingRequestTwins(subject, [candidate({ status })]).length, 1, `${status} is live and must block`);
  }
  for (const status of ["draft", "returned", "rejected", "cancelled", "archived"]) {
    assert.equal(findMarketingRequestTwins(subject, [candidate({ status })]).length, 0, `${status} will not be paid and must not block`);
  }
}

function testTwinStatusesAreTheApprovedListPlusPending() {
  // twin-request.ts writes the list out so it stays importable without the service; it must not
  // drift from `approvedMarketingRequestStatuses`, the list the request named.
  const service = readFileSync(new URL("../src/lib/marketing-requests/service.ts", import.meta.url), "utf8");
  const block = service.match(/export const approvedMarketingRequestStatuses[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(block, "approvedMarketingRequestStatuses must still be declared in service.ts");
  const approved = [...block[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...MARKETING_REQUEST_TWIN_STATUSES].sort(), ["pending_approval", ...approved].sort());
}

function testNeverItsOwnTwin() {
  const resubmit: TwinSubject = { ...subject, requestId: "self" };
  assert.equal(
    findMarketingRequestTwins(resubmit, [candidate({ requestId: "self" })]).length,
    0,
    "a resubmitted request must not refuse itself",
  );
  assert.equal(findMarketingRequestTwins(resubmit, [candidate({ requestId: "self" }), candidate({})]).length, 1);
}

function testEarliestTwinFirst() {
  const twins = findMarketingRequestTwins(subject, [
    candidate({ requestCode: "LATER", requestId: "b", submittedAt: "2026-08-22T09:02:00Z" }),
    candidate({ requestCode: "FIRST", requestId: "a", submittedAt: "2026-08-22T09:00:00Z" }),
  ]);
  assert.deepEqual(twins.map((twin) => twin.requestCode), ["FIRST", "LATER"]);
}

function testMessagesNameCustomerAndCairoDate() {
  // 22:30 UTC on 22 Aug is 01:30 on 23 Aug in Cairo — the day must be Cairo's, never UTC's.
  assert.equal(twinSubmittedDay("2026-08-22T22:30:00Z"), "23 Aug 2026");
  assert.equal(twinSubmittedDay(null), "an earlier date");

  const twin = candidate({ submittedAt: "2026-08-22T22:30:00Z" });
  const refusal = twinRefusalMessage({ customerName: "El Shifa Pharmacy", twin });
  assert.match(refusal, /El Shifa Pharmacy/, "must name the earlier request's customer");
  assert.match(refusal, /23 Aug 2026/, "must name the earlier request's date");
  assert.match(refusal, /EGP 4,500/);
  assert.doesNotMatch(refusal, /cust-1|req-first|P-101/, "must not print raw ids at a requester");

  const warning = describeTwinForApprover({ ...twin, currentStepCode: "finance_execution" });
  assert.equal(warning.requestCode, twin.requestCode);
  assert.match(warning.description, /twice/, "must state the consequence: the same activity paid twice");
  assert.equal(warning.submittedDay, "23 Aug 2026");
}

function functionBody(source: string, name: string) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must still exist in service.ts`);
  const next = source.indexOf("\nexport async function ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

function testBothSubmitPathsCallTheGuardBeforeWriting() {
  const service = readFileSync(new URL("../src/lib/marketing-requests/service.ts", import.meta.url), "utf8");

  const create = functionBody(service, "createMarketingRequestDraft");
  const createGuard = create.indexOf("await assertNoMarketingRequestTwin(");
  const createWrite = create.indexOf("const requestInsert = await supabase");
  assert.ok(createGuard >= 0, "a first submit must refuse a twin");
  assert.ok(createWrite > createGuard, "the twin refusal must run before the request is inserted");

  const resubmit = functionBody(service, "resubmitReturnedMarketingRequest");
  const resubmitGuard = resubmit.indexOf("await assertNoMarketingRequestTwin(");
  const resubmitWrite = resubmit.indexOf('supabase.rpc("phx_resubmit_marketing_request"');
  assert.ok(resubmitGuard >= 0, "a resubmit must refuse a twin");
  assert.ok(resubmitWrite > resubmitGuard, "the twin refusal must run before the request re-enters the chain");

  assert.match(
    service,
    /throw validationError\(twinRefusalMessage\(\{ customerName, twin \}\), "marketing_request_twin"\)/,
    "the refusal is a validation error carrying the twin message",
  );
}

export function runMarketingRequestTwinGuardTests() {
  testFindsTheLiveTwin();
  testEveryKeyMustMatch();
  testOnlyLiveStatusesBlock();
  testTwinStatusesAreTheApprovedListPlusPending();
  testNeverItsOwnTwin();
  testEarliestTwinFirst();
  testMessagesNameCustomerAndCairoDate();
  testBothSubmitPathsCallTheGuardBeforeWriting();
}
