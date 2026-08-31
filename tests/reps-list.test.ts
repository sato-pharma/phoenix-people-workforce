import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { polishAddress } from "../src/lib/crm/address-polish.ts";
import type { DoctorListRow } from "../src/lib/crm/contact-lists.ts";
import {
  buildCoverageFilterTree,
  narrowCoverageOptions,
  type CoverageFilterMapRow,
} from "../src/lib/crm/coverage-filters.ts";
import { DOCTOR_LIST_ACCESS_ROLES } from "../src/lib/crm/doctor-list-access.ts";
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
import { pruneLineFirst, regionsForLine } from "../src/lib/crm/reps-list-board.ts";
import { groupContactsByBrick, type BrickIndex } from "../src/lib/crm/reps-list.ts";

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
      ["No CRM region recorded"],
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
  // The portal sidebar flag cannot import doctor-list-access.ts (it reaches the Supabase server
  // client through manager-scope.ts and is consumed by client components), so the role list is
  // spelled out twice. This is the assertion that keeps the copies honest: a role offered a sidebar
  // row the page then refuses is the exact "visible row he cannot open" bug the sidebar guards
  // elsewhere exist to catch, and it is invisible until someone in that role clicks it.
  {
    const PORTAL_REPS_LIST_ROLES = ["District Manager", "Regional Manager", "National Sales Manager"] as const;
    for (const role of PORTAL_REPS_LIST_ROLES) {
      assert.ok(
        (DOCTOR_LIST_ACCESS_ROLES as readonly string[]).includes(role),
        `${role} is offered the portal Reps List row, so the enforcing gate must admit them`,
      );
    }

    const navSource = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
    const flag = navSource.slice(navSource.indexOf("const showRepsListTab"));
    assert.ok(flag.length > 0, "the portal Reps List visibility flag must exist");
    for (const role of PORTAL_REPS_LIST_ROLES) {
      assert.ok(
        flag.slice(0, 400).includes(`"${role}"`),
        `the portal flag must name ${role} — the sidebar row and the gate are two hand-maintained lists`,
      );
    }
    assert.ok(
      !flag.slice(0, 400).includes("isDistrictManager"),
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

    const once = scoreLocationConfidence(pin, [{ agentCrmId: 1, at: daysAgo(10), lat: 30, lon: 31 }], now);
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
        { agentCrmId: 1, at: daysAgo(5), lat: 30, lon: 31 },
        { agentCrmId: 1, at: daysAgo(9), lat: 30.0001, lon: 31 },
        { agentCrmId: 2, at: daysAgo(20), lat: 30, lon: 31.0001 },
        { agentCrmId: 2, at: daysAgo(30), lat: 30, lon: 31 },
        { agentCrmId: 2, at: daysAgo(40), lat: 30.0002, lon: 31 },
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
        { agentCrmId: 1, at: daysAgo(5), lat: 30, lon: 31 },
        { agentCrmId: 1, at: daysAgo(6), lat: 30, lon: 31 },
        { agentCrmId: 1, at: daysAgo(7), lat: 30.05, lon: 31 },
        { agentCrmId: 1, at: daysAgo(8), lat: 30.05, lon: 31 },
        { agentCrmId: 1, at: daysAgo(9), lat: 30.05, lon: 31 },
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
    const lone = scoreLocationConfidence(pin, [{ agentCrmId: 1, at: daysAgo(5), lat: 30, lon: 31 }, { agentCrmId: 1, at: daysAgo(6), lat: 30, lon: 31 }], now);
    const withPartner = scoreLocationConfidence(
      pin,
      [
        { agentCrmId: 1, at: daysAgo(5), lat: 30, lon: 31 },
        { agentCrmId: 1, at: daysAgo(6), lat: 30, lon: 31 },
        { agentCrmId: 2, at: daysAgo(7), lat: 30, lon: 31 },
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
        { agentCrmId: 1, at: daysAgo(5), lat: 30, lon: 31 },
        { agentCrmId: 1, at: daysAgo(6), lat: 30, lon: 31 },
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
        { agentCrmId: 1, at: daysAgo(5), lat: 30, lon: 31 },
        { agentCrmId: 1, at: daysAgo(6), lat: 30.05, lon: 31 },
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
        { agentCrmId: 1, at: daysAgo(5), lat: 30, lon: 31 },
        { agentCrmId: 1, at: daysAgo(7), lat: 30, lon: 31 },
      ],
      now,
    );
    const twoReps = scoreLocationConfidence(
      pin,
      [
        { agentCrmId: 1, at: daysAgo(5), lat: 30, lon: 31 },
        { agentCrmId: 2, at: daysAgo(7), lat: 30, lon: 31 },
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

  // ── SHARING IS AN IDENTITY JUDGEMENT, AND A NAME IS NOT AN IDENTITY ──────────────────────────
  // Measured on production 2026-09-01: 69% of same-name cross-rep contact pairs stand over 5 km
  // apart. Matching on the name alone would have painted hundreds of rows violet and told the owner
  // that unrelated doctors who happen to share a common Egyptian name are the same customer.
  {
    const repNames = new Map([
      [10, "Mahmoud Alslamony"],
      [20, "Omnia Ismael"],
    ]);
    const entry = (agentCrmId: number, contactCrmId: number, name: string, phone: string | null): RosterEntry => ({
      agentCrmId,
      contactCrmId,
      name,
      nameKey: nameKey(name),
      phoneKey: phoneKey(phone),
    });
    const mine = [{ agentCrmId: 10, contactCrmId: 101 }];
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

    const declaration = "const repNameByAgentId = new Map<number, string>();";
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
      mapBlock.includes("tree.reps"),
      "the map is built from the org tree, the only source that actually holds a rep's name — and unscoped on purpose, because a shared customer's other half is by definition on another rep's list",
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

    const palette = board.match(/const NEIGHBOUR_TINTS = \[([\s\S]*?)\] as const;/);
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
}
