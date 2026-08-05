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

// ─────────────────────────────────────────────────────────────────────────────
// The phantom report (spec A3).
//
// Written by the system, not by a person, and only when there is something to say. It names the
// pharmacy, its orders, the money, and the REP — because a report that describes a problem without
// naming who created it produces a meeting instead of a decision.
//
// Goes to the owner and the CEO. Not to the rep's manager: this is the escalation of last resort,
// after the held notice and the probation window have both already given the rep a way out.
// ─────────────────────────────────────────────────────────────────────────────

export type PhantomReportRow = {
  pharmacyId: string;
  pharmacyName: string;
  phoenixPharmacyCode: string;
  requesterHrId: string | null;
  orders: number;
  salesValue: number;
  daysOnProbation: number;
};

const money = (value: number) => `${Math.round(value).toLocaleString("en-US")} EGP`;

/** Active CEO + Super Admin work emails, resolved live so an account change takes effect. */
async function resolveOwnerAndCeoEmails(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data: authRows } = await supabase
    .from("app_auth_users")
    .select("hr_id")
    .eq("is_active", true)
    .in("role", ["CEO", "Super Admin"]);
  const hrIds = [
    ...new Set(
      ((authRows ?? []) as Array<{ hr_id: string | null }>).map((r) => r.hr_id?.trim()).filter((v): v is string => Boolean(v)),
    ),
  ];
  if (hrIds.length === 0) return [];
  const { data: employees } = await supabase
    .from("employees")
    .select("hr_id, work_email, employment_status")
    .in("hr_id", hrIds)
    .not("work_email", "is", null);
  const emails = new Set<string>();
  for (const row of (employees ?? []) as Array<{ work_email: string | null; employment_status: string | null }>) {
    if (isTerminalEmploymentStatus(row.employment_status)) continue;
    const email = String(row.work_email ?? "").trim().toLowerCase();
    if (email) emails.add(email);
  }
  return [...emails];
}

/** Resolve rep names once, so the report reads in names and never in HR codes (owner rule). */
async function resolveNames(hrIds: string[]): Promise<Map<string, string>> {
  const ids = hrIds.filter(Boolean);
  if (ids.length === 0) return new Map();
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from("employees").select("hr_id, full_name").in("hr_id", ids);
  return new Map(
    ((data ?? []) as Array<{ hr_id: string; full_name: string | null }>).map((e) => [
      e.hr_id.toUpperCase(),
      e.full_name ?? e.hr_id,
    ]),
  );
}

/**
 * Email the phantom report. Best-effort: a failure here is logged, never thrown, because the sweep
 * has already recorded every finding in the audit log — the email is the alert, not the record.
 */
export async function sendDirectOrderPhantomReport(rows: PhantomReportRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const recipients = await resolveOwnerAndCeoEmails();
    if (recipients.length === 0) {
      logError("Phantom report has no recipient (no active CEO/Super Admin with a work email)", {
        labels: { event: "direct_order_phantom_report_no_recipient" },
        error: new Error("no recipients"),
      });
      return;
    }

    const nameByHr = await resolveNames(rows.map((r) => r.requesterHrId ?? "").filter(Boolean));
    const totalValue = rows.reduce((sum, r) => sum + r.salesValue, 0);

    const bodyText =
      `${rows.length} pharmac${rows.length === 1 ? "y" : "ies"} completed the 90-day probation window ` +
      "with no distributor sales and no payment recorded against them.\n\n" +
      "A pharmacy that received real stock leaves a trace: it appears in a distributor sheet, or its " +
      "collection is paid. These left neither, so the stock they were approved for cannot be " +
      "accounted for.\n\n" +
      `Total value of the direct orders involved: ${money(totalValue)}.\n\n` +
      "Each pharmacy below has been moved out of the trusted list automatically and needs a decision.";

    const metadataRows = rows.map((r) => ({
      label: r.phoenixPharmacyCode,
      value:
        `${r.pharmacyName} - ${r.orders} order${r.orders === 1 ? "" : "s"}, ${money(r.salesValue)} - ` +
        `submitted by ${r.requesterHrId ? nameByHr.get(r.requesterHrId.toUpperCase()) ?? r.requesterHrId : "unknown"} - ` +
        `${r.daysOnProbation} days on probation`,
    }));

    const subject = `Direct Orders: ${rows.length} pharmac${rows.length === 1 ? "y" : "ies"} failed probation`;
    const action = {
      href: `${systemDeployment.productionUrl}/admin/direct-orders/pharmacies`,
      label: "Open Pharmacy Registry",
    };

    const html = renderPhoenixEmailHtml({
      title: "Pharmacies That Failed Probation",
      subject,
      previewText: `${rows.length} pharmacies show no distributor sales and no payment after 90 days.`,
      bodyHtml: renderEmailParagraphs(bodyText),
      metadataRows,
      action,
    });
    const text = renderPhoenixEmailText({ title: "Pharmacies That Failed Probation", bodyText, metadataRows, action });

    await sendPhoenixEmail({
      to: recipients,
      subject,
      html,
      text,
      // One report per day at most, whatever the sweep retries.
      idempotencyKey: `direct-orders-phantom-report:${new Date().toISOString().slice(0, 10)}`,
      origin: { eventType: "direct_order_phantom_report", module: "direct_orders" },
    });
  } catch (error) {
    logError("Phantom report email failed; the findings are still in the audit log", {
      labels: { event: "direct_order_phantom_report_failed" },
      error,
    });
  }
}
