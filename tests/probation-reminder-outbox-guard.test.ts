// PROBATION REMINDER OUTBOX GUARD — a missing COLUMN must never silence a reminder.
//
// Found 2026-09-30 by the org and hiring-lifecycle select-audit. Both reminder writes go to the
// SHARED outbox `notification_events`, but they guarded the result with `isProbationSchemaMissing` —
// a predicate written for probation's OWN tables during the window before their migration landed.
// One of the things it matches is the bare phrase "schema cache", and that is exactly how PostgREST
// words a missing COLUMN:
//
//   Could not find the 'scheduled_for' column of 'notification_events' in the schema cache
//
// So a dropped or renamed outbox column would have made every "probation feedback is due" and
// "decision overdue" row silently fail to be created. No manager told, no row to find, nothing red.
// The owner has already lost a night to a notification job whose halves had drifted apart, so a
// visible failure beats a notice nobody receives.
//
// `isNotificationOutboxMissing` tolerates only the case the original was reaching for — the TABLE
// being absent — and states that positively, so a new PostgREST wording cannot quietly widen it.

import { strict as assert } from "node:assert";

import { isNotificationOutboxMissing, isProbationSchemaMissing } from "../src/lib/probation/service.ts";

const err = (message: string, code?: string) => (code ? Object.assign(new Error(message), { code }) : new Error(message));

export function runProbationReminderOutboxGuardTests() {
  // 1. THE REGRESSION. Every way PostgREST and Postgres word a missing column must NOT be tolerated.
  const missingColumn = [
    err("Could not find the 'scheduled_for' column of 'notification_events' in the schema cache", "PGRST204"),
    err("Could not find the 'recipients' column of 'notification_events' in the schema cache"),
    err('column "subject" of relation "notification_events" does not exist', "42703"),
    err('column notification_events.event_key does not exist'),
  ];
  for (const error of missingColumn) {
    assert.equal(
      isNotificationOutboxMissing(error),
      false,
      `a missing COLUMN must throw, not be swallowed — "${error.message.slice(0, 60)}" would have silenced `
        + "every probation reminder with nothing red anywhere",
    );
  }

  // And the proof that this is a real change: the OLD predicate tolerated every one of them.
  for (const error of missingColumn.slice(0, 2)) {
    assert.equal(
      isProbationSchemaMissing(error),
      true,
      "isProbationSchemaMissing still matches the missing-column wording — which is exactly why the "
        + "reminder writes must not use it. If this ever goes false, that helper changed and this "
        + "test's premise needs re-reading rather than deleting",
    );
  }

  // 2. The one case the original was reaching for is KEPT: the outbox table genuinely not there.
  const missingTable = [
    err("Could not find the table 'public.notification_events' in the schema cache", "PGRST205"),
    err('relation "notification_events" does not exist', "42P01"),
    err("Could not find the table 'public.notification_events' in the schema cache"),
  ];
  for (const error of missingTable) {
    assert.equal(
      isNotificationOutboxMissing(error),
      true,
      `a genuinely absent outbox table must still be tolerated — "${error.message.slice(0, 50)}"`,
    );
  }

  // 3. Anything else is a real failure and must surface: a timeout, a policy, a constraint.
  const realFailures = [
    err("canceling statement due to statement timeout", "57014"),
    err("new row violates row-level security policy for table \"notification_events\"", "42501"),
    err('duplicate key value violates unique constraint "notification_events_event_key_key"', "23505"),
    err("fetch failed"),
  ];
  for (const error of realFailures) {
    assert.equal(
      isNotificationOutboxMissing(error),
      false,
      `a real failure must throw — "${error.message.slice(0, 50)}" is not the table being absent`,
    );
  }

  // 4. A missing column on some OTHER table is still not this table being absent.
  assert.equal(
    isNotificationOutboxMissing(err("Could not find the table 'public.probation_cases' in the schema cache", "PGRST205")),
    true,
    "the code is authoritative when it is present — PGRST205 is a missing relation whatever it names",
  );
  assert.equal(
    isNotificationOutboxMissing(err("Could not find the table 'public.probation_cases' in the schema cache")),
    false,
    "but with no code, the message must name notification_events — this guard speaks only for the outbox",
  );
}
