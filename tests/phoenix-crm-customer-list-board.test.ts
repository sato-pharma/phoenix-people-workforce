import assert from "node:assert/strict";

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
  UNSPECIFIED,
} from "../src/lib/phoenix-crm/customer-list-grouping.ts";
import type { ListCustomer, ListPlace } from "../src/lib/phoenix-crm/server/list.ts";

/**
 * Phoenix CRM — the grouping and filtering that give the List tab's three customer parts (To
 * validate, Customers, Left the list) the same look as the board (owner, 2026-09-25: "make all the
 * list tabs have the same features and tweaks").
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
    ...overrides,
  };
}

function customer(overrides: Partial<ListCustomer> = {}): ListCustomer {
  return {
    customerId: overrides.name ?? "c",
    listType: "PM",
    name: "Dr Test",
    speciality: null,
    grade: null,
    origin: "reference",
    referenceContactCrmId: null,
    status: "active",
    validatedAt: null,
    validatedByName: null,
    reference: null,
    droppedReason: null,
    droppedNote: null,
    statusChangedAt: "2026-09-01T00:00:00Z",
    places: [],
    visitsThisMonth: 0,
    target: null,
    tier: 0,
    pendingGradeRequestId: null,
    pendingGrade: null,
    pendingDropRequestId: null,
    primaryPharmacyName: null,
    pharmacies: [],
    ...overrides,
  };
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

  // No place at all (a pending customer): fall back to the iReports360 reference's city, then zone.
  const byRefCity = groupOf(customer({ places: [], reference: { address: null, city: "Tanta", zone: null, lastVisitedOn: null } }));
  assert.equal(byRefCity.key, "loc:tanta", "with no place, the reference city names the group");
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
    reference: { address: "12 El Nasr St", city: "Giza", zone: null, lastVisitedOn: null },
    places: [place({ label: "Sunrise Clinic", brickName: "Dokki", zone: "Mohandessin" })],
  });
  assert.equal(matchesQuery(searchable, ""), true, "an empty needle matches everyone");
  assert.equal(matchesQuery(searchable, "mona"), true, "matches the name, lower-cased");
  assert.equal(matchesQuery(searchable, "pediatrics"), true, "matches the speciality");
  assert.equal(matchesQuery(searchable, "sunrise"), true, "matches a place label");
  assert.equal(matchesQuery(searchable, "mohandessin"), true, "matches a place zone");
  assert.equal(matchesQuery(searchable, "el nasr"), true, "matches the iReports360 reference address");
  assert.equal(matchesQuery(searchable, "alexandria"), false, "a term that is nowhere does not match");
}
