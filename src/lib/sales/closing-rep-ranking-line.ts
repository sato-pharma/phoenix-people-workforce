import { normalizeLineKey } from "@/lib/sales/confidential-products";

/**
 * 🔴 THE ONE GATE ON THE REP RANKING WORKBOOK — Anti Infective, and no other line.
 *
 * Owner, 2026-10-13: "wire this only to the anti-infective line. Leave PD and CNS as they are."
 * Every other line keeps the workbook it already had, so there is one place to read and one place
 * to change if he widens it.
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
export function isRepRankingLine(line: string | null | undefined): boolean {
  return normalizeLineKey(line ?? "") === normalizeLineKey("Anti Infective");
}
