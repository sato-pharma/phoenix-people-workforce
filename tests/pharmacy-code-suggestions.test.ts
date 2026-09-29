import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  type PharmacyCodeCandidate,
  normalizePlaceName,
  proximityLabel,
  rankPharmacyCodeSuggestions,
} from "../src/lib/venues/pharmacy-code-suggestions.ts";

// 🔒 NOTHING IS EVER FILTERED OUT — owner ruling, 2026-09-29: "build the code picker ranked by gps,
// nothing filtered out".
//
// The obvious design was to FILTER the code list to the rep's area, and it is refused because
// 25,811 of 50,936 reference codes (50.7%) carry no area at all — a filter would make half the
// database unreachable and a legitimate shop with a blank reference row could never be captured.
//
// So the load-bearing assertion in this file is not the ordering, it is the CONSERVATION: the
// ranker returns exactly the rows it was given. A future "improvement" that adds a .filter(), a
// limit, or drops place-less rows breaks this test, and should.

/** The real pair behind the rule. One digit apart, 60 km apart on the ground. */
const RIGHT_CODE: PharmacyCodeCandidate = {
  address: "ناحيةنشوةبم السيدمحمديوسف الزقازيق",
  areaName: "الزقازيق",
  code: "442359",
  governorateName: "الشرقية",
  name: "اسعد جديدة",
};
const WRONG_CODE: PharmacyCodeCandidate = {
  address: "رقم31ش الخليفة حى الهرمكفرطهرمس",
  areaName: "فيصل",
  code: "443359",
  governorateName: "الجيزة",
  name: "احمد عبدالشافى",
};
/** Half the reference import looks like this: a code and an address, no place at all. */
const PLACELESS: PharmacyCodeCandidate = { address: "ش الجمهورية", code: "999001" };

/** Where Samaa actually stood, as Google reverse-geocoded it. */
const NASHWAH = { areaName: "Zagazig", governorateName: "Al-Sharqia Governorate" };

function runConservationTests() {
  // ── THE RULING: every input row comes back, whatever its place ────────────────
  const input = [WRONG_CODE, PLACELESS, RIGHT_CODE];
  const ranked = rankPharmacyCodeSuggestions(input, { areaName: "الزقازيق", governorateName: "الشرقية" });

  assert.equal(ranked.length, input.length, "the ranker must return EVERY candidate it was given");
  assert.deepEqual(
    [...ranked.map((row) => row.code)].sort(),
    [...input.map((row) => row.code)].sort(),
    "same members, reordered — never a subset",
  );
  assert.ok(
    ranked.some((row) => row.code === PLACELESS.code),
    "a candidate with NO area and NO governorate must survive — 50.7% of the reference import looks like this",
  );

  // An empty place must not become a filter either.
  const noPlace = rankPharmacyCodeSuggestions(input, {});
  assert.equal(noPlace.length, input.length, "an unknown capture place must still return everything");
  assert.ok(
    noPlace.every((row) => row.proximity === "elsewhere"),
    "with no place to compare against, nothing may claim to be nearby",
  );

  // Scale: a realistic area holds ~400 codes. None of them may be trimmed.
  const many = Array.from({ length: 416 }, (_, i) => ({ code: `C${i}`, areaName: i % 3 === 0 ? "الزقازيق" : null }));
  assert.equal(
    rankPharmacyCodeSuggestions(many, { areaName: "الزقازيق" }).length,
    416,
    "no implicit limit — the full candidate set is returned",
  );
}

function runRankingTests() {
  // ── The right code outranks the wrong one, which is the entire point ──────────
  // Samaa typed 443359. Had she been shown this list, 442359 would have been the first row.
  //
  // ACROSS THE LANGUAGE BOUNDARY: Google gave her position as English ("Zagazig, Al-Sharqia
  // Governorate") while the reference rows are Arabic ("الزقازيق", "الشرقية"). The area tier cannot
  // bridge that and deliberately does not try, so this resolves through the GOVERNORATE tier via
  // the canonical vocabulary — coarser, still correct, and still puts 442359 first.
  const ranked = rankPharmacyCodeSuggestions([WRONG_CODE, RIGHT_CODE], NASHWAH);
  assert.equal(ranked[0]?.code, "442359", "the code registered where she stood must rank first");
  assert.equal(
    ranked[0]?.proximity,
    "same_governorate",
    "English capture vs Arabic reference resolves at governorate level, not area",
  );
  assert.equal(ranked[1]?.code, "443359", "the Giza code is still present, just below");
  assert.equal(ranked[1]?.proximity, "elsewhere");

  // Same language on both sides DOES reach the finer tier.
  const sameLanguage = rankPharmacyCodeSuggestions([WRONG_CODE, RIGHT_CODE], {
    areaName: "الزقازيق",
    governorateName: "الشرقية",
  });
  assert.equal(sameLanguage[0]?.code, "442359");
  assert.equal(sameLanguage[0]?.proximity, "same_area", "matching Arabic area names reach same_area");

  // ── Same governorate, different area sits in between ─────────────────────────
  // Arabic on both sides, so all three tiers are reachable in one list.
  const sameGov: PharmacyCodeCandidate = { areaName: "ههيا", code: "500100", governorateName: "الشرقية" };
  const tiers = rankPharmacyCodeSuggestions([PLACELESS, sameGov, RIGHT_CODE], {
    areaName: "الزقازيق",
    governorateName: "الشرقية",
  });
  assert.deepEqual(
    tiers.map((row) => row.proximity),
    ["same_area", "same_governorate", "elsewhere"],
    "same area, then same governorate, then everything else",
  );

  // ── The sort is STABLE, so the caller's own ordering survives underneath ──────
  const a: PharmacyCodeCandidate = { areaName: "الزقازيق", code: "A" };
  const b: PharmacyCodeCandidate = { areaName: "الزقازيق", code: "B" };
  const c: PharmacyCodeCandidate = { areaName: "الزقازيق", code: "C" };
  assert.deepEqual(
    rankPharmacyCodeSuggestions([a, b, c], { areaName: "الزقازيق" }).map((row) => row.code),
    ["A", "B", "C"],
    "within one tier the caller's order (closest code match first) must not be scrambled",
  );
}

function runNormalisationTests() {
  // The three sources spell the same place three ways: Google, the distributor's sheet, our areas.
  assert.equal(normalizePlaceName("Al-Sharqia Governorate"), normalizePlaceName("al sharqia"));
  assert.equal(normalizePlaceName("الشرقية"), normalizePlaceName("الشرقيه"), "ة and ه are one letter here");
  assert.equal(normalizePlaceName("الزقازيق"), normalizePlaceName("الزقازيق "), "trailing space");
  assert.equal(normalizePlaceName("إسماعيلية"), normalizePlaceName("اسماعيليه"), "alef and ta-marbuta variants");
  assert.equal(normalizePlaceName(null), "");
  assert.equal(normalizePlaceName(undefined), "");

  // NOT fuzzy — two genuinely different towns must never be equated, or a wrong code ranks first.
  assert.notEqual(
    normalizePlaceName("شبين الكوم"),
    normalizePlaceName("شبين القناطر"),
    "these are different towns in different governorates and must never collapse together",
  );
  assert.notEqual(normalizePlaceName("المنيا"), normalizePlaceName("المنوفية"));

  assert.equal(proximityLabel("same_area"), "In this area");
  // The labels describe the CODE's place, never the rep — nothing may imply he is being judged.
  for (const proximity of ["same_area", "same_governorate", "elsewhere"] as const) {
    const label = proximityLabel(proximity).toLowerCase();
    for (const forbidden of ["you", "your", "wrong", "suspicious", "far from"]) {
      assert.ok(!label.includes(forbidden), `label "${label}" must not address or judge the rep`);
    }
  }
}

function runWiringTests() {
  // A RANKER NOTHING CALLS RANKS NOTHING. Every assertion above would pass against a module that is
  // never reached — the exact "shipped green, reachable by nobody" shape. Pin the three joints.
  const read = (path: string) =>
    readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

  const service = read("src/lib/marketing-requests/service.ts");
  assert.ok(
    /(^|[^A-Za-z0-9_$])rankPharmacyCodeSuggestions\s*\(/m.test(service),
    "the service must actually rank the candidates it fetches",
  );
  // 🔒 The service may narrow by the DISTRIBUTOR and the TYPED CODE — the rep's own input — and by
  // nothing else. A place filter here is the ruling this whole module exists to honour.
  assert.ok(
    !/\.eq\(\s*["']raw_area["']/.test(service) && !/\.eq\(\s*["']raw_region["']/.test(service),
    "the candidate query must never filter by area or region — ranked, never filtered (owner, 2026-09-29)",
  );

  const route = read("app/api/marketing-requests/pharmacy-code-lookup/route.ts");
  assert.ok(
    /(^|[^A-Za-z0-9_$])searchMarketingPharmacyCodeSuggestions\s*\(/m.test(route),
    "the lookup route must return suggestions, or the client has nothing to show",
  );

  const client = read("src/components/employee-portal/marketing-validation-workspace.tsx");
  assert.ok(
    client.includes("codeSuggestions"),
    "the capture screen must render the suggestions, or the picker exists only on the server",
  );
  assert.ok(
    /params\.set\(\s*["']area["']/.test(client) && /params\.set\(\s*["']governorate["']/.test(client),
    "the client must send the captured place, or every suggestion ranks as 'elsewhere'",
  );
}

export function runPharmacyCodeSuggestionTests() {
  runConservationTests();
  runRankingTests();
  runNormalisationTests();
  runWiringTests();
}
