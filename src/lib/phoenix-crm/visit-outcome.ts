/**
 * Phoenix CRM — what the rep took away from a visit: the objection he met, and what he will do next.
 *
 * Owner, 2026-09-26, as part of Golden Rule #1. A call report that records only WHO was seen and WHAT
 * was discussed is an attendance sheet. The two questions a pharmaceutical manager actually coaches
 * on are what the doctor pushed back on and what the rep committed to — and neither is anywhere in
 * this module today.
 *
 * ## Both halves of the golden rule live in this file
 *
 * **EASY.** Two rows of chips, both optional, neither ever typed. The date and the free-text note
 * appear only once a chip that needs them is tapped, so the rep who has nothing to add taps nothing
 * and the form is no longer than it was. The next step comes back to him at the NEXT visit to the
 * same customer, which is the whole point of writing it down.
 *
 * **BLIND.** Nothing here judges him. `objection` is the DOCTOR's objection, never a mark against the
 * rep, and the word "flag" appears nowhere. It is recorded because a rep who never once meets an
 * objection in a month is worth a quiet look on the Super Admin's board — and that look happens over
 * there, where he cannot see it, never here.
 *
 * ## An unknown value falls back to null, and nothing is refused
 *
 * Deliberately the OPPOSITE of `day-activities.ts`, where an unknown kind is refused because the kind
 * IS the record. Here these are extras on a visit that is otherwise complete: a phone one release
 * behind sending `next_step: "sample_left"` must not cost a rep a visit he actually made, standing at
 * a door with a photo he cannot retake. The value is dropped and the visit saves.
 */

export const VISIT_NEXT_STEPS = [
  { key: "follow_up", label: "Follow up next visit" },
  { key: "send_data", label: "Send the data" },
  { key: "arrange_double", label: "Arrange a double visit" },
  { key: "invite_event", label: "Invite to an event" },
  { key: "pharmacy_stock", label: "Chase the pharmacy stock" },
  { key: "none", label: "Nothing to follow" },
] as const;

export const VISIT_OBJECTIONS = [
  { key: "price", label: "Price" },
  { key: "efficacy", label: "Not convinced it works" },
  { key: "safety", label: "Side effects or safety" },
  { key: "competitor", label: "Prescribes a competitor" },
  { key: "formulary", label: "Not on the hospital list" },
  { key: "no_time", label: "No time to listen" },
  { key: "none", label: "No objection" },
] as const;

export type VisitNextStep = (typeof VISIT_NEXT_STEPS)[number]["key"];
export type VisitObjection = (typeof VISIT_OBJECTIONS)[number]["key"];

export const OBJECTION_NOTE_MAX = 300;

const NEXT_STEP_KEYS = new Set<string>(VISIT_NEXT_STEPS.map((entry) => entry.key));
const OBJECTION_KEYS = new Set<string>(VISIT_OBJECTIONS.map((entry) => entry.key));

export function isVisitNextStep(value: unknown): value is VisitNextStep {
  return typeof value === "string" && NEXT_STEP_KEYS.has(value);
}

export function isVisitObjection(value: unknown): value is VisitObjection {
  return typeof value === "string" && OBJECTION_KEYS.has(value);
}

export function visitNextStepLabel(value: VisitNextStep): string {
  return VISIT_NEXT_STEPS.find((entry) => entry.key === value)?.label ?? value;
}

export function visitObjectionLabel(value: VisitObjection): string {
  return VISIT_OBJECTIONS.find((entry) => entry.key === value)?.label ?? value;
}

/**
 * `none` is STORED, never collapsed to null.
 *
 * "He tapped No objection" and "he left the row alone" are different facts, and only the first is an
 * answer. Collapsing them would leave the manager's board unable to tell a rep who reports honestly
 * that a call went smoothly from a rep who never fills the row in at all — and telling those two
 * apart is the entire reason the column exists.
 */
export function isFollowUp(value: VisitNextStep | null): boolean {
  return value !== null && value !== "none";
}

export type VisitOutcome = {
  nextStep: VisitNextStep | null;
  /** The day he means to do it. Only ever kept beside a next step that is something to do. */
  nextStepOn: string | null;
  objection: VisitObjection | null;
  /** What was actually said, in his words. Only ever kept beside a real objection. */
  objectionNote: string | null;
};

export const EMPTY_VISIT_OUTCOME: VisitOutcome = { nextStep: null, nextStepOn: null, objection: null, objectionNote: null };

function isoDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return null;
  // A calendar-shaped string is not a calendar day: 2026-02-31 passes the pattern above.
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

/**
 * The outcome from the wire. It cannot fail — see the header.
 *
 * The two dependents are cleared with their parent rather than left behind: a date under "Nothing to
 * follow", or a note under "No objection", is a sentence on a screen that contradicts the chip
 * beside it. Clearing them here means no screen has to remember the rule.
 */
export function parseVisitOutcome(raw: unknown): VisitOutcome {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const nextStep = isVisitNextStep(body.nextStep) ? body.nextStep : null;
  const objection = isVisitObjection(body.objection) ? body.objection : null;

  const note = typeof body.objectionNote === "string" ? body.objectionNote.replace(/\s+/g, " ").trim() : "";

  return {
    nextStep,
    nextStepOn: isFollowUp(nextStep) ? isoDay(body.nextStepOn) : null,
    objection,
    // Sliced, never refused: the cap is a column width, not a rule the rep broke.
    objectionNote: objection !== null && objection !== "none" && note ? note.slice(0, OBJECTION_NOTE_MAX) : null,
  };
}

// ── What he said last time ──────────────────────────────────────────────────────────────────────

/** One earlier visit's next step, as the server reads it back. */
export type LastNextStepRow = {
  customerId: string;
  /** The Cairo day, `YYYY-MM-DD`. */
  visitDate: string;
  /** The server's own capture time — the tiebreaker when a day holds two. */
  capturedAt: string;
  nextStep: string | null;
  nextStepOn: string | null;
};

export type LastNextStep = { date: string; nextStep: VisitNextStep; label: string; dueOn: string | null };

/**
 * The newest earlier visit per customer that left something to do.
 *
 * Kept APART from `pickLastVisitProducts`, which shares the same read, because the two answer
 * different questions and one must not silence the other: that function deliberately drops a
 * customer whose last products have all been retired from the line, and a commitment the rep made to
 * that same doctor is still a commitment. Folding this into its return would lose it.
 *
 * "Nothing to follow" is not something to do, so it is absent here — the same absent-never-empty rule
 * `pickLastVisitProducts` follows, for the same reason: the screen has to tell "nothing to carry" from
 * "he carried nothing".
 */
export function pickLastNextStep(rows: readonly LastNextStepRow[]): Map<string, LastNextStep> {
  const newest = new Map<string, LastNextStepRow>();

  for (const row of rows) {
    if (!row.customerId || !row.visitDate) continue;
    const held = newest.get(row.customerId);
    if (!held || row.visitDate > held.visitDate || (row.visitDate === held.visitDate && row.capturedAt > held.capturedAt)) {
      newest.set(row.customerId, row);
    }
  }

  const out = new Map<string, LastNextStep>();
  for (const [customerId, row] of newest) {
    // The NEWEST visit's answer, never the newest visit that happens to carry one. A rep who followed
    // up last week and closed it out must not be told again, from the visit before that, to do it.
    if (!isVisitNextStep(row.nextStep) || !isFollowUp(row.nextStep)) continue;
    out.set(customerId, {
      date: row.visitDate,
      nextStep: row.nextStep,
      label: visitNextStepLabel(row.nextStep),
      dueOn: isoDay(row.nextStepOn),
    });
  }
  return out;
}
