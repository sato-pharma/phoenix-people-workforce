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
