import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  classifyCrmContactSpeciality,
  KNOWN_HCP_SPECIALITIES,
  KNOWN_HOSPITAL_SPECIALITIES,
  KNOWN_SP_SPECIALITIES,
} from "../src/lib/crm/contact-taxonomy.ts";
import { boundingBox, haversineKm, isUsablePoint, roundKm } from "../src/lib/pharmacy-search/geo.ts";
import { mergeHospitals, __testables as nearbyTestables } from "../src/lib/pharmacy-search/nearby.ts";
import { resolveTerritory, type TerritoryReference } from "../src/lib/pharmacy-search/reference.ts";
import { __testables as searchTestables } from "../src/lib/pharmacy-search/search.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Pharmacy Search — the search box that answers "where is this pharmacy" from our own tables and,
// when they have never heard of it, from Google.
//
// What is pinned here is the handful of decisions that are silently wrong rather than loudly
// wrong: a PostgREST filter that a comma turns into a different query, a bounding box that clips
// doctors off its east and west edges, a territory that reads the stale code on a mapping row
// instead of the brick table, and a Google-derived brick presented as if it were a mapping.
// ─────────────────────────────────────────────────────────────────────────────

const { collapseByPharmacy, looksLikeCode, rankHits, sanitizeForOrFilter } = searchTestables;

/** Source-scanning assertions read CODE, never prose — a comment explaining a rule is not a breach. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function reference(): TerritoryReference {
  return {
    areaNames: new Map([
      ["HEL", "Heliopolis"],
      ["MIN1", "Minia 1"],
    ]),
    bricks: new Map([
      ["B4-58", { areaCode: "HEL", blockCode: "B4", brickId: "B4-58", brickName: "ارض الجولف", regionCode: "CA" }],
      ["B129-41", { areaCode: "MIN1", blockCode: "B129", brickId: "B129-41", brickName: "مغاغه", regionCode: "UE" }],
    ]),
    distributorNames: new Map([
      ["IS", "Ibn sina"],
      ["PS", "overseas"],
    ]),
    regionNames: new Map([
      ["CA", "Cairo"],
      ["UE", "Upper Egypt"],
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
      !/<table[\s>]/.test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
      `src/components/pharmacy-search/${name} must not hand-roll a <table> — <PortalDesktopTable> ` +
        "carries the md: gate that keeps it off a phone",
    );
  }
}
