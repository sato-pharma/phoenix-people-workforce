// Report-delivery capability for the Source-of-Sales BI workbook: builds the exact same
// ExcelForge workbook the /sales Export button produces, at CEO/Super-Admin scope with the
// confidential-reveal already on (recipients are hard-gated to those two roles, so there is
// nothing left to protect by excluding LA003/LA004/SS001 from a report only they will ever
// receive), and emails it as an attachment. Three callers: the manual on-demand API route
// (POST /api/sales/sos-dashboard/email-report), the daily cron check below (fires once a
// monthly closing period becomes fully published across every line), and the underlying
// send path both share.

import { systemDeployment } from "@/config/system-settings";
import { systemAccessContext } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import {
  renderPhoenixMetadataTable,
  renderPhoenixMetadataTableText,
} from "@/emails/phoenix-email-layout";
import { sendTemplatedEmail } from "@/lib/email-templates/service";
import { closingPeriodGateMessage, isClosingPeriodComplete } from "@/lib/sales/closing-period-gate";
import { listAllPublishedClosings, normalizeClosingLine } from "@/lib/sales/monthly-closing-publication";
import { listMonthlyClosingLines } from "@/lib/sales/monthly-distributor-import";
import { periodProseLabel } from "@/lib/sales/periods";
import { buildSosBiWorkbook } from "@/lib/sales/sos-bi-workbook";
import { getSosDashboard } from "@/lib/sales/sos-dashboard";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { cairoDateTimeSortable } from "@/lib/format/cairo-datetime";

export type SosReportDeliveryResult =
  | { period: string; recipients: string[]; sent: true }
  | { period: string; reason: string; sent: false };

/** Dynamic recipient list: every active CEO / Super Admin with a work email on file — never a
 *  hardcoded address, so adding/removing an executive account changes delivery automatically. */
async function resolveCeoSuperAdminRecipients(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data: authRows, error: authError } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .eq("is_active", true)
    .in("role", ["CEO", "Super Admin"]);
  if (authError) throw authError;

  // Use the RAW hr_id as stored on app_auth_users — employees.hr_id is a case-sensitive FK
  // target, and normalizeHrId() produces a lowercase equality key meant for comparisons, not
  // for querying that column directly (confirmed against live data: normalizing first returned
  // zero matches, the raw value matched every account).
  const hrIds = [
    ...new Set(
      ((authRows ?? []) as Array<{ hr_id: string | null }>)
        .map((row) => row.hr_id?.trim())
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  if (hrIds.length === 0) return [];

  const { data: employeeRows, error: employeeError } = await supabase
    .from("employees")
    .select("hr_id,work_email,employment_status")
    .in("hr_id", hrIds)
    .not("work_email", "is", null);
  if (employeeError) throw employeeError;

  const emails = new Set<string>();
  for (const row of (employeeRows ?? []) as Array<{ employment_status: string | null; work_email: string | null }>) {
    if (isTerminalEmploymentStatus(row.employment_status)) continue;
    const email = String(row.work_email ?? "").trim().toLowerCase();
    if (email) emails.add(email);
  }
  return [...emails];
}

/**
 * The report must be the month it is named for. getSosDashboard answers a month with no validated
 * sales with the NEWEST month instead, so an unchecked build emailed that month's workbook and
 * figures under the requested month's filename, and spent the requested month's once-only send key
 * on it. Returns why not to send, or null when the dashboard answered for exactly `requested`.
 */
export function reportPeriodMismatch(
  requested: string,
  answered: { period: string | null; selectedPeriods: string[] },
): string | null {
  const requestedLabel = periodProseLabel(requested);
  if (!answered.period) return `No Source-of-Sales data is available for ${requestedLabel}.`;
  const exactlyRequested =
    answered.period === requested && answered.selectedPeriods.length === 1 && answered.selectedPeriods[0] === requested;
  if (exactlyRequested) return null;
  return `${requestedLabel} has no validated Source-of-Sales data, so no report was sent. The dashboard would have answered with ${periodProseLabel(answered.period)} instead.`;
}

/**
 * Build the CEO/Super-Admin-scope Source-of-Sales BI workbook for `period` and email it to
 * every active CEO / Super Admin (or `recipientsOverride`, for manual testing against a single
 * address). Never sends confidential data anywhere but this fixed, role-derived recipient set.
 */
export async function buildAndEmailSosBiReport(input: {
  period: string;
  recipientsOverride?: string[];
}): Promise<SosReportDeliveryResult> {
  const { period } = input;

  // THE CLOSING GOLDEN RULE — a closing is never SENT during the month it covers. The daily cron
  // caller reaches here only once every line's closing is published, which is already gated; the
  // manual route takes any period the caller types, so the rule is enforced here too rather than
  // trusting the entry point. Returned as an unsent result, not thrown: "not sent, and here is
  // why" is this function's existing contract and the route surfaces `reason` verbatim.
  if (!isClosingPeriodComplete(period)) {
    return { period, reason: closingPeriodGateMessage(period), sent: false };
  }

  const data = await getSosDashboard({ periods: [period] }, systemAccessContext, {
    includeDetailRows: true,
    includeMomComparison: true,
    includeYoY: true,
    // Safe to reveal unconditionally here: this workbook is only ever emailed to the same
    // CEO / Super Admin roles the on-screen toggle already gates the reveal to.
    revealRestrictedProducts: true,
  });
  const wrongMonth = reportPeriodMismatch(period, data);
  if (wrongMonth) {
    return { period, reason: wrongMonth, sent: false };
  }

  const recipients =
    input.recipientsOverride && input.recipientsOverride.length > 0
      ? input.recipientsOverride
      : await resolveCeoSuperAdminRecipients();
  if (recipients.length === 0) {
    return { period, reason: "No active CEO / Super Admin has a work email on file.", sent: false };
  }

  const generatedAt = cairoDateTimeSortable(new Date().toISOString()) + " Cairo";
  const buffer = await buildSosBiWorkbook({
    data,
    filterSummary: "No filters (full scope) — CEO / Super Admin monthly report",
    generatedAt,
    generatedBy: "Phoenix Automated Report",
  });

  const periodLabel = periodProseLabel(period);
  const subject = `Source of Sales — ${periodLabel} Executive BI Report`;
  const metadataRows = [
    { label: "Period", value: periodLabel },
    { label: "Total value (EGP)", value: Math.round(data.summary.totalValue).toLocaleString() },
    { label: "Distributors", value: data.summary.distributorCount },
    { label: "Products", value: data.summary.productCount },
  ];
  // Wording lives in /admin/email-templates under "Source of Sales Executive Report". The
  // workbook rides beside the template as an attachment: generated content, never wording.
  const result = await sendTemplatedEmail({
    attachments: [
      {
        content: buffer.toString("base64"),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: `phoenix-sos-dashboard_${period}.xlsx`,
      },
    ],
    context: {
      ctaLabel: "Open live dashboard",
      ctaUrl: `${systemDeployment.productionUrl}/sales`,
      detailsTable: renderPhoenixMetadataTable(metadataRows),
      detailsTableText: renderPhoenixMetadataTableText(metadataRows),
      periodLabel,
      subject,
      summary: `The ${periodLabel} Source-of-Sales executive BI workbook is attached.`,
    },
    fallbackTo: recipients,
    idempotencyKey: `sos-bi-report:${period}`,
    origin: { eventType: "sos_monthly_closing_report", module: "sales" },
    overrides: { replaceRecipients: true, to: recipients },
    templateKey: "sos_executive_report",
  });

  if (result.skipped) {
    return { period, reason: result.reason, sent: false };
  }
  return { period, recipients, sent: true };
}

export type SosMonthlyReportCheckResult = {
  checkedPeriods: string[];
  sentPeriods: string[];
  errors: Array<{ period: string; error: string }>;
};

/**
 * Pure logic, no DB I/O: given the full list of active monthly-closing lines and every
 * currently-published (line, period) row, return every period whose published lines cover
 * ALL active lines — i.e. every period ready for the CEO/Super-Admin BI report.
 *
 * A period with zero published closings never appears as a key in `publishedClosings`
 * grouping, so it's naturally excluded (nothing to check) rather than needing a special case.
 */
export function computeFullyPublishedPeriods(
  activeLines: string[],
  publishedClosings: Array<{ normalizedLine: string; period: string }>,
): string[] {
  if (activeLines.length === 0) return [];

  const normalizedActiveLines = new Set(activeLines.map((line) => normalizeClosingLine(line)));
  const publishedLinesByPeriod = new Map<string, Set<string>>();
  for (const closing of publishedClosings) {
    const set = publishedLinesByPeriod.get(closing.period) ?? new Set<string>();
    set.add(closing.normalizedLine);
    publishedLinesByPeriod.set(closing.period, set);
  }

  const fullyPublished: string[] = [];
  for (const [period, publishedLineSet] of publishedLinesByPeriod) {
    const isFullyPublished = [...normalizedActiveLines].every((line) => publishedLineSet.has(line));
    if (isFullyPublished) fullyPublished.push(period);
  }
  return fullyPublished;
}

/**
 * Daily check (the morning job `sos-monthly-report-check`, /api/cron/daily/sos-monthly-report-check): for every period
 * with at least one published monthly closing, if EVERY active line is now published for
 * that period, send the CEO/Super-Admin BI report exactly once.
 *
 * "Fully published" stays true indefinitely once reached (nothing un-publishes a period in
 * the normal flow), so this can't rely on Resend's own Idempotency-Key header alone — that
 * key's dedupe window is not documented as indefinite, and this check runs daily forever.
 * Own dedupe via `notification_outbox.dedupe_key` (same key string also passed as
 * sendPhoenixEmail's idempotencyKey, so both layers agree): insert a `status: "sent"` marker
 * row after a successful send. The outbox drain worker only ever claims
 * `status IN ("pending", "failed")` rows (see processNotificationOutbox in
 * src/lib/notifications/email.ts), so this marker is never picked up for delivery — it is
 * purely a "have we already reported this period" flag, reusing existing infrastructure
 * instead of a new table/migration.
 */
export async function runSosMonthlyClosingReportCheck(): Promise<SosMonthlyReportCheckResult> {
  const checkedPeriods: string[] = [];
  const sentPeriods: string[] = [];
  const errors: Array<{ period: string; error: string }> = [];

  try {
    const [activeLines, publishedClosings] = await Promise.all([
      // Head Office is NOT counted here, and re-adding it would silence this report permanently.
      //
      // This gate asks "is every active line published for the period" and requires ALL of them,
      // so it counts Head Office only if Head Office can be published. It cannot: the closing has
      // excluded it since 2026-08-05, so no Head Office publication can ever exist — measured on
      // production 2026-08-30, monthly_closing_publications held 1 row each for Anti Infective,
      // CNS and Pedia and 0 for Head Office, while source_of_sales_products still carried 4 active
      // Head Office products. Counting an unpublishable line made the condition unsatisfiable, and
      // the report has consequently never fired once: notification_outbox held 0 `sos-bi-report:%`
      // rows on that date, with 2026-07 fully published on all three real lines.
      //
      // The earlier note here defended the wider set as "a different question", which was true of
      // the question and wrong about the answer — it was reasoning about a gate that had never
      // opened. The owner then settled the rule outright, 2026-08-30: "The head office will not be
      // used in the weekly sales or monthly sales."
      listMonthlyClosingLines(),
      listAllPublishedClosings(),
    ]);
    const fullyPublishedPeriods = computeFullyPublishedPeriods(activeLines, publishedClosings);
    if (fullyPublishedPeriods.length === 0) return { checkedPeriods, sentPeriods, errors };

    const supabase = getSupabaseAdmin();

    for (const period of fullyPublishedPeriods) {
      checkedPeriods.push(period);

      const dedupeKey = `sos-bi-report:${period}`;
      const { data: existingMarker, error: lookupError } = await supabase
        .from("notification_outbox")
        .select("id")
        .eq("dedupe_key", dedupeKey)
        .maybeSingle();
      if (lookupError) {
        errors.push({ period, error: lookupError.message });
        continue;
      }
      if (existingMarker) continue; // Already reported for this period.

      const result = await buildAndEmailSosBiReport({ period });
      if (!result.sent) {
        errors.push({ period, error: result.reason });
        continue;
      }

      const now = new Date().toISOString();
      const { error: markerError } = await supabase.from("notification_outbox").insert({
        attempts: 1,
        dedupe_key: dedupeKey,
        max_attempts: 1,
        next_attempt_at: now,
        payload: { period, recipients: result.recipients, type: "sos_monthly_bi_report" },
        sent_at: now,
        status: "sent",
        updated_at: now,
      });
      if (markerError) {
        errors.push({ period, error: `Report sent but dedupe marker insert failed: ${markerError.message}` });
        continue;
      }
      sentPeriods.push(period);
    }
  } catch (error) {
    logError("SoS monthly-closing report check failed", {
      labels: { event: "sos_monthly_report_check_failed" },
      error,
    });
    errors.push({ period: "unknown", error: error instanceof Error ? error.message : String(error) });
  }

  return { checkedPeriods, sentPeriods, errors };
}
