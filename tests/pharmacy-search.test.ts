import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyCrmContactSpeciality,
  KNOWN_HCP_SPECIALITIES,
  KNOWN_HOSPITAL_SPECIALITIES,
  KNOWN_SP_SPECIALITIES,
} from "../src/lib/crm/contact-taxonomy.ts";
import { normalizeArabicPharmacyName } from "../src/lib/pharmacy-master/pharmacy-matching.ts";
import { boundingBox, haversineKm, isUsablePoint, roundKm } from "../src/lib/pharmacy-search/geo.ts";
import { MAX_BRICK_SNAP_KM, pickNearestBrick } from "../src/lib/pharmacy-search/locate.ts";
import { mergeHospitals, __testables as nearbyTestables } from "../src/lib/pharmacy-search/nearby.ts";
import { sameVenueSiblings } from "../src/lib/pharmacy-search/profile.ts";
import { resolveTerritory, type TerritoryReference } from "../src/lib/pharmacy-search/reference.ts";
import {
  visibleDistributorRows,
  visibleTerritoryReference,
  withoutHiddenReferenceCodes,
} from "../src/lib/pharmacy-search/source-visibility.ts";
import { PHOENIX_PROFILE_ID_PREFIX, phoenixCodeFromProfileId } from "../src/lib/pharmacy-search/types.ts";
import { __testables as searchTestables } from "../src/lib/pharmacy-search/search.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pharmacy Search — the search box that answers "where is this pharmacy" from our own tables and,
// when they have never heard of it, from Google.
//
// What is pinned here is the handful of decisions that are silently wrong rather than loudly
// wrong: a PostgREST filter that a comma turns into a different query, a bounding box that clips
// doctors off its east and west edges, a territory that reads the stale code on a mapping row
// instead of the brick table, and a Google-derived brick presented as if it were a mapping.
// ─────────────────────────────────────────────────────────────────────────────

const {
  collapseByPharmacy,
  foldRegistryIntoDirectory,
  looksLikeCode,
  matchRegistryPharmacy,
  rankHits,
  registryHits,
  sanitizeForOrFilter,
} = searchTestables;

function reference(): TerritoryReference {
  return {
    areaNames: new Map([
      ["HEL", "Heliopolis"],
      ["MIN1", "Minia 1"],
      ["D24", "Zagazig"],
    ]),
    bricks: new Map([
      ["B4-58", { areaCode: "HEL", blockCode: "B4", brickId: "B4-58", brickName: "ارض الجولف", regionCode: "CA" }],
      ["B129-41", { areaCode: "MIN1", blockCode: "B129", brickId: "B129-41", brickName: "مغاغه", regionCode: "UE" }],
      ["B211-3", { areaCode: "D24", blockCode: "B211", brickId: "B211-3", brickName: "الزقازيق", regionCode: "D2" }],
    ]),
    distributorNames: new Map([
      ["IS", "Ibn sina"],
      ["PS", "overseas"],
    ]),
    regionNames: new Map([
      ["CA", "Cairo"],
      ["UE", "Upper Egypt"],
      ["D2", "Delta 2"],
    ]),
  };
}

function hit(overrides: Partial<Parameters<typeof collapseByPharmacy>[0][number]> = {}) {
  return {
    address: null,
    customerCode: "1",
    distributorCode: "PS",
    distributorCount: 1,
    distributorName: "overseas",
    id: "PS:1",
    matchedOn: "name" as const,
    name: "الصيدلية الحديثة",
    origin: "database" as const,
    phoenixPharmacyCode: null,
    territory: {
      areaCode: "HEL",
      areaName: "Heliopolis",
      blockCode: "B4",
      brickId: "B4-58",
      brickName: "ارض الجولف",
      regionCode: "CA",
      regionName: "Cairo",
    },
    ...overrides,
  };
}

/**
 * DOP-000079 as production actually holds it: the pharmacy the owner searched for on 2026-09-08,
 * registered by hand at 11:18 Cairo, searched at 15:33, and reported as not in the database.
 */
function registryPharmacy(
  overrides: Partial<Parameters<typeof registryHits>[0]> = {},
): Parameters<typeof registryHits>[0] {
  return {
    address: "الزقازيق",
    areaCode: "D24",
    brickId: "B211-3",
    codes: [{ customerCode: "344524", distributorCode: "IS" }],
    name: "الإنسانية",
    phoenixPharmacyCode: "DOP-000079",
    regionCode: "D2",
    ...overrides,
  };
}

export function runPharmacySearchTests() {
  // ── A PostgREST `or=(...)` value is parsed by PostgREST, not escaped by it ──
  // A pharmacy name containing a comma or a parenthesis would terminate the filter early. The
  // query then either errors or, worse, silently means something else and returns wrong rows.
  assert.equal(sanitizeForOrFilter("صيدلية النور, فرع (2)"), "صيدلية النور فرع 2");
  assert.equal(sanitizeForOrFilter('El "Salam" Pharmacy'), "El Salam Pharmacy");
  assert.equal(sanitizeForOrFilter("  spaced   out  "), "spaced out");
  assert.ok(!sanitizeForOrFilter("a*b\\c").includes("*"), "a wildcard must not survive into an ilike pattern");

  // ── Code detection decides whether the code branch runs at all ─────────────
  assert.ok(looksLikeCode("0001559807"), "a 10-digit Overseas code is a code");
  assert.ok(looksLikeCode("344524"), "a 6-digit Ibn Sina code is a code");
  assert.ok(looksLikeCode("B4-58"), "a brick-style id is code-shaped");
  assert.ok(!looksLikeCode("الصيدلية الحديثة"), "an Arabic pharmacy name is not a code");
  assert.ok(!looksLikeCode("Ibn sina"), "a distributor name is not a code");

  // ── The same pharmacy at two distributors is ONE pharmacy ──────────────────
  // 52,615 mapping rows cover 40,512 distinct names: a busy pharmacy is carried by several
  // distributors under separate codes. Listing it once per distributor buries every other result.
  const collapsed = collapseByPharmacy([
    hit({ customerCode: "1", distributorCode: "PS", id: "PS:1" }),
    hit({ address: "7 عدنان السرادى", customerCode: "9", distributorCode: "IS", id: "IS:9" }),
  ]);
  assert.equal(collapsed.length, 1, "one physical pharmacy must collapse to one row");
  assert.equal(collapsed[0].distributorCount, 2, "the count must say how many distributors carry it");
  assert.equal(
    collapsed[0].address,
    "7 عدنان السرادى",
    "the surviving row must keep the address — a row with one beats an identical row without",
  );

  // ── ...but the same NAME in two different bricks is two pharmacies ─────────
  // Four brick names are known to repeat across areas, and generic pharmacy names repeat far
  // more. Collapsing on name alone would merge a Cairo pharmacy into an Upper Egypt one and
  // report a single brick for both.
  const twoBricks = collapseByPharmacy([
    hit({ customerCode: "1", distributorCode: "PS", id: "PS:1" }),
    hit({
      customerCode: "2",
      distributorCode: "PS",
      id: "PS:2",
      territory: {
        areaCode: "MIN1",
        areaName: "Minia 1",
        blockCode: "B129",
        brickId: "B129-41",
        brickName: "مغاغه",
        regionCode: "UE",
        regionName: "Upper Egypt",
      },
    }),
  ]);
  assert.equal(twoBricks.length, 2, "the same name in two bricks is two pharmacies, not one");

  // ═══════════════════════════════════════════════════════════════════════════
  // The Phoenix registry — the fourth branch
  //
  // A pharmacy is born down two disjoint paths and neither writes the other's table:
  // `source_of_sales_customer_map` from the distributor files, and `direct_order_pharmacies` when
  // someone registers a venue in Phoenix. This screen searched only the first until 2026-09-08,
  // when the owner searched صيدلية الإنسانية, was told it was not in the database, and spent a
  // billed Google Places call being told so — while DOP-000079 "الإنسانية" (brick B211-3, area
  // D24) had been registered by hand at 11:18 Cairo that morning, four hours earlier.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── The query is LONGER than the stored name, which is the direction nobody tests ──
  // "صيدلية الإنسانية" typed against "الإنسانية" stored: a plain `name.includes(query)` is false,
  // and so is an ILIKE '%query%' in SQL. Dropping the generic word from BOTH sides is what makes
  // them meet — and it is the same word list the pharmacy-matching module already keeps.
  const registryQuery = (raw: string) => ({ normalized: normalizeArabicPharmacyName(raw), raw });

  assert.equal(
    matchRegistryPharmacy(registryPharmacy(), registryQuery("صيدلية الإنسانية")),
    "name",
    "the owner's own query must reach the pharmacy someone registered that morning — the generic "
      + "word makes the query longer than the stored name, so a substring test fails one way round",
  );
  assert.equal(
    matchRegistryPharmacy(registryPharmacy(), registryQuery("الإنسانية")),
    "name",
    "the bare name must match too — stripping stop words must not be the only route",
  );
  assert.equal(
    matchRegistryPharmacy(registryPharmacy(), registryQuery("الانسانيه فرع 2")),
    null,
    "a query naming a DIFFERENT branch must not match — stop-word removal widens the match, it "
      + "must not make it unconditional",
  );

  // A code is an unambiguous identifier, and `matchedOn` must say which kind was recognised —
  // reporting a code hit as a name hit tells the reader the wrong thing about why a row came back.
  assert.equal(
    matchRegistryPharmacy(registryPharmacy(), registryQuery("DOP-000079")),
    "phoenix_code",
    "the Phoenix registry code must be searchable — it is the only identifier a venue with no "
      + "distributor code has",
  );
  assert.equal(
    matchRegistryPharmacy(registryPharmacy(), registryQuery("dop-000079")),
    "phoenix_code",
    "…and its casing must not decide it",
  );
  assert.equal(
    matchRegistryPharmacy(registryPharmacy(), registryQuery("344524")),
    "customer_code",
    "a distributor's own code recorded against the venue must find it",
  );
  assert.equal(
    matchRegistryPharmacy(registryPharmacy(), registryQuery("الصيدلية الحديثة")),
    null,
    "an unrelated name must not match — every registered pharmacy would otherwise answer every query",
  );

  // ── One hit per distributor code, exactly as the directory branches emit one per mapping ──
  const withTwoCodes = registryHits(
    registryPharmacy({
      codes: [
        { customerCode: "344524", distributorCode: "IS" },
        { customerCode: "0001559807", distributorCode: "PS" },
      ],
    }),
    reference(),
    "name",
  );
  assert.equal(withTwoCodes.length, 2, "a venue with two distributor codes emits one hit per code");
  assert.equal(new Set(withTwoCodes.map((entry) => entry.id)).size, 2, "…with distinct ids, or React keys collide");
  assert.ok(
    withTwoCodes.every((entry) => entry.origin === "phoenix" && entry.phoenixPharmacyCode === "DOP-000079"),
    "every registry hit must carry the origin and the DOP code, or the screen cannot label it",
  );

  // The territory is the VENUE's own brick, not a distributor's `mapped_*` view of it. Reading the
  // mapped columns would split one pharmacy's hits across several collapse keys.
  assert.equal(withTwoCodes[0]?.territory.brickName, "الزقازيق", "the venue's own brick resolves to its name");
  assert.equal(withTwoCodes[0]?.territory.areaName, "Zagazig", "…and to its area");
  assert.equal(withTwoCodes[0]?.territory.regionName, "Delta 2", "…and its region");

  // ── A venue no distributor has heard of is the whole point of this branch ──
  // 6 of the 53 active registrations (production, 2026-09-08) carry no distributor code at all.
  // Emitting nothing for them would leave exactly the pharmacies the directory cannot answer for
  // invisible — which is the defect, not an edge case.
  const codeless = registryHits(registryPharmacy({ codes: [] }), reference(), "phoenix_code");
  assert.equal(codeless.length, 1, "a venue with no distributor code still produces a hit");
  assert.equal(codeless[0]?.distributorCode, null);
  assert.equal(codeless[0]?.customerCode, null);
  assert.equal(codeless[0]?.phoenixPharmacyCode, "DOP-000079", "…identified by its Phoenix code alone");

  // ── The same distributor twice is one catalogue entry ──────────────────────
  // A registry row and a directory row carrying the SAME distributor AND the same customer code
  // are one entry in one distributor's own catalogue — identity by construction. (The inference
  // that is NOT sound is the other one: a code shared BETWEEN distributors proves nothing,
  // because each numbers from its own catalogue.) The directory row survives because it is the
  // one with sales history behind it, but it must inherit the DOP code or the registration
  // becomes invisible again — the exact failure this branch exists to fix, one step later.
  const folded = foldRegistryIntoDirectory(
    [hit({ customerCode: "344524", distributorCode: "IS", id: "IS:344524", name: "الإنسانية" })],
    registryHits(registryPharmacy(), reference(), "name"),
  );
  assert.equal(folded.length, 1, "the same distributor's own code twice is one row, not two");
  assert.equal(folded[0]?.origin, "database", "the directory row survives — it is the one with sales behind it");
  assert.equal(
    folded[0]?.phoenixPharmacyCode,
    "DOP-000079",
    "…and it must absorb the Phoenix code, or a registered venue reads as unregistered",
  );

  // A registry code no directory row carries is a real extra result, not a duplicate.
  const notFolded = foldRegistryIntoDirectory(
    [hit({ customerCode: "999", distributorCode: "IS", id: "IS:999", name: "الإنسانية" })],
    registryHits(registryPharmacy(), reference(), "name"),
  );
  assert.equal(notFolded.length, 2, "a different code is a different catalogue entry and must survive");

  // A code-less registry hit can never be folded away — there is no pair to match it on.
  const codelessSurvives = foldRegistryIntoDirectory(
    [hit({ customerCode: "344524", distributorCode: "IS", id: "IS:344524", name: "الإنسانية" })],
    registryHits(registryPharmacy({ codes: [] }), reference(), "name"),
  );
  assert.equal(codelessSurvives.length, 2, "a venue with no distributor code has no pair to fold on and must survive");

  // ── Registry and directory collapse together, not into separate lists ─────
  // 40 of the 53 active registrations are ALSO in the directory at the same brick (production,
  // 2026-09-08). Without a shared collapse the fourth branch would double three quarters of its
  // own results — the screen would answer the owner twice for the same pharmacy.
  const bothSources = collapseByPharmacy([
    hit({ customerCode: "1", distributorCode: "PS", id: "PS:1", name: "الإنسانية" }),
    ...registryHits(registryPharmacy({ brickId: "B4-58" }), reference(), "name").map((entry) => ({
      ...entry,
      territory: hit().territory,
    })),
  ]);
  assert.equal(bothSources.length, 1, "one physical pharmacy in both tables must collapse to one row");
  assert.equal(bothSources[0]?.origin, "database", "the directory row wins the tie — its profile assembles fully");
  assert.equal(
    bothSources[0]?.phoenixPharmacyCode,
    "DOP-000079",
    "the survivor must carry the Phoenix code across the collapse, whichever side won",
  );
  assert.equal(bothSources[0]?.distributorCount, 2, "both distributors must still be counted");
  // The directory row leading must not cost the registry's facts. Preferring one row is about
  // which identity leads, not about which side's information survives — and the address rule must
  // never be able to promote the registry row instead, which is a different answer entirely.
  assert.equal(
    bothSources[0]?.address,
    "الزقازيق",
    "the survivor must absorb the address from whichever side has one, without changing which row won",
  );

  // The reverse order must give the same answer — a collapse whose result depends on which branch
  // returned first is a collapse that reports a different pharmacy on a slow day.
  const reversed = collapseByPharmacy([
    ...registryHits(registryPharmacy({ brickId: "B4-58" }), reference(), "name").map((entry) => ({
      ...entry,
      territory: hit().territory,
    })),
    hit({ customerCode: "1", distributorCode: "PS", id: "PS:1", name: "الإنسانية" }),
  ]);
  assert.equal(reversed.length, 1);
  assert.equal(reversed[0]?.origin, "database", "the directory row wins regardless of arrival order");
  assert.equal(reversed[0]?.phoenixPharmacyCode, "DOP-000079", "…and the Phoenix code survives either way");

  // ── ...but the brick still decides identity, and it cuts both ways here ───
  // DOP-000079 sits in B211-3 (Zagazig) while the directory holds two pharmacies also called
  // الإنسانية in B11-10 and B114-87 — different bricks, different pharmacies. "الإسعاف" is worse:
  // registered once, and present in TWENTY separate directory bricks. Merging on name would
  // report one pharmacy where there are twenty.
  const differentBricks = collapseByPharmacy([
    hit({ customerCode: "1", distributorCode: "PS", id: "PS:1", name: "الإنسانية" }),
    ...registryHits(registryPharmacy(), reference(), "name"),
  ]);
  assert.equal(
    differentBricks.length,
    2,
    "a registered venue in one brick and a same-named directory pharmacy in another are two "
      + "pharmacies — the registry must not buy an exemption from the rule that governs the rest",
  );

  // ── "1 distributor" beside a blank distributor name is a lie the reader cannot check ──
  // Every active directory row carries a distributor code (67,233 of 67,233, production
  // 2026-09-08), so dropping the floor of 1 cannot make one of those read 0 — but a venue no
  // distributor has a code for genuinely has none, and saying so is the honest answer.
  const codelessCollapsed = collapseByPharmacy(registryHits(registryPharmacy({ codes: [] }), reference(), "name"));
  assert.equal(codelessCollapsed.length, 1);
  assert.equal(
    codelessCollapsed[0]?.distributorCount,
    0,
    "a venue with no distributor code must count zero of them, not be floored up to one",
  );
  assert.equal(
    collapseByPharmacy([hit()])[0]?.distributorCount,
    1,
    "a directory row still counts its own distributor — dropping the floor must not cost the normal case",
  );

  // ── A registry venue must not inherit another pharmacy's codes, or its SALES ──
  // `loadSiblingRows` answers "same name", which for a directory-backed profile IS the question —
  // the rows describe one customer under several distributors. For a registry venue it is not: a
  // sibling is a different pharmacy spelt the same, and 10 of the 54 active venues have an
  // exact-name twin in another brick (production, 2026-09-08). Measured before the fix:
  // DOP-000038 "المنصورية" (brick B160-6, and it holds NO distributor code of its own) served
  // three Ibn Sina codes and two sales periods belonging to a pharmacy in B193-6. Nothing about
  // that reads as wrong on screen — it is an ordinary-looking sales history against a real venue.
  const venue = { row: { brick_id: "B160-6" } };
  const rows = [
    { brick_id: "B160-6", customer_code: "1", distributor_code: "IS" },
    { brick_id: "B193-6", customer_code: "416005", distributor_code: "IS" },
    { brick_id: null, customer_code: "9", distributor_code: "PS" },
  ];

  assert.deepEqual(
    sameVenueSiblings(rows, venue).map((row) => row.customer_code),
    ["1"],
    "only a sibling in the venue's OWN brick is the same pharmacy — a same-named row in another "
      + "brick hands this venue that pharmacy's codes, and through loadSales its sales",
  );

  // A venue with no brick has nothing to agree with, so nothing can be shown to be the same
  // pharmacy. Widening on the name alone there is precisely the guess this refuses to make.
  assert.deepEqual(sameVenueSiblings(rows, { row: { brick_id: null } }), []);
  assert.deepEqual(sameVenueSiblings(rows, { row: { brick_id: "   " } }), [], "a blank brick is no brick");

  // The directory path is untouched: siblings there are one customer under several distributors,
  // which is exactly what the profile is for. Narrowing it would drop real distributor codes.
  assert.equal(
    sameVenueSiblings(rows, null).length,
    3,
    "a directory-backed profile must still widen across every distributor carrying the name",
  );

  // ── The registry must be consulted BEFORE the bare-name fallback ──────────
  // Same defect, earlier: with `name` sent — which is what the workspace sends — the name lookup
  // resolved DOP-000038 to the B193-6 pharmacy and labelled the profile `database`, so the reader
  // opened a venue in one brick and was shown another. The code lookup still runs first, so a
  // venue the directory can answer for keeps resolving to its directory row.
  {
    const source = stripComments(
      readFileSync(fileURLToPath(new URL("../src/lib/pharmacy-search/profile.ts", import.meta.url)), "utf8"),
    );
    const registryAt = source.indexOf("request.phoenixPharmacyCode");
    const nameFallbackAt = source.indexOf("await loadSiblingRows(request.name,");
    const codeLookupAt = source.indexOf('.eq("distributor_code", request.distributorCode)');
    assert.ok(
      registryAt !== -1 && nameFallbackAt !== -1 && codeLookupAt !== -1,
      "could not locate the three resolution steps — this test is measuring nothing until it can",
    );
    assert.ok(
      codeLookupAt < registryAt,
      "the distributor code lookup must stay first — a venue the directory can answer for belongs "
        + "on its directory row, which is the one with sales behind it",
    );
    assert.ok(
      registryAt < nameFallbackAt,
      "the registry must be resolved BEFORE the bare-name fallback — a caller naming a Phoenix "
        + "venue is naming the subject, and an exact-name twin in another brick is a different "
        + "pharmacy, not a better match",
    );
  }

  // ── The `phoenix:` id prefix is spelled in three files ────────────────────
  // A registered venue's profile is fetched by its own code, not by distributor+customer, so the
  // id carries the code. A typo in any of the three spellings fails SILENTLY — the id simply stops
  // being recognised and the profile renders as an ordinary directory row, saying nothing.
  assert.equal(phoenixCodeFromProfileId(`${PHOENIX_PROFILE_ID_PREFIX}DOP-000079`), "DOP-000079");
  assert.equal(phoenixCodeFromProfileId("IS:344524"), null, "a directory id is not a Phoenix id");
  assert.equal(phoenixCodeFromProfileId("google:ChIJabc"), null, "nor is a Places id");
  assert.equal(phoenixCodeFromProfileId(PHOENIX_PROFILE_ID_PREFIX), null, "the bare prefix names no venue");
  assert.equal(phoenixCodeFromProfileId(null), null);
  assert.equal(phoenixCodeFromProfileId(undefined), null);

  // The id the search emits must be the one the profile panel can read back, or the chip is dead.
  assert.equal(
    phoenixCodeFromProfileId(registryHits(registryPharmacy({ codes: [] }), reference(), "name")[0]?.id ?? null),
    "DOP-000079",
    "a code-less registry hit's id must round-trip through the reader the panel uses",
  );

  // ── Ranking: an exact name must not sit below a 90-character one ───────────
  const ranked = rankHits(
    [
      hit({ id: "long", name: "الصيدلية الحديثة فرع مدينة نصر الجديدة بجوار المستشفى" }),
      hit({ id: "exact", name: "الصيدلية الحديثة" }),
    ],
    "الصيدليه الحديثه",
  );
  assert.equal(ranked[0].id, "exact", "the exact match must rank first");

  // ── The brick table is the authority, not the code on the mapping row ──────
  // `source_of_sales_bricks` is the branch→area authority; a mapping row's own area_code can lag
  // a brick that moved between areas. Reading the row's code first would report the old area.
  const stale = resolveTerritory(reference(), { areaCode: "MIN1", brickId: "B4-58", regionCode: "UE" });
  assert.equal(stale.areaName, "Heliopolis", "the brick's area must win over a stale code on the row");
  assert.equal(stale.regionName, "Cairo", "the brick's region must win too");
  assert.equal(stale.blockCode, "B4", "the block comes from the brick row");

  // An unknown brick id must not invent a territory — it degrades to codes only.
  const unknownBrick = resolveTerritory(reference(), { areaCode: "HEL", brickId: "B999-1", regionCode: "CA" });
  assert.equal(unknownBrick.brickName, null, "an unknown brick id has no name, and must not borrow one");
  assert.equal(unknownBrick.areaName, "Heliopolis", "the row's own area code still resolves");

  // Nothing in, nothing out — never a half-built territory that reads as real.
  const nothing = resolveTerritory(reference(), { areaCode: null, brickId: null, regionCode: null });
  assert.equal(nothing.brickId, null);
  assert.equal(nothing.areaName, null);
  assert.equal(nothing.regionName, null);

  // ── Distance maths ────────────────────────────────────────────────────────
  // The Heliopolis fixture: a doctor 0.19 km from a pharmacy must not read as 0 or as 19.
  const pharmacy = { latitude: 30.09, longitude: 31.33 };
  const doctor = { latitude: 30.0917, longitude: 31.3305 };
  const km = haversineKm(pharmacy, doctor);
  assert.ok(km > 0.15 && km < 0.25, `expected ~0.19 km, got ${km}`);
  assert.equal(haversineKm(pharmacy, pharmacy), 0, "a point is zero km from itself");
  assert.equal(roundKm(0.18999), 0.19);

  // ── The bounding box must be WIDER in longitude than in latitude ───────────
  // Degrees of longitude shrink towards the poles. A box that used the same delta for both would
  // clip doctors off its east and west edges — and they would simply never appear, with no error.
  const box = boundingBox(pharmacy, 2);
  const latSpan = box.maxLatitude - box.minLatitude;
  const lonSpan = box.maxLongitude - box.minLongitude;
  assert.ok(lonSpan > latSpan, "longitude span must widen with latitude, or the box clips east/west");
  assert.ok(
    haversineKm(pharmacy, { latitude: box.maxLatitude, longitude: pharmacy.longitude }) >= 1.99,
    "the box must fully contain the requested radius, not sit inside it",
  );
  assert.ok(
    haversineKm(pharmacy, { latitude: pharmacy.latitude, longitude: box.maxLongitude }) >= 1.99,
    "the longitude edge must reach the radius too",
  );

  // ── Null island is not a place ────────────────────────────────────────────
  // `0,0` is the sentinel a missing GPS fix leaves behind. Treating it as real puts a doctor in
  // the Gulf of Guinea and, worse, makes them "nearby" for any pharmacy also missing its fix.
  assert.equal(isUsablePoint(0, 0), false);
  assert.equal(isUsablePoint(null, 31.3), false);
  assert.equal(isUsablePoint(30.09, undefined), false);
  assert.equal(isUsablePoint(Number.NaN, 31.3), false);
  assert.equal(isUsablePoint(95, 31.3), false, "a latitude past the pole is not usable");
  assert.equal(isUsablePoint(30.09, 31.33), true);

  // ── Hospital detection covers the Arabic spellings actually in the data ────
  assert.ok(nearbyTestables.looksLikeHospital("مستشفى الزقازيق الجامعى"));
  assert.ok(nearbyTestables.looksLikeHospital("مستشفي مبره مصر القديمه"), "both ى and ي spellings occur");
  assert.ok(nearbyTestables.looksLikeHospital("معهد دمنهور الطبى"));
  assert.ok(nearbyTestables.looksLikeHospital("Cleopatra Hospital"));
  assert.ok(!nearbyTestables.looksLikeHospital("الصيدلية الحديثة"), "a pharmacy is not a hospital");
  assert.ok(!nearbyTestables.looksLikeHospital(null));

  // ── A hospital is not a doctor, and a pharmacy is neither ─────────────────
  // "مستشفي المطريه التعليمي" (speciality "Hospital", 50 visits) was returned as a DOCTOR 0.49 km
  // from the pharmacy, while the hospitals section — reading the customer map, which has no
  // coordinates — said "same brick" or nothing at all. The check-in is the only source that yields
  // a measured distance, so the classification decides whether the owner's "hospitals near it"
  // question gets a real answer or a shrug.
  //
  // The classification itself is NOT redefined here: contact-taxonomy.ts already holds the owner's
  // 2026-08-08 rule and 19.7% of the 14,451 CRM contacts turn on it. These assertions pin that this
  // module COMPOSES that one rather than keeping a second opinion.
  const { classifyContact } = nearbyTestables;
  for (const speciality of KNOWN_HOSPITAL_SPECIALITIES) {
    assert.equal(classifyContact(speciality), "hospital", `${speciality} names an institution, not a doctor`);
  }
  assert.equal(classifyContact("HOSPITAL"), "hospital", "the speciality string's casing must not decide this");
  assert.equal(classifyContact(" private   hospital "), "hospital", "nor must stray whitespace");

  // The hospital list must stay a strict SUBSET of the taxonomy's HCP list. If a hospital value is
  // ever added to one and not the other, a hospital silently becomes a doctor again.
  for (const speciality of KNOWN_HOSPITAL_SPECIALITIES) {
    assert.ok(
      KNOWN_HCP_SPECIALITIES.includes(speciality),
      `${speciality} is treated as a hospital but is not in the taxonomy's HCP list — the two have drifted`,
    );
    assert.equal(classifyCrmContactSpeciality(speciality), "hcp", `${speciality} must classify as HCP upstream`);
  }

  // Every OTHER HCP value is an account or a place we are not being asked about, and is dropped.
  for (const speciality of KNOWN_HCP_SPECIALITIES.filter((value) => !KNOWN_HOSPITAL_SPECIALITIES.includes(value))) {
    assert.equal(classifyContact(speciality), "other", `${speciality} is not a clinician and must not be listed as one`);
  }
  for (const speciality of KNOWN_SP_SPECIALITIES) {
    assert.equal(classifyContact(speciality), "doctor", `${speciality} is clinical and belongs in the doctors list`);
  }
  // An unclassified value stays a doctor — the same call Doctor Coverage makes ("an unknown
  // speciality is still scored"). "Dermatologist" and "Nephrology" are real production values the
  // taxonomy has not learned yet; dropping them would hide four real clinicians over a label.
  for (const speciality of ["Dermatologist", "Nephrology", null, "  "]) {
    assert.equal(
      classifyContact(speciality),
      "doctor",
      `an unclassified speciality (${speciality ?? "null"}) stays a doctor rather than vanishing`,
    );
  }

  // ── The same hospital arrives from three sources; the measured one must win ────
  // A hospital reaches us as a CRM contact with a real check-in distance, as a customer row in
  // this brick with NO coordinates, and sometimes from Google. Keeping whichever arrived first
  // would routinely replace "0.35 km away" with "somewhere in this brick" — strictly less
  // information, and it would look like a deliberate answer.
  const merged = mergeHospitals(
    [{ address: null, distanceKm: null, name: "مستشفى النور", origin: "database", proximity: "same_brick", speciality: null }],
    [{ address: "Nasr Rd", distanceKm: 0.35, name: "مستشفى النور", origin: "database", proximity: "checkin", speciality: "Hospital" }],
    [{ address: "Ring Rd", distanceKm: 1.2, name: "Cleopatra Hospital", origin: "google", proximity: "google", speciality: null }],
  );
  assert.equal(merged.length, 2, "the same hospital from two sources is ONE hospital");
  assert.equal(merged[0]?.name, "مستشفى النور", "a measured 0.35 km must sort ahead of a 1.2 km");
  assert.equal(merged[0]?.distanceKm, 0.35, "the entry that knows the distance must survive the merge");
  assert.equal(merged[0]?.proximity, "checkin", "…and it must keep saying HOW it knows");

  // An unmeasured hospital still belongs in the list — it just sorts last, never first.
  const unmeasuredLast = mergeHospitals(
    [{ address: null, distanceKm: null, name: "مستشفى بلا احداثيات", origin: "database", proximity: "same_brick", speciality: null }],
    [{ address: null, distanceKm: 4.9, name: "مستشفى بعيد", origin: "database", proximity: "checkin", speciality: "Hospital" }],
  );
  assert.deepEqual(
    unmeasuredLast.map((entry) => entry.name),
    ["مستشفى بعيد", "مستشفى بلا احداثيات"],
    "a hospital with no coordinates sorts last rather than being dropped or floated to the top",
  );

  // ── The write path must never touch sales attribution ─────────────────────
  // The owner chose "show, plus a Save button you press". The danger that decision guards against
  // is a Google-derived brick reaching source_of_sales_customer_map, where it would silently
  // change which area is credited for real sales. Enforced by reading the file: the save module
  // must not name that table at all.
  // Comments are stripped first: save.ts explains at length WHY it stays away from that table,
  // and an explanation must not be mistaken for the thing it warns against.
  const saveSource = stripComments(
    readFileSync(fileURLToPath(new URL("../src/lib/pharmacy-search/save.ts", import.meta.url)), "utf8"),
  );
  assert.ok(
    !/source_of_sales_customer_map/.test(saveSource),
    "save.ts must never write to source_of_sales_customer_map — a Google-derived brick there " +
      "would move sales attribution. Discoveries belong in pharmacy_search_discoveries.",
  );
  assert.ok(
    /pharmacy_search_discoveries/.test(saveSource),
    "save.ts must write discoveries to their own register",
  );
  assert.ok(
    /writeAuditLog/.test(saveSource),
    "every save must leave an audit row — this is a human-initiated write to production data",
  );

  // ── `origin` drives behaviour, so a fourth value must not open the write path ──
  // Adding "phoenix" to PharmacySearchOrigin widens a union that `saveDiscoveredPharmacy` reads
  // to decide whether a profile may be written at all. It must stay an ALLOW-list of exactly
  // "google": a `!== "database"` style test would have let a registered venue be written into the
  // Google discovery register, inventing a second identity for a pharmacy that already has one.
  assert.ok(
    /profile\.origin !== "google"/.test(saveSource),
    'saveDiscoveredPharmacy must gate on origin being exactly "google" — a deny-list would admit '
      + "every origin added later, starting with the Phoenix registry",
  );

  // ── The fourth search branch must actually read the registry ──────────────
  // The search module is the only place that can answer "is this pharmacy in Phoenix at all".
  // If this read is ever removed, every assertion above still passes on fixtures while the
  // screen goes back to reporting a registered pharmacy as absent.
  const searchSource = stripComments(
    readFileSync(fileURLToPath(new URL("../src/lib/pharmacy-search/search.ts", import.meta.url)), "utf8"),
  );
  assert.match(
    searchSource,
    /\.from\("direct_order_pharmacies"\)/,
    "search.ts must read direct_order_pharmacies — searching only the distributor directory is "
      + "the defect this branch exists to fix",
  );
  assert.match(
    searchSource,
    /\.from\("direct_order_pharmacy_distributor_codes"\)/,
    "…and its distributor codes, or a rep holding a distributor's code for a registered venue "
      + "cannot find it",
  );
  assert.ok(
    !/\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(searchSource),
    "search.ts is read-only — a search box must never write, least of all to the registry",
  );
  for (const [label, source] of [["search.ts", searchSource], ["profile.ts", null]] as const) {
    const text = source ?? stripComments(
      readFileSync(fileURLToPath(new URL("../src/lib/pharmacy-search/profile.ts", import.meta.url)), "utf8"),
    );
    assert.ok(
      !/["'`]phoenix:/.test(text),
      `${label} must build the id from PHOENIX_PROFILE_ID_PREFIX, never a literal — a typo in one `
        + "of the three spellings is invisible: the id stops being recognised and the profile "
        + "quietly renders as an ordinary directory row",
    );
  }

  // The profile must be able to resolve a registry-only venue. Without this a Phoenix-only hit is
  // listed by the search and then answers PharmacyNotFoundError when clicked, which on screen
  // reads as "this pharmacy does not exist" about one the box just offered.
  const profileSource = stripComments(
    readFileSync(fileURLToPath(new URL("../src/lib/pharmacy-search/profile.ts", import.meta.url)), "utf8"),
  );
  assert.match(
    profileSource,
    /\.from\("direct_order_pharmacies"\)/,
    "profile.ts must fall back to the registry, or every Phoenix-only search hit is unopenable",
  );
  assert.match(
    profileSource,
    /origin: registry \? "phoenix" : "database"/,
    "a registry-backed profile must say so — it has no distributor sales behind it and the reader "
      + "must not read an empty sales section as a pharmacy that buys nothing",
  );

  // The profile panel must say WHICH database a record came from. A registered venue IS in the
  // database, so the plain "In the Phoenix database" chip is not wrong — it is silent about the
  // one thing the reader needs: this record came from the direct-order desk, its codes are what
  // somebody typed, and it may have no sales history at all.
  const panelSource = readFileSync(
    fileURLToPath(new URL("../src/components/pharmacy-search/pharmacy-profile-panel.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(
    panelSource,
    /profile\.origin === "phoenix"/,
    "the profile panel must handle the phoenix origin as a THIRD state — falling through to the "
      + "generic chip loses the distinction the whole branch exists to draw",
  );
  assert.match(
    panelSource,
    /phoenixCodeFromProfileId\(profile\.id\)/,
    "…and read the DOP code back out of the id, rather than re-deriving the prefix by hand",
  );

  // The route has to pass the code through, or the fallback above is unreachable from the browser.
  const profileRouteSource = readFileSync(
    fileURLToPath(new URL("../app/api/admin/pharmacy-search/profile/route.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    profileRouteSource,
    /phoenixPharmacyCode: params\.get\("phoenix"\)/,
    "the profile route must forward the Phoenix code — the registry fallback is dead code without it",
  );

  // The save ROUTE must rebuild the profile server-side from the place id rather than trusting a
  // posted profile, or a caller could write any brick they liked into the register.
  const saveRouteSource = readFileSync(
    fileURLToPath(new URL("../app/api/admin/pharmacy-search/save/route.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    /loadExternalPharmacyProfile/.test(saveRouteSource),
    "the save route must rebuild the profile from the place id, never trust a posted one",
  );
  assert.ok(
    /assertPharmacySearchAccess/.test(saveRouteSource),
    "the save route must assert permission before it writes — the page gate is UX, this is the boundary",
  );
  assert.ok(
    /assertSameOriginMutation\(request\)/.test(saveRouteSource),
    "the save route is a mutation that also spends a billed Google call — it must reject a cross-site POST",
  );

  // ── Every route asserts access ────────────────────────────────────────────
  // Server-side access control is the security boundary here; a route that forgot the assert
  // would serve the whole customer estate to any signed-in employee.
  for (const route of ["route.ts", "profile/route.ts", "external/route.ts", "save/route.ts"]) {
    const source = readFileSync(
      fileURLToPath(new URL(`../app/api/admin/pharmacy-search/${route}`, import.meta.url)),
      "utf8",
    );
    assert.match(
      source,
      /assertPharmacySearchAccess/,
      `app/api/admin/pharmacy-search/${route} must call assertPharmacySearchAccess before it reads or writes`,
    );
  }

  // ── CRM data comes through the one door ───────────────────────────────────
  // src/lib/crm/reads.ts is the single door onto the iReports360 mirror; nothing outside
  // src/lib/crm/ may query those tables itself (tests/crm-single-source.test.ts enforces that
  // repo-wide). This pins the pharmacy-search side of it specifically, because the temptation to
  // hand-roll one convenient proximity query is exactly how that invariant erodes.
  const nearbySource = readFileSync(
    fileURLToPath(new URL("../src/lib/pharmacy-search/nearby.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    nearbySource,
    /import \{[^}]*queryCheckins[^}]*\} from "@\/lib\/crm\/reads"/,
    "nearby.ts must read check-ins through crm/reads.ts, not from the mirror table directly",
  );
  assert.ok(
    !/\.from\(\s*["'`]ireports360_/.test(stripComments(nearbySource)),
    "nearby.ts must never name an ireports360_ table in a .from() — that is what the door is for",
  );

  // The door has to actually carry a geographic filter, or the only way to write this feature is
  // to bypass it. All four edges must be applied: dropping one silently returns a half-plane of
  // check-ins rather than a box, which reads downstream as "doctors much further away than asked".
  const readsSource = readFileSync(
    fileURLToPath(new URL("../src/lib/crm/reads.ts", import.meta.url)),
    "utf8",
  );
  assert.match(readsSource, /bounds\?: \{/, "CrmCheckinFilter must expose a bounding-box filter");
  for (const edge of [
    /\.gte\("lat", filter\.bounds\.minLatitude\)/,
    /\.lte\("lat", filter\.bounds\.maxLatitude\)/,
    /\.gte\("lon", filter\.bounds\.minLongitude\)/,
    /\.lte\("lon", filter\.bounds\.maxLongitude\)/,
  ]) {
    assert.match(readsSource, edge, `the check-in bounding box must apply every edge (${edge.source})`);
  }

  // ── A cleared search box must not leave the spinner running ───────────────
  // The effect deliberately resets no state when the query gets too short (setState inside an
  // effect body cascades renders and is a lint error here), so what hides the previous answer is
  // this derivation. Drop the `!queryTooShort` guard and a search in flight when the box is
  // cleared leaves "Searching the customer database…" on screen forever.
  const workspaceSource = readFileSync(
    fileURLToPath(new URL("../src/components/pharmacy-search/pharmacy-search-workspace.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(
    workspaceSource,
    /const isSearching = searching && !queryTooShort;/,
    "the spinner must be gated on the query still being long enough, not on `searching` alone",
  );
  assert.match(
    workspaceSource,
    /const visibleResults = queryTooShort \? null : results;/,
    "results must be hidden by derivation when the query gets too short, not by resetting state",
  );

  // ── Desktop tables, mobile cards (AGENTS.md §4) ───────────────────────────
  // "Admin shell: desktop shows full tables/dashboards, mobile never does — mobile gets cards."
  // Both files render tables; both must therefore route them through the responsive primitive.
  for (const name of ["pharmacy-search-workspace.tsx", "pharmacy-profile-panel.tsx"]) {
    const source = readFileSync(
      fileURLToPath(new URL(`../src/components/pharmacy-search/${name}`, import.meta.url)),
      "utf8",
    );
    assert.match(
      source,
      /\bPortalResponsiveDataList\b/,
      `src/components/pharmacy-search/${name} must render rows through <PortalResponsiveDataList> ` +
        "so a phone gets cards instead of a sideways-scrolling table",
    );
    assert.ok(
      !/<table[\s>]/.test(stripComments(source)),
      `src/components/pharmacy-search/${name} must not hand-roll a <table> — <PortalDesktopTable> ` +
        "carries the md: gate that keeps it off a phone",
    );
  }

  // ── A code on a phone must say whose code it is ───────────────────────────
  // The desktop results table has carried Distributor and Code as adjacent columns from the
  // start. The card shipped with four fields — brick, area, region, code — so a phone showed
  // `0001559807` with nothing saying it was Ibn sina's number for that pharmacy. Sliced to the
  // card renderer specifically: the desktop table below it must not be what satisfies this.
  {
    const source = readFileSync(
      fileURLToPath(new URL("../src/components/pharmacy-search/pharmacy-search-workspace.tsx", import.meta.url)),
      "utf8",
    );
    const cardStart = source.indexOf("renderCard=");
    const cardEnd = source.indexOf("renderTable=", cardStart);
    assert.ok(
      cardStart !== -1 && cardEnd > cardStart,
      "could not isolate the mobile card renderer — this test is measuring nothing until it can",
    );
    const card = source.slice(cardStart, cardEnd);

    assert.match(
      card,
      /label:\s*"Distributor"/,
      "the mobile result card must name the distributor — a bare customer code with no owner "
        + "cannot be acted on, and desktop has always shown both",
    );
    assert.ok(
      card.includes("hit.distributorName"),
      "the card's Distributor field must read the real distributor name off the hit, not a literal",
    );
    assert.ok(
      card.indexOf('label: "Distributor"') < card.indexOf('label: "Code"'),
      "the distributor must sit immediately before its code, so the pair reads as one fact",
    );

    // A registered venue with no distributor code has "—" for both fields above. Without a field
    // of its own the card would show a pharmacy with nothing at all saying where it came from.
    assert.match(
      card,
      /label:\s*"Phoenix"/,
      "the mobile card must carry the Phoenix registry code — for a venue no distributor has a "
        + "code for it is the only identifier the card can show",
    );
  }

  // ── The Google lookup must not be offered for a pharmacy we registered ourselves ──
  // A billed Places call, spent to be told about DOP-000079 four hours after someone typed it in
  // by hand. The prompt is gated on `isEmpty`, so what protects the owner is that a Phoenix-only
  // hit lands in `hits` and makes `isEmpty` false — nothing in the component knows about origins.
  {
    const source = readFileSync(
      fileURLToPath(new URL("../src/components/pharmacy-search/pharmacy-search-workspace.tsx", import.meta.url)),
      "utf8",
    );

    assert.match(
      source,
      /Boolean\(visibleResults\?\.isEmpty\)/,
      "the Google prompt must stay gated on isEmpty — a Phoenix-only hit makes it false and that "
        + "is what stops the billed Places call",
    );
    assert.match(
      source,
      /params\.set\("phoenix", hit\.phoenixPharmacyCode\)/,
      "opening a hit must carry its Phoenix code to the profile route, or a registered venue is "
        + "listed and then unopenable",
    );
    assert.ok(
      !/hit\.origin === "phoenix"[^\n]*params\.set\("phoenix"/.test(source),
      "the Phoenix code must be sent for ANY hit that has one, not only a phoenix-origin row — a "
        + "venue in both tables collapses to a database hit and still needs the fallback",
    );
    assert.match(
      source,
      /distributorSummary\(hit\.distributorCount\)/,
      'the card must route the count through the helper — "0 distributors" is not what a venue '
        + "with no distributor code should say",
    );
  }

  // ── Same defect, second instance ──────────────────────────────────────────
  // The distributor-codes card on the profile page carried Brick but not Area, so a phone
  // answered two thirds of "brick, area and region" — the first thing this page exists for.
  // Sliced to that one section, so neither the results table nor the other three card
  // renderers in the same file can be what satisfies it.
  {
    const source = readFileSync(
      fileURLToPath(new URL("../src/components/pharmacy-search/pharmacy-profile-panel.tsx", import.meta.url)),
      "utf8",
    );
    const section = source.indexOf("Distributor codes (");
    const cardStart = source.indexOf("renderCard=", section);
    const cardEnd = source.indexOf("renderTable=", cardStart);
    assert.ok(
      section !== -1 && cardStart > section && cardEnd > cardStart,
      "could not isolate the distributor-codes card — this test is measuring nothing until it can",
    );
    const card = source.slice(cardStart, cardEnd);

    for (const field of ["Brick", "Area"]) {
      assert.ok(
        card.includes(`label: "${field}"`),
        `the distributor-codes card must show ${field} on a phone — brick, area and region are the `
          + "first thing this page answers, and the desktop table has always carried it",
      );
    }
  }

  // ── A retired brick id must never win the snap ─────────────────────────────
  // `geo_locations` holds 1,142 brick_centroid pins for 700 real bricks: every centroid is
  // pinned twice, once under a retired brick vocabulary and once under the current one, at the
  // same coordinates. They therefore tie at EXACTLY the same distance, and the loop keeps
  // whichever it met first — so which id won was decided by row order, with no ORDER BY.
  //
  // Measured on production 2026-09-08: a pharmacy in شرويدة (Zagazig) snapped to `B95-6`, which
  // is in no brick table, at 1.72 km — the identical distance to `B211-3` الزقازيق, the live
  // brick for that point. The saved discovery came out with brick_id set and area_code and
  // region_code NULL, which reads as a mapped row until you try to use it.
  {
    const point = { latitude: 30.5768429, longitude: 31.4861073 };
    const centroid = { latitude: 30.5629, longitude: 31.4952 };
    const live = new Set(["B211-3", "B211-4"]);

    // The retired pin is FIRST, so a picker without the live-brick rule keeps it and this fails.
    const tie = pickNearestBrick({
      isLiveBrick: (brickId) => live.has(brickId),
      pins: [
        { brickId: "B95-6", ...centroid },
        { brickId: "B211-3", ...centroid },
      ],
      point,
    });
    assert.equal(
      tie?.brickId,
      "B211-3",
      "a retired brick id tying at the same centroid must lose to the live brick — snapping to a "
        + "brick the brick table does not know yields a discovery with no area and no region",
    );

    // Closer is not a reason. A retired id sitting exactly on the point still must not win.
    const closer = pickNearestBrick({
      isLiveBrick: (brickId) => live.has(brickId),
      pins: [
        { brickId: "B95-6", ...point },
        { brickId: "B211-4", latitude: 30.6205, longitude: 31.5310 },
      ],
      point,
    });
    assert.equal(
      closer?.brickId,
      "B211-4",
      "even a retired brick sitting on the point must lose — distance cannot buy back an id that "
        + "resolves to nothing",
    );

    // Nothing live in range beats a wrong answer: the caller renders "area and region unknown".
    const noneLive = pickNearestBrick({
      isLiveBrick: (brickId) => live.has(brickId),
      pins: [{ brickId: "B95-6", ...centroid }],
      point,
    });
    assert.equal(noneLive, null, "with no live brick in range the snap must return null, never a retired id");

    // The predicate the caller actually passes is the brick table itself, so a brick the
    // reference holds must still be pickable — otherwise the filter would snap nothing at all.
    const viaReference = pickNearestBrick({
      isLiveBrick: (brickId) => reference().bricks.has(brickId),
      pins: [
        { brickId: "B999-1", ...centroid },
        { brickId: "B4-58", ...centroid },
      ],
      point,
    });
    assert.equal(
      viaReference?.brickId,
      "B4-58",
      "the live-brick test must be satisfied by the territory reference's own brick map",
    );
    assert.ok(MAX_BRICK_SNAP_KM > 0, "the snap ceiling must stay a real distance");
  }

  // ── El Qema leaves this screen for everyone but Super Admin, the CEO included ──
  // Owner, 2026-11-01. As the SFE Manager, searching its name returned 60 of its customers.
  {
    const superAdmin = { role: "Super Admin", scope: "system" } as const;
    const hiddenFrom = [
      { role: "CEO", scope: "company" },
      { role: "SFE Manager", scope: "company" },
    ] as const;

    const withElQema: TerritoryReference = {
      ...reference(),
      distributorNames: new Map([
        ["IS", "Ibn sina"],
        ["QM", "El Qema"],
      ]),
    };
    const code = (distributorCode: string) => ({
      customerCode: "1001",
      distributorCode,
      distributorName: distributorCode,
      fromReferenceList: true,
      territory: resolveTerritory(reference(), {}),
    });
    type FakeQuery = { applied: string[]; or(filters: string): FakeQuery };
    const fakeQuery = (): FakeQuery => {
      const query: FakeQuery = {
        applied: [],
        or(filters) {
          query.applied.push(filters);
          return query;
        },
      };
      return query;
    };

    assert.equal(
      visibleTerritoryReference(withElQema, superAdmin).distributorNames.get("QM"),
      "El Qema",
      "Super Admin keeps the name",
    );
    assert.equal(visibleDistributorRows(fakeQuery(), superAdmin).applied.length, 0, "Super Admin reads every row");
    assert.deepEqual(
      withoutHiddenReferenceCodes([code("El Qema")], withElQema, superAdmin).map((entry) => entry.distributorCode),
      ["El Qema"],
      "Super Admin keeps the reference row",
    );

    for (const viewer of hiddenFrom) {
      const names = visibleTerritoryReference(withElQema, viewer).distributorNames;
      assert.equal(names.has("QM"), false, `${viewer.role}: typing the name must not list its customers`);
      assert.equal(names.get("IS"), "Ibn sina", `${viewer.role}: other distributors stay`);
      assert.equal(withElQema.distributorNames.has("QM"), true, "the shared cached reference must never be edited");

      // A row with no distributor names nobody, and `not.in` alone would silently drop it.
      assert.deepEqual(
        visibleDistributorRows(fakeQuery(), viewer).applied,
        ['distributor_code.is.null,distributor_code.not.in.("QM")'],
        `${viewer.role}: the read must leave El Qema's rows out at the query`,
      );

      // The reference list carries the name as typed and no code, so this is the only way to know.
      assert.deepEqual(
        withoutHiddenReferenceCodes(
          [code("El Qema"), code("el qema "), code("QM"), code("Ibn sina")],
          withElQema,
          viewer,
        ).map((entry) => entry.distributorCode),
        ["Ibn sina"],
        `${viewer.role}: the reference list must not name El Qema, in any case`,
      );
    }

    // Every read of a table holding El Qema's rows must go through the filter. A new one that does
    // not fails here, instead of quietly putting its customers back on the screen.
    const tables = '"(?:source_of_sales_customer_map|direct_order_pharmacy_distributor_codes)"';
    for (const file of ["search.ts", "profile.ts", "nearby.ts"]) {
      const source = stripComments(
        readFileSync(fileURLToPath(new URL(`../src/lib/pharmacy-search/${file}`, import.meta.url)), "utf8"),
      );
      const reads = source.match(new RegExp(`\\.from\\(\\s*${tables}`, "g"))?.length ?? 0;
      const filtered =
        source.match(new RegExp(`visibleDistributorRows\\(\\s*supabase\\s*\\.from\\(\\s*${tables}`, "g"))?.length ?? 0;
      assert.ok(reads > 0, `${file} must still read these tables, or this check has gone stale`);
      assert.equal(filtered, reads, `${file}: every read of a distributor's rows must go through visibleDistributorRows`);
    }
  }
}
