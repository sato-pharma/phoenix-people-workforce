import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { DoctorListRow } from "../src/lib/crm/contact-lists.ts";
import {
  buildCoverageFilterTree,
  narrowCoverageOptions,
  type CoverageFilterMapRow,
} from "../src/lib/crm/coverage-filters.ts";
import { DOCTOR_LIST_ACCESS_ROLES } from "../src/lib/crm/doctor-list-access.ts";
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
      grouped.groups.map((group) => [group.heading, group.contacts.map((contact) => contact.name)]),
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
      grouped.groups.map((group) => `${group.heading}:${group.contacts.length}:${group.mapped ? "mapped" : "open"}`),
      ["Bashteel:2:mapped", "Smouha:1:mapped", "Qena:3:open"],
      "mapped groups come first regardless of size, then largest first — the three-contact unmapped locality must not outrank a one-contact real brick",
    );
    assert.deepEqual(
      grouped.groups[0].contacts.map((contact) => contact.name),
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
      { am: 1, pharmacy: 1, pm: 2, total: 4 },
      "the three list types are counted apart; the board labels each row and can filter to one",
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
}
