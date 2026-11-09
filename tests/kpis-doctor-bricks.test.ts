import assert from "node:assert/strict";

import {
  chooseKpiDoctorBricks,
  chooseWantedKpiDoctorBricks,
  type KpiBrickCustomer,
  type KpiBrickPlace,
} from "../src/lib/crm/kpis-doctor-bricks.ts";
import { readFileSync } from "node:fs";

import { chooseValidatedDates, chooseValidatedPlacePoints } from "../src/lib/crm/validated-place-points.ts";

/**
 * The brick each doctor on a rep's Coverage and Frequency list is filed under (owner, 2026-10-29: "the
 * brick is derived from the live photo validation"). The chooser is the whole decision, so it is pinned
 * here with no database near it. Every case fails as a plausible screen — a doctor in the wrong brick,
 * or a validated doctor printed as "not validated yet" — never as an error.
 */

function customer(overrides: Partial<KpiBrickCustomer> = {}): KpiBrickCustomer {
  return {
    id: "c-1",
    status: "active",
    validated_at: "2026-09-01T09:00:00Z",
    reference_contact_crm_id: 501,
    own_contact_crm_id: null,
    ...overrides,
  };
}

function place(overrides: Partial<KpiBrickPlace> = {}): KpiBrickPlace {
  return { customer_id: "c-1", brick_name: "Heliopolis", created_at: "2026-09-01T09:00:00Z", ...overrides };
}

export function runKpiDoctorBrickChooserTests() {
  // The plain case, and the contact a rep minted himself.
  assert.deepEqual(
    [...chooseKpiDoctorBricks([customer(), customer({ id: "c-2", reference_contact_crm_id: null, own_contact_crm_id: 902 })], [place(), place({ customer_id: "c-2", brick_name: "Maadi" })])],
    [
      [501, "Heliopolis"],
      [902, "Maadi"],
    ],
  );

  // The placeholder contact and an unvalidated row are nobody's brick.
  assert.equal(chooseKpiDoctorBricks([customer({ reference_contact_crm_id: 100000 })], [place()]).size, 0, "the placeholder contact is no doctor");
  assert.equal(chooseKpiDoctorBricks([customer({ validated_at: null })], [place()]).size, 0, "no validation, no brick");

  // A customer still on a list beats a dropped one, even a later-validated dropped one.
  const dropped = chooseKpiDoctorBricks(
    [customer({ id: "old", status: "Dropped", validated_at: "2026-10-01T09:00:00Z" }), customer({ id: "live", validated_at: "2026-08-01T09:00:00Z" })],
    [place({ customer_id: "old", brick_name: "Shubra" }), place({ customer_id: "live", brick_name: "Zamalek" })],
  );
  assert.equal(dropped.get(501), "Zamalek", "the dropped customer loses to the one still on a list");

  // Two live customers: the latest validation wins.
  const latest = chooseKpiDoctorBricks(
    [customer({ id: "first", validated_at: "2026-08-01T09:00:00Z" }), customer({ id: "second", validated_at: "2026-09-15T09:00:00Z" })],
    [place({ customer_id: "first", brick_name: "Dokki" }), place({ customer_id: "second", brick_name: "Mohandessin" })],
  );
  assert.equal(latest.get(501), "Mohandessin", "the newest validation wins");

  // Among one customer's active places: a place with a brick beats one without, then the earliest.
  assert.equal(
    chooseKpiDoctorBricks([customer()], [place({ brick_name: null, created_at: "2026-08-01T09:00:00Z" }), place({ brick_name: "Heliopolis", created_at: "2026-09-20T09:00:00Z" })]).get(501),
    "Heliopolis",
    "a place with a brick beats one without, however early",
  );
  assert.equal(
    chooseKpiDoctorBricks([customer()], [place({ brick_name: "Nasr City", created_at: "2026-09-20T09:00:00Z" }), place({ brick_name: "Heliopolis", created_at: "2026-09-01T09:00:00Z" })]).get(501),
    "Heliopolis",
    "the earliest place is the validation photo itself",
  );

  // Validated with no brick on record: in the map as null, never missing (missing reads "not validated yet").
  const noBrick = chooseKpiDoctorBricks([customer()], [place({ brick_name: "  " })]);
  assert.equal(noBrick.has(501), true);
  assert.equal(noBrick.get(501), null, "a blank brick is no brick");
  // No live place, no live photo behind the validation (owner, 2026-10-29: "Not validated yet") — a
  // customer whose places were all retired reads exactly like one never validated: missing from the map.
  const noPlace = chooseKpiDoctorBricks([customer()], []);
  assert.equal(noPlace.has(501), false, "a validated customer with no active place left reads Not validated yet");
  // And a doctor validated twice is validated on the customer that still has a live place, even a
  // dropped one, rather than called not validated because the listed customer's place was retired.
  const liveElsewhere = chooseKpiDoctorBricks(
    [customer({ id: "listed-retired" }), customer({ id: "dropped-live", status: "Dropped", validated_at: "2026-08-01T09:00:00Z" })],
    [place({ customer_id: "dropped-live", brick_name: "Ain Shams" })],
  );
  assert.equal(liveElsewhere.get(501), "Ain Shams", "the customer with the live photo carries the doctor's brick");

  // Above 600 doctors the board reads every validated customer and active place and narrows the answer
  // (owner, 2026-10-29: one brick read for the whole team). It must give each doctor asked for the brick
  // the chunked read gives him: the chunked read asks for customers by either contact id, then for those
  // customers' places. A customer carrying both ids is filed under the carried-over one by both paths.
  const pool = [
    customer({ id: "a", reference_contact_crm_id: 501 }),
    customer({ id: "b", reference_contact_crm_id: null, own_contact_crm_id: 902 }),
    customer({ id: "both", reference_contact_crm_id: 700, own_contact_crm_id: 903 }),
    customer({ id: "other", reference_contact_crm_id: 800 }),
    customer({ id: "dropped-501", status: "Dropped", validated_at: "2026-10-20T09:00:00Z", reference_contact_crm_id: 501 }),
  ];
  const poolPlaces = [
    place({ customer_id: "a", brick_name: "Heliopolis" }),
    place({ customer_id: "b", brick_name: "Maadi" }),
    place({ customer_id: "both", brick_name: "Dokki" }),
    place({ customer_id: "other", brick_name: "Shubra" }),
    place({ customer_id: "dropped-501", brick_name: "Zamalek" }),
  ];
  const asked = [501, 902, 903, 640];
  const chunkedCustomers = pool.filter(
    (row) => asked.includes(row.reference_contact_crm_id ?? -1) || asked.includes(row.own_contact_crm_id ?? -1),
  );
  const chunkedIds = new Set(chunkedCustomers.map((row) => row.id));
  const chunked = chooseKpiDoctorBricks(chunkedCustomers, poolPlaces.filter((row) => chunkedIds.has(row.customer_id)));
  const whole = chooseWantedKpiDoctorBricks(asked, pool, poolPlaces);
  for (const contactId of asked) {
    assert.equal(whole.has(contactId), chunked.has(contactId), `doctor ${contactId} is validated on both read paths or on neither`);
    assert.equal(whole.get(contactId), chunked.get(contactId), `doctor ${contactId} gets the same brick on both read paths`);
  }
  assert.deepEqual(
    [...whole].sort(([a], [b]) => a - b),
    [
      [501, "Heliopolis"],
      [902, "Maadi"],
    ],
    "the whole read holds only the doctors asked for — never the rest of the company",
  );

  // The Reps List stands each validated doctor on the SAME place the brick above comes from (owner,
  // 2026-10-31: "use the validation pin"), so the brick he is counted in and the neighbours he is
  // painted with come from one photo. Its point, its address and the validation date — nothing else.
  const located = (
    overrides: Partial<KpiBrickPlace> & { address?: string | null; brick_id?: string | null; lat?: number | null; lon?: number | null },
  ) => ({
    address: "Kom Hamada, Behira",
    brick_id: null as string | null,
    lat: 30.76,
    lon: 30.7,
    ...place(overrides),
    ...overrides,
  });
  const points = chooseValidatedPlacePoints(
    [customer({ validated_at: "2026-10-20T08:00:00Z" })],
    [
      located({ brick_name: "Nasr City", created_at: "2026-10-25T09:00:00Z", lat: 30.9, lon: 30.9 }),
      located({ brick_name: "Heliopolis", created_at: "2026-10-20T08:00:00Z" }),
    ],
  );
  assert.deepEqual(
    points.get(501),
    { address: "Kom Hamada, Behira", lat: 30.76, lon: 30.7, validatedAt: "2026-10-20T08:00:00Z" },
    "the validation photo's own place is the doctor's point — the earliest, the one his brick is read from — and it carries no accuracy or reading",
  );
  assert.equal(
    chooseValidatedPlacePoints([customer()], [located({ lat: 0, lon: 0 })]).has(501),
    false,
    "a point outside Egypt is no point: the row falls back to its check-ins rather than pinning a doctor in the sea",
  );
  assert.equal(
    chooseValidatedPlacePoints([customer({ validated_at: null })], [located({})]).has(501),
    false,
    "a doctor not validated yet has no validation pin",
  );

  // ── "IN REP LIST SHOW WHAT'S VALIDATED" (owner, 2026-11-09) ─────────────────────────────────────────
  // Every validated, not-dropped customer is validated on the Reps List — WITH OR WITHOUT a usable place,
  // because a doctor validated with a poor fix is still validated. Two customers on one contact: the
  // earliest validation answers. A dropped customer is not validated on anyone's list.
  const dates = chooseValidatedDates([
    customer({ id: "c-1", validated_at: "2026-10-20T08:00:00Z" }),
    customer({ id: "c-2", validated_at: "2026-10-02T08:00:00Z" }),
    customer({ id: "c-3", reference_contact_crm_id: 777, validated_at: null }),
    customer({ id: "c-4", reference_contact_crm_id: 778, status: "dropped" }),
    customer({ id: "c-5", reference_contact_crm_id: null, own_contact_crm_id: 903 }),
  ]);
  assert.deepEqual(
    [...dates].sort(([left], [right]) => left - right),
    [
      [501, "2026-10-02T08:00:00Z"],
      [903, "2026-09-01T09:00:00Z"],
    ],
    "validated: the earliest date per contact, a rep-added contact too; not validated: null date or dropped",
  );
  assert.equal(
    chooseValidatedPlacePoints([customer()], [located({ lat: 0, lon: 0 })]).has(501),
    false,
    "a validated doctor whose photo has no usable pin has no point…",
  );
  assert.ok(chooseValidatedDates([customer()]).has(501), "…yet he still reads Validated on the Reps List");

  // The board draws the chip, the brick count and the filter only when the read worked, and a failed
  // read says so once — never "Not validated yet" against every doctor.
  const board = readFileSync("src/components/crm/reps-list-tables.tsx", "utf8");
  assert.ok(board.includes("const showValidation = validationRead === true;"), "the validation signals are drawn only on a read that worked");
  assert.ok(board.includes("{validationRead === false ? ("), "a failed read is said once, above the list");
  assert.ok(board.includes("(!showValidation || matchesValidation(row, validation))"), "the Validation filter narrows the rows");
  assert.ok(
    readFileSync("src/components/crm/reps-list-board.tsx", "utf8").includes("validationRead={list.validationRead}"),
    "the manager Reps List passes the read through; Phoenix CRM's own My List does not",
  );
}
