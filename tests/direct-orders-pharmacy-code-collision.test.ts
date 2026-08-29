import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { selectExactCodePairOwners } from "../src/lib/direct-orders/service.ts";

// ─────────────────────────────────────────────────────────────────────────────
// "Could not create the pharmacy." — and a duplicate had ALREADY been saved.
//
// THE LIVE CASE (staging, 2026-08-13, 19:38 Cairo). A rep registered "ابراهيم احمد الجديدة" in
// Gharbia 1 (Tanta) with distributor PS and customer code 12345. It worked: DOP-000013. One minute
// later, 19:39, she registered the identical pharmacy again — same name, same brick, same doctor,
// same address — and this time the screen said "Could not create the pharmacy."
//
// It was not refused. It half-succeeded. createDirectOrderPharmacy did TWO independent inserts with
// no transaction around them:
//
//   1. INSERT direct_order_pharmacies              → committed. DOP-000014 now exists.
//   2. INSERT direct_order_pharmacy_distributor_codes → 23505 on the unique index, threw.
//
// So the failure message was about step 2 while step 1 was already permanent. The rep read "nothing
// was created", and a codeless twin of her pharmacy was sitting in the table.
//
// AND IT IS INVISIBLE TO BOTH DUPLICATE PASSES. groupDuplicatePharmacies matches on codes, so the
// codeless twin has nothing to match. Its name+area fallback only fires when BOTH sides carry zero
// identity keys — and DOP-000013 holds PS/12345, so the pair can never cluster. Nothing would ever
// have proposed them. Production carries five such clusters, 159,779.35 EGP of approved orders.
//
// The fix has three parts and this file guards all three:
//   · ONE TRANSACTION — phx_create_direct_order_pharmacy writes parent and codes in one plpgsql
//     body, so a failing code insert rolls the pharmacy back with it. No orphan is possible.
//   · ASK FIRST — the collision is looked up and shown as "did you mean this pharmacy?", naming the
//     pharmacy that holds the code, instead of surfacing as a failed insert afterwards.
//   · "NO" HAS AN ANSWER — a rep who says her pharmacy is genuinely different is NOT blocked and is
//     NOT given the code. The pharmacy is registered without it and the claim is recorded for a
//     reviewer. Blocking is what produced the invented codes: "000000" and "00000" are both live in
//     production on two "حضانه زمزم" records, which are two different strings to a unique index and
//     therefore collided with nothing.
// ─────────────────────────────────────────────────────────────────────────────

function ownerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    distributor_code: "PS",
    customer_code: "12345",
    pharmacy_id: "ph-13",
    direct_order_pharmacies: {
      id: "ph-13",
      phoenix_pharmacy_code: "DOP-000013",
      pharmacy_name: "ابراهيم احمد الجديدة",
      area_code: "D14",
      region_code: "R3",
      pharmacy_address: "شيراتون",
      verification_status: "pending_review",
    },
    ...overrides,
  };
}

export function runDirectOrdersPharmacyCodeCollisionTests() {
  const service = readFileSync(new URL("../src/lib/direct-orders/service.ts", import.meta.url), "utf8");
  const form = readFileSync(
    new URL("../src/components/direct-orders/direct-order-submit-form.tsx", import.meta.url),
    "utf8",
  );
  const migration = readFileSync(
    new URL("../supabase/migrations/20260813230000_direct_order_pharmacy_atomic_create.sql", import.meta.url),
    "utf8",
  );

  // ── 1. The collision lookup must match PAIRS, not loose codes ─────────────
  //
  // PostgREST's two `.in()` filters are independent: asking for distributors [PS, IBN] and customer
  // codes [12345, 99999] also returns PS/99999 and IBN/12345. Those are pairs nobody asked about.
  // Reporting one as a conflict tells a rep her free code belongs to a pharmacy that does not hold
  // it — and a rep who cannot use her real code invents one.
  {
    const requested = new Map([
      ["PS", "12345"],
      ["IBN", "99999"],
    ]);
    const owners = selectExactCodePairOwners(requested, [
      ownerRow(),
      // The cross-product noise. Both halves appear in the request; neither pair does.
      ownerRow({ distributor_code: "PS", customer_code: "99999", pharmacy_id: "ph-x" }),
      ownerRow({ distributor_code: "IBN", customer_code: "12345", pharmacy_id: "ph-y" }),
    ]);
    assert.equal(
      owners.size,
      1,
      "only the exact (distributor, customer code) pair is a conflict — matching either half alone " +
        "refuses codes that are completely free, and a rep who cannot use her real code invents one",
    );
    assert.equal(owners.get("PS::12345")?.phoenixPharmacyCode, "DOP-000013");
    assert.equal(owners.has("PS::99999"), false, "PS/99999 was never requested as a pair");
    assert.equal(owners.has("IBN::12345"), false, "IBN/12345 was never requested as a pair");
  }

  // ── 2. A real collision must be REPORTED, not dropped ─────────────────────
  // The failure direction that costs money: a missed conflict falls straight back through to the
  // unique index, which is the bug this whole change removes.
  {
    const owners = selectExactCodePairOwners(new Map([["PS", "12345"]]), [ownerRow()]);
    const held = owners.get("PS::12345");
    assert.ok(held, "the pair PS/12345 IS held and must be reported");
    assert.equal(held.pharmacyName, "ابراهيم احمد الجديدة");
    assert.equal(held.areaCode, "D14");
    // The rep is being asked "did you mean this pharmacy?" — she cannot answer from a code alone,
    // so the incumbent's name, geography and address all have to survive the lookup.
    assert.equal(held.pharmacyAddress, "شيراتون");
    assert.equal(held.verificationStatus, "pending_review");
  }

  // ── 3. PostgREST's embedded row arrives as an object OR a one-element array ─
  // Both shapes have been seen across schema-cache reloads. Reading only the object shape turns a
  // real collision into "no owner", which silently restores the failed-insert bug.
  {
    const owners = selectExactCodePairOwners(new Map([["PS", "12345"]]), [
      ownerRow({ direct_order_pharmacies: [ownerRow().direct_order_pharmacies] }),
    ]);
    assert.equal(owners.get("PS::12345")?.phoenixPharmacyCode, "DOP-000013", "the array shape must resolve too");
  }

  // A row with no embedded pharmacy proves nothing and must never be reported as a conflict.
  {
    const owners = selectExactCodePairOwners(new Map([["PS", "12345"]]), [
      ownerRow({ direct_order_pharmacies: null }),
      ownerRow({ direct_order_pharmacies: [] }),
    ]);
    assert.equal(owners.size, 0, "a code row with no pharmacy behind it cannot name an incumbent");
  }

  // ── 4. The pharmacy and its codes must be written in ONE transaction ──────
  assert.match(
    migration,
    /create or replace function public\.phx_create_direct_order_pharmacy/,
    "the atomic create RPC must exist — two client inserts cannot roll each other back",
  );
  assert.match(
    service,
    /supabase\.rpc\("phx_create_direct_order_pharmacy"/,
    "createDirectOrderPharmacy must go through the RPC, not insert the pharmacy itself",
  );
  {
    // Pin the exact regression: an insert into the parent table inside this function is the bug.
    const start = service.indexOf("export async function createDirectOrderPharmacy");
    const end = service.indexOf("\nexport ", start + 1);
    assert.ok(start > -1 && end > start, "createDirectOrderPharmacy must be findable");
    const body = service.slice(start, end);
    assert.doesNotMatch(
      body,
      /from\("direct_order_pharmacies"\)\s*\.insert/,
      "the pharmacy must NOT be inserted directly — that is the untransacted half that committed " +
        "DOP-000014 while the codes threw, leaving an orphan the dedupe passes cannot see",
    );
    assert.doesNotMatch(
      body,
      /from\("direct_order_pharmacy_distributor_codes"\)\s*\.insert/,
      "the code rows must NOT be inserted separately — a second insert is a second transaction",
    );
  }
  // The RPC pins the review state itself, so no caller can register a pre-approved pharmacy by
  // passing its own verification_status.
  assert.match(
    migration,
    /'pending_review',\s*'manual'/,
    "the RPC must pin verification_status/entry_source itself — they must not be caller-supplied",
  );
  // REVOKE FROM PUBLIC strips service_role on a default ACL, so the grant has to come after it.
  assert.ok(
    migration.indexOf("grant execute on function public.phx_create_direct_order_pharmacy") >
      migration.lastIndexOf("revoke all on function public.phx_create_direct_order_pharmacy"),
    "the service_role grant must come AFTER the revokes — revoking from PUBLIC on a default ACL " +
      "strips service_role, and the RPC then fails in production only",
  );

  // ── 5. "No, mine is different" must never claim the contested code ────────
  assert.match(
    service,
    /const claimablePairs = new Map\(\s*Array\.from\(byDistributor\.entries\(\)\)\.filter\(\(\[distributorCode, customerCode\]\) => !owners\.has\(`\$\{distributorCode\}::\$\{customerCode\}`\)\),\s*\)/,
    "a contested pair must be dropped from the insert entirely — the incumbent keeps its code and " +
      "the unique index is never even tested",
  );
  assert.match(
    service,
    /contested_code_claims: contestedCodeClaims/,
    "the disputed claim must be recorded on the new pharmacy as evidence for the reviewer",
  );
  assert.match(
    migration,
    /contested_code_claims jsonb not null default '\[\]'::jsonb/,
    "the column the claim is recorded in must exist",
  );
  // The reviewer's queue has to be able to tell a dispute apart from a missing code: one is a
  // decision waiting to be made, the other is a gap waiting to be filled.
  assert.match(
    service,
    /code\(s\) are claimed by another pharmacy and the submitter says this is a different one/,
    "the review reason must name the dispute specifically",
  );

  // ── 6. The client flag can only ever ADD the dispute, never skip the check ─
  assert.match(
    service,
    /const owners = await findOwnedDistributorCodes\(byDistributor\);/,
    "the server must re-run the collision lookup itself on every create",
  );
  assert.match(
    service,
    /if \(owners\.size > 0 && input\.acknowledgedCodeConflict !== true\)/,
    "the lookup must run BEFORE the acknowledgement is consulted — the flag decides what happens " +
      "to a known conflict, it must never decide whether to look",
  );
  // Refused BY NAME. The API is reachable outside the form, so this message is the only thing some
  // callers ever see; "Could not create the pharmacy." is what sent a rep round the loop again.
  assert.match(
    service,
    /already belongs to \$\{owner\.phoenixPharmacyCode\}/,
    "the refusal must name the pharmacy holding the code, not fall back to a generic message",
  );

  // ── 7. The form asks the question, and BOTH answers move the rep forward ──
  assert.match(form, /\/api\/direct-orders\/pharmacies\/check/, "the form must ask before it creates");
  assert.match(
    form,
    /preflight\.codeConflicts\.length > 0/,
    "a held code must be surfaced as a question in the form, before submit",
  );
  assert.match(form, /Yes — use this pharmacy/, "the YES answer must reuse the existing pharmacy");
  assert.match(form, /No — mine is a different pharmacy/, "the NO answer must exist at all — that is the fix");
  assert.match(
    form,
    /const unansweredCodeConflict =\s*pharmacyMode === "new" && preflight\.codeConflicts\.length > 0 && !acknowledgedCodeConflict;/,
    "submit must wait for an ANSWER, not for a dismissal",
  );
  assert.match(
    form,
    /!unansweredCodeConflict/,
    "the submit button must be gated on the question being answered",
  );
  // Changing the codes retracts the acknowledgement: it answered one specific collision.
  assert.match(
    form,
    /setAcknowledgedCodeConflict\(false\);/,
    "a new set of codes must retract the previous answer — it answered a different collision",
  );

  // ── 8. The name question, for the case that has no code to answer it ──────
  // This is the blind spot that has no other cover: groupDuplicatePharmacies matches on codes, so a
  // codeless pharmacy is invisible to it, and its name fallback only fires when BOTH sides are
  // codeless. "السيد ابوالفتوح" exists twice in D11, once codeless and once holding PS/0001556836.
  assert.match(
    service,
    /if \(name\.length < 2 \|\| byDistributor\.size > 0\) return \{ codeConflicts, nameMatches: \[\] \};/,
    "the name question is only asked when there is no code — a code is stronger evidence",
  );
  assert.match(
    service,
    /searchDirectOrderPharmacyDirectory\(access, \{ query: name, limit: 60 \}\)/,
    "the name search must cover the master DIRECTORY too — in the staging case the real pharmacy " +
      "was sitting there as PS/0001544640 the whole time and the rep could not see it",
  );
  assert.match(
    service,
    /distributorName: hit\.distributorCode \? distributorNameOf\(hit\.distributorCode\) : ""/,
    "each candidate must carry its distributor NAME — the owner's instruction, because a pharmacy " +
      "name alone does not tell a rep which pharmacy this is",
  );
  assert.match(
    form,
    /code \$\{hit\.customerCode\}/,
    "the customer code must be shown beside each candidate, not just the name",
  );

  // ── 9. My pharmacies — one click, and it can create nothing ───────────────
  assert.match(
    service,
    /\.eq\("verification_status", "verified"\)/,
    "My Pharmacies must exclude pending_review and rejected — offering an unsettled pharmacy as a " +
      "one-click choice spreads the very records the cleanup desk is trying to resolve",
  );
  assert.match(
    service,
    /\.eq\("status", "approved"\)/,
    "a pharmacy carrying an APPROVED order of this person's counts as theirs, including ones they " +
      "picked from the catalogue and never created",
  );
  assert.match(form, /My venues/, "the tab must exist");
  assert.match(
    form,
    /\(pharmacyMode !== "mine" \|\| !!pickedMine\)/,
    "the My Pharmacies tab must require an actual pick before submit",
  );
  // An empty list and a failed load must never read the same — only one of them is a reason to go
  // and search instead of trusting the emptiness.
  assert.match(form, /myPharmaciesError/, "a failed load must be distinguishable from an empty list");
}
