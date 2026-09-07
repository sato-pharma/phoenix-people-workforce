import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * OWNER RULE, 2026-09-07: "since the monthly closing is published then no ever change in it ever
 * never."
 *
 * Until this change, PUBLISHED and FROZEN were two unrelated switches. `monthly_closing_publications`
 * gated portal visibility and fired the announcement; `monthly_closing_locks` was the only thing the
 * database triggers enforced. `publishClosing` wrote the first and never touched the second, so a
 * month was protected only if somebody separately remembered to click the padlock.
 *
 * August 2026 had no lock row at all. It was published and announced with a workbook built
 * 5 September, and on 6 September Finance booked ten more Anti Infective direct orders straight into
 * it. Nothing refused them.
 *
 * The second half is the evidence: `unpublishClosing` DELETED the row, so once August was
 * unpublished the database held no trace it had ever been published, and the investigation had to
 * reconstruct that from the audit log.
 *
 * These blocks read the sources, because the behaviour lives in a migration and in Supabase calls
 * that cannot run here. Each one fails loudly if the wiring is undone.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

export async function runPublishingFreezesClosingTests() {
  const migration = read("../supabase/migrations/20260907140000_publishing_a_closing_freezes_it.sql");
  const publication = read("../src/lib/sales/monthly-closing-publication.ts");
  const lockModule = read("../src/lib/sales/monthly-closing-lock.ts");

  // ── 1. publishing takes the lock, in the database ──────────────────────────
  assert.match(
    migration,
    /create trigger trg_publication_freezes_closing\s+after insert or update on public\.monthly_closing_publications/,
    "publishing must freeze the month from a trigger, so a caller that forgets cannot skip it",
  );
  assert.match(
    migration,
    /phx_lock_monthly_closing\(/,
    "the freeze must reuse the existing lock RPC, not invent a second kind of lock",
  );
  assert.ok(
    /after insert or update/.test(migration),
    "AFTER UPDATE matters: publishClosing upserts, so a re-publish takes the DO UPDATE branch and "
      + "an insert-only trigger would never fire for it",
  );

  // Idempotent — one ACTIVE lock per (line, period) is a unique index.
  assert.match(
    migration,
    /if exists \(\s*select 1\s*from public\.monthly_closing_locks/,
    "the freeze must no-op when the month is already locked, or a re-publish violates the unique index",
  );

  // ── 2. unpublishing must NOT unlock ────────────────────────────────────────
  const unpublish = publication.slice(publication.indexOf("export async function unpublishClosing"));
  assert.ok(unpublish.length > 0, "unpublishClosing must still exist — it is the recovery path");
  assert.ok(
    !/unlockClosing|phx_unlock_monthly_closing/.test(unpublish),
    "unpublishing must never release the freeze — the rule is anchored to having BEEN published",
  );
  assert.ok(
    !/\.delete\(\)/.test(unpublish),
    "unpublishing must stamp unpublished_at, never delete — a deleted row is why August's publish "
      + "left no trace at all",
  );
  assert.match(
    unpublish,
    /unpublished_at: new Date\(\)\.toISOString\(\)/,
    "unpublishing must record WHEN the month was withdrawn",
  );

  // The database refuses the delete too, so ad-hoc SQL and migrations cannot erase the record.
  assert.match(
    migration,
    /create trigger trg_publication_no_delete\s+before delete on public\.monthly_closing_publications/,
    "a publication record a stray statement can erase is not a record",
  );

  // ── 3. re-publishing revives a withdrawn row ───────────────────────────────
  const publish = publication.slice(
    publication.indexOf("export async function publishClosing"),
    publication.indexOf("export async function unpublishClosing"),
  );
  // Read the UPSERT ARGUMENT, not the whole function: the prose above it names the snapshot
  // columns precisely to explain why they are absent, and a grep over the comments would fail on
  // the explanation rather than on the code.
  const upsertAt = publish.indexOf(".upsert(");
  assert.ok(upsertAt > 0, "publishClosing must still upsert the publication row");
  const upsertArg = publish.slice(upsertAt, publish.indexOf("{ onConflict", upsertAt));
  assert.match(
    upsertArg,
    /unpublished_at: null/,
    "re-publishing must clear unpublished_at, or the month stays invisible AND unfrozen",
  );
  // The snapshot columns must still stay out of the payload — see 20260905133000.
  assert.ok(
    !/snapshot_units|snapshot_cells|snapshot_breakdown|snapshot_taken_at/.test(upsertArg),
    "publishClosing must never write the snapshot columns — a re-publish would overwrite the baseline",
  );

  // ── 4. every VISIBILITY reader ignores a withdrawn month ───────────────────
  for (const fn of [
    "export async function isClosingPublished",
    "export async function listPublishedPeriodsForLine",
    "export async function listAllPublishedClosings",
    "export async function latestPublishedClosingPeriod",
  ]) {
    const at = publication.indexOf(fn);
    assert.ok(at > 0, `${fn} must exist`);
    const bodyEnd = publication.indexOf("\n}", at);
    const body = publication.slice(at, bodyEnd);
    assert.match(
      body,
      /\.is\("unpublished_at", null\)/,
      `${fn} must ignore withdrawn months — the row survives an unpublish now, so an unfiltered `
        + "read would report a withdrawn month as published",
    );
  }

  const vsTarget = read("../src/lib/sales/vs-target.ts");
  const publishedKeys = vsTarget.slice(vsTarget.indexOf("export async function loadPublishedPeriodKeys"));
  assert.match(
    publishedKeys.slice(0, publishedKeys.indexOf("\n}")),
    /\.is\("unpublished_at", null\)/,
    "the sales-vs-target dashboard is a visibility gate — a withdrawn month must go dark there too",
  );

  // ── 5. the territory re-stamp is deliberately EVER-published ───────────────
  // Not an oversight: a month that was published was SENT, and re-stamping it afterwards would
  // rewrite a closing people already have.
  const sync = read("../src/lib/sales/territory/scheduled-sync.ts");
  const listPeriods = sync.slice(sync.indexOf("export async function listPublishedClosingPeriods"));
  const listBody = listPeriods.slice(0, listPeriods.indexOf("\n}"));
  assert.ok(
    !/\.is\("unpublished_at", null\)/.test(listBody),
    "the territory re-stamp must withhold EVER-published periods, not only currently-published ones",
  );
  assert.match(
    listBody,
    /EVER published, deliberately/,
    "that asymmetry must be stated in the source, or the next reader 'fixes' it to match the others",
  );

  // ── 6. the lock set the booking rule reads ─────────────────────────────────
  const lockList = lockModule.slice(lockModule.indexOf("export async function listLockedPeriodsForLine"));
  assert.ok(lockList.length > 0, "the booking rule needs every frozen period for a line in one read");
  assert.match(
    lockList.slice(0, lockList.indexOf("\n}")),
    /\.is\("unlocked_at", null\)/,
    "a released lock must not count as frozen",
  );
  assert.match(
    lockList,
    /return new Set\(\)/,
    "an unreadable lock table must yield an EMPTY set — failing the other way would shift a booking "
      + "into the wrong month on a transient read error",
  );
}
