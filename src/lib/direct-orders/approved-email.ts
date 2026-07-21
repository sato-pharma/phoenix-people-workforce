// Bespoke "direct order approved" email — fired on FINAL CEO approval of a normal
// direct order (not a reversal). Sends a polished, branded details table to a fixed
// recipient, CC'ing the CEO + system admin (Super Admin). Uses the direct send path
// (sendPhoenixEmail + the shared premium layout), NOT the workflow-participant
// notification hub or the DB template engine — the established pattern for a fixed,
// bespoke email (mirrors src/lib/sales/sos-report-delivery.ts).

import { systemDeployment } from "@/config/system-settings";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import {
  renderEmailParagraphs,
  renderPhoenixEmailHtml,
  renderPhoenixEmailText,
} from "@/emails/phoenix-email-layout";
import { sendPhoenixEmail } from "@/lib/email/send-phoenix-email";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { DirectOrderReportRow } from "@/lib/direct-orders/types";

/** Fixed primary recipient for the approved-order notification (owner-specified). */
const DIRECT_ORDER_APPROVED_TO = "ahmed.elmaraghy@satopharma.com";

const money = (value: number | null | undefined): string => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
};
const units = (value: number | null | undefined): string => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
};
const codeName = (name: string | null | undefined, code: string | null | undefined): string => {
  const n = (name ?? "").trim();
  const c = (code ?? "").trim();
  if (n && c) return `${n} (${c})`;
  return n || c || "—";
};

/** Active CEO + Super Admin work emails (the CC set), resolved live — never hardcoded,
 *  so executive account changes take effect automatically. Mirrors the SoS report delivery. */
async function resolveCeoSuperAdminEmails(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data: authRows, error: authError } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .eq("is_active", true)
    .in("role", ["CEO", "Super Admin"]);
  if (authError) throw authError;

  // Raw hr_id: employees.hr_id is a case-sensitive FK target; normalizing first misses matches.
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
    if (email && email !== DIRECT_ORDER_APPROVED_TO) emails.add(email);
  }
  return [...emails];
}

/**
 * Email the approved-direct-order details table to the fixed recipient, CC the CEO +
 * system admin. Best-effort: any failure is logged and swallowed so it can never block
 * an approval that has already committed.
 */
export async function sendDirectOrderApprovedEmail(row: DirectOrderReportRow): Promise<void> {
  try {
    const cc = await resolveCeoSuperAdminEmails();

    const dealLine =
      row.dealType === "discount"
        ? `Discount ${row.discountPct ?? 0}% · public price ${money(row.publicPriceSnapshot)}`
        : `Bonus ${units(row.bonus)} units · factory price ${money(row.factoryPriceSnapshot)}`;

    const metadataRows: Array<{ label: string; value: string | number | null | undefined }> = [
      { label: "Request ID", value: row.id },
      { label: "Requester", value: `${row.requesterName || row.requesterHrId} · ${row.requesterHrId} · ${row.requesterRole}` },
      { label: "Line", value: row.line || "—" },
      { label: "Product", value: codeName(row.productName, row.productCode) },
      { label: "Deal", value: dealLine },
      { label: "Quantity", value: units(row.qty) },
      { label: "Sales value (EGP)", value: money(row.salesValue) },
      { label: "Pharmacy", value: codeName(row.pharmacyName, row.pharmacyCode) },
      { label: "Address", value: row.pharmacyAddress || "—" },
      { label: "Doctor", value: row.doctorName || "—" },
      { label: "Brick", value: codeName(row.brickName, row.brickId) },
      { label: "Area", value: codeName(row.areaName, row.areaCode) },
      { label: "Region", value: codeName(row.regionName, row.regionCode) },
      { label: "Distributor codes", value: row.distributorCodesText || "—" },
      { label: "Collection date", value: row.collectionDate || "—" },
      { label: "Sales month", value: row.salesMonth || "—" },
      { label: "Approved (UTC)", value: row.decidedAt ? `${row.decidedAt.replace("T", " ").slice(0, 16)} UTC` : "—" },
    ];
    if (row.bonusOverrideReason) {
      metadataRows.push({ label: "Cap override reason", value: row.bonusOverrideReason });
    }

    const subject = `Direct Order Approved — ${row.pharmacyName || row.pharmacyCode} · ${row.productName} · ${money(row.salesValue)} EGP`;
    const bodyText =
      "A direct order request has received final CEO approval and has been posted to sales " +
      "(credited to the pharmacy's area rep). The full order details are below.";
    const action = {
      href: `${systemDeployment.productionUrl}/admin/direct-orders/report`,
      label: "Open Direct Orders report",
    };

    const html = renderPhoenixEmailHtml({
      title: "Direct Order Approved",
      subject,
      previewText: `Approved: ${row.pharmacyName || row.pharmacyCode} · ${money(row.salesValue)} EGP.`,
      bodyHtml: renderEmailParagraphs(bodyText),
      metadataRows,
      action,
    });
    const text = renderPhoenixEmailText({ title: "Direct Order Approved", bodyText, metadataRows, action });

    const sendResult = await sendPhoenixEmail({
      to: [DIRECT_ORDER_APPROVED_TO],
      cc,
      subject,
      html,
      text,
      idempotencyKey: `direct-order-approved:${row.id}`,
    });
    const outcome = sendResult.skipped ? `skipped (${sendResult.reason})` : `sent (${sendResult.id ?? "ok"})`;
    console.info(`[direct-orders] approved-email for ${row.id} → to=${DIRECT_ORDER_APPROVED_TO} cc=${cc.length}: ${outcome}`);
  } catch (error) {
    logError("Direct order approved-email failed", { labels: { event: "direct_order_approved_email_failed", requestId: row.id }, error });
  }
}
