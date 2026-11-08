import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { MarketingCeoApprovalRow } from "../src/lib/marketing-requests/ceo-approvals.ts";
import {
  APPROVED_REQUESTS_EMAIL_EVENT,
  APPROVED_REQUESTS_EMAIL_MODULE,
  APPROVED_REQUESTS_MAX_NOTE_CHARS,
  APPROVED_REQUESTS_MAX_RECIPIENTS,
  APPROVED_REQUESTS_MAX_ROWS,
  approvedRequestsIntro,
  approvedRequestsNoticeMessage,
  approvedRequestsSubject,
  canSendMarketingCeoApprovalsEmail,
  defaultMarkFor,
  financeHoldNames,
  managersUpToNationalSalesManager,
  normalizeEmailSelection,
  renderApprovedRequestsEmail,
  resolveApprovedRequestsRecipients,
  type ApprovedRequestsEmailRow,
  type ApprovedRequestsPerson,
} from "../src/lib/marketing-requests/ceo-approvals-email.ts";
import { approvedRequestsBlocksTelegramFallback } from "../src/lib/notifications/approved-requests-channel-guard.ts";
import { resolveCeilingOverride } from "../src/lib/notifications/confidence-gate.ts";

// The "Approved requests" email from CEO Approvals (owner, 2026-11-08): the Marketing Manager ticks
// rows, writes a note beside any of them, marks a row red or "Finance hold", and sends ONE email —
// To Finance, Cc the requesters, each one's managers up to the National Sales Manager, Dr Anwar and
// Omar Anwar — with the same notice in the app and on Telegram.

function person(hrId: string, name: string, jobTitle: string, managerHrId: string | null, overrides: Partial<ApprovedRequestsPerson> = {}): ApprovedRequestsPerson {
  return {
    email: `${hrId.toLowerCase()}@satopharma.com`,
    hrId,
    isActive: true,
    jobTitle,
    managerHrId,
    name,
    ...overrides,
  };
}

// A directory shaped like the real one, measured 2026-11-08 (codes are fixtures, names are roles).
const directory = [
  person("AA", "Dr Anwar Gaweesh", "CEO", null),
  person("B-10", "Omar Anwar", "HR Manager", "AA"),
  person("B-185", "Ahmed El Maraghy", "Finance Manager", "AA"),
  person("OF-0002", "Adel El Sayed", "Accountant", "B-185"),
  person("A-9", "Hossam Reda", "Marketing Manager", "AA"),
  person("A-2", "Khaled Bedair", "SFE Manager", "AA"),
  person("A-8", "Rasha Sabry", "Group Product Manager", "AA"),
  person("B-155", "Ahmed Sharaf", "Product Manager", "A-8"),
  // Pedia: DSM → RSM → NSM → CEO.
  // A director above the National Sales Manager proves the walk stops AT the NSM, not at the CEO.
  person("SD", "Sales Director", "Commercial Director", "AA"),
  person("P-NSM", "Ali Mohamed", "Pedia National Sales Manager", "SD"),
  person("P-RSM", "Hany Saad", "Pedia Regional Sales Manager", "P-NSM"),
  person("P-DSM", "Akram Khamis", "Pedia District Sales Manager", "P-RSM"),
  // Anti Infective: DSM → NSM → CEO.
  person("AI-NSM", "Magdy El Senosey", "Anti Infective National Sales Manager", "AA"),
  person("AI-DSM", "Amir El Khouly", "Anti Infective District Sales Manager", "AI-NSM"),
  // Someone reporting straight to the CEO: the walk stops without adding him.
  person("PM-1", "Mona Fathy", "Brand Manager", "AA"),
  // A requester whose manager has left, and one with no email.
  person("GONE", "Left Manager", "District Sales Manager", "AI-NSM", { isActive: false }),
  person("R-ORPHAN", "Nour Adel", "Medical Rep", "GONE"),
  person("R-NOMAIL", "Sara Ali", "Medical Rep", "P-DSM", { email: null }),
];
const people = new Map(directory.map((entry) => [entry.hrId.toLowerCase(), entry]));

function row(requestId: string, overrides: Partial<MarketingCeoApprovalRow> = {}): MarketingCeoApprovalRow {
  return {
    approvedAtIso: "2026-11-09T08:00:00.000Z",
    approvedOnBehalfBy: null,
    customerId: null,
    customerName: `Customer ${requestId}`,
    estimatedCost: 1000,
    executedAtIso: null,
    executedByName: null,
    financeLabel: "Waiting for Finance",
    financeState: "waiting_finance",
    href: `/marketing-requests/${requestId}`,
    lineName: "Pedia",
    listedAs: "approved_in_period",
    payDate: "2026-11-20",
    payDateOverdue: false,
    requestCode: `MKT-REQ-${requestId}`,
    requestId,
    requesterHrId: "P-DSM",
    requesterName: "Akram Khamis",
    requestType: "Deal",
    statusLabel: "Pending approval",
    ...overrides,
  };
}

function emailRow(overrides: Partial<ApprovedRequestsEmailRow> = {}): ApprovedRequestsEmailRow {
  return {
    customerName: "صيدلية الشفاء",
    estimatedCost: 20000,
    lineName: "Pedia",
    mark: "none",
    note: "",
    requestType: "Deal",
    requesterName: "Akram Khamis",
    ...overrides,
  };
}

export function runMarketingCeoApprovalsEmailTests() {
  // ── Who may press Send ──────────────────────────────────────────────────────────────────────────
  assert.equal(canSendMarketingCeoApprovalsEmail("Marketing Manager"), true);
  assert.equal(canSendMarketingCeoApprovalsEmail("Super Admin"), true);
  for (const role of ["CEO", "SFE Manager", "Product Manager", "Finance Manager", "Medical Rep", null, undefined, ""]) {
    assert.equal(canSendMarketingCeoApprovalsEmail(role), false, `${String(role)} reads CEO Approvals but never sends it`);
  }

  // ── Subject: "Approved requests" and the period he filtered ─────────────────────────────────────
  assert.equal(approvedRequestsSubject({ from: "2026-11-08", to: "2026-11-15" }), "Approved requests 8th Nov to 15th Nov");
  assert.equal(approvedRequestsSubject({ from: "2026-11-01", to: "2026-11-02" }), "Approved requests 1st Nov to 2nd Nov");
  assert.equal(approvedRequestsSubject({ from: "2026-11-03", to: "2026-11-03" }), "Approved requests 3rd Nov", "one day is named once");
  assert.equal(approvedRequestsSubject({ from: "2026-11-11", to: "2026-11-13" }), "Approved requests 11th Nov to 13th Nov", "11, 12, 13 are -th");
  assert.equal(approvedRequestsSubject({ from: "2026-11-21", to: "2026-11-23" }), "Approved requests 21st Nov to 23rd Nov");
  assert.equal(approvedRequestsSubject({ from: "2026-12-28", to: "2027-01-03" }), "Approved requests 28th Dec 2026 to 3rd Jan 2027", "years only across a year end");
  assert.equal(approvedRequestsIntro({ from: "2026-11-08", to: "2026-11-15" }), "Please find below this week's transfers");
  assert.equal(approvedRequestsIntro({ from: "2026-11-01", to: "2026-11-30" }), "Please find below the transfers approved from 1st Nov to 30th Nov");

  // ── The manager chain stops after the National Sales Manager ────────────────────────────────────
  assert.deepEqual(
    managersUpToNationalSalesManager("P-DSM", people).map((entry) => entry.name),
    ["Hany Saad", "Ali Mohamed"],
    "a Pedia District Manager copies the Regional AND the National Sales Manager",
  );
  assert.deepEqual(
    managersUpToNationalSalesManager("AI-DSM", people).map((entry) => entry.name),
    ["Magdy El Senosey"],
    "an Anti Infective District Manager copies the National Sales Manager",
  );
  assert.deepEqual(managersUpToNationalSalesManager("PM-1", people), [], "the CEO ends the walk and is never added by it");
  assert.deepEqual(managersUpToNationalSalesManager("p-dsm", people).length, 2, "a lower-case id walks the same chain");
  const loop = new Map([
    ["x", person("X", "X", "District Sales Manager", "Y")],
    ["y", person("Y", "Y", "District Sales Manager", "X")],
  ]);
  assert.equal(managersUpToNationalSalesManager("X", loop).length, 1, "a manager loop ends instead of spinning");

  // ── Recipients: To Finance, Cc everyone else, each once ─────────────────────────────────────────
  const recipients = resolveApprovedRequestsRecipients({
    people,
    requesterHrIds: ["P-DSM", "AI-DSM", "R-ORPHAN", "R-NOMAIL", "B-185", "P-DSM"],
    senderHrId: "A-9",
  });
  assert.deepEqual(recipients.to.map((entry) => entry.name), ["Ahmed El Maraghy", "Adel El Sayed"]);
  assert.deepEqual(
    recipients.cc.map((entry) => entry.name),
    ["Akram Khamis", "Hany Saad", "Ali Mohamed", "Amir El Khouly", "Magdy El Senosey", "Nour Adel", "Dr Anwar Gaweesh", "Omar Anwar", "Khaled Bedair", "Rasha Sabry", "Ahmed Sharaf", "Hossam Reda"],
    "requesters with their chains, then Dr Anwar, Omar Anwar, Khaled Bedair, Rasha Sabry and Ahmed Sharaf, then the sender — nobody twice, To wins over Cc",
  );
  assert.ok(!recipients.cc.some((entry) => entry.hrId === "B-185"), "a Finance person who also requested stays on To only");
  assert.ok(recipients.warnings.some((line) => line.includes("Left Manager") && line.includes("no longer active")));
  assert.ok(recipients.warnings.some((line) => line.includes("Sara Ali") && line.includes("no work email")));
  assert.ok(!recipients.notifyHrIds.includes("A-9"), "the sender is not notified of his own email");
  assert.ok(recipients.notifyHrIds.includes("B-185") && recipients.notifyHrIds.includes("P-NSM"));
  assert.ok(APPROVED_REQUESTS_MAX_RECIPIENTS >= recipients.to.length + recipients.cc.length);

  // ── Marks start from Finance's own state ────────────────────────────────────────────────────────
  assert.equal(defaultMarkFor({ financeState: "executed" }), "executed");
  assert.equal(defaultMarkFor({ financeState: "held" }), "hold");
  assert.equal(defaultMarkFor({ financeState: "waiting_finance" }), "none");

  // ── What a browser may post ─────────────────────────────────────────────────────────────────────
  const inRange = [row("a"), row("b"), row("c")];
  const picked = normalizeEmailSelection(
    [
      { mark: "executed", note: "  paid‮  by   cheque ", requestId: "c" },
      { mark: "bogus", note: "x".repeat(APPROVED_REQUESTS_MAX_NOTE_CHARS + 50), requestId: "a" },
      { mark: "hold", note: "dup", requestId: "a" },
    ],
    inRange,
  );
  assert.deepEqual(picked.map((entry) => entry.row.requestId), ["a", "c"], "the report's order, each id once");
  assert.equal(picked[0].mark, "none", "an unknown mark is no mark");
  assert.equal(picked[0].note.length, APPROVED_REQUESTS_MAX_NOTE_CHARS);
  assert.equal(picked[1].note, "paid by cheque", "direction overrides and extra spaces are removed");
  assert.throws(() => normalizeEmailSelection([], inRange), /Tick at least one request/);
  assert.throws(() => normalizeEmailSelection([{ requestId: "zzz" }], inRange), /no longer in this date range/);
  const many = Array.from({ length: APPROVED_REQUESTS_MAX_ROWS + 1 }, (_, index) => ({ requestId: `r${index}` }));
  assert.throws(() => normalizeEmailSelection(many, inRange), new RegExp(`at most ${APPROVED_REQUESTS_MAX_ROWS} requests`));

  // ── The email ───────────────────────────────────────────────────────────────────────────────────
  const rows = [
    emailRow({ mark: "executed", note: "Paid in cash" }),
    emailRow({ customerName: "Seif Pharmacy", estimatedCost: 35000, requesterName: "Amir El Khouly", lineName: "Anti Infective", mark: "hold" }),
    emailRow({ customerName: "<script>alert(1)</script>", estimatedCost: 5000, requesterName: "Tom & Jerry", note: "<b>x</b>" }),
  ];
  assert.deepEqual(financeHoldNames(rows), ["Amir El Khouly"]);
  const content = {
    financeContactName: "Ahmed El Maraghy",
    holdNames: financeHoldNames(rows),
    range: { from: "2026-11-08", to: "2026-11-15" },
    rows,
    senderName: "Hossam Reda",
    senderTitle: "Marketing Manager",
  };
  const { html, text } = renderApprovedRequestsEmail(content);
  assert.match(html, /Dear all,<br \/>Please find below this week's transfers/);
  assert.match(html, /background-color:#0F172A;color:#ffffff/, "the weekly-plan email's navy header");
  assert.match(html, /background-color:#F8FAFC/, "zebra rows");
  assert.equal((html.match(/color:#B91C1C/g) ?? []).length >= 6, true, "every cell of the executed row is red");
  assert.match(html, /<td dir="rtl" style="[^"]*text-align:right/, "an Arabic customer reads right to left");
  assert.match(html, /@Ahmed El Maraghy<\/strong>, thanks for executing the items in/);
  assert.match(html, /@Amir El Khouly<\/strong><br \/>Thanks to contact Mr\. Ahmed El Maraghy to clear your Finance Hold\./);
  assert.match(html, /Total · 3 requests/);
  assert.match(html, />60,000</, "the total row");
  assert.match(html, /Best Regards,/);
  assert.match(html, /<strong>Hossam Reda<\/strong><br \/>Marketing Manager<br \/>Sato Pharma/);
  assert.ok(!html.includes("<script>"), "a customer name is escaped");
  assert.ok(html.includes("&lt;script&gt;") && html.includes("Tom &amp; Jerry") && html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.match(text, /Paid in cash \| \(executed, in red\)/);
  assert.match(text, /Total: 3 requests, EGP 60,000/);

  const plain = renderApprovedRequestsEmail({ ...content, holdNames: [], rows: [emailRow()] });
  assert.ok(!plain.html.includes("thanks for executing"), "no red row, no thank-you line");
  assert.ok(!plain.html.includes("Finance Hold"), "no hold, no hold line");
  assert.ok(!plain.html.includes("#B91C1C;"), "no red row, no red cell");

  const notice = approvedRequestsNoticeMessage(content);
  assert.match(notice, /^Hossam Reda sent the approved requests for 8th Nov to 15th Nov: 3 requests, EGP 60,000\./);
  assert.match(notice, /· executed · Paid in cash/);
  const longNotice = approvedRequestsNoticeMessage({ ...content, rows: Array.from({ length: 20 }, () => emailRow()) });
  assert.match(longNotice, /and 5 more in the email\.$/);

  // ── Delivery: the same notice in the app and on Telegram, and no second email ───────────────────
  assert.equal(approvedRequestsBlocksTelegramFallback(APPROVED_REQUESTS_EMAIL_MODULE, APPROVED_REQUESTS_EMAIL_EVENT), true);
  assert.equal(approvedRequestsBlocksTelegramFallback("marketing_requests", "request_submitted"), false);
  assert.equal(approvedRequestsBlocksTelegramFallback("payroll", APPROVED_REQUESTS_EMAIL_EVENT), false);
  const system = readFileSync(new URL("../src/lib/notifications/system.ts", import.meta.url), "utf8");
  assert.equal((system.match(/approvedRequestsBlocksTelegramFallback\(/g) ?? []).length, 3, "all three Telegram-fallback sites skip the re-send");

  assert.equal(
    resolveCeilingOverride(APPROVED_REQUESTS_EMAIL_MODULE, APPROVED_REQUESTS_EMAIL_EVENT, "established"),
    APPROVED_REQUESTS_MAX_RECIPIENTS,
    "his weekly email is never held by the volume gate, first run or not",
  );

  const service = readFileSync(new URL("../src/lib/marketing-requests/ceo-approvals-email-service.ts", import.meta.url), "utf8");
  assert.match(service, /canSendMarketingCeoApprovalsEmail\(access\.role\)/, "who may send is decided on the server");
  assert.match(service, /assertNotTestAccount\(access\)/);
  assert.match(service, /assertNotSeatView\(access\)/);
  assert.match(service, /if \(dryRun\) return/, "the preview sends nothing");
  assert.match(service, /channels: \["in_app", "telegram"\]/);
  assert.match(service, /writeRequiredAuditLog/);

  const component = readFileSync(new URL("../src/components/marketing-requests/marketing-ceo-approvals-report.tsx", import.meta.url), "utf8");
  assert.match(component, /canSend && selected\.size > 0 \?/, "the Send button appears only once a row is ticked");
  assert.match(component, /postEmail\(true\)/, "the button first asks who it would reach");
}
