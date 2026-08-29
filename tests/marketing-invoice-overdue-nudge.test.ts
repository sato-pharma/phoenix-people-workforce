import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  INVOICE_OVERDUE_CHANNELS,
  INVOICE_OVERDUE_EVENT_TYPE,
  INVOICE_OVERDUE_FINANCE_AUDIENCE,
  INVOICE_OVERDUE_FINANCE_URL,
  INVOICE_OVERDUE_REQUESTER_URL,
  describeOverdueInvoice,
  financeOverdueInvoiceDigest,
  groupOverdueInvoicesByRequester,
  requesterOverdueInvoiceMessage,
  type OverdueMarketingInvoice,
} from "../src/lib/marketing-requests/invoice-overdue-nudge.ts";
import {
  DEFAULT_NOTIFICATION_ROLE_POLICIES,
  notificationRoleKeys,
} from "../src/lib/notifications/role-recipients.ts";
import { enforceMarketingSlaEmailBlock } from "../src/lib/notifications/marketing-sla-channel-guard.ts";
import { resolveMarketingInvoiceObligation } from "../src/lib/marketing-requests/invoice-obligation.ts";

const ROOT = process.cwd();

/** The real production row this feature was built for, read from Phoenix HR on 2026-08-29. */
function realOverdueInvoice(): OverdueMarketingInvoice {
  return {
    amount: 5500,
    customerName: "هيثم خضري",
    daysOverdue: 18,
    deadlineDate: "2026-08-11",
    requestCode: "MR-0001",
    requestId: "11111111-1111-1111-1111-111111111111",
    requesterHrId: "B-184",
    requesterName: "Sally Saied Sedhom Mankrios Sedhom",
  };
}

function invoice(overrides: Partial<OverdueMarketingInvoice>): OverdueMarketingInvoice {
  return { ...realOverdueInvoice(), ...overrides };
}

export function runMarketingInvoiceOverdueNudgeTests() {
  // ── Channels: the owner's 2026-07-25 rule, asserted out loud ────────────────────────────────
  assert.ok(
    !(INVOICE_OVERDUE_CHANNELS as readonly string[]).includes("email"),
    "a marketing lateness reminder is never emailed — the owner retired that channel on 2026-07-25 after an unactionable mail re-sent every morning for weeks",
  );
  assert.deepEqual(
    [...INVOICE_OVERDUE_CHANNELS],
    ["in_app", "telegram", "push"],
    "in-app, Telegram and push — the same three the sibling field-capture nudge uses",
  );

  // The call site's list is the intent; the guard is the guarantee. The Telegram-failure fallback
  // re-enters the pipeline asking for email on its own, so the post-filter has to hold independently.
  assert.deepEqual(
    enforceMarketingSlaEmailBlock(
      ["in_app", "email", "telegram", "push"],
      "marketing_requests",
      INVOICE_OVERDUE_EVENT_TYPE,
    ),
    ["in_app", "telegram", "push"],
    "even when something downstream asks for email on this event type, the marketing SLA guard strips it",
  );
  assert.deepEqual(
    enforceMarketingSlaEmailBlock(["in_app", "email"], "expenses", INVOICE_OVERDUE_EVENT_TYPE),
    ["in_app", "email"],
    "the block is keyed on module AND event type, so it never reaches another module reusing the name",
  );

  // ── Event type: must not collide with the approval SLA that already owns 'overdue_reminder' ──
  assert.equal(INVOICE_OVERDUE_EVENT_TYPE, "invoice_overdue");
  assert.notEqual(
    INVOICE_OVERDUE_EVENT_TYPE,
    "overdue_reminder",
    "'overdue_reminder' already means the APPROVAL is late; reusing it would merge two different reminders into one policy row and one recipient list",
  );

  // ── Audience: finance is configurable, the requester is not ─────────────────────────────────
  assert.ok(
    (notificationRoleKeys as readonly string[]).includes(INVOICE_OVERDUE_FINANCE_AUDIENCE),
    "the finance audience must be a real notification role key or /admin/notification-recipients cannot show it",
  );
  const financePolicy = DEFAULT_NOTIFICATION_ROLE_POLICIES[INVOICE_OVERDUE_FINANCE_AUDIENCE];
  assert.deepEqual(
    financePolicy.roles,
    ["Finance Manager"],
    "the owner said 'finance', and the Finance Manager is the finance_execution rung on the marketing approval chain",
  );
  assert.equal(financePolicy.enabled, true, "the owner asked for this notification, so it ships on");

  // ── Links: every action URL must be a page its audience can actually open ───────────────────
  assert.equal(
    INVOICE_OVERDUE_REQUESTER_URL,
    "/employee-portals/marketing-requests",
    "the portal workspace holds the Approved Requests tab and admits every marketing creator role",
  );
  assert.notEqual(
    INVOICE_OVERDUE_REQUESTER_URL,
    "/admin/marketing-requests",
    "the admin page admits only the five workflow roles and bounces everyone else — a requester sent there lands on /overview",
  );
  assert.equal(
    INVOICE_OVERDUE_FINANCE_URL,
    null,
    "finance gets NO link on purpose: there is no screen showing him an overdue invoice, and a button to a page that cannot show the item is the mistake this codebase has already paid for twice",
  );

  // ── Grouping: one message per person, mixed-case HR IDs collapsed ───────────────────────────
  const grouped = groupOverdueInvoicesByRequester([
    invoice({ daysOverdue: 3, requestId: "a" }),
    invoice({ daysOverdue: 18, requestId: "b" }),
    invoice({ daysOverdue: 9, requestId: "c", requesterHrId: "b-184" }),
    invoice({ daysOverdue: 1, requestId: "d", requesterHrId: "A-10", requesterName: "Nahed" }),
  ]);
  assert.equal(grouped.length, 2, "B-184 and b-184 are one person — an exact-case key would have made two");
  const sally = grouped.find((entry) => entry.hrId.toUpperCase() === "B-184");
  assert.ok(sally);
  assert.equal(sally.invoices.length, 3, "all three of that person's overdue invoices arrive in one message");
  assert.deepEqual(
    sally.invoices.map((entry) => entry.daysOverdue),
    [18, 9, 3],
    "worst first — the oldest debt is the one that needs reading",
  );
  assert.equal(
    groupOverdueInvoicesByRequester([invoice({ requesterHrId: "  " })]).length,
    0,
    "an invoice with no requester is dropped rather than grouped under an empty key",
  );

  // ── The requester's message ─────────────────────────────────────────────────────────────────
  const single = requesterOverdueInvoiceMessage({ hrId: "B-184", invoices: [realOverdueInvoice()] });
  assert.ok(single.includes("1 of your approved marketing invoice is past the deadline"));
  assert.ok(single.includes("هيثم خضري"), "the customer is named — a request code is not something anybody recognises");
  assert.ok(single.includes("EGP 5,500"), "the amount is stated so the message can be judged without opening anything");
  assert.ok(single.includes("18 days late"), "spelled out, unlike the table cell's cramped '18d late'");
  assert.ok(single.includes("2026-08-11"), "the deadline itself, so the reader can check it");
  assert.ok(!single.includes("…") && !single.includes("..."), "the owner's rule: text is never truncated with an ellipsis");

  const plural = requesterOverdueInvoiceMessage({
    hrId: "B-184",
    invoices: [realOverdueInvoice(), invoice({ daysOverdue: 1, customerName: "Hossam bosraty" })],
  });
  assert.ok(plural.includes("2 of your approved marketing invoices are past"), "plural agreement follows the count");
  assert.ok(plural.includes("1 day late"), "and so does the day count — '1 days late' reads as a bug");

  // ── The finance digest ──────────────────────────────────────────────────────────────────────
  const digest = financeOverdueInvoiceDigest([
    invoice({ daysOverdue: 2, customerName: "Hossam bosraty", requesterName: "Taha Mohamed" }),
    realOverdueInvoice(),
  ]);
  assert.ok(digest.includes("2 approved marketing invoices are past the invoice deadline"));
  assert.ok(
    digest.indexOf("هيثم خضري") < digest.indexOf("Hossam bosraty"),
    "worst first, whatever order the caller passed them in",
  );
  assert.ok(
    digest.includes("Sally Saied Sedhom Mankrios Sedhom"),
    "finance chases a PERSON — a digest of customers without owners forces a lookup on a screen he cannot open",
  );
  assert.ok(
    digest.includes("The oldest is 18 days late."),
    "the closing line reads as English — composing it from the same 'N days late' phrase once produced 'outstanding for 18 days late'",
  );
  assert.ok(
    digest.includes("Each requester has been told about their own"),
    "finance must know the requester was already chased, or he duplicates the chase",
  );

  // ── Amounts and lateness ────────────────────────────────────────────────────────────────────
  assert.ok(
    describeOverdueInvoice(invoice({ amount: null })).includes("— due"),
    "a request with no amount still describes cleanly rather than printing 'EGP null'",
  );
  assert.ok(
    !describeOverdueInvoice(invoice({ amount: null })).includes("EGP"),
    "no amount means no money phrase at all, not an empty one",
  );
  assert.ok(
    describeOverdueInvoice(invoice({ amount: 11200 })).includes("EGP 11,200"),
    "thousands are separated — an unseparated 11200 is misread at a glance",
  );
  assert.ok(
    describeOverdueInvoice(invoice({ customerName: "" })).includes("MR-0001"),
    "a customer with no name falls back to the request code rather than rendering an empty line",
  );

  // ── Source assertions: the rule must not be re-implemented here ─────────────────────────────
  const nudgeSource = readFileSync(join(ROOT, "src/lib/marketing-requests/invoice-overdue-nudge.ts"), "utf8");
  assert.ok(
    nudgeSource.includes("resolveMarketingInvoiceObligation"),
    "the overdue verdict comes from the module the screen and the export already use — a second copy of the rule is how a tab and a nudge start disagreeing",
  );
  assert.ok(
    !/invoice_status[^\n]*===\s*["']overdue["']/.test(nudgeSource),
    "nothing here may read 'overdue' off the stored column: the database never writes that value, which is the entire defect this feature fixes",
  );
  assert.ok(
    nudgeSource.includes('.eq("invoice_status", "pending")'),
    "the SQL filter is a narrowing only, and it must stay 'pending' — the status the database actually stores",
  );
  assert.ok(
    /for \(let index = 0; index < requestIds\.length; index \+= 50\)/.test(nudgeSource),
    "ids are chunked at 50: a PostgREST .in() carrying several hundred returns zero rows and no error",
  );

  // A finance HOLD is a pause somebody chose. `marketing-finance-hold` landed on main while this
  // nudge was being built, and the two features meet here: holding a request is documented as
  // silencing the overdue marker, so it has to silence the nudge as well or the hold button does
  // nothing except move the nagging from a screen to a phone.
  assert.equal(
    resolveMarketingInvoiceObligation(
      { invoiceDeadlineDate: "2026-08-11", invoiceStatus: "hold" },
      "2026-08-29",
    ).isOverdue,
    false,
    "a held invoice is never overdue, 18 days past its deadline or not — the shared resolver already says so, and routing the verdict through it is what makes the nudge inherit that for free",
  );
  assert.ok(
    !nudgeSource.includes('"hold"'),
    "the SQL narrowing must never widen to include 'hold': it would hand held rows to the resolver, which drops them anyway — but the next person to 'fix' the resolver would then start nagging about deliberate pauses",
  );

  const routeSource = readFileSync(join(ROOT, "app/api/cron/marketing-invoice-overdue-nudge/route.ts"), "utf8");
  assert.ok(
    routeSource.includes("assertCronAuthorized"),
    "the cron route is guarded by CRON_SECRET like every other job here",
  );
  assert.ok(
    routeSource.includes("withDeadMansSwitch"),
    "a job nobody watches is a job that fails silently — this one pings the dead-man's switch",
  );

  const registrySource = readFileSync(join(ROOT, "src/lib/security/access-registry.ts"), "utf8");
  assert.ok(
    registrySource.includes("/api/cron/marketing-invoice-overdue-nudge"),
    "an unregistered route fails the access-registry CI gate",
  );
}
