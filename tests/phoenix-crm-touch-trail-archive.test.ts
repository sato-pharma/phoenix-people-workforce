import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ARCHIVE_DELETE_SLICE,
  ARCHIVE_FILE_ROWS,
  ARCHIVE_READ_PAGE,
  ARCHIVE_RUN_BUDGET_MS,
  TOUCH_TRAIL_ARCHIVE_BUCKET,
  TOUCH_TRAIL_KEEP_DAYS,
  archiveObjectPath,
  checkArchiveBody,
  deleteSlices,
  firstKeptTrailDay,
  isArchivedTrailDay,
  toNdjson,
} from "../src/lib/phoenix-crm/touch-trail-archive.ts";
import { TRAIL_DAYS_LISTED } from "../src/lib/phoenix-crm/touch-trail-reader.ts";
import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE PHOENIX CRM TOUCH TRAIL ARCHIVE (owner, 2026-10-27: "Archive after 30 days", after the afternoon
// database stalls). Touches older than 30 days are written to a gzipped file in a private bucket, the
// file is read BACK and checked, and only then are exactly those ids deleted. Production has no
// point-in-time recovery, so the order of those steps is the whole safety of the job.
// ─────────────────────────────────────────────────────────────────────────────

const source = (path: string) => stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

export function runPhoenixCrmTouchTrailArchiveTests(): void {
  // ── The 30-day window ──
  assert.equal(TOUCH_TRAIL_KEEP_DAYS, 30);
  assert.equal(firstKeptTrailDay("2026-11-01"), "2026-10-03", "today plus the 29 days before it stay");
  assert.equal(firstKeptTrailDay("2026-11-02"), "2026-10-04");
  assert.equal(firstKeptTrailDay("2026-03-01"), "2026-01-31", "across a short February");
  assert.equal(isArchivedTrailDay("2026-10-03", "2026-11-01"), false, "3 Oct is still in the database on 1 Nov");
  assert.equal(isArchivedTrailDay("2026-10-03", "2026-11-02"), true, "and archived from 2 Nov");
  assert.equal(isArchivedTrailDay("2026-10-27", "2026-10-27"), false, "today is never archived");
  assert.equal(isArchivedTrailDay("not a day", "2026-11-02"), false);
  assert.ok(TRAIL_DAYS_LISTED <= TOUCH_TRAIL_KEEP_DAYS, "the picker never offers a day the database no longer holds");

  // ── The file name names its first and last id (rule 3) ──
  assert.equal(archiveObjectPath("2026-10-03", 257, 9934), "2026/10/2026-10-03/ids-257-9934.ndjson.gz");
  assert.throws(() => archiveObjectPath("2026-10-03", 10, 9), /Not an id range/);
  assert.throws(() => archiveObjectPath("03-10-2026", 1, 2), /Not a calendar day/);

  // ── The read-back check (rule 1) ──
  const rows = [{ id: 7, kind: "tap" }, { id: 8, kind: "type" }, { id: 12, kind: "tap" }];
  const text = toNdjson(rows);
  assert.equal(text.split("\n").length, 4, "one line per row, newline-terminated");
  assert.equal(checkArchiveBody(text, { firstId: 7, lastId: 12, rows: 3 }), null);
  assert.match(checkArchiveBody(text, { firstId: 7, lastId: 12, rows: 4 }) ?? "", /holds 3 rows, 4 were written/);
  assert.match(checkArchiveBody(text, { firstId: 6, lastId: 12, rows: 3 }) ?? "", /starts at id 7/);
  assert.match(checkArchiveBody(text, { firstId: 7, lastId: 13, rows: 3 }) ?? "", /ends at id 12/);
  assert.match(checkArchiveBody("{\n{\n", { firstId: 7, lastId: 12, rows: 2 }) ?? "", /does not read back as JSON/);
  assert.match(checkArchiveBody("", { firstId: 7, lastId: 12, rows: 3 }) ?? "", /holds 0 rows/);

  // ── The delete names every id, in slices short enough for one URL (rule 2) ──
  const ids = Array.from({ length: 1_001 }, (_, at) => 2_000_000 + at);
  const slices = deleteSlices(ids, ARCHIVE_DELETE_SLICE);
  assert.deepEqual(slices.map((slice) => slice.length), [400, 400, 201]);
  assert.deepEqual(slices.flat(), ids, "every id once, in order, none dropped");
  assert.deepEqual(deleteSlices([]), []);
  assert.ok(ARCHIVE_DELETE_SLICE * 9 < 6_000, "seven-digit ids and commas stay well inside one request URL");
  assert.ok(ARCHIVE_READ_PAGE <= 1_000, "a page never asks past PostgREST's silent 1,000-row ceiling");
  assert.equal(ARCHIVE_FILE_ROWS % ARCHIVE_READ_PAGE, 0);
  assert.ok(ARCHIVE_RUN_BUDGET_MS <= 240_000, "no file starts in the route's last minute");

  // ── The job itself, read from source: the order of its steps is the safety ──
  const job = source("src/lib/phoenix-crm/server/touch-trail-archive.ts");
  const run = job.slice(job.indexOf("export async function runTouchTrailArchive"));
  assert.ok(run.indexOf("await archiveFile(") > 0, "the run archives");
  assert.ok(
    run.indexOf("await archiveFile(") < run.indexOf("await deleteArchived("),
    "rule 1: a file is written and read back BEFORE its rows are deleted",
  );
  const archiveFile = job.slice(job.indexOf("async function archiveFile"), job.indexOf("async function deleteArchived"));
  assert.match(archiveFile, /\.upload\(/);
  assert.match(archiveFile, /\.download\(/, "the file is downloaded again");
  assert.match(archiveFile, /sha256[\s\S]*sha256/, "and its bytes hashed against what was sent");
  assert.match(archiveFile, /checkArchiveBody\(/, "and its rows counted and its ends compared");
  assert.doesNotMatch(archiveFile, /\.delete\(/, "nothing is deleted while the file is being checked");
  const deleter = job.slice(job.indexOf("async function deleteArchived"), job.indexOf("export async function runTouchTrailArchive"));
  assert.match(deleter, /\.delete\(\{ count: "exact" \}\)\.in\("id", slice\)/, "rule 2: the delete names its ids");
  assert.equal((job.match(/\.delete\(/g) ?? []).length, 1, "and it is the only delete in the job");
  for (const range of [".lt(", ".lte(", ".gt(", ".gte(", ".eq("]) {
    const at = deleter.indexOf(range);
    assert.equal(at, -1, `rule 2: the delete is never narrowed by a range (${range})`);
  }
  assert.match(run, /if \(dryRun\)[\s\S]*?return result;/, "a dry run returns before anything is written");
  const dryBranch = run.slice(run.indexOf("if (dryRun)"), run.indexOf("return result;", run.indexOf("if (dryRun)")));
  assert.doesNotMatch(dryBranch, /archiveFile|deleteArchived/);
  assert.match(run, /rows\[0\]!\.id <= lastArchivedId/, "a delete that did not land stops the run instead of re-archiving forever");

  // ── The route, the bucket and the declarations ──
  const route = source("app/api/cron/phoenix-crm-touch-trail-archive/route.ts");
  assert.match(route, /assertCronAuthorized\(request, "cron\/phoenix-crm-touch-trail-archive"\)/);
  assert.match(route, /withDeadMansSwitch\("phoenix-crm-touch-trail-archive"[\s\S]*?signalStart:\s*true/);
  assert.match(route, /export const maxDuration = 300;/);
  assert.doesNotMatch(route, /notify|sendEmail|telegram/i, "it tells nobody");

  const migration = stripSqlComments(
    readFileSync(new URL("../supabase/migrations/20261027175121_phoenix_crm_touch_trail_archive.sql", import.meta.url), "utf8"),
  );
  assert.ok(migration.includes(`'${TOUCH_TRAIL_ARCHIVE_BUCKET}'`), "the migration creates the bucket the job writes");
  assert.match(migration, /values \(\s*'phoenix-crm-touch-trail-archive',\s*'phoenix-crm-touch-trail-archive',\s*false,/, "the bucket is private");
  assert.match(migration, /set public = false/, "and stays private on a re-run");
  assert.match(migration, /to service_role/, "only the service role reaches it");
  assert.doesNotMatch(migration, /to (anon|authenticated|public)\b/);
  assert.doesNotMatch(migration, /\bdelete from\b|\bdrop table\b|\btruncate\b/i, "the migration deletes nothing");

  const schedule = readFileSync(new URL("../src/lib/observability/job-schedule.ts", import.meta.url), "utf8");
  assert.match(schedule, /slug: "phoenix-crm-touch-trail-archive", kind: "cron", schedule: "37 4 \* \* \*"/);
  const cronjob = readFileSync(new URL("../scripts/cronjob-sync.mjs", import.meta.url), "utf8");
  assert.match(cronjob, /"phoenix-crm-touch-trail-archive": \{[\s\S]*?hours: \[4\], minutes: \[37\]/, "cron-job.org fires at the declared minute");
  const registry = readFileSync(new URL("../src/lib/security/access-registry.ts", import.meta.url), "utf8");
  assert.match(registry, /pattern: "\/api\/cron\/phoenix-crm-touch-trail-archive"/);

  // ── The reader says a day is archived rather than empty ──
  const reader = source("src/lib/phoenix-crm/server/touch-trail-reader.ts");
  assert.match(reader, /archived: isArchivedTrailDay\(day, viewer\.visitDay\)/);
  const board = source("src/components/phoenix-crm/touch-trail-board.tsx");
  assert.match(board, /view\.sessions\.length === 0 && view\.archived/);
  assert.match(board, /older than 30 days/);
}
