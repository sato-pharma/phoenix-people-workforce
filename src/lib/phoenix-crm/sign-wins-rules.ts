/**
 * Phoenix CRM — "the sign wins": the one group of place checks the system approves by itself.
 *
 * Owner, 23 Nov 2026, asked as a choice on the Place checks rebuild and answered "Yes, the sign wins
 * (Recommended)". A place that ONLY the Google check held, whose photographed sign names the customer,
 * is approved by the system. He had approved every one of the 117 put to him, so each was a press that
 * decided nothing. Account: `docs/approvals-rebuild-2026-11-place-checks.md`.
 *
 * Pure and screen-free. `server/sign-wins.ts` reads the rows and writes; this file is the whole rule,
 * so each line of it is pinned by `tests/phoenix-crm-sign-wins.test.ts`.
 *
 * 🔴 WHAT IT NEVER TOUCHES, each named with the reason it is left to him:
 *   - a clinic customer still short of three names (no approve path ever takes one, owner 2026-11-07);
 *   - a place with an integrity case nobody has settled (the silent boards are his to read first);
 *   - a place the SFE Manager recommended on (those wait on the SFE recommendations page, 19 Nov 2026);
 *   - a customer seated in a polyclinic (a building and its timetable are his alone, 2026-10-17);
 *   - a hold the sign or the timetable raised (the system already re-reads those, `signboard-holds.ts`);
 *   - a place with no photograph on file (owner, 20 Nov 2026: "must have a photo except i tell u"). A
 *     sign can only have been read off a photo, so this never fires today; it is written down so that no
 *     later source of a sign reading can make the system approve a place nobody photographed;
 *   - a test entry, and anything already decided.
 *
 * 🔴 IT ONLY EVER SAYS YES. Nothing here rejects, and nothing tells the rep anything a person's approval
 * would not.
 *
 * 🔴 IT SWITCHES ITSELF OFF. If he takes back more than 1 in 20 of what it approved in 30 days, it stops
 * approving and the page says so (`signWinsSwitch`). It starts again by itself once those take-backs
 * are older than 30 days; nobody turns it back on by hand in code.
 */

/** The value `system_approved_rule` carries on a review this rule approved. */
export const SIGN_WINS_RULE = "sign_wins";

/** The kinds of hold Google raises. A hold of any other kind is never this rule's. */
export const GOOGLE_HOLD_REASONS = ["no_confident_listing", "lookup_failed", "listing_far", "listing_off"] as const;

/**
 * 🔴 ONLY A PLACE CAPTURED FROM THIS INSTANT ON: the start of the day he chose the rule. It is not a
 * pass over what waited before that day (none of those was in the group, read on production, 23 Nov
 * 2026), and an older backlog would be a bulk change to announce to him first, never something an
 * hourly job does on its own.
 *
 * 🔴 IT IS NOT THE DEPLOY INSTANT. A place captured from this instant on that is still waiting when the
 * rule goes live is approved by the first hourly runs, at most `SIGN_WINS_SWEEP_LIMIT` a run. That
 * count is read on production and put to him before the merge (0 on 23 Nov 2026, 07:26 Cairo).
 */
export const SIGN_WINS_STARTED_AT = "2026-11-23T00:00:00+02:00";

/** The window the switch counts over, and the share of take-backs that stops the rule. */
export const SIGN_WINS_WINDOW_DAYS = 30;
export const SIGN_WINS_TAKE_BACK_ONE_IN = 20;

/** The decision note the board shows beside "the system". One sentence of why, and what had held it. */
export const SIGN_WINS_NOTE = "The sign in the photo names the customer. Only the Google check had held this place.";

/** Most places one hourly run approves. The door's own call handles its one place; this bounds the sweep. */
export const SIGN_WINS_SWEEP_LIMIT = 25;

export type SignWinsCandidate = {
  reviewStatus: string | null;
  isTest: boolean;
  /** `google.verdict` on the review: `signboard` and `schedule` are holds the photo raised, never Google's. */
  holdVerdict: string | null;
  /** `google.reason` on the review. */
  holdReason: string | null;
  /** When the review was raised. */
  createdAt: string | null;
  placeStatus: string | null;
  /** The building the place is seated in, when it is. */
  sharedPlaceId: string | null;
  /** The place has a photograph on file. A trusted point has none, and is the Super Admin's alone. */
  hasPhoto: boolean;
  /** The place's own stored reading of its sign. */
  signVerdict: string | null;
  /** A clinic customer with one or two names (`approvalNeedsFullName`). */
  needsFullName: boolean;
  /** An integrity case on this place that nobody has settled. */
  openIntegrityCase: boolean;
  /** The SFE Manager recommended on this place. */
  sfeRecommended: boolean;
};

export type SignWinsLeftBecause =
  | "decided"
  | "test_entry"
  | "not_a_google_hold"
  | "before_the_rule"
  | "place_not_in_use"
  | "seated_in_a_building"
  | "no_photo"
  | "sign_does_not_name_the_customer"
  | "short_name"
  | "integrity_case_open"
  | "sfe_recommended";

function isGoogleReason(value: string | null): boolean {
  return value !== null && (GOOGLE_HOLD_REASONS as readonly string[]).includes(value);
}

/**
 * Whether the rule approves this place, and when it does not, the first reason it is left to him.
 * Every test must pass: a row that cannot be read (a null where a value belongs) is left.
 */
export function signWinsVerdict(row: SignWinsCandidate): { applies: true } | { applies: false; because: SignWinsLeftBecause } {
  const left = (because: SignWinsLeftBecause) => ({ applies: false as const, because });
  if (row.reviewStatus !== "pending") return left("decided");
  if (row.isTest) return left("test_entry");
  if (row.holdVerdict === "signboard" || row.holdVerdict === "schedule" || !isGoogleReason(row.holdReason)) return left("not_a_google_hold");
  const created = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
  if (!Number.isFinite(created) || created < Date.parse(SIGN_WINS_STARTED_AT)) return left("before_the_rule");
  if (row.placeStatus !== "active") return left("place_not_in_use");
  if (row.sharedPlaceId !== null) return left("seated_in_a_building");
  if (!row.hasPhoto) return left("no_photo");
  if (row.signVerdict !== "match") return left("sign_does_not_name_the_customer");
  if (row.needsFullName) return left("short_name");
  if (row.openIntegrityCase) return left("integrity_case_open");
  if (row.sfeRecommended) return left("sfe_recommended");
  return { applies: true };
}

export type SignWinsSwitch = {
  on: boolean;
  /** What the rule approved in the window. */
  approvals: number;
  /** How many of those he took back. */
  takeBacks: number;
};

/**
 * On, unless he took back more than 1 in 20 of what it approved in the window. One take-back in ten
 * approvals is already more than 1 in 20: with few approvals the rule stops at the first take-back,
 * which is the cautious way round for something that decides without him.
 */
export function signWinsSwitch(input: { approvals: number; takeBacks: number }): SignWinsSwitch {
  const approvals = Math.max(0, Math.floor(input.approvals));
  const takeBacks = Math.max(0, Math.min(approvals, Math.floor(input.takeBacks)));
  return { on: takeBacks * SIGN_WINS_TAKE_BACK_ONE_IN <= approvals, approvals, takeBacks };
}

const places = (count: number) => `${count} ${count === 1 ? "place" : "places"}`;

/** What the page says about the rule, in one or two sentences. Never a count it cannot stand behind. */
export function signWinsSentence(state: SignWinsSwitch): string {
  if (!state.on) {
    return `The system has stopped approving by itself: you took back ${state.takeBacks} of the ${places(state.approvals)} it approved in the last ${SIGN_WINS_WINDOW_DAYS} days, which is more than 1 in ${SIGN_WINS_TAKE_BACK_ONE_IN}. Every such place waits for you until those take-backs are older than ${SIGN_WINS_WINDOW_DAYS} days.`;
  }
  if (state.approvals === 0) {
    return `The system approves a place by itself when only the Google check held it and the sign in the photo names the customer. It has approved none in the last ${SIGN_WINS_WINDOW_DAYS} days.`;
  }
  const taken = state.takeBacks === 0 ? "You took none back." : `You took back ${state.takeBacks}.`;
  return `The system approved ${places(state.approvals)} by itself in the last ${SIGN_WINS_WINDOW_DAYS} days: only the Google check had held each, and its sign names the customer. ${taken}`;
}
