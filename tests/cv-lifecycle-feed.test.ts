import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { cairoDateTimeSortable } from "../src/lib/format/cairo-datetime.ts";
import {
  buildCvLifecycleCsv,
  buildDailyChannelRollup,
  cvLifecycleRowCells,
  summarizeCvLifecycle,
  CV_LIFECYCLE_COLUMNS,
  CV_LIFECYCLE_DAILY_COLUMNS,
  type CvLifecycleRow,
} from "../src/lib/recruitment/cv-lifecycle.ts";

const BASE = "https://phoenix-hr.satopharma.com";

/** A row with everything present; individual tests override the one field they are about. */
function row(overrides: Partial<CvLifecycleRow> = {}): CvLifecycleRow {
  return {
    appliedForJobTitle: "Medical Representative",
    candidateId: "11111111-2222-3333-4444-555555555555",
    candidateName: "Ahmed Hassan",
    candidatePhone: "201001234567",
    candidateStatus: "new",
    channel: "whatsapp",
    driveError: null,
    driveFileId: "1AbCdEf",
    driveFolder: "Medical Representative/Alex-AB/Alex Center",
    fileId: "file-1",
    fileName: "cv.pdf",
    folderFiledAt: null,
    folderKey: null,
    folderKind: null,
    mailboxLabel: null,
    mimeType: "application/pdf",
    preferencesDeclaredAt: null,
    preferredAreaName: "Alex Center",
    preferredRegionCode: "AB",
    queueAttempts: 1,
    queueLastError: null,
    queueStatus: "done",
    reachedPhoenixAt: "2026-09-04T09:00:00.000Z",
    savedInDriveAt: "2026-09-04T09:02:00.000Z",
    savedInPhoenixAt: "2026-09-04T09:01:00.000Z",
    senderDisplayName: "Ahmed Hassan",
    sizeBytes: 204800,
    timingSource: "queued",
    ...overrides,
  };
}

function cellFor(columnName: string, subject: CvLifecycleRow): unknown {
  const index = CV_LIFECYCLE_COLUMNS.indexOf(columnName as (typeof CV_LIFECYCLE_COLUMNS)[number]);
  assert.notEqual(index, -1, `no column named ${columnName} — the test and the feed have drifted`);
  return cvLifecycleRowCells(subject, 1, BASE)[index];
}

export function runCvLifecycleFeedTests() {
  // ── The day bucket is CAIRO's, never the server's ────────────────────────────────────────────
  //
  // Railway runs in UTC and Cairo is UTC+2/+3. A CV that arrives at 01:30 Cairo on the 5th is
  // 22:30 UTC on the 4th, so a rollup that bucketed on the server's day would file it under
  // yesterday — producing a permanent dip at the start of every working morning that nobody could
  // explain from the data. This is the single assertion that catches that class of bug.

  const justAfterCairoMidnight = row({
    fileId: "after-midnight",
    reachedPhoenixAt: "2026-09-04T22:30:00.000Z", // 2026-09-05 01:30 Cairo
  });
  const daily = buildDailyChannelRollup([justAfterCairoMidnight]);
  assert.equal(daily.length, 1);
  assert.equal(daily[0].day, "2026-09-05", "an 01:30 Cairo arrival belongs to the Cairo day, not the UTC one");

  // ── One row per day, one column per channel — the shape the chart needs ──────────────────────

  const mixed = buildDailyChannelRollup([
    row({ channel: "whatsapp", fileId: "a", reachedPhoenixAt: "2026-09-01T09:00:00.000Z" }),
    row({ channel: "whatsapp", fileId: "b", reachedPhoenixAt: "2026-09-01T10:00:00.000Z" }),
    row({ channel: "email", fileId: "c", reachedPhoenixAt: "2026-09-01T11:00:00.000Z" }),
    row({ channel: "upload", fileId: "d", reachedPhoenixAt: "2026-09-02T09:00:00.000Z" }),
  ]);

  assert.deepEqual(
    mixed.map((d) => [d.day, d.whatsapp, d.email, d.upload, d.total]),
    [
      ["2026-09-01", 2, 1, 0, 3],
      ["2026-09-02", 0, 0, 1, 1],
    ],
  );

  // Oldest first: a chart reads left to right in time.
  assert.ok(mixed[0].day < mixed[1].day, "the daily rollup must be chronological for the chart to read correctly");

  // ── "Reached Drive" counts THAT DAY'S intake, not that day's mirroring ───────────────────────
  //
  // The 2026-09-03 backfill mirrored six weeks of CVs in one evening. A column that counted mirror
  // EVENTS per day would have shown one enormous spike on the 3rd and zero on every day those CVs
  // actually arrived — which answers a question nobody asked. The question worth asking is "did
  // that day's intake land safely", so the bucket is the arrival day and the flag is the mirror.

  const backfilled = buildDailyChannelRollup([
    row({
      fileId: "old-cv",
      reachedPhoenixAt: "2026-07-28T09:00:00.000Z",
      savedInDriveAt: "2026-09-03T21:00:00.000Z", // mirrored six weeks later, by the backfill
      savedInPhoenixAt: "2026-07-28T09:01:00.000Z",
    }),
  ]);
  assert.equal(backfilled.length, 1);
  assert.equal(backfilled[0].day, "2026-07-28", "a backfilled CV is counted on the day it ARRIVED");
  assert.equal(backfilled[0].onDrive, 1);
  assert.equal(backfilled[0].missingFromDrive, 0);

  // A CV with no Drive copy is the number that should be zero, and it must be visible per day.
  const unmirrored = buildDailyChannelRollup([row({ fileId: "no-drive", savedInDriveAt: null })]);
  assert.equal(unmirrored[0].onDrive, 0);
  assert.equal(unmirrored[0].missingFromDrive, 1);

  // ── The three confirmations the owner actually asked for ─────────────────────────────────────
  //
  // "Confirm that this is received on the system and ... received on Google Drive."

  assert.equal(cellFor("In Phoenix?", row()), "Yes");
  assert.equal(cellFor("On Google Drive?", row()), "Yes");
  assert.equal(cellFor("On Google Drive?", row({ savedInDriveAt: null })), "No");
  assert.equal(
    cellFor("Drive folder", row()),
    "Medical Representative/Alex-AB/Alex Center",
    "the owner asked which folder received it — the path is the answer",
  );

  // ── Timestamps sort, and they are Cairo ──────────────────────────────────────────────────────
  //
  // `cairoDateTime`'s "04 Sep 2026 · 12:00" reads well and sorts by the month's FIRST LETTER, so a
  // sheet column of it orders April before August before December. The sortable form exists for
  // exactly this, and Sheets also parses it as a real datetime.

  // 09:00 UTC is 12:00 Cairo (UTC+3 in September).
  assert.equal(cairoDateTimeSortable("2026-09-04T09:00:00.000Z"), "2026-09-04 12:00");
  assert.equal(cellFor("Reached Phoenix", row()), "2026-09-04 12:00");
  // A missing stamp is an EMPTY cell, never an em dash: a dash in a date column defeats both the
  // sort and the date parsing it exists to protect.
  assert.equal(cairoDateTimeSortable(null), "");
  assert.equal(cellFor("Saved in Google Drive", row({ savedInDriveAt: null })), "");

  // ── The honest limit is published per row, not buried in a comment ────────────────────────────
  //
  // Phoenix does not know when the candidate pressed send. Three different stamps stand in for it
  // with three different precisions, and the sheet says which one each row used. A version that
  // presented all three as one number would be the confidently-wrong answer this report replaces.

  assert.equal(cellFor("Accuracy of that time", row({ timingSource: "queued" })), "Exact — webhook arrival");
  assert.equal(
    cellFor("Accuracy of that time", row({ timingSource: "processed" })),
    "When Phoenix processed it (±1 poll)",
  );
  assert.equal(cellFor("Accuracy of that time", row({ timingSource: "saved" })), "Only the saved time exists");

  // No column may claim the candidate's own send time.
  for (const column of CV_LIFECYCLE_COLUMNS) {
    assert.ok(
      !/\bsent\b/i.test(column),
      `column "${column}" says "sent" — Phoenix does not store the candidate's send time, and a column that claims it would be read as fact`,
    );
  }

  // ── A phone number must survive Google Sheets ────────────────────────────────────────────────
  //
  // Without the leading apostrophe, Sheets reads 201001234567 as a number and renders it as
  // 2.01E+11, and a leading zero is eaten outright. A phone column that does that is unusable —
  // and the owner's standing rule is that he sees human-readable values, never mangled ones.

  assert.equal(cellFor("Phone", row()), "'201001234567");
  assert.equal(cellFor("Phone", row({ candidatePhone: null })), "");

  // ── Links point at the CONFIGURED domain ─────────────────────────────────────────────────────

  assert.equal(cellFor("Open in Drive", row()), "https://drive.google.com/file/d/1AbCdEf/view");
  assert.equal(
    cellFor("Open in Phoenix", row()),
    `${BASE}/recruitment/candidates?candidate=11111111-2222-3333-4444-555555555555`,
  );
  assert.equal(cellFor("Open in Drive", row({ driveFileId: null })), "");
  assert.equal(cellFor("Open in Phoenix", row({ candidateId: null })), "");

  // ── The elapsed column is minutes, and blank when it cannot be known ─────────────────────────

  assert.equal(cellFor("Phoenix → Drive (minutes)", row()), 1);
  assert.equal(cellFor("Phoenix → Drive (minutes)", row({ savedInDriveAt: null })), null);

  // ── The bundle's shape is what the Apps Script parses ────────────────────────────────────────

  const rows = [row(), row({ candidateName: "Mona, Ali", channel: "email", fileId: "file-2" })];
  const csv = buildCvLifecycleCsv({
    baseUrl: BASE,
    daily: buildDailyChannelRollup(rows),
    rows,
    summary: summarizeCvLifecycle(rows, new Date("2026-09-04T12:00:00.000Z")),
  });

  assert.ok(csv.startsWith("﻿"), "the BOM is what makes Excel open Arabic names as names rather than mojibake");
  for (const marker of ["#SUMMARY", "#DAILY", "#LIFECYCLE"]) {
    assert.ok(csv.includes(`\r\n${marker}\r\n`) || csv.startsWith(`﻿${marker}\r\n`), `missing section ${marker}`);
  }
  assert.ok(csv.includes(CV_LIFECYCLE_DAILY_COLUMNS.join(",")), "the daily header must survive verbatim");

  // A comma inside a candidate's name must be quoted, or every cell after it shifts one column
  // left and the whole row reads as somebody else's data.
  assert.ok(csv.includes('"Mona, Ali"'), "a name containing a comma must be RFC4180-quoted");

  // ── The summary states the caveat in the DATA, not only in a comment ─────────────────────────

  const summary = summarizeCvLifecycle(
    [row(), row({ fileId: "no-drive", savedInDriveAt: null })],
    new Date("2026-09-04T12:00:00.000Z"),
  );
  assert.equal(summary.total, 2);
  assert.equal(summary.onDrive, 1);
  assert.equal(summary.missingFromDrive, 1);
  assert.equal(summary.cvsToday, 2, "both rows arrived on 2026-09-04 Cairo");
  assert.ok(
    csv.includes("not the moment the candidate sent it"),
    "the sheet itself must carry the caveat — a reader who never opens the source must still be told",
  );

  // ── The migration and the reader must agree on the view's name ───────────────────────────────
  //
  // A rename on one side and not the other is a silent empty report, not an error: PostgREST
  // answers a missing relation with PGRST205, which this repo's own trap notes reads as a 500 on a
  // whole page rather than as "that table is gone".

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const migration = fs.readFileSync(
    path.join(repoRoot, "supabase/migrations/20260905011500_cv_lifecycle_view_and_share_links.sql"),
    "utf8",
  );
  const reader = fs.readFileSync(path.join(repoRoot, "src/lib/recruitment/cv-lifecycle.ts"), "utf8");

  assert.ok(
    migration.includes("create or replace view public.ats_v_cv_lifecycle"),
    "the migration must still create the view the feed reads",
  );
  assert.ok(reader.includes('const VIEW = "ats_v_cv_lifecycle"'), "the feed must still read that same view");

  // The email join is the one that silently returns nothing if it is "simplified" back to a single
  // provider_message_id comparison: measured 2026-09-04, that matched 0 of 244 email CVs, and 0
  // reads as "email CVs have no arrival time" rather than as a broken join.
  assert.ok(
    migration.includes("email_mailbox = ev.mailbox_label"),
    "the email leg of the queue join must survive — without it every email CV loses its arrival time, silently",
  );

  // Paging is not optional at this size: an unbounded select stops at 1000 rows with no marker and
  // production already holds 979 CVs.
  assert.ok(reader.includes(".range(from, from + PAGE_SIZE - 1)"), "the lifecycle read must stay paged");
  assert.ok(
    reader.includes('.order("saved_in_phoenix_at"') && reader.includes('.order("file_id"'),
    "paging needs a TOTAL order — a nullable sort key alone drops rows between pages",
  );

  // ── The unauthenticated route must never grow a file surface ─────────────────────────────────
  //
  // The two older share feeds can stream an evidence photo. This one must not: a CV is the most
  // sensitive document the system holds, and the token cannot be protected by a passcode.

  const shareDir = path.join(repoRoot, "app/api/share/cv-lifecycle");
  const surfaces = fs
    .readdirSync(path.join(shareDir, "[token]"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    surfaces,
    ["feed"],
    "the CV-lifecycle share link has exactly one surface, and it is not a file streamer",
  );
}
