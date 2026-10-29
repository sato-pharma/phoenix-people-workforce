import assert from "node:assert/strict";

import {
  chooseKpiDoctorBricks,
  chooseWantedKpiDoctorBricks,
  type KpiBrickCustomer,
  type KpiBrickPlace,
} from "../src/lib/crm/kpis-doctor-bricks.ts";

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
  const noPlace = chooseKpiDoctorBricks([customer()], []);
  assert.equal(noPlace.has(501), true, "a validated customer with no active place is still validated");
  assert.equal(noPlace.get(501), null);

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
}
