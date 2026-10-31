import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { polishAddress } from "../src/lib/crm/address-polish.ts";
import type { DoctorListRow } from "../src/lib/crm/contact-lists.ts";
import {
  buildCoverageFilterTree,
  narrowCoverageOptions,
  restrictCoverageFilterTree,
  type CoverageFilterMapRow,
} from "../src/lib/crm/coverage-filters.ts";
import {
  matchContactTrade,
  venueKey,
  type TradeCounterparty,
} from "../src/lib/crm/contact-trade.ts";
import { employeePortalNavigationSections } from "../src/config/system-navigation.ts";
import { DOCTOR_LIST_ACCESS_ROLES, DOCTOR_LIST_PORTAL_ROLES } from "../src/lib/crm/doctor-list-roles.ts";
import {
  clusterRows,
  confidenceLabel,
  findNeighbours,
  findSharedCustomers,
  nameKey,
  phoneKey,
  scoreLocationConfidence,
  type RosterEntry,
} from "../src/lib/crm/location-confidence.ts";
import { buildPhoenixInsights } from "../src/lib/crm/phoenix-insights.ts";
import { pruneLineFirst, regionsForLine } from "../src/lib/crm/reps-list-board.ts";
import { awaitingBrickSub, brickSpreadLine } from "../src/lib/crm/reps-list-labels.ts";
import { groupContactsByBrick, placementLabel, type BrickIndex } from "../src/lib/crm/reps-list.ts";

/**
 * Reps List — the board the owner specified on 2026-08-31: filter Line -> Region -> Area, pick a
 * medical rep, and see his whole CRM contact list "grouped by bricks".
 *
 * What is worth pinning here is the GROUPING, because every way it can go wrong is silent:
 *
 * · dropping the contacts no brick resolves for would shorten a rep's list by roughly 40% with
 *   nothing on screen saying why — measured on production, only 5,608 of 9,518 contact links resolve
 *   to a brick at all, and the other 3,910 are NOT missing data (exactly one of them lacks a CRM
 *   region; the rest carry a good region name that has never been mapped, across 152 names);
 * · pooling them into one "Unmapped" bucket would throw away the region name that is the only thing
 *   an admin needs to fix the mapping;
 * · resolving the region BEFORE the contact would silently coarsen a contact whose own brick is
 *   known, which is the finest thing Phoenix can resolve;
 * · and a brick id with no name row would render as a bare code, which the owner's naming rule
 *   forbids outright.
 *
 * None of those throws, and every one of them looks like a working board.
 */

const BASE: Omit<DoctorListRow, "contactCrmId" | "listType" | "name" | "region"> = {
  address: null,
  agentCrmId: 1102,
  agentHrId: "A-42",
  firstSeenAt: "2026-08-01T00:00:00.000Z",
  grade: "A",
  nameAr: null,
  phone: null,
  speciality: "Cardiology",
  syncedAt: "2026-08-31T00:00:00.000Z",
};

function row(
  contactCrmId: number,
  name: string,
  region: string | null,
  listType: DoctorListRow["listType"] = "PM",
): DoctorListRow {
  return { ...BASE, contactCrmId, listType, name, region };
}

function index(overrides: Partial<BrickIndex> = {}): BrickIndex {
  return {
    brickByContactId: new Map(),
    brickByRegionName: new Map(),
    metaByBrickId: new Map(),
    ...overrides,
  };
}

/**
 * A two-line, three-region org: CNS works Delta and Giza, Pedia works Giza only.
 *
 * That asymmetry is the whole point — it is what makes "picking CNS must not offer a region only
 * Pedia works" a question with a right answer.
 */
function cascadeTree() {
  const map = (
    regionCode: string,
    lineCode: string,
    areaCode: string,
    areaName: string,
    repSeatId: string,
  ): CoverageFilterMapRow => ({ areaCode, areaName, lineCode, regionCode, repSeatId });

  return buildCoverageFilterTree({
    lineNames: new Map([
      ["CNS", "CNS"],
      ["PED", "Pedia"],
    ]),
    mapRows: [
      map("D1", "CNS", "D11", "Qalubeya", "SEAT-1"),
      map("GZ", "CNS", "GZ3", "Imbaba", "SEAT-2"),
      map("GZ", "PED", "GZ6", "Fayoum", "SEAT-3"),
      map("UE", "PED", "UE9", "Beni Suef", "SEAT-4"),
    ],
    regionNames: new Map([
      ["D1", "Delta (1)"],
      ["GZ", "Giza"],
      ["UE", "Upper Egypt"],
    ]),
    seats: [
      { fullName: "Ahmed Fathy", hrId: "A-1", seatId: "SEAT-1", seatTier: "REP" },
      { fullName: "Mohamed Adel", hrId: "A-2", seatId: "SEAT-2", seatTier: "REP" },
      { fullName: "Omar Nabil", hrId: "A-3", seatId: "SEAT-3", seatTier: "REP" },
      { fullName: "Hassan Sami", hrId: "A-4", seatId: "SEAT-4", seatTier: "REP" },
    ],
  });
}

export function runRepsListTests() {
  // ── The cascade starts at LINE, so picking a line narrows the regions ────────────────────────
  // The owner's words: "he can filter by line — then if he chooses the line, its regions appear."
  // The shared narrowCoverageOptions returns EVERY region unconditionally, which is right for
  // Doctor Coverage (its cascade starts at Region, and narrowing the top by the bottom would hide
  // the region you were about to switch to) and wrong here. This asserts both halves: that the
  // shared helper still behaves its own way, and that this board overrides it.
  {
    const tree = cascadeTree();

    assert.deepEqual(
      narrowCoverageOptions(tree, { line: "CNS" }).regions.map((option) => option.name),
      ["Delta (1)", "Giza", "Upper Egypt"],
      "the shared helper must keep returning every region — this test documents WHY the override exists, and would go quiet if the shared rule changed under it",
    );

    assert.deepEqual(
      regionsForLine(tree, "CNS", tree.regions).map((option) => option.name),
      ["Delta (1)", "Giza"],
      "picking CNS must not offer Upper Egypt, where only Pedia works — a region that leads to no rep is a dead end the owner's order exists to prevent",
    );
    assert.deepEqual(
      regionsForLine(tree, undefined, tree.regions).map((option) => option.name),
      ["Delta (1)", "Giza", "Upper Egypt"],
      "with no line picked yet, every region is still offered",
    );
  }

  // ── A conflicting hand-typed URL drops the REGION, never the line ────────────────────────────
  // pruneCoverageSelection does the same job region-first and would keep Upper Egypt while silently
  // discarding CNS. On a board whose top level is the line, that is the wrong survivor: the user's
  // broadest choice would vanish and the narrower one would stand, with nothing on screen saying so.
  {
    const tree = cascadeTree();

    assert.deepEqual(
      pruneLineFirst(tree, { line: "CNS", region: "UE" }),
      { area: undefined, line: "CNS", region: undefined, rep: undefined },
      "the line is the top of this cascade and must outrank a region it does not work",
    );
    assert.deepEqual(
      pruneLineFirst(tree, { line: "CNS", region: "GZ" }).region,
      "GZ",
      "a pair that a rep really occupies survives untouched",
    );
    assert.deepEqual(
      pruneLineFirst(tree, { area: "UE9", line: "CNS", region: "GZ" }).area,
      undefined,
      "an area below a valid line and region is still pruned when no cell carries it",
    );
    assert.deepEqual(
      pruneLineFirst(tree, { line: "NOPE", region: "GZ" }),
      { area: undefined, line: undefined, region: "GZ", rep: undefined },
      "a line the tree does not offer is dropped, and the region below it is then judged on its own",
    );
  }

  // ── The contact's own mapping beats its region's ────────────────────────────────────────────
  // Both routes resolve for contact 1; only the region route resolves for contact 2. If precedence
  // ever inverted, contact 1 would quietly join the coarser group and the board would still look
  // perfectly normal — one heading, the right number of doctors under it, the wrong brick.
  {
    const grouped = groupContactsByBrick(
      [row(1, "Ahmed", "Smouha"), row(2, "Mohamed", "Smouha")],
      index({
        brickByContactId: new Map([[1, "B-PRECISE"]]),
        brickByRegionName: new Map([["smouha", "B-REGION"]]),
        metaByBrickId: new Map([
          ["B-PRECISE", { areaCode: "AL1", areaName: "Alexandria 1", name: "Smouha East" }],
          ["B-REGION", { areaCode: "AL1", areaName: "Alexandria 1", name: "Smouha" }],
        ]),
      }),
    );

    assert.deepEqual(
      grouped.groups.map((group) => [group.heading, group.rows.map((contact) => contact.name)]),
      [
        ["Smouha", ["Mohamed"]],
        ["Smouha East", ["Ahmed"]],
      ],
      "a contact's OWN brick mapping must win over the one its CRM region supplies — the region is a rough locality holding many customers, the contact mapping is the finest thing Phoenix can resolve",
    );
    assert.equal(grouped.unmappedRegionCount, 0, "both contacts resolved, so nothing is awaiting a brick");
  }

  // ── Phoenix CRM first: the validated place's brick, then the SFE's "where to find" ─────────────
  // Owner, 2026-10-31: "any data anywhere depending on data from ireports must shift to pulling its
  // data from phoenix crm". Contact 1 has all four routes and must sit where his validated place was
  // filed; contact 2 is still waiting and carries only the SFE sheet's locality; contact 3's place
  // brick is stale (no name row), so the next route — his "where to find" — is taken; contact 4 has a
  // locality with its own hyphen. Shahd's whole list sat under "No CRM region recorded" before this.
  {
    const grouped = groupContactsByBrick(
      [row(1, "Ahmed", "Smouha"), row(2, "Mohamed", null), row(3, "Omar", null), row(4, "Hassan", null)],
      index({
        brickByContactId: new Map([[1, "B-PRECISE"]]),
        brickByRegionName: new Map([
          ["smouha", "B-REGION"],
          ["damanhor", "B182-1"],
          ["ma-adi", "B-MAADI"],
        ]),
        intakeByContactId: new Map([
          [1, "Damanhor-Behira I-Alex"],
          [2, "Damanhor-Behira I-Alex"],
          [3, "Damanhor -Behira I-Alex"],
          [4, "Ma-adi-Cairo 1-Cairo"],
        ]),
        metaByBrickId: new Map([
          ["B-PLACE", { areaCode: "BH1", areaName: "Behira 1", name: "Damanhor West", regionName: "Alex-BHR" }],
          ["B-PRECISE", { areaCode: "AL1", areaName: "Alexandria 1", name: "Smouha East" }],
          ["B-REGION", { areaCode: "AL1", areaName: "Alexandria 1", name: "Smouha" }],
          ["B182-1", { areaCode: "BH1", areaName: "Behira 1", name: "Damanhor", regionName: "Alex-BHR" }],
          ["B-MAADI", { areaCode: "CA1", areaName: "Cairo 1", name: "Maadi", regionName: "Cairo" }],
        ]),
        placeBrickByContactId: new Map([
          [1, "B-PLACE"],
          [3, "B-STALE"],
        ]),
      }),
    );

    assert.deepEqual(
      grouped.groups.map((group) => [group.heading, group.rows.map((contact) => contact.name)]),
      [
        ["Damanhor", ["Mohamed", "Omar"]],
        ["Damanhor West", ["Ahmed"]],
        ["Maadi", ["Hassan"]],
      ],
      "the validated place's brick beats every iReports360 route; a doctor still waiting sits under the brick of the locality the SFE wrote; a stale place brick falls through to that locality; a hyphenated locality is matched whole",
    );
    assert.equal(
      grouped.groups.find((group) => group.heading === "Damanhor West")?.regionName,
      "Alex-BHR",
      "a brick heading carries its area's region, so the board can say Behira 1 · Alex-BHR",
    );
    assert.equal(grouped.unmappedRegionCount, 0);
  }

  // ── The SFE's own words head an unmapped group; "No location yet" is the last resort, last ───
  {
    const grouped = groupContactsByBrick(
      [row(1, "Ahmed", null), row(2, "Mohamed", null), row(3, "Omar", null), row(4, "Hassan", "Qena")],
      index({ intakeByContactId: new Map([[4, "Nag Hammadi-Qena I-Upper Egypt"]]) }),
    );

    assert.deepEqual(
      grouped.groups.map((group) => `${group.heading}:${group.rows.length}`),
      ["Nag Hammadi-Qena I-Upper Egypt:1", "No location yet:3"],
      "the SFE's \"where to find\" outranks the CRM region as a heading, and the three doctors Phoenix knows nothing about sit under Phoenix CRM's own words, after every named locality however large",
    );
  }

  // ── "No location yet" is never counted as a locality awaiting a brick ────────────────────────
  // Shahd's Pharmacies tab read "2 pharmacies across 1 locality awaiting a brick" when both
  // pharmacies had no location at all (owner, 2026-10-31). The summary line and the board tile
  // state those rows apart, in rows.
  {
    const nowhere = { count: 2, heading: "No location yet", mapped: false };
    assert.equal(
      brickSpreadLine("2 pharmacies", [nowhere]),
      "2 pharmacies, no location yet",
      "a tab holding only the no-location group names no locality at all",
    );
    assert.equal(
      brickSpreadLine("120 contacts", [
        ...Array.from({ length: 6 }, (_, i) => ({ count: 20, heading: `Brick ${i}`, mapped: true })),
        nowhere,
      ]),
      "120 contacts across 6 bricks · 2 with no location yet",
    );
    assert.equal(
      brickSpreadLine("9 contacts", [
        { count: 5, heading: "Smouha", mapped: true },
        { count: 3, heading: "Qena", mapped: false },
        nowhere,
      ]),
      "9 contacts across 1 brick and 1 locality awaiting one · 2 with no location yet",
    );
    assert.equal(brickSpreadLine("3 contacts", [{ count: 3, heading: "Qena", mapped: false }]), "3 contacts across 1 locality awaiting a brick");

    const rows = (n: number) => Array.from({ length: n }, () => ({}));
    assert.equal(
      awaitingBrickSub({ groups: [{ heading: "No location yet", mapped: false, rows: rows(2) }], unmappedRegionCount: 1 }),
      "2 with no location yet",
      "the board tile does not call the no-location group a locality not yet mapped",
    );
    assert.equal(
      awaitingBrickSub({
        groups: [
          { heading: "Qena", mapped: false, rows: rows(3) },
          { heading: "No location yet", mapped: false, rows: rows(2) },
        ],
        unmappedRegionCount: 2,
      }),
      "1 locality not yet mapped · 2 with no location yet",
      "and one locality is singular",
    );
  }

  // ── An unmapped contact is SHOWN, under its own region name ─────────────────────────────────
  {
    const grouped = groupContactsByBrick(
      [row(1, "Ahmed", "Qena"), row(2, "Mohamed", "Qena"), row(3, "Omar", "Smouha")],
      index({
        brickByRegionName: new Map([["smouha", "B1"]]),
        metaByBrickId: new Map([["B1", { areaCode: "AL1", areaName: "Alexandria 1", name: "Smouha" }]]),
      }),
    );

    assert.equal(grouped.counts.total, 3, "no contact is ever dropped for want of a brick");
    const qena = grouped.groups.find((group) => group.heading === "Qena");
    assert.ok(qena, "an unmapped contact groups under its own CRM region name, not into a shared bucket");
    assert.equal(qena.mapped, false, "and it is flagged so the page can say the locality needs mapping");
    assert.equal(qena.brickId, null);
    assert.equal(qena.areaName, null, "an unmapped group claims no area — it has no brick to take one from");
    assert.deepEqual(
      [grouped.unmappedRegionCount, grouped.unmappedContactCount],
      [1, 2],
      "the two counters are what the board states out loud, so the gap reads as a mapping backlog rather than as missing data",
    );
  }

  // ── A brick id with no name row is treated as unmapped, never rendered as a code ─────────────
  // This is the stale-mapping case: the resolution table still points at a brick that
  // source_of_sales_bricks no longer names (retired, renamed, or never seeded). Showing "B198-5" as
  // a heading would break the owner's standing rule that a screen never prints a raw code.
  {
    const grouped = groupContactsByBrick(
      [row(1, "Ahmed", "Qena")],
      index({ brickByContactId: new Map([[1, "B198-5"]]) }),
    );

    assert.equal(grouped.groups.length, 1);
    assert.equal(grouped.groups[0].heading, "Qena", "a brick with no name row falls back to the region name");
    assert.equal(grouped.groups[0].mapped, false);
    assert.equal(grouped.groups[0].brickId, null, "and it must not carry the unusable id forward");
  }

  // ── A contact with neither a brick nor a region still appears ────────────────────────────────
  // Exactly one contact in production is in this state. It is one row, and it must not be the row
  // that crashes a rep's board or vanishes from it.
  {
    const grouped = groupContactsByBrick([row(1, "Ahmed", null), row(2, "Mohamed", "  ")], index());

    assert.equal(grouped.counts.total, 2);
    assert.deepEqual(
      grouped.groups.map((group) => group.heading),
      ["No location yet"],
      "a null and a blank region are the same statement and share one heading, which says what is true rather than showing an empty label",
    );
  }

  // ── Ordering: mapped before unmapped, then size, then name ──────────────────────────────────
  // The size rule puts the brick a rep actually works at the top. The mapped-first rule outranks it,
  // because a heading that really means "still needs mapping" must never sit above a real brick just
  // for being large — and in production the unmapped groups often ARE the large ones.
  {
    const grouped = groupContactsByBrick(
      [
        row(1, "Ahmed", "Qena"),
        row(2, "Mohamed", "Qena"),
        row(3, "Omar", "Qena"),
        row(4, "Hassan", "Smouha"),
        row(5, "Youssef", "Bashteel"),
        row(6, "Karim", "Bashteel"),
      ],
      index({
        brickByRegionName: new Map([
          ["smouha", "B1"],
          ["bashteel", "B2"],
        ]),
        metaByBrickId: new Map([
          ["B1", { areaCode: "AL1", areaName: "Alexandria 1", name: "Smouha" }],
          ["B2", { areaCode: "GZ3", areaName: "Giza 3", name: "Bashteel" }],
        ]),
      }),
    );

    assert.deepEqual(
      grouped.groups.map((group) => `${group.heading}:${group.rows.length}:${group.mapped ? "mapped" : "open"}`),
      ["Bashteel:2:mapped", "Smouha:1:mapped", "Qena:3:open"],
      "mapped groups come first regardless of size, then largest first — the three-contact unmapped locality must not outrank a one-contact real brick",
    );
    assert.deepEqual(
      grouped.groups[0].rows.map((contact) => contact.name),
      ["Karim", "Youssef"],
      "contacts are sorted by name inside each brick",
    );
  }

  // ── All three lists are counted apart and all three are kept ────────────────────────────────
  // The owner asked for all three, labelled. Pharmacies are not doctors and the AM list is not the
  // PM list; folding any of them into another would misstate what a rep was given.
  {
    const grouped = groupContactsByBrick(
      [
        row(1, "Ahmed", "Smouha", "PM"),
        row(2, "Mohamed", "Smouha", "AM"),
        row(3, "El Ezaby", "Smouha", "Pharmacy"),
        row(4, "Omar", "Smouha", "PM"),
      ],
      index({
        brickByRegionName: new Map([["smouha", "B1"]]),
        metaByBrickId: new Map([["B1", { areaCode: "AL1", areaName: "Alexandria 1", name: "Smouha" }]]),
      }),
    );

    assert.deepEqual(
      grouped.counts,
      { am: 1, contacts: 3, pharmacy: 1, pm: 2, total: 4 },
      "the three list types are counted apart; the board labels each row and can filter to one",
    );
    // A PHARMACY IS NOT A CONTACT — the owner's rule, 2026-09-01: "you will not count the pharmacies
    // as contacts... the contacts is divided into AM and PM, and the pharmacies are separate." What
    // this pins fails silently and flatteringly: summing all three inflated one real rep's list from
    // 114 contacts to "157 contacts", a 38% overstatement of the very figure the 90-120 rule judges.
    assert.equal(
      grouped.counts.contacts,
      grouped.counts.pm + grouped.counts.am,
      "contacts are PM + AM and nothing else — a pharmacy must never be counted as a contact",
    );
    assert.notEqual(
      grouped.counts.contacts,
      grouped.counts.total,
      "and `total` is rows INCLUDING pharmacies, so with a pharmacy present the two must differ — no screen may print `total` under the word contacts",
    );
    assert.equal(grouped.groups.length, 1, "and all three share the brick they sit in — the grouping is geography, not list type");
  }

  // ── The three lists carry the owner's own names ──────────────────────────────────────
  // Corrected by the owner on 2026-09-01, in his words: "It's not doctor list. AM list, PM list,
  // pharmacist." The first build called `PM` the "Doctor list" because that is what it holds, and
  // that is exactly the invention he refused — the CRM says PM, the reps and managers say PM, and a
  // friendlier name only makes the screen and the CRM disagree out loud in front of a user. Pinned
  // rather than left to code review because a rename reads as a harmless copy tidy-up.
  {
    const source = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");
    for (const label of ['PM: "PM list"', 'AM: "AM list"', 'Pharmacy: "Pharmacist"']) {
      assert.ok(
        source.includes(label),
        `the three lists are named PM list, AM list and Pharmacist — the owner's own words, never "Doctor list": ${label} is missing`,
      );
    }
    assert.ok(
      !/"Doctor list/.test(source),
      'no surface may call the PM list a "Doctor list" — the owner corrected that name on 2026-09-01',
    );
  }

  // ── The address is polished, and polishing never eats a place ───────────────────────────────
  // The owner asked for the address to be polished rather than shown raw (2026-09-01). These
  // fixtures are VERBATIM production rows, because the risk is not that polishing does nothing —
  // it is that polishing removes too much and sends a rep to the wrong Mansoura. A dropped street
  // or district cannot be seen on screen: what remains still reads as a perfectly good address.
  {
    assert.deepEqual(
      polishAddress("F57H+JMX, Salah Hegazy, Qism Banha, Banha, Al-Qalyubia Governorate 6460243, Egypt"),
      ["Salah Hegazy", "Qism Banha", "Banha", "Al-Qalyubia"],
      "the plus code, the postal code, the word Governorate and the country all come out — 69.4%, ~93%, 93.3% and 99.97% of production rows carry them",
    );
    assert.deepEqual(
      polishAddress("X64Q+739، منيل شيحة، أبو النمرس، محافظة الجيزة 3398442، مصر"),
      ["منيل شيحة", "أبو النمرس", "الجيزة"],
      "the Arabic comma separates segments too, and محافظة/مصر are the same boilerplate as their English twins",
    );
    // The bilingual case, which is 18.2% of production addresses (20,313 of 111,912). It is why
    // the function returns SEGMENTS: rendered as one `dir="auto"` string this flips wholly RTL and
    // the English half prints backwards — AGENTS.md §2.1, direction per line is the fix.
    assert.deepEqual(
      polishAddress("3C32+VV3، الامام محمد عبده، Mansoura Qism 2, El Mansoura 2, Dakahlia Governorate 7661351, Egypt"),
      ["الامام محمد عبده", "Mansoura Qism 2", "El Mansoura 2", "Dakahlia"],
      "a bilingual address keeps both halves, in order, as separate segments the caller can isolate",
    );
    assert.deepEqual(
      polishAddress("1, Al Gemhoureya Street, Talkha City, Talkha, Ad Dakahliya, 35681, Egypt"),
      ["1", "Al Gemhoureya Street", "Talkha City", "Talkha", "Ad Dakahliya"],
      "a house number is 1-4 digits and must survive; only a 5+ digit postal code is dropped",
    );
    assert.deepEqual(
      polishAddress("HGM2+83V, Ismailia - El-Zakazik Rd, Youssef, Zagazig 2, Al-Sharqia Governorate 7130401, Egypt"),
      ["Ismailia - El-Zakazik Rd", "Youssef", "Zagazig 2", "Al-Sharqia"],
      "district numbers (Zagazig 2, El Mansoura 2) are how Egyptian districts are NAMED — stripping them merges two real places into one",
    );
    assert.deepEqual(polishAddress("برج الصيرفي"), ["برج الصيرفي"], "a bare CRM address is already clean and passes through");
    for (const nothing of [null, undefined, "", "   ", "Egypt", "X64Q+739"]) {
      assert.deepEqual(
        polishAddress(nothing),
        [],
        `"${String(nothing)}" carries no place, so it must yield nothing for the caller to render as an absence rather than as an empty address`,
      );
    }
  }

  // ── THE GOLDEN RULE: this board never scrolls sideways ──────────────────────────────────────
  // Owner 2026-09-01, asked for as a golden word: "never make horizontal scrolling. Must fit in the
  // same screen... always mobile friendly and desktop friendly." Pinned in source because the
  // regression is a ONE-LINE convenience: `PortalDesktopTable` is the house primitive for exactly
  // this shape and it hard-codes `overflow-x-auto` with a 980px floor, so reaching for it is the
  // natural thing a future edit does — and the result looks completely fine on a desktop monitor.
  // That is how the Address column he asked for came to be already present and off-screen.
  {
    const source = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");
    // Checked against CODE, not prose: the file's own comment explains why that primitive is not
    // used here, so a bare `includes` would fail on the explanation. A pin that matches a comment
    // is a pin that gets "fixed" by deleting the comment.
    assert.ok(
      !/import[^;]*\bPortalDesktopTable\b/.test(source) && !source.includes("<PortalDesktopTable"),
      "Reps List must not import or render PortalDesktopTable: it hard-codes overflow-x-auto and a 980px minimum, which is the horizontal scroll the owner forbade",
    );
    assert.ok(
      !/className=[^\n]*overflow-x-(auto|scroll)/.test(source),
      "no horizontal scroll container on this board — content fits the screen or wraps, it is never reachable only by dragging sideways",
    );
    assert.ok(
      !/minWidth[:=]|\bmin-w-\[/.test(source),
      "no minimum width may be imposed on this board's table — a width floor is what forces the scroll",
    );
    assert.ok(
      source.includes("table-fixed") && source.includes("<colgroup>"),
      "the columns share the available width through table-fixed plus a colgroup, which is what lets them fit any screen",
    );
    // Wrapping is the permitted answer and the ellipsis is not: the owner's older rule forbids
    // truncating text, and vertical space is free where horizontal space is not.
    assert.ok(
      source.includes("break-words"),
      "cells must wrap rather than push the table wider; wrapping hides nothing, which is what separates it from the ellipsis he forbids",
    );
    assert.ok(
      !/\btruncate\b|text-ellipsis/.test(source),
      "and nothing may be truncated to make it fit — the golden rule replaced a scroll with wrapping, not with hidden text",
    );

    // The percentages themselves, because `table-fixed` obeys them exactly and fails silently.
    // A column narrower than its own heading does not clip and does not scroll — the text simply
    // hangs outside the column into its neighbour's padding, which no assertion above can see and
    // which nothing in this repo can measure. It shipped that way on 2026-09-01: Confidence at 11%
    // gave the header 95px at a 1280 viewport and 74px at 768, against the 106px the word needs.
    // Sliced between the colgroup markers rather than by a byte window, which shifts when the file
    // moves and false-fails.
    const colgroup = source.slice(source.indexOf("<colgroup>"), source.indexOf("</colgroup>"));
    const widths = [...colgroup.matchAll(/w-\[(\d+)%\]/g)].map((match) => Number(match[1]));
    // The first four columns are unconditional and always in this order: Contact, Specialty, List,
    // Brick. Read them positionally.
    const [contact, specialty, list, brick] = widths;
    assert.deepEqual(
      [contact, specialty, list, brick],
      [21, 13, 13, 11],
      "the first four columns — Contact, Specialty, List, Brick — keep their measured widths",
    );
    // The last two columns SWAP SEATS between surfaces: Phoenix CRM puts Address right after the
    // brick with Actions last (owner, 2026-09-25), every other surface keeps Confidence then Address.
    // Both orders live in the source, so the colgroup carries the actions/confidence width and both
    // Address widths in each order. What must hold is the arithmetic, not the order — so read the
    // three distinct trailing widths and check both tabs still total exactly 100%.
    const trailing = [...new Set(widths.slice(4))].sort((left, right) => left - right);
    assert.deepEqual(
      trailing,
      [16, 26, 39],
      "the trailing columns are the actions/confidence width (16%) and Address's two widths (26% with List, 39% without), whatever order a surface puts them in",
    );
    const [actions, addressWithList, addressWithoutList] = trailing;
    assert.equal(
      contact + specialty + list + brick + actions + addressWithList,
      100,
      "the Contacts tab's six columns must total exactly 100% — table-fixed scales anything else, so a total under 100 leaves dead space and over 100 squeezes every column at once",
    );
    assert.equal(
      contact + specialty + brick + actions + addressWithoutList,
      100,
      "and the Pharmacies tab's five must total 100% too: dropping the List column is what frees its share for Address",
    );
    assert.ok(
      actions >= 16,
      `the actions/confidence column must stay at 16% or wider (it is ${actions}%): the word "Confidence" is a single unbreakable token needing 106px at this uppercase tracking, and 16% is what clears that at the 768px viewport where the desktop table first appears. A single word cannot wrap, so a narrower column puts the heading outside its own cell — silently, because nothing clips and nothing scrolls`,
    );
  }

  // ── A region name matches case- and whitespace-insensitively ────────────────────────────────
  // The CRM's region strings are hand-entered and the mapping table is hand-maintained, so an exact
  // match would silently strand a locality that IS mapped — which is indistinguishable on screen
  // from one that never was.
  {
    const grouped = groupContactsByBrick(
      [row(1, "Ahmed", "  SMOUHA  ")],
      index({
        brickByRegionName: new Map([["smouha", "B1"]]),
        metaByBrickId: new Map([["B1", { areaCode: "AL1", areaName: "Alexandria 1", name: "Smouha" }]]),
      }),
    );

    assert.equal(grouped.groups[0].mapped, true, "region matching is normalised on both sides");
    assert.equal(grouped.groups[0].areaName, "Alexandria 1", "a mapped group carries its area NAME, never the code");
  }

  // ── The nav and the gate name the same roles ────────────────────────────────────────────────
  // This block used to hold THREE hand-maintained copies of the portal role list honest — the gate,
  // the sidebar flag and the catalog entry — because the flag could not import doctor-list-access.ts
  // (it reaches the Supabase server client through manager-scope.ts and is consumed by client
  // components). On 2026-09-03 the roles moved to doctor-list-roles.ts, which carries no server-only
  // import, and both nav callers now read that list; the widening from three seats to seven is what
  // forced it, because keeping a seven-role list in step by hand across three files is not a thing
  // that survives contact with a tired session at 4am.
  //
  // So what is asserted here has changed shape: not "do the copies agree" but "is there still only
  // one copy". A role offered a sidebar row the page then refuses is the exact "visible row he
  // cannot open" bug, and it is invisible until someone in that role clicks it.
  {
    for (const role of DOCTOR_LIST_PORTAL_ROLES) {
      assert.ok(
        (DOCTOR_LIST_ACCESS_ROLES as readonly string[]).includes(role),
        `${role} is offered the portal Reps List row, so the enforcing gate must admit them`,
      );
    }

    // The catalog entry is still a literal array — the nav config keeps every entry's roles spelled
    // out so the file reads as one table — so THIS pair is the one that can still drift.
    const portalItems = employeePortalNavigationSections.flatMap((section) => section.items);
    const repsListItem = portalItems.find((item) => item.href === "/employee-portals/reps-list");
    assert.ok(repsListItem, "the portal sidebar catalog must offer Reps List");
    assert.deepEqual(
      [...(repsListItem.roles ?? [])].sort(),
      [...DOCTOR_LIST_PORTAL_ROLES].sort(),
      "the Reps List catalog entry must name exactly DOCTOR_LIST_PORTAL_ROLES — a hand-maintained second copy is how a row appears for a seat the page refuses",
    );

    // THE STATEMENT, not a fixed byte window. Both assertions below read `flag`, and slicing a
    // fixed 400 bytes is how this block false-failed the moment the flag got SHORTER: the window
    // ran past the end of the statement and swallowed the Reps Plans comment beneath it, which says
    // "Deliberately NOT isDistrictManager" — so the guard fired on the neighbouring comment that
    // agrees with it. Ending at the statement's own semicolon cannot drift with what follows.
    const navSource = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
    const flagStart = navSource.indexOf("const showRepsListTab");
    assert.ok(flagStart >= 0, "the portal Reps List visibility flag must exist");
    const flag = navSource.slice(flagStart, navSource.indexOf(";", flagStart) + 1);
    // Pin the fix itself, not just its effect. A future session "simplifying" this back to a
    // spelled-out chain would restore the very drift the split removed, and nothing would fail.
    assert.ok(
      flag.includes("DOCTOR_LIST_PORTAL_ROLES"),
      "the portal flag must ASK the shared list rather than spell the roles out again — that second copy is what this block used to exist to police",
    );
    assert.ok(
      !flag.includes("isDistrictManager"),
      'the flag must not reuse isDistrictManager: that predicate also admits the bare "Manager" title, which the access module does not, so a Manager would see a row the page refuses',
    );
  }

  // ── The retirement is complete: one door, not two ───────────────────────────────────────────
  // The owner asked for the old board AND its District Manager tab to go. Two boards over the same
  // data is how the two diverge on the first edit, and a surviving tab strip is a second door.
  {
    const retired = readFileSync("app/(admin)/admin/doctor-list/page.tsx", "utf8");
    assert.ok(
      retired.includes('redirect("/admin/reps-list")'),
      "the retired Doctor List route must redirect to Reps List rather than 404 — bookmarks and browser history still point at it",
    );
    assert.ok(
      !retired.includes("DoctorListBoardView"),
      "the retired route must not still render the old board",
    );

    const plans = readFileSync("app/(admin)/admin/plan-verification/page.tsx", "utf8");
    assert.ok(
      !plans.includes("DistrictManagerTabs"),
      "the District Manager tab strip was retired with Doctor List — Plan Verification now stands on its own",
    );

    const nav = readFileSync("src/config/system-navigation.ts", "utf8");
    assert.ok(
      nav.includes('href: "/admin/reps-list"'),
      "Reps List must have an admin nav card, or the page is reachable only by a typed URL",
    );
    assert.ok(
      !nav.includes('href: "/admin/doctor-list"'),
      "the retired route must not still be offered as a nav destination",
    );
  }

  // ── A SINGLE CHECK-IN IS THE LEAST VERIFIED CASE, AND MUST NEVER SCORE LIKE THE MOST ──────────
  // The whole model is "how well does the evidence agree with the pin". One observation agrees with
  // itself perfectly, so an agreement ratio alone hands a contact nobody has ever confirmed a
  // flawless mark — the exact inversion of what the owner asked the percentage to tell him. It gets
  // its own branch and its own word, and this is the assertion that keeps the branch there.
  {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const pin = { lat: 30, lon: 31 };

    const once = scoreLocationConfidence(pin, [{ repKey: "1", at: daysAgo(10), lat: 30, lon: 31 }], now);
    assert.ok(once, "one check-in is still evidence — it must produce a score, not a null");
    assert.equal(once.total, 1, "the popup states how many check-ins are behind the score");
    assert.equal(
      once.band,
      "unverified",
      "one sighting is UNVERIFIED, whatever it agrees with — a lone observation cannot corroborate itself",
    );
    assert.ok(
      once.score <= 60,
      "a single unconfirmed sighting must never reach a confident-looking percentage: it agrees with itself perfectly, and scoring that agreement is what would put the least-verified contacts at the top",
    );

    const agreeing = scoreLocationConfidence(
      pin,
      [
        { repKey: "1", at: daysAgo(5), lat: 30, lon: 31 },
        { repKey: "1", at: daysAgo(9), lat: 30.0001, lon: 31 },
        { repKey: "2", at: daysAgo(20), lat: 30, lon: 31.0001 },
        { repKey: "2", at: daysAgo(30), lat: 30, lon: 31 },
        { repKey: "2", at: daysAgo(40), lat: 30.0002, lon: 31 },
      ],
      now,
    );
    assert.ok(agreeing, "five agreeing check-ins must score");
    assert.equal(agreeing.band, "high", "five recent check-ins all at the pin is what confirmed means");
    assert.ok(
      agreeing.score > once.score,
      "corroborated evidence must outrank a single sighting, or the percentage tells the reader the opposite of the truth",
    );
    assert.equal(agreeing.observers, 2, "the popup names how many different reps have been there");

    // Half the check-ins somewhere else entirely. That is usually a doctor practising in two places,
    // which is a FACT ABOUT THE DOCTOR and not a fault — so it lowers the score and is explained in
    // words, rather than being silently subtracted.
    const split = scoreLocationConfidence(
      pin,
      [
        { repKey: "1", at: daysAgo(5), lat: 30, lon: 31 },
        { repKey: "1", at: daysAgo(6), lat: 30, lon: 31 },
        { repKey: "1", at: daysAgo(7), lat: 30.05, lon: 31 },
        { repKey: "1", at: daysAgo(8), lat: 30.05, lon: 31 },
        { repKey: "1", at: daysAgo(9), lat: 30.05, lon: 31 },
      ],
      now,
    );
    assert.ok(split, "a disagreeing set still scores");
    assert.equal(split.far, 3, "check-ins beyond the close radius are counted, not dropped");
    assert.ok(split.score < agreeing.score, "disagreement must cost score");
    assert.ok(
      split.reasons.some((reason) => reason.points === null),
      "a contact whose check-ins disagree gets a line of PLAIN ENGLISH explaining why, not just a smaller number — the popup exists to say where the score came from",
    );

    assert.equal(scoreLocationConfidence(null, [], now), null, "no pin, no score");
    assert.equal(
      scoreLocationConfidence(pin, [], now),
      null,
      "a pin nobody has ever checked in on scores NOTHING rather than 0% — zero would read as 'this address is wrong' when the truth is 'nobody has been yet'",
    );
    assert.equal(confidenceLabel(null), "Not confirmed", "the no-evidence case is said in words, never as a number");

    // ── A SHARED CUSTOMER'S SECOND REP MUST BE VISIBLE TO THE SCORE, AND SAID OUT LOUD ──────────
    // The owner caught this on the screen: a row highlighted violet as shared with another rep,
    // whose popup underneath read "only one rep has ever checked in here". Both came from the same
    // cause — the CRM files a visit against the contact row of the rep who made it and gives each
    // rep their own row for one doctor, so a score computed on our row alone can never see the
    // other rep's visits. `contactCrmIds` is the join that lets the caller fetch them, and this
    // asserts the two halves agree: once the other rep's visits are passed in, the observer count
    // rises AND the popup carries a line naming whose evidence was counted. A score that quietly
    // absorbed another rep's visits without saying so would be the worse bug of the two.
    const lone = scoreLocationConfidence(pin, [{ repKey: "1", at: daysAgo(5), lat: 30, lon: 31 }, { repKey: "1", at: daysAgo(6), lat: 30, lon: 31 }], now);
    const withPartner = scoreLocationConfidence(
      pin,
      [
        { repKey: "1", at: daysAgo(5), lat: 30, lon: 31 },
        { repKey: "1", at: daysAgo(6), lat: 30, lon: 31 },
        { repKey: "2", at: daysAgo(7), lat: 30, lon: 31 },
      ],
      now,
      { count: 1, repNames: ["Sara Mohy Eldeen"] },
    );
    assert.ok(lone && withPartner, "both shapes must score");
    assert.equal(lone.observers, 1, "our rep alone is one observer");
    assert.equal(
      withPartner.observers,
      2,
      "the other rep's visits are visits on the same customer — the popup must count them, or it tells a manager 'only one rep has ever checked in here' about a row that names the second rep beside it",
    );
    assert.ok(
      withPartner.score > lone.score,
      "an independently confirmed pin must outrank a pin only one rep has ever stood on",
    );
    const foldedLine = withPartner.reasons.find((reason) => reason.label === "Counted from a shared customer");
    assert.ok(
      foldedLine,
      "folding another rep's visits in rests on an identity JUDGEMENT, so the popup must carry a line saying it happened — a wrong match has to be legible instead of silently lifting the percentage",
    );
    assert.ok(
      foldedLine.detail.includes("Sara Mohy Eldeen"),
      "the line names the rep whose record was counted, so the reader can judge the match themselves",
    );
    assert.ok(
      lone.reasons.every((reason) => reason.label !== "Counted from a shared customer"),
      "a contact nobody shares must NOT carry the shared-customer line",
    );
    assert.ok(
      !withPartner.reasons.some((reason) => reason.detail.includes("Only one rep has ever checked in here")),
      "the sentence the owner caught must be gone once a second rep's visits are counted",
    );

    // A SHARED ROW WHOSE PARTNER WAS NOT COUNTED MUST EXPLAIN ITSELF. The proximity gate keeps a
    // distant phone match out of the score, which is right — but it leaves the row highlighted as
    // shared above a popup reading "only one rep has ever checked in here", which is word for word
    // the contradiction the owner reported. It is TRUE for these rows and still unreadable, so the
    // reason has to be stated. 41 rows in production are in this shape.
    const distantOnly = scoreLocationConfidence(
      pin,
      [
        { repKey: "1", at: daysAgo(5), lat: 30, lon: 31 },
        { repKey: "1", at: daysAgo(6), lat: 30, lon: 31 },
      ],
      now,
      { count: 0, distant: [{ metres: 11_000, repName: "Mariem Hany" }], repNames: [] },
    );
    assert.ok(distantOnly, "a row whose partner was refused still scores on its own visits");
    const gapLine = distantOnly.reasons.find((reason) => reason.label === "Shared, but not the same place");
    assert.ok(
      gapLine,
      "a highlighted row that counted NOTHING from its partner must say why, or the popup reproduces the exact contradiction this work exists to remove",
    );
    assert.ok(
      gapLine.detail.includes("Mariem Hany") && gapLine.detail.includes("11.0 km"),
      "the line names the rep and how far away their record stands — distance is the whole reason those visits were left out, so stating it is what turns a contradiction into an explanation",
    );
    assert.equal(
      distantOnly.observers,
      1,
      "a refused partner must NOT be counted as an observer — the explanation is a sentence, never a nudge to the number",
    );
    assert.ok(
      distantOnly.reasons.every((reason) => reason.label !== "Counted from a shared customer"),
      "nothing was counted, so nothing may claim to have been counted",
    );

    // Plural agreement, on a line a non-engineer reads every day. "1 visits back this pin up" was on
    // screen in production.
    const single = scoreLocationConfidence(
      pin,
      [
        { repKey: "1", at: daysAgo(5), lat: 30, lon: 31 },
        { repKey: "1", at: daysAgo(6), lat: 30.05, lon: 31 },
      ],
      now,
    );
    assert.ok(single, "a two-check-in split still scores");
    assert.ok(
      single.reasons.some((reason) => reason.detail.includes("1 visit backs this pin up")),
      "one corroborating visit reads '1 visit backs', never '1 visits back'",
    );

    // The second-observer term, ISOLATED. Comparing a 3-visit set against a 2-visit one also moves
    // the corroboration term, so it cannot tell you the independence bonus still exists. These two
    // sets are identical in count, position and date — only WHO stood there differs.
    const sameRep = scoreLocationConfidence(
      pin,
      [
        { repKey: "1", at: daysAgo(5), lat: 30, lon: 31 },
        { repKey: "1", at: daysAgo(7), lat: 30, lon: 31 },
      ],
      now,
    );
    const twoReps = scoreLocationConfidence(
      pin,
      [
        { repKey: "1", at: daysAgo(5), lat: 30, lon: 31 },
        { repKey: "2", at: daysAgo(7), lat: 30, lon: 31 },
      ],
      now,
    );
    assert.ok(sameRep && twoReps, "both two-visit shapes score");
    assert.ok(
      twoReps.score > sameRep.score,
      "two DIFFERENT reps standing at the same pin must outscore one rep standing there twice — independent confirmation is the whole reason the term exists, and the counts here are deliberately equal so nothing else can account for the difference",
    );
  }

  // ── NEIGHBOURHOODS ARE CONNECTED COMPONENTS, NUMBERED IN READING ORDER ───────────────────────
  // The owner asked for each neighbourhood to carry its own colour and for its members to sit under
  // each other. Both depend on the same thing: that a block is a chain, not a radius. If clustering
  // ever became "everyone within N metres of me", the middle contact of a chain would belong to two
  // blocks at once and the page would paint it one colour while listing it under another.
  {
    const rows = [
      { contactCrmId: 1, lat: 30, lon: 31, name: "Ahmed Fouad" },
      { contactCrmId: 2, lat: 30.0001, lon: 31, name: "Basma Nabil" },
      { contactCrmId: 3, lat: 30.0002, lon: 31, name: "Carim Adel" },
      { contactCrmId: 4, lat: 30.05, lon: 31, name: "Dalia Sherif" },
      { contactCrmId: 5, lat: 30.03, lon: 31, name: "Eman Zaki" },
      { contactCrmId: 6, lat: 30.03005, lon: 31, name: "Farid Helmy" },
    ];
    const near = findNeighbours(rows);

    assert.ok(
      near.get(1)?.some((entry) => entry.contactCrmId === 2),
      "11 metres apart is the same address by any reading",
    );
    assert.ok(
      !near.get(1)?.some((entry) => entry.contactCrmId === 3),
      "22 metres is outside the radius — these two are joined through the contact between them, not directly",
    );
    assert.ok(!near.has(4), "a contact standing on its own has no neighbours and needs no highlight");

    const clustered = clusterRows(rows, near);
    assert.equal(
      clustered.clusterOf.get(1),
      clustered.clusterOf.get(3),
      "A near B and B near C is ONE block, even where A and C are further apart than the radius — anything else puts B in two places at once",
    );
    assert.equal(
      clustered.clusterOf.get(4),
      undefined,
      "a contact standing alone is not a neighbourhood and takes no colour: a tint with nothing to compare against is the noise the owner asked us not to make",
    );
    assert.notEqual(
      clustered.clusterOf.get(1),
      clustered.clusterOf.get(5),
      "two separate neighbourhoods must not share a number, or the page paints them the same colour and they read as one place",
    );

    const order = clustered.rows.map((row) => row.contactCrmId);
    const blockStart = order.indexOf(1);
    assert.deepEqual(
      order.slice(blockStart, blockStart + 3).sort((left, right) => left - right),
      [1, 2, 3],
      "a block's members sit on consecutive rows — the owner asked for them 'under each other', and a colour scattered down the column proves a cluster exists without letting anyone read it",
    );

    const seen: number[] = [];
    for (const row of clustered.rows) {
      const index = clustered.clusterOf.get(row.contactCrmId);
      if (index != null && !seen.includes(index)) seen.push(index);
    }
    assert.deepEqual(
      seen,
      [0, 1],
      "neighbourhoods are numbered in the order they are READ down the column; numbering them any other way scatters the palette and costs the colours the legibility they were added for",
    );
  }

  // ── THE VALIDATION PIN OUTRANKS THE CHECK-IN ─────────────────────────────────────────────────
  // Owner, 2026-10-31: "use the validation pin and build it". A rep with no iReports360 check-ins read
  // "No address on record" on every row and was never painted a single neighbour, while her validated
  // doctors stood on live photos 3 to 19 metres apart. A row now stands where its validated photo was
  // taken, and on its last check-in only while it is not validated yet.
  {
    const validated = (lat: number) => ({ address: null, lat, lon: 30.7, validatedAt: "2026-10-20T08:00:00Z" });
    const checkedIn = (lat: number) => ({ address: null, at: "2026-09-01T08:00:00Z", lat, lon: 30.7 });
    const grouped = groupContactsByBrick(
      [
        // Two validated doctors 11 m apart with no check-in at all — a new rep's list.
        { ...row(1, "Amal", "Kom Hamada"), place: validated(30.76), seenAt: null },
        { ...row(2, "Ahmed", "Kom Hamada"), place: validated(30.7601), seenAt: null },
        // An old check-in beside them, but the validated photo is 5 km away: the photo wins.
        { ...row(3, "Basem", "Kom Hamada"), place: validated(30.805), seenAt: checkedIn(30.76005) },
        // Not validated yet: the check-in still places him, 5 m from Ahmed.
        { ...row(4, "Dina", "Kom Hamada"), place: null, seenAt: checkedIn(30.76015) },
      ],
      index(),
    );
    const byId = new Map(grouped.groups.flatMap((group) => group.rows).map((entry) => [entry.contactCrmId, entry]));
    assert.ok(
      byId.get(1)?.nearby?.some((entry) => entry.contactCrmId === 2),
      "a validated doctor with no check-in is painted beside his validated neighbour — the whole point of the validation pin",
    );
    assert.equal(
      byId.get(3)?.nearby ?? null,
      null,
      "the validated photo outranks an older check-in: a doctor whose photo stands 5 km away is not anyone's neighbour because a visit once logged him nearby",
    );
    assert.ok(
      byId.get(4)?.nearby?.some((entry) => entry.contactCrmId === 2),
      "a doctor not validated yet still stands on his check-in, so he is gathered with the validated doctors beside him",
    );
    assert.equal(byId.get(1)?.cluster, byId.get(4)?.cluster, "one neighbourhood, one colour, whichever pin placed each member");
    assert.equal(byId.get(3)?.cluster ?? null, null, "the doctor standing alone carries no colour");
  }

  // ── SHARING IS AN IDENTITY JUDGEMENT, AND A NAME IS NOT AN IDENTITY ──────────────────────────
  // Measured on production 2026-09-01: 69% of same-name cross-rep contact pairs stand over 5 km
  // apart. Matching on the name alone would have painted hundreds of rows violet and told the owner
  // that unrelated doctors who happen to share a common Egyptian name are the same customer.
  {
    const repNames = new Map([
      ["10", "Mahmoud Alslamony"],
      ["20", "Omnia Ismael"],
    ]);
    const entry = (agentCrmId: number, contactCrmId: number, name: string, phone: string | null): RosterEntry => ({
      contactCrmId,
      name,
      nameKey: nameKey(name),
      phoneKey: phoneKey(phone),
      regionKey: null,
      repKey: String(agentCrmId),
      speciality: null,
    });
    const mine = [{ repKey: "10", contactCrmId: 101 }];
    const roster = [
      entry(10, 101, "Ahmed Fouad", "0100 123 4567"),
      entry(20, 201, "Ahmed Fouad", "0100 999 8888"),
    ];

    const together = findSharedCustomers(
      mine,
      roster,
      new Map([
        [101, { lat: 30, lon: 31 }],
        [201, { lat: 30.0005, lon: 31 }],
      ]),
      repNames,
    );
    assert.equal(together.get(101)?.length, 1, "the same name standing in the same place is the same customer");
    assert.equal(
      together.get(101)?.[0]?.basis,
      "name and location",
      "the reason is carried, so the row can say WHY it is highlighted",
    );
    assert.equal(
      together.get(101)?.[0]?.repName,
      "Omnia Ismael",
      "the other rep is named — the owner asked who the customer is shared with",
    );

    const apart = findSharedCustomers(
      mine,
      roster,
      new Map([
        [101, { lat: 30, lon: 31 }],
        [201, { lat: 30.1, lon: 31 }],
      ]),
      repNames,
    );
    assert.equal(
      apart.get(101),
      undefined,
      "the same name eleven kilometres away is TWO different people — 69% of same-name cross-rep pairs are over 5 km apart, so a name on its own is a coin toss dressed as evidence",
    );

    const unlocated = findSharedCustomers(mine, roster, new Map([[101, { lat: 30, lon: 31 }]]), repNames);
    assert.equal(
      unlocated.get(101),
      undefined,
      "a name match with no pin on the other side cannot be checked, and an unchecked name match is precisely the false positive being guarded against",
    );

    // One number carried by five contacts is a hospital switchboard, not a person's phone. The
    // biggest real one covers 53 contacts; left ungated it would join dozens of unrelated doctors.
    const switchboard = [
      entry(10, 101, "Ahmed Fouad", "0223 456 789"),
      entry(20, 201, "Mona Sami", "0223 456 789"),
      entry(20, 202, "Hany Adel", "0223 456 789"),
      entry(20, 203, "Sara Nabil", "0223 456 789"),
      entry(20, 204, "Karim Zaki", "0223 456 789"),
    ];
    assert.equal(
      findSharedCustomers(mine, switchboard, new Map(), repNames).get(101),
      undefined,
      "a number on more than three contacts is a switchboard, and joining people by it would invent sharing that does not exist",
    );

    const pair = [entry(10, 101, "Ahmed Fouad", "0100 123 4567"), entry(20, 201, "Ahmed F.", "0100 123 4567")];
    assert.equal(
      findSharedCustomers(mine, pair, new Map(), repNames).get(101)?.[0]?.basis,
      "shared phone",
      "a phone shared by two contacts is the strongest signal there is, and needs no pin to be trusted",
    );

    // ── A LABEL AND A VOTE ON THE SCORE ARE NOT THE SAME CLAIM ────────────────────────────────
    // Saying "also on Sara's list" describes two records. Counting her VISITS into this pin says
    // they are the same physical place, which is a far stronger claim and needs the proximity test
    // the name path has always had. Measured 2026-09-01: 42 of 72 cross-rep phone pairs are over
    // 200 m apart and 26 are over 5 km — clinic switchboards and doctors working in two cities.
    // Those visits land far from the pin, so folding them in would count as DISAGREEMENT and push
    // the score DOWN, then explain it with a "practises in two places" line about a customer who
    // does not exist. So `contactCrmIds` may legitimately be empty on a genuinely shared row.
    assert.deepEqual(
      findSharedCustomers(mine, pair, new Map(), repNames).get(101)?.[0]?.contactCrmIds,
      [],
      "a phone match with no pins keeps its highlight but contributes NO visits — proximity was never established, so there is nothing to justify moving the score",
    );

    const farPhone = findSharedCustomers(
      mine,
      pair,
      new Map([
        [101, { lat: 30, lon: 31 }],
        [201, { lat: 30.1, lon: 31 }],
      ]),
      repNames,
    );
    assert.equal(
      farPhone.get(101)?.[0]?.basis,
      "shared phone",
      "eleven kilometres apart on a shared phone is still worth SAYING — it is how a manager spots a clinic switchboard or a doctor working two cities",
    );
    assert.deepEqual(
      farPhone.get(101)?.[0]?.contactCrmIds,
      [],
      "but a record eleven kilometres away must contribute NO visits to this pin's score: its check-ins would read as disagreement and drag down a percentage that was never about it",
    );

    const nearPhone = findSharedCustomers(
      mine,
      pair,
      new Map([
        [101, { lat: 30, lon: 31 }],
        [201, { lat: 30.0005, lon: 31 }],
      ]),
      repNames,
    );
    assert.deepEqual(
      nearPhone.get(101)?.[0]?.contactCrmIds,
      [201],
      "a shared phone AT THE SAME PLACE is the case the whole feature exists for — that partner's visits must be counted, or the popup goes back to claiming one rep on a row that names two",
    );

    assert.equal(
      findSharedCustomers(mine, pair, new Map(), new Map()).get(101),
      undefined,
      "a rep whose name cannot be resolved is DROPPED, never printed as a raw agent id — the owner's standing rule is that a screen shows human-readable names",
    );
  }

  // ── A REP HIRED WITHOUT A CRM ACCOUNT IS STILL SOMEBODY ─────────────────────────────────────
  // Keyed on the CRM id, a rep hired after the cutover had no key at all: his roster rows were
  // dropped, so a customer he shared was never highlighted from either side, and his check-ins never
  // counted as a second observer. Both halves now carry the rep key — the CRM id as a string, or
  // `hr:<id>` for a rep with none — and the name map is keyed the same way.
  {
    const roster: RosterEntry[] = [
      { contactCrmId: 11, name: "Dr Adel", nameKey: "dradel", phoneKey: null, regionKey: null, repKey: "1001", speciality: null },
      { contactCrmId: 22, name: "Dr Adel", nameKey: "dradel", phoneKey: null, regionKey: null, repKey: "hr:b-40", speciality: null },
    ];
    const pins = new Map([
      [11, { lat: 30, lon: 31 }],
      [22, { lat: 30, lon: 31 }],
    ]);
    const names = new Map([
      ["1001", "Ahmed Fathy"],
      ["hr:b-40", "Mona Samir"],
    ]);

    const fromCrmSide = findSharedCustomers([{ contactCrmId: 11, repKey: "1001" }], roster, pins, names).get(11) ?? [];
    assert.deepEqual(
      fromCrmSide.map((shared) => shared.repName),
      ["Mona Samir"],
      "a partner with no CRM account must be NAMED as the other half of a shared customer — keyed on the CRM id she could never be",
    );
    assert.deepEqual(fromCrmSide[0]?.contactCrmIds, [22], "and her row is carried out, so her check-ins reach the score");

    const fromHerSide = findSharedCustomers([{ contactCrmId: 22, repKey: "hr:b-40" }], roster, pins, names).get(22) ?? [];
    assert.deepEqual(
      fromHerSide.map((shared) => shared.repName),
      ["Ahmed Fathy"],
      "from her own list the shared customer is found too, and her own row is her, not a stranger",
    );

    const now = Date.parse("2026-09-14T12:00:00.000Z");
    const confirmed = scoreLocationConfidence(
      { lat: 30, lon: 31 },
      [
        { at: "2026-09-10T09:00:00.000Z", lat: 30, lon: 31, repKey: "1001" },
        { at: "2026-09-11T09:00:00.000Z", lat: 30, lon: 31, repKey: "hr:b-40" },
      ],
      now,
    );
    assert.equal(
      confirmed?.observers,
      2,
      "a rep with no CRM account who stood at the pin is a second observer — dropping his check-in told the popup only one rep had ever been there",
    );
  }

  // ── THE REP-NAME MAP MUST NOT BE BUILT FROM THE SUMMARIES ────────────────────────────────────
  // This one shipped and rendered NOTHING. getDoctorListRepSummaries constructs every row with
  // `name: ""` and never fills it — the name is resolved against the org tree by whichever board
  // is assembling the screen. Building the shared-customer name map from those summaries therefore
  // produced an empty map, and findSharedCustomers drops a match whose rep cannot be named (the
  // owner's rule: never print a raw id). So every match was discarded, on every rep, with no error
  // and no empty state — the board simply looked like a company with no shared customers.
  // Measured 2026-09-01: agent 1131 has 18 shared contacts and the screen showed 0.
  {
    const summaries = readFileSync("src/lib/crm/contact-lists.ts", "utf8");
    const board = readFileSync("src/lib/crm/reps-list-board.ts", "utf8");

    assert.ok(
      /name: "",/.test(summaries),
      "DoctorListRepSummary still carries an unfilled name — the hazard this pin guards is live, and if the loader ever starts resolving names this assertion is the place to say so",
    );

    const declaration = "const repNameByRepKey = new Map<string, string>();";
    const start = board.indexOf(declaration);
    assert.ok(
      start > 0,
      "the shared-customer rep-name map must exist, or no row can say who a customer is shared with",
    );
    const mapBlock = board.slice(start, board.indexOf("await getRepsListForAgent", start));
    assert.ok(
      !mapBlock.includes("summary.name"),
      "the rep-name map must NOT read summary.name: it is empty by construction, and an empty map silently discards every shared-customer match instead of failing",
    );
    assert.ok(
      mapBlock.includes("companyTree.reps"),
      "the map is built from the UNRESTRICTED org tree, the only source that both holds a rep's name and reaches past the viewer's own team",
    );
    assert.ok(
      !/\btree\.reps\b/.test(mapBlock),
      "the map must NOT read the scope-restricted `tree`: it holds the viewer's own reps alone, so a partner outside his team cannot be named and findSharedCustomers discards the match entirely",
    );
  }

  // ── THE NAME MAP MUST BE THE UNRESTRICTED TREE, NOT THE SCOPED ONE ───────────────────────────
  // The same failure a second time, one variable along, and PORTAL-ONLY — which is why it survived
  // review: /admin/reps-list runs at company scope, where restrictCoverageFilterTree is a no-op, so
  // the board looked right on the surface a reviewer opens. A District Manager's board is the one
  // that was blind.
  //
  // The chain is silent at every link. `tree` is restricted for the picker (correctly), the name map
  // was read off it, findSharedCustomers refuses to print a raw id and so DISCARDS a partner it
  // cannot name rather than degrading to "shared with someone", and the discarded entry is also what
  // carries `contactCrmIds` — so the partner's check-ins are never fetched and the confidence score
  // quietly loses its second observer too. No error, no empty state, no marker: a manager just sees
  // a company with no shared customers.
  //
  // Measured on production 2026-09-01: of 3,334 cross-rep same-name pairs 2,842 (85%) sit under a
  // different manager, and of the 62 shared-phone pairs ALL 62 do.
  //
  // Pinned as BEHAVIOUR and not only as source text, because the source pin above can only say which
  // identifier is read — it cannot show that reading the wrong one costs a real row.
  {
    const company = cascadeTree();
    // A District Manager whose team is Ahmed Fathy alone. Mohamed Adel is another manager's rep.
    const scopedToOwnTeam = restrictCoverageFilterTree(company, ["A-1"]);

    const agentByHrId = new Map([
      ["A-1", 1001],
      ["A-2", 2002],
    ]);
    const namesFrom = (source: { reps: readonly { hrId: string; repName: string }[] }) => {
      const names = new Map<string, string>();
      for (const rep of source.reps) {
        const agentCrmId = agentByHrId.get(rep.hrId);
        if (agentCrmId != null) names.set(String(agentCrmId), rep.repName);
      }
      return names;
    };

    assert.equal(
      namesFrom(scopedToOwnTeam).size,
      1,
      "the restricted tree holds the viewer's own rep alone — this is the trap, and it is invisible at company scope",
    );
    assert.equal(namesFrom(company).size, 2, "the company tree can name the partner rep");

    // One doctor, two reps, standing in the same place: exactly the shape the board tints violet.
    const roster: RosterEntry[] = [
      { repKey: "1001", contactCrmId: 11, name: "Dr Adel", nameKey: "dr adel", phoneKey: null, regionKey: null, speciality: "Pediatrics" },
      { repKey: "2002", contactCrmId: 22, name: "Dr Adel", nameKey: "dr adel", phoneKey: null, regionKey: null, speciality: "Pediatrics" },
    ];
    const pins = new Map([
      [11, { lat: 30, lon: 31 }],
      [22, { lat: 30, lon: 31 }],
    ]);
    const mine = [{ repKey: "1001", contactCrmId: 11 }];

    const withCompanyNames = findSharedCustomers(mine, roster, pins, namesFrom(company)).get(11) ?? [];
    const withScopedNames = findSharedCustomers(mine, roster, pins, namesFrom(scopedToOwnTeam)).get(11) ?? [];

    assert.equal(
      withCompanyNames.length,
      1,
      "with the company tree the shared customer is found and the partner rep can be named",
    );
    assert.deepEqual(
      withCompanyNames[0]?.contactCrmIds,
      [22],
      "and the partner's own contact row is carried out, which is what later fetches his check-ins for the confidence score",
    );
    assert.equal(
      withScopedNames.length,
      0,
      "PINNED: a scope-restricted name map finds NOTHING on identical data — the row loses its violet tint and the score loses the second rep, with nothing on screen saying so",
    );
  }

  // ── A SHARED CUSTOMER'S OTHER ROW MUST BE FETCHED, NOT JUST NAMED ────────────────────────────
  // The second bug of exactly this shape. `scoreLocationConfidence` counts distinct reps correctly,
  // but it can only count what it is HANDED, and the loader was handing it one contact row's own
  // check-ins. The CRM files a visit against the row of the rep who made it, so the other rep's
  // visits live under an id this row never fetched — and the popup told the owner "only one rep has
  // ever checked in here" directly beneath a violet line naming the second rep. A unit test on the
  // scorer cannot see this: it passes whatever points the caller invents. Only the wiring can be
  // pinned, so it is pinned here.
  {
    const loader = readFileSync("src/lib/crm/reps-list.ts", "utf8");
    const start = loader.indexOf("const partnerIds = new Set<number>();");
    assert.ok(
      start > 0,
      "the loader must gather the shared partners' own contact ids — without them a shared customer's second rep is invisible to the score",
    );
    const block = loader.slice(start, loader.indexOf("return groupContactsByBrick", start));
    assert.ok(
      block.includes("loadCheckins("),
      "the partner ids must be turned into real CHECK-INS. Collecting the ids and never fetching them is the failure this pin exists for: the row still says 'shared with X' while the score behind it has never seen one of X's visits",
    );
    assert.ok(
      /\.\.\.found\.points,\s*\.\.\.sharedPoints/.test(block),
      "the partner's visits must reach scoreLocationConfidence alongside our own, or the observer count cannot rise and the popup keeps contradicting the row above it",
    );
    assert.ok(
      block.includes("sharedRepNames"),
      "the reps whose visits were counted must be passed through so the popup can name them — folding another rep's evidence in silently is worse than not folding it in at all",
    );
  }

  // ── The two tabs, and one colour per neighbourhood ───────────────────────────────────────────
  {
    const board = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");

    assert.ok(
      board.includes('key: "pharmacies"') && board.includes('key: "contacts"'),
      "Contacts and Pharmacies must be separate tabs — the owner asked for them counted apart 'to avoid misleading', because a pharmacy is not a contact",
    );
    // Checked against CODE, not prose. The file explains in a comment WHY that option was
    // removed, so a bare includes() fails on the explanation — and a pin that matches a comment
    // is a pin that gets "fixed" by deleting the comment. Second time this shape has bitten this
    // very file; read the options list instead.
    const listFilters = board.match(/const LIST_FILTERS = \[([\s\S]*?)\] as const;/);
    assert.ok(listFilters, "the List filter options must stay a named list, or nothing here can read them");
    assert.ok(
      !/value: "Pharmacy"/.test(listFilters[1]),
      "the List filter must offer no pharmacy-only choice: it renders on the Contacts tab, where such an option empties the table by definition — the misleading the tabs were added to remove",
    );

    // ONE copy of the palette, in brick-tints.ts, shared with the Phoenix CRM List and the plan day.
    assert.ok(
      /import \{[^}]*\bneighbourTint\b[^}]*\} from "@\/components\/phoenix-crm\/brick-tints";/.test(board),
      "the Reps List reads the neighbourhood colours from the one shared palette, never a copy of its own",
    );
    assert.ok(!board.includes("const NEIGHBOUR_TINTS"), "no second copy on the Reps List");
    const palette = readFileSync("src/components/phoenix-crm/brick-tints.ts", "utf8").match(/export const NEIGHBOUR_TINTS = \[([\s\S]*?)\] as const;/);
    assert.ok(
      palette,
      "the neighbourhood palette must exist: the owner asked for one colour per neighbourhood, not one colour for all of them",
    );
    const fills = [...palette[1].matchAll(/fill: "([a-z0-9-]+)"/g)].map((match) => match[1]);
    assert.ok(fills.length >= 4, "too few hues and neighbouring blocks wrap onto the same colour");
    assert.equal(
      new Set(fills).size,
      fills.length,
      "every neighbourhood colour must be distinct — one repeated fill makes two blocks read as a single place",
    );
    assert.ok(
      !fills.some((fill) => /violet|amber|orange|emerald/.test(fill)),
      "violet already means shared customer, emerald and amber are the confidence bands, amber is also 'no brick yet' and orange is a link: reusing one makes a colour answer two questions at once",
    );
    assert.ok(
      fills.every((fill) => fill.endsWith("-100")),
      "the FILL has to carry the hue by itself. app/globals.css gives every .admin-shell cell a 1px orange hairline with !important — an owner-level rule drawing the house grid — so a border utility on a cell cannot show and must not be made to. At the -50 step the hues are indistinguishable, which is what sent the first attempt to the border in the first place",
    );
  }

  // ---------------------------------------------------------------------------------------------
  // PHOENIX INSIGHTS — the odd things about one record, one sentence each.
  //
  // The owner asked for this on 2026-09-01 and gave his own example: "any weird thing, like same
  // full match about forty kilometre away — highlight it... but be simple, use clear English, be to
  // the point, and don't prolong."
  //
  // What has to be pinned is the RESTRAINT, not the detection. Every one of these rules is trivial
  // to make fire, and each one measured on production would mark between 664 and 1,596 of 9,518
  // contacts if the gates came off — a chip on one row in six, which is wallpaper rather than a
  // signal, and the exact outcome his standing "don't make the page noisy" rule exists to prevent.
  // So the negative cases below matter more than the positive ones.
  {
    const at = (lat: number) => ({ lat, lon: 31 });
    // 111_320 m per degree of latitude, the constant the scorer uses — so these are exact.
    const northOf = (km: number) => at(30 + (km * 1000) / 111_320);
    const entry = (
      contactCrmId: number,
      agentCrmId: number,
      name: string,
      phone: string | null,
      speciality: string | null = null,
      region: string | null = null,
    ): RosterEntry => ({
      contactCrmId,
      name,
      nameKey: nameKey(name),
      phoneKey: phoneKey(phone),
      regionKey: region,
      repKey: String(agentCrmId),
      speciality,
    });
    const reps = new Map([
      ["10", "Mina Adel"],
      ["20", "Sara Ali"],
      ["30", "Karim Fouad"],
    ]);

    // THE OWNER'S OWN EXAMPLE: one distinctive name, two reps, forty kilometres apart.
    {
      const roster = [
        entry(1, 10, "Ahmed Fathy Nour", null, "Internal Medicine"),
        entry(2, 20, "Ahmed Fathy Nour", null, "Internal Medicine"),
      ];
      const pins = new Map([
        [1, at(30)],
        [2, northOf(40)],
      ]);
      const found = buildPhoenixInsights([{ repKey: "10", contactCrmId: 1, points: [] }], roster, pins, reps);
      const insights = found.get(1) ?? [];
      assert.equal(insights.length, 1, "a distinctive name forty kilometres away under another rep is the owner's own example of a weird thing and must be reported");
      assert.equal(insights[0].kind, "distant twin");
      assert.ok(
        insights[0].detail.includes("the same speciality"),
        `the owner asked the insight to say WHICH other field agrees, so he can tell a fraud from a coincidence: ${insights[0].detail}`,
      );
      assert.ok(
        insights[0].detail.includes("Sara Ali"),
        "the insight has to name the rep whose list the twin is on — a finding a reader cannot act on is not a finding",
      );
      assert.ok(
        insights[0].detail.includes("40.0 km"),
        `the distance is the whole point of this insight and must be stated: ${insights[0].detail}`,
      );
      // The sentence must not open with the rep's name. Rep names here can be Arabic, and a block
      // that starts with a strong RTL character flips an English sentence wholly right-to-left —
      // the bilingual trap in AGENTS.md 2.1, which has shipped through green checks twice.
      assert.ok(
        !insights[0].detail.startsWith("Sara Ali") && /^[A-Za-z]/.test(insights[0].detail),
        `every insight must open in English so an Arabic rep name cannot flip the line: ${insights[0].detail}`,
      );
    }

    // NOTHING ELSE AGREES, SO NOTHING IS SAID. The owner's second instruction on 2026-09-01 was to
    // check the speciality, the area and the phone as well as the name, "so I have many ways to
    // tell that this is a fraud or this is normal". This is the normal one: one rare name, two
    // cities, and every other field disagreeing — a paediatrician in Cairo and a urologist in
    // Tanta who happen to be namesakes. 266 of the 585 flagged contacts are this shape.
    {
      const roster = [
        entry(1, 10, "Ahmed Fathy Nour", "01001234567", "Pediatrics", "cairo"),
        entry(2, 20, "Ahmed Fathy Nour", "01009998888", "Urology", "tanta"),
      ];
      const pins = new Map([
        [1, at(30)],
        [2, northOf(40)],
      ]);
      const found = buildPhoenixInsights([{ repKey: "10", contactCrmId: 1, points: [] }], roster, pins, reps);
      assert.equal(
        found.has(1),
        false,
        "a shared rare name where the speciality, area and phone all disagree is two different doctors, and calling it weird is a coin toss printed as a finding",
      );
    }

    // THE PHONE SETTLES IT. Two records reachable on one number are one doctor, so the question is
    // no longer who these people are but which pin is wrong — and the sentence has to say so.
    {
      const roster = [
        entry(1, 10, "Ahmed Fathy Nour", "01001234567", "Pediatrics", "cairo"),
        entry(2, 20, "Ahmed Fathy Nour", "01001234567", "Urology", "tanta"),
      ];
      const pins = new Map([
        [1, at(30)],
        [2, northOf(40)],
      ]);
      const found = buildPhoenixInsights([{ repKey: "10", contactCrmId: 1, points: [] }], roster, pins, reps);
      const insights = found.get(1) ?? [];
      assert.equal(insights.length, 1, "one phone number on two records forty kilometres apart is the strongest evidence this board has that a pin is wrong");
      assert.ok(
        insights[0].detail.includes("the same phone number"),
        `the agreeing field must be named: ${insights[0].detail}`,
      );
      assert.ok(
        insights[0].detail.includes("one doctor on two lists"),
        `a phone match turns the finding from a question into a verdict, and the sentence must carry the verdict: ${insights[0].detail}`,
      );
    }

    // THE AREA AGREEING IS A CONTRADICTION ON ITS FACE — one locality cannot be forty kilometres
    // wide — and it must count even when the speciality disagrees.
    {
      const roster = [
        entry(1, 10, "Ahmed Fathy Nour", null, "Pediatrics", "mahalla"),
        entry(2, 20, "Ahmed Fathy Nour", null, "Urology", "mahalla"),
      ];
      const pins = new Map([
        [1, at(30)],
        [2, northOf(40)],
      ]);
      const found = buildPhoenixInsights([{ repKey: "10", contactCrmId: 1, points: [] }], roster, pins, reps);
      const insights = found.get(1) ?? [];
      assert.equal(insights.length, 1, "two records filed in one locality but pinned forty kilometres apart contradict each other whichever of them names the place");
      assert.ok(
        insights[0].detail.includes("the same area") && !insights[0].detail.includes("speciality"),
        `only the fields that actually agree may be listed — naming one that disagrees would be a false statement on screen: ${insights[0].detail}`,
      );
    }

    // ALL THREE AGREEING READS AS ONE ENGLISH LIST, not three clauses.
    {
      const roster = [
        entry(1, 10, "Ahmed Fathy Nour", "01001234567", "Pediatrics", "mahalla"),
        entry(2, 20, "Ahmed Fathy Nour", "01001234567", "Pediatrics", "mahalla"),
      ];
      const pins = new Map([
        [1, at(30)],
        [2, northOf(40)],
      ]);
      const found = buildPhoenixInsights([{ repKey: "10", contactCrmId: 1, points: [] }], roster, pins, reps);
      const insights = found.get(1) ?? [];
      assert.ok(
        (insights[0]?.detail ?? "").includes("the same phone number, area and speciality"),
        `three agreements are one list with one "the same", not three repetitions of it: ${insights[0]?.detail}`,
      );
    }

    // A COMMON NAME IS NOT EVIDENCE. Same distance, same two reps — but the name is carried by five
    // contacts company-wide, which in Egypt means five different doctors. 785 rows would carry a
    // chip without this gate; 390 do with it.
    {
      // Every one of them agrees on speciality, so ONLY the rare-name gate can be what silences
      // this — a fixture that would also be caught by the corroboration gate proves nothing.
      const roster = [
        entry(1, 10, "Mohamed Ahmed", null, "Internal Medicine"),
        entry(2, 20, "Mohamed Ahmed", null, "Internal Medicine"),
        entry(3, 30, "Mohamed Ahmed", null, "Internal Medicine"),
        entry(4, 30, "Mohamed Ahmed", null, "Internal Medicine"),
        entry(5, 20, "Mohamed Ahmed", null, "Internal Medicine"),
      ];
      const pins = new Map([
        [1, at(30)],
        [2, northOf(40)],
        [3, northOf(50)],
        [4, northOf(60)],
        [5, northOf(70)],
      ]);
      const found = buildPhoenixInsights([{ repKey: "10", contactCrmId: 1, points: [] }], roster, pins, reps);
      assert.equal(
        found.has(1),
        false,
        "a name five contacts share is not an identity, and flagging it would put a chip on a thousand rows",
      );
    }

    // A NEAR MATCH IS THE SHARED-CUSTOMER HIGHLIGHT'S JOB, NOT THIS ONE. The two rules meet at the
    // 200 m identity threshold and must never both fire on one pair: a row cannot be both "the same
    // customer as Sara's" and "suspiciously far from Sara's".
    {
      // Corroborated, so only the DISTANCE can be what silences it.
      const roster = [
        entry(1, 10, "Ahmed Fathy Nour", null, "Internal Medicine"),
        entry(2, 20, "Ahmed Fathy Nour", null, "Internal Medicine"),
      ];
      const pins = new Map([
        [1, at(30)],
        [2, northOf(0.8)],
      ]);
      const found = buildPhoenixInsights([{ repKey: "10", contactCrmId: 1, points: [] }], roster, pins, reps);
      assert.equal(found.has(1), false, "a same-name pair 800 m apart is a rep who pinned the next street, and is already handled by the shared-customer highlight");
    }

    // AN UNNAMEABLE REP IS SILENCE, NOT AN ID. The standing rule is that no screen prints a raw id
    // at a reader, so a twin under a rep nobody can name is dropped rather than described.
    {
      // Corroborated and far enough, so only the UNREADABLE REP NAME can be what silences it.
      const roster = [
        entry(1, 10, "Ahmed Fathy Nour", null, "Internal Medicine"),
        entry(2, 99, "Ahmed Fathy Nour", null, "Internal Medicine"),
      ];
      const pins = new Map([
        [1, at(30)],
        [2, northOf(40)],
      ]);
      const found = buildPhoenixInsights([{ repKey: "10", contactCrmId: 1, points: [] }], roster, pins, reps);
      assert.equal(found.has(1), false, "with no readable rep name the only sentence available names a raw agent id, which the owner's naming rule forbids");
    }

    // THE SAME NAME TWICE ON ONE REP'S OWN LIST. findSharedCustomers skips this by design — it is a
    // duplicate, not sharing — so nothing else on the board can see it.
    {
      const roster = [entry(1, 10, "Ahmed Fathy Nour", null), entry(2, 10, "Ahmed Fathy Nour", null)];
      const pins = new Map([
        [1, at(30)],
        [2, northOf(12)],
      ]);
      const found = buildPhoenixInsights([{ repKey: "10", contactCrmId: 1, points: [] }], roster, pins, reps);
      const insights = found.get(1) ?? [];
      assert.equal(insights.length, 1, "one rep carrying the same name on two rows is a duplicate and must be reported");
      assert.equal(insights[0].kind, "duplicate row");
      assert.ok(
        insights[0].detail.includes("twice") && insights[0].detail.includes("12.0 km apart"),
        `the duplicate line must say how many rows and how far apart: ${insights[0].detail}`,
      );
      assert.ok(
        !insights.some((insight) => insight.kind === "distant twin"),
        "a rep's own duplicate is never also a distant twin — the twin rule is about ANOTHER rep's list, and reporting both would say the same thing twice",
      );
    }

    // A SWITCHBOARD PHONE. Same threshold the identity matcher refuses a phone at, so the two can
    // never disagree about what a switchboard is.
    {
      const roster = [
        entry(1, 10, "Nadia Samir", "01001234567"),
        entry(2, 20, "Hala Mostafa", "01001234567"),
        entry(3, 20, "Omar Zaki", "01001234567"),
        entry(4, 30, "Yara Adel", "01001234567"),
        entry(5, 30, "Tarek Nabil", "01001234567"),
      ];
      const found = buildPhoenixInsights(
        [{ repKey: "10", contactCrmId: 1, points: [] }],
        roster,
        new Map([[1, at(30)]]),
        reps,
      );
      const insights = found.get(1) ?? [];
      assert.equal(insights.length, 1);
      assert.equal(insights[0].kind, "shared phone line");
      assert.ok(
        insights[0].detail.includes("5 different contacts"),
        `the count is what makes this readable as a switchboard rather than an accusation: ${insights[0].detail}`,
      );
    }

    // A PHONE ON TWO CONTACTS IS A DOCTOR REACHABLE ON ONE LINE. Thirty of the thirty-four shared
    // numbers in production are this shape, and flagging them would bury the one that matters.
    {
      const roster = [entry(1, 10, "Nadia Samir", "01001234567"), entry(2, 20, "Hala Mostafa", "01001234567")];
      const found = buildPhoenixInsights(
        [{ repKey: "10", contactCrmId: 1, points: [] }],
        roster,
        new Map([[1, at(30)]]),
        reps,
      );
      assert.equal(found.has(1), false, "two contacts on one number is normal and must stay quiet");
    }

    // A NUMBER ON DOZENS OF CONTACTS IS A BUILDING, AND SAYING SO ON EVERY ROW IS WALLPAPER. One
    // real rep's list came back 102 of 110 flagged off a single number carried by 101 contacts,
    // which buried that same list's six distant twins and one scattered contact. Above the cap the
    // finding is about the LIST, not the doctor, and a per-row chip is the wrong shape for it.
    {
      const roster = Array.from({ length: 40 }, (_unused, index) =>
        entry(index + 1, index === 0 ? 10 : 20, `Doctor ${index + 1} Distinctive`, "01001234567"),
      );
      const found = buildPhoenixInsights(
        [{ repKey: "10", contactCrmId: 1, points: [] }],
        roster,
        new Map([[1, at(30)]]),
        reps,
      );
      assert.equal(
        found.has(1),
        false,
        "a number on forty contacts is a hospital switchboard, and repeating that on all forty rows teaches the reader to ignore the chip",
      );
    }

    // CHECK-INS TOO FAR APART TO BE ONE PLACE.
    {
      const roster = [entry(1, 10, "Nadia Samir", null)];
      const rows = [{ repKey: "10", contactCrmId: 1, points: [at(30), northOf(60)] }];
      const found = buildPhoenixInsights(rows, roster, new Map([[1, at(30)]]), reps);
      const insights = found.get(1) ?? [];
      assert.equal(insights.length, 1);
      assert.equal(insights[0].kind, "scattered visits");
      assert.ok(insights[0].detail.includes("60.0 km"), `the spread must be stated: ${insights[0].detail}`);
    }

    // A THREE-KILOMETRE SPREAD IS ALREADY EXPLAINED NEXT DOOR, by the confidence popup's "what is
    // pulling the score down" line. 1,596 contacts are in that state and repeating it here would
    // mark a sixth of the board with something a reader can already see.
    {
      const roster = [entry(1, 10, "Nadia Samir", null)];
      const rows = [{ repKey: "10", contactCrmId: 1, points: [at(30), northOf(3)] }];
      assert.equal(
        buildPhoenixInsights(rows, roster, new Map([[1, at(30)]]), reps).has(1),
        false,
        "a 3 km spread is a doctor with two clinics and is already explained by the confidence popup",
      );
    }

    // A QUIET ROW IS ABSENT FROM THE MAP, not present with an empty list — the page reads presence,
    // so an empty array would render a chip promising a popup with nothing in it.
    {
      const roster = [entry(1, 10, "Nadia Samir", "01001234567"), entry(2, 20, "Hala Mostafa", null)];
      const found = buildPhoenixInsights(
        [{ repKey: "10", contactCrmId: 1, points: [at(30)] }],
        roster,
        new Map([[1, at(30)]]),
        reps,
      );
      assert.equal(found.size, 0, "a contact with nothing odd about it must carry no entry at all");
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The insights have to REACH the page. Every rule above is pure and provable, and all of it is
  // worth nothing if the loader never calls it or the board never renders the chip — the shape that
  // has already shipped once here, where a feature was green, deployed, and reachable by nobody.
  {
    const loader = readFileSync("src/lib/crm/reps-list.ts", "utf8");
    assert.ok(
      /buildPhoenixInsights\(/.test(loader),
      "the loader must actually build the insights: the pure rules above are unreachable otherwise",
    );
    assert.ok(
      /insights: insightsByContact\.get\(row\.contactCrmId\)/.test(loader),
      "the insights must be attached to the row — they cross the server-to-client boundary on the row itself, because a Map arrives as {} there",
    );
    assert.ok(
      /points: checkins\.get\(row\.contactCrmId\)\?\.points \?\? \[\]/.test(loader),
      "the scattered-visits rule needs this contact's own check-ins; passing an empty list would silently disable it with no error anywhere",
    );
    // THE ONE FAILURE NOTHING ELSE IN THIS FILE CAN SEE. Every twin now needs a second field to
    // agree before it is reported, and those two fields arrive from one SELECT in the roster
    // loader. Drop either of them and `agreementsBetween` returns an empty list for every pair on
    // the board, so the whole distant-twin rule goes quiet — with no error, no failing unit test,
    // and a page that looks exactly like a clean month. Pinned on the source because the loader is
    // IO and the rules above are pure, so nothing else here ever reads it.
    assert.ok(
      /contact:\$\{CRM_CONTACT_MASTER_TABLE\}\(name, phone, speciality, crm_region_name\)/.test(loader),
      "the roster must SELECT speciality and the CRM region: without them nothing corroborates a name match and every distant twin falls silent",
    );
    assert.ok(
      /regionKey: row\.crm_region_name/.test(loader) && /speciality: row\.speciality/.test(loader),
      "the roster must MAP speciality and the CRM region onto the entry — selecting a column and dropping it fails exactly as silently",
    );

    const board = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");
    const chip = board.match(/function InsightsChip\(\{[\s\S]*?\n\}/);
    assert.ok(chip, "the chip must exist — it is the only way into the popup");
    assert.ok(
      chip[0].includes(">\n      Phoenix insights\n"),
      "the label is the owner's own words and is exactly 'Phoenix insights' — he asked for that name and for nothing else to be shown until it is pressed",
    );
    assert.ok(
      /if \(!insights \|\| insights\.length === 0\) return null;/.test(chip[0]),
      "a row with nothing odd must render no chip at all: a chip on every row is the noise the owner's standing rule forbids",
    );
    assert.ok(
      chip[0].includes("bg-slate-900"),
      "the chip carries its meaning by SHAPE, in the slate the headers already use",
    );
    assert.ok(
      !/violet|emerald|rose|sky-|teal|lime|indigo/.test(chip[0]),
      "every one of those hues already means something else on this board — a tenth colour would be a SECOND meaning for a colour that already had one",
    );
    assert.ok(
      board.includes("<InsightsChip onOpen={onOpenInsights} row={row} />") &&
        board.includes("<InsightsChip onOpen={() => onOpenInsights(row)} row={row} />"),
      "the chip must render on BOTH halves — the desktop cell and the mobile card. The owner's golden rule is that this board works on a phone, and a finding only a laptop can see is half shipped",
    );
    assert.ok(
      board.includes("<InsightsDialog onClose={closeInsights} row={insightsFor} />"),
      "pressing the chip must open the popup: the owner asked for a pop up, not a page and not a column",
    );
    // ONE shell for both popups. Two hand-written dialogs drift, and the way they drift is that one
    // of them loses a way to close — on a phone, where the backdrop is the only obvious one.
    assert.equal(
      (board.match(/role="dialog"/g) ?? []).length,
      1,
      "both popups must go through the one DialogShell, so neither can lose its backdrop, its Escape key or its close button",
    );
  }

  // ── HAS PHOENIX ACTUALLY TRADED WITH THIS ROW? ───────────────────────────────────────────────
  //
  // The owner's ask, 2026-09-01: "if a pharmacy in the contact list and we meet direct order,
  // show", scoped a moment later to "two quantity ... I don't need the value now".
  //
  // Every rule below exists because the join it stands in for DOES NOT EXIST. Phoenix has no key
  // from a direct-order pharmacy to a CRM contact, so the match is inferred from the name — and a
  // name alone is catastrophically wrong here in a way that is invisible on screen: a badge reading
  // "1 direct order" is indistinguishable from a true one whichever row it lands on.
  {
    const party = (over: Partial<TradeCounterparty> = {}): TradeCounterparty => ({
      approved: 1,
      areaCode: "D21",
      channel: "direct-order",
      contactCrmId: null,
      count: 2,
      name: "المدينة",
      ...over,
    });

    // THE ELEVEN-PHARMACY CASE, THE REASON THIS MODULE IS AREA-GATED AT ALL. Measured on production
    // 2026-09-01: the direct-order venue `المدينة` name-matches ELEVEN CRM pharmacies, because "City
    // Pharmacy" is the "Main Street" of Egyptian pharmacy names. Exactly ONE of them is in the area
    // the order was raised in. Without the gate, ten reps are told they sold to a pharmacy they have
    // never sold to — and each of those ten badges looks exactly like the one true one.
    {
      const towns = ["D11", "D12", "D13", "D15", "D16", "D22", "D23", "D26", "GZ1", "GZ3"];
      const contacts = [
        { areaCode: "D21", contactCrmId: 1, name: "صيدلية المدينة" },
        ...towns.map((areaCode, index) => ({ areaCode, contactCrmId: index + 2, name: "صيدلية المدينة" })),
      ];
      const found = matchContactTrade(contacts, [party()]);
      assert.equal(found.size, 1, "a generic pharmacy name must attach to the ONE contact in the order's own area, never to all eleven namesakes");
      assert.equal(found.get(1)?.directOrders, 2, "and it must be the Belkas row — the one whose area matches the order");
    }

    // THE AREA IS A VETO, NOT A TIE-BREAK. Four production venues — مستشفى زمزم, احمد صالح, ريهام,
    // أيمن صالح — each share a name with a CRM row in a DIFFERENT area. They are different
    // businesses. A name match with no area agreement must produce nothing at all.
    {
      const found = matchContactTrade([{ areaCode: "AB2", contactCrmId: 1, name: "صيدلية المدينة" }], [party()]);
      assert.equal(found.size, 0, "same name in a different area is a different business, and showing a trade there is a false record");
    }

    // AN UNPLACEABLE COUNTERPARTY MATCHES NOTHING. 41% of CRM contacts resolve to no brick and so to
    // no area; a venue with no area is the same problem from the other side. Either way there is no
    // evidence, and the safe direction is silence.
    {
      const found = matchContactTrade(
        [{ areaCode: "D21", contactCrmId: 1, name: "صيدلية المدينة" }],
        [party({ areaCode: null })],
      );
      assert.equal(found.size, 0, "a venue Phoenix cannot place cannot corroborate anything, so it must attach to no row");
      const unplaceable = matchContactTrade([{ areaCode: null, contactCrmId: 1, name: "صيدلية المدينة" }], [party()]);
      assert.equal(unplaceable.size, 0, "a contact Phoenix cannot place is equally unmatched — the gate has to hold from both sides");
    }

    // THE ONE PLACE AMBIGUITY IS TOLERATED. Two CRM rows reading `حضانه نور المصطفي`, both in Shebeen
    // El Kom, are one nursery the CRM holds twice — a real production shape. The rep looking at
    // either copy should see the order, so an EXACT name in the SAME area attaches to all of them.
    {
      const found = matchContactTrade(
        [
          { areaCode: "D12", contactCrmId: 1, name: "حضانه نور المصطفي" },
          { areaCode: "D12", contactCrmId: 2, name: "حضانة نور المصطفى" },
        ],
        [party({ areaCode: "D12", approved: 1, count: 1, name: "حضانه نور المصطفي" })],
      );
      assert.equal(found.size, 2, "one venue duplicated in the CRM within a single town is still that venue, and both rows must carry its order");
    }

    // A PREFIX IS HOW REAL ORDERS ARE WRITTEN. A rep types the venue with its location appended, so
    // exact matching alone misses `ريهام عادل بلقاس ن` against the CRM's `صيدلية ريهام عادل` in
    // Belkas — a genuine production pair, and one of only a handful this board has at all.
    {
      const found = matchContactTrade(
        [{ areaCode: "D21", contactCrmId: 1, name: "صيدلية ريهام عادل" }],
        [party({ name: "ريهام عادل بلقاس ن" })],
      );
      assert.equal(found.get(1)?.directOrders, 2, "a venue written with its town appended is still that venue when nothing else in the area competes");
    }

    // AND THE PREFIX IS WHERE IT GOES WRONG. `محمد حسام` is a prefix of `محمد حسام على`, and
    // `انجي جاد` of `انجي جاد عبداللة` — both real, both in one area, both DIFFERENT doctors. A
    // prefix landing on more than one contact is not a weaker match, it is a question the data
    // cannot answer, so it must attach to NEITHER rather than to both or to an arbitrary one.
    {
      // No exact spelling anywhere, and the shorter name prefixes BOTH — so there is no basis to
      // choose, and choosing anyway would print a marketing request against a doctor who never had
      // one. Both surnames are held by real people in one area.
      const twoSurnames = [
        { areaCode: "UE5", contactCrmId: 1, name: "انجي جاد عبداللة" },
        { areaCode: "UE5", contactCrmId: 2, name: "انجي جاد محمود" },
      ];
      const found = matchContactTrade(twoSurnames, [
        party({ areaCode: "UE5", channel: "marketing", count: 3, name: "انجي جاد" }),
      ]);
      assert.equal(found.size, 0, "a prefix landing on two real doctors must attach to NEITHER: it is not a weaker match, it is a question the data cannot answer");

      // AND THIS IS WHAT SAVES THE PAIR IN PRODUCTION. The CRM really does hold `انجى جاد` beside
      // `انجي جاد عبداللة`, and `محمد حسام` beside `محمد حسام على`. Rule 2 fires on the exact
      // spelling and the longer namesake is never reached, so the ambiguity above never arises —
      // but only while exact keeps its precedence over prefix.
      const withExact = [{ areaCode: "UE5", contactCrmId: 3, name: "انجى جاد" }, ...twoSurnames];
      const exact = matchContactTrade(withExact, [
        party({ areaCode: "UE5", channel: "marketing", count: 3, name: "انجي جاد" }),
      ]);
      assert.equal(exact.size, 1, "an exact name must beat the prefix rule outright rather than being dragged into its ambiguity");
      assert.equal(exact.get(3)?.marketingRequests, 3, "and it must land on the exactly-named doctor, not on either longer namesake");
    }

    // A SHORT PREFIX IS NOT EVIDENCE. Without the floor, the four-letter `ريهام` would prefix-match
    // every `ريهام <surname>` in its area.
    {
      const found = matchContactTrade(
        [{ areaCode: "D21", contactCrmId: 1, name: "ريهام عادل" }],
        [party({ name: "ريهام" })],
      );
      assert.equal(found.size, 0, "a name too short to identify anybody must not fire the prefix rule, however unique it happens to be today");
    }

    // AN ID A HUMAN WROTE DOWN OUTRANKS EVERYTHING INFERRED — and is deliberately NOT area-gated,
    // because it already names one specific contact and there is nothing left to disambiguate.
    {
      const found = matchContactTrade(
        [{ areaCode: null, contactCrmId: 4242, name: "someone else entirely" }],
        [party({ areaCode: null, channel: "marketing", contactCrmId: 4242, count: 3, name: "unrelated" })],
      );
      assert.equal(found.get(4242)?.marketingRequests, 3, "an explicit crm_code must bind on its own, with no name or area test — a human recorded it and nothing inferred outranks that");
    }

    // THE TWO CHANNELS ARE COUNTED APART. A pharmacy's orders and a doctor's marketing requests are
    // different questions, and the owner asked for TWO quantities, not one total.
    {
      const found = matchContactTrade(
        [{ areaCode: "D12", contactCrmId: 7, name: "محمد جابر" }],
        [
          party({ areaCode: "D12", approved: 1, count: 2, name: "محمد جابر" }),
          party({ areaCode: "D12", approved: 0, channel: "marketing", count: 1, name: "محمد جابر" }),
        ],
      );
      const trade = found.get(7);
      assert.equal(trade?.directOrders, 2, "direct orders are their own count");
      assert.equal(trade?.marketingRequests, 1, "marketing requests are their own count, never folded into the orders");
      assert.equal(trade?.marketingRequestsApproved, 0, "and the approved figure is tracked per channel too — none of the 27 Phoenix marketing requests is approved");
    }

    // THE NORMALIZER'S THREE SYSTEMATIC DIFFERENCES. The CRM writes `صيدلية X` and `د. X` where an
    // order writes `X`; أ/إ/آ, ى/ي and ة/ه are the same letters carelessly typed. Each is a real
    // divergence between a list the CRM exported and a form a rep filled in.
    assert.equal(venueKey("صيدلية المدينة"), venueKey("المدينه"), "the CRM's صيدلية prefix and the ة/ه spelling must not separate a pharmacy from itself");
    assert.equal(venueKey("د. أحمد"), venueKey("احمد"), "the د. honorific and the أ/ا spelling must not separate a doctor from himself");
    assert.ok(venueKey("محمد حسام").includes(" "), "spaces must SURVIVE normalization: the prefix rule respects word boundaries, and fusing tokens would let one name prefix-match an unrelated longer one");
  }

  // ── THE WIRING, PINNED ON SOURCE ─────────────────────────────────────────────────────────────
  //
  // Each of these fails silently and identically: a board that renders perfectly and shows no trade
  // on any row, which is also what a quiet month looks like.
  {
    const loader = readFileSync("src/lib/crm/reps-list.ts", "utf8");
    assert.ok(
      /trade: tradeByContact\.get\(row\.contactCrmId\) \?\? null/.test(loader),
      "the trade must be ATTACHED to the row — computing it and dropping it leaves every badge missing with no error anywhere",
    );
    assert.ok(
      /areaCode: brickId \? \(metaByBrickId\.get\(brickId\)\?\.areaCode \?\? null\) : null/.test(loader),
      "the contact's area must come from the SAME brick resolution the grouping uses; resolving it a second way is how the badge and the group heading come to disagree",
    );

    const trade = readFileSync("src/lib/crm/contact-trade.ts", "utf8");
    // THE OWNER'S OWN SCOPING, 2026-09-01: "submitted through phoenix only, not import by xlsx".
    // The marketing tables carry a seeded catalogue far larger than the requests actually raised —
    // 286 of 332 pharmacies and 156 of 199 customers have no capture behind them — so losing this
    // filter would put a badge on rows nobody has ever traded with, which is the exact opposite of
    // what the board is for.
    assert.ok(
      /\.eq\("origin", "phoenix"\)/.test(trade),
      "marketing requests must stay scoped to origin=phoenix: the owner excluded the xlsx-imported catalogue explicitly, and it dwarfs the real requests",
    );

    const board = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");
    assert.ok(
      board.includes("<TradeLine row={row} />"),
      "the trade line must render on the board at all",
    );
    assert.equal(
      (board.match(/<TradeLine row=\{row\} \/>/g) ?? []).length,
      2,
      "it must render on BOTH halves — the desktop cell and the mobile card. The owner's golden rule is that this board works on a phone, and a trade record only a laptop can see cannot be checked standing in the pharmacy",
    );
    assert.ok(
      !/table-fixed[\s\S]{0,900}<col className="w-\[\d+%\]" \/>[\s\S]{0,60}<col[\s\S]{0,600}<th className=\{THEAD\}>Direct orders/.test(board),
      "the trade must NOT become a seventh column: the table is table-fixed at 100% and the owner's golden rule forbids a horizontal scroll, so it is merged into the Contact cell instead",
    );
  }

  // ── THE ONE DOOR'S LABEL (owner, 2026-10-31) ──────────────────────────────────────────────────────
  // Every screen that moved off iReports360 — the plan board, the rep's visit table, the venue picker —
  // prints a placed contact exactly as the Reps List heads his brick: "Brick · Area · Region", and never
  // the raw CRM region name.
  assert.equal(placementLabel({ name: "Dokki", areaCode: "G1", areaName: "Giza I", regionName: "Cairo" }), "Dokki · Giza I · Cairo");
  assert.equal(placementLabel({ name: "Dokki", areaCode: "G1", areaName: null, regionName: null }), "Dokki", "a missing part is left out, never printed empty");
  assert.equal(placementLabel(null), null, "no brick, no label — the caller falls back to the unmapped heading");
  {
    const door = readFileSync("src/lib/crm/reps-list.ts", "utf8");
    assert.match(
      door,
      /label: placementLabel\(hit\?\.meta \?\? null\) \?\? unmappedHeading\(row, index\)/,
      "an unplaced contact reads the Reps List's own unmapped heading, never \"No CRM region\"",
    );
    assert.match(door, /console\.warn\("\[reps-list\] contact placements unavailable/, "a failed placement read never fails the caller");
  }
}
