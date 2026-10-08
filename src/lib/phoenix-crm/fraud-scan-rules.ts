/**
 * Phoenix CRM — the weekly visit-fraud scan: the window and the tier cut.
 *
 * The PURE, phone-safe half of `src/lib/phoenix-crm/server/fraud-scan.ts`. Owner, 2026-10-07: a weekly
 * digest of the integrity board — the GPS and photo flags the module already records silently at
 * capture — to the Super Admin and the SFE Managers, so a week's worth of signals is read once,
 * together, rather than only when someone remembers to open the board.
 *
 * ## What lives here, and what deliberately does NOT
 *
 * This file is in a rep's bundle, so Golden Rule #1's blind half forbids it from NAMING the checks in
 * a string a rep could read (`tests/phoenix-crm-blind-half.test.ts`). So the summary composition — the
 * only part that must say "integrity" and "flagged" — and the job slug (which carries "fraud") live
 * in `server/fraud-scan-summary.ts`, server-side and pure, where those words are allowed and the unit
 * test can still import them without pulling the server's I/O. Here: the window maths and the SFE cut,
 * both word-free.
 *
 * ## It judges NOTHING of its own (and must never start)
 *
 * Every case it reports was filed by a detector that already ran: `location-integrity.ts` at capture
 * (mock provider, coordinate replay, impossible travel, zero jitter, coarse location) and the nightly
 * photo sweep (`duplicate-photos.ts`). This scan re-runs no detector and invents no threshold — it
 * reads `phoenix_crm_location_integrity` for the week through the board's own reader and summarises
 * it. A "fraud scan" that lowered the impossible-travel bar, or added a far-from-place rule of its
 * own, would be a second opinion the owner never set; the thresholds live in `location-integrity.ts`,
 * pinned by `tests/phoenix-crm-location-integrity.test.ts`, and this file does not touch them.
 *
 * ## Golden Rule #1 — it is the narrowest audience in the module, and the rep is never in it
 *
 * The integrity board is the Super Admin's and the SFE Manager's (`integrity-board.ts`). This scan
 * carries the same evidence, so it goes to exactly those two roles and nowhere else — never a rep,
 * never a district manager, never a manager chain. And the tiers hold: the position (GPS) cases are
 * the Super Admin's alone, so the SFE's copy is built from the photo cases only (`sfeVisibleCases`),
 * the same split `loadIntegrityBoard` enforces on the screen.
 *
 * ## Why it sends even on a clean week (unlike the 06:55 digest)
 *
 * The daily digest to managers stays silent when clean, because a daily message that always arrives
 * is muted inside a week. This is the opposite case: WEEKLY, to two admin roles, and a report that
 * only appears with bad news cannot be told apart from one that has silently stopped — the same
 * reasoning `retention-risk-pre-payroll` is built on. So a clean week is reported as a clean week,
 * which also proves the scan is alive.
 */

/** Thursday 07:00 Cairo (owner, 2026-10-07): the morning after the Sat–Wed working week it reports. */
export const FRAUD_SCAN_CRON = "0 7 * * 4";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type FraudScanWindow = {
  /** Inclusive Saturday of the reported week, YYYY-MM-DD. */
  fromIso: string;
  /** Inclusive Wednesday of the reported week, YYYY-MM-DD. */
  toIso: string;
  /** Human label, e.g. "Sat 4 Oct – Wed 8 Oct". No ellipsis, ever (owner rule). */
  label: string;
};

/** A capture the board already flagged, pared to what the summary needs. Names, never codes. */
export type FraudScanCase = {
  repHrId: string;
  repName: string;
  /** Which detector filed it. `gps` is the Super Admin's alone; `photo` both roles may read. */
  source: "gps" | "photo";
  strong: boolean;
  /** The flags in plain English, already resolved by the board's label maps. */
  reasons: string[];
};

export type FraudScanSummary = {
  title: string;
  message: string;
  flaggedVisits: number;
  strongVisits: number;
  reps: number;
};

/**
 * The completed Saturday–Wednesday working week relative to a Cairo date.
 *
 * The scan fires on a Thursday, so the Wednesday it reports is yesterday and the Saturday is four
 * days before that. Computed from the weekday rather than a fixed offset so it is still correct if
 * the cron is ever moved: the window end is the most recent Wednesday STRICTLY before the run day,
 * and the start is that Wednesday minus four days. Date-only arithmetic in UTC — these are calendar
 * days, never instants, so no zone shifts them.
 */
export function fraudScanWindow(cairoTodayIso: string): FraudScanWindow {
  const today = new Date(`${cairoTodayIso}T00:00:00.000Z`);
  let end = new Date(today.getTime() - DAY_MS);
  // 3 === Wednesday. Walk back at most a week to the nearest Wednesday before today.
  while (end.getUTCDay() !== 3) end = new Date(end.getTime() - DAY_MS);
  const start = new Date(end.getTime() - 4 * DAY_MS);
  return {
    fromIso: start.toISOString().slice(0, 10),
    toIso: end.toISOString().slice(0, 10),
    label: `${labelOf(start)} – ${labelOf(end)}`,
  };
}

function labelOf(date: Date): string {
  return `${WEEKDAY_SHORT[date.getUTCDay()]} ${date.getUTCDate()} ${MONTH_SHORT[date.getUTCMonth()]}`;
}

/**
 * The cases an SFE Manager may read: the photo detector's only. The position (GPS) cases — mock
 * provider and impossible travel among them — are the Super Admin's alone (owner, 2026-10-02), so
 * they never enter the SFE's copy. This is the same cut `loadIntegrityBoard` makes for an SFE viewer.
 */
export function sfeVisibleCases(cases: ReadonlyArray<FraudScanCase>): FraudScanCase[] {
  return cases.filter((entry) => entry.source !== "gps");
}
