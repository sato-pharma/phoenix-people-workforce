import assert from "node:assert/strict";

import { recordsNoWorkToAttribute } from "../src/lib/crm/identity.ts";
import {
  ADMIN_WORK_TYPE,
  AMBIGUOUS_TYPE,
  BRM_TYPE,
  CAMPAIGN_TYPE,
  CASUAL_LEAVE_TYPE,
  HOLIDAY_TYPE,
  MEETING_TYPE,
  REGULAR_TYPE,
  TRAINING_TYPE,
  UNLABELED_FIELD_VISIT_TYPE,
} from "../src/lib/crm/visit-types.ts";

/**
 * WHICH VISIT TYPES RECORD THE ABSENCE OF WORK.
 *
 * THE INCIDENT THIS PINS (production, measured 2026-08-28). 27 August was a public holiday:
 * iReports360 sprayed a holiday marker across EVERY account in the system, 168 markers across 168
 * slots with zero real calls company-wide, deactivated accounts included. Five of those landed on
 * slots whose holder had left, the post-exit guard correctly refused them, and the old sync counted
 * five dead accounts as five live handovers needing an override.
 *
 * The block-counting half of that file went with the vendor sync on 2026-11-06 (iReports360 retired).
 * What stays is the predicate `recordsNoWorkToAttribute` in identity.ts, which the attribution
 * waterfall still uses: a holiday or casual-leave marker records the ABSENCE of work, so there is
 * nothing to credit to anyone, while every other visit type IS activity somebody performed.
 */
export function runCrmBlockCountingTests() {
  // ── The predicate: only the two codes that record the ABSENCE of work ─────────────────────
  assert.equal(recordsNoWorkToAttribute(HOLIDAY_TYPE), true, "a public holiday records no work");
  assert.equal(recordsNoWorkToAttribute(CASUAL_LEAVE_TYPE), true, "a casual leave day records no work");

  // Everything else IS activity somebody performed, and a block on one still wants acting on.
  // Listed one by one rather than as "not the two above" so that adding a new code to the domain
  // forces a decision here instead of silently inheriting whichever default someone wrote.
  for (const [type, name] of [
    [REGULAR_TYPE, "a regular doctor call"],
    [CAMPAIGN_TYPE, "a campaign visit"],
    [TRAINING_TYPE, "a training day"],
    [MEETING_TYPE, "a meeting"],
    [ADMIN_WORK_TYPE, "admin work"],
    [BRM_TYPE, "a business review"],
    [AMBIGUOUS_TYPE, "an ambiguous -7 row, which may well be a sales day"],
    [UNLABELED_FIELD_VISIT_TYPE, "an unlabeled field visit — a real call the vendor never described"],
  ] as const) {
    assert.equal(recordsNoWorkToAttribute(type), false, `${name} records work and must still count`);
  }
  assert.equal(recordsNoWorkToAttribute(null), false, "an unknown type is not evidence of no work");
  assert.equal(recordsNoWorkToAttribute(undefined), false, "a missing type is not evidence of no work");
}
