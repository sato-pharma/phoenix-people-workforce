import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { outstationDeparturePhotoReminderDue } from "../src/lib/outstation/expense-gate.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** Slice one function body so an assertion is scoped to it, not to the whole 3k-line service. */
function functionSlice(src: string, declaration: string) {
  const start = src.indexOf(declaration);
  assert.notEqual(start, -1, `expected to find ${declaration}`);
  const rest = src.slice(start + declaration.length);
  const nextExport = rest.indexOf("\nexport ");
  const nextFn = rest.indexOf("\nasync function ");
  const ends = [nextExport, nextFn].filter((index) => index !== -1);
  return rest.slice(0, ends.length > 0 ? Math.min(...ends) : rest.length);
}

/**
 * The departure-photo reminder — the only thing that ever tells an employee his expense is stuck
 * behind a photo he has not taken.
 *
 * Two defects were found in production on 2026-08-19, and between them they meant six employees
 * were owed EGP 2,279.67 behind a step nobody had asked them for in time:
 *
 *   1. The reminder only ever fired from a 06:36 Cairo daily job. For a SAME-DAY trip the request
 *      does not exist at that hour — it is submitted in the afternoon or evening, after the
 *      travelling (median 16:00 Cairo, some as late as 21:40). So the "last day" reminder could
 *      never fire for a one-day trip, and the first and only notice was the next morning's
 *      "overdue" one, telling someone to photograph a destination he had already left. Production
 *      held 8 reminders and every single one was "overdue"; not one "due today" had ever been sent.
 *
 *   2. The email half was refused on every single send — 8 of 8 — because the call carried no
 *      subject HR ID and `outstation` is an employee-subject workflow module. The event row still
 *      read "sent"; only the delivery's `last_error` said otherwise. No employee has ever received
 *      an email about a departure photo.
 *
 * Later the same evening the owner asked what the overdue message was for, and retired it. The
 * departure photo is a live capture at the destination; once the employee is home there is no
 * photo left for him to take, so an overdue mail asks either for nothing or for a capture in the
 * wrong place — which comes back flagged and reads as suspicious for a trip that really happened.
 * **The reminder now fires on the trip's last day and on no other day**, and a request past its
 * window is released by a Super Admin instead of chased. Most of what is asserted below is the
 * silence: the days this must NOT send on now outnumber the one day it may.
 */
export function runOutstationDeparturePhotoReminderTests() {
  const TODAY = "2026-08-19";
  const due = (over: Partial<Parameters<typeof outstationDeparturePhotoReminderDue>[0]>) =>
    outstationDeparturePhotoReminderDue({
      gateBlocker: over.gateBlocker === undefined ? "departure_photo" : over.gateBlocker,
      todayCairo: over.todayCairo ?? TODAY,
      tripEndDate: over.tripEndDate === undefined ? TODAY : over.tripEndDate,
    });

  // ── Only the departure photo triggers this reminder ──────────────────────────────
  // Telling someone to take a photo when what is actually missing is the CRM workload sends him
  // to do something that cannot help, and teaches him the message is not worth reading.
  for (const gateBlocker of [null, "arrival_photo", "workload", "inconsistent"] as const) {
    assert.deepEqual(
      due({ gateBlocker }),
      { due: false },
      `blocker ${String(gateBlocker)} must not raise a DEPARTURE-photo reminder`,
    );
  }

  // ── Never before the trip's last day ─────────────────────────────────────────────
  // A reminder on day one of a five-day trip arrives before the employee could act on it, and
  // noise is how the real ones start getting ignored.
  assert.deepEqual(
    due({ tripEndDate: "2026-08-20" }),
    { due: false },
    "a trip still running must not be reminded — the photo is not due until he leaves",
  );
  assert.deepEqual(due({ tripEndDate: "2026-08-25" }), { due: false }, "nor one days away");

  // ── On the last day — the ONLY day it sends ──────────────────────────────────────
  // This is the case that had never once fired in production. It is reachable only because the
  // submit path now raises the reminder too — the 06:36 job cannot see a request that does not
  // exist yet at 06:36.
  assert.deepEqual(
    due({ tripEndDate: TODAY }),
    { due: true },
    "on the trip's last day the reminder is due — he is still at the destination and a photo he takes now is real evidence",
  );

  // ── After the last day: NOTHING, ever ────────────────────────────────────────────
  // Owner's decision, 2026-08-19. This is the assertion that keeps the retired overdue message
  // from creeping back: there is no photo he can still take, so there is nothing to ask for.
  // A request in this state is released by a Super Admin, not chased by email.
  for (const tripEndDate of ["2026-08-18", "2026-08-01", "2026-07-01", "2025-12-31"]) {
    assert.deepEqual(
      due({ tripEndDate }),
      { due: false },
      `a trip that ended on ${tripEndDate} must send nothing — the departure photo can no longer be taken where it had to be taken, so an "overdue" mail asks either for nothing or for a capture in the wrong place`,
    );
  }
  // One day either side of the boundary, stated as a pair so an off-by-one cannot pass: the last
  // day sends, the very next day does not.
  assert.equal(due({ todayCairo: "2026-08-19", tripEndDate: "2026-08-19" }).due, true, "last day sends");
  assert.equal(
    due({ todayCairo: "2026-08-20", tripEndDate: "2026-08-19" }).due,
    false,
    "the morning after does not — that single day is the whole of the change",
  );

  // The shape itself: nothing may carry an `overdue` flag any more. A vestigial always-false
  // field is how a retired branch quietly comes back.
  assert.deepEqual(
    Object.keys(due({ tripEndDate: TODAY })),
    ["due"],
    "the rule answers one question now — a lingering `overdue` key is an invitation to re-branch on it",
  );

  // ── Unreadable dates send nothing ────────────────────────────────────────────────
  // Compared as strings, so any non-date text sorts ABOVE a "2026-…" date. Without the shape
  // check a malformed value reads as a far-future trip and the reminder silently never sends —
  // the exact failure this whole area exists to correct.
  for (const tripEndDate of [null, "", "not-a-date", "n/a", "19/08/2026"]) {
    assert.deepEqual(
      due({ tripEndDate }),
      { due: false },
      `trip end ${JSON.stringify(tripEndDate)} is not a date this may act on`,
    );
  }
  for (const todayCairo of ["", "today", "2026-8-19"]) {
    assert.deepEqual(
      due({ todayCairo }),
      { due: false },
      `today ${JSON.stringify(todayCairo)} is not a date this may act on`,
    );
  }

  // ── The email must carry a subject identity ──────────────────────────────────────
  // `outstation` is in employeeSubjectWorkflowModules, so resolvedEmailIdentity() REQUIRES a
  // subject HR ID and skips the email outright without one. This is a source assertion because
  // the send needs Supabase; it is the only way to pin the field that made every email vanish.
  const service = source("src/lib/outstation/service.ts");
  const sendSlice = functionSlice(service, "export async function sendOutstationDeparturePhotoReminder");
  assert.match(
    sendSlice,
    /subjectHrId: row\.employeeHrId/,
    "the reminder must name its subject employee, or the email half is skipped and only push survives",
  );
  assert.match(
    sendSlice,
    /outstationDeparturePhotoReminderDue\(\{/,
    "the send must delegate the timing to the pure rule rather than re-deriving it inline",
  );

  // ── One message, one key, no overdue variant left in the sender ──────────────────
  // The rule above stops the overdue branch being REACHED; these stop it being REBUILT. A second
  // wording behind a ternary is how it would come back, and the key is what would make it a
  // separate, un-deduplicated send rather than a no-op.
  // Comments stripped first: the metadata note explains WHY the overdue message is gone, and a
  // test that forbade the word outright would forbid recording the decision.
  const sendCode = sendSlice.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.equal(
    /overdue/i.test(sendCode),
    false,
    "no executable trace of `overdue` may remain in the sender — the wording, the tone and the title were all branched on it, and a surviving branch is a message waiting for someone to re-enable it",
  );
  assert.match(
    sendSlice,
    /`outstation:\$\{String\(row\.id\)\}:departure-photo:due`/,
    "the automatic key is now a single fixed key — one reminder per request, ever",
  );
  assert.equal(
    (sendSlice.match(/title:/g) ?? []).length,
    1,
    "one title",
  );
  assert.equal(
    (sendSlice.match(/message:/g) ?? []).length,
    1,
    "and one message — two means the retired variant is back",
  );

  // ── It must fire at SUBMIT time, not only from the daily job ─────────────────────
  const submitSlice = functionSlice(service, "export async function submitOutstationRequest");
  assert.match(
    submitSlice,
    /await sendOutstationDeparturePhotoReminder\(submitted, cairoTodayIso\(\)\)/,
    "the submit path must raise the reminder itself — the 06:36 job cannot see a request created at 20:49",
  );
  // Swallowed on purpose: a failed reminder must never fail the submission the employee just made.
  assert.match(
    submitSlice,
    /try \{\s*\n\s*await sendOutstationDeparturePhotoReminder\(/,
    "the submit-time reminder must be wrapped — a notification failure may not lose the request",
  );

  // ── The daily job still runs through the same function ───────────────────────────
  // Two copies of "when is this due" is how the job and the submit path drift apart.
  const jobSlice = functionSlice(service, "export async function runOutstationDeparturePhotoReminders");
  assert.match(
    jobSlice,
    /await sendOutstationDeparturePhotoReminder\(row, today\)/,
    "the daily job must call the shared sender, not its own inlined copy",
  );
}
