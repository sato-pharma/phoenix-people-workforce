// Report-delivery capability for the Source-of-Sales BI workbook: builds the exact same
// ExcelForge workbook the /sales Export button produces, at CEO/Super-Admin scope with the
// confidential-reveal already on (recipients are hard-gated to those two roles, so there is
// nothing left to protect by excluding LA003/LA004/SS001 from a report only they will ever
// receive), and emails it as an attachment. Two callers: the manual on-demand API route
// (POST /api/sales/sos-dashboard/email-report) today, and — per the Round-2 plan — a future
// monthly-closing-triggered cron hook (not built yet; see the TODO in
// app/api/sales/monthly-closing/publish/route.ts).

import { systemDeployment } from "@/config/system-settings";
import { systemAccessContext } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import {
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { periodProseLabel } from "@/lib/sales/periods";
import { buildSosBiWorkbook } from "@/lib/sales/sos-bi-workbook";
import { getSosDashboard } from "@/lib/sales/sos-dashboard";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
 * Build the CEO/Super-Admin-scope Source-of-Sales BI workbook for `period` and email it to
 * every active CEO / Super Admin (or `recipientsOverride`, for manual testing against a single
 * address). Never sends confidential data anywhere but this fixed, role-derived recipient set.
 */
export async function buildAndEmailSosBiReport(input: {
  period: string;
  recipientsOverride?: string[];
}): Promise<SosReportDeliveryResult> {
  const { period } = input;

  const data = await getSosDashboard({ periods: [period] }, systemAccessContext, {
    includeDetailRows: true,
    includeMomComparison: true,
    includeYoY: true,
    // Safe to reveal unconditionally here: this workbook is only ever emailed to the same
    // CEO / Super Admin roles the on-screen toggle already gates the reveal to.
    revealRestrictedProducts: true,
  });
  if (!data.period) {
    return { period, reason: `No Source-of-Sales data available for period ${period}.`, sent: false };
  }

  const recipients =
    input.recipientsOverride && input.recipientsOverride.length > 0
      ? input.recipientsOverride
      : await resolveCeoSuperAdminRecipients();
  if (recipients.length === 0) {
    return { period, reason: "No active CEO / Super Admin has a work email on file.", sent: false };
  }

  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const buffer = await buildSosBiWorkbook({
    data,
    filterSummary: "No filters (full scope) — CEO / Super Admin monthly report",
    generatedAt,
    generatedBy: "Phoenix Automated Report",
  });

  const periodLabel = periodProseLabel(data.period);
  const subject = `Source of Sales — ${periodLabel} Executive BI Report`;
  const metadataRows = [
    { label: "Period", value: periodLabel },
    { label: "Total value (EGP)", value: Math.round(data.summary.totalValue).toLocaleString() },
    { label: "Distributors", value: data.summary.distributorCount },
    { label: "Products", value: data.summary.productCount },
  ];
  const action = { href: `${systemDeployment.productionUrl}/sales`, label: "Open live dashboard" };
  const bodyText =
    `Attached is the ${periodLabel} Source-of-Sales executive BI workbook — full company scope, ` +
    "including confidential products, month-over-month and year-over-year momentum, Pareto rankings " +
    "and territory coverage. This report mirrors the live /sales dashboard for this period.";

  const html = renderPhoenixEmailHtml({
    bodyHtml: renderEmailParagraphs(bodyText),
    action,
    metadataRows,
    previewText: `${periodLabel} Source-of-Sales BI report attached.`,
    subject,
    title: "Source of Sales — Executive BI Report",
  });
  const text = renderPhoenixEmailText({
    action,
    bodyText,
    metadataRows,
    title: "Source of Sales — Executive BI Report",
  });

  const result = await sendPhoenixEmail({
    attachments: [
      {
        content: buffer.toString("base64"),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename: `phoenix-sos-dashboard_${period}.xlsx`,
      },
    ],
    fanoutToBcc: true,
    html,
    idempotencyKey: `sos-bi-report:${period}`,
    subject,
    text,
    to: recipients,
  });

  if (result.skipped) {
    return { period, reason: result.reason, sent: false };
  }
  return { period, recipients, sent: true };
}
