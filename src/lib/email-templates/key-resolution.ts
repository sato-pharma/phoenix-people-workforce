/**
 * Email template KEY RESOLUTION - the key list, the retired-name aliases, and the row picker.
 *
 * Split out of service.ts for the same reason render-core.ts was: this logic is pure and needs
 * unit tests, while service.ts pulls in the JSX email layout and the Supabase admin client and
 * cannot be imported from a test. Every existing import path still works - service.ts re-exports
 * `emailTemplateKeys`, `EmailTemplateKey` and `normalizeEmailTemplateKey` unchanged.
 */

export const emailTemplateKeys = [
  "offer",
  "interview_invitation",
  "interview_feedback",
  "probation_workflow",
  "probation_reminder",
  "probation_dv_snapshot",
  "probation_weekly_digest",
  "probation_day30",
  "probation_day60",
  "probation_day75",
  "contract_renewal",
  "birthday",
  "resignation_workflow",
  "leave_request",
  "leave_approval",
  "leave_rejection",
  "leave_submission_confirmation",
  "leave_resubmit_confirmation",
  "leave_returned",
  "leave_manager_step_decision",
  "vacation_balance_settlement",
  "password_setup",
  "password_reset",
  // The SELF-SERVICE reset code is its OWN template, not a variant of password_reset. That one is
  // the admin-minted LINK email ("click below"), and its stored production body carries no
  // {{detailsTable}} - so the 6-digit code rendered into nothing and the employee received an
  // email with no code in it (production, 2026-10-07: three codes delivered, none usable, none
  // ever entered). A separate key stops the two emails competing for one admin-editable body.
  "password_reset_code",
  // The account email: username, temporary password, sign-in link (owner, 12 Nov 2026).
  "account_temporary_password",
  "user_created",
  "weekly_plans",
  "outstation",
  "marketing_request",
  "excuse_request",
  "excuse_decision",
  "offer_status",
  "recruitment_update",
  "coaching_report",
  "payroll_update",
  "attendance_workflow",
  "general",
  "direct_order_approved",
  "direct_order_probation_report",
  "monthly_closing_published",
  "sos_executive_report",
  "cv_intake_digest",
  "telegram_connect",
  "weekly_sales_uploaded",
  "targets_uploaded",
  "production_planning_reorder",
  "production_planning_expiry",
] as const;

export type EmailTemplateKey = (typeof emailTemplateKeys)[number];

/**
 * Retired template names that still resolve to a live key. A row stored under one of these is
 * readable, but saveEmailTemplate always writes the MODERN key - see findRowForKey for what that
 * asymmetry cost in production.
 */
const aliases: Record<string, EmailTemplateKey> = {
  job_offer: "offer",
  probation: "probation_workflow",
  probation_tracker: "probation_workflow",
  resignation: "resignation_workflow",
  user_creation: "user_created",
};

/**
 * The text-folding half of normalizeTemplateKey - lowercase, trim, space/hyphen to underscore -
 * WITHOUT alias resolution. Kept separate so findRowForKey can tell a row that literally IS the
 * key from one that only reaches it through a retired alias.
 */
export function templateKeyText(value: string | null | undefined) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function normalizeTemplateKey(value: string | null | undefined): EmailTemplateKey | null {
  const normalized = templateKeyText(value);
  if ((emailTemplateKeys as readonly string[]).includes(normalized)) return normalized as EmailTemplateKey;
  return aliases[normalized] ?? null;
}

/**
 * Pick the one stored row that belongs to `key`, preferring a row that literally IS the key over
 * one that only reaches it through a retired alias.
 *
 * normalizeTemplateKey folds retired names onto their modern key (`probation` ->
 * `probation_workflow`, `resignation` -> `resignation_workflow`, `job_offer` -> `offer`), so a
 * table holding BOTH names has two rows normalizing to the same key. A plain `.find()` returned
 * whichever the unordered PostgREST select happened to yield first - in production, the retired
 * row, which sat earlier in the heap. Because saveEmailTemplate always writes the MODERN key,
 * every admin edit landed on a row nothing read: resignation notices sent on 2026-09-07 still
 * carried the retired row's 2026-05-18 wording, six weeks after the edit. Neither of the module's
 * own checks could show it - Preview and Send Test both render the editor's in-flight payload, and
 * the catalog list read the same retired row, so a saved edit appeared to revert on reload.
 *
 * The two shadowing rows were deleted from production on 2026-09-09 (pre-image kept in
 * email_backup_20260909.email_templates_legacy_pre). This makes the choice deterministic anyway,
 * so a retired name re-entering the table can never silently win again.
 */
export function findRowForKey<T extends { template_key: string }>(
  rows: readonly T[],
  key: EmailTemplateKey,
): T | null {
  const exact = rows.find((row) => templateKeyText(row.template_key) === key);
  if (exact) return exact;
  return rows.find((row) => normalizeTemplateKey(row.template_key) === key) ?? null;
}
