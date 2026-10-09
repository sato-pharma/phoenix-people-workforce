// The months the OWNER has said a source files nothing in — the declaration, and nothing else.
//
// A LEAF MODULE ON PURPOSE. This started life inside `sos-month-complete.ts`, which imports
// `previousPeriod` from `source-coverage.ts`; the moment the closing's own coverage banner needed
// the same declaration (owner, 2026-10-09: "fix the closing banner that still calls epda and mec a
// hole") those two files would have imported each other. The declaration is data plus one lookup,
// so it moves down here where both can reach it. Its one import, `direct-channel.ts`, is itself a
// leaf. `sos-month-complete.ts` re-exports all three names, so every existing caller and test is
// unaffected.
//
// 🔴 ONLY HIS WORD PUTS AN ENTRY HERE. A quiet month is indistinguishable from a book nobody has
// uploaded yet, so this is never inferred from the data — and the data still outvotes it in both
// directions: a file that does arrive is simply present, and nothing here can hide a late upload.
//
// 🔴 PERIOD-SCOPED, NEVER A RETIREMENT. The month after a declared one expects the file again. A
// source that stops filing for good is a different change, in the distributors master.

import { canonicalDistributorKey } from "@/lib/sales/direct-channel";

/**
 * A source the OWNER has said is not filing in a given month.
 *
 * Period-scoped, never a retirement: the month after the declared one expects its file again, so a
 * source that goes quiet once cannot drop off the expectation for ever. Only the owner's own word
 * puts an entry here — this is not inferred from a quiet month, which is indistinguishable from a
 * book that has not been uploaded yet.
 */
export type SourceQuietPeriod = {
  /** The source's code, compared folded. */
  code: string;
  /** The months it files nothing in — "YYYY-MM". */
  periods: readonly string[];
  /** His words and the date, for the reader of this file. */
  reason: string;
};

/**
 * The months the owner has declared a source does not file in.
 *
 * 🔴 THE CODE IS THE DISTRIBUTOR CODE, NOT THE NAME, and the two look nothing alike here. Read
 * live from production on 2026-10-09: `EP` is the source whose name renders as "epda" and `MC` the
 * one that renders as "mec" — while `EP-BK` (EPDA-BULK) and `EP-PHS` (EPDA-Pharmacies) are
 * SEPARATE sources that are not covered by this declaration and must not be, because EPDA-BULK did
 * file in September. A declaration written against a name, or against a prefix of one, would have
 * silenced the wrong books.
 */
export const SOURCE_QUIET_PERIODS: readonly SourceQuietPeriod[] = [
  {
    code: "EP",
    periods: ["2026-09"],
    reason: 'owner, 2026-10-09: "ebda and mec are not comming this month"',
  },
  {
    code: "MC",
    periods: ["2026-09"],
    reason: 'owner, 2026-10-09: "ebda and mec are not comming this month" — mec, the separate distributor',
  },
];

/** The declaration covering this source in this period, or null. Codes are compared folded. */
export function sourceQuietIn(code: string, period: string): SourceQuietPeriod | null {
  const key = canonicalDistributorKey(code);
  if (!key) return null;
  for (const quiet of SOURCE_QUIET_PERIODS) {
    if (canonicalDistributorKey(quiet.code) !== key) continue;
    if (quiet.periods.includes(period)) return quiet;
  }
  return null;
}

/**
 * The sentence naming the sources the owner has declared quiet in this month.
 *
 * 🔴 IT LIVES IN THIS LEAF BECAUSE THE CLOSING SCREEN IS A CLIENT COMPONENT. `source-coverage.ts`,
 * where the rule is applied, imports `getSupabaseAdmin`, so a value import from there would drag
 * the server Supabase client into the browser bundle.
 *
 * It lives beside the rule rather than in the screen, because it is the thing he actually reads and
 * the whole defect was its wording: the closing told him a finished month was short two files and
 * promised they would arrive. NAMES, never codes (standing rule), and no arrival. Masked viewers
 * reach this with an already-relabelled name, because `maskSourceCoverage` covers `quietSources`.
 */
export function quietSourcesSentence(
  period: string,
  quiet: readonly { name: string }[],
): string {
  const names = quiet.map((entry) => entry.name).filter(Boolean);
  if (names.length === 0) return "";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const one = names.length === 1;
  return `${list} ${one ? "files" : "file"} nothing in ${period} by the owner's instruction, so `
    + `${one ? "it is" : "they are"} not counted as missing.`;
}
