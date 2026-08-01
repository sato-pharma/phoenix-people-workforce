import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CRM_MASTER_DATASETS,
  CRM_MASTER_SUPPORTED_FILTERS,
  crmMasterSupportsFilter,
} from "../src/lib/crm/master-datasets.ts";
import { indexCheckinsByAgentContactDay, pickCheckinForVisit } from "../src/lib/crm/checkin-match.ts";
import { attachEffectiveType } from "../src/lib/crm/master.ts";
import type { CrmMasterRow } from "../src/lib/crm/master.ts";
import { isUtcTimestamp, offsetOf } from "../scripts/check-db-timezone.ts";

/** The exact label attachEffectiveType writes when it counts a Regular visit as Campaign. */
const RECLASSIFIED = "Campaign — reclassified (Regular, no check-in)";

/** A Regular visit with no correlated check-in — the row shape this whole rule turns on. */
function regularNoCheckin(): CrmMasterRow {
  return { checkin_id: null, visit_type: 0, visit_type_description: "Regular" } as unknown as CrmMasterRow;
}

/**
 * The CRM module's DEGRADATION POLICY and the filter-honesty contract that goes with it.
 *
 * One rule, applied module-wide: a cosmetic OVERLAY may fall back to null (a blank GPS address
 * reads as "unknown", which is honest), but anything that changes a CLASSIFICATION or a COUNT must
 * propagate the failure instead of substituting a plausible value. The three things guarded here
 * are each a case where a failure used to be rendered as a confident, wrong answer.
 */
export function runCrmDegradationPolicyTests() {
  const master = readFileSync("src/lib/crm/master.ts", "utf8");

  // ── (A) A failed check-in read must never manufacture a reclassification ─────────
  //
  // attachNearestCheckins leaves every checkin_id null when the read fails. attachEffectiveType
  // reads exactly that null to decide "Regular with no check-in -> counted as Campaign". Wired
  // naively, an infrastructure error relabels a whole team's regular visits as Campaign — a
  // classification invented out of an outage. The availability flag is what separates the two.
  // Driven BEHAVIOURALLY, not by matching the source of master.ts. A source assertion breaks when a
  // parameter is renamed or a ternary is reformatted — and, worse, passes for right-looking code
  // that computes the flag wrongly. attachEffectiveType is a pure function over rows, so drive it.

  // Correlation SUCCEEDED and the visit genuinely has no check-in — reclassifying is correct.
  const correlated = [regularNoCheckin()];
  attachEffectiveType("visits", correlated, true);
  assert.equal(correlated[0].effective_type, RECLASSIFIED, "a genuine no-check-in Regular visit is counted as Campaign");

  // THE BUG: correlation FAILED, so checkin_id is null for that reason alone. Reclassifying here
  // turns an outage into the confident claim that a team did no verified regular visits.
  for (const dataset of ["visits", "double_visits"] as const) {
    const failed = [regularNoCheckin()];
    attachEffectiveType(dataset, failed, false);
    assert.equal(
      failed[0].effective_type,
      "Regular",
      `${dataset}: a FAILED check-in read must keep the raw vendor type, never manufacture a reclassification`,
    );
  }

  // The two No-Check-in tabs filter at the DB on `reclassified_no_checkin`, so they never depended
  // on the in-memory correlation and must stay correct even when it fails.
  for (const dataset of ["regular_no_checkin", "regular_dv_no_checkin"] as const) {
    const dbFiltered = [regularNoCheckin()];
    attachEffectiveType(dataset, dbFiltered, false);
    assert.equal(dbFiltered[0].effective_type, RECLASSIFIED, `${dataset} is DB-filtered and stays reclassified`);
  }

  // A Regular visit that DID match a check-in is never reclassified — the guard is not over-broad.
  const matched = [{ ...regularNoCheckin(), checkin_id: 4321 } as unknown as CrmMasterRow];
  attachEffectiveType("visits", matched, true);
  assert.equal(matched[0].effective_type, "Regular", "a Regular visit with a matched check-in keeps its type");

  // A non-Regular visit is outside the rule entirely.
  const campaign = [{ checkin_id: null, visit_type: -8, visit_type_description: "Campaign" } as unknown as CrmMasterRow];
  attachEffectiveType("visits", campaign, true);
  assert.equal(campaign[0].effective_type, "Campaign", "a non-Regular visit is never reclassified");

  // Kept as source assertions on purpose: attachNearestCheckins' return CONTRACT is what carries the
  // failure into the function above, and exercising it for real would need a stubbed Supabase.
  assert.match(
    master,
    /async function attachNearestCheckins\([^)]*\): Promise<boolean>/,
    "attachNearestCheckins must REPORT whether the correlation ran (Promise<boolean>), not return void",
  );
  assert.match(
    master,
    /attachEffectiveType\(dataset, rows, checkinCorrelationAvailable\)/,
    "attachDerived must thread the availability flag into attachEffectiveType",
  );
  // The flag must stay REQUIRED: a `= true` default fails OPEN, so a caller that forgets the
  // argument silently restores the bug this whole section exists to prevent. Checked via
  // Function.length — which counts parameters BEFORE the first default — rather than by banning
  // the substring "checkinCorrelationAvailable = true" in the source, because attachDerived
  // legitimately initialises a local of that name the same way. (A source ban failed here for
  // exactly that reason: it is the same over-broad-assertion trap this file is meant to avoid.)
  assert.equal(
    attachEffectiveType.length,
    3,
    "attachEffectiveType must REQUIRE the availability flag — a defaulted parameter drops out of Function.length and fails OPEN",
  );
  // The EXPORT is stricter than the screen: a workbook is a permanent artifact someone acts on, so
  // a failed check-in preload aborts it rather than shipping a file that says a team did no
  // verified regular visits. It runs before the first page is yielded, so nothing is half-written.
  assert.doesNotMatch(
    master,
    /return indexCheckinsByAgentContactDay\(data\);\s*\}\s*catch\s*\{\s*return new Map\(\);/,
    "the export's check-in preload must not swallow a failure into an empty index",
  );
  assert.match(
    master,
    /throw new Error\(\s*`CRM export aborted: the check-in correlation data could not be loaded/,
    "the export's check-in preload must abort the export on failure",
  );

  // ── (B) Filters may not be offered where they are not honoured ──────────────────
  //
  // The computed tabs build rows in memory (filterComputedRows) and never look at AM/PM, Visit Type
  // or Mapping. Offering those controls produced a chip asserting a narrowing that never happened:
  // picking "Annual Vacation" on Vacations still returned Health Day rows.
  for (const { id } of CRM_MASTER_DATASETS) {
    assert.ok(CRM_MASTER_SUPPORTED_FILTERS[id], `every dataset needs a supported-filter list (${id})`);
    for (const universal of ["agentHrId", "dateRange", "hireDate", "line", "search"] as const) {
      assert.ok(crmMasterSupportsFilter(id, universal), `${id} must honour the universal ${universal} filter`);
    }
  }
  for (const computed of ["vacations", "triple_visits"] as const) {
    for (const unsupported of ["ampm", "visitType", "mappingStatus"] as const) {
      assert.equal(
        crmMasterSupportsFilter(computed, unsupported),
        false,
        `${computed} computes rows in memory and cannot honour ${unsupported} — it must not be offered`,
      );
    }
  }
  // Check-ins are a different table with no ampm / visit_type / agent-mapping columns.
  for (const unsupported of ["ampm", "visitType", "mappingStatus"] as const) {
    assert.equal(crmMasterSupportsFilter("checkins", unsupported), false, `checkins cannot honour ${unsupported}`);
  }
  // Duration / half-days are period-level fields that exist only on the grouped Vacations rows.
  assert.ok(crmMasterSupportsFilter("vacations", "minDuration"), "vacations must honour minDuration");
  assert.ok(crmMasterSupportsFilter("vacations", "halfDaysOnly"), "vacations must honour halfDaysOnly");
  assert.equal(crmMasterSupportsFilter("visits", "minDuration"), false, "visits has no period Duration to filter");
  assert.equal(crmMasterSupportsFilter("triple_visits", "halfDaysOnly"), false, "triples have no half-day field");
  // The DB-backed visit tabs DO honour all three (applyMasterFilters applies them).
  for (const dbBacked of ["visits", "double_visits", "regular_no_checkin", "regular_dv_no_checkin"] as const) {
    for (const supported of ["ampm", "visitType", "mappingStatus"] as const) {
      assert.ok(crmMasterSupportsFilter(dbBacked, supported), `${dbBacked} is DB-filtered and must honour ${supported}`);
    }
  }
  // The server echoes an unsupported filter back CLEARED, so the active-filter chip (derived from
  // the echo) cannot claim a narrowing that did not happen when a value carries over between tabs.
  assert.match(master, /ampm: supports\("ampm"\) \? ampm : \("all" as CrmMasterAmpm\)/, "the echo must clear an unsupported ampm");
  assert.match(master, /visitType: supports\("visitType"\) \? visitType : null/, "the echo must clear an unsupported visitType");
  assert.match(
    master,
    /mappingStatus: supports\("mappingStatus"\) \? mappingStatus : \("all" as CrmMasterMappingStatus\)/,
    "the echo must clear an unsupported mappingStatus",
  );

  // ── (C) The contact-0 placeholder is rejected on BOTH sides of the matcher ───────
  //
  // `0` is the vendor's "no contact" value. The visit side always normalised it to null; the index
  // side did not, so contact-less check-ins were stored under an `agent|0|day` key. Symmetry means
  // the rule holds on its own rather than depending on one caller's guard.
  const zeroContactIndex = indexCheckinsByAgentContactDay([
    { agent_crm_id: 100, contact_crm_id: 0, check_date: "2026-07-01T09:00:00Z" },
  ]);
  assert.equal(zeroContactIndex.size, 0, "a check-in with the contact-0 placeholder must not be indexed at all");
  assert.equal(
    pickCheckinForVisit({ agentCrmId: 100, contactCrmId: 0, visitDay: "2026-07-01", crmSaveDate: "2026-07-01T09:05:00Z" }, zeroContactIndex),
    null,
    "a contact-less visit must never match a contact-less check-in",
  );
  // A real contact still indexes and matches — the guard must not be over-broad.
  const realIndex = indexCheckinsByAgentContactDay([
    { agent_crm_id: 100, contact_crm_id: 555, check_date: "2026-07-01T09:00:00Z" },
  ]);
  assert.equal(realIndex.size, 1, "a check-in with a real contact must still be indexed");

  // ── (D) Machine timestamps sort lexicographically, never by locale ──────────────
  //
  // localeCompare gives digits and hyphens variable weight, so ISO ordering would depend on the
  // runtime's locale + ICU data — different on a laptop than in the Cloud Run container.
  assert.doesNotMatch(master, /visit_date\)\.localeCompare/, "ISO date sorts in master.ts must not use localeCompare");
  assert.doesNotMatch(master, /from_date\)\.localeCompare/, "ISO date sorts in master.ts must not use localeCompare");
  assert.match(master, /function compareIso\(/, "master.ts must define the explicit ISO comparator");
  const repDay = readFileSync("src/lib/crm/rep-day.ts", "utf8");
  assert.doesNotMatch(repDay, /checkDate\)\.localeCompare/, "the rep-day route ordering must not depend on locale collation");
  // Human-readable names DO want a collator — but an explicitly pinned one.
  const regionBrick = readFileSync("src/lib/crm/region-brick.ts", "utf8");
  assert.match(regionBrick, /new Intl\.Collator\("en"\)/, "brick list sorting must pin an explicit locale");

  // ── (E) The check-ins upper date bound is half-open ─────────────────────────────
  //
  // `<= 23:59:59` silently dropped the final second of the day on a timestamptz column, so the last
  // day of a range under-reported depending on sub-second precision.
  assert.doesNotMatch(master, /T23:59:59/, "the check-ins date bound must not use an inclusive 23:59:59 cutoff");
  assert.match(
    master,
    /q\.lt\(dateColumn, `\$\{addDaysIso\(dateTo, 1\)\}T00:00:00`\)/,
    "the check-ins upper bound must be a half-open < next-day 00:00:00",
  );

  // ── (F) A free-text `*` must not become a wildcard ─────────────────────────────
  assert.match(master, /term\.replace\(\/\[%\*,\(\)\]\/g, " "\)/, "sanitizeSearch must strip `*` alongside `%`");

  // ── (G) Region and customer mapping validate a brick the SAME way ───────────────
  //
  // Region mapping used to accept any `active` brick, a weaker test than the customer resolver's
  // current-brick index — so a brick superseded by the geography rebuild was accepted on one
  // surface and rejected on the other, pointing visits at stale geography.
  assert.match(
    regionBrick,
    /const \{ allKnown, current \} = await getCurrentBrickIndex\(\);/,
    "the region resolver must validate through getCurrentBrickIndex, not a bare active check",
  );
  assert.doesNotMatch(
    regionBrick,
    /exists but is not active/,
    "the region resolver must not keep its weaker active-only rejection path",
  );

  // ── (H) The UTC-timestamp probe classifies offsets correctly ───────────────────
  assert.ok(isUtcTimestamp("2026-07-14T09:30:00+00:00"), "+00:00 is UTC");
  assert.ok(isUtcTimestamp("2026-07-14T09:30:00Z"), "Z is UTC");
  assert.ok(isUtcTimestamp("2026-07-14T09:30:00+00"), "PostgREST's short +00 form is UTC");
  assert.equal(isUtcTimestamp("2026-07-14T09:30:00+02:00"), false, "a Cairo offset is NOT UTC");
  assert.equal(isUtcTimestamp("2026-07-14T09:30:00"), false, "a naive timestamp is not proof of UTC");
  assert.equal(offsetOf("2026-07-14T09:30:00+02:00"), "+02:00", "the failure message must name the real offset");
  assert.equal(offsetOf("2026-07-14T09:30:00"), "none", "a naive timestamp reports no offset");
}
