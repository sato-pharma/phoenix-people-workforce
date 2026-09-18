import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { overnightStayEvidenceHoldReason } from "../src/lib/outstation/overnight-evidence.ts";

/**
 * Only an overnight stay joins two days into one trip (owner, 2026-09-18).
 *
 * A trip From 24 Aug To 25 Aug was filed on the 25th with both photos taken on the 25th, priced as
 * "Overnight / 2 days", and paid with nothing showing the employee was away on the 24th. The owner
 * went looking for the 24th's photo; none had ever been taken.
 *
 * Also pins the Expense Approvals save fix from the same day: the screen and its export read the
 * tables Save writes, and Save rebuilds the `expense_claims` copy every other screen reads.
 */
export function runOutstationOvernightEvidenceTests() {
  // The incident's own shape: arrival photo at 11:24 Cairo on the 25th (08:24 UTC, summer time).
  {
    const reason = overnightStayEvidenceHoldReason({
      arrivalCapturedAt: "2026-08-25T08:24:25.137Z",
      tripEndDate: "2026-08-25",
      tripStartDate: "2026-08-24",
    });
    assert.ok(reason, "a two-day trip whose arrival photo is on its second day is held");
    assert.match(String(reason), /24 Aug 2026/, "the reason names the day nothing evidences");
    assert.match(String(reason), /25 Aug 2026/, "and the day the photo was actually taken");
    assert.match(String(reason), /same-day return is one trip per day/, "and says the days are separate trips");
  }

  {
    assert.equal(
      overnightStayEvidenceHoldReason({
        arrivalCapturedAt: "2026-08-24T07:10:00.000Z",
        tripEndDate: "2026-08-25",
        tripStartDate: "2026-08-24",
      }),
      null,
      "a real stay — arrival photo on the first day — is not held",
    );
    assert.equal(
      overnightStayEvidenceHoldReason({
        arrivalCapturedAt: "2026-08-25T08:24:25.137Z",
        tripEndDate: "2026-08-25",
        tripStartDate: "2026-08-25",
      }),
      null,
      "a same-day trip is never held by this check",
    );
    assert.equal(
      overnightStayEvidenceHoldReason({ arrivalCapturedAt: null, tripEndDate: "2026-08-25", tripStartDate: "2026-08-24" }),
      null,
      "no dated photo (a waived role, an admin-created expense) is not this check's business",
    );
    assert.equal(
      overnightStayEvidenceHoldReason({
        arrivalCapturedAt: "2026-08-25T08:24:25.137Z",
        tripEndDate: "2026-08-25T00:00:00+00:00",
        tripStartDate: "2026-08-24T00:00:00+00:00",
      }),
      overnightStayEvidenceHoldReason({
        arrivalCapturedAt: "2026-08-25T08:24:25.137Z",
        tripEndDate: "2026-08-25",
        tripStartDate: "2026-08-24",
      }),
      "a database timestamp and a bare date read as the same trip",
    );
  }

  // The day is CAIRO's, not UTC's. 22:30 UTC on the 23rd is 01:30 on the 24th in Cairo (summer).
  {
    assert.equal(
      overnightStayEvidenceHoldReason({
        arrivalCapturedAt: "2026-08-23T22:30:00.000Z",
        tripEndDate: "2026-08-25",
        tripStartDate: "2026-08-24",
      }),
      null,
      "a photo just after midnight Cairo time counts as the first day",
    );
    assert.ok(
      overnightStayEvidenceHoldReason({
        arrivalCapturedAt: "2026-08-24T21:30:00.000Z",
        tripEndDate: "2026-08-25",
        tripStartDate: "2026-08-24",
      }),
      "21:30 UTC on the 24th is 00:30 on the 25th in Cairo, so it is held",
    );
  }

  // Wired into the one submission path, as a HOLD — never a refusal (owner's flag-never-reject rule).
  {
    const service = readFileSync(new URL("../src/lib/outstation/service.ts", import.meta.url), "utf8");
    assert.match(
      service,
      /const detectedHoldReasons = \[[^\]]*overnightEvidenceHoldReason/,
      "the overnight check feeds the submission's hold reasons",
    );
  }

  // ── The Expense Approvals save fix ─────────────────────────────────────────
  {
    const route = readFileSync(new URL("../app/api/admin/outstation/expenses/route.ts", import.meta.url), "utf8");
    const exportRoute = readFileSync(
      new URL("../app/api/admin/outstation/expenses/export/route.ts", import.meta.url),
      "utf8",
    );
    assert.match(
      route,
      /listUnifiedOutstationExpenses\([\s\S]*?\{ readLegacyTables: true \}/,
      "the approvals screen reads back the tables its Save writes, never the scheduled copy",
    );
    assert.match(
      exportRoute,
      /listUnifiedOutstationExpenses\([\s\S]*?readLegacyTables: true/,
      "the export matches the screen it is downloaded from",
    );
    assert.match(route, /await refreshExpenseClaims\(\)/, "Save rebuilds the copy every other expense screen reads");
  }
}
