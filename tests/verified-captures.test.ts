import assert from "node:assert/strict";

import {
  ALL,
  EMPTY_CAPTURE_FILTER,
  applyCaptureFilter,
  cairoMonthKey,
  distinctMonths,
  distinctPeople,
  distinctValues,
  matchesCaptureFilter,
  type FilterableCapture,
} from "../src/lib/verified-captures/filters.ts";
import {
  buildCaptureLocation,
  extractGovernorate,
  parseCapturedAddress,
} from "../src/lib/verified-captures/location.ts";
import { canOpenVerifiedCaptures } from "../src/lib/verified-captures/access.ts";
import type { PhoenixRole } from "../src/lib/auth/permissions.ts";

// The Verified Captures gallery is the Super Admin AND the SFE Manager (owner, 2026-09-24, then
// widened 2026-09-29 when the photo-vs-location readout landed on it), and the rep/DM/search
// filter is the interaction the owner asked for by name ("filter by rep or by district manager").
// These are the two pieces worth pinning: the gate must not widen, and the filter must select the
// right rows. Both are pure, so they test without a database or a DOM.

const ROWS: FilterableCapture[] = [
  {
    repHrId: "B-20",
    repName: "Mona Adel",
    managerHrId: "B-05",
    managerName: "Karim Fouad",
    searchText: "El Nasr Pharmacy · Cairo · 12 Tahrir St",
  },
  {
    repHrId: "B-21",
    repName: "Ahmed Sami",
    managerHrId: "B-05",
    managerName: "Karim Fouad",
    searchText: "Shifa Pharmacy · Giza",
  },
  {
    repHrId: "B-20",
    repName: "Mona Adel",
    managerHrId: "B-06",
    managerName: "Hala Nabil",
    searchText: "Rowad Pharmacy · Alexandria",
  },
  // A capture whose rep the employees table has not named: still filterable, labelled by id.
  {
    repHrId: "B-99",
    repName: null,
    managerHrId: null,
    managerName: null,
    searchText: "Orphan Pharmacy",
  },
];

export function runVerifiedCapturesTests() {
  // ── The gate is the narrowest one there is ─────────────────────────────────
  assert.equal(
    canOpenVerifiedCaptures({ role: "Super Admin", scope: "self" }),
    true,
    "Super Admin opens the gallery",
  );
  assert.equal(
    canOpenVerifiedCaptures({ role: "Employee", scope: "system" }),
    true,
    "the system scope (Super Admin's own) opens it",
  );
  // WIDENED 2026-09-29, in the owner’s own words (“add the SFE Manager to verified captures”).
  // Golden rule #1 names the Super Admin and the SFE Manager as the two who may read an integrity
  // signal, and the photo-vs-location readout now lives on this page - so the gallery had been
  // sitting one notch tighter than its own content.
  assert.equal(
    canOpenVerifiedCaptures({ role: "SFE Manager", scope: "self" }),
    true,
    "the SFE Manager opens the gallery",
  );
  // The CEO stays OUT deliberately: he is not a reader of integrity signals under golden rule #1,
  // and nobody has asked for him. Each seat here is the owner’s own decision, one at a time.
  const deniedRoles: PhoenixRole[] = ["CEO", "District Manager", "Medical Rep", "Employee"];
  for (const role of deniedRoles) {
    assert.equal(
      canOpenVerifiedCaptures({ role, scope: "self" }),
      false,
      `${role} cannot open the gallery`,
    );
  }

  // ── distinctPeople: one option per person, sorted, id-labelled when unnamed ──
  const reps = distinctPeople(ROWS, "rep");
  assert.deepEqual(
    reps.map((option) => option.hrId),
    ["B-21", "B-20", "B-99"],
    "reps are distinct and sorted by name (Ahmed, Mona, then the id-only B-99)",
  );
  assert.equal(reps.find((option) => option.hrId === "B-99")?.name, "B-99", "an unnamed rep is labelled by id");

  const managers = distinctPeople(ROWS, "manager");
  assert.deepEqual(
    managers.map((option) => option.hrId),
    ["B-06", "B-05"],
    "managers are distinct and sorted by name (Hala, then Karim)",
  );

  // ── The empty filter matches everything ────────────────────────────────────
  assert.equal(applyCaptureFilter(ROWS, EMPTY_CAPTURE_FILTER).length, ROWS.length, "no filter shows every row");

  // ── Rep filter ─────────────────────────────────────────────────────────────
  const monaOnly = applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, rep: "B-20" });
  assert.equal(monaOnly.length, 2, "Mona owns two captures");
  assert.ok(monaOnly.every((row) => row.repHrId === "B-20"));

  // ── District-manager filter ────────────────────────────────────────────────
  const karimOnly = applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, manager: "B-05" });
  assert.equal(karimOnly.length, 2, "Karim manages two captures");
  assert.ok(karimOnly.every((row) => row.managerHrId === "B-05"));

  // ── Rep AND manager together ───────────────────────────────────────────────
  const monaUnderKarim = applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, rep: "B-20", manager: "B-05" });
  assert.equal(monaUnderKarim.length, 1, "Mona's captures under Karim is exactly one");
  assert.equal(monaUnderKarim[0]?.searchText, "El Nasr Pharmacy · Cairo · 12 Tahrir St");

  // ── Search matches text, rep name and manager name, case-insensitively ──────
  assert.equal(applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, search: "alexandria" }).length, 1);
  assert.equal(applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, search: "PHARMACY" }).length, 4);
  assert.equal(
    applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, search: "ahmed" }).length,
    1,
    "search matches the rep's name, not only the row text",
  );
  assert.equal(
    applyCaptureFilter(ROWS, { ...EMPTY_CAPTURE_FILTER, search: "hala" }).length,
    1,
    "search matches the manager's name too",
  );

  // ── ALL is the no-filter sentinel, never a real id ─────────────────────────
  assert.equal(matchesCaptureFilter(ROWS[3], { rep: ALL, manager: ALL, search: "" }), true);
  assert.equal(
    matchesCaptureFilter(ROWS[3], { ...EMPTY_CAPTURE_FILTER, search: "no-such-text" }),
    false,
    "a non-matching search excludes the row",
  );

  runLocationParseTests();
  runGeographyAndDateFilterTests();
}

// ── Parsing one captured string into its parts (owner ask, 2026-09-25) ────────
function runLocationParseTests() {
  // A direct-order capture: Google address, then "· Brick/Area/Region <name>" tags.
  const direct = parseCapturedAddress(
    "H2G7+966, Qism Shebeen El-Kom, Shibin el Kom, Menofia Governorate 6132720, Egypt · Brick شبين الكوم · Area Menoufia 1 · Region Delta (1)",
  );
  assert.equal(direct.brick, "شبين الكوم", "brick is read from the tag");
  assert.equal(direct.area, "Menoufia 1", "area is read from the tag");
  assert.equal(direct.region, "Delta (1)", "region is read from the tag");
  assert.equal(direct.governorate, "Menofia Governorate", "governorate is read from the Google address");
  assert.ok(direct.cleanAddress?.endsWith("Egypt"), "the clean address has the tags stripped off");
  assert.ok(!direct.cleanAddress?.includes("Brick"), "no tag leaks into the clean address");

  // A marketing capture: plain reverse-geocode, no tags. Clean address = the whole string.
  const marketing = parseCapturedAddress(
    "XW45+PRF, 74 Al Jabal 17, 6th of October City (2), Giza Governorate 3231423, Egypt",
  );
  assert.equal(marketing.brick, null, "a plain capture has no brick");
  assert.equal(marketing.area, null, "a plain capture has no area tag");
  assert.equal(marketing.governorate, "Giza Governorate", "governorate still reads out of the address");
  assert.equal(
    marketing.cleanAddress,
    "XW45+PRF, 74 Al Jabal 17, 6th of October City (2), Giza Governorate 3231423, Egypt",
  );

  assert.deepEqual(parseCapturedAddress(null), {
    cleanAddress: null,
    brick: null,
    area: null,
    region: null,
    governorate: null,
  });
  assert.equal(extractGovernorate("12 Tahrir St, Cairo, Egypt"), null, "no governorate token → null");
  assert.equal(extractGovernorate("…, Cairo Governorate 4064104, Egypt"), "Cairo Governorate");

  // buildCaptureLocation keeps the raw verbatim and prefers parsed parts over the fallbacks.
  const built = buildCaptureLocation({
    latitude: 30.5,
    longitude: 31.0,
    capturedAddress: "Somewhere, Menofia Governorate 1, Egypt · Brick B · Area A · Region R",
    rawFallback: "rep typed this",
    area: "Fallback Area",
    governorate: "Fallback Gov",
  });
  assert.equal(built.rawLocation, "Somewhere, Menofia Governorate 1, Egypt · Brick B · Area A · Region R");
  assert.equal(built.brick, "B");
  assert.equal(built.area, "A", "the parsed area wins over the fallback");
  assert.equal(built.region, "R");
  assert.equal(built.governorate, "Fallback Gov", "a clean pre-resolved governorate wins over the scrape");
  assert.ok(!built.address?.includes("Brick"), "clean address drops the tags");

  // With no captured string, the raw falls back to the rep's own text and the code-resolved names.
  const fallback = buildCaptureLocation({
    latitude: null,
    longitude: null,
    capturedAddress: null,
    rawFallback: "طهطا عنيبس",
    brick: "Tahta brick",
    area: "Sohag1",
  });
  assert.equal(fallback.rawLocation, "طهطا عنيبس");
  assert.equal(fallback.address, "طهطا عنيبس");
  assert.equal(fallback.brick, "Tahta brick");
  assert.equal(fallback.area, "Sohag1");
}

// ── Geography, month and date-sort filters (owner ask, 2026-09-25) ────────────
function runGeographyAndDateFilterTests() {
  const GEO: FilterableCapture[] = [
    {
      repHrId: "B-1",
      repName: "Rep One",
      managerHrId: "M-1",
      managerName: "Mgr One",
      line: "Pedia",
      area: "Menoufia 1",
      brick: "شبين الكوم",
      region: "Delta (1)",
      sortDate: "2026-09-10T09:00:00Z",
    },
    {
      repHrId: "B-2",
      repName: "Rep Two",
      managerHrId: "M-1",
      managerName: "Mgr One",
      line: "CNS",
      area: "Cairo West",
      brick: "ش الكورنيش",
      region: "Cairo",
      sortDate: "2026-08-20T09:00:00Z",
    },
    {
      repHrId: "B-3",
      repName: "Rep Three",
      managerHrId: "M-2",
      managerName: "Mgr Two",
      line: "Pedia",
      area: "Menoufia 1",
      brick: null,
      region: "Delta (1)",
      sortDate: "2026-09-25T09:00:00Z",
    },
  ];

  assert.deepEqual(distinctValues(GEO, "line"), ["CNS", "Pedia"], "lines are distinct and sorted");
  assert.deepEqual(distinctValues(GEO, "area"), ["Cairo West", "Menoufia 1"], "areas are distinct and sorted");
  assert.deepEqual(distinctValues(GEO, "brick"), ["ش الكورنيش", "شبين الكوم"], "empty bricks are dropped");
  assert.deepEqual(distinctValues(GEO, "region"), ["Cairo", "Delta (1)"], "regions are distinct and sorted");

  assert.equal(cairoMonthKey("2026-09-10T09:00:00Z"), "2026-09", "Cairo month key of a September instant");
  assert.deepEqual(
    distinctMonths(GEO).map((month) => month.key),
    ["2026-09", "2026-08"],
    "months are distinct and newest-first",
  );

  assert.equal(applyCaptureFilter(GEO, { ...EMPTY_CAPTURE_FILTER, line: "Pedia" }).length, 2, "line filter");
  assert.equal(applyCaptureFilter(GEO, { ...EMPTY_CAPTURE_FILTER, area: "Cairo West" }).length, 1, "area filter");
  assert.equal(
    applyCaptureFilter(GEO, { ...EMPTY_CAPTURE_FILTER, brick: "شبين الكوم" }).length,
    1,
    "brick filter",
  );
  assert.equal(
    applyCaptureFilter(GEO, { ...EMPTY_CAPTURE_FILTER, region: "Delta (1)", line: "Pedia" }).length,
    2,
    "region and line together",
  );
  assert.equal(applyCaptureFilter(GEO, { ...EMPTY_CAPTURE_FILTER, month: "2026-08" }).length, 1, "month filter");

  // Sort by date, both directions; the default is newest first.
  const desc = applyCaptureFilter(GEO, { ...EMPTY_CAPTURE_FILTER, sort: "date-desc" });
  assert.deepEqual(desc.map((row) => row.repHrId), ["B-3", "B-1", "B-2"], "newest first");
  const asc = applyCaptureFilter(GEO, { ...EMPTY_CAPTURE_FILTER, sort: "date-asc" });
  assert.deepEqual(asc.map((row) => row.repHrId), ["B-2", "B-1", "B-3"], "oldest first");
}
