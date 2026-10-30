import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments, stripSqlComments } from "./support/comment-strip.ts";

/**
 * Phoenix CRM — the interviews on an Interviews day (owner, 2026-10-29: "if interviews attach the cvs
 * and scheduled time"; asked which, he answered "Both").
 *
 *   1. The interviews already booked for him in the hiring calendar that day are shown, each with its
 *      time and its CV, and COPIED onto the day when it is saved — a later edit of the calendar does not
 *      rewrite what the day recorded.
 *   2. He can add one that is missing, with the candidate's name, the time and the CV, all required.
 *   3. An Interviews day with none of either is REFUSED, before anything is written.
 *   4. Recording the day as anything else, or clearing it, drops its interviews and their CV files.
 *
 * Each is silent when broken — a save that forgets the snapshot still answers 200, and a refusal moved
 * after the RPC still refuses, having already written the day — so they are pinned here.
 */

const MIGRATION = "supabase/migrations/20261029235000_phoenix_crm_day_interviews.sql";

function source(path: string): string {
  return stripComments(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
}

function functionBody(text: string, name: string): string {
  const start = text.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is still exported`);
  const next = text.indexOf("\nexport ", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

export function runPhoenixCrmDayInterviewsTests(): void {
  // ── The save: refuse first, write, then copy the bookings — or drop them ────────────────────────
  {
    const save = functionBody(source("src/lib/phoenix-crm/server/day-activities.ts"), "saveDayActivity");
    const refuse = save.indexOf("interviewsForDaySave(");
    // The LAST call is the save; clearing the day goes through the same RPC first.
    const rpc = save.lastIndexOf('callPhoenixCrm("phoenix_crm_save_day_activity"');
    const snapshot = save.indexOf("snapshotBookedInterviews(");
    assert.ok(refuse >= 0, "an Interviews day reads its interviews before it is saved");
    assert.ok(rpc >= 0, "the day is still saved through its one RPC");
    assert.ok(refuse < rpc, "the refusal comes BEFORE the save, so a day with no interview writes nothing");
    assert.ok(snapshot > rpc, "the booked interviews are copied once the day is saved");
    assert.match(
      save,
      /activityType === "interviews"\s*\?\s*await interviewsForDaySave\(/,
      "only an Interviews day is asked for its interviews",
    );
    assert.match(
      save.slice(snapshot),
      /else await dropDayInterviews\(/,
      "a day recorded as anything else drops the interviews it carried",
    );
    const clear = save.slice(0, save.indexOf("parseDayActivityDraft("));
    assert.match(clear, /await dropDayInterviews\(/, "clearing the day drops its interviews and their CVs");
  }

  // ── The refusal itself: none booked and none added is refused, with a sentence and a code ───────
  {
    const cvs = source("src/lib/phoenix-crm/server/interview-cvs.ts");
    const gate = functionBody(cvs, "interviewsForDaySave");
    assert.match(gate, /if \(booked\.length \+ added\.length === 0\)/, "the day needs one interview, booked or added");
    assert.match(gate, /"interviews_required"/, "the refusal carries its own code");
    assert.match(gate, /storedOn\(seat\.seatId, isTest, date, "added"\)/, "the ones he added count");
    assert.match(gate, /bookedOn\(seat\.occupantHrId, date\)/, "the hiring calendar's bookings for that person count");

    // An added interview needs all three: the name, the time and the CV.
    const add = functionBody(cvs, "addDayInterview");
    assert.match(add, /territoryForDayWrite\(/, "only the day's own writer adds one");
    assert.match(add, /Write the candidate's name\./);
    assert.match(add, /Choose the time of the interview\./);
    assert.match(add, /Attach the candidate's CV\./);
    assert.match(add, /DAY_INTERVIEW_CV_MAX_BYTES/, "the CV has a size limit");

    // Removing one is for today's added rows only — a booked one is the hiring calendar's.
    const remove = functionBody(cvs, "removeDayInterview");
    assert.match(remove, /"added"/, "only an added interview can be removed");

    // A CV opens only for someone who reads that territory, and only for a short while.
    const signed = functionBody(cvs, "signedDayInterviewCvUrl");
    assert.match(signed, /territoryForRead\(/, "a CV opens only for a reader of that territory");
    assert.match(signed, /createSignedUrl\(path, SIGNED_URL_SECONDS\)/, "the CV link is the short one");
    assert.match(cvs, /const SIGNED_URL_SECONDS = 600;/, "the CV link lasts ten minutes");
  }

  // ── Opening a CV is audited like an export ────────────────────────────────────────────────────
  {
    const route = source("app/api/phoenix-crm/day-interviews/cv/route.ts");
    assert.match(route, /afterResponse\("phoenix_crm_day_interview_cv_audit"/, "opening a CV writes an audit row");
    assert.match(route, /writeAuditLog\(/);
  }

  // ── The table: two shapes, nothing else ───────────────────────────────────────────────────────
  {
    const sql = stripSqlComments(readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8").replace(/\r\n/g, "\n"));
    assert.match(sql, /check \(source in \('calendar', 'added'\)\)/);
    assert.match(
      sql,
      /\(source = 'added' and booking_id is null and cv_path is not null and cv_file_name is not null and cv_mime_type is not null\)\s*or \(source = 'calendar' and booking_id is not null and cv_path is null\)/,
      "an added interview carries its CV file; a booked one carries its booking",
    );
    assert.match(sql, /calendar_cv_url like '\/api\/recruitment\/interview-calendar\/%'/, "a booked CV opens only through the hiring calendar's own door");
    assert.match(sql, /'phoenix-crm-interview-cvs',\s*'phoenix-crm-interview-cvs',\s*false,/, "the CV bucket is private");
    assert.match(sql, /revoke all on table public\.phoenix_crm_day_interviews from public, anon, authenticated;/);
  }

  // ── The screen: Save waits for the first interview ────────────────────────────────────────────
  {
    const start = source("src/components/phoenix-crm/visit-start.tsx");
    assert.match(
      start,
      /const waitingForInterviews = activity === "interviews" && \(interviewCount === null \|\| interviewCount === 0\);/,
      "an Interviews day cannot be saved from the screen until an interview is on it",
    );
    assert.match(start, /disabled=\{waitingForInterviews\}/, "the Save button is the one that waits");
    assert.match(start, /<DayInterviewsEntry /, "the entry shows the booked interviews and the add form");
    for (const file of ["src/components/phoenix-crm/day-detail-view.tsx", "src/components/phoenix-crm/visits-tab.tsx"]) {
      assert.match(source(file), /activityType === "interviews" \? \(\s*<div[^>]*>\s*<DayInterviewsList /, `${file} reads a recorded Interviews day back`);
    }
  }
}
