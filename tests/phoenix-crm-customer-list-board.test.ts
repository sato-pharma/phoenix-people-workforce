import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";
import {
  buildGroups,
  displayOrder,
  distinct,
  gradeOf,
  groupOf,
  matchesActivity,
  matchesQuery,
  NO_GRADE,
  specialityOf,
  UNNAMED_BRICK,
  UNSPECIFIED,
} from "../src/lib/phoenix-crm/customer-list-grouping.ts";
import type { ListCustomer, ListPlace } from "../src/lib/phoenix-crm/server/list.ts";
import { listCustomer } from "./support/phoenix-crm-list-customer.ts";

/**
 * Phoenix CRM — the grouping and filtering that give the List tab's customer parts (To validate,
 * Your list, Outside the list and the Archive since 2026-09-29) the same look as the board (owner,
 * 2026-09-25: "make all the list tabs have the same features and tweaks").
 *
 * The screens are React, but the part a test can hold to is pure: one group per brick, unmapped
 * localities kept apart and named, a stable order the colour is keyed off, and the same six filters.
 * Break any of it and the board still renders — it just groups or hides the wrong customers — so each
 * rule is pinned here.
 */

function place(overrides: Partial<ListPlace> = {}): ListPlace {
  return {
    placeId: "p",
    label: null,
    address: null,
    brickId: null,
    brickName: null,
    brickDistanceKm: null,
    areaCode: null,
    areaName: null,
    regionCode: null,
    regionName: null,
    zone: null,
    lat: 0,
    lon: 0,
    accuracyMeters: null,
    timings: [],
    photoPath: "",
    capturedAt: "2026-09-01T00:00:00Z",
    clockOff: false,
    pointSource: "photo",
    pinReading: null,
    photoReading: null,
    moved: null,
    ...overrides,
  };
}

function customer(overrides: Partial<ListCustomer> = {}): ListCustomer {
  // The full field list lives in ONE place now (tests/support/phoenix-crm-list-customer.ts). Widening
  // `ListCustomer` breaks that annotated literal by name instead of this call site by field count.
  return listCustomer({ customerId: overrides.name ?? "c", ...overrides });
}

export function runPhoenixCrmCustomerListBoardTests() {
  // ── groupOf: a customer's first place decides his group ────────────────────────────────────────
  const mapped = customer({ places: [place({ brickId: "BR-1", brickName: "Maadi", areaName: "Cairo 1" })] });
  const mappedGroup = groupOf(mapped);
  assert.equal(mappedGroup.key, "BR-1", "a mapped place groups by its brick id");
  assert.equal(mappedGroup.heading, "Maadi");
  assert.equal(mappedGroup.areaName, "Cairo 1");
  assert.equal(mappedGroup.mapped, true, "a real brick is mapped");

  // No brick yet, but a locality on the place: grouped by that locality, NOT mapped, key lowercased.
  const byPlaceZone = groupOf(customer({ places: [place({ zone: "Nasr City" })] }));
  assert.equal(byPlaceZone.key, "loc:nasr city", "an unmapped locality is keyed on its lowered name");
  assert.equal(byPlaceZone.heading, "Nasr City", "the heading keeps the locality's own case");
  assert.equal(byPlaceZone.mapped, false);

  // A pending customer with no place YET still has a known brick from iReports360, and groups under it
  // as a real tinted brick — the owner's rule, 2026-09-26: "group the pending customers under their
  // known brick with a pending-capture tag." The amber "locality not yet mapped" heading is for a row
  // with no brick at all, which is why the two fallbacks below still exist. If precedence ever put the
  // locality first, every pending customer would go amber again — the exact thing this removed — and
  // the board would still render, just wrongly.
  const byRefBrick = groupOf(
    customer({
      places: [],
      reference: { address: null, city: "Tanta", zone: null, lastVisitedOn: null, brickId: "BR-7", brickName: "Tanta 1", areaName: "Gharbia" },
    }),
  );
  assert.equal(byRefBrick.key, "BR-7", "a pending customer groups under the brick iReports360 already carries for him, keyed on the brick id");
  assert.equal(byRefBrick.heading, "Tanta 1", "the heading is the brick's NAME, never its code — the owner's naming rule");
  assert.equal(byRefBrick.areaName, "Gharbia");
  assert.equal(byRefBrick.mapped, true, "a known brick is a real brick: tinted, ordered with the mapped ones, never the amber 'not yet mapped'");

  // A brick the master holds no name for keeps its id as the KEY and reads as words in the heading —
  // the raw code reached the board heading, the Brick filter and the export (audit, 2026-10-02).
  const unnamedPlaceBrick = groupOf(customer({ places: [place({ brickId: "BR-9", brickName: null })] }));
  assert.equal(unnamedPlaceBrick.key, "BR-9", "the unnamed brick is still grouped by its id");
  assert.equal(unnamedPlaceBrick.heading, UNNAMED_BRICK, "its heading is a name label, never the raw code");
  assert.equal(unnamedPlaceBrick.mapped, true);
  const unnamedRefBrick = groupOf(
    customer({ places: [], reference: { address: null, city: null, zone: null, lastVisitedOn: null, brickId: "BR-10", brickName: " ", areaName: null } }),
  );
  assert.equal(unnamedRefBrick.key, "BR-10");
  assert.equal(unnamedRefBrick.heading, UNNAMED_BRICK, "a blank reference brick name reads as the label too");

  // No brick anywhere, but a locality on the reference: fall back to that locality, NOT mapped, lowercased.
  const byRefCity = groupOf(customer({ places: [], reference: { address: null, city: "Tanta", zone: null, lastVisitedOn: null, brickId: null, brickName: null, areaName: null } }));
  assert.equal(byRefCity.key, "loc:tanta", "with no place AND no known brick, the reference city names the group");
  assert.equal(byRefCity.mapped, false);

  const nowhere = groupOf(customer({ places: [], reference: null }));
  assert.equal(nowhere.key, "none", "nothing to group on → the catch-all group");
  assert.equal(nowhere.heading, "No location yet");

  // ── buildGroups: appearance order, AM before PM, then name ─────────────────────────────────────
  const rows: ListCustomer[] = [
    customer({ name: "Zaki", listType: "PM", places: [place({ brickId: "BR-2", brickName: "Dokki" })] }),
    customer({ name: "Adel", listType: "PM", places: [place({ brickId: "BR-1", brickName: "Maadi" })] }),
    customer({ name: "Bahaa", listType: "AM", places: [place({ brickId: "BR-1", brickName: "Maadi" })] }),
    customer({ name: "Amr", listType: "PM", places: [place({ brickId: "BR-1", brickName: "Maadi" })] }),
  ];
  const groups = buildGroups(rows);
  assert.deepEqual(
    groups.map((g) => g.key),
    ["BR-2", "BR-1"],
    "groups appear in the order the customers first name them — the order the hue is keyed off, so it never moves as a filter narrows",
  );
  const maadi = groups.find((g) => g.key === "BR-1");
  assert.ok(maadi);
  assert.deepEqual(
    maadi.customers.map((c) => c.name),
    ["Bahaa", "Adel", "Amr"],
    "within a group AM (Bahaa) comes before PM, then PM by name (Adel, Amr)",
  );

  // ── displayOrder: bricks first, unmapped localities next, 'No location yet' last ───────────────
  const ordered = displayOrder([
    { key: "none", heading: "No location yet", areaName: null, mapped: false, customers: [] },
    { key: "loc:giza", heading: "Giza", areaName: null, mapped: false, customers: [] },
    { key: "BR-9", heading: "Heliopolis", areaName: "Cairo 2", mapped: true, customers: [] },
  ]);
  assert.deepEqual(
    ordered.map((g) => g.key),
    ["BR-9", "loc:giza", "none"],
    "territories before gaps: a mapped brick first, an unmapped locality next, the catch-all last",
  );

  // ── distinct: real values first, the placeholders last ─────────────────────────────────────────
  assert.deepEqual(
    distinct([UNSPECIFIED, "Cardiology", NO_GRADE, "A", "A"]),
    ["A", "Cardiology", NO_GRADE, UNSPECIFIED],
    "a filter lists real values first and the 'No grade'/'Unspecified' placeholders last, de-duplicated",
  );

  // ── gradeOf / specialityOf: trim, and name the blank ───────────────────────────────────────────
  assert.equal(gradeOf(customer({ grade: null })), NO_GRADE);
  assert.equal(specialityOf(customer({ speciality: "  " })), UNSPECIFIED, "an all-blank speciality is Unspecified, not a stray space");
  assert.equal(specialityOf(customer({ speciality: " Neurology " })), "Neurology", "a real speciality is trimmed");

  // ── matchesActivity: the two answers read off this month's visits ──────────────────────────────
  assert.equal(matchesActivity(customer({ visitsThisMonth: 0 }), ""), true, "no filter matches everyone");
  assert.equal(matchesActivity(customer({ visitsThisMonth: 0 }), "unvisited"), true);
  assert.equal(matchesActivity(customer({ visitsThisMonth: 3 }), "unvisited"), false);
  assert.equal(matchesActivity(customer({ visitsThisMonth: 3 }), "visited"), true);
  assert.equal(matchesActivity(customer({ visitsThisMonth: 0 }), "visited"), false);

  // ── matchesQuery: name, place fields and the reference, case-insensitive; empty matches all ─────
  const searchable = customer({
    name: "Dr Mona Adel",
    speciality: "Pediatrics",
    grade: "A" as ListCustomer["grade"],
    reference: { address: "12 El Nasr St", city: "Giza", zone: null, lastVisitedOn: null, brickId: null, brickName: null, areaName: null },
    places: [place({ label: "Sunrise Clinic", brickName: "Dokki", zone: "Mohandessin" })],
  });
  assert.equal(matchesQuery(searchable, ""), true, "an empty needle matches everyone");
  assert.equal(matchesQuery(searchable, "mona"), true, "matches the name, lower-cased");
  assert.equal(matchesQuery(searchable, "pediatrics"), true, "matches the speciality");
  assert.equal(matchesQuery(searchable, "sunrise"), true, "matches a place label");
  assert.equal(matchesQuery(searchable, "mohandessin"), true, "matches a place zone");
  assert.equal(matchesQuery(searchable, "el nasr"), true, "matches the iReports360 reference address");
  assert.equal(matchesQuery(searchable, "alexandria"), false, "a term that is nowhere does not match");

  // ── The export carries the rep's phone, as TEXT ─────────────────────────────────────────────────
  //
  // The columns and the rows are built inline in the JSX, so the source is what a test can hold to —
  // comments stripped first, so the explanation of a rule can never be mistaken for the rule itself.
  {
    const board = stripComments(readFileSync(new URL("../src/components/phoenix-crm/customer-list-board.tsx", import.meta.url), "utf8"));

    assert.ok(
      /\{ key: "phone", label: "Phone", text: true/.test(board),
      "the export has a Phone column carrying `text: true` — a phone is an identifier, so one retype must not turn 01012345678 into the number 1012345678, which is how 124 employee mobile numbers lost their leading zero",
    );
    assert.ok(board.includes('phone: customer.phone ?? "",'), "and every row carries the phone the rep typed");
    assert.equal(
      /phone: customer\.phone \?\? "—"/.test(board),
      false,
      "blank, not a dash: this sheet leaves the grade and the specialty empty too, and a dash would be exported as the customer's phone number",
    );

    const order = ["customer", "grade", "speciality", "phone", "list"].map((key) => board.indexOf(`{ key: "${key}",`));
    assert.ok(
      order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])),
      "the phone sits after the specialty and before the list, where the daily plan sheet puts it too",
    );
  }
}
