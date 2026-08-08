import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canonicalPharmacyMap,
  DEDUPE_OPEN_STATUSES,
  findDuplicateRequestGroups,
  groupDuplicatePharmacies,
  pharmacyIdentityKeys,
  type PharmacyForDedupe,
  type RequestForDedupe,
} from "../src/lib/direct-orders/duplicate-resolution.ts";

// ─────────────────────────────────────────────────────────────────────────────
// One real pharmacy entered twice, one real order submitted twice (owner rules 1-5, 2026-08-09).
//
// THE LIVE CASE. On 2026-08-06 a District Manager registered a pharmacy with the distributor's
// customer code typed into the NAME box (DOP-000017, name "1573270") and submitted LA001 × 240 at
// 25% for 59,400 EGP, collection 2026-09-11. The next evening she registered THE SAME pharmacy
// correctly (DOP-000021, "محمود احمد صالح", PS/0001573270 in its own column) and submitted THE SAME
// order again. Nothing noticed: two pharmacy records, two orders, 59,400 EGP standing twice, one
// copy already climbing the approval chain.
//
// The two failures this file prevents are opposites and both cost real money:
//   1. a duplicate going UNDETECTED — the company pays for one order twice, and
//   2. a merge or cancellation firing on records that are NOT the same thing — which silently moves
//      one pharmacy's sales onto another, or closes a live order somebody is waiting on.
// ─────────────────────────────────────────────────────────────────────────────

function pharmacy(overrides: Partial<PharmacyForDedupe> = {}): PharmacyForDedupe {
  return {
    id: "ph-1",
    phoenixPharmacyCode: "DOP-000001",
    pharmacyName: "صيدلية النور",
    brickId: "B201-3",
    areaCode: "D12",
    verificationStatus: "pending_review",
    active: true,
    createdAt: "2026-08-01T10:00:00.000Z",
    linkedCodes: [],
    nameCodeCandidates: [],
    ...overrides,
  };
}

function request(overrides: Partial<RequestForDedupe> = {}): RequestForDedupe {
  return {
    id: "req-1",
    pharmacyId: "ph-1",
    status: "pending_approval",
    productCode: "LA001",
    qty: 240,
    bonus: 0,
    dealType: "discount",
    discountPct: 25,
    collectionDate: "2026-09-11",
    requesterHrId: "b-154",
    submittedAt: "2026-08-06T12:19:44.000Z",
    approvedStepCount: 0,
    ...overrides,
  };
}

export function runDirectOrderDuplicateCleanupTests() {
  // ── Identity is the DISTRIBUTOR CODE, never the name ──────────────────────────────────────
  assert.deepEqual(
    pharmacyIdentityKeys(pharmacy({ linkedCodes: [{ distributorCode: "ps", customerCode: "0001573270" }] })),
    ["PS|1573270"],
    "the distributor is upper-cased and the customer code zero-stripped, so the padded master spelling and a hand-typed bare one land on ONE key",
  );
  assert.deepEqual(
    pharmacyIdentityKeys(pharmacy({ nameCodeCandidates: [{ distributorCode: "PS", customerCode: "1573270" }] })),
    ["PS|1573270"],
    "a code sitting in the NAME field is an identity key too — that is the whole wrong-box case",
  );

  // Placeholders denote NO customer. Two pharmacies both carrying "000000" are not thereby the same
  // pharmacy, and the placeholder is live on two records today — without this they would merge.
  for (const placeholder of ["000000", "00000"]) {
    assert.deepEqual(
      pharmacyIdentityKeys(pharmacy({ linkedCodes: [{ distributorCode: "PS", customerCode: placeholder }] })),
      [],
      `placeholder "${placeholder}" must contribute NO identity key — it denotes no customer, so it can never prove two records are one pharmacy`,
    );
  }
  assert.deepEqual(
    pharmacyIdentityKeys(pharmacy({ linkedCodes: [{ distributorCode: "", customerCode: "1573270" }] })),
    [],
    "a code with no distributor is not an identity — customer codes are only unique WITHIN a distributor",
  );

  // ── THE LIVE PAIR: two records, one pharmacy ──────────────────────────────────────────────
  const wrongBox = pharmacy({
    id: "ph-17",
    phoenixPharmacyCode: "DOP-000017",
    pharmacyName: "1573270",
    verificationStatus: "verified",
    createdAt: "2026-08-06T12:19:41.000Z",
    nameCodeCandidates: [{ distributorCode: "PS", customerCode: "0001573270" }],
  });
  const correct = pharmacy({
    id: "ph-21",
    phoenixPharmacyCode: "DOP-000021",
    pharmacyName: "محمود احمد صالح",
    createdAt: "2026-08-07T17:37:28.000Z",
    linkedCodes: [{ distributorCode: "PS", customerCode: "0001573270" }],
  });

  const groups = groupDuplicatePharmacies([wrongBox, correct]);
  assert.equal(groups.length, 1, "the two records must be recognised as ONE pharmacy");
  assert.equal(
    groups[0].survivorId,
    "ph-21",
    "the COMPLETE record survives — real name plus the code in its proper column. DOP-000017 is `verified` and DOP-000021 is not, so ranking verification above the code would keep the broken row and throw away the good one",
  );
  assert.deepEqual(groups[0].mergedIds, ["ph-17"]);
  assert.equal(groups[0].provenBy.customerCode, "1573270", "the shared customer is the evidence, and the screen shows it");

  // A verified-but-broken record must never outrank a complete one. This is the specific ranking
  // that would have destroyed the good record, so it gets its own assertion.
  assert.equal(
    groupDuplicatePharmacies([
      pharmacy({ id: "a", pharmacyName: "9999999", verificationStatus: "verified", nameCodeCandidates: [{ distributorCode: "PS", customerCode: "9999999" }] }),
      pharmacy({ id: "b", pharmacyName: "صيدلية حقيقية", verificationStatus: "pending_review", linkedCodes: [{ distributorCode: "PS", customerCode: "9999999" }] }),
    ])[0].survivorId,
    "b",
    "having the code linked outranks being verified — verification only records that somebody looked, the code is the evidence",
  );

  // ── Records that are NOT the same pharmacy must never merge ───────────────────────────────
  assert.deepEqual(
    groupDuplicatePharmacies([
      pharmacy({ id: "a", pharmacyName: "صيدلية النور", brickId: "B201-3", areaCode: "D12" }),
      pharmacy({ id: "b", pharmacyName: "صيدلية النور", brickId: "B201-3", areaCode: "D12" }),
    ]),
    [],
    "IDENTICAL name, brick and area is NOT evidence — thousands of pharmacies share a name and a brick. Only a shared distributor customer code merges anything",
  );
  assert.deepEqual(
    groupDuplicatePharmacies([
      pharmacy({ id: "a", linkedCodes: [{ distributorCode: "PS", customerCode: "1573270" }] }),
      pharmacy({ id: "b", linkedCodes: [{ distributorCode: "IBN", customerCode: "1573270" }] }),
    ]),
    [],
    "the same digits at two DIFFERENT distributors are two different customers — distributors keep separate code spaces",
  );

  // Transitive: A shares one code with B, B shares another with C. One customer cannot belong to two
  // pharmacies, so the chain holds and all three are one record.
  const chained = groupDuplicatePharmacies([
    pharmacy({ id: "a", linkedCodes: [{ distributorCode: "PS", customerCode: "111111" }] }),
    pharmacy({
      id: "b",
      linkedCodes: [
        { distributorCode: "PS", customerCode: "111111" },
        { distributorCode: "IBN", customerCode: "222222" },
      ],
    }),
    pharmacy({ id: "c", linkedCodes: [{ distributorCode: "IBN", customerCode: "222222" }] }),
  ]);
  assert.equal(chained.length, 1, "a shared-code chain must collapse into ONE group, not two overlapping pairs");
  assert.equal(chained[0].mergedIds.length, 2);

  // ── THE LIVE DUPLICATE ORDER ──────────────────────────────────────────────────────────────
  // Crucially it is only visible AFTER the merge folds the two pharmacy records together — which is
  // exactly how it hid in production for a day.
  const keeperSide = request({ id: "req-06", pharmacyId: "ph-17", status: "pending_approval", submittedAt: "2026-08-06T12:19:44.000Z" });
  const laterCopy = request({ id: "req-07", pharmacyId: "ph-21", status: "held", submittedAt: "2026-08-07T17:37:31.000Z" });

  assert.deepEqual(
    findDuplicateRequestGroups([keeperSide, laterCopy]),
    [],
    "WITHOUT the merge the two orders sit on different pharmacy ids and are invisible to each other — this is the production blind spot, asserted so it cannot be reintroduced",
  );

  const folded = canonicalPharmacyMap(groups);
  assert.equal(folded.get("ph-17"), "ph-21", "the canonical map must point the closed record at the survivor");
  const dupes = findDuplicateRequestGroups([keeperSide, laterCopy], folded);
  assert.equal(dupes.length, 1, "WITH the merge folded in, the pair is one order submitted twice");
  assert.equal(
    dupes[0].keeperId,
    "req-06",
    "the copy already in the approval chain is kept — cancelling it would throw away the chain progress and leave the held one to start over",
  );
  assert.deepEqual(dupes[0].duplicateIds, ["req-07"]);

  // Approvals already given outrank everything: cancelling a copy several managers have signed
  // destroys their work, so it survives even when it is the later and less advanced submission.
  const byApprovals = findDuplicateRequestGroups([
    request({ id: "early", status: "pending_approval", approvedStepCount: 0, submittedAt: "2026-08-01T00:00:00.000Z" }),
    request({ id: "late-but-approved", status: "pending_approval", approvedStepCount: 2, submittedAt: "2026-08-05T00:00:00.000Z" }),
  ]);
  assert.equal(
    byApprovals[0].keeperId,
    "late-but-approved",
    "decided rungs beat an earlier submission — the cost of a cancellation is the human work already done on it",
  );

  // ── Orders that are NOT duplicates must never be cancelled ────────────────────────────────
  const notDuplicates: Array<[string, RequestForDedupe]> = [
    ["a different product", request({ id: "x", productCode: "LA002" })],
    ["a different quantity", request({ id: "x", qty: 120 })],
    ["a different discount", request({ id: "x", discountPct: 20 })],
    ["a different deal type", request({ id: "x", dealType: "bonus" })],
    ["a different collection date", request({ id: "x", collectionDate: "2026-10-11" })],
    ["a different bonus quantity", request({ id: "x", bonus: 12 })],
  ];
  for (const [label, other] of notDuplicates) {
    assert.deepEqual(
      findDuplicateRequestGroups([request({ id: "base" }), other]),
      [],
      `${label} makes it a DIFFERENT order — cancelling it would close a real request somebody is waiting on`,
    );
  }

  // Two people entering the same order for the same pharmacy IS a duplicate — arguably a worse one,
  // since neither knows about the other. The requester is deliberately not part of the key.
  assert.equal(
    findDuplicateRequestGroups([request({ id: "mine", requesterHrId: "b-154" }), request({ id: "theirs", requesterHrId: "b-200" })]).length,
    1,
    "two DIFFERENT people entering the same order for the same pharmacy is still one order",
  );

  // ── An APPROVED order can never be cancelled as a duplicate ───────────────────────────────
  assert.ok(
    !(DEDUPE_OPEN_STATUSES as readonly string[]).includes("approved"),
    "approved is money committed and, once a sales month is set, injected into Source of Sales — undoing it is a REVERSAL with its own re-approval, never a quiet duplicate cancellation",
  );
  for (const terminal of ["approved", "rejected", "cancelled", "expired", "reversed"]) {
    assert.deepEqual(
      findDuplicateRequestGroups([request({ id: "open" }), request({ id: "closed", status: terminal })]),
      [],
      `a ${terminal} request must never be paired for cancellation — it is already closed or already money`,
    );
  }

  // ── Owner rule 2: resolving a pharmacy resolves EVERY request on it ───────────────────────
  {
    const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const start = service.indexOf("async function moveHeldDirectOrdersIntoChain");
    assert.ok(start > 0, "the shared held-release core must exist");
    const body = service.slice(start, service.indexOf("\nasync function ", start + 1));
    assert.match(
      body,
      /\.eq\("pharmacy_id", pharmacyId\)[\s\S]{0,200}\.eq\("status", "held"\)/,
      "release must select by PHARMACY and held status — pharmacy-wide is the owner's rule 2, and a per-request filter would resolve one order and leave its siblings frozen",
    );
    assert.ok(
      !/\.limit\(/.test(body),
      "no limit on the held-release query: a pharmacy with more held orders than the cap would silently leave the remainder frozen, which reads as the fix having worked",
    );

    // Owner rule 1: the repair pass must run over EXISTING records, not only new submissions.
    assert.match(
      service,
      /export async function getDirectOrderCleanupPlan/,
      "the cleanup plan is what repairs records created before auto-link existed (owner rule 1)",
    );
    // The apply path re-validates live status before cancelling. A plan read minutes ago may name a
    // request that has since been approved.
    const applyStart = service.indexOf("export async function confirmDirectOrderCleanup");
    assert.ok(applyStart > 0, "the apply path must exist");
    const applyBody = service.slice(applyStart);
    assert.match(
      applyBody,
      /DEDUPE_OPEN_STATUSES as readonly string\[\]\)\.includes\(status\)/,
      "the apply path must re-read each request's LIVE status before cancelling it — trusting the plan would let an order approved in the meantime be closed as a duplicate",
    );
    assert.match(
      applyBody,
      /decideDirectOrderHold\(\{/,
      "release must re-run the SAME hold rule the submit fork runs — the cleanup releases what it actually fixed, never everything it touched",
    );
  }

  // ── The migration: no new statuses, and the loader simulation is present ──────────────────
  {
    const migration = readFileSync(
      new URL("../supabase/migrations/20260809031500_direct_orders_duplicate_cleanup.sql", import.meta.url),
      "utf8",
    );
    assert.match(migration, /'key', 'cancel_duplicate'/, "the action must be declared in the registry row");
    assert.match(
      migration,
      /raise exception 'direct_orders registry would be SKIPPED by the loader/,
      "the loader simulation must run before commit — its absence is what let the 2026-08-05 outage ship",
    );
    assert.ok(
      !/set statuses|statuses =/.test(migration),
      "this migration must NOT touch the status list: every source and target it uses is already declared, and adding one is how an action comes to reference an undeclared status",
    );
    assert.ok(
      !/\bversion\s*=/.test(migration),
      "version must not be set explicitly — the touch trigger already bumps it, and setting it moved the row 5 -> 7 instead of 5 -> 6 on 2026-08-05",
    );
    assert.ok(
      !/'approved'/.test(migration.slice(migration.indexOf("'key', 'cancel_duplicate'"), migration.indexOf("-- `version` is deliberately"))),
      "approved must not be a source status for cancel_duplicate — an approved order is reversed, never cancelled as a duplicate",
    );

    // The union, the DB row and the call site have to land together (audit finding F2).
    const workflow = readFileSync(new URL("../src/lib/direct-orders/workflow.ts", import.meta.url), "utf8");
    assert.match(
      workflow,
      /\|\s*"cancel_duplicate"/,
      "DirectOrderWorkflowActionKey must list cancel_duplicate — a key in the migration but not the union is the F2 drift class",
    );
  }

  // ── The reviewer gate: SFE Manager as well as Super Admin (owner rule 5) ──────────────────
  {
    const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const gateStart = service.indexOf("function assertDirectOrderCleanupAccess");
    assert.ok(gateStart > 0, "the cleanup access gate must exist");
    const gate = service.slice(gateStart, gateStart + 400);
    assert.match(gate, /"SFE Manager"/, "the owner put SFE in the reviewer's seat for this cleanup");
    assert.match(gate, /"Super Admin"/, "Super Admin keeps access too");

    const nav = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");
    const navIdx = nav.indexOf('href: "/admin/direct-orders/cleanup"');
    assert.ok(navIdx > 0, "the cleanup desk must be reachable from the nav, not only by typing a URL");
    assert.match(
      nav.slice(navIdx, navIdx + 700),
      /roles: \["Super Admin", "SFE Manager"\]/,
      "the link and the server gate must admit the SAME roles — a wider link only leads to a 403, a narrower one hides the page from the person who owns the work",
    );

    // Nothing writes on the read path. The plan is a proposal; a GET that mutated would apply the
    // cleanup merely by opening the page.
    const planStart = service.indexOf("export async function getDirectOrderCleanupPlan");
    const planBody = service.slice(planStart, service.indexOf("/** What an SFE Manager confirmed", planStart));
    assert.ok(
      !/\.update\(|\.insert\(|\.delete\(/.test(planBody),
      "the plan is a READ — opening the review page must never write anything, or the review is not a review",
    );
  }
}
