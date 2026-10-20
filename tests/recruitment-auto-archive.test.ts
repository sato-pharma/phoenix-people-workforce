import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  AUTO_ARCHIVE_ACTOR,
  archiveCutoff,
  rejectionsToArchive,
  type ArchiveCandidateRow,
} from "../src/lib/recruitment/workspace/archive.ts";
import { ARCHIVE_REJECTED_AFTER_DAYS } from "../src/lib/recruitment/workspace/vocabulary.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The daily auto-archive of old rejections (owner's plan, Phase 4, 20 Oct 2026: rejections leave the
// working lists after 30 days).
//
// Measured from the REJECTION (`status_changed_at`), never from arrival; archived, never deleted; a
// manager's Skip still waiting in the Returned filter is held; the write re-checks its own WHERE so a
// candidate HR re-opened in between is left alone. Production on 20 Oct 2026 held 51 rejected
// candidates, every one with a rejection time, one of them past 30 days — the shape fixed below.
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-10-20T01:29:00.000Z"); // 03:29 Cairo, when the job runs
const DAY = 86_400_000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function rejected(id: string, days: number | null, overrides: Partial<ArchiveCandidateRow> = {}): ArchiveCandidateRow {
  return {
    archived_at: null,
    id,
    status: "rejected",
    status_changed_at: days === null ? null : daysAgo(days),
    ...overrides,
  };
}

function flat(file: string): string {
  return stripComments(readFileSync(file, "utf8")).replace(/\s+/g, " ");
}

export function runRecruitmentAutoArchiveTests(): void {
  // ── 1 · The threshold is the owner's 30 days, measured from the rejection ────────────────────
  assert.equal(ARCHIVE_REJECTED_AFTER_DAYS, 30, "the owner's number");
  assert.equal(archiveCutoff(NOW).toISOString(), daysAgo(30));

  const rows: ArchiveCandidateRow[] = [
    rejected("old", 31),
    rejected("exactly-30", 30),
    rejected("just-past", 30.0001),
    rejected("recent", 3),
    rejected("no-time", null),
    rejected("already", 90, { archived_at: daysAgo(10) }),
    rejected("reopened", 60, { status: "shortlisted" }),
    rejected("returned", 45),
  ];
  const returned = new Set(["returned"]);
  const ids = rejectionsToArchive(rows, returned, NOW);

  assert.deepEqual(ids, ["old", "just-past"], "RED only rejections strictly older than 30 days");
  assert.ok(!ids.includes("exactly-30"), "the day itself is not yet past it");
  assert.ok(!ids.includes("recent"));
  assert.ok(!ids.includes("no-time"), "RED a rejection with no time is never guessed old");
  assert.ok(!ids.includes("already"), "an archived row is not archived twice");
  assert.ok(!ids.includes("reopened"), "RED only a candidate still rejected");
  assert.ok(!ids.includes("returned"), "RED a manager's return still waiting on HR is held however old");
  assert.deepEqual(rejectionsToArchive(rows, new Set(), NOW), ["old", "just-past", "returned"], "and archives once HR has acted on it");

  // A different window is honoured (the same function, one number).
  assert.deepEqual(rejectionsToArchive([rejected("a", 8), rejected("b", 6)], new Set(), NOW, 7), ["a"]);

  // ── 2 · The writer: archived, never deleted; the WHERE re-checked; who did it stamped ─────────
  const archive = flat("src/lib/recruitment/workspace/archive.ts");
  assert.equal(AUTO_ARCHIVE_ACTOR, "system:auto-archive");
  assert.match(
    archive,
    /\.update\(\{ archived_at: archivedAt, archived_by: AUTO_ARCHIVE_ACTOR \}\) \.in\("id", batch\) \.eq\("status", "rejected"\) \.is\("archived_at", null\)/,
    "RED the write re-checks status and archived_at in its own WHERE, so a CV re-opened in between is not archived from under HR",
  );
  assert.match(archive, /\.lt\("status_changed_at", cutoff\.toISOString\(\)\)/, "the read is by rejection time, never created_at");
  assert.ok(!/created_at/.test(archive), "RED arrival time is never the measure");
  assert.match(archive, /\.from\("ats_v_candidate_returns"\)/, "the Returned filter's own view decides what is held");
  assert.ok(!/\.delete\(/.test(archive), "RED archived, never deleted");
  assert.ok(!/notification|sendEmail|resend|telegram|whatsapp/i.test(archive), "nothing is sent to anybody");
  assert.match(archive, /if \(options\.dryRun \|\| ids\.length === 0\) return result;/, "a dry run writes nothing");

  // ── 3 · The cron: authorised, watched, and able to rehearse ──────────────────────────────────
  const cron = flat("app/api/cron/recruitment-archive-rejections/route.ts");
  assert.match(cron, /assertCronAuthorized\(request, "cron\/recruitment-archive-rejections"\)/, "RED only the scheduler may call it");
  assert.match(
    cron,
    /withDeadMansSwitch\("phoenix-recruitment-archive-rejections", \(\) => archiveOldRejections\(\)\)/,
    "a missed day is noticed — the slug job-schedule.ts registers",
  );
  assert.match(cron, /searchParams\.get\("dryRun"\) === "1"/);
  assert.match(cron, /archiveOldRejections\(\{ dryRun: true \}\)/, "?dryRun=1 reports and writes nothing");
}
