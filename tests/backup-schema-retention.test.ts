import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EXEMPT_SCHEMAS,
  RETENTION_DAYS,
  VERDICT,
  classify,
  datesIn,
  snapshotDateOf,
} from "../scripts/audit-backup-schemas.mjs";

/**
 * scripts/audit-backup-schemas.mjs decides which ad-hoc backup schemas have outlived their
 * purpose. Production had 99 of them on 2026-09-29 and had ever dropped one.
 *
 * Everything below runs with no database. What it guards is the single way this script could
 * cause real damage: naming a schema expired while something still needs it. Production has no
 * point-in-time recovery, so that mistake is recoverable for seven days and only by restoring a
 * backup into a separate project.
 *
 * Every rule here is asserted with its NEGATIVE CONTROL — the same input with the protection
 * removed, which must flip to EXPIRED. Without that, a classifier that returned "keep" for
 * everything would pass every test on this page.
 */
export function runBackupSchemaRetentionTests() {
  const TODAY = "2026-09-29";

  // ---------------------------------------------------------------- date extraction

  assert.deepEqual(datesIn("ats_backup_20260928_hiredfix"), ["2026-09-28"]);
  assert.deepEqual(datesIn("code_refs_pre_sync_2026_08_19b"), ["2026-08-19"]);
  assert.deepEqual(datesIn("snap-2026-01-05"), ["2026-01-05"]);
  assert.deepEqual(datesIn("customer_map_20260911_0110"), ["2026-09-11"], "a trailing time is not a second date");
  assert.deepEqual(datesIn("areas_full"), [], "no digits, no date");

  // An impossible date is NOT a date. Clamping one would invent an expiry for a schema that
  // never declared one, which is the one direction this must never fail in.
  assert.deepEqual(datesIn("x_20261301"), [], "month 13 is not December");
  assert.deepEqual(datesIn("x_20260230"), [], "February 30th does not exist");
  assert.deepEqual(datesIn("x_20260000"), [], "month 0 / day 0 is not a date");

  // ---------------------------------------------------------------- which date wins

  assert.equal(
    snapshotDateOf("sos_backup_20260913", ["anything_20260101"]),
    "2026-09-13",
    "the schema's own date beats its tables'",
  );

  // The fallback that rescues the undated schemas. ops_backup carries no date; its tables do.
  assert.equal(
    snapshotDateOf("ops_backup", [
      "v2_vacation_requests_20260824",
      "v2_vacation_requests_a10_pre_paidfix_20260917",
      "email_templates_20260910_leave_codes",
    ]),
    "2026-09-17",
    "the NEWEST table date — a schema reused later is only as expired as its latest contents",
  );

  assert.equal(snapshotDateOf("plan_backups", ["deleted_employee_plans"]), null);

  // ---------------------------------------------------------------- the safety property

  // 🔴 A LIVE DEPENDENCY BEATS AGE. This is the real production case: the live table
  // public.private_calendar_no_activity_clarifications holds a foreign key into
  // deductions_governance_backup_20260830, which by name and age is indistinguishable from 98
  // inert siblings.
  const pinned = {
    schema: "deductions_governance_backup_20260830",
    tables: ["deduction_candidates"],
    blockers: ["foreign key private_calendar_..._fkey on public.private_calendar_no_activity_clarifications points into it"],
  };
  assert.equal(
    classify(pinned, { today: "2031-01-01", retentionDays: 1 }).verdict,
    VERDICT.PINNED,
    "A FOREIGN KEY MUST BEAT AGE — five years old against a one-day retention and it still stays",
  );

  // Negative control: the identical entry with the blocker removed MUST expire. If this does not
  // flip, the assertion above is proving nothing.
  assert.equal(
    classify({ ...pinned, blockers: [] }, { today: "2031-01-01", retentionDays: 1 }).verdict,
    VERDICT.EXPIRED,
    "without the foreign key the same schema expires — so the check above is load-bearing",
  );

  // ---------------------------------------------------------------- the owner's decisions

  for (const schema of ["hr_backup_20260829", "crm_backup_20260828", "delta3_defer_backup_20260829"]) {
    assert.ok(EXEMPT_SCHEMAS[schema], `${schema} must stay exempt — the owner's standing decision`);
    assert.equal(
      classify({ schema, tables: [], blockers: [] }, { today: "2031-01-01", retentionDays: 1 }).verdict,
      VERDICT.PROTECTED,
      `${schema} must never expire on age alone`,
    );
  }

  // Negative control: an unlisted sibling of the same vintage DOES expire, so the exemption is
  // doing the work and not some accident of the name.
  assert.equal(
    classify({ schema: "hr_backup_20260830", tables: [], blockers: [] }, { today: TODAY, retentionDays: 1 }).verdict,
    VERDICT.EXPIRED,
    "an unlisted schema of the same shape expires — the exemption list is what holds the others",
  );

  assert.equal(classify({ schema: "analytics", tables: [], blockers: [] }, { today: TODAY }).verdict, VERDICT.LIVE);
  assert.equal(classify({ schema: "private", tables: [], blockers: [] }, { today: TODAY }).verdict, VERDICT.LIVE);

  // ---------------------------------------------------------------- undated never expires

  const undated = { schema: "plan_backups", tables: ["deleted_employee_plans"], blockers: [] };
  assert.equal(
    classify(undated, { today: "2031-01-01", retentionDays: 1 }).verdict,
    VERDICT.UNDATED,
    "no date means the rule cannot reach it — it is reported for a human, never auto-proposed",
  );

  // Negative control: give the same schema a dated table and it becomes ageable.
  assert.equal(
    classify({ ...undated, tables: ["deleted_employee_plans_20260101"] }, { today: "2031-01-01", retentionDays: 1 }).verdict,
    VERDICT.EXPIRED,
  );

  // ---------------------------------------------------------------- the window boundary

  const at = (date: string, retentionDays: number) =>
    classify({ schema: `x_backup_${date.split("-").join("")}`, tables: [], blockers: [] }, { today: TODAY, retentionDays });

  assert.equal(at("2026-08-31", 30).verdict, VERDICT.YOUNG, "29 days old under a 30-day retention");
  assert.equal(at("2026-08-31", 30).ageDays, 29);
  assert.equal(at("2026-08-30", 30).verdict, VERDICT.EXPIRED, "exactly at the retention age is expired");
  assert.equal(at("2026-08-30", 30).ageDays, 30);

  // A snapshot dated in the future is not expired. Clock skew and a hand-typed name both produce
  // these, and a negative age must never read as "very old".
  assert.equal(at("2027-01-01", 30).verdict, VERDICT.YOUNG);

  assert.equal(RETENTION_DAYS, 90, "the default is deliberately generous — see docs/security/backup-schema-retention.md");

  // ---------------------------------------------------------------- it cannot drop anything

  const source = readFileSync(new URL("../scripts/audit-backup-schemas.mjs", import.meta.url), "utf8");

  // The script prints `drop schema` statements. It must never SEND one. Anything inside a
  // postgres`...` template is sent.
  //
  // Written with exec rather than matchAll, and without the `s` flag, because both are above this
  // repo's compile target — `[^`]` already spans newlines, so the flag bought nothing anyway.
  const sentToDatabase: string[] = [];
  const templates = /sql`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = templates.exec(source)) !== null) sentToDatabase.push(match[1]);

  assert.ok(sentToDatabase.length >= 4, `expected to find the queries, found ${sentToDatabase.length}`);
  for (const statement of sentToDatabase) {
    assert.ok(
      !/\bdrop\b/i.test(statement),
      `this script must never send a DROP to the database, found: ${statement.slice(0, 80)}`,
    );
  }
  assert.ok(!/--apply/.test(source), "there must be no --apply flag — dropping is a human's job, under supervision");
}
