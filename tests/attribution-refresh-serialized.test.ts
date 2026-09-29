import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

/**
 * The attribution refresh must serialize per period, and must never be "fixed" with a unique index.
 *
 * 🔴 WHAT THIS PINS, AND WHY IT COST A REAL NUMBER. `au.f_refresh_monthly_attribution` is
 * `delete where period = X` then `insert`. On 2026-09-29 a hire flipped the config fingerprint, the
 * stale-period sweep was run by hand, and the scheduler's cron run overlapped it: both deleted, then
 * both inserted, and 2026-09 came out DOUBLED — 22 rows to 44, every key twice, 579,055.85 to
 * 1,158,111.70. Nothing in the schema prevented it: the rollup has one non-unique index on `period`.
 *
 * 🔴 THE OBVIOUS FIX IS WRONG, WHICH IS THE WHOLE REASON THIS TEST EXISTS. A unique index on
 * (period, line_code, area_code, product_code) looks right and would silently halve real money: the
 * function emits an `indirect` row AND a `direct` row and the rollup stores no channel, so two rows
 * per key are LEGITIMATE and carry different values — measured on 2026-08, anti_infective / CA4 /
 * RO001 holds 3,450.00 and 4,188.30. Whoever reads the doubling incident next will reach for that
 * index; this test is the thing that stops them.
 *
 * The real fix is a transaction-scoped advisory lock keyed on the period, so the second caller waits
 * and then rebuilds over a settled table.
 */

const MIGRATIONS = new URL("../supabase/migrations/", import.meta.url);
const THIS_MIGRATION = "20260929200000_serialize_attribution_refresh.sql";

export function runAttributionRefreshSerializedTests() {
  const files = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql"));
  assert.ok(files.length > 50, `expected the migrations directory, found ${files.length} files`);
  assert.ok(files.includes(THIS_MIGRATION), `${THIS_MIGRATION} must exist`);

  const sql = readFileSync(new URL(THIS_MIGRATION, MIGRATIONS), "utf8");
  const body = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  // 1. THE LOCK. Transaction-scoped, so a crashed caller cannot hold it, and keyed on the period so
  //    different periods still refresh in parallel.
  assert.match(
    body,
    /pg_advisory_xact_lock\(\s*hashtext\(/,
    "the refresh must take a transaction-scoped advisory lock — without it two runs both delete and " +
      "both insert, which doubled 2026-09 on production",
  );
  assert.ok(
    /hashtext\('au\.f_refresh_monthly_attribution:' \|\| coalesce\(p_period/.test(body),
    "the lock must be keyed on the PERIOD, or every period serializes behind every other",
  );
  assert.ok(
    body.indexOf("pg_advisory_xact_lock") < body.indexOf("delete from au.monthly_attribution_rollup"),
    "the lock must be taken BEFORE the delete, or the race it exists to close is still open",
  );

  // 2. THE PUBLISHED GUARD SURVIVES. This is what kept 2026-07 and 2026-08 frozen through the
  //    incident, and a rewrite of this function is exactly where it would be dropped by accident.
  assert.match(
    body,
    /from public\.monthly_closing_publications[\s\S]{0,200}?unpublished_at is null/,
    "the function must still refuse a published period — a published month is never corrected",
  );
  assert.ok(
    body.indexOf("monthly_closing_publications") < body.indexOf("delete from au.monthly_attribution_rollup"),
    "the published check must come before the delete, or a published month is emptied before it is refused",
  );

  // 3. NO UNIQUE INDEX ON THE ROLLUP. The direct and indirect rows share a key by design.
  //
  // 🔴 THE FAILURE MESSAGE NAMES THE INCIDENT ON PURPOSE. If you are reading it because you were
  // sent here by the 2026-09 doubling, that story is exactly what makes a unique index look
  // obvious — and it is the wrong fix. Fix the race, never this test.
  assert.ok(
    !/create\s+unique\s+index[\s\S]{0,120}monthly_attribution_rollup/i.test(body),
    "a unique index on au.monthly_attribution_rollup would REJECT the legitimate second row per key " +
      "and silently halve a line. If you are here because 2026-09 doubled on 2026-09-29 (22 rows -> " +
      "44, 579,055.85 -> 1,158,111.70): that was two concurrent refreshes, not a missing constraint. " +
      "The direct and indirect rows share a key by design and carry DIFFERENT values — 2026-08 " +
      "anti_infective/CA4/RO001 holds 3,450.00 and 4,188.30, and a census found 98 such groups. " +
      "The advisory lock is the fix. Do not delete this assertion to make an index pass.",
  );

  // 4. THE WRITERS ARE NOT EXECUTABLE BY PUBLIC. Measured on production 2026-09-29: the two
  //    functions in this family that WRITE the rollup carried a null proacl — PUBLIC EXECUTE, with
  //    anon and authenticated inheriting it — while their two read-only siblings were already
  //    locked to postgres and service_role. Both writers are SECURITY DEFINER.
  // 🔴 ALL FOUR THAT WERE OPEN, not the three a hand-written list first named. Rehearsing the
  // migration in a rolled-back transaction and counting has_function_privilege across the whole
  // au.%attribution% family still returned 1 for anon afterwards: the family has SEVEN members and
  // `f_monthly_attribution_pre_split` was the one nobody had enumerated. It is STABLE, so it writes
  // nothing — but it returns attribution by area and product, exactly what its already-locked twin
  // `f_monthly_attribution` is protected against.
  for (const fn of [
    "au.f_refresh_monthly_attribution(text)",
    "au.f_rebuild_monthly_attribution_all()",
    "au.f_attribution_config_fingerprint()",
    "au.f_monthly_attribution_pre_split(text)",
  ]) {
    assert.ok(
      body.includes(`revoke execute on function ${fn} from public, anon, authenticated`),
      `${fn} must be revoked from public/anon/authenticated — it is SECURITY DEFINER`,
    );
    assert.ok(
      body.includes(`grant  execute on function ${fn} to service_role`) ||
        body.includes(`grant execute on function ${fn} to service_role`),
      `${fn} must keep service_role, which is how the app's own wrappers reach it`,
    );
  }
  assert.ok(
    body.indexOf("revoke execute on function") > body.indexOf("create or replace function"),
    "the revoke must come after the function is (re)created, or CREATE resets the ACL it just set",
  );

  // 5. THE SWEEP DOES NOT RE-ATTEMPT — OR REPORT — A PUBLISHED PERIOD.
  //
  // The inner guard returns ABOVE the meta upsert, so a published period is never stamped and is
  // stale by construction, permanently. Before this migration the sweep therefore re-attempted
  // 2026-07 and 2026-08 on every call, occupied 2 of the 6 default slots, and — because
  // `return next` fires unconditionally — REPORTED them as refreshed when nothing had happened.
  // That last part is a false green, which is why the filter belongs in the outer loop rather than
  // in a fix that stamps a frozen period's fingerprint.
  assert.match(
    body,
    /create or replace function au\.f_refresh_stale_attribution_periods/,
    "the sweep must be updated too — the published filter belongs in the outer loop",
  );
  // The function BODY only — not the `comment on function` that follows it, whose text names both
  // tables on purpose. Slicing to the end of the file caught that string and failed, which is the
  // scan-your-own-prose mistake this file has already made once today.
  const sweepStart = body.indexOf("create or replace function au.f_refresh_stale_attribution_periods");
  const sweep = body.slice(sweepStart, body.indexOf("$function$;", sweepStart));
  assert.match(
    sweep,
    /not exists\s*\([\s\S]{0,200}?monthly_closing_publications[\s\S]{0,120}?unpublished_at is null/,
    "the sweep must exclude published periods, so they neither consume a slot nor get reported as " +
      "refreshed when the inner function only declined",
  );
  // 🔴 And it must read PUBLICATIONS, not LOCKS. Measured 2026-09-29: 2026-09 has 0 open publication
  // rows and 1 lock row, so a filter written against locks would skip the live month — which is the
  // one period that genuinely needs refreshing.
  assert.ok(
    !/monthly_closing_locks/.test(sweep),
    "the sweep must gate on monthly_closing_publications, never monthly_closing_locks: 2026-09 is " +
      "locked with no publication rows, and gating on locks would skip the live month",
  );

  // 6. And no migration anywhere may add one.
  const offenders: string[] = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, MIGRATIONS), "utf8")
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");
    if (/create\s+unique\s+index[\s\S]{0,160}au\.monthly_attribution_rollup\b/i.test(text)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a migration adds a unique index to au.monthly_attribution_rollup. It would fail on the 98 " +
      "legitimate duplicate-key groups (direct vs indirect, different values) and, if forced, halve " +
      "lines. The 2026-09 doubling that sent you here was two concurrent refreshes, closed by the " +
      `advisory lock in 20260929200000_serialize_attribution_refresh.sql: ${offenders.join(", ")}`,
  );
}
