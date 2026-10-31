import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// 2026-10-23, every page change under 1 second. Two reads that waited on an answer they did not need
// now start beside it:
//
//   • the visit day (src/lib/phoenix-crm/server/visits.ts `loadVisitDay`) read its rows, THEN the day's
//     activities, start and product managers, THEN the recordings — three waves. The day reads need only
//     the seat and the date, so they start beside the rows, and the recordings go with the names: two.
//   • the messages list (src/lib/internal-messages/service.ts `listInternalMessagesForViewer`) resolved
//     the sender, THEN asked for the messages — two waves. It now asks with the session's own ids beside
//     the lookup, and uses those rows only when the lookup resolves to the very same filters: one.
//
// Nothing on a screen changes, so nothing on a screen catches either of them slipping back into a
// wave of its own — or the messages shortcut ever answering with rows the resolved viewer would not
// have read. These are that signal.

function source(path: string): string {
  return stripComments(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
}

/** A top-level function's text, from its declaration to the first column-0 closing brace. */
function functionBody(text: string, declaration: string): string {
  const start = text.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} must still exist`);
  const rest = text.slice(start);
  const end = rest.indexOf("\n}\n");
  return rest.slice(0, end > 0 ? end : rest.length);
}

function assertBefore(text: string, first: string, second: string, message: string): void {
  const a = text.indexOf(first);
  const b = text.indexOf(second);
  assert.ok(a >= 0, `${message} — missing: ${first}`);
  assert.ok(b >= 0, `${message} — missing: ${second}`);
  assert.ok(a < b, message);
}

function awaitsIn(text: string): number {
  return (text.match(/\bawait\b/g) ?? []).length;
}

export async function runPageChangeFewerWavesTests(): Promise<void> {
  // ── the visit day: two waves, not three ──────────────────────────────────────────────────────
  {
    const day = functionBody(source("src/lib/phoenix-crm/server/visits.ts"), "export async function loadVisitDay(");
    assert.match(day, /const rowsRead = loadVisitRows\(seat\.seatId, isTest, date\);/, "the visit rows start without being awaited on the spot");
    for (const early of [
      "loadDayActivityOn(seat.seatId, isTest, date)",
      "loadDayActivityOn(ownSeat.seatId, isTest, date)",
      "productManagerRolesFor(viewer.org, seat.seatId)",
      "loadDayStartOn(seat.seatId, isTest, date)",
    ]) {
      assertBefore(day, early, "await rowsRead", `${early} starts beside the visit rows, never after them`);
    }
    assert.match(day, /dayReads\.catch\(\(\) => undefined\);/, "an early read's failure is handled the moment it starts, so it never goes unhandled while the rows are read");
    assert.match(
      day,
      /await Promise\.all\(\[\s*loadPeopleNames\([\s\S]*?\),\s*loadRecordingsByVisit\(rows\.map\(\(row\) => String\(row\.id\)\)\),\s*dayReads,\s*\]\)/,
      "the names, the recordings and the early day reads are awaited together, in the one wave after the rows",
    );
    assert.equal(awaitsIn(day), 2, "HEADLINE: the visit day waits twice — the rows, then everything that needs them — never a third wave");
  }

  // ── the messages list: one wave, and never another viewer's rows ─────────────────────────────
  {
    const list = functionBody(source("src/lib/internal-messages/service.ts"), "export async function listInternalMessagesForViewer(");
    assert.match(
      list,
      /const sessionFilters = viewerFilters\(\{ hrId: normalizeHrId\(access\.hrId\), loginId: cleanText\(access\.loginId\) \|\| null \}\);/,
      "the early read is scoped to the session's OWN ids, and to nothing else",
    );
    assertBefore(list, "const senderLookup = resolveSender(access);", "readMessageRows(sessionFilters)", "the sender lookup starts first");
    assertBefore(list, "readMessageRows(sessionFilters)", "await senderLookup", "HEADLINE: the messages are asked for beside the sender lookup, never after it");
    assert.doesNotMatch(list, /await resolveSender\(/, "the list never waits on the lookup before it starts reading");
    assert.match(
      list,
      /earlyRows && sessionFilters\.join\(","\) === filters\.join\(","\) \? await earlyRows : null/,
      "the early rows are used ONLY when the resolved viewer's filters are the very same strings",
    );
    assert.match(list, /\(error: unknown\) => \(\{ rows: null, error \}\)/, "the early read's failure is held as a value, never dropped");
    assert.match(list, /if \(early && early\.rows === null\) throw early\.error;/, "and raised when its rows are the ones used");
    assert.match(list, /early\?\.rows \?\? \(await readMessageRows\(filters\)\)/, "a mismatch reads the list again with the resolved filters, exactly as before");
    assert.match(list, /rows\.map\(\(row\) => mapMessage\(row, sender\)\)/, "every row is mapped with the RESOLVED sender, as before");
    assertBefore(list, "try {", "await earlyRows", "a missing messages table still degrades to an empty list on the early path too");
    assertBefore(list, "if (filters.length === 0) return { messages: [], unreadCount: 0 };", "await earlyRows", "an identity with no filter still answers empty before any rows are used");
  }

  // ── the rep's day page: leave and the visits in full start beside the day (2026-10-31) ──────────
  // "fix the slowest five pages": the Phoenix CRM day page waited for the day, THEN for leave, THEN for
  // the full-visit table — seven waves for reads that needed only the seat and the date.
  {
    const detail = functionBody(source("src/lib/phoenix-crm/server/day-detail.ts"), "export async function loadPhoenixCrmDayDetail(");
    assertBefore(detail, "resolveVisitDayAddress(viewer, raw)", "readDayLeave(", "the day's address is settled first, with no read and the same refusal");
    for (const early of ["readDayLeave(address.seat.occupantHrId, address.date)", "readVisitsInFull(viewer, address)"]) {
      assertBefore(detail, early, "await loadVisitDay(viewer, raw)", `HEADLINE: ${early} starts beside the day, never after it`);
    }
    assert.match(
      detail,
      /await Promise\.all\(\[leaveRead, visitsInFullRead\]\)/,
      "and both are awaited together once the day is in",
    );
    const visits = functionBody(source("src/lib/phoenix-crm/server/visits.ts"), "export async function loadVisitDay(");
    assert.match(visits, /resolveVisitDayAddress\(viewer, raw\)/, "the visit day clamps its date through the same helper, so the two never disagree on which day");
  }
}
