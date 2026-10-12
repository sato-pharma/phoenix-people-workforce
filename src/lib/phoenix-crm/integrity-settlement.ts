/**
 * Phoenix CRM — what it means for a location-integrity case to be settled.
 *
 * The pure half, so the board's own BUTTON can import it: the server module that reads and writes
 * these rows (`server/integrity-board.ts`) pulls in the service-role Supabase client, and a client
 * component importing that would drag it into the browser bundle. The rule, the limit, the sentence
 * and the type live here; the queries live there, and that file re-exports this type so existing
 * readers do not need to know it moved.
 *
 * 🔴 THE RULE IS `settled_flags = flags`, AND IT IS THE WHOLE REOPENING MECHANISM. A settlement
 * stamps the flags it was taken on. The detectors upsert on (subject_kind, subject_id, source), so a
 * NEW finding on the same subject replaces `flags` in place — and the moment it does, the stored
 * settlement no longer describes the row, the case counts as standing again, and it is back in the
 * board's counters and in the weekly fraud scan. No detector was taught about settling to make that
 * work, and none has to be.
 */

/** How long a settling note may be. Long enough for the reason, short enough to stay readable. */
export const INTEGRITY_NOTE_LIMIT = 500;

/** Shown when somebody presses Settle with nothing written. The service is the authority on it. */
export const INTEGRITY_NOTE_REQUIRED = "Write why this case is settled — it stays on the record.";

/**
 * How many cases one bulk settle may carry. The board sends them in runs of this size and the route
 * refuses a longer one.
 *
 * It is a real limit rather than a round number: each case is its own `.update()`, because
 * `settled_flags` is that row's own flags and a single statement over an `.in()` would stamp one
 * case's flags onto another. 200 updates is a few seconds; a whole 5,000-row board in one request is
 * a gateway timeout that leaves nobody knowing which half was written.
 */
export const INTEGRITY_BULK_SETTLE_CAP = 200;

/**
 * Why a case was settled, and what it was settled ON.
 *
 * `flagsThen` is not an audit nicety: it is compared to the row's current flags on every read, and a
 * case whose flags have moved since is shown as standing again. `byName` is the person's name — the
 * board never prints an HR id (the owner's standing rule), and `byHrId` is there for the record.
 */
export type IntegritySettlement = {
  at: string;
  byHrId: string;
  byName: string;
  note: string;
  flagsThen: string[];
};

/**
 * Two flag lists, compared as SETS — order is the detector's business, not the settlement's.
 *
 * A filer that rebuilt the same flags in a different order would otherwise reopen every case it
 * touched, which would look exactly like a new finding and is the one thing this must not invent.
 *
 * 🔴 SETS ON BOTH SIDES, BECAUSE A LENGTH CHECK IS NOT A SET CHECK. Comparing lengths and then
 * membership one way answered "unchanged" for `["a", "b"]` against `["a", "a"]` — same length, and
 * every member of the second is in the first. Each side is collapsed to a set and the sizes
 * compared, so a repeated flag is not a new finding and a different flag always is.
 */
export function sameIntegrityFlags(left: readonly string[], right: readonly string[]): boolean {
  const seen = new Set(left);
  const other = new Set(right);
  if (seen.size !== other.size) return false;
  for (const flag of seen) if (!other.has(flag)) return false;
  return true;
}

/**
 * The settlement a row still carries, or null — the whole rule, with no database in it.
 *
 * It is pure so it can be broken in a test and watched to fail. The server module adds the person's
 * NAME on top of what this returns and nothing else, so what the board shows is what this decides.
 *
 * Null is returned for three different situations, and a reader needs all three to mean the same
 * thing — somewhere to look:
 *   · nobody ever settled this case;
 *   · it was settled and the detectors have since filed a DIFFERENT set of flags on the same subject,
 *     which is the reopening mechanism (`flagsThen` no longer describes the row);
 *   · the settlement is incomplete. The table's CHECK makes that impossible, but a settlement with no
 *     author or no reason would be one nobody owns, and printing it would be worse than losing it.
 */
export function readIntegritySettlement(input: {
  settledAt: unknown;
  settledBy: unknown;
  settledNote: unknown;
  settledFlags: unknown;
  flagsNow: readonly unknown[];
}): Omit<IntegritySettlement, "byName"> | null {
  if (!input.settledAt || !input.settledBy || !input.settledNote || !Array.isArray(input.settledFlags)) return null;
  const flagsThen = (input.settledFlags as unknown[]).map((flag) => String(flag));
  const flagsNow = [...input.flagsNow].map((flag) => String(flag));
  if (!sameIntegrityFlags(flagsThen, flagsNow)) return null;
  return {
    at: String(input.settledAt),
    byHrId: String(input.settledBy),
    note: String(input.settledNote),
    flagsThen,
  };
}

/**
 * Is this `phoenix_crm_location_integrity` ROW settled right now? The same rule as above, taking the
 * database's own column names, for the readers that only need the yes/no.
 *
 * 🔴 EVERY READER OF THIS TABLE GOES THROUGH ONE OF THESE TWO FUNCTIONS, and there are four of them
 * now: the integrity board (which needs the settlement itself, to print it), the weekly fraud scan,
 * Phoenix Ranks' nightly score, and the behaviour board's strong-case gate. A fifth reader that
 * re-implements `settled_flags = flags` is the defect — a length check in place of a set comparison
 * already held one case closed through a genuinely different finding before this shipped.
 *
 * A row that was never settled, and one whose flags have moved since, both answer false: to a reader
 * deciding whether a case still stands they are the same thing.
 */
export function isSettledIntegrityRow(row: {
  flags?: unknown;
  settled_at?: unknown;
  settled_by?: unknown;
  settled_note?: unknown;
  settled_flags?: unknown;
}): boolean {
  return (
    readIntegritySettlement({
      flagsNow: Array.isArray(row.flags) ? row.flags : [],
      settledAt: row.settled_at,
      settledBy: row.settled_by,
      settledFlags: row.settled_flags,
      settledNote: row.settled_note,
    }) !== null
  );
}
