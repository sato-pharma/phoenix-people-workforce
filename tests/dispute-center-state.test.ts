import assert from "node:assert/strict";

import {
  compareCasesForReviewer,
  deriveDisputeCaseState,
  isDecidedByEvents,
  lastActivityAt,
  reopenedSince,
} from "../src/lib/dispute-center/state.ts";
import type { DisputeCaseEvent, DisputeCaseEventType } from "../src/lib/dispute-center/types.ts";

/**
 * WHO OWES THE NEXT WORD — the one question the Dispute Center answers for both sides.
 *
 * The owner's two rulings this is built from (2026-10-09):
 *   - "Wait, no deadline": nothing closes itself and nothing expires. A case waits on a person.
 *   - "Employee asks, reviewer reopens": a decided case stays decided until the REVIEWER reopens it.
 *     The employee's request is a flag on the case, never a reopen.
 *
 * The state is DERIVED, never stored, so it cannot go stale against the conversation it summarises —
 * which is exactly how the three old screens disagreed about whether a dispute was still open.
 */

function event(eventType: DisputeCaseEventType, createdAt: string): DisputeCaseEvent {
  return {
    actorHrId: null,
    actorName: null,
    actorRole: null,
    createdAt,
    details: {},
    eventType,
    id: `${eventType}-${createdAt}`,
    note: null,
  };
}

const T = {
  opened: "2026-10-01T08:00:00.000Z",
  employee: "2026-10-02T08:00:00.000Z",
  reviewer: "2026-10-03T08:00:00.000Z",
  decided: "2026-10-04T08:00:00.000Z",
  asked: "2026-10-05T08:00:00.000Z",
  answered: "2026-10-06T08:00:00.000Z",
};

export async function runDisputeCenterStateTests() {
  // A dispute just opened waits on the reviewer — the opening IS the employee's word.
  assert.equal(
    deriveDisputeCaseState({ decided: false, events: [], messages: [], openedAt: T.opened }),
    "waiting_reviewer",
    "a dispute with nothing but its opening claim is waiting on the reviewer",
  );

  // The reviewer asked something: it is the employee's turn, and it waits for ever (no deadline).
  assert.equal(
    deriveDisputeCaseState({
      decided: false,
      events: [],
      messages: [{ createdAt: T.reviewer, side: "reviewer" }],
      openedAt: T.opened,
    }),
    "waiting_employee",
    "once the reviewer has written, the case waits on the employee",
  );

  // The employee answered: back to the reviewer.
  assert.equal(
    deriveDisputeCaseState({
      decided: false,
      events: [],
      messages: [
        { createdAt: T.reviewer, side: "reviewer" },
        { createdAt: T.answered, side: "employee" },
      ],
      openedAt: T.opened,
    }),
    "waiting_reviewer",
    "the employee's answer puts it back on the reviewer",
  );

  // Decided is decided — and it is still on the screen (owner: it "never disappeared from me or the
  // employee side"), it is simply not waiting on anybody.
  assert.equal(
    deriveDisputeCaseState({ decided: true, events: [event("decided", T.decided)], messages: [], openedAt: T.opened }),
    "decided",
    "a decided case reads as decided, not as waiting",
  );

  // The employee asks for another look. It FLAGS the case; it does not reopen it.
  assert.equal(
    deriveDisputeCaseState({
      decided: true,
      events: [event("decided", T.decided), event("reopen_requested", T.asked)],
      messages: [],
      openedAt: T.opened,
    }),
    "reopen_requested",
    "the employee's request shows as a reopen request while the decision still stands",
  );

  // The reviewer declined it: the decision stands and the flag is gone.
  assert.equal(
    deriveDisputeCaseState({
      decided: true,
      events: [event("decided", T.decided), event("reopen_requested", T.asked), event("reopen_declined", T.answered)],
      messages: [],
      openedAt: T.opened,
    }),
    "decided",
    "a declined request leaves the case decided, never stuck on the request",
  );

  // The reviewer reopened it: the module's own row is open again, and it waits on the REVIEWER —
  // the reviewer took it back in order to decide again, so the employee owes nothing.
  assert.equal(
    deriveDisputeCaseState({
      decided: false,
      events: [event("decided", T.decided), event("reopen_requested", T.asked), event("reopened", T.answered)],
      messages: [{ createdAt: T.reviewer, side: "reviewer" }],
      openedAt: T.opened,
    }),
    "waiting_reviewer",
    "a reopened case waits on the reviewer even though the reviewer wrote last before it",
  );

  // A module with no status of its own (a deduction dispute is a comment thread) reads its state
  // from the events alone: decided unless something reopened it afterwards.
  assert.equal(isDecidedByEvents([]), false, "no events at all is not a decision");
  assert.equal(isDecidedByEvents([event("decided", T.decided)]), true, "a decision with nothing after it stands");
  assert.equal(
    isDecidedByEvents([event("decided", T.decided), event("reopened", T.asked)]),
    false,
    "a reopen after the decision makes it open again",
  );
  assert.equal(
    isDecidedByEvents([event("decided", T.decided), event("reopened", T.asked), event("decided", T.answered)]),
    true,
    "…and deciding it a second time closes it again",
  );
  assert.equal(
    isDecidedByEvents([event("reopen_requested", T.asked)]),
    false,
    "a request on its own is not a decision — a case nobody decided must never read as closed",
  );

  // reopenedSince is what lets a revision be refused unless the case really was reopened: the
  // weekly-review settlement is immutable, so re-deciding one needs proof it was reopened AFTER the
  // first decision, not merely that a reopen exists somewhere in its history.
  assert.equal(reopenedSince([], T.decided), false, "no reopen event means it was never reopened");
  assert.equal(
    reopenedSince([event("reopened", T.asked)], T.decided),
    true,
    "a reopen after the recorded decision counts",
  );
  assert.equal(
    reopenedSince([event("reopened", T.employee)], T.decided),
    false,
    "a reopen BEFORE the current decision does not — that decision already answered it",
  );
  assert.equal(
    reopenedSince([event("reopened", T.asked)], null),
    true,
    "with no decision on record, a reopen still counts",
  );

  // The sort key of every list is the newest thing that happened, whatever kind of thing it was.
  assert.equal(
    lastActivityAt({
      decidedAt: T.decided,
      events: [event("decided", T.decided)],
      messages: [{ createdAt: T.employee }],
      openedAt: T.opened,
    }),
    T.decided,
    "a decision is activity",
  );
  assert.equal(
    lastActivityAt({ events: [], messages: [], openedAt: T.opened }),
    T.opened,
    "a case with nothing on it sorts by when it was opened",
  );
  assert.equal(
    lastActivityAt({
      decidedAt: T.decided,
      events: [event("reopen_requested", T.asked)],
      messages: [{ createdAt: T.employee }],
      openedAt: T.opened,
    }),
    T.asked,
    "a reopen request is the newest activity, so the case rises in the list",
  );

  // The reviewer's inbox order: what is waiting on him first, then the reopen requests, then the
  // cases waiting on employees, then the decided ones — newest first inside each band.
  const ranked = [
    { lastActivityAt: T.opened, name: "decided", state: "decided" as const },
    { lastActivityAt: T.employee, name: "waiting_employee", state: "waiting_employee" as const },
    { lastActivityAt: T.asked, name: "reopen_requested", state: "reopen_requested" as const },
    { lastActivityAt: T.reviewer, name: "waiting_reviewer", state: "waiting_reviewer" as const },
  ].sort(compareCasesForReviewer);
  assert.deepEqual(
    ranked.map((entry) => entry.name),
    ["waiting_reviewer", "reopen_requested", "waiting_employee", "decided"],
    "the reviewer's own queue comes first and the decided cases last",
  );

  const sameBand = [
    { lastActivityAt: T.opened, name: "older", state: "waiting_reviewer" as const },
    { lastActivityAt: T.answered, name: "newer", state: "waiting_reviewer" as const },
  ].sort(compareCasesForReviewer);
  assert.deepEqual(
    sameBand.map((entry) => entry.name),
    ["newer", "older"],
    "inside one band the newest activity is at the top",
  );
}
