// Marketing field-capture backlog — who owes a real visit, and telling them so.
//
// The badge added in #2347/#2354 tells the truth on screen: 150 of 177 marketing customers carry a
// validated status that no rep ever proved in the field. Truth on a screen is not the same as work
// getting done, and the owner's standing rule is that the system chases people, he does not. So the
// same rule that draws the badge also drives a daily nudge to the person who can actually close it.
//
// The rule is NOT re-implemented here. `customerFieldEvidenceGap` is imported from the badge's own
// module, so a customer can never be badged on screen and absent from someone's list, or the
// reverse. If that rule changes, both move together or neither does.

import { cairoTodayIso } from "@/lib/attendance/working-days";
import { isDeskValidated, isInferredFromHistory } from "@/lib/customer-pharmacy-mapping/readiness";
import { createSystemNotification, logNotificationSendFailure } from "@/lib/notifications/system";
import type { MarketingEvidenceStatus } from "@/lib/marketing-requests/types";
import { customerFieldEvidenceGap, type FieldEvidenceGap } from "@/lib/marketing-requests/validation-report";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Where a rep lands from the nudge: the PORTAL's Customer Validation screen, which renders the
 * same badge and holds the completion path #2352 added.
 *
 * NOT the Customer Database screen, which is the obvious-looking choice and the wrong one:
 * `assertMarketingCustomerDatabaseAccess` admits Super Admin and SFE Manager ONLY, so linking
 * there would have sent all 51 reps to a 403 every morning. This page is gated by
 * `assertEmployeePortalMarketingPageAccess("requests")`, and Medical Rep is in
 * `marketingCreatorRoles` — checked, not assumed.
 */
export const FIELD_CAPTURE_ACTION_URL = "/employee-portals/marketing-requests/validation";

/**
 * IN-APP, TELEGRAM AND PUSH ONLY — never email, and exported so a test can say so out loud. Two
 * standing owner rules meet here: bulk email is never fired from this system, and 51 recipients is
 * bulk by any reading. Passed explicitly rather than left to the notification policy table, so a
 * future policy edit cannot quietly put email back on a 51-recipient daily job.
 */
export const FIELD_CAPTURE_CHANNELS = ["in_app", "telegram", "push"] as const;

/**
 * HR IDs are stored mixed-case across this schema, and an `.eq` on the wrong case silently returns
 * fewer rows rather than erroring — that trap cost 28% of a rep's own direct orders once. Every
 * comparison and every grouping key here goes through this first.
 */
function cleanHrId(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

export type FieldCaptureBacklogCustomer = {
  customerCode: string;
  customerId: string;
  customerName: string;
  /** Why it is unproven — the same three answers the badge gives. */
  gap: FieldEvidenceGap;
  /**
   * The shops linked to this customer. Named because the VENUE half is usually the only capture
   * still obtainable: a doctor is rarely standing in his pharmacy when the rep calls, which is why
   * #2352 made a venue completable long after the fact. Telling a rep "photograph the shop" is
   * actionable; telling him "this customer is unproven" is not.
   */
  venueNames: string[];
};

export type FieldCaptureBacklogOwner = {
  customers: FieldCaptureBacklogCustomer[];
  hrId: string;
  /**
   * `owner` when the customer names its own rep, `manager` when it does not and the nudge falls
   * through to the manager. Reported so a run can be read without guessing why someone was picked.
   */
  routedVia: "manager" | "owner";
};

export type MarketingFieldCaptureBacklog = {
  owners: FieldCaptureBacklogOwner[];
  totals: {
    customers: number;
    owners: number;
    unassignedCustomers: number;
  };
  /**
   * Customers naming neither a rep nor a manager. Production had 53 such links on 2026-08-23, and
   * they are the ones that would vanish silently from a naive "group by owner" — so they are
   * returned separately and reported, never dropped. Nobody can be nudged about them; they need an
   * owner assigned first.
   */
  unassigned: FieldCaptureBacklogCustomer[];
};

/**
 * One customer with its links, already loaded. The rule below is pure over this shape so the real
 * production combinations can be tested without a database in the way.
 */
export type FieldCaptureBacklogInput = {
  customerCode: string;
  customerEvidenceStatus: MarketingEvidenceStatus;
  customerId: string;
  customerName: string;
  links: ReadonlyArray<{
    pharmacyEvidenceStatus: MarketingEvidenceStatus;
    pharmacyName: string;
    validationNotes: string | null;
  }>;
  managerHrId: string | null;
  ownerHrId: string | null;
};

/**
 * Which customers are unproven, and whose problem each one is.
 *
 * Pure. The "is this unproven" half is delegated wholesale to `customerFieldEvidenceGap` — the
 * badge's own function — so this file decides only WHO, never WHETHER.
 */
export function groupFieldCaptureBacklog(
  customers: readonly FieldCaptureBacklogInput[],
): MarketingFieldCaptureBacklog {
  const ownerBuckets = new Map<string, { customers: FieldCaptureBacklogCustomer[]; routedVia: "manager" | "owner" }>();
  const unassigned: FieldCaptureBacklogCustomer[] = [];
  let customerCount = 0;

  for (const customer of customers) {
    // The badge's own input shape, built the badge's own way — the flags from the link's frozen
    // note, the two evidence statuses as they stand right now.
    const gap = customerFieldEvidenceGap(
      customer.links.map((link) => ({
        customerEvidenceStatus: customer.customerEvidenceStatus,
        deskValidated: isDeskValidated(link.validationNotes),
        inferredFromHistory: isInferredFromHistory(link.validationNotes),
        pharmacyEvidenceStatus: link.pharmacyEvidenceStatus,
      })),
    );
    if (!gap) continue;

    customerCount += 1;
    const entry: FieldCaptureBacklogCustomer = {
      customerCode: customer.customerCode,
      customerId: customer.customerId,
      customerName: customer.customerName,
      gap,
      venueNames: Array.from(
        new Set(customer.links.map((link) => link.pharmacyName).filter((name) => name.length > 0)),
      ),
    };

    const ownerHrId = cleanHrId(customer.ownerHrId);
    const routedTo = ownerHrId ?? cleanHrId(customer.managerHrId);
    if (!routedTo) {
      unassigned.push(entry);
      continue;
    }

    const bucket = ownerBuckets.get(routedTo) ?? { customers: [], routedVia: ownerHrId ? "owner" : "manager" };
    bucket.customers.push(entry);
    ownerBuckets.set(routedTo, bucket);
  }

  const owners: FieldCaptureBacklogOwner[] = Array.from(ownerBuckets.entries())
    .map(([hrId, bucket]) => ({
      customers: [...bucket.customers].sort((a, b) => a.customerName.localeCompare(b.customerName)),
      hrId,
      routedVia: bucket.routedVia,
    }))
    .sort((a, b) => b.customers.length - a.customers.length || a.hrId.localeCompare(b.hrId));

  return {
    owners,
    totals: { customers: customerCount, owners: owners.length, unassignedCustomers: unassigned.length },
    unassigned,
  };
}

type CustomerRow = {
  customer_code: string | null;
  display_name: string | null;
  evidence_status: string | null;
  id: string;
  manager_hr_id: string | null;
  owner_hr_id: string | null;
};

type PharmacyRow = {
  display_name: string | null;
  evidence_status: string | null;
  id: string;
};

type LinkRow = {
  customer_id: string;
  id: string;
  pharmacy_id: string;
  validation_notes: string | null;
};

function evidenceStatus(value: string | null | undefined): MarketingEvidenceStatus {
  return (value ?? "missing") as MarketingEvidenceStatus;
}

/**
 * Every marketing customer whose validated status has no field capture behind it, grouped by the
 * person who can go and get one.
 *
 * Scoped to ACTIVE links only, exactly like the screen — an inactive link is not shown to anybody,
 * so nudging about it would send a rep to a row he cannot see.
 */
export async function loadMarketingFieldCaptureBacklog(): Promise<MarketingFieldCaptureBacklog> {
  const supabase = getSupabaseAdmin();

  const linksResult = await supabase
    .from("marketing_customer_pharmacies")
    .select("id, customer_id, pharmacy_id, validation_notes")
    .eq("active", true);
  if (linksResult.error) throw linksResult.error;

  const links = (linksResult.data ?? []) as LinkRow[];
  if (links.length === 0) {
    return { owners: [], totals: { customers: 0, owners: 0, unassignedCustomers: 0 }, unassigned: [] };
  }

  const customerIds = Array.from(new Set(links.map((link) => link.customer_id)));
  const pharmacyIds = Array.from(new Set(links.map((link) => link.pharmacy_id)));

  const [customersResult, pharmaciesResult] = await Promise.all([
    supabase
      .from("marketing_customers")
      .select("id, customer_code, display_name, evidence_status, owner_hr_id, manager_hr_id")
      .in("id", customerIds),
    supabase.from("marketing_pharmacies").select("id, display_name, evidence_status").in("id", pharmacyIds),
  ]);
  if (customersResult.error) throw customersResult.error;
  if (pharmaciesResult.error) throw pharmaciesResult.error;

  const pharmacyById = new Map((pharmaciesResult.data ?? []).map((row) => [row.id, row as PharmacyRow]));
  const linksByCustomerId = new Map<string, LinkRow[]>();
  for (const link of links) {
    const bucket = linksByCustomerId.get(link.customer_id) ?? [];
    bucket.push(link);
    linksByCustomerId.set(link.customer_id, bucket);
  }

  const inputs: FieldCaptureBacklogInput[] = ((customersResult.data ?? []) as CustomerRow[]).map((customer) => ({
    customerCode: customer.customer_code ?? "",
    customerEvidenceStatus: evidenceStatus(customer.evidence_status),
    customerId: customer.id,
    customerName: customer.display_name ?? "",
    links: (linksByCustomerId.get(customer.id) ?? []).map((link) => ({
      pharmacyEvidenceStatus: evidenceStatus(pharmacyById.get(link.pharmacy_id)?.evidence_status),
      pharmacyName: pharmacyById.get(link.pharmacy_id)?.display_name ?? "",
      validationNotes: link.validation_notes,
    })),
    managerHrId: customer.manager_hr_id,
    ownerHrId: customer.owner_hr_id,
  }));

  return groupFieldCaptureBacklog(inputs);
}

/**
 * What one rep is told. Names the shops rather than the abstraction, and never truncates with an
 * ellipsis — the owner's standing rule, and a truncated shop name is an unfindable shop.
 */
export function fieldCaptureNudgeMessage(owner: FieldCaptureBacklogOwner): string {
  const count = owner.customers.length;
  const noun = count === 1 ? "customer" : "customers";
  const named = owner.customers
    .slice(0, 3)
    .map((customer) => customer.customerName || customer.customerCode)
    .filter(Boolean);
  const remainder = count - named.length;
  const list = named.length > 0 ? ` Starting with ${named.join(", ")}${remainder > 0 ? ` and ${remainder} more` : ""}.` : "";
  return (
    `${count} of your marketing ${noun} show a validated status with no field capture behind them.` +
    `${list} Photographing the shop on your next visit closes it — the customer does not have to be there.`
  );
}

export type MarketingFieldCaptureNudgeResult = {
  customersCovered: number;
  notified: number;
  skipped: number;
  unassignedCustomers: number;
};

/**
 * Tell each rep what they owe, once a day.
 *
 * IN-APP, TELEGRAM AND PUSH ONLY — never email. Two standing owner rules meet here: bulk email is
 * never to be fired from this system, and this is by definition bulk (51 recipients in production).
 * The channel list is passed explicitly rather than left to the policy table so that a future
 * policy edit cannot quietly reintroduce email on a 51-recipient daily job.
 *
 * Each recipient gets their OWN message, so this loops the single-recipient call rather than using
 * `createSystemNotificationForRecipients` — that helper exists to consolidate ONE shared email
 * across many recipients, and there is no email here to consolidate. `subjectHrId` is set to the
 * recipient so the fail-closed explicit-recipient check sees subject and recipient agree.
 *
 * The idempotency key carries the Cairo date, so a second run on the same day re-sends nothing —
 * which matters because the daily route has unlimited scheduler retries.
 */
export async function runMarketingFieldCaptureNudge(): Promise<MarketingFieldCaptureNudgeResult> {
  const backlog = await loadMarketingFieldCaptureBacklog();
  const today = cairoTodayIso();
  let notified = 0;
  let skipped = 0;
  let customersCovered = 0;

  for (const owner of backlog.owners) {
    customersCovered += owner.customers.length;
    try {
      await createSystemNotification({
        actionUrl: FIELD_CAPTURE_ACTION_URL,
        channels: [...FIELD_CAPTURE_CHANNELS],
        eventType: "field_capture_backlog",
        message: fieldCaptureNudgeMessage(owner),
        metadata: {
          customerCodes: owner.customers.map((customer) => customer.customerCode),
          customerCount: owner.customers.length,
          idempotencyKey: `marketing-field-capture:${today}:${owner.hrId}`,
          routedVia: owner.routedVia,
        },
        module: "marketing_requests",
        priority: "normal",
        recipientHrId: owner.hrId,
        subjectHrId: owner.hrId,
        title: "Marketing customers still need field proof",
      });
      notified += 1;
    } catch (error) {
      skipped += 1;
      logNotificationSendFailure("marketingRequests.runMarketingFieldCaptureNudge", error);
    }
  }

  // Nobody can be nudged about these, so say so loudly rather than letting them sit at zero
  // attention for ever. A silent drop here is exactly how 53 links stayed invisible.
  if (backlog.unassigned.length > 0) {
    logError("Marketing customers need field proof but name no rep or manager", {
      labels: { event: "marketing_field_capture_unassigned", job: "daily-marketing-field-capture" },
      error: new Error(
        `${backlog.unassigned.length} marketing customers have no owner_hr_id and no manager_hr_id: ` +
          backlog.unassigned.map((customer) => customer.customerCode).join(", "),
      ),
    });
  }

  return {
    customersCovered,
    notified,
    skipped,
    unassignedCustomers: backlog.unassigned.length,
  };
}
