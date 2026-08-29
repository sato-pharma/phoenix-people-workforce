import type { DirectOrderPharmacyStanding, DirectOrderPharmacyTrustState } from "@/lib/direct-orders/types";

// ─────────────────────────────────────────────────────────────────────────────
// What an approver reads where a sales table would be (spec D2).
//
// The table itself has existed since #1665. What it could not say is WHY it is empty, and the two
// reasons are opposite risks:
//
//   • a TRUSTED pharmacy with no distributor sales — a real place that simply has not bought;
//   • a PROVISIONAL pharmacy — a place one Super Admin approved on a photo, which has not yet
//     proved it exists at all.
//
// Rendered identically, those read the same to a tired approver at 11pm, and the second is the one
// the whole V2 gate was built to surface. So the absence itself has to be narrated.
//
// The owner's standing rule — an empty table must never read as zero — is why every branch here
// returns a SENTENCE and never a count. A zero is a measurement; "we have not established that this
// pharmacy exists" is not, and showing the former in place of the latter is the specific lie this
// module refuses to tell.
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The probation window, in days (spec A3/G4).
 *
 * Deliberately declared here and NOT imported from `pharmacy-probation.ts`: that module pulls in
 * the Supabase admin client, and this one has to stay importable by a plain unit test and by any
 * render path. `tests/direct-orders-pharmacy-standing.test.ts` asserts this equals the sweep's own
 * `PROBATION_DAYS`, so the two cannot drift apart in silence.
 */
export const PROBATION_WINDOW_DAYS = 90;

export function normalizeDirectOrderTrustState(value: unknown): DirectOrderPharmacyTrustState {
  const text = String(value ?? "").trim();
  if (text === "provisional" || text === "phantom_suspected") return text;
  // Anything unrecognised reads as `trusted` ONLY because that is the column default and the state
  // 12 of the 12 live rows were created in. It is never inferred from silence — a pharmacy becomes
  // provisional by an explicit write in the validation flow, never by failing to parse here.
  return "trusted";
}

/**
 * Which day of the probation window a pharmacy is on, 1-based, or null when the clock was never
 * started.
 *
 * A null clock is NOT day zero, and the distinction is load-bearing: all 10 provisional pharmacies
 * live today have `probation_started_at` null, because they were hand-created on 2026-08-04 before
 * the clock existed. Rendering those as "day 0 of 90" would invent a countdown that no sweep is
 * actually running, and the approver would wait for a promotion that cannot arrive.
 */
export function probationDayOf(input: {
  probationStartedAt: string | null;
  now?: Date;
  windowDays?: number;
}): number | null {
  if (!input.probationStartedAt) return null;
  const started = new Date(input.probationStartedAt);
  if (Number.isNaN(started.getTime())) return null;
  const now = input.now ?? new Date();
  const windowDays = input.windowDays ?? PROBATION_WINDOW_DAYS;
  const elapsed = Math.floor((now.getTime() - started.getTime()) / MS_PER_DAY);
  // 1-based: the day a pharmacy is approved is day 1, not day 0 — that is how a person counts a
  // deadline. Clamped at both ends so a clock skew cannot print "day -1" or "day 214 of 90".
  return Math.min(Math.max(elapsed + 1, 1), windowDays);
}

/**
 * The approver-facing standing for one pharmacy.
 *
 * Lives in the domain rather than the component because it IS the business rule — the words are
 * the deliverable, not decoration. A component that assembled this sentence itself would be the
 * second place the rule lives, and the two would drift.
 */
export function describeDirectOrderPharmacyStanding(input: {
  trustState: unknown;
  probationStartedAt: string | null;
  now?: Date;
  windowDays?: number;
}): DirectOrderPharmacyStanding {
  const trustState = normalizeDirectOrderTrustState(input.trustState);
  const windowDays = input.windowDays ?? PROBATION_WINDOW_DAYS;
  const probationDay = probationDayOf({
    probationStartedAt: input.probationStartedAt,
    now: input.now,
    windowDays,
  });

  // The remedy for a missing code, appended to every no-code sentence. Kept identical across trust
  // states so the instruction never changes — only what precedes it does.
  const registerTheCode =
    "Register it against the distributor that actually supplies it to see them here.";

  if (trustState === "phantom_suspected") {
    const reported =
      `this venue finished its ${windowDays}-day probation with no distributor sales and no ` +
      "payment, and has been reported as a suspected phantom. Treat this order as unverified " +
      "until someone confirms the venue exists";
    return {
      trustState,
      probationDay,
      windowDays,
      noHistoryNote: `No history — ${reported}.`,
      noCodeNote: `No history — ${reported}. It also has no distributor customer code on file. ${registerTheCode}`,
    };
  }

  if (trustState === "provisional") {
    const unproved =
      probationDay === null
        ? "new venue, still provisional. Its probation clock was never started, so nothing will " +
          "promote or flag it on its own"
        : `new venue, probation day ${probationDay} of ${windowDays}. It is approved but not yet ` +
          "proved: no distributor has invoiced it and no collection has been paid";
    return {
      trustState,
      probationDay,
      windowDays,
      noHistoryNote:
        probationDay === null
          ? `No history — ${unproved}; it needs a distributor sale or a paid collection before its sales can appear here.`
          : `No history — ${unproved}.`,
      // The trust state leads. A missing code is paperwork; an unproved pharmacy is the risk, and
      // showing only the former is what let five of the ten provisional pharmacies look routine.
      noCodeNote:
        `No history — ${unproved}. It has no distributor customer code on file either, so even its ` +
        `retail sales cannot be matched. ${registerTheCode}`,
    };
  }

  return {
    trustState,
    probationDay,
    windowDays,
    noHistoryNote:
      "No distributor sales found for this venue's customer codes. The venue is established, " +
      "so this means it has not bought in the months on record — not that it is unknown.",
    noCodeNote:
      "This venue has no distributor customer code on file, so its retail sales cannot be " +
      `matched. ${registerTheCode}`,
  };
}
