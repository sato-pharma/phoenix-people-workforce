import assert from "node:assert/strict";

import {
  findLookAlikeVenues,
  groupDuplicatePharmacies,
  type PharmacyForDedupe,
} from "../src/lib/direct-orders/duplicate-resolution.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Venue records that look alike and that the merge rule will NOT rule on.
//
// THE LIVE CASE, measured against production rows on 2026-08-29. `groupDuplicatePharmacies` runs
// two passes that partition the input: the code pass sees only records carrying an identity key,
// the name+area pass only records carrying none. That partition is correct — it stops a resemblance
// from diluting a distributor-proven fact — and it has a blind spot that two live pairs sit in:
//
//   محمد فتحي أبو زيد  · AB5 · DOP-000040 (no code)  + DOP-000041 (PS/0001576761)
//   المنصورية الجديدة · GZ3 · DOP-000009 (no code)  + DOP-000049 (PS/0001539236)
//
// One coded record beside one codeless one. The code pass has nothing to compare the codeless row
// against; the name pass excludes the coded row by design. Neither can see the pair, so it reached
// no screen at all and a rep could pick either half.
//
// WHAT THIS FILE PINS, and the two failures are opposites:
//   1. the pair going UNSEEN again — the reason this function exists; and
//   2. this list quietly becoming a MERGE — every group it can produce has approved orders on at
//      least one side, and the owner's rule of 2026-08-29 is that a venue row carrying confirmed
//      orders is never touched. `confirmDirectOrderCleanup` repoints requests with no status
//      filter, so a merge moves approved orders too. A review list that grows a survivor and a
//      write path is the one regression that would turn a safe screen into a dangerous one.
// ─────────────────────────────────────────────────────────────────────────────

function pharmacy(overrides: Partial<PharmacyForDedupe> = {}): PharmacyForDedupe {
  return {
    id: "ph-1",
    phoenixPharmacyCode: "DOP-000001",
    pharmacyName: "محمد فتحي أبو زيد",
    brickId: "B155-1",
    areaCode: "AB5",
    verificationStatus: "verified",
    active: true,
    createdAt: "2026-08-19T13:25:38.000Z",
    linkedCodes: [],
    nameCodeCandidates: [],
    normalizedName: "محمدفتحيابوزيد",
    ...overrides,
  };
}

/** The live AB5 pair: one codeless record, one carrying a real distributor code. */
function livePair(): PharmacyForDedupe[] {
  return [
    pharmacy({ id: "codeless", phoenixPharmacyCode: "DOP-000040" }),
    pharmacy({
      id: "coded",
      phoenixPharmacyCode: "DOP-000041",
      createdAt: "2026-08-19T18:09:40.000Z",
      linkedCodes: [{ distributorCode: "PS", customerCode: "0001576761" }],
    }),
  ];
}

export function runDirectOrderVenueLookAlikeTests() {
  // ── 1. The blind spot itself ────────────────────────────────────────────────
  const pair = livePair();
  const proposals = groupDuplicatePharmacies(pair);
  assert.equal(
    proposals.length,
    0,
    "guard on the premise: the merge rule must still refuse this pair. If it starts proposing it, " +
      "this whole function is redundant and the test below is measuring nothing",
  );

  const groups = findLookAlikeVenues(pair, proposals);
  assert.equal(
    groups.length,
    1,
    "one coded record beside one codeless one, same name and same area, must be surfaced — this is " +
      "the pair that reached no screen at all",
  );
  assert.equal(groups[0].blocker, "one-side-has-a-code");
  assert.deepEqual(
    [...groups[0].memberIds].sort(),
    ["codeless", "coded"].sort(),
    "both halves must be listed — a reviewer comparing two records needs both of them",
  );
  assert.equal(groups[0].areaCode, "AB5");

  // ── 2. It must never become a merge ─────────────────────────────────────────
  //
  // Shape, not wording: a look-alike group carries no survivor and no merge list, so no caller can
  // pass it to confirmDirectOrderCleanup even by mistake.
  const shape = Object.keys(groups[0]).sort();
  assert.deepEqual(
    shape,
    ["areaCode", "blocker", "explanation", "memberIds", "normalizedName"],
    "a look-alike group must expose NOTHING a write path could consume — no survivorId, no " +
      "mergedIds. Every pair this can produce has approved orders on at least one side, and a row " +
      "carrying confirmed orders is never touched (owner, 2026-08-29)",
  );

  // ── 3. A pair the merge rule ALREADY proposes is not repeated here ──────────
  //
  // The live "433106" shape: both records digit-named, so both pick up the same two name-code
  // candidates from the distributor master and union normally. It is already on the desk with a
  // survivor and a checkbox; listing it again would ask one question twice and invite two answers.
  const digitNamed = [
    pharmacy({
      id: "d33",
      phoenixPharmacyCode: "DOP-000033",
      pharmacyName: "433106",
      normalizedName: "433106",
      areaCode: "GZ1",
      linkedCodes: [{ distributorCode: "IS-S", customerCode: "433106" }],
      nameCodeCandidates: [
        { distributorCode: "IS", customerCode: "433106" },
        { distributorCode: "IS-S", customerCode: "433106" },
      ],
    }),
    pharmacy({
      id: "d34",
      phoenixPharmacyCode: "DOP-000034",
      pharmacyName: "433106",
      normalizedName: "433106",
      areaCode: "GZ1",
      linkedCodes: [{ distributorCode: "IS", customerCode: "433106" }],
      nameCodeCandidates: [
        { distributorCode: "IS", customerCode: "433106" },
        { distributorCode: "IS-S", customerCode: "433106" },
      ],
    }),
  ];
  const digitProposals = groupDuplicatePharmacies(digitNamed);
  assert.equal(digitProposals.length, 1, "guard on the premise: the 433106 shape IS already a merge proposal");
  assert.deepEqual(
    findLookAlikeVenues(digitNamed, digitProposals),
    [],
    "a pair the desk already proposes as a merge must not also appear as a look-alike",
  );

  // ── 4. The area anchor still holds ──────────────────────────────────────────
  const differentAreas = [
    pharmacy({ id: "a", areaCode: "AB5" }),
    pharmacy({
      id: "b",
      areaCode: "D12",
      linkedCodes: [{ distributorCode: "PS", customerCode: "0001576761" }],
    }),
  ];
  assert.deepEqual(
    findLookAlikeVenues(differentAreas, groupDuplicatePharmacies(differentAreas)),
    [],
    "the area is the anchor that stops a common name from pairing two unrelated venues — a review " +
      "list padded with coincidences is one nobody reads twice",
  );

  // ── 5. Two codes that disagree read as a different blocker ──────────────────
  const rivalCodes = [
    pharmacy({ id: "x", linkedCodes: [{ distributorCode: "PS", customerCode: "0001111111" }] }),
    pharmacy({ id: "y", linkedCodes: [{ distributorCode: "IS", customerCode: "0002222222" }] }),
  ];
  const rival = findLookAlikeVenues(rivalCodes, groupDuplicatePharmacies(rivalCodes));
  assert.equal(rival.length, 1);
  assert.equal(
    rival[0].blocker,
    "different-codes",
    "both records coded, and the codes disagree — the reviewer must be told THAT, not the " +
      "codeless story, because it is a different question to answer",
  );

  // ── 6. A wholly codeless pair belongs to the merge rule, not here ───────────
  const bothCodeless = [
    pharmacy({ id: "p", normalizedName: "حضانهزمزم", areaCode: "D15" }),
    pharmacy({ id: "q", normalizedName: "حضانهزمزم", areaCode: "D15" }),
  ];
  const codelessProposals = groupDuplicatePharmacies(bothCodeless);
  assert.equal(codelessProposals.length, 1, "guard on the premise: the name+area pass owns a wholly codeless pair");
  assert.deepEqual(
    findLookAlikeVenues(bothCodeless, codelessProposals),
    [],
    "the name+area pass already proposes this one as a real merge — it must not be downgraded to a " +
      "review note, which would take a mergeable pair OFF the actionable list",
  );

  // ── 7. A lone record is not a look-alike ────────────────────────────────────
  const single = [pharmacy({ id: "only" })];
  assert.deepEqual(findLookAlikeVenues(single, groupDuplicatePharmacies(single)), []);
}
