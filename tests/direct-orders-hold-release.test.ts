import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildDirectOrderSalesMatrix } from "../src/lib/direct-orders/approval-fields.ts";
import { checkDirectOrderGeography, describeResolvedAddressPlace } from "../src/lib/direct-orders/geography-check.ts";
import {
  customerCodesMatch,
  decideDirectOrderAutoLink,
  decideDirectOrderHold,
  describeDirectOrderAutoLinkRefusal,
  isDirectOrderHistoryProductVisible,
  normalizeCustomerCode,
  type DirectOrderAutoLinkCandidate,
  type DirectOrderAutoLinkRefusal,
  type DirectOrderHoldCandidateCode,
} from "../src/lib/direct-orders/hold-decision.ts";
import type { DirectOrderPharmacyVerificationStatus } from "../src/lib/direct-orders/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The held fork (owner rule, 2026-08-08): the DISTRIBUTOR code is the proof, not the Sato code.
//
// Before this, the fork was one line reading `verificationStatus === "pending_review"` and nothing
// else — so a hand-typed pharmacy whose code resolved perfectly and one with no code at all routed
// IDENTICALLY into the held lane. Eight live orders worth 243,871.75 EGP sat there.
//
// The two failures this file exists to prevent are opposites, and both cost real money:
//   1. a REAL pharmacy frozen out of the chain until the 14-day clock kills its order, and
//   2. a mistyped code that happens to be real ELSEWHERE releasing an order onto the wrong
//      pharmacy's geography — the mis-attribution the old code's comment was written to defend.
// ─────────────────────────────────────────────────────────────────────────────

function code(overrides: Partial<DirectOrderHoldCandidateCode> = {}): DirectOrderHoldCandidateCode {
  return {
    distributorCode: "PS",
    distributorName: "overseas",
    customerCode: "0001573270",
    mappedBrickId: "B201-3",
    mappedAreaCode: "D12",
    mappedRegionCode: "D1",
    ...overrides,
  };
}

function candidate(overrides: Partial<DirectOrderAutoLinkCandidate> = {}): DirectOrderAutoLinkCandidate {
  return {
    distributorCode: "PS",
    distributorName: "overseas",
    customerCode: "0001573270",
    customerName: "محمود احمد صالح الجديدة",
    areaCode: "D12",
    brickId: "B201-3",
    ownedByOtherPharmacyId: null,
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

export function runDirectOrderHoldReleaseTests() {
  // ── Code normalization: the master pads, humans type bare ─────────────────────────────────
  assert.equal(normalizeCustomerCode("0001573270"), "1573270");
  assert.equal(normalizeCustomerCode("1573270"), "1573270");
  assert.equal(
    customerCodesMatch("1573270", "0001573270"),
    true,
    "THE LIVE CASE: a human typed 1573270, the master stores 0001573270 — zero-padding must not hide a real match",
  );
  assert.equal(
    customerCodesMatch("31573270", "1573270"),
    false,
    "SUFFIX TRAP: a longer code must never match a shorter one. This is what an .ilike('%code') would wrongly admit",
  );
  // The live placeholders. If these ever match, Nermeen's two orders release on no evidence at all.
  for (const placeholder of ["000000", "00000", "0", ""]) {
    assert.equal(
      customerCodesMatch(placeholder, placeholder),
      false,
      `PLACEHOLDER "${placeholder}" must match nothing — not even itself. It denotes no customer`,
    );
  }
  assert.equal(normalizeCustomerCode("brgthyrhyuj"), null, "junk is not a code");
  assert.equal(normalizeCustomerCode(null), null);

  // ── The fork, executed ─────────────────────────────────────────────────────────────────────

  // Today's behaviour, which must not regress.
  assert.equal(
    decideDirectOrderHold({
      verificationStatus: "verified",
      declaredBrickId: "B201-3",
      distributorCodes: [],
      holdReleaseGround: null,
    }).hold,
    false,
    "a confirmed pharmacy has never been held and still is not",
  );

  // No code at all — nothing to prove anything with.
  const unproven = decideDirectOrderHold({
    verificationStatus: "pending_review",
    declaredBrickId: "B192-1",
    distributorCodes: [],
    holdReleaseGround: null,
  });
  assert.equal(unproven.hold, true);
  assert.equal(unproven.ground, "unproven");

  // THE HEADLINE: a resolving code whose brick agrees releases the order.
  const proven = decideDirectOrderHold({
    verificationStatus: "pending_review",
    declaredBrickId: "B201-3",
    distributorCodes: [code()],
    holdReleaseGround: null,
  });
  assert.equal(proven.hold, false, "a code the master database recognises, in the declared brick, proves the pharmacy");
  assert.equal(proven.ground, "code_proven");
  assert.deepEqual(proven.provenBy, { distributorCode: "PS", customerCode: "0001573270" });

  // THE REGRESSION THAT MATTERS MOST. The owner chose brick-level strictness over area-level. If
  // this assertion ever flips, a code mistyped onto a real customer in another brick releases an
  // order onto the wrong geography — and sales attribution follows the brick.
  const wrongBrick = decideDirectOrderHold({
    verificationStatus: "pending_review",
    declaredBrickId: "B192-1",
    distributorCodes: [code({ mappedBrickId: "B201-3" })],
    holdReleaseGround: null,
  });
  assert.equal(
    wrongBrick.hold,
    true,
    "MIS-ATTRIBUTION GUARD: a real code whose brick disagrees with the request must STAY HELD, however tempting the match looks",
  );
  assert.equal(wrongBrick.ground, "code_conflict");
  assert.equal(wrongBrick.conflicts[0]?.kind, "brick_mismatch");
  assert.equal(wrongBrick.conflicts[0]?.mappedBrickId, "B201-3");
  assert.equal(wrongBrick.conflicts[0]?.declaredBrickId, "B192-1");

  // Two Phoenix pharmacies pointing at one distributor customer is the collision in its pure form.
  const stolen = decideDirectOrderHold({
    verificationStatus: "pending_review",
    declaredBrickId: "B201-3",
    distributorCodes: [code({ ownedByOtherPharmacyId: "other-pharmacy-id" })],
    holdReleaseGround: null,
  });
  assert.equal(stolen.hold, true, "a code already owned by another pharmacy proves nothing about this one");
  assert.equal(stolen.conflicts[0]?.kind, "owned_by_another_pharmacy");

  // An unresolved code contributes neither proof nor conflict — it is simply not evidence.
  const placeholderOnly = decideDirectOrderHold({
    verificationStatus: "pending_review",
    declaredBrickId: "B192-1",
    distributorCodes: [code({ customerCode: "000000", mappedBrickId: null, mappedAreaCode: null })],
    holdReleaseGround: null,
  });
  assert.equal(placeholderOnly.hold, true, "NERMEEN'S CASE: a placeholder code that resolves to nothing must stay held");
  assert.equal(placeholderOnly.ground, "unproven", "an unresolvable code is 'unproven', not a 'conflict' — nothing conflicted");

  // A resolving code sitting beside a junk one still releases: one proof is enough.
  const mixed = decideDirectOrderHold({
    verificationStatus: "pending_review",
    declaredBrickId: "B201-3",
    distributorCodes: [code({ distributorCode: "XX", customerCode: "00000", mappedBrickId: null }), code()],
    holdReleaseGround: null,
  });
  assert.equal(mixed.hold, false, "one proven pair is enough, even alongside an unusable one");

  // The System Admin's recorded decision (Task C).
  assert.equal(
    decideDirectOrderHold({
      verificationStatus: "pending_review",
      declaredBrickId: "B192-1",
      distributorCodes: [],
      holdReleaseGround: "admin_released",
    }).hold,
    false,
    "a System Admin who judged the pharmacy releases it, with no code needed",
  );
  assert.equal(
    decideDirectOrderHold({
      verificationStatus: "pending_review",
      declaredBrickId: "B192-1",
      distributorCodes: [],
      holdReleaseGround: "kept_held",
    }).hold,
    true,
    "a System Admin who looked and chose to KEEP it held must not be read as a release",
  );

  // A rejected pharmacy is unreleasable by every route. Checked in every combination, because a
  // release path that resurrects a pharmacy proven not to exist is the worst outcome available.
  for (const ground of [null, "admin_released", "kept_held"]) {
    for (const codes of [[], [code()]]) {
      const rejected = decideDirectOrderHold({
        verificationStatus: "rejected",
        declaredBrickId: "B201-3",
        distributorCodes: codes,
        holdReleaseGround: ground,
      });
      assert.equal(rejected.hold, true, `a rejected pharmacy must stay held (ground=${ground}, codes=${codes.length})`);
      assert.equal(rejected.ground, "pharmacy_rejected");
    }
  }

  // Exhaustive over the status union, so adding a fourth value fails loudly here rather than
  // silently taking whichever branch happens to catch it.
  const allStatuses: DirectOrderPharmacyVerificationStatus[] = ["verified", "pending_review", "rejected"];
  for (const status of allStatuses) {
    const decision = decideDirectOrderHold({
      verificationStatus: status,
      declaredBrickId: "B201-3",
      distributorCodes: [code()],
      holdReleaseGround: null,
    });
    assert.ok(
      ["verified", "code_proven", "pharmacy_rejected"].includes(decision.ground),
      `status ${status} produced an unexpected ground (${decision.ground}) — a new status needs an explicit branch`,
    );
  }

  // ── The safety property the old comment defended must survive, in the source ───────────────
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    service,
    /const submitAsHeld = pharmacy\.verificationStatus === "pending_review";/,
    "the one-line fork must be gone — the whole point is that the distributor code now participates",
  );
  assert.match(service, /const submitAsHeld = holdDecision\.hold;/, "the fork must read the shared rule");

  // createDirectOrderPharmacy must STILL flag every hand-registered pharmacy unconditionally.
  // Releasing changes WHERE an order sits, never whether the pharmacy was reviewed.
  const createIdx = service.indexOf("export async function createDirectOrderPharmacy(");
  const createBody = service.slice(createIdx, service.indexOf("export async function acknowledgeDirectOrderPharmacy(", createIdx));
  // pending_review/manual used to be set in a client-side INSERT here; the code-collision fix
  // (3ec5c640) moved pharmacy creation onto the atomic phx_create_direct_order_pharmacy RPC, which
  // pins both values itself (asserted against the migration SQL by
  // direct-orders-pharmacy-code-collision.test.ts) so no caller can supply anything else. What this
  // test can still check from the TS side is that creation still goes through that RPC.
  assert.match(
    createBody,
    /supabase\.rpc\("phx_create_direct_order_pharmacy"/,
    "a hand-registered pharmacy must still be created through the atomic RPC, which pins pending_review/manual itself",
  );
  assert.doesNotMatch(
    createBody,
    /decideDirectOrderHold|holdDecision/,
    "registration must NOT derive verification from the codes — that is the collision hole the 2026-08-04 comment defends",
  );

  // The race the revive path never checked: `.eq("status","held")` guards against the 14-day cron
  // firing mid-write, but nothing looked at whether it matched. A zero-row update reported success
  // and left an expired request carrying a full pending chain.
  assert.match(
    service,
    /if \(\(updatedRows \?\? \[\]\)\.length === 0\) \{/,
    "reviving must verify the status update actually matched a row, not assume it did",
  );

  // The ownership check must FAIL CLOSED. If we cannot prove a pair is unclaimed, it is not proof.
  const ownershipIdx = service.indexOf("async function attachCodeOwnership(");
  assert.ok(ownershipIdx > 0, "attachCodeOwnership must exist");
  const ownershipBody = topLevelBlock(service, ownershipIdx);
  assert.match(
    ownershipBody,
    /ownedByOtherPharmacyId: "unknown"/,
    "a failed ownership lookup must mark the pair contested, never clean — an unavailable check cannot be the reason an order releases",
  );

  // ── The migration: it must not be able to reproduce the 2026-08-05 outage ──────────────────
  const migration = readFileSync(
    new URL("../supabase/migrations/20260808214500_direct_orders_release_held.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /'key', 'release_held'/);
  assert.match(migration, /'key', 'keep_held'/);
  assert.match(migration, /'to', 'pending_approval'/);
  assert.match(migration, /raise exception 'direct_orders registry would be SKIPPED by the loader/);
  // THE ANTI-OUTAGE ASSERTIONS. Every direct-order transition died on 2026-08-05 because an action
  // named a status the module did not declare. This migration adds none, and must never be edited
  // to — both of its targets are already declared.
  assert.doesNotMatch(
    migration,
    /direct_order_requests_status_check/,
    "this migration must not touch the status constraint — it declares no new status and must stay unable to",
  );
  assert.doesNotMatch(
    migration,
    /set statuses|statuses = statuses/,
    "this migration must not add a status; that is the single ingredient of the 2026-08-05 outage",
  );
  assert.doesNotMatch(migration, /set\s+version|version = version/i, "the touch trigger bumps version — never set it by hand");
  assert.equal(
    (migration.match(/update public\.workflow_registry_modules/g) ?? []).length,
    1,
    "exactly ONE registry update — two would be two version bumps for one logical change",
  );

  // Union / DB / call-site drift is audit finding F2: a key declared in only two of the three
  // places silently ungates a transition. Scrape the literals and require the union to list them.
  const workflow = readFileSync(new URL("../src/lib/direct-orders/workflow.ts", import.meta.url), "utf8");
  const unionBlock = workflow.slice(
    workflow.indexOf("export type DirectOrderWorkflowActionKey"),
    workflow.indexOf("/** Map a request status"),
  );
  for (const key of ["release_held", "keep_held"]) {
    assert.ok(
      unionBlock.includes(`"${key}"`),
      `DirectOrderWorkflowActionKey must list "${key}" — the migration declares it and the service uses it (audit F2)`,
    );
  }

  // ── No release path may ever mint a confirmed pharmacy ────────────────────────────────────
  //
  // Bounded to each function's OWN body. An earlier version of this sliced to end-of-file and
  // therefore swept up markDirectOrderPharmacyVerified — which writes `verified` entirely
  // legitimately, that being its whole job. A guard that fires on correct code gets deleted, so it
  // has to point at exactly the three functions that must never do it.
  for (const fnName of [
    "export async function releaseHeldDirectOrdersForPharmacy(",
    "export async function keepDirectOrderHeld(",
    "export async function linkDirectOrderPharmacyCode(",
  ]) {
    const start = service.indexOf(fnName);
    assert.ok(start > -1, `${fnName} must exist`);
    const end = service.indexOf("\nexport ", start + 1);
    const body = service.slice(start, end === -1 ? undefined : end);
    assert.doesNotMatch(
      body,
      /verification_status: "verified"/,
      `${fnName.trim()} must never write verification_status — releasing changes WHERE an order sits, never whether the pharmacy was confirmed. Only a human rung may confirm one, and the final-approval backstop still refuses while it is pending_review`,
    );
  }

  // The System Admin's ruling is persisted on the PHARMACY, so it covers sibling orders and the
  // next submission. Request-level would re-freeze every reorder behind the same answered question.
  const releaseStart = service.indexOf("export async function releaseHeldDirectOrdersForPharmacy(");
  const releaseBody = service.slice(releaseStart, service.indexOf("\nexport ", releaseStart + 1));
  assert.match(
    releaseBody,
    /hold_release_ground: "admin_released"/,
    "an admin release must be recorded on the pharmacy, or the next order re-freezes behind the same question",
  );
  assert.match(
    releaseBody,
    /A reason is required when a System Admin releases a held request\./,
    "an admin release is a judgement call and must carry a written reason",
  );

  // ── The sales matrix: products × months, executed ─────────────────────────────────────────
  const retail = (over: Partial<{ month: string; productCode: string; qty: number; bonus: number; distributorName: string }> = {}) => ({
    month: "2026-06",
    productCode: "LA001",
    productName: "Lacto Advanced 1",
    distributorName: "overseas",
    distributorCode: "PS",
    customerCode: "0001573270",
    qty: 10,
    bonus: 0,
    salesValue: 100,
    ...over,
  });

  const matrix = buildDirectOrderSalesMatrix([
    retail({ month: "2026-07", qty: 5 }),
    retail({ month: "2026-06", qty: 10 }),
    retail({ month: "2026-06", productCode: "LA002", qty: 40 }),
  ]);
  assert.deepEqual(matrix.months, ["2026-06", "2026-07"], "months read oldest → newest so a trend runs left to right");
  assert.equal(matrix.products[0]?.productCode, "LA002", "products sort by total units desc — the biggest relationship first");
  assert.equal(matrix.products[1]?.cells[0]?.units, 10);
  assert.equal(matrix.products[1]?.cells[1]?.units, 5);
  assert.deepEqual(matrix.monthTotals, [50, 5]);
  assert.equal(matrix.grandTotalUnits, 55);
  // A month a product was NOT bought in must be a real null, not a zero — "did not buy" and
  // "bought nothing" look identical as 0 and only one of them is a fact about the month.
  assert.equal(matrix.products[0]?.cells[1], null, "a month with no purchase of that product stays null, never 0");

  // Two distributors supplying one product in one month is real and must both be named — the
  // owner's requirement is that every cell says WHICH distributor, not just how many units.
  const twoDistributors = buildDirectOrderSalesMatrix([
    retail({ qty: 3 }),
    { ...retail({ qty: 7 }), distributorName: "Ibn Sina", distributorCode: "IS" },
  ]);
  assert.equal(twoDistributors.products[0]?.cells[0]?.units, 10, "units from both distributors add up in the cell");
  assert.deepEqual(
    twoDistributors.products[0]?.cells[0]?.distributors,
    ["overseas", "Ibn Sina"],
    "both distributors must be named in the cell, never collapsed to one",
  );

  // Bonus rides beside units, never inside them: merging the two overstates what was bought.
  const withBonus = buildDirectOrderSalesMatrix([retail({ qty: 10, bonus: 4 })]);
  assert.equal(withBonus.products[0]?.cells[0]?.units, 10, "bonus units must NOT be folded into the units figure");
  assert.equal(withBonus.products[0]?.cells[0]?.bonus, 4);

  assert.deepEqual(
    buildDirectOrderSalesMatrix([]),
    { months: [], products: [], monthTotals: [], grandTotalUnits: 0 },
    "an empty history must produce an empty matrix, never throw",
  );

  // ── Confidentiality is enforced in the SERVICE, not the component ─────────────────────────
  // Owner rule: the restricted codes AND the Head Office line are hidden from every role including
  // CEO and Super Admin. Before this, neither history loader took an AccessContext at all, so every
  // approver of any line saw a pharmacy's entire product history.
  assert.match(
    service,
    /async function resolveHistoryVisibility\(access: AccessContext\)/,
    "history visibility must be resolved server-side from the viewer's access context",
  );
  assert.match(service, /RESTRICTED_PRODUCT_CODES/, "the restricted product codes must be applied to the history");
  assert.doesNotMatch(
    service.slice(service.indexOf("async function resolveHistoryVisibility("), service.indexOf("async function loadPharmacyRetailHistory(")),
    /canViewRestrictedProducts/,
    "confidentiality here must NOT route through canViewRestrictedProducts — that helper re-admits CEO and Super Admin, and the owner's rule hides these from everyone",
  );

  // ── The confidentiality rule, EXECUTED ────────────────────────────────────────────────────
  // These replaced source-text assertions that a prove-it-fails run showed were worthless: with the
  // rule inline in service.ts, disabling the Head Office lock outright (`if (false && …)`) left
  // every assertion green, because the literal text was still on the line. The rule was moved into
  // a pure function so the guard can run it instead of reading it.
  const RESTRICTED = new Set(["LA003", "LA004", "SS001"]);
  const headOffice = (line: string) => ["head office", "headoffice", "office", "hq"].includes(line.trim().toLowerCase());
  const visible = (productCode: string, line: string, viewerLine: string | null) =>
    isDirectOrderHistoryProductVisible({ productCode, line, restrictedCodes: RESTRICTED, isHeadOfficeLine: headOffice, viewerLine });

  // Hidden from EVERYONE, including the two roles that see everything else.
  for (const viewerLine of [null, "pedia", ""]) {
    for (const restrictedCode of ["LA003", "LA004", "SS001"]) {
      assert.equal(
        visible(restrictedCode, "Pedia", viewerLine),
        false,
        `${restrictedCode} is confidential and must be hidden even from a viewer who sees every line (viewerLine=${JSON.stringify(viewerLine)})`,
      );
    }
    assert.equal(
      visible("RY001", "Head Office", viewerLine),
      false,
      "RY001 is NOT in the restricted code list — only the Head Office LINE lock hides it, and it reached an SFE Manager's screen once through exactly this gap",
    );
  }

  // A restricted code on a NON-Head-Office line is still hidden, and a Head Office product that is
  // not a restricted code is still hidden. Neither mechanism subsumes the other.
  assert.equal(visible("LA003", "CNS", null), false, "a restricted code hides regardless of its line");
  assert.equal(visible("XX999", "Head Office", null), false, "any Head Office product hides regardless of its code");

  // Ordinary products: visible to an unrestricted viewer, and to a viewer on the same line only.
  assert.equal(visible("LA001", "Pedia", null), true, "Super Admin / SFE Manager / CEO see every line");
  assert.equal(visible("LA001", "Pedia", "pedia"), true, "a Pedia viewer sees Pedia products");
  assert.equal(visible("LA001", "Pedia", "cns"), false, "a CNS viewer must NOT see another line's products");
  assert.equal(
    visible("LA001", "Pedia", ""),
    false,
    "FAIL CLOSED: a restricted role whose own line could not be resolved must see NOTHING, never everything",
  );
  assert.equal(visible("", "Pedia", null), false, "a product with no code cannot be shown");
  // Line scoping uses the direct-orders resolver, whose unrestricted set is exactly
  // {Super Admin, SFE Manager, CEO}. resolveSalesAccessScope would narrow a District Manager to
  // their region and seat areas, showing them LESS than their own line.
  assert.match(
    service,
    /const lineName = await resolveDirectOrderRequesterLineName\(access\);/,
    "line scoping must use the direct-orders resolver, whose role set matches the owner's spec exactly",
  );

  // ── GOLDEN RULE: the geography panel never leaves a field blank ───────────────────────────
  // Owner rule, 2026-08-08: "under any circumstances there never should be missing data."
  // Satisfied by always saying something TRUE — including "could not be matched" — never by
  // inventing a place. A derived value must also carry its provenance, or it is indistinguishable
  // from something the distributor's master database asserted.
  const PLACES = [
    { name: "بركة السبع", brickId: "B201-3", areaCode: "D12" },
    { name: "كفر شكر", brickId: "B208-8", areaCode: "D11" },
    { name: "بنها", brickId: "B208-1", areaCode: "D11" },
  ];
  const geo = (address: string | null, declaredBrickName = "بركة السبع") =>
    checkDirectOrderGeography({
      declaredBrickId: "B201-3",
      declaredBrickName,
      declaredAreaCode: "D12",
      declaredAreaName: "Menoufia 1",
      masterBrickId: "B201-3",
      masterBrickName: "بركة السبع",
      masterAreaCode: "D12",
      masterAreaName: "Menoufia 1",
      address,
      knownPlaces: PLACES,
    });

  // THE LIVE CASE (order e6740fcf): the address names كفر شكر / بنها — both brick B208-8/B208-1 in
  // area D11 — while the request declares بركة السبع, B201-3 in D12. Verified against production.
  const live = geo("كفر شكر بنها");
  assert.equal(live.address.verdict, "mismatch", "an address naming a DIFFERENT area must be flagged, not passed over");
  assert.equal(live.address.resolvedPlace, "كفر شكر", "the address must resolve to a real place, never be left blank");
  assert.equal(live.address.resolvedFrom, "address-text", "a derived value must record HOW it was derived");
  assert.match(
    describeResolvedAddressPlace(live.address),
    /read from the address/,
    "PROVENANCE: a place read out of free text must never be presented as something the master database asserted",
  );

  // An address that names the declared place confirms it — and still resolves rather than blanking.
  const agrees = geo("صيدلية النور - بركة السبع");
  assert.equal(agrees.address.verdict, "match");
  assert.equal(agrees.address.resolvedPlace, "بركة السبع");

  // FAIL SOFT: an address matching no known place is UNKNOWN, never a mismatch. A wrong accusation
  // teaches people to ignore the warning, which costs more than the warning is worth.
  const unknown = geo("١٢ شارع لا يوجد");
  assert.equal(unknown.address.verdict, "unknown", "an unrecognised address is not an accusation");
  assert.equal(unknown.address.resolvedPlace, null);
  assert.match(
    describeResolvedAddressPlace(unknown.address),
    /Could not be matched/,
    "GOLDEN RULE: an unresolved address must say so in words — a bare dash reads as 'we forgot to look'",
  );

  // No address at all is a fourth, distinct state — and still not a blank.
  const none = geo(null);
  assert.equal(none.address.verdict, "not_checkable");
  assert.match(describeResolvedAddressPlace(none.address), /No address was entered/);

  // Every state produces non-empty prose. This is the golden rule expressed as an invariant.
  for (const address of ["كفر شكر بنها", "بركة السبع", "١٢ شارع لا يوجد", null, ""]) {
    const text = describeResolvedAddressPlace(geo(address).address);
    assert.ok(text.trim().length > 0, `the address column must never render empty (address=${JSON.stringify(address)})`);
    assert.doesNotMatch(text, /^[—-]$/, "a bare dash is exactly the 'missing data' the golden rule forbids");
  }

  // LONGEST MATCH WINS: "بركة السبع" contains no shorter place here, but the rule matters when one
  // place name is a substring of another — resolving to the shorter one would be confidently wrong.
  const longest = checkDirectOrderGeography({
    declaredBrickId: "B999",
    declaredBrickName: "nowhere",
    declaredAreaCode: "Z9",
    declaredAreaName: "nowhere area",
    masterBrickId: null,
    masterBrickName: null,
    masterAreaCode: null,
    masterAreaName: null,
    address: "بركة السبع",
    knownPlaces: [{ name: "بركة", brickId: "B1", areaCode: "A1" }, { name: "بركة السبع", brickId: "B201-3", areaCode: "D12" }],
  });
  assert.equal(longest.address.resolvedPlace, "بركة السبع", "the LONGEST matching place name must win, not the first");

  // ── THE LIVE PHOTO IS THE PRIMARY SOURCE OF TRUST (owner, 2026-10-18) ─────────────────────
  // The live case (request 299304bf): حضانه عبد الكريم, no distributor code, filed under brick
  // منشأة سلطان / Menoufia 1 from an inherited marketing label, while its photo was taken 0.7 km
  // from منوف / Menoufia 2. The panel used to print "nothing to check" on every territory row.
  const photoCase = (
    photoTerritory: Parameters<typeof checkDirectOrderGeography>[0]["photoTerritory"],
    overrides: { masterBrickId?: string | null; masterAreaCode?: string | null } = {},
  ) =>
    checkDirectOrderGeography({
      declaredBrickId: "B201-9",
      declaredBrickName: "منشأة سلطان",
      declaredAreaCode: "D12",
      declaredAreaName: "Menoufia 1",
      masterBrickId: overrides.masterBrickId ?? null,
      masterBrickName: null,
      masterAreaCode: overrides.masterAreaCode ?? null,
      masterAreaName: null,
      address: null,
      photoTerritory,
    });
  const menouf = { brickId: "B202-1", brickName: "منوف", areaCode: "D13", areaName: "Menoufia 2", distanceKm: 0.7 };

  const photoWrongArea = photoCase(menouf);
  assert.equal(photoWrongArea.photo.area.verdict, "mismatch", "a photo taken in another AREA must disagree with the filed area");
  assert.equal(photoWrongArea.photo.brick.verdict, "mismatch");
  assert.match(photoWrongArea.summary, /^PHOTO MISMATCH/, "the photo's disagreement must LEAD the summary");
  assert.match(photoWrongArea.summary, /Menoufia 2/);
  assert.match(photoWrongArea.summary, /primary evidence/);

  // The photo outranks a passing master check — a distributor code that agrees with the filed brick
  // must not drown out a pin that says the shop stands somewhere else.
  const photoBeatsMaster = photoCase(menouf, { masterBrickId: "B201-9", masterAreaCode: "D12" });
  assert.equal(photoBeatsMaster.brick.verdict, "match", "the master check is still run and still reported");
  assert.match(photoBeatsMaster.summary, /^PHOTO MISMATCH/, "a passing master check must not hide a photo mismatch");

  // Same area, different brick: still the photo's word, but named as a brick difference.
  const photoWrongBrick = photoCase({ ...menouf, brickId: "B201-3", brickName: "بركة السبع", areaCode: "D12", areaName: "Menoufia 1" });
  assert.equal(photoWrongBrick.photo.area.verdict, "match");
  assert.equal(photoWrongBrick.photo.brick.verdict, "mismatch");
  assert.match(photoWrongBrick.summary, /same area/);

  // Everything agrees with the photo, with no distributor code to cross-check.
  const photoAgrees = photoCase({ brickId: "B201-9", brickName: "منشأة سلطان", areaCode: "D12", areaName: "Menoufia 1", distanceKm: 1.1 });
  assert.equal(photoAgrees.photo.area.verdict, "match");
  assert.equal(photoAgrees.photo.brick.verdict, "match");
  assert.match(photoAgrees.summary, /^Checked against the live photo/);

  // FAIL SOFT: a pin whose nearest brick centre is implausibly far names no territory, and a rep is
  // never accused on it. No photo at all is its own state — both say so in words, never skip.
  const photoTooFar = photoCase({ ...menouf, distanceKm: 40 });
  assert.equal(photoTooFar.photo.unusableReason, "too_far");
  assert.equal(photoTooFar.photo.area.verdict, "not_checkable");
  assert.doesNotMatch(photoTooFar.summary, /PHOTO MISMATCH/, "a centre 40 km away is not evidence against the filed place");
  // A nursery has NO distributor account by definition (حضانه عبد الكريم): the sentence must never
  // read as though a code were missing — the photo is its only territory evidence.
  const nurseryAgrees = checkDirectOrderGeography({
    declaredBrickId: "B201-9",
    declaredBrickName: "منشأة سلطان",
    declaredAreaCode: "D12",
    declaredAreaName: "Menoufia 1",
    masterBrickId: null,
    masterBrickName: null,
    masterAreaCode: null,
    masterAreaName: null,
    address: null,
    photoTerritory: { brickId: "B201-9", brickName: "منشأة سلطان", areaCode: "D12", areaName: "Menoufia 1", distanceKm: 1.1 },
    noDistributorAccountVenueLabel: "Nursery",
  });
  assert.match(nurseryAgrees.summary, /A nursery has no distributor account/);
  assert.doesNotMatch(nurseryAgrees.summary, /No distributor customer code was available/);
  const nurseryNoPhoto = checkDirectOrderGeography({
    declaredBrickId: "B201-9",
    declaredBrickName: "منشأة سلطان",
    declaredAreaCode: "D12",
    declaredAreaName: "Menoufia 1",
    masterBrickId: null,
    masterBrickName: null,
    masterAreaCode: null,
    masterAreaName: null,
    address: null,
    photoTerritory: null,
    noDistributorAccountVenueLabel: "Nursery",
  });
  assert.match(nurseryNoPhoto.summary, /^NOT CHECKED — a nursery has no distributor account/);
  assert.doesNotMatch(nurseryNoPhoto.summary, /no distributor customer code to check against/);
  const noPhoto = photoCase(null);
  assert.equal(noPhoto.photo.unusableReason, "no_photo");
  assert.equal(noPhoto.photo.brick.verdict, "not_checkable");
  assert.doesNotMatch(noPhoto.summary, /PHOTO MISMATCH/);

  // 🔴 A BRICK MAP THAT DID NOT LOAD IS NOT A MISSING PHOTO (code review, 19 Oct 2026).
  // `loadBrickCentroids` answers [] on a read failure, so a photo WITH a pin resolved to nothing and
  // the panel said "No live evidence photo with GPS" — dropping the primary evidence check unannounced.
  const mapDownInput = {
    declaredBrickId: "B201-9",
    declaredBrickName: "منشأة سلطان",
    declaredAreaCode: "D12",
    declaredAreaName: "Menoufia 1",
    masterBrickId: "B201-9",
    masterBrickName: "منشأة سلطان",
    masterAreaCode: "D12",
    masterAreaName: "Menoufia 1",
    address: null,
    photoTerritory: null,
    photoPinUnresolved: "brick_map_unavailable" as const,
  };
  const mapDown = checkDirectOrderGeography(mapDownInput);
  assert.equal(mapDown.photo.unusableReason, "brick_map_unavailable", "a pin the map could not read is not a missing photo");
  assert.equal(mapDown.photo.area.verdict, "not_checkable");
  assert.match(mapDown.summary, /^Checked and agrees/, "the master check still runs and still speaks");
  assert.match(
    mapDown.summary,
    /brick map did not load, so the photo's own territory — the primary evidence — was not checked/,
    "a master pass must not read as a pass the photo never gave",
  );
  const nurseryMapDown = checkDirectOrderGeography({
    ...mapDownInput,
    masterBrickId: null,
    masterBrickName: null,
    masterAreaCode: null,
    masterAreaName: null,
    noDistributorAccountVenueLabel: "Nursery",
  });
  assert.match(nurseryMapDown.summary, /^NOT CHECKED — a nursery has no distributor account, and the brick map did not load/);
  assert.doesNotMatch(nurseryMapDown.summary, /carries no usable live photo/, "the nursery's photo exists — the map is what failed");
  assert.equal(nurseryMapDown.summary.match(/brick map did not load/g)?.length, 1, "said once, not twice");
  // A pin with no brick centre anywhere near it is the far case, never "no photo".
  assert.equal(checkDirectOrderGeography({ ...mapDownInput, photoPinUnresolved: "no_brick_near" }).photo.unusableReason, "too_far");
  assert.doesNotMatch(noPhoto.summary, /brick map/, "a request with no pin says nothing about the map");
  const panel = readFileSync(new URL("../src/components/approvals-hub/direct-order-request-detail.tsx", import.meta.url), "utf8");
  assert.match(
    panel,
    /unusableReason === "brick_map_unavailable"\s*\?\s*"The photo has GPS, but the brick map did not load/,
    "the panel row names a map that did not load instead of a missing GPS photo",
  );
  const detailService = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  assert.match(
    detailService,
    /photoPinUnresolved = centroids\.length === 0 \? "brick_map_unavailable" : "no_brick_near"/,
    "the approval detail tells an empty brick map apart from a pin with no brick near",
  );
  assert.match(detailService, /checkDirectOrderGeography\(\{\s*photoTerritory,\s*photoPinUnresolved,/, "and hands that reason to the check");

  // ── AUTO-LINK (owner rule, 2026-08-08: "if the pharmacy matches automatic link") ──────────
  //
  // The click was removed, so the match condition is now the ONLY thing standing between a
  // heuristic and a production write that redirects a pharmacy's sales. Every refusal below is a
  // way that write could go wrong, and each one is executed rather than asserted from source text.

  // The live case: DOP-000017, name "1573270", one overseas customer 0001573270, unclaimed.
  const linked = decideDirectOrderAutoLink({
    pharmacyName: "1573270",
    existingCodes: [],
    candidates: [candidate()],
  });
  assert.equal(linked.link, true, "one unambiguous, unclaimed match on a digit-shaped name must link automatically");
  if (linked.link) {
    assert.equal(linked.candidate.customerCode, "0001573270", "the MASTER's padded spelling is what gets linked");
    assert.equal(
      linked.renameTo,
      "محمود احمد صالح الجديدة",
      "the name field held a code, so the master's own customer name replaces it — half-fixing the record leaves every list still reading a number",
    );
  }

  // A real name is not a misplaced code. Nothing to move, nothing to rename.
  assert.deepEqual(
    decideDirectOrderAutoLink({ pharmacyName: "صيدلية النور", existingCodes: [], candidates: [candidate()] }),
    { link: false, refusal: "name_is_not_a_code", candidates: [] },
    "a pharmacy with an actual name must never be renamed or linked by this rule",
  );

  // Nermeen's live placeholders. "000000" collapses to "0", which denotes no customer.
  for (const placeholder of ["000000", "00000"]) {
    const decision = decideDirectOrderAutoLink({
      pharmacyName: placeholder,
      existingCodes: [],
      candidates: [candidate({ customerCode: placeholder })],
    });
    assert.equal(
      decision.link,
      false,
      `placeholder "${placeholder}" must never auto-link — it is the shape that proves nothing, and it is live on two pharmacies today`,
    );
  }

  // Never overwrite a link a human made. Repair is for the empty case only.
  assert.equal(
    decideDirectOrderAutoLink({
      pharmacyName: "1573270",
      existingCodes: [{ distributorCode: "IBN", customerCode: "999888" }],
      candidates: [candidate()],
    }).link,
    false,
    "a pharmacy that already carries a distributor code must be left alone — an automatic rule never overwrites a human's entry",
  );

  // THE SUFFIX TRAP. The candidate query is `.ilike('%1573270')`, so "31573270" comes back as a row.
  // A suffix compare here would auto-link one pharmacy onto another customer's sales, silently.
  const suffix = decideDirectOrderAutoLink({
    pharmacyName: "1573270",
    existingCodes: [],
    candidates: [candidate({ customerCode: "31573270" })],
  });
  assert.equal(
    suffix.link,
    false,
    "31573270 must NOT satisfy a search for 1573270 — a suffix match would redirect a real customer's retail sales onto the wrong pharmacy",
  );
  assert.equal(suffix.link === false && suffix.refusal, "no_candidate", "and it refuses as no_candidate, not as something softer");

  // Two distributors, same digits. Separate code spaces means this is a coincidence, not one
  // pharmacy — and picking either one at random would be a 50/50 guess about whose sales these are.
  const ambiguous = decideDirectOrderAutoLink({
    pharmacyName: "1573270",
    existingCodes: [],
    candidates: [candidate(), candidate({ distributorCode: "IBN", distributorName: "Ibn Sina", areaCode: "UE9" })],
  });
  assert.equal(ambiguous.link, false, "the same digits at two distributors must NOT auto-link");
  assert.equal(ambiguous.link === false && ambiguous.refusal, "ambiguous_candidates");
  assert.equal(
    ambiguous.link === false && ambiguous.candidates.length,
    2,
    "and both candidates ride along, or the screen cannot offer the choice it just refused to make",
  );

  // Two Phoenix pharmacies pointing at one distributor customer splits that customer's sales.
  const claimed = decideDirectOrderAutoLink({
    pharmacyName: "1573270",
    existingCodes: [],
    candidates: [candidate({ ownedByOtherPharmacyId: "some-other-pharmacy" })],
  });
  assert.equal(claimed.link, false, "a code another Phoenix pharmacy already holds must never be auto-linked");
  assert.equal(claimed.link === false && claimed.refusal, "owned_by_another_pharmacy");

  // FAIL CLOSED. findOtherPharmacyHoldingCode returns the string "unknown" when the check itself
  // failed; that must read as owned, never as free. A database hiccup cannot be the reason two
  // pharmacies end up sharing one customer.
  assert.equal(
    decideDirectOrderAutoLink({
      pharmacyName: "1573270",
      existingCodes: [],
      candidates: [candidate({ ownedByOtherPharmacyId: "unknown" })],
    }).link,
    false,
    "an ownership check that could not run must block the link — an unavailable check is not a clean bill of health",
  );

  // A master row whose own "name" is also just digits must not overwrite one code with another.
  const digitName = decideDirectOrderAutoLink({
    pharmacyName: "1573270",
    existingCodes: [],
    candidates: [candidate({ customerName: "1573270" })],
  });
  assert.equal(digitName.link, true, "the link still happens — the code belongs in its column regardless");
  assert.equal(
    digitName.link === true && digitName.renameTo,
    null,
    "but a digits-only master name is not a name either, so the rename is skipped rather than swapping one number for another",
  );

  // Every refusal must say something a human can act on. A bare enum on screen is the "Not flagged"
  // failure again: a state the reader cannot distinguish from any other.
  const refusals: DirectOrderAutoLinkRefusal[] = [
    "name_is_not_a_code",
    "already_linked",
    "no_candidate",
    "ambiguous_candidates",
    "owned_by_another_pharmacy",
  ];
  for (const refusal of refusals) {
    const sentence = describeDirectOrderAutoLinkRefusal(refusal);
    assert.ok(sentence.length > 30, `refusal "${refusal}" must be explained in a sentence, not a code`);
    assert.ok(!sentence.includes("_"), `refusal "${refusal}" must not leak its enum name onto the screen`);
  }

  // The wiring, source-pinned: the repair must run BEFORE the hold decision, or a freshly linked
  // code cannot release the very order that triggered the repair.
  {
    const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
    const autoLinkAt = service.indexOf("await autoLinkDirectOrderPharmacyCode(input.pharmacyId");
    const holdAt = service.indexOf("const holdDecision = decideDirectOrderHold({");
    assert.ok(autoLinkAt > 0 && holdAt > 0, "both the submit-path auto-link and the hold decision must exist");
    assert.ok(
      autoLinkAt < holdAt,
      "the auto-link must run BEFORE decideDirectOrderHold on the submit path — after it, the decision reads a stale pre-link pharmacy and the order holds for a code it now has",
    );
    assert.match(
      service.slice(autoLinkAt, holdAt),
      /loadPharmaciesByIds\(\[input\.pharmacyId\]\)/,
      "and the pharmacy must be RE-READ after the link, or the hold decision still sees the row as it was before the write",
    );
    // Auto-linking says nothing about whether a human reviewed the pharmacy.
    assert.ok(
      !/autoLinkDirectOrderPharmacyCode[\s\S]{0,4000}?verification_status:\s*"verified"/.test(service),
      "the auto-link path must never write verification_status: verified — it moves a code into the right column, it does not stand in for SFE validation",
    );
  }

  // ── The Distributors block must not contradict itself. THIRD TIME. ────────────────────────
  // First it printed "no code on file" above "possible match found". That was fixed. Then the
  // FIELDS above that block kept printing "Not provided" directly above a callout naming the very
  // distributor and code that had been found — the same defect one block higher.
  //
  // The invariant: wherever those fields can say "Not provided", the value must be derived from the
  // SAME candidate the callout reads, so the two can never disagree.
  for (const [label, path] of [
    ["the admin approval window", "../src/components/approvals-hub/direct-order-request-detail.tsx"],
  ] as const) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(
      source,
      /const candidateMatch = possibleDistributorMatches\[0\] \?\? null;/,
      `${label} must read the candidate ONCE, so the distributor fields and the callout below them cannot describe different things`,
    );
    const idx = source.indexOf("distributors.length === 0");
    // Bounded by the ternary's own else arm at this nesting depth — a real sibling anchor — so the
    // branch can grow without the window needing to be widened after it, and no marker can leak in
    // from the arm below and answer for a branch that lost it.
    const elseArm = source.slice(idx).search(/^ {10}\) : \(/m);
    const emptyBranch = source.slice(idx, elseArm >= 0 ? idx + elseArm : source.length);
    assert.match(
      emptyBranch,
      /candidateMatch \? \(/,
      `${label}: the Distributor fields must show the found candidate — "Not provided" printed above a block naming that same distributor is the contradiction this guard exists for`,
    );
    assert.match(
      emptyBranch,
      /found, not linked/,
      `${label}: a found-but-unlinked code must say exactly that — "nothing on file" and "found, waiting to be linked" are different facts with different remedies`,
    );
  }
}
