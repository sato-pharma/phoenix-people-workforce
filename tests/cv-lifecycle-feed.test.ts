import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { cairoDateTimeSortable } from "../src/lib/format/cairo-datetime.ts";
import {
  buildCvLifecycleCsv,
  buildDailyChannelRollup,
  cvDetailRowCells,
  cvLifecycleRowCells,
  cvLifecycleRowsAfter,
  oneRowPerCandidate,
  summarizeCvLifecycle,
  CV_DETAIL_COLUMNS,
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

    // The candidate themself — the half the sheet could not show before 2026-09-05.
    candidateAddress: "12 Gamal Abdel Nasser St, Sidi Gaber",
    candidateCreatedAt: "2026-09-04T08:55:00.000Z",
    candidateEmail: "ahmed.hassan@example.com",
    candidateSource: "whatsapp",
    candidateStatusNote: null,
    currentEmployer: "Delta Pharma",
    currentJobTitle: "Medical Representative",
    cvCertifications: "Good Clinical Practice (2024)",
    cvEducation: "BSc Pharmacy \u2014 Alexandria University (2019)",
    cvLanguages: "Arabic, English",
    cvSkills: "Selling skills, CRM, Presentation",
    cvWorkHistory: "Medical Representative \u2014 Delta Pharma (2020-03\u2192now)",
    dateOfBirth: "1997-04-11",
    declaredBackground: "Pharmacy",
    declaredExpectedSalary: "12000",
    declaredExperience: "3 years medical rep",
    degree: "BSc",
    expectedSalary: "12000",
    faculty: "Pharmacy",
    gender: "male",
    governorate: "Alexandria",
    grade: "Good",
    graduationYear: 2019,
    hasMedicalRepExperience: true,
    hasPriorWorkExperience: true,
    linkedinUrl: "https://www.linkedin.com/in/ahmed-hassan",
    managerNotifiedAt: "2026-09-04T10:00:00.000Z",
    managerNotifiedName: "Rasha Fouad",
    maritalStatus: "single",
    medicalRepEmployer: "Delta Pharma",
    militaryStatus: "exempted",
    nationality: "Egyptian",
    noticePeriod: "1 month",
    preferredRegionName: "Alexandria & Behera",
    professionalSummary: "Three years selling CNS products in Alexandria.",
    screeningAgeBand: "25-30",
    screeningBookingExperience: "yes",
    screeningCommute: "yes",
    screeningEnglishLevel: "very good",
    screeningMsOffice: "good",
    screeningStartDate: "immediately",
    sentForArea: "Alex Center",
    sentForJobTitle: "Medical Representative",
    sentForLine: "CNS",
    sentForRegion: "AB",
    university: "Alexandria University",
    yearsExperience: 3,

    ...overrides,
  };
}

/**
 * Apps Script's `Utilities.parseCsv`, to the extent this suite depends on it: RFC 4180 quoting, so a
 * professional summary carrying a comma stays one cell. It exists because the parser under test is
 * Apps Script source and cannot be imported — it is run here through `new Function` with this as
 * its only injected global.
 */
function parseCsvLikeAppsScript(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((entry) => entry.length > 1 || entry[0] !== "");
}

function detailCellFor(columnName: string, subject: CvLifecycleRow, cvCount = 1): unknown {
  const index = CV_DETAIL_COLUMNS.indexOf(columnName as (typeof CV_DETAIL_COLUMNS)[number]);
  assert.notEqual(index, -1, `no detail column named ${columnName} \u2014 the test and the feed have drifted`);
  return cvDetailRowCells({ cvCount, row: subject }, 1, BASE)[index];
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
  for (const marker of ["#SUMMARY", "#DAILY", "#DETAIL", "#LIFECYCLE"]) {
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

  // ── The view that is LIVE is the newest migration that replaces it — pin that one ─────────────
  //
  // 2026-09-17: the view was 11.5% of all production database time. Two shapes caused it and both
  // read as harmless tidy-ups, so both are pinned on whichever migration last defines the view:
  //   * an OR inside the queue join cannot be hashed, so Postgres tested 1,587,790 row pairs;
  //   * a view written with WITH is never flattened into its reader, so the five CV-text functions
  //     ran for every file on every page instead of only for the rows the page returns.
  const migrationsDir = path.join(repoRoot, "supabase/migrations");
  const viewMigrations = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(migrationsDir, name), "utf8") }))
    .filter(({ sql }) => sql.includes("create or replace view public.ats_v_cv_lifecycle"));
  // A migration may instead REWRITE the live definition — pg_get_viewdef, one select-list column
  // swapped, nothing retyped (2026-10-20: the age column reading the kept `field_age_band` key
  // first). The body it carries forward is the last one written out in full, so that is the one the
  // shape pins below read; the rewrite itself is held to swapping one output column, never a join,
  // a WITH or a filter, and to restating security_invoker, which CREATE OR REPLACE VIEW drops.
  const rewritesLive = (sql: string) => sql.includes("pg_get_viewdef('public.ats_v_cv_lifecycle'::regclass)");
  const fullDefinitions = viewMigrations.filter(({ sql }) => !rewritesLive(sql));
  const liveViewFile = fullDefinitions.at(-1)!.name;
  for (const rewrite of viewMigrations.filter(({ name, sql }) => name > liveViewFile && rewritesLive(sql))) {
    const fragments = [...rewrite.sql.matchAll(/v_(?:old|new) text := '((?:[^']|'')*)'/g)].map((match) => match[1]!.toLowerCase());
    assert.ok(fragments.length === 2, `${rewrite.name}: a rewrite of the live view must name exactly one old and one new fragment`);
    for (const fragment of fragments) {
      assert.ok(/ as \w+$/.test(fragment), `${rewrite.name}: a rewrite may swap one output column ("… AS name"), nothing else`);
      assert.ok(!/\b(join|with|where|from)\b/.test(fragment), `${rewrite.name}: a rewrite must not touch a join, a WITH, a FROM or a filter`);
    }
    assert.ok(
      rewrite.sql.includes("create or replace view public.ats_v_cv_lifecycle with (security_invoker = on) as"),
      `${rewrite.name}: a rewrite must restate security_invoker — CREATE OR REPLACE VIEW replaces the view's options`,
    );
  }
  const liveViewSql = fs.readFileSync(path.join(migrationsDir, liveViewFile), "utf8");
  const viewBody = liveViewSql
    .slice(liveViewSql.indexOf("create or replace view public.ats_v_cv_lifecycle"))
    .split("where f.kind = 'cv';")[0]!
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .toLowerCase();

  assert.ok(viewBody.includes("f.id as file_id"), `${liveViewFile}: the view must be found and parsed`);
  assert.ok(
    !/\bas with\b/.test(viewBody),
    `${liveViewFile}: the view must not carry its own WITH — a CTE-bearing view is never flattened, and the CV-text functions then run for every file on every page`,
  );
  assert.ok(
    viewBody.includes("q.channel = ev.channel and q.match_a = ev.queue_match_a and q.match_b = ev.queue_match_b"),
    `${liveViewFile}: the queue join must stay an equi-join on (channel, match_a, match_b)`,
  );
  assert.ok(!/left join \(.*\) q on[^)]* or /.test(viewBody), `${liveViewFile}: no OR may come back into the queue join`);

  // The email join is the one that silently returns nothing if it is "simplified" back to a single
  // provider_message_id comparison: measured 2026-09-04, that matched 0 of 244 email CVs, and 0
  // reads as "email CVs have no arrival time" rather than as a broken join. In the equi-join form
  // the email leg is the mailbox and uid on the event against parts 2 and 4 of the queue id.
  assert.ok(
    viewBody.includes("when e.channel = 'email' then e.mailbox_label") &&
      viewBody.includes("when e.channel = 'email' then e.provider_uid") &&
      viewBody.includes("when q_1.channel = 'email' then split_part(q_1.provider_message_id, ':', 2)") &&
      viewBody.includes("when q_1.channel = 'email' then split_part(q_1.provider_message_id, ':', 4)"),
    "the email leg of the queue join must survive — without it every email CV loses its arrival time, silently",
  );
  assert.ok(
    viewBody.includes("when e.channel = 'whatsapp' then e.provider_message_id") &&
      viewBody.includes("when q_1.channel = 'whatsapp' then q_1.provider_message_id"),
    "the WhatsApp leg of the queue join must survive",
  );
  assert.ok(
    liveViewSql.includes("raise exception 'ats_v_cv_lifecycle content changed"),
    `${liveViewFile}: a replace of this view must fingerprint the rows before and after and refuse a changed report`,
  );

  // Paging is not optional at this size: an unbounded select stops at 1000 rows with no marker and
  // production already holds 1,429 CVs. It pages by CURSOR: an OFFSET page makes the database build
  // and discard every row before it, which is what made the third page of each refresh the slowest.
  assert.ok(reader.includes(".limit(PAGE_SIZE)"), "the lifecycle read must stay paged");
  assert.ok(reader.includes(".or(cvLifecycleRowsAfter(cursor))"), "each page after the first must start after the last row read");
  assert.ok(!/\.range\(/.test(reader), "the lifecycle read must not page by OFFSET again");
  assert.ok(
    reader.includes('.order("saved_in_phoenix_at"') && reader.includes('.order("file_id"'),
    "paging needs a TOTAL order — a nullable sort key alone drops rows between pages",
  );

  // The cursor filter itself. BOTH legs matter: every file saved in one transaction shares `now()`,
  // so without `eq … and file_id.lt` a page boundary inside such a batch drops the rest of it.
  assert.equal(
    cvLifecycleRowsAfter({
      fileId: "0b9f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4",
      savedInPhoenixAt: "2026-09-04T09:01:00.123456+00:00",
    }),
    'saved_in_phoenix_at.lt."2026-09-04T09:01:00.123456+00:00",' +
      'and(saved_in_phoenix_at.eq."2026-09-04T09:01:00.123456+00:00",file_id.lt."0b9f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4")',
    "the cursor must carry the stored instant to the microsecond and break ties on file_id",
  );
  // PostgREST trims trailing zeros from the fraction and may drop it entirely; both must round-trip.
  assert.ok(
    cvLifecycleRowsAfter({ fileId: "0b9f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4", savedInPhoenixAt: "2026-09-04T09:01:00+00:00" })
      .includes('lt."2026-09-04T09:01:00+00:00"'),
  );
  for (const [savedInPhoenixAt, fileId] of [
    ["2026-09-04T09:01:00.123Z\"),or(id.gt.0", "0b9f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"],
    ["", "0b9f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4"],
    ["2026-09-04T09:01:00+00:00", "file-1"],
    ["2026-09-04T09:01:00+00:00", "undefined"],
  ] as const) {
    assert.throws(
      () => cvLifecycleRowsAfter({ fileId, savedInPhoenixAt }),
      /unexpected/,
      "a cursor that is not a timestamp and a uuid must throw — never splice it into a filter",
    );
  }

  // ── CV Details: everything Phoenix already knows about the PERSON ──────────────────────────────────────────────
  //
  // This section exists because the sheet showed an Area column that was blank seven times in
  // eight. It printed the area the candidate DECLARED — answered by 12% of them — while
  // `governorate`, filled for 76%, sat one join away in `ats_candidates` and was simply never
  // selected. Reporting "we do not know" when the answer is on the row is the defect being closed.

  assert.ok(
    csv.includes(CV_DETAIL_COLUMNS.join(",")),
    "the detail header must survive verbatim — the sheet anchors its column groups by name",
  );

  const silent = row({
    governorate: "Beni Suef",
    preferredAreaName: null,
    preferredRegionCode: null,
    preferredRegionName: null,
  });
  assert.equal(
    detailCellFor("Governorate", silent),
    "Beni Suef",
    "a candidate who never declared an area still HAS a governorate — an empty cell here is the whole bug",
  );
  assert.equal(
    detailCellFor("Prefers area", silent),
    "",
    "the declared area keeps its own column and stays honestly blank rather than borrowing the governorate",
  );

  // One row per PERSON, not per file: 982 files belong to 741 people, so a per-file tab would
  // print one applicant's education three times and make a duplicate look like three candidates.
  const collapsed = oneRowPerCandidate([row({ fileId: "f1" }), row({ fileId: "f2" })]);
  assert.equal(collapsed.length, 1, "two CVs from one candidate are one row");
  assert.equal(collapsed[0]!.cvCount, 2, "and the row states how many CVs that candidate has sent");

  // A file that never got attached to anybody must stay individually visible. Keying orphans on a
  // null candidate id would collapse every one of them under a single blank key and hide all but
  // the first — which is precisely the population most worth looking at.
  const orphans = oneRowPerCandidate([
    row({ candidateId: null, fileId: "f3" }),
    row({ candidateId: null, fileId: "f4" }),
  ]);
  assert.equal(orphans.length, 2, "orphaned CVs are never collapsed into one another");

  // Blank and "No" are different answers. Nobody asked is not the same as they said no, and
  // printing "No" for an unasked question invents a fact about a real person.
  assert.equal(detailCellFor("Medical rep before?", row({ hasMedicalRepExperience: null })), "");
  assert.equal(detailCellFor("Medical rep before?", row({ hasMedicalRepExperience: false })), "No");
  assert.equal(detailCellFor("Medical rep before?", row({ hasMedicalRepExperience: true })), "Yes");

  // The WhatsApp screening answers. Every one of these was asked, answered and stored, and then
  // shown on no screen anywhere.
  assert.equal(detailCellFor("Salary they asked for", row({ declaredExpectedSalary: "9500" })), "9500");
  assert.equal(detailCellFor("Expected salary (on file)", row({ expectedSalary: "11000" })), "11000");
  assert.equal(detailCellFor("Can commute to Sheraton", row({ screeningCommute: "yes" })), "yes");
  assert.equal(detailCellFor("English level", row({ screeningEnglishLevel: "very good" })), "very good");
  assert.equal(detailCellFor("Can start", row({ screeningStartDate: "immediately" })), "immediately");

  // A date of birth is a DATE, not an instant. Through the Cairo datetime formatter it printed
  // "1997-04-11 02:00" — a time nobody was born at, invented by reading UTC midnight in Cairo.
  assert.equal(detailCellFor("Date of birth", row({ dateOfBirth: "1997-04-11" })), "1997-04-11");
  assert.equal(detailCellFor("Date of birth", row({ dateOfBirth: null })), "");

  // ── The sheet's column groups are anchored by NAME, so a rename here silently mislabels them ──

  const script = fs.readFileSync(path.join(repoRoot, "docs/cv-lifecycle-live-sheet.gs"), "utf8");
  const anchors = [...script.matchAll(/from: '([^']+)'/g)].map((match) => match[1]!);
  assert.ok(anchors.length >= 5, "the sheet must still group its 58 detail columns into named bands");
  for (const anchor of anchors) {
    assert.ok(
      (CV_DETAIL_COLUMNS as readonly string[]).includes(anchor),
      `the sheet paints a group band starting at "${anchor}" and the feed sends no such column — the band would label the wrong block`,
    );
  }
  assert.ok(script.includes("var TAB_DETAIL = 'CV Details';"), "the sheet must still register the detail tab");
  assert.ok(
    script.includes("writeDetail_(ss, sections.DETAIL"),
    "the refresh must actually write the detail tab — registering the name alone builds nothing",
  );

  // ── The sheet must be able to READ what the feed writes ───────────────────────────
  //
  // This is the one seam the two halves of this feature meet at, and it broke in the most expensive
  // way available: silently, in the direction of doing nothing at all.
  //
  // `parseSections_` used to treat any row whose first cell began with "#" as a section marker. The
  // first column of both big tables is literally named "#", so every refresh read those two header
  // rows as markers, filed their data under a section named "", and handed back LIFECYCLE = [] and
  // DETAIL = []. `refreshCvLifecycle` then hit its own guard — fewer than two lifecycle rows means
  // never overwrite a full sheet — and returned before writing a single tab. The guard was right.
  // Everything upstream of it was green: the view, the route, the feed, this suite. The sheet just
  // sat there, and "nothing changed" was the literal truth.
  //
  // So this runs the sheet's OWN parser, extracted from the .gs verbatim, over a bundle built by the
  // real feed builder. Asserting on a hand-written fixture would have missed it; asserting the two
  // halves agree is the only shape of test that catches it.

  const parserSource = script.slice(script.indexOf("function parseSections_"));
  const parseSections = new Function(
    "Utilities",
    parserSource.slice(0, parserSource.indexOf("\n}\n") + 3) + "\nreturn parseSections_;",
  )({ parseCsv: parseCsvLikeAppsScript }) as (text: string) => Record<string, string[][]>;

  const parsed = parseSections(csv);
  for (const [name, minimum] of [
    ["SUMMARY", 2],
    ["DAILY", 2],
    ["DETAIL", 2],
    ["LIFECYCLE", 2],
  ] as const) {
    assert.ok(
      (parsed[name]?.length ?? 0) >= minimum,
      `the sheet's parser found ${parsed[name]?.length ?? 0} rows in #${name} — a header row whose first cell is "#" is being eaten as a section marker, and the refresh will write nothing at all`,
    );
  }
  assert.equal(
    parsed[""],
    undefined,
    'the parser invented a section with an empty name — that is a data header being read as a marker',
  );
  assert.deepEqual(
    parsed.LIFECYCLE?.[0],
    [...CV_LIFECYCLE_COLUMNS],
    "the lifecycle header must survive the parser intact rather than being consumed as a marker",
  );
  assert.deepEqual(
    parsed.DETAIL?.[0],
    [...CV_DETAIL_COLUMNS],
    "the detail header must survive the parser intact rather than being consumed as a marker",
  );

  // ── A builder may not address a cell it has not reserved ───────────────────────────────
  //
  // A new Google Sheets tab is 1000 rows by 26 columns and `getRange` does not extend the grid — it
  // throws. Both dimensions were out of bounds: the body ranges need row 1004, and the CV Details
  // header needs column 58. Nothing grew either one.
  //
  // What made it expensive to find is how it fails. Summary is six columns with small ranges, so it
  // rebuilds and looks new; Daily then throws on row 1004 and Detail and Lifecycle never run. One
  // tab changes and three do not, which reads as "nothing happened" — the same sentence a script
  // that never ran produces, and it sends you looking at triggers and pastes instead of at rows.

  const gridSource = script.slice(script.indexOf("function ensureGrid_"));
  const ensureGrid = new Function(
    gridSource.slice(0, gridSource.indexOf("\n}\n") + 3) + "\nreturn ensureGrid_;",
  )() as (sheet: unknown, rows: number, cols: number) => void;

  function fakeSheet(rows: number, cols: number) {
    return {
      rows,
      cols,
      getMaxRows() { return this.rows; },
      getMaxColumns() { return this.cols; },
      insertRowsAfter(_after: number, count: number) { this.rows += count; },
      insertColumnsAfter(_after: number, count: number) { this.cols += count; },
    };
  }

  const fresh = fakeSheet(1000, 26);
  ensureGrid(fresh, 1005, 58);
  assert.ok(fresh.rows >= 1005, `a fresh tab was left at ${fresh.rows} rows and the layout addresses 1004`);
  assert.ok(fresh.cols >= 58, `a fresh tab was left at ${fresh.cols} columns and CV Details has 58`);

  const roomy = fakeSheet(2000, 80);
  ensureGrid(roomy, 1005, 58);
  assert.equal(roomy.rows, 2000, "a tab that is already big enough must not grow every refresh");
  assert.equal(roomy.cols, 80, "a tab that is already big enough must not grow every refresh");

  // resetTab_ owns the guarantee, so no builder has to remember it. A builder that calls
  // resetTab_(sheet) with no size is the regression this catches: it compiles, it runs, and it
  // throws only on a tab nobody has resized by hand.
  assert.ok(
    /function resetTab_\(sheet, rows, cols\) \{\s*ensureGrid_\(sheet, rows, cols\);/.test(script),
    "resetTab_ must take a size and reserve it before anything else touches the tab",
  );
  const bareReset = script.match(/resetTab_\(sheet\)/g);
  assert.equal(
    bareReset,
    null,
    `${bareReset?.length ?? 0} builder(s) still call resetTab_ without declaring the grid they need`,
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
