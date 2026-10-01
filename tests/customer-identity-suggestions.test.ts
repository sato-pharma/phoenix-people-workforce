import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  betterBand,
  identityNameKey,
  identityPairKey,
  isLinkableCandidate,
  isLinkableName,
  judgePair,
  DISTRIBUTORS_WHOSE_CODE_IS_NOT_PROOF,
  sharedProvingDistributorPair,
  sharesDistributorCode,
  specialityConflicts,
  suggestIdentityPairs,
  STRONG_METRES,
} from "../src/lib/customer-identity/suggestions.ts";
import type { IdentityCandidate } from "../src/lib/customer-identity/types.ts";
import { STORE_OVERRIDE_CUSTOMER_KEYS } from "../src/lib/sales/customer-channel.ts";
import { isCertainWholesalerVenue } from "../src/lib/venues/wholesaler-venue-guard.ts";

/**
 * Phoenix CRM Wave 2 — the engine only ever SUGGESTS, and it is pessimistic on purpose.
 *
 * 🔴 THE OWNER'S RULING (2026-09-30): the system suggests and the Super Admin confirms, in bulk or
 * one by one; nothing links by itself, and PM, AM and pharmacy are each linked only with their own
 * kind. His standing rule behind all of it is that a false positive is worse than a missed catch —
 * a wrong link merges two real people's work into one record, and nobody is told.
 *
 * So what this pins is mostly REFUSAL: a one-word name, a speciality conflict, a distributor code
 * shared across two different distributors, a wholesaler offered as a pharmacy, and a pair he has
 * already ruled on. Each of those is a way the engine could have looked clever and been wrong.
 */
function candidate(over: Partial<IdentityCandidate> & Pick<IdentityCandidate, "source" | "sourceId">): IdentityCandidate {
  return {
    kind: "PM",
    name: "أحمد الهضيمي",
    ...over,
  } as IdentityCandidate;
}

export function runCustomerIdentitySuggestionTests(): void {
  // ── The folded key ───────────────────────────────────────────────────────────────────────────
  // Two foldings in sequence, not one: the contact folding understands a person's name (titles,
  // diacritics, أ/ة/ى), the place folding understands how Egyptian spelling actually varies (ض↔د).
  assert.equal(identityNameKey("د/ أحمد الهضيمي"), identityNameKey("احمد الهضيمى"), "titles and أ/ى fold away");
  assert.ok(identityNameKey("محمد الرضا").length > 0, "a real name produces a key");
  assert.equal(identityNameKey("  "), "", "an empty name has no key");

  // ── A one-word name is not evidence ──────────────────────────────────────────────────────────
  assert.equal(isLinkableName("أحمد"), false, "one of the commonest first names in Egypt is not a match");
  assert.equal(isLinkableName("أحمد الهضيمي"), true, "a first name and one more thing is the floor");
  assert.equal(
    judgePair(candidate({ source: "phoenix_crm", sourceId: "1", name: "أحمد" }), candidate({ source: "marketing", sourceId: "2", name: "أحمد" })),
    null,
    "two bare first names are never offered, however perfectly they match",
  );

  // ── The pair key is ordered, so a ruling survives the pair coming back the other way round ───
  const left = { source: "marketing" as const, sourceId: "b" };
  const right = { source: "phoenix_crm" as const, sourceId: "a" };
  assert.equal(identityPairKey(left, right), identityPairKey(right, left), "(a, b) and (b, a) are ONE pair");

  assert.equal(betterBand("possible", "strong"), "strong");
  assert.equal(betterBand("fact", "strong"), "fact");

  // ── A speciality conflict vetoes the pair, whatever else agrees ──────────────────────────────
  const paediatrician = candidate({ source: "phoenix_crm", sourceId: "1", speciality: "Pediatrics", lat: 30.1, lon: 31.2 });
  const surgeon = candidate({ source: "marketing", sourceId: "2", speciality: "General Surgery", lat: 30.1, lon: 31.2 });
  assert.equal(specialityConflicts(paediatrician, surgeon), true);
  assert.equal(judgePair(paediatrician, surgeon), null, "same name, same spot, different speciality — two people");
  // A BLANK is not a conflict: most rows carry no speciality, and treating absence as disagreement
  // would veto nearly every real pair.
  assert.equal(specialityConflicts(paediatrician, candidate({ source: "marketing", sourceId: "3" })), false);

  // ── PM, AM and pharmacy never mix ────────────────────────────────────────────────────────────
  assert.equal(
    judgePair(
      candidate({ source: "phoenix_crm", sourceId: "1", kind: "PM", lat: 30.1, lon: 31.2 }),
      candidate({ source: "marketing", sourceId: "2", kind: "AM", lat: 30.1, lon: 31.2 }),
    ),
    null,
    "an AM contact is never folded into a PM one, however well the names agree",
  );

  // ── FACT: the systems themselves already say it is one row ───────────────────────────────────
  const byContactId = judgePair(
    candidate({ source: "ireports360", sourceId: "9", contactCrmId: 4321 }),
    candidate({ source: "phoenix_crm", sourceId: "7", contactCrmId: 4321, name: "اسم مختلف تماما" }),
  );
  assert.equal(byContactId?.band, "fact", "a shared contact id needs no name match at all — nothing is being inferred");

  // 🔴 A distributor code proves nothing ACROSS distributors: each keeps its own numbering, so the
  //    same integer at two distributors is two different shops.
  const shopA = candidate({ source: "marketing", sourceId: "1", kind: "pharmacy", name: "صيدلية النور", distributorPairs: [{ code: "421993", distributorId: "IS-S" }] });
  const sameDistributor = candidate({ source: "direct_order", sourceId: "2", kind: "pharmacy", name: "صيدلية النور", distributorPairs: [{ code: "421993", distributorId: "IS-S" }] });
  const otherDistributor = candidate({ source: "direct_order", sourceId: "3", kind: "pharmacy", name: "صيدلية النور", distributorPairs: [{ code: "421993", distributorId: "EP-PHS" }] });
  assert.equal(sharesDistributorCode(shopA, sameDistributor), true);
  assert.equal(sharesDistributorCode(shopA, otherDistributor), false, "the same code at a DIFFERENT distributor is a different shop");
  assert.equal(judgePair(shopA, sameDistributor)?.band, "fact");
  assert.match(
    String(judgePair(shopA, sameDistributor)?.reason),
    /421993 at IS-S/,
    "the reason names the code AND whose numbering it is, because a bare code cannot be checked",
  );

  // 🔴 A SHOP CARRIES SEVERAL CODES, AND THE EVIDENCE CAN BE IN THE SECOND ONE. Measured on
  //    production 2026-09-30: 4 of the 131 direct-order pharmacies hold two. A single-code field
  //    silently kept whichever came first, so a pair matching on the other was never compared —
  //    which is why the pair travels as a LIST and every code gets its own bucket.
  const twoCodes = candidate({
    source: "direct_order",
    sourceId: "6",
    kind: "pharmacy",
    name: "شيء اخر تماما",
    distributorPairs: [
      { code: "999999", distributorId: "EP-PHS" },
      { code: "421993", distributorId: "IS-S" },
    ],
  });
  assert.equal(sharesDistributorCode(shopA, twoCodes), true, "the match is on the SECOND code, and it still counts");
  assert.equal(judgePair(shopA, twoCodes)?.band, "fact", "a fact needs no name match — and these two names do not match at all");
  assert.equal(
    suggestIdentityPairs([shopA, twoCodes]).length,
    1,
    "the sweep finds it too: a shop is bucketed under EVERY code it carries, never just its first",
  );

  // 🔴 AN EP-PHS CODE IS A REASON TO LOOK, NEVER THE PROOF — so it cannot reach the `fact` band.
  //
  // Measured on production 2026-08-23 across all eight distributors: 232 EP-PHS codes carry two or
  // three pharmacy names, 168 of them CONCURRENTLY (overlapping invoice months, which is what
  // separates a reuse from a rename). PS: 224 multi-name codes, 0 concurrent. IS: 108, 0.
  // EG/IS-S/EP-BK/SF: 38, 0. One distributor's numbering, so the exclusion is exactly one entry.
  //
  // Whether those concurrent names are two real shops or one shop written twice is NOT established
  // (the 2026-08-23 audit found EP-PHS's "address" column is a byte copy of the name, so it
  // corroborates nothing) — and that is exactly the point: the code settles neither question.
  // What makes it dangerous rather than untidy is that `fact` is the ONE band that skips the name
  // check, so before this an EP-PHS code offered two UNLIKE names as certain — and the owner
  // confirming it would have recorded a merge on evidence that says "look".
  {
    const epLeft = candidate({
      source: "marketing",
      sourceId: "ep-1",
      kind: "pharmacy",
      name: "صيدلية علا رجب",
      distributorPairs: [{ code: "22197793", distributorId: "EP-PHS" }],
    });
    const epUnlikeName = candidate({
      source: "marketing",
      sourceId: "ep-2",
      kind: "pharmacy",
      name: "الجمعية الشرعية - 6 اكتوبر",
      distributorPairs: [{ code: "22197793", distributorId: "EP-PHS" }],
    });
    assert.equal(
      judgePair(epLeft, epUnlikeName),
      null,
      "two unlike names sharing only an EP-PHS code are offered as NOTHING — that code is why 168 of them " +
        "carry two concurrent names, so it cannot be the certainty that skips the name check",
    );

    // The plain question is unchanged: they DO share a code. Only its standing as proof is withdrawn,
    // and `sharedDistributorPair` stays as it was for callers asking that plain question.
    assert.equal(sharesDistributorCode(epLeft, epUnlikeName), true, "they do share a code — that is still true");
    assert.equal(
      sharedProvingDistributorPair(epLeft, epUnlikeName),
      null,
      "but it is not a PROVING code, which is the only thing the fact band may rest on",
    );

    // Not hidden: with the names agreeing it stands on its own evidence, honestly banded.
    const epSameName = candidate({
      source: "direct_order",
      sourceId: "ep-3",
      kind: "pharmacy",
      name: "صيدلية علا رجب",
      distributorPairs: [{ code: "22197793", distributorId: "EP-PHS" }],
      lat: 30.05,
      lon: 31.25,
    });
    const epSameNameNear = candidate({
      source: "marketing",
      sourceId: "ep-4",
      kind: "pharmacy",
      name: "صيدلية علا رجب",
      distributorPairs: [{ code: "22197793", distributorId: "EP-PHS" }],
      lat: 30.05,
      lon: 31.2501,
    });
    assert.equal(
      judgePair(epSameName, epSameNameNear)?.band,
      "strong",
      "the same name with the places together is STRONG, not fact — the pair is demoted, never dropped",
    );

    // A real proving code still reaches fact even when the row also carries an EP-PHS one, so the
    // exclusion skips that one code rather than disqualifying the whole row.
    const mixed = candidate({
      source: "direct_order",
      sourceId: "ep-5",
      kind: "pharmacy",
      name: "لا يشبه الاسم الاخر",
      distributorPairs: [
        { code: "22197793", distributorId: "EP-PHS" },
        { code: "0001509893", distributorId: "PS" },
      ],
    });
    const psOnly = candidate({
      source: "marketing",
      sourceId: "ep-6",
      kind: "pharmacy",
      name: "اسم ثالث مختلف",
      distributorPairs: [{ code: "0001509893", distributorId: "PS" }],
    });
    assert.equal(judgePair(mixed, psOnly)?.band, "fact", "a PS code on the same row still proves it");
    assert.match(String(judgePair(mixed, psOnly)?.reason), /0001509893 at PS/, "and the reason names the code that did prove it");

    // 🔴 Spelling of the id must not be what lets it through, and the case that matters is BOTH sides
    //    spelling it the same unexpected way: two ids that differ never match as a shared code at
    //    all, so testing "EP-PHS" against " ep-phs " passes whether the exclusion folds case or not.
    //    Here both carry the padded lower-case form, so they DO match each other — and only the
    //    folding keeps that out of the fact band. (The first draft of this test used the mismatched
    //    pair and went green against a build with the folding removed.)
    const epLower = candidate({
      source: "direct_order",
      sourceId: "ep-7",
      kind: "pharmacy",
      name: "اسم مختلف رابع",
      distributorPairs: [{ code: "22197793", distributorId: " ep-phs " }],
    });
    const epLowerTwin = candidate({
      source: "marketing",
      sourceId: "ep-8",
      kind: "pharmacy",
      name: "اسم مختلف خامس",
      distributorPairs: [{ code: "22197793", distributorId: " ep-phs " }],
    });
    assert.equal(sharesDistributorCode(epLower, epLowerTwin), true, "spelled the same way, they do share the code");
    assert.equal(
      sharedProvingDistributorPair(epLower, epLowerTwin),
      null,
      "a lower-cased or padded EP-PHS is the same distributor — the exclusion trims and folds case",
    );
    assert.equal(judgePair(epLower, epLowerTwin), null, "so no spelling of that id reaches the fact band");

    // Keep it NARROW. Widening this to another distributor throws away real evidence: every other
    // one measured 0 concurrent codes.
    assert.deepEqual(
      [...DISTRIBUTORS_WHOSE_CODE_IS_NOT_PROOF],
      ["EP-PHS"],
      "exactly one distributor is excluded — the only one measured to reuse a code concurrently",
    );
  }

  // An empty or half-filled pair is not evidence. Two rows that know nothing must not match each
  // other on knowing nothing — the shape a blank string would have made look like agreement.
  const noCode = candidate({ source: "direct_order", sourceId: "7", kind: "pharmacy", name: "صيدلية النور" });
  const halfCode = candidate({ source: "marketing", sourceId: "8", kind: "pharmacy", name: "صيدلية النور", distributorPairs: [{ code: "", distributorId: "IS-S" }] });
  assert.equal(sharesDistributorCode(noCode, halfCode), false, "no code and half a code are not a shared code");
  assert.equal(sharesDistributorCode(halfCode, halfCode), false, "and a blank code never matches even itself");

  // ── A wholesaler is never offered as a pharmacy identity ─────────────────────────────────────
  const makhzan = candidate({ source: "marketing", sourceId: "4", kind: "pharmacy", name: "مخزن النور للادويه" });
  const makhzanTwin = candidate({ source: "direct_order", sourceId: "5", kind: "pharmacy", name: "مخزن النور للادويه" });
  assert.equal(judgePair(makhzan, makhzanTwin), null, "two warehouses of the same name are still never offered as a pharmacy");
  assert.equal(
    suggestIdentityPairs([makhzan, makhzanTwin]).length,
    0,
    "and the sweep drops them before the screen ever sees them",
  );

  // ── STRONG: the names match and the two places stand together ────────────────────────────────
  // Roughly 90 m apart at Cairo's latitude — inside the 200 m band.
  const here = candidate({ source: "phoenix_crm", sourceId: "10", lat: 30.05, lon: 31.23 });
  const nearby = candidate({ source: "marketing", sourceId: "11", lat: 30.0508, lon: 31.23 });
  const strong = judgePair(here, nearby);
  assert.equal(strong?.band, "strong");
  assert.match(String(strong?.reason), /m apart/, "the reason names the real distance, in words he can check");

  // Far apart, and nothing else ties them: the distance does NOT promote, and with no brick, phone
  // or region there is nothing left to offer.
  const faraway = candidate({ source: "marketing", sourceId: "12", lat: 31.2, lon: 29.9 });
  assert.equal(judgePair(here, faraway), null, "distance alone never suggests, and never rescues");

  // ── LIKELY: the names match and one more thing ties them ─────────────────────────────────────
  assert.equal(
    judgePair(candidate({ source: "phoenix_crm", sourceId: "20", phone: "+20 100 123 4567" }), candidate({ source: "marketing", sourceId: "21", phone: "01001234567" }))?.band,
    "likely",
    "the same handset written two ways is one phone number",
  );
  assert.equal(
    judgePair(candidate({ source: "phoenix_crm", sourceId: "22", brickCode: "D14" }), candidate({ source: "marketing", sourceId: "23", brickCode: "D14" }))?.band,
    "likely",
  );

  // ── POSSIBLE: the same name in the same region, and nothing else ─────────────────────────────
  const possible = judgePair(
    candidate({ source: "phoenix_crm", sourceId: "30", regionCode: "Delta (1)" }),
    candidate({ source: "marketing", sourceId: "31", regionCode: "Delta (1)" }),
  );
  assert.equal(possible?.band, "possible");
  assert.match(String(possible?.reason), /Nothing else ties them together/, "the weakest band says so in its own words");

  // And with no region either, nothing is offered at all — a bare name match is not a suggestion.
  assert.equal(judgePair(candidate({ source: "phoenix_crm", sourceId: "40" }), candidate({ source: "marketing", sourceId: "41" })), null);

  // ── The sweep ────────────────────────────────────────────────────────────────────────────────
  const pool = [
    candidate({ source: "phoenix_crm", sourceId: "50", brickCode: "D14" }),
    candidate({ source: "marketing", sourceId: "51", brickCode: "D14" }),
    candidate({ source: "direct_order", sourceId: "52", contactCrmId: 77 }),
    candidate({ source: "ireports360", sourceId: "53", contactCrmId: 77 }),
  ];
  const all = suggestIdentityPairs(pool);
  assert.ok(all.length >= 2, "the sweep finds both pairs");
  assert.equal(all[0]?.band, "fact", "certain first — the screen reads in the order he works it");

  // 🔴 A pair he has already ruled "not the same" is dropped HERE, not in the screen — so a
  //    WITHDRAWN ruling brings it straight back simply by leaving the key out of the set. That is
  //    the whole mechanism behind his "yes, the Super Admin can undo it" answer.
  const ruledKey = identityPairKey({ source: "direct_order", sourceId: "52" }, { source: "ireports360", sourceId: "53" });
  const afterRuling = suggestIdentityPairs(pool, { ruledOut: new Set([ruledKey]) });
  assert.ok(!afterRuling.some((pair) => pair.pairKey === ruledKey), "a live ruling removes the pair");
  assert.ok(suggestIdentityPairs(pool).some((pair) => pair.pairKey === ruledKey), "and withdrawing it returns the pair, with no other change");

  // A row already on a master is settled — offering it again would ask a question he has answered.
  const afterLink = suggestIdentityPairs(pool, { linkedSourceIds: new Set(["direct_order:52"]) });
  assert.ok(!afterLink.some((pair) => pair.pairKey === ruledKey), "a confirmed row leaves the suggestion list");

  // The sweep is stable: two runs over unchanged data produce the same list in the same order, so
  // a pick that did not change never jumps about between two reloads.
  assert.deepEqual(
    suggestIdentityPairs(pool).map((pair) => pair.pairKey),
    suggestIdentityPairs(pool).map((pair) => pair.pairKey),
  );

  // ── 🔴 THE SWEEP MUST FIND WHAT THE RULE FINDS ───────────────────────────────────────────────
  // The first cut bucketed candidates by folded NAME alone, reasoning that every band needs a name
  // match. Two do not: a shared iReports360 contact id and a shared distributor code are `fact`
  // whatever the rows are called — and that is exactly when a link is worth most, because nothing
  // else would ever find it. Measured on the real engine before the fix: judgePair said `fact` and
  // suggestIdentityPairs over the SAME two rows returned ZERO pairs. The rule and the sweep
  // disagreed silently, in the sweep's favour.
  //
  // The old suite passed straight through it, because both its fixtures happened to share a name.
  // These assertions are the ones that would have caught it.
  const arabicName = candidate({ source: "ireports360", sourceId: "60", contactCrmId: 4321, name: "احمد الهضيمي" });
  const latinName = candidate({ source: "direct_order", sourceId: "61", contactCrmId: 4321, name: "Ahmed El Hodeimy Clinic" });
  assert.equal(judgePair(arabicName, latinName)?.band, "fact", "the RULE sees a shared contact id across two spellings");
  const crossName = suggestIdentityPairs([arabicName, latinName]);
  assert.equal(crossName.length, 1, "and so must the SWEEP — a fact pair is never invisible because the names differ");
  assert.equal(crossName[0]?.band, "fact");

  // A pair that lands in TWO buckets — same name AND same contact id — is offered exactly once.
  const twice = suggestIdentityPairs([
    candidate({ source: "phoenix_crm", sourceId: "62", contactCrmId: 99 }),
    candidate({ source: "marketing", sourceId: "63", contactCrmId: 99 }),
  ]);
  assert.equal(twice.length, 1, "he is asked about one pair once, however many ways the engine found it");

  // The cross-distributor refusal must survive the new code bucket: two shops sharing an integer
  // at DIFFERENT distributors are now bucketed near each other, and must still not be offered.
  const nour = candidate({ source: "marketing", sourceId: "64", kind: "pharmacy", name: "صيدلية النور", distributorPairs: [{ code: "421993", distributorId: "IS-S" }] });
  const elsewhere = candidate({ source: "direct_order", sourceId: "65", kind: "pharmacy", name: "شيء اخر تماما", distributorPairs: [{ code: "421993", distributorId: "EP-PHS" }] });
  assert.equal(suggestIdentityPairs([nour, elsewhere]).length, 0, "the same code at a DIFFERENT distributor is still two shops");
  assert.equal(
    suggestIdentityPairs([nour, { ...elsewhere, distributorPairs: [{ code: "421993", distributorId: "IS-S" }] }]).length,
    1,
    "and the same distributor is still one",
  );

  // ── The screen wears the house design system, not a look of its own ──────────────────────────
  // 🔴 The owner's standing rule: "before building new UI, match the sibling pages' exact design
  //    identity. Never invent a one-off look." This screen shipped with a hand-rolled header and
  //    hand-rolled figure tiles and had to be rebuilt on the shared primitives; these keep it there.
  const workspace = readFileSync("src/components/customer-identity/customer-links-workspace.tsx", "utf8");
  for (const primitive of ["AdminPageHero", "AdminStatCard", "AdminSectionHeader", "AdminInsightChip", "AdminCallout"]) {
    assert.ok(workspace.includes(`<${primitive}`), `the screen must use the shared ${primitive}, not a hand-rolled copy`);
  }
  assert.ok(
    workspace.includes('from "@/components/admin/admin-design-system"'),
    "and it must take them from the one design system every other admin page reads",
  );
  // 🔴 AND THE WEAK FORM OF THIS CHECK WAS MEASURED NOT TO FIRE. Asserting only that the string
  //    "<AdminPageHero" appears passes while the hero sits behind `{false ? … }` with a
  //    hand-rolled <h1> above it — proved by breaking it exactly that way. A source check cannot
  //    tell rendered from dead, so it is paired with the thing the hero OWNS: this file may not
  //    carry a heading of its own, because the page's title comes from the hero.
  assert.doesNotMatch(workspace, /<h1[\s>]/, "the page title comes from AdminPageHero — a local <h1> means the hero was bypassed");
  assert.doesNotMatch(workspace, /\brounded-(?!none\b)/, "square corners, as everywhere");
  assert.doesNotMatch(workspace, /\btruncate\b|…/, "nothing is cut off with an ellipsis");

  assert.equal(STRONG_METRES, 200, "the strong band is 200 m — measured against the 127 validated links, not tuned");

  // ── Customer 360 for one confirmed identity ────────────────────────────────────────
  {
    const profile = readFileSync("src/components/customer-identity/customer-identity-profile.tsx", "utf8");
    const loader = readFileSync("src/lib/customer-identity/server/profile.ts", "utf8");
    const route = readFileSync("app/(admin)/admin/customer-links/[masterId]/page.tsx", "utf8");

    // The same house look as the screen it hangs off, and the same proof that the hero is really
    // rendered: a string check alone passes while the hero sits behind `{false ? ... }`.
    for (const primitive of ["AdminPageHero", "AdminStatCard", "AdminTableShell", "AdminInsightChip"]) {
      assert.match(profile, new RegExp(`<${primitive}`), `Customer 360 uses ${primitive}, like every other admin page`);
    }
    assert.doesNotMatch(profile, /<h1[\s>]/, "the page title comes from AdminPageHero — a local <h1> means the hero was bypassed");
    assert.doesNotMatch(profile, /rounded-(?!none)/, "square corners, as everywhere");
    assert.doesNotMatch(profile, /truncate|\u2026/, "nothing is cut off with an ellipsis");

    // 🔴 SHAPES ARE SHARED; READERS ARE NOT. A component naming `server/profile` — even in an
    //    `import type` TypeScript erases — puts the service-role client one refactor from the
    //    browser bundle. It is the rule this module already wrote for `SuggestionCluster`.
    assert.doesNotMatch(profile, /customer-identity\/server/, "the screen names no server module");
    assert.match(profile, /from "@\/lib\/customer-identity\/types"/, "it borrows the shapes from types.ts");

    // 🔴 BY ID, NEVER THE WHOLE REGISTER. `loadIdentityCandidates` reads every row of all four
    //    systems — right for the suggestion engine, and absurd for one person's page.
    assert.doesNotMatch(loader, /loadIdentityCandidates/, "one identity is read by its own ids, never by loading every candidate");
    for (const table of ["phoenix_crm_customers", "crm_contacts", "marketing_pharmacies", "direct_order_pharmacies"]) {
      assert.match(loader, new RegExp(`from\\("${table}"\\)`), `it can read ${table} for a linked row`);
    }

    // 🔴 A ROW WHOSE SOURCE HAS GONE IS SHOWN, NOT DROPPED. A link disappearing quietly turns a
    //    decision somebody made into one nobody can find.
    assert.match(loader, /missing: !found/, "a vanished source row is marked missing");
    assert.match(profile, /No longer in its own system|row\.missing/, "and the screen says so");

    // The gate is repeated on the page rather than inherited from the one it hangs off.
    assert.match(route, /canAccess\(access, "customer_identity", "read"\)/, "Customer 360 carries its own permission check");
    assert.match(route, /notFound\(\)/, "an unknown master is a not-found page, not an empty one");
    // A mistyped id must not reach the database: `master_id` is a uuid column, so anything else
    // makes Postgres throw and the browser shows an application error instead of a missing page.
    assert.match(route, /0-9a-f\]\{8\}-/, "the id shape is checked before the read");
  }

  // ── Where a pharmacy's distributor codes are read from ──────────────────────────────────────
  {
    const reads = stripComments(readFileSync("src/lib/customer-identity/server/reads.ts", "utf8"));
    const loader = stripComments(readFileSync("src/lib/customer-identity/server/profile.ts", "utf8"));

    for (const [file, source] of [
      ["reads.ts", reads],
      ["profile.ts", loader],
    ] as const) {
      // 🔴 BOTH SIDES READ THEIR CHILD TABLE. The parents' own columns are dead —
      //    `direct_order_pharmacies.distributor_code` is empty on all 131 production rows — and a
      //    reader that names one gets null for every shop and raises nothing at all.
      assert.match(source, /direct_order_pharmacy_distributor_codes/, `${file} reads the direct-order codes from the child table`);
      assert.match(source, /marketing_pharmacy_distributor_codes/, `${file} reads the marketing codes from the child table`);

      // 🔴 THE MASTER-RESOLVED PAIR, NEVER THE RAW ONE. `mapped_customer_code` differs from the
      //    typed `distributor_pharmacy_code` on 33 of the 479 marketing rows, so the raw code would
      //    file those shops under a code no other system uses. And `distributor_id` there is a
      //    bigint in the desk's own numbering while direct orders speak the text code — comparing
      //    the two is the cross-vocabulary mistake the distributor rule exists to prevent.
      assert.match(source, /mapped_distributor_code/, `${file} takes the resolved distributor`);
      assert.match(source, /mapped_customer_code/, `${file} takes the resolved customer code`);
      assert.doesNotMatch(source, /distributor_pharmacy_code/, `${file} never keys on the raw typed code`);
      assert.doesNotMatch(source, /distributor_customer_code/, `${file} never names the parent's dead column`);
    }
  }

  // ── The wholesaler guard is asked the question it can actually answer ───────────────────────
  {
    // 🔴 EACH HALF IN ITS OWN PARAMETER. `isCertainWholesalerVenue(name, clientCode,
    //    distributorCode)` carries two account-level owner rulings that need the halves apart: a
    //    pharmacy-override that PROTECTS a real shop, and `isStoreOverride`, which fires only when
    //    the customer code and the distributor arrive TOGETHER. #4978 passed the customer code as
    //    the distributor and left clientCode null, so neither could ever fire — silently, because
    //    a guard answering "not a wholesaler" looks exactly like a guard that was never asked.
    //
    //    The case is taken from the repo's own roster rather than typed in, so it stays true when
    //    the owner rules on another account.
    const [firstOverride] = [...STORE_OVERRIDE_CUSTOMER_KEYS];
    const [distributorId, code] = String(firstOverride).split("|");
    assert.ok(distributorId && code, "the store-override roster is keyed distributor|code");

    // A name that trips NOTHING on its own, so only the code pair can be doing the work — and two
    // words, or `isLinkableName` would refuse it first and the whole block would pass for the
    // wrong reason (it did, on the first draft of this test).
    const plainName = "بدر الدين";
    assert.equal(isLinkableName(plainName), true, "the name itself is linkable, so the code is what decides below");
    assert.equal(isCertainWholesalerVenue(plainName, null, null), false, "the name alone says nothing");
    assert.equal(
      isCertainWholesalerVenue(plainName, null, code),
      false,
      "and the shipped argument order could never have caught it — the bug, pinned",
    );
    assert.equal(isCertainWholesalerVenue(plainName, code, distributorId), true, "the two halves together are the owner's ruling");

    const ruled = candidate({
      source: "marketing",
      sourceId: "90",
      kind: "pharmacy",
      name: plainName,
      distributorPairs: [{ code, distributorId }],
    });
    assert.equal(isLinkableCandidate(ruled), false, "so a venue the owner ruled a store is never offered as a pharmacy identity");
    assert.equal(
      isLinkableCandidate({ ...ruled, distributorPairs: [] }),
      true,
      "while the same name carrying no code is still a pharmacy — the ruling belongs to the CODE, not the name",
    );
    assert.equal(
      judgePair(ruled, { ...ruled, source: "direct_order", sourceId: "91" }),
      null,
      "and it is refused from both sides of a pair",
    );
  }

  console.log("customer identity suggestions: OK");
}
