/**
 * The Pedia NSM page audit (owner, 2026-10-26), pinned.
 *
 *   1. One trip is claimed once. OUTSTATION-292 (confirmed by HR) and OUTSTATION-293 (pending) are one
 *      District Manager's one drive to Asyut 2 on 22 Oct 2026; the copy asked for a second fuel line.
 *      Submission now refuses a same-person, same-day, same-destination copy, and the approvals screen
 *      flags every pair already stored. A refused claim never blocks, and Meeting / Other claims are
 *      not trips.
 *   2. Display tidy-ups the audit named: "Delta (1)" / "Sohag1" read "Delta 1" / "Sohag 1"; a word
 *      typed in lower case inside a proper name gets its capital; a CRM handle with no name reads as
 *      its territory's rep; a "-" HR note is no note; "1 request" / "2 requests"; the old CRM's day
 *      reads as a sentence.
 */
import assert from "node:assert/strict";

import { meaningfulHrText, PORTAL_LEDGER_NO_REPLY_NOTE } from "@/lib/deductions/portal-ledger-filters";
import { tidyAllCapitalsName } from "@/lib/employees/display-name";
import { crmDayLabel } from "@/lib/field-absence/server/evidence";
import { countOf } from "@/lib/i18n/format";
import { displayPlaceName } from "@/lib/org/place-name";
import { crmRepDisplayName } from "@/lib/crm/rep-name";
import {
  duplicateTripMessage,
  findDuplicateTrip,
  flagDuplicateTripRows,
  type DuplicateTripExisting,
} from "@/lib/outstation/duplicate-trip-guard";

// OUTSTATION-292 as stored on production (accepted by HR), and the copy 293 tried to be.
const trip292: DuplicateTripExisting = {
  capturedLatitude: 27.1809,
  capturedLongitude: 31.1837,
  employeeHrId: "PD-0015",
  expenseType: "outstation",
  id: 292,
  status: "accepted_by_admin",
  toArea: "Asyut 2",
  toCity: "Asyut",
  tripStartDate: "2026-10-22",
};
const copy293 = {
  capturedLatitude: 27.1809,
  capturedLongitude: 31.1837,
  employeeHrId: "pd-0015",
  expenseType: "outstation",
  toArea: "Asyut 2",
  toCity: "Asyut",
  tripStartDate: "2026-10-22T08:14:00Z",
};

export async function runOutstationDuplicateTripGuardTests() {
  // ── 1. Submission refuses the copy, naming the earlier claim ──────────────────────────────────────
  {
    const found = findDuplicateTrip(copy293, [trip292]);
    assert.equal(found?.id, 292, "the 293 copy of 292 — same person, day and area — must be refused");
    const words = duplicateTripMessage(trip292);
    assert.match(words, /OUTSTATION-292/, "the refusal names the claim that already covers the trip");
    assert.match(words, /22 Oct 2026/);
    assert.match(words, /Asyut 2/);

    // The request being re-submitted never blocks its own edit.
    assert.equal(findDuplicateTrip(copy293, [trip292], 292), null);

    // A different area on the same day is a different trip.
    assert.equal(findDuplicateTrip({ ...copy293, toArea: "Sohag 1", toCity: "Sohag" }, [trip292]), null);
    // A different day is a different trip.
    assert.equal(findDuplicateTrip({ ...copy293, tripStartDate: "2026-10-23" }, [trip292]), null);
    // Someone else's trip to the same place is not a copy.
    assert.equal(findDuplicateTrip({ ...copy293, employeeHrId: "PD-0016" }, [trip292]), null);

    // A refused claim never paid, so it never blocks claiming the trip properly.
    for (const status of ["rejected_by_admin", "rejected_by_system", "draft", "cancelled"]) {
      assert.equal(findDuplicateTrip(copy293, [{ ...trip292, status }]), null, `a ${status} claim must not block`);
    }
    // Meeting and Other claims are not trips — several on a day are normal, on either side.
    assert.equal(findDuplicateTrip({ ...copy293, expenseType: "meeting" }, [trip292]), null);
    assert.equal(findDuplicateTrip(copy293, [{ ...trip292, expenseType: "other" }]), null);

    // With no area or city on a side, the captured points decide: same spot matches, 5 km off does not.
    const unnamed = { ...copy293, toArea: null, toCity: null };
    assert.equal(findDuplicateTrip(unnamed, [{ ...trip292, toArea: null, toCity: null }])?.id, 292);
    assert.equal(
      findDuplicateTrip({ ...unnamed, capturedLatitude: 27.2259 }, [{ ...trip292, toArea: null, toCity: null }]),
      null,
      "two unnamed trips 5 km apart are two trips",
    );

    // The earliest live claim is the one named.
    assert.equal(findDuplicateTrip(copy293, [{ ...trip292, id: 300 }, trip292])?.id, 292);
  }

  // ── 2. The approvals screen flags the stored pair, both ways ──────────────────────────────────────
  {
    const row = (tripId: string, extra: Record<string, unknown> = {}) => ({
      capturedLatitude: 27.1809,
      capturedLongitude: 31.1837,
      date: "2026-10-22",
      hrId: "PD-0015",
      location: "Asyut 2",
      status: "Pending",
      to: "Asyut",
      tripId,
      tripType: "outstation",
      ...extra,
    });
    const flags = flagDuplicateTripRows([
      row("OUTSTATION-292", { status: "Confirmed by HR" }),
      row("OUTSTATION-293"),
      row("OUTSTATION-294", { location: "Sohag 1", to: "Sohag", capturedLatitude: 26.5569, capturedLongitude: 31.6948 }),
      row("OUTSTATION-295", { tripType: "meeting" }),
    ]);
    assert.deepEqual(flags.get("OUTSTATION-292"), ["OUTSTATION-293"]);
    assert.deepEqual(flags.get("OUTSTATION-293"), ["OUTSTATION-292"]);
    assert.equal(flags.has("OUTSTATION-294"), false, "the same day in another area is not flagged");
    assert.equal(flags.has("OUTSTATION-295"), false, "a meeting claim is not a trip");

    const afterRejection = flagDuplicateTripRows([row("OUTSTATION-292"), row("OUTSTATION-293", { status: "Rejected" })]);
    assert.equal(afterRejection.size, 0, "once HR refused the copy, the other claim is the trip — no flag");
  }

  // ── 3. Names and labels the audit named ───────────────────────────────────────────────────────────
  {
    assert.equal(displayPlaceName("Delta (1)"), "Delta 1");
    assert.equal(displayPlaceName("Sohag1"), "Sohag 1");
    assert.equal(displayPlaceName("Upper Egypt 1"), "Upper Egypt 1");
    assert.equal(displayPlaceName("Gharbia 1 (Tanta)"), "Gharbia 1 (Tanta)");

    assert.equal(tidyAllCapitalsName("SAHAR EL GALLAD"), "Sahar El Gallad");
    assert.equal(tidyAllCapitalsName("Aya Mamdouh sdeek Ali"), "Aya Mamdouh Sdeek Ali");
    assert.equal(tidyAllCapitalsName("Hossam Mohamed Reda AboElftouh"), "Hossam Mohamed Reda AboElftouh");
    assert.equal(tidyAllCapitalsName("محمد علي"), "محمد علي");

    assert.equal(crmRepDisplayName("( Alex Center 2 / P )"), "Alex Center 2 rep");

    assert.equal(meaningfulHrText("-"), null, "a dash is no HR note");
    assert.equal(meaningfulHrText("  "), null);
    assert.equal(meaningfulHrText("Late by 20 minutes"), "Late by 20 minutes");
    assert.doesNotMatch(PORTAL_LEDGER_NO_REPLY_NOTE.cleared, /released/, "a cleared row promises no release");
    assert.match(PORTAL_LEDGER_NO_REPLY_NOTE.cleared, /Nothing was deducted/);

    assert.equal(countOf(1, "request"), "1 request");
    assert.equal(countOf(2, "request"), "2 requests");
    assert.equal(countOf(1, "team member"), "1 team member");

    assert.equal(crmDayLabel("Regular Visit: Dr. Sameh", "fallback"), "Regular visit in the old CRM");
    assert.equal(crmDayLabel("Phoenix CRM: 3 visits", "fallback"), "Phoenix CRM: 3 visits");
  }
}
