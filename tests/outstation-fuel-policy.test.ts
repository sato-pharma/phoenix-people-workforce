import assert from "node:assert/strict";

import {
  carTripFuelIsUnpriceable,
  UNPRICEABLE_CAR_TRIP_MESSAGE,
} from "../src/lib/outstation/fuel-policy.ts";

// Regression guard for the 2026-08-01 Routes API billing failure. Fuel is distance x 2 x rate;
// a failed distance lookup returned null, the calculation coerced it to 0, and the claim stored
// a real-looking 0.00 EGP fuel line that an approver could wave through — paying a rep nothing
// for a real drive. Submission is now refused instead.
export function runOutstationFuelPolicyTests() {
  // The failure this exists for.
  assert.equal(
    carTripFuelIsUnpriceable("car", null),
    true,
    "a car trip with no measurable distance must be BLOCKED — coercing null to 0 is what stored 0.00 EGP fuel on real drives",
  );
  assert.equal(
    carTripFuelIsUnpriceable("car", undefined),
    true,
    "undefined distance must block exactly like null",
  );

  // A measured zero is a real answer, not a missing one. Collapsing the two would be the same
  // bug pointing the other way: blocking legitimate submissions.
  assert.equal(
    carTripFuelIsUnpriceable("car", 0),
    false,
    "a MEASURED zero distance is priceable and must still submit — only a failed lookup blocks",
  );
  assert.equal(carTripFuelIsUnpriceable("car", 218.4), false, "a normal measured distance must submit");

  // Ticket-priced transport does not need a distance at all, so a dead geocoder must not take
  // train and bus claims down with it.
  assert.equal(
    carTripFuelIsUnpriceable("train", null),
    false,
    "train claims are priced from ticket amounts — a dead distance lookup must not block them",
  );
  assert.equal(
    carTripFuelIsUnpriceable("bus", null),
    false,
    "bus claims are priced from ticket amounts — a dead distance lookup must not block them",
  );
  assert.equal(carTripFuelIsUnpriceable(null, null), false, "an unset transport type must not block");

  // The message is what the rep sees, so it has to say what to do rather than just failing.
  assert.match(
    UNPRICEABLE_CAR_TRIP_MESSAGE,
    /could not be measured/,
    "the message must state the actual cause, not a generic failure",
  );
  assert.match(
    UNPRICEABLE_CAR_TRIP_MESSAGE,
    /contact HR/,
    "the message must give the rep a route forward when retrying does not help",
  );
}
