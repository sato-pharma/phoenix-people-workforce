// "Direct order approved" email — fired on FINAL CEO approval of a normal direct order
// (not a reversal). Goes to a fixed recipient, CC'ing the CEO + system admin (Super Admin).
//
// The WORDING is admin-editable at /admin/email-templates under "Direct Order Approved"
// (2026-09-09); before that it was assembled here and could not be changed without a deploy.
// What stays here is what is generated rather than written: the grouped detail sections and
// the hero sales figure. Routing also stays here — who receives an approved order is decided
// by the approval, not by the template's recipient rules — hence replaceRecipients.

import { raiseApproval } from "@/lib/approvals/raise-approval";
import { systemDeployment } from "@/config/system-settings";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import {
  renderPhoenixMetadataSections,
  renderPhoenixMetadataSectionsText,
  type PhoenixEmailMetadataSection,
} from "@/emails/phoenix-email-layout";
import { codeNameLabel } from "@/lib/direct-orders/geo-names";
import { sendTemplatedEmail } from "@/lib/email-templates/service";
import { formatPhoenixDateTime } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { DirectOrderReportRow } from "@/lib/direct-orders/types";

/** Fixed primary recipient for the approved-order notification (owner-specified). */
const DIRECT_ORDER_APPROVED_TO = "ahmed.elmaraghy@satopharma.com";

// The null check must come BEFORE Number(): `Number(null)` is 0 and passes Number.isFinite, so
// the obvious one-liner reports an unset price as "0.00" in an email about money.
const money = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
};
const units = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—";
};
/** Shared with the approval window, so the email and the screen phrase geography identically. */
const codeName = codeNameLabel;

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

    // A basket states its units per product ("72 + 24"), never a sum.
    const bonusUnits = row.basketUnits?.bonus ?? units(row.bonus);
    const dealLine =
      row.dealType === "discount"
        ? `Discount ${row.discountPct ?? 0}% · public price ${money(row.publicPriceSnapshot)}`
        : `Bonus ${bonusUnits} units · pharmacy price ${money(row.pharmacyPriceSnapshot)}`;
    // Short form for the hero badge — the full price context still lives in the Deal row below.
    const dealBadge =
      row.dealType === "discount" ? `Discount ${row.discountPct ?? 0}%` : `Bonus ${bonusUnits} units`;

    const productDealRows: Array<{ label: string; value: string | number | null | undefined }> = [
      { label: "Product", value: codeName(row.productName, row.productCode) },
      { label: "Deal", value: dealLine },
      { label: "Quantity", value: row.basketUnits?.qty ?? units(row.qty) },
    ];
    if (row.bonusOverrideReason) {
      productDealRows.push({ label: "Cap override reason", value: row.bonusOverrideReason });
    }

    const metadataSections: PhoenixEmailMetadataSection[] = [
      {
        heading: "Order & requester",
        rows: [
          { label: "Request ID", value: row.id },
          { label: "Requester", value: `${row.requesterName || row.requesterHrId} · ${row.requesterHrId} · ${row.requesterRole}` },
          { label: "Line", value: row.line || "—" },
          { label: "Distributor codes", value: row.distributorCodesText || "—" },
          { label: "Collection date", value: row.collectionDate || "—" },
          { label: "Sales month", value: row.salesMonth || "—" },
          { label: "Approved", value: formatPhoenixDateTime(row.decidedAt) },
        ],
      },
      { heading: "Product & deal", rows: productDealRows },
      {
        heading: "Pharmacy, doctor & geography",
        rows: [
          { label: "Pharmacy", value: codeName(row.pharmacyName, row.pharmacyCode) },
          { label: "Address", value: row.pharmacyAddress || "—" },
          { label: "Doctor", value: row.doctorName || "—" },
          { label: "Brick", value: codeName(row.brickName, row.brickId) },
          { label: "Area", value: codeName(row.areaName, row.areaCode) },
          { label: "Region", value: codeName(row.regionName, row.regionCode) },
        ],
      },
    ];

    const subject = `Direct Order Approved — ${row.pharmacyName || row.pharmacyCode} · ${row.productName} · ${money(row.salesValue)} EGP`;

    // Wording lives in /admin/email-templates under "Direct Order Approved". The grouped detail
    // sections and the hero figure are generated from the order itself, so they stay here and
    // reach the template through {{detailsSections}} and the heroStat passthrough.
    const sendResult = await raiseApproval({ decision: "approved", module: "direct_order", step: "decided" }, { via: "direct-email", send: () => sendTemplatedEmail({
      context: {
        ctaLabel: "Open Direct Orders report",
        ctaUrl: `${systemDeployment.productionUrl}/admin/direct-orders/report`,
        detailsSections: renderPhoenixMetadataSections(metadataSections),
        detailsSectionsText: renderPhoenixMetadataSectionsText(metadataSections),
        subject,
        summary:
          "A direct order request has received final CEO approval and has been posted to sales " +
          "(credited to the pharmacy's area rep). The full order details are below.",
      },
      fallbackTo: [DIRECT_ORDER_APPROVED_TO],
      idempotencyKey: `direct-order-approved:${row.id}`,
      heroStat: { badge: dealBadge, label: "Sales value", value: `${money(row.salesValue)} EGP` },
      origin: { eventType: "direct_order_approved", module: "direct_orders" },
      overrides: { cc, replaceRecipients: true, to: [DIRECT_ORDER_APPROVED_TO] },
      templateKey: "direct_order_approved",
    }) });
    const outcome = sendResult.skipped ? `skipped (${sendResult.reason})` : `sent (${sendResult.id ?? "ok"})`;
    console.info(`[direct-orders] approved-email for ${row.id} → to=${DIRECT_ORDER_APPROVED_TO} cc=${cc.length}: ${outcome}`);
  } catch (error) {
    logError("Direct order approved-email failed", { labels: { event: "direct_order_approved_email_failed", requestId: row.id }, error });
  }
}
