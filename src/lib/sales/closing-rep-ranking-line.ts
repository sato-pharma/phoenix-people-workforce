import { normalizeLineKey } from "@/lib/sales/confidential-products";

/**
 * 🔴 THE ONE GATE ON THE REP RANKING WORKBOOK — the lines that have an identity to wear it in.
 *
 * Owner, 2026-10-13, opening it: "wire this only to the anti-infective line. Leave PD and CNS as
 * they are." Owner, later the same day, widening it himself: "now use the CNS identity to make the
 * new identity ranking rep closing sheet, exactly as you did for anti-infective, but for CNS with
 * CNS identity." So this is a LIST now rather than one name, and Pedia still keeps the workbook it
 * already had — one place to read, one place to change when he widens it again.
 *
 * 🔴 A LINE BELONGS HERE ONLY ONCE ITS CHROME IS COMMITTED. The workbook reads ten rendered PNGs out
 * of `public/brand/<line>-ranking/` and throws if they are missing, so adding a name here without
 * its art turns that line's download into an error page rather than into a plainer file.
 * `closing-ranking-dress.ts` holds the art's folder and the tokens, and
 * `tests/closing-rep-ranking.test.ts` pins this list to that one so the two cannot drift to
 * different answers about which lines these are.
 *
 * It lives in this leaf module, not beside the builder, for the reason confidential-products.ts
 * exists: the admin closing screen is a CLIENT component and has to ask this same question to
 * decide whether to show the button, while `closing-rep-ranking-export.ts` imports
 * `@/lib/supabase/server` and the employee-directory chain behind it. One import of that from the
 * client bundle is a webpack refusal (UnhandledSchemeError over `node:crypto`), and in dev it
 * poisons every later request on the server it was compiled on. So the gate is dependency-free and
 * `closing-rep-ranking-export.ts` re-exports it — the builder's callers are untouched, and the
 * screen and the route cannot drift to two different answers about which line this is.
 */
const REP_RANKING_LINES = ["Anti Infective", "CNS"].map(normalizeLineKey);

export function isRepRankingLine(line: string | null | undefined): boolean {
  return REP_RANKING_LINES.includes(normalizeLineKey(line ?? ""));
}
