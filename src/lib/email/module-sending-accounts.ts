/**
 * Resend accounts DEDICATED to one module's mail.
 *
 * Owner decision, 2026-10-13: one Resend account per module (people, total rewards or finance,
 * sales, and so on), each sending only that module's email, "starting with sales". The first
 * module is sales, on `sales.satopharma.com`.
 *
 * ── Why a registry and not another numbered account ──
 * `RESEND_API_KEY_2/_3/_4` are a FAILOVER pool: any ordinary Phoenix email may land on any of them
 * when the one before runs out of quota. A module account is the opposite — it is never part of
 * that pool, so nothing but its own module's mail can spend its ~100/day, and its own module's
 * mail is tried on it FIRST. Giving it a named suffix (`RESEND_API_KEY_SALES`) instead of the next
 * number keeps it out of `extraResendAccountSuffixes` by construction.
 *
 * ── Adding the next module ──
 * One entry below, plus the three env names it implies (`RESEND_API_KEY_<SUFFIX>`,
 * `RESEND_EMAIL_FROM_<SUFFIX>`, `RESEND_WEBHOOK_SECRET_<SUFFIX>`) in
 * `scripts/sync-railway-production-secrets.mjs`, and its webhook secret in the Resend webhook
 * route's list. The account is INERT until both its key and its sender address are set.
 *
 * ── What a module account never does ──
 * It never carries mail that speaks as a person (`hr@`, `hrbp@`, `ceo@` — the dedicated first
 * account's job, `sato-identity-senders.ts`), and a job offer can never be re-addressed onto it
 * (`senderOverrideRefusal`). Mail with no module, or a module with no account here, is untouched.
 */

export type ModuleSendingAccount = {
  /** Plain-language name, for the health read-out. */
  label: string;
  /** Normalised module keys (see `moduleKey`) whose email this account carries. */
  modules: readonly string[];
  /** The env suffix: `RESEND_API_KEY_<suffix>`, `RESEND_EMAIL_FROM_<suffix>`, `RESEND_WEBHOOK_SECRET_<suffix>`. */
  suffix: string;
};

/**
 * `sales` is both the `module` the sales senders stamp on their origin (closing published, the
 * executive report, the weekly upload, the distributor nudge) and the lower-cased template
 * category of those templates, so one key covers both ways a send reaches the router.
 *
 * Direct Orders is deliberately NOT here: it is its own module with its own template category
 * and was not part of the owner's instruction. Moving it is a one-word change to this list.
 */
export const moduleSendingAccounts: readonly ModuleSendingAccount[] = [
  { label: "Sales", modules: ["sales"], suffix: "SALES" },
];

/** `"Sales"`, `"sales"`, `" Weekly & Monthly Plans "` → `sales`, `sales`, `weekly_monthly_plans`. */
export function moduleKey(module: string | null | undefined): string {
  return String(module ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The dedicated account for a module's mail, or null when that module has none. */
export function moduleSendingAccountFor(module: string | null | undefined): ModuleSendingAccount | null {
  const key = moduleKey(module);
  if (!key) return null;
  return moduleSendingAccounts.find((account) => account.modules.includes(key)) ?? null;
}
