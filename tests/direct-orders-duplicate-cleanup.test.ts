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
    // Empty by default: these fixtures carry linkedCodes, so pharmacyIdentityKeys() never falls
    // through to the name+area fallback and this field is never read for them.
    normalizedName: "",
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

/**
 * Slice a top-level declaration out of a source file by its REAL end — the next top-level
 * declaration — instead of a fixed byte count. A magic window measures source LENGTH, not the
 * invariant it claims to guard: it false-FAILS the moment the pinned function grows past the
 * window (the regression fixed in PR #2288), and it false-PASSES when a function that genuinely
 * lost its marker spills into the next function's copy of it.
 */
function topLevelBlock(source: string, start: number): string {
  if (start < 0) return "";
  const rest = source.slice(start + 1);
  const next = rest.search(/^(?:export )?(?:async )?function |^(?:export )?(?:const|type|interface|class) /m);
  return source.slice(start, next >= 0 ? start + 1 + next : source.length);
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
  assert.equal(groups[0].provenBy.kind, "code", "these two share a distributor code — that is the strong evidence, not a name resemblance");
  assert.equal(
    groups[0].provenBy.kind === "code" ? groups[0].provenBy.customerCode : null,
    "1573270",
    "the shared customer is the evidence, and the screen shows it",
  );

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

  // ── A request may now carry SEVERAL products (Lacto Advanced 1 + 2 on one order) ──────────
  //
  // The request's singular product_code/qty/bonus columns hold only the FIRST line. Keying on those
  // alone would call two different baskets the same order whenever their first lines matched, and an
  // SFE Manager — shown two orders the system says are identical — would confirm the cancellation of
  // a line the pharmacy actually wants. So the key is EVERY line, on identical terms.
  {
    const LACTO_1 = { productCode: "LA001", qty: 240, bonus: 0, dealType: "discount", discountPct: 25 };
    const LACTO_2 = { productCode: "LA002", qty: 60, bonus: 0, dealType: "discount", discountPct: 25 };
    const basket = (id: string, lines: typeof LACTO_1[]) =>
      request({ id, lines, productCode: lines[0].productCode, qty: lines[0].qty, bonus: lines[0].bonus });

    assert.equal(
      findDuplicateRequestGroups([basket("basket-a", [LACTO_1, LACTO_2]), basket("basket-b", [LACTO_1, LACTO_2])]).length,
      1,
      "the same basket entered twice is still one order",
    );

    assert.deepEqual(
      findDuplicateRequestGroups([basket("both", [LACTO_1, LACTO_2]), basket("just-one", [LACTO_1])]),
      [],
      "THE REGRESSION: a two-product basket and a one-product order sharing a first line are DIFFERENT " +
        "orders — proposing them as duplicates would cancel a Lacto Advanced 2 line somebody ordered",
    );

    assert.deepEqual(
      findDuplicateRequestGroups([
        basket("qty-a", [LACTO_1, LACTO_2]),
        basket("qty-b", [LACTO_1, { ...LACTO_2, qty: 120 }]),
      ]),
      [],
      "a different quantity on the SECOND line makes it a different order, exactly as it does on the first",
    );

    assert.equal(
      findDuplicateRequestGroups([basket("in-order", [LACTO_1, LACTO_2]), basket("reversed", [LACTO_2, LACTO_1])]).length,
      1,
      "the two concentrations entered in either order are the same basket — the key is sorted, so " +
        "which one the requester picked first is not a commercial difference",
    );

    // A caller that has not loaded the lines must behave EXACTLY as it did before baskets existed —
    // otherwise adding line items would quietly change what the cleanup pass proposes.
    assert.equal(
      findDuplicateRequestGroups([request({ id: "no-lines-a" }), request({ id: "no-lines-b" })]).length,
      1,
      "with no lines supplied the request's own columns are the key, unchanged",
    );
    assert.deepEqual(
      findDuplicateRequestGroups([basket("with-lines", [LACTO_1]), request({ id: "without-lines" })]).map((p) => p.duplicateIds.length),
      [1],
      "a single-line basket and the same order expressed in the singular columns are the SAME order — " +
        "which is what the migration's backfill made every existing request",
    );

    const [proposal] = findDuplicateRequestGroups([basket("ev-a", [LACTO_1, LACTO_2]), basket("ev-b", [LACTO_1, LACTO_2])]);
    assert.deepEqual(
      proposal.matchedOn.productCodes,
      ["LA001", "LA002"],
      "the evidence names every product that matched, not just the first — an SFE Manager confirming " +
        "a cancellation must see the whole order they are closing",
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
    const gate = topLevelBlock(service, gateStart);
    assert.match(gate, /"SFE Manager"/, "the owner put SFE in the reviewer's seat for this cleanup");
    assert.match(gate, /"Super Admin"/, "Super Admin keeps access too");

    const nav = readFileSync(new URL("../src/config/system-navigation.ts", import.meta.url), "utf8");
    const navIdx = nav.indexOf('href: "/admin/direct-orders/cleanup"');
    assert.ok(navIdx > 0, "the cleanup desk must be reachable from the nav, not only by typing a URL");
    // Bounded by the nav item's own closing brace, not 700 bytes. The item is ~640 bytes today —
    // one more line of description and the window would stop before the `roles:` line it exists
    // to read, and report a role drift that never happened.
    const navEnd = nav.slice(navIdx).search(/^  \},$/m);
    assert.match(
      nav.slice(navIdx, navEnd >= 0 ? navIdx + navEnd : nav.length),
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

  // ── The name+area fallback, for pharmacies the code match cannot see at all (owner, 2026-08-13) ──
  //
  // THE LIVE CASE. "حضانه زمزم", area D15, registered twice the same day by the same rep — DOP-000018
  // and DOP-000019, neither carrying a distributor code, so pharmacyIdentityKeys() returns an empty
  // array for both and the code matcher above has nothing to compare, right or wrong. This block is
  // the regression test for exactly that shape.
  {
    const zamzam1 = pharmacy({
      id: "ph-18",
      phoenixPharmacyCode: "DOP-000018",
      pharmacyName: "حضانه زمزم",
      areaCode: "D15",
      // Verified against the real function, not guessed: phx_normalize_arabic('حضانه زمزم') on
      // staging returns exactly this — ة→ه and the space both fold, ض is untouched (only the
      // alef/ta-marbuta/ya family folds; ض was never in it, and assuming otherwise by eye is
      // exactly the class of mistake this design avoids by never re-deriving the fold in TS).
      normalizedName: "حضانهزمزم",
      linkedCodes: [],
      createdAt: "2026-08-06T09:00:00.000Z",
    });
    const zamzam2 = pharmacy({
      id: "ph-19",
      phoenixPharmacyCode: "DOP-000019",
      pharmacyName: "حضانه زمزم",
      areaCode: "D15",
      normalizedName: "حضانهزمزم",
      linkedCodes: [],
      createdAt: "2026-08-06T14:00:00.000Z",
    });

    const groups = groupDuplicatePharmacies([zamzam1, zamzam2]);
    assert.equal(groups.length, 1, "two codeless records, same name, same area — the live DOP-000018/19 case must cluster");
    assert.equal(groups[0].provenBy.kind, "name", "neither record carries a code, so the evidence must be the name+area match, not a code");
    assert.equal(
      groups[0].provenBy.kind === "name" ? groups[0].provenBy.areaCode : null,
      "D15",
      "the evidence must name the area that anchored the match",
    );
    assert.deepEqual([groups[0].survivorId, ...groups[0].mergedIds].sort(), ["ph-18", "ph-19"]);

    // Prove the regression rather than assume it: without the name+area pass, this exact input
    // produces zero proposals — the shape this feature exists to fix.
    assert.equal(
      groupDuplicatePharmacies([zamzam1, zamzam2].map((p) => ({ ...p, normalizedName: "" }))).length,
      0,
      "with no normalized name supplied, the two records must NOT cluster — this is what proves the " +
        "fallback is doing the work, not some other path silently matching on the raw name",
    );
  }

  // ── The fallback trusts the CALLER's normalization, and does not re-derive its own ─────────
  //
  // duplicate-resolution.ts has no database access and must not reimplement Arabic folding —
  // phx_normalize_arabic is the one place that logic lives. Two different raw spellings that the
  // SQL function folds to the same string must cluster.
  //
  // This is the EXACT example 20260807120000's own header comment documents (Nermeen Salah's case:
  // "ابوالفتوح" stored as one word, typed as two) — reused rather than invented, and both fold
  // strings below are verified against the real function, not guessed:
  //   phx_normalize_arabic('ابوالفتوح صيدلية') = phx_normalize_arabic('ابو الفتوح صيدلية')
  //   = 'ابوالفتوحصيدليه'  (checked on staging, 2026-08-13)
  {
    const spacedOneWord = pharmacy({
      id: "ph-30",
      pharmacyName: "ابوالفتوح صيدلية",
      areaCode: "A1",
      normalizedName: "ابوالفتوحصيدليه",
      linkedCodes: [],
    });
    const spacedTwoWords = pharmacy({
      id: "ph-31",
      pharmacyName: "ابو الفتوح صيدلية", // different raw spelling, same real place
      areaCode: "A1",
      normalizedName: "ابوالفتوحصيدليه",
      linkedCodes: [],
    });
    const clustered = groupDuplicatePharmacies([spacedOneWord, spacedTwoWords]);
    assert.equal(clustered.length, 1, "two raw spellings sharing a normalized form must cluster — the whole point of reusing phx_normalize_arabic");
  }

  // ── The area anchor: same name, different area, must NOT cluster ───────────────────────────
  //
  // "Al Nour Pharmacy" is not an unusual name. Without an area anchor, every codeless pharmacy
  // sharing a common name anywhere in the country would be proposed as one merge.
  //
  // normalizedName verified against the real function (staging, 2026-08-13):
  // phx_normalize_arabic('صيدلية النور') = 'صيدليهالنور'.
  {
    const cairo = pharmacy({ id: "ph-40", pharmacyName: "صيدلية النور", areaCode: "C1", normalizedName: "صيدليهالنور", linkedCodes: [] });
    const alex = pharmacy({ id: "ph-41", pharmacyName: "صيدلية النور", areaCode: "X9", normalizedName: "صيدليهالنور", linkedCodes: [] });
    assert.deepEqual(
      groupDuplicatePharmacies([cairo, alex]),
      [],
      "same normalized name in DIFFERENT areas must not be proposed as one pharmacy",
    );
  }

  // ── A coded pharmacy is NEVER pulled into a name cluster, in either direction ───────────────
  //
  // A pharmacy with even one linked code has real evidence; a name match must never dilute it, and
  // a name match must never let a coded record's identity leak onto an unrelated codeless one that
  // happens to share its name and area.
  //
  // normalizedName verified against the real function (staging, 2026-08-13):
  // phx_normalize_arabic('صيدلية الشفاء') = 'صيدليهالشفاء'.
  {
    const coded = pharmacy({
      id: "ph-50",
      pharmacyName: "صيدلية الشفاء",
      areaCode: "B2",
      normalizedName: "صيدليهالشفاء",
      linkedCodes: [{ distributorCode: "PS", customerCode: "9999999" }],
    });
    const codelessSameNameArea = pharmacy({
      id: "ph-51",
      pharmacyName: "صيدلية الشفاء",
      areaCode: "B2",
      normalizedName: "صيدليهالشفاء",
      linkedCodes: [],
    });
    assert.deepEqual(
      groupDuplicatePharmacies([coded, codelessSameNameArea]),
      [],
      "a coded pharmacy and a codeless one sharing a name+area must NOT merge on that alone — " +
        "identity is the code wherever a code exists, and the fallback is scoped to pharmacies with none",
    );
  }

  // ── A merged-away venue must not come back on the registry board ─────────────────────
  //
  // The admin board's four summary chips — venue total, waiting for a System Admin, no distributor
  // code, not linked to a CRM contact — are each `rows.filter(...).length` over the prop the page
  // hands straight from listDirectOrderPharmacyRegistry. The chips are therefore exactly as honest
  // as that one query, and sizing the outstanding work is the only thing a chip is for: a tombstone
  // counted into one overstates the backlog with nothing on screen to give it away.
  //
  // MEASURED ON PRODUCTION, 2026-09-03: 74 venue rows — 52 active, 22 inactive, 10 merged, and
  // merged-but-still-active ZERO. So `active` alone already selects exactly the 52 reachable venues
  // and this filter moves no row today. That coincidence is the reason to pin it rather than to skip
  // it. Nothing in the schema ties the two columns — 20260809031500 adds an FK and a not-self check,
  // no pairing constraint — so the entire invariant is confirmDirectOrderCleanup happening to write
  // `active: false` in the same update that sets merged_into_pharmacy_id. One writer that sets the
  // merge without the deactivation and a retired duplicate is back in the list, the picker and the
  // counts; AGENTS.md sends a merge that stranded a desk validation to hand SQL, which is precisely
  // such a writer.
  {
    const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const start = service.indexOf("export async function listDirectOrderPharmacyRegistry");
    assert.ok(start > 0, "the registry read must be findable");
    const body = topLevelBlock(service, start);
    // Substring checks rather than regex literals, deliberately. The escaping in a regex is one
    // transport layer away from being flattened, and the flattened form still MATCHES — an unescaped
    // /.is("x", null)/ reads every dot and paren as syntax and passes on text that is not the call
    // at all. A pinning test that goes green for the wrong reason is the failure this file exists
    // to prevent, so these ask for the literal bytes.
    assert.ok(
      body.includes('.is("merged_into_pharmacy_id", null)'),
      "the registry read must exclude merged-away venues BY NAME rather than trusting the merge to have " +
        "deactivated them — whatever this query returns is what the board counts, edits and offers",
    );
    assert.ok(
      body.includes('.eq("active", true)'),
      "and it must still exclude deactivated venues — 11 rejected rows and 1 retired one are live in " +
        "production and belong in neither the list nor the chips",
    );

    // WHY the query is the only place this can happen: the row the board receives carries no merged
    // marker at all, so no amount of client-side filtering could recover one. Mapping the column
    // instead would be the wrong repair — it would put a tombstone on screen and ask the component to
    // hide it, giving 'reachable' a second definition that nobody re-measures against the database.
    const mapStart = service.indexOf("function mapPharmacyRow");
    assert.ok(mapStart > 0, "mapPharmacyRow must be findable");
    assert.ok(
      !topLevelBlock(service, mapStart).includes("merged_into_pharmacy_id"),
      "the venue row must NOT carry a merged marker to the client — reachability is settled once, at " +
        "the query, and a board that could see the flag would eventually be asked to filter on it too",
    );
  }

  // ── The cancellation must reach the person whose order it was ─────────────────────────────
  //
  // The workflow registry has declared `notify requester + CC` for cancel_duplicate since the action
  // was added (2026-08-09) and NOTHING sent it. The event row and the audit row are both admin-side,
  // so an order was closed under its requester without a word reaching them. The registry screen
  // cannot catch this: it renders the DECLARATION, so the gap reads as compliant from the one place
  // built to police it — which is why the check has to live here, against the code.
  {
    const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const body = topLevelBlock(service, service.indexOf("export async function confirmDirectOrderCleanup"));
    assert.ok(body.length > 0, "confirmDirectOrderCleanup must be findable");
    assert.ok(
      body.includes("notifyDirectOrder({"),
      "cancelling a duplicate must NOTIFY the requester — an audit row is not a notification: it is " +
        "read by the desk, never by the person whose order was closed",
    );
    assert.ok(
      body.includes('channels: ["in_app", "telegram"],'),
      "and it must drop EMAIL, exactly as its sibling cancel_held does — having one's own superseded " +
        "duplicate tidied away is not news worth an inbox entry, and widening this would put every " +
        "cleanup into a District Manager's mailbox",
    );
    // The notice addresses the requester, so the row it is built from must carry one. The narrowed
    // select this replaced would leave requesterHrId undefined and the notification would still
    // "send" — to nobody — with no error raised anywhere.
    assert.ok(
      !body.includes('.select("id, status")'),
      "the duplicate's row must not be read through a narrowed select — the notification needs the " +
        "requester and the pharmacy, and a missing recipient fails SILENTLY rather than loudly",
    );
  }
}
