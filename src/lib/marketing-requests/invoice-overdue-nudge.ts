// Marketing invoice obligations that have gone past their deadline — and telling the two people
// who can do something about it.
//
// #2686 made an overdue invoice VISIBLE: the Approved Requests tab and the report export both call
// `resolveMarketingInvoiceObligation`, so an obligation eighteen days past its date reads "18d late"
// instead of the plain "Pending" the database still stores. That closed half the gap. Visible is not
// the same as known — somebody has to open the tab — and the owner's standing rule is that the
// system chases people, he does not.
//
// Owner decision 2026-08-29, asked directly and answered in three words: "the requester and finance".
// So two audiences, two different messages, one run:
//
//   - the REQUESTER, per person, about their OWN requests. Always on and not role-configurable:
//     being told your own invoice is late is not an audience question.
//   - FINANCE, one digest covering everything overdue, addressed to the configured
//     `marketing_invoice_overdue_alert` role list (default: Finance Manager, who holds the
//     `finance_execution` rung on the marketing approval chain and is the person chasing it).
//     Configurable at /admin/notification-recipients so the audience can move without a deploy.
//
// The overdue RULE is not re-implemented here. `resolveMarketingInvoiceObligation` is imported from
// the module the screen and the export already use, so an invoice can never be marked late on the
// tab and absent from this run, or the reverse. If that rule changes, all three move together.

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { normalizeHrId } from "@/lib/auth/permissions";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import { resolveMarketingInvoiceObligation } from "@/lib/marketing-requests/invoice-obligation";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * IN-APP, TELEGRAM AND PUSH ONLY — never email, and exported so a test can say so out loud.
 *
 * The owner's rule of 2026-07-25 retired email for marketing-request lateness reminders after the
 * exact failure this job could reproduce: an unactionable "critical" mail re-sent every morning for
 * weeks. `marketing-sla-channel-guard.ts` now blocks `invoice_overdue` as a hard post-filter too, so
 * this list is the intent and that guard is the guarantee — the belt and the braces are deliberate,
 * because the Telegram-failure fallback re-enters the pipeline asking for email on its own.
 */
export const INVOICE_OVERDUE_CHANNELS = ["in_app", "telegram", "push"] as const;

/** Its own event type: `overdue_reminder` already means "approval is late", a different thing. */
export const INVOICE_OVERDUE_EVENT_TYPE = "invoice_overdue";

/** The finance-side audience, editable at /admin/notification-recipients. */
export const INVOICE_OVERDUE_FINANCE_AUDIENCE = "marketing_invoice_overdue_alert" as const;

/**
 * Where a REQUESTER lands: the portal workspace holding the Approved Requests tab, which is the
 * screen that renders the "Invoice due" column added in #2686.
 *
 * Checked, not assumed — `assertEmployeePortalMarketingPageAccess("requests")` gates it and the
 * marketing creator roles sit inside `marketingRequestRoles`, so every person who can raise a
 * request can open this. The obvious-looking `/admin/marketing-requests` is the WRONG choice for
 * this audience: `assertMarketingAdminPageAccess()` is called there with no options, admitting only
 * the five workflow roles, and it bounces everyone else to the portal — which then bounces an
 * admin-shell role back out to /overview.
 */
export const INVOICE_OVERDUE_REQUESTER_URL = "/employee-portals/marketing-requests";

/**
 * Finance deliberately gets NO action URL, and this is the honest answer rather than a missing one.
 *
 * There is no screen today that shows the Finance Manager an overdue invoice. He is not in
 * `marketingAdminWorkflowRoles`, so `/admin/marketing-requests` — the only page rendering the
 * Invoice due column — redirects him away, and the marketing inbox he CAN open lists requests
 * awaiting a decision, which by definition excludes an already-approved request. Linking him to
 * either would repeat a mistake this codebase has already paid for twice: a notification whose
 * button leads to a 403 or to a page that cannot show the thing it is about.
 *
 * So the facts travel IN the message instead — request code, customer, amount, requester, deadline,
 * days late — which is what he acts on anyway: he chases the invoice, he does not click a row.
 * Granting him that page is a real option and an access decision, which belongs to the owner.
 */
export const INVOICE_OVERDUE_FINANCE_URL = null;

/** One overdue obligation, flattened to what either message needs. */
export type OverdueMarketingInvoice = {
  amount: number | null;
  customerName: string;
  daysOverdue: number;
  deadlineDate: string;
  requestCode: string;
  requestId: string;
  requesterHrId: string;
  requesterName: string;
};

export type OverdueInvoiceRequester = {
  hrId: string;
  invoices: OverdueMarketingInvoice[];
};

/**
 * Group by requester so one person with three late invoices gets one message, not three.
 *
 * HR IDs are stored mixed-case across this schema and an exact-case comparison silently
 * under-returns rather than erroring — the trap that once hid 28% of a rep's own direct orders. The
 * grouping key is normalized; the ORIGINAL spelling is kept for the notification, because that is
 * what the recipient tables store.
 */
export function groupOverdueInvoicesByRequester(
  invoices: readonly OverdueMarketingInvoice[],
): OverdueInvoiceRequester[] {
  const byRequester = new Map<string, OverdueInvoiceRequester>();
  for (const invoice of invoices) {
    const key = normalizeHrId(invoice.requesterHrId);
    if (!key) continue;
    const held = byRequester.get(key);
    if (held) held.invoices.push(invoice);
    else byRequester.set(key, { hrId: invoice.requesterHrId, invoices: [invoice] });
  }
  return Array.from(byRequester.values())
    .map((requester) => ({
      hrId: requester.hrId,
      invoices: [...requester.invoices].sort((left, right) => right.daysOverdue - left.daysOverdue),
    }))
    .sort((left, right) => normalizeHrId(left.hrId).localeCompare(normalizeHrId(right.hrId)));
}

/** "EGP 5,500", or an empty string when the request carries no amount at all. */
function money(amount: number | null): string {
  return typeof amount === "number" && Number.isFinite(amount)
    ? `EGP ${Math.round(amount).toLocaleString("en-US")}`
    : "";
}

/** "18 days late" / "1 day late" — spelled out here, unlike the table cell's cramped "18d late". */
function lateness(daysOverdue: number): string {
  return `${daysOverdue} ${daysOverdue === 1 ? "day" : "days"} late`;
}

/**
 * One line describing a single overdue invoice. Names the customer rather than the request id — a
 * request code is not something anybody recognises — and never truncates with an ellipsis, the
 * owner's standing rule, because a shortened customer name is an unfindable customer.
 */
export function describeOverdueInvoice(invoice: OverdueMarketingInvoice): string {
  const amount = money(invoice.amount);
  return [
    invoice.customerName || invoice.requestCode,
    amount ? ` (${amount})` : "",
    ` — due ${invoice.deadlineDate}, ${lateness(invoice.daysOverdue)}`,
  ].join("");
}

/** What ONE requester is told about their own overdue invoices. */
export function requesterOverdueInvoiceMessage(requester: OverdueInvoiceRequester): string {
  const count = requester.invoices.length;
  const noun = count === 1 ? "invoice is" : "invoices are";
  const lines = requester.invoices.map((invoice) => `• ${describeOverdueInvoice(invoice)}`);
  return [
    `${count} of your approved marketing ${noun} past the deadline for sending the invoice.`,
    "",
    ...lines,
    "",
    "Uploading the invoice on the Approved Requests tab clears it.",
  ].join("\n");
}

/**
 * What FINANCE is told — everything overdue, in one digest, worst first.
 *
 * Carries the requester's name on every line: this audience's action is to chase a person, and a
 * digest that lists customers without saying who owes each one forces a second lookup on a screen
 * they cannot currently open.
 */
export function financeOverdueInvoiceDigest(invoices: readonly OverdueMarketingInvoice[]): string {
  const count = invoices.length;
  const noun = count === 1 ? "invoice is" : "invoices are";
  const ordered = [...invoices].sort((left, right) => right.daysOverdue - left.daysOverdue);
  const lines = ordered.map(
    (invoice) => `• ${describeOverdueInvoice(invoice)} — ${invoice.requesterName || invoice.requesterHrId}`,
  );
  const worst = ordered[0];
  return [
    `${count} approved marketing ${noun} past the invoice deadline.`,
    "",
    ...lines,
    "",
    `The oldest is ${lateness(worst?.daysOverdue ?? 0)}. Each requester has been told about their own.`,
  ].join("\n");
}

/**
 * Every marketing invoice obligation that is overdue as of today in Cairo.
 *
 * The `pending` filter is applied in SQL only as a narrowing — the ACTUAL verdict comes from
 * `resolveMarketingInvoiceObligation`, so the definition of "overdue" stays in one place. Reading
 * the status column alone would be the bug this whole feature exists to fix.
 */
export async function loadOverdueMarketingInvoices(
  today: string = currentCairoDateOnlyIso(),
): Promise<OverdueMarketingInvoice[]> {
  const supabase = getSupabaseAdmin();

  const financeResult = await supabase
    .from("marketing_request_finance_requirements")
    .select("request_id,invoice_status,invoice_deadline_date")
    .eq("invoice_status", "pending")
    .not("invoice_deadline_date", "is", null);
  if (financeResult.error) throw financeResult.error;

  const candidates = (financeResult.data ?? []) as Array<{
    invoice_deadline_date: string | null;
    invoice_status: string | null;
    request_id: string;
  }>;

  const overdueByRequestId = new Map<string, { daysOverdue: number; deadlineDate: string }>();
  for (const row of candidates) {
    const obligation = resolveMarketingInvoiceObligation(
      { invoiceDeadlineDate: row.invoice_deadline_date, invoiceStatus: row.invoice_status },
      today,
    );
    if (!obligation.isOverdue) continue;
    overdueByRequestId.set(row.request_id, {
      daysOverdue: obligation.daysOverdue,
      deadlineDate: String(row.invoice_deadline_date),
    });
  }
  if (overdueByRequestId.size === 0) return [];

  // Chunked: a PostgREST `.in()` carrying several hundred ids returns zero rows and no error at all.
  // Four rows is today's whole population, but the chunk costs nothing and the silent-empty failure
  // mode is one this repo has already been bitten by.
  const requestIds = Array.from(overdueByRequestId.keys());
  const requests: Array<{
    customer_id: string | null;
    estimated_cost: number | null;
    id: string;
    request_code: string | null;
    requester_hr_id: string | null;
  }> = [];
  for (let index = 0; index < requestIds.length; index += 50) {
    const chunk = requestIds.slice(index, index + 50);
    const result = await supabase
      .from("marketing_requests")
      .select("id,request_code,requester_hr_id,customer_id,estimated_cost")
      .in("id", chunk);
    if (result.error) throw result.error;
    requests.push(...((result.data ?? []) as typeof requests));
  }

  const customerIds = Array.from(
    new Set(requests.map((request) => request.customer_id).filter((id): id is string => Boolean(id))),
  );
  const customerNameById = new Map<string, string>();
  for (let index = 0; index < customerIds.length; index += 50) {
    const chunk = customerIds.slice(index, index + 50);
    const result = await supabase.from("marketing_customers").select("id,display_name").in("id", chunk);
    if (result.error) throw result.error;
    for (const row of (result.data ?? []) as Array<{ display_name: string | null; id: string }>) {
      customerNameById.set(row.id, row.display_name ?? "");
    }
  }

  const employees = await getEmployeeDirectoryRows();
  const employeeByHrId = new Map(employees.map((employee) => [normalizeHrId(employee.hrId), employee]));

  return requests
    .map((request) => {
      const overdue = overdueByRequestId.get(request.id);
      if (!overdue) return null;
      const requesterHrId = String(request.requester_hr_id ?? "").trim();
      return {
        amount: request.estimated_cost,
        customerName: customerNameById.get(String(request.customer_id ?? "")) ?? "",
        daysOverdue: overdue.daysOverdue,
        deadlineDate: overdue.deadlineDate,
        requestCode: request.request_code ?? "",
        requestId: request.id,
        requesterHrId,
        requesterName: employeeByHrId.get(normalizeHrId(requesterHrId))?.displayName ?? "",
      } satisfies OverdueMarketingInvoice;
    })
    .filter((invoice): invoice is OverdueMarketingInvoice => invoice !== null)
    .sort((left, right) => right.daysOverdue - left.daysOverdue);
}

export type MarketingInvoiceOverdueNudgeResult = {
  financeNotified: number;
  financeWarnings: string[];
  overdueInvoices: number;
  requestersNotified: number;
  skipped: number;
};

/**
 * Tell the requester and finance, once a day.
 *
 * The idempotency key carries the Cairo date AND the day count, so a second run on the same day
 * re-sends nothing while an invoice that slips one more day still produces tomorrow's message. That
 * matters because the count is the whole point of the reminder: a message saying "18 days late"
 * suppressed on day 19 would be a stale fact presented as a current one.
 *
 * `subjectHrId` is set to the RECIPIENT on both messages, so the fail-closed explicit-recipient
 * check sees subject and recipient agree. A finance digest spans many requesters and therefore has
 * no single subject to name; pointing it at one of them would be arbitrary and would misreport who
 * the notification is about. (`marketing_requests` is not in `explicitSensitiveModules`, so that
 * check passes either way here — this is about the row being truthful, not about getting through.)
 */
export async function runMarketingInvoiceOverdueNudge(
  today: string = currentCairoDateOnlyIso(),
): Promise<MarketingInvoiceOverdueNudgeResult> {
  const invoices = await loadOverdueMarketingInvoices(today);
  let requestersNotified = 0;
  let financeNotified = 0;
  let skipped = 0;

  if (invoices.length === 0) {
    return {
      financeNotified: 0,
      financeWarnings: [],
      overdueInvoices: 0,
      requestersNotified: 0,
      skipped: 0,
    };
  }

  for (const requester of groupOverdueInvoicesByRequester(invoices)) {
    try {
      await createSystemNotification({
        actionUrl: INVOICE_OVERDUE_REQUESTER_URL,
        channels: [...INVOICE_OVERDUE_CHANNELS],
        eventType: INVOICE_OVERDUE_EVENT_TYPE,
        message: requesterOverdueInvoiceMessage(requester),
        metadata: {
          idempotencyKey: `marketing-invoice-overdue:requester:${today}:${normalizeHrId(requester.hrId)}:${requester.invoices.reduce((sum, invoice) => sum + invoice.daysOverdue, 0)}`,
          invoiceCount: requester.invoices.length,
          requestIds: requester.invoices.map((invoice) => invoice.requestId),
        },
        module: "marketing_requests",
        priority: "high",
        recipientHrId: requester.hrId,
        subjectHrId: requester.hrId,
        title: "Marketing invoice past its deadline",
      });
      requestersNotified += 1;
    } catch (error) {
      skipped += 1;
      logNotificationSendFailure("marketingRequests.runMarketingInvoiceOverdueNudge.requester", error);
    }
  }

  const { recipients, warnings } = await resolveNotificationPersonRecipients(
    INVOICE_OVERDUE_FINANCE_AUDIENCE,
    "Marketing invoice overdue — finance recipients",
  );

  // Say so loudly rather than reporting a clean run: an audience that resolves to nobody looks
  // exactly like an audience with nothing to say, and that is how a job goes unread for weeks.
  if (recipients.length === 0) {
    logError("Marketing invoices are overdue but the finance audience resolved to nobody", {
      labels: { event: "marketing_invoice_overdue_no_finance_recipient", job: "marketing-invoice-overdue-nudge" },
      error: new Error(
        `${invoices.length} overdue marketing invoices had no finance recipient. Warnings: ${warnings.join("; ") || "none"}`,
      ),
    });
  }

  const digest = financeOverdueInvoiceDigest(invoices);
  const financeIdempotencyBase = `marketing-invoice-overdue:finance:${today}:${invoices.reduce((sum, invoice) => sum + invoice.daysOverdue, 0)}`;
  for (const recipient of recipients) {
    try {
      await createSystemNotification({
        // No actionUrl — see INVOICE_OVERDUE_FINANCE_URL. There is no screen to send him to yet.
        channels: [...INVOICE_OVERDUE_CHANNELS],
        eventType: INVOICE_OVERDUE_EVENT_TYPE,
        message: digest,
        metadata: {
          idempotencyKey: `${financeIdempotencyBase}:${recipient.hrId}`,
          invoiceCount: invoices.length,
          requestIds: invoices.map((invoice) => invoice.requestId),
        },
        module: "marketing_requests",
        priority: "high",
        recipientHrId: recipient.hrId,
        recipientUserId: recipient.userId,
        subjectHrId: recipient.hrId,
        title: "Marketing invoices past their deadline",
      });
      financeNotified += 1;
    } catch (error) {
      skipped += 1;
      logNotificationSendFailure("marketingRequests.runMarketingInvoiceOverdueNudge.finance", error);
    }
  }

  return {
    financeNotified,
    financeWarnings: warnings,
    overdueInvoices: invoices.length,
    requestersNotified,
    skipped,
  };
}
