/**
 * The RETIRED per-module Resend accounts — kept only so their webhooks still verify.
 *
 * 🔴 Since 2026-11-06 (owner: "keep a free Resend account as the primary, and one Brevo account in
 * case needed as a fallback") NO module has its own sending account: every email rides the same
 * Resend → Brevo chain (`email-providers.ts`). The Sales account (`sales.satopharma.com`, owner
 * 2026-10-13) and the People account (`people.satopharma.com`) no longer send anything.
 *
 * This list survives for one reason: the Resend webhook route reads
 * `RESEND_WEBHOOK_SECRET_<suffix>` for each entry, so the late bounces and complaints of mail
 * these accounts sent before the cut are still recorded instead of being rejected with a 401.
 * Never wire it back into the chain without his word.
 */

export type ModuleSendingAccount = {
  /** Plain-language name, for the health read-out. */
  label: string;
  /** The modules whose email this account carried before 2026-11-06. */
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
  // People (owner, 2026-10-13, sending domain people.satopharma.com): leave, excuses, attendance;
  // probation, contracts, resignations; recruitment and birthdays. Each lifecycle area is listed
  // under every spelling a send reaches the router with — the raw `origin.module` the sender stamps
  // ("vacation", "contract_renewal") and the lower-cased template category ("leave_management").
  //
  // 🔴 LEFT OUT ON PURPOSE: password reset, account setup and new-user mail (category "Account
  // Access" — his answer, the most critical mail Phoenix sends must never wait on a module's
  // quota), payroll, expenses and outstation, coaching, and the modules he did not name
  // (early birds, the private calendar, support requests, internal messages, field compliance).
  {
    label: "People",
    modules: [
      "leave",
      "leave_management",
      "vacation",
      "excuse",
      "excuses",
      "attendance",
      "attendance_digest",
      "probation",
      "contract_renewal",
      "contracts",
      "resignation",
      "resignations",
      "recruitment",
      "birthday",
      "birthdays",
    ],
    suffix: "PEOPLE",
  },
];
