import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  askDirectOrderWithoutReceipt,
  closeDirectOrderReceiptBook,
  countDirectOrderWithoutReceiptToDecide,
  decideDirectOrderWithoutReceipt,
  issueDirectOrderReceiptBook,
  listDirectOrderWithoutReceiptToDecide,
  listLateReceiptsForRequester,
  loadDirectOrderReceiptPanel,
  loadDirectOrderReceiptPrint,
  loadDirectOrderReceiptRegister,
  recordDirectOrderDelivery,
  recordDirectOrderReceipt,
  recordDirectOrderWarehouseExit,
  releaseDirectOrderReceipt,
} from "../src/lib/direct-orders/receipt-books.ts";
import {
  bookHeldAtApproval,
  cairoDateKeyOf,
  checkBookIssue,
  checkDeliveryForOrder,
  checkNoReceiptAsk,
  checkNoReceiptDecision,
  checkReceiptForOrder,
  checkReceiptRelease,
  checkReceiptVoid,
  checkWarehouseExit,
  classifyOrderReceipt,
  normalizeReceiptCode,
  parseDateKey,
  parseReceiptSerial,
  receiptDueDates,
  receiptEntryBookFor,
  receiptLateness,
  receiptRolloutStart,
  type NoReceiptRow,
  type OrderForReceipt,
  type ReceiptBookRow,
  type ReceiptProgress,
  type ReceiptRow,
} from "../src/lib/direct-orders/receipt-rules.ts";
import { withPostgrestStandIn, writesTo, type Row, type StandIn } from "./support/postgrest-stand-in.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The delivery-receipt books (owner, 26 Nov 2026: "Build the check"; "Finance"; "14 days").
//
// Every District Manager holds a printed book of numbered receipts; each page carries a six-digit
// serial and a random six-character code. A receipt proves ONE direct order, for ever. These tests
// pin the three promises the paper rests on:
//   1. an invented page is refused — its code does not match the serial;
//   2. one paper never proves two orders — the claim is a compare-and-set on `state = unused`;
//   3. a page from a book not in the requester's hands (never issued, returned, lost, someone
//      else's) is refused.
// and the 14-day flag, whose cutover is each book's own issue date.
//
// The 27 Nov 2026 gap audit added (owner: "Flag them", "Allow late entry", "make an undo option",
// "Fix all in PR 829"): an order raised by someone holding no book is flagged after the rollout; a
// returned book still proves an order approved while it was held; Finance can take a receipt off the
// wrong order with a reason; every refused attempt is written on the order; a hand-out names a
// person still at work; and closing a book is one database call.
//
// TWO ORIGINALS AND A COPY (owner, 27 Nov 2026, "Go, build it"): Original 1 is the manager's signed
// custody of the goods and claims the receipt; Original 2 is the page the customer signs and stamps,
// added to the same receipt once. Finance records the day the goods left the warehouse; from the next
// day Original 1 is due in 3 calendar days and Original 2 in 6 working days, Friday off. Nothing is
// late before the exit is recorded, and the order "has its receipt" only with both originals in.
//
// An order with no receipt stands only with the CEO's approval (owner, 27 Nov 2026: "صلاحيه عمل اى
// اوردر بدون ايصال هى صلاحيه انور فقط لاغير"; he chose "Anwar approves in Phoenix"): Finance asks
// with a reason, the CEO alone decides — never the Super Admin — and an approved order leaves the
// missing-receipt lists.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-12-20T10:00:00.000Z");

function book(overrides: Partial<ReceiptBookRow> = {}): ReceiptBookRow {
  return {
    bookNo: 1,
    firstSerial: 1,
    lastSerial: 50,
    printedHolderHrId: "AI-0001",
    holderHrId: "AI-0001",
    status: "issued",
    issuedAt: "2026-12-01T08:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

function receipt(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return { serial: 7, bookNo: 1, checkCode: "AB3K7Q", state: "unused", requestId: null, voidedReason: null, ...overrides };
}

function order(overrides: Partial<OrderForReceipt> = {}): OrderForReceipt {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    requesterHrId: "ai-0001",
    status: "approved",
    decidedAt: "2026-12-10T09:00:00.000Z",
    reversalOfRequestId: null,
    ...overrides,
  };
}

function check(input: Partial<Parameters<typeof checkReceiptForOrder>[0]> = {}) {
  return checkReceiptForOrder({
    order: order(),
    serial: 7,
    typedCode: "AB3K7Q",
    receipt: receipt(),
    book: book(),
    orderReceiptSerial: null,
    ...input,
  });
}

function reasonOf(decision: ReturnType<typeof checkReceiptForOrder>): string {
  return decision.ok ? "ok" : decision.reason;
}

function pureTests() {
  assert.equal(parseReceiptSerial("000123"), 123, "the serial as printed, leading zeros and all");
  assert.equal(parseReceiptSerial("٠٠٠١٢٣"), 123, "Arabic-Indic digits typed on an Arabic keyboard");
  assert.equal(parseReceiptSerial("1234567"), null, "seven digits is not a printed serial");
  assert.equal(parseReceiptSerial("0"), null);
  assert.equal(parseReceiptSerial("12a"), null);

  assert.equal(normalizeReceiptCode(" ab3k7q "), "AB3K7Q", "lower case and spaces are forgiven");
  assert.equal(normalizeReceiptCode("AB3K7O"), null, "O is not in the printer's alphabet, so it cannot be a real code");
  assert.equal(normalizeReceiptCode("AB3K7"), null);

  assert.equal(reasonOf(check()), "ok", "the requester's own unused receipt with its printed code");
  assert.equal(reasonOf(check({ typedCode: "ZZZZZZ" })), "code_mismatch", "an invented page is refused");
  assert.equal(
    reasonOf(check({ typedCode: "ZZZZZZ", receipt: receipt({ state: "used", requestId: "x" }) })),
    "code_mismatch",
    "a wrong code is refused BEFORE 'already used' is said, so guessing a code learns nothing",
  );
  assert.equal(reasonOf(check({ receipt: receipt({ state: "used", requestId: "x" }) })), "receipt_used", "one paper never proves two orders");
  assert.equal(reasonOf(check({ receipt: receipt({ state: "voided", voidedReason: "spoiled" }) })), "receipt_voided");
  assert.equal(reasonOf(check({ book: book({ holderHrId: "PD-0012", printedHolderHrId: "PD-0012" }) })), "other_holders_book");
  assert.equal(reasonOf(check({ book: book({ status: "in_store", holderHrId: null, issuedAt: null }) })), "book_not_issued");
  // Late entry (owner, 27 Nov 2026: "Allow late entry"): a returned book proves an order approved while it was held.
  assert.equal(
    reasonOf(check({ book: book({ status: "returned", closedAt: "2026-12-15T00:00:00Z" }) })),
    "ok",
    "a page from a returned book still proves an order approved while the manager held it",
  );
  assert.equal(
    reasonOf(check({ book: book({ status: "returned", closedAt: "2026-12-05T00:00:00Z" }) })),
    "book_returned",
    "a returned book never proves an order approved after it came back",
  );
  assert.equal(
    reasonOf(check({ book: book({ status: "returned", closedAt: "2026-12-15T00:00:00Z", holderHrId: "PD-0012", printedHolderHrId: "PD-0012" }) })),
    "other_holders_book",
    "late entry is from the requester's own book only",
  );
  assert.equal(
    reasonOf(check({ typedCode: "ZZZZZZ", book: book({ status: "returned", closedAt: "2026-12-15T00:00:00Z" }) })),
    "code_mismatch",
    "late entry still checks the printed code",
  );
  assert.equal(reasonOf(check({ book: book({ status: "lost", closedAt: "2026-12-15T00:00:00Z" }) })), "book_lost");
  assert.equal(reasonOf(check({ receipt: null, book: null })), "no_such_receipt");
  assert.equal(reasonOf(check({ order: order({ status: "pending_approval" }) })), "order_not_approved");
  assert.equal(reasonOf(check({ order: order({ reversalOfRequestId: "r" }) })), "order_not_approved", "a reversal never takes a receipt");
  assert.equal(reasonOf(check({ orderReceiptSerial: 3 })), "order_has_receipt", "an order takes one receipt");

  // The due dates (owner, 27 Nov 2026): counted from the day AFTER the exit. 10 Dec 2026 is a Thursday.
  assert.deepEqual(receiptDueDates("2026-12-10"), { custodyDue: "2026-12-13", deliveryDue: "2026-12-17" }, "left Thursday: Original 1 by Sunday, Original 2 by the next Thursday, the Friday skipped");
  assert.deepEqual(receiptDueDates("2026-12-12"), { custodyDue: "2026-12-15", deliveryDue: "2026-12-19" }, "left Saturday: the Friday inside the week is skipped");
  assert.deepEqual(receiptDueDates("2026-12-11"), { custodyDue: "2026-12-14", deliveryDue: "2026-12-17" }, "left on a Friday: the count starts Saturday");
  assert.deepEqual(receiptDueDates("2026-12-30"), { custodyDue: "2027-01-02", deliveryDue: "2027-01-06" }, "across the year end");
  assert.equal(parseDateKey("2026-12-10"), "2026-12-10");
  assert.equal(parseDateKey("2026-02-30"), null, "never a day that does not exist");
  assert.equal(parseDateKey("10/12/2026"), null);
  assert.equal(cairoDateKeyOf(new Date("2026-12-10T22:30:00.000Z")), "2026-12-11", "the Cairo day, not the UTC day");

  const progress = (overrides: Partial<ReceiptProgress> = {}): ReceiptProgress => ({ custodyEntered: false, deliveryEntered: false, exitDate: "2026-12-10", ...overrides });
  assert.equal(receiptLateness(progress({ exitDate: null }), "2027-03-01"), null, "nothing is late before Finance records the exit");
  assert.equal(receiptLateness(progress(), "2026-12-13"), null, "Original 1 on its due day is not late");
  assert.deepEqual(receiptLateness(progress(), "2026-12-14"), { original: "custody", dueDate: "2026-12-13", daysLate: 1 }, "Original 1 the day after is late");
  assert.equal(receiptLateness(progress({ custodyEntered: true }), "2026-12-17"), null, "Original 2 on its due day is not late");
  assert.deepEqual(receiptLateness(progress({ custodyEntered: true }), "2026-12-19"), { original: "delivery", dueDate: "2026-12-17", daysLate: 2 }, "Original 2 after its working week is late");
  assert.deepEqual(receiptLateness(progress(), "2026-12-19")?.original, "custody", "the custody page is said first: it was due first");
  assert.equal(receiptLateness(progress({ custodyEntered: true, deliveryEntered: true }), "2027-03-01"), null);

  // The standing, and its cutover: each book's own issue date.
  const books = [book()];
  const at = (days: number) => new Date(Date.parse("2026-12-10T09:00:00.000Z") + days * DAY);
  const none = progress({ exitDate: null });
  assert.equal(classifyOrderReceipt({ order: order(), books, progress: none, now: at(60) }), "awaiting_exit", "before the exit is recorded nothing counts, however long");
  assert.equal(classifyOrderReceipt({ order: order(), books, progress: progress(), now: at(3) }), "waiting", "Original 1 on its due day");
  assert.equal(classifyOrderReceipt({ order: order(), books, progress: progress(), now: at(4) }), "overdue", "Original 1 past its 3 days");
  assert.equal(classifyOrderReceipt({ order: order(), books, progress: progress({ custodyEntered: true }), now: at(7) }), "waiting", "Original 2 on its due day");
  assert.equal(classifyOrderReceipt({ order: order(), books, progress: progress({ custodyEntered: true }), now: at(8) }), "overdue", "Original 2 past its 6 working days");
  assert.equal(classifyOrderReceipt({ order: order(), books, progress: progress({ custodyEntered: true, deliveryEntered: true }), now: at(30) }), "has_receipt", "both originals in");
  assert.equal(
    classifyOrderReceipt({ order: order(), books, progress: progress({ custodyEntered: true, exitDate: null }), now: at(30) }),
    "awaiting_exit",
    "Original 1 alone is not the receipt: the order still owes Original 2",
  );
  assert.equal(
    classifyOrderReceipt({ order: order({ decidedAt: "2026-11-20T09:00:00.000Z" }), books, progress: none, now: NOW }),
    "not_required",
    "an order approved before the manager received his book never owes a receipt",
  );
  assert.equal(
    bookHeldAtApproval(order(), [book({ status: "returned", closedAt: "2026-12-05T00:00:00.000Z" })]),
    null,
    "a book returned before the approval does not count",
  );
  assert.equal(classifyOrderReceipt({ order: order({ status: "rejected" }), books, progress: none, now: NOW }), "not_required");

  // No book (owner, 27 Nov 2026: "Flag them"): after the first book went out, an order raised by
  // someone holding none is flagged — never silently excused.
  const stranger = order({ requesterHrId: "NS-0001", decidedAt: "2026-12-12T09:00:00.000Z" });
  assert.equal(classifyOrderReceipt({ order: stranger, books, progress: none, now: NOW }), "no_book", "a no-book order after the rollout is flagged");
  assert.equal(
    classifyOrderReceipt({ order: stranger, books, progress: progress({ custodyEntered: true, deliveryEntered: true }), now: NOW }),
    "has_receipt",
    "a book handed over later can still prove it",
  );
  assert.equal(
    classifyOrderReceipt({ order: stranger, books, progress: progress({ custodyEntered: true }), now: NOW }),
    "overdue",
    "once Original 1 is in, the order is held to its due dates like any other",
  );
  assert.equal(
    classifyOrderReceipt({ order: order({ requesterHrId: "NS-0001", decidedAt: "2026-11-20T09:00:00.000Z" }), books, progress: none, now: NOW }),
    "not_required",
    "nothing approved before the first book went out is flagged",
  );
  assert.equal(
    classifyOrderReceipt({ order: stranger, books: [book({ status: "in_store", holderHrId: null, issuedAt: null })], progress: none, now: NOW }),
    "not_required",
    "while every book is still in store, nothing is flagged",
  );
  assert.equal(classifyOrderReceipt({ order: order({ requesterHrId: "NS-0001", status: "rejected" }), books, progress: none, now: NOW }), "not_required");

  // Original 2: after Original 1, from the same receipt, once.
  const claimed = receipt({ state: "used", requestId: order().id });
  const delivery = (input: Partial<Parameters<typeof checkDeliveryForOrder>[0]> = {}) => {
    const decision = checkDeliveryForOrder({ order: order(), serial: 7, typedCode: "AB3K7Q", orderReceipt: claimed, deliveryEntered: false, ...input });
    return decision.ok ? "ok" : decision.reason;
  };
  assert.equal(delivery(), "ok", "the same number and code as Original 1");
  assert.equal(delivery({ orderReceipt: null }), "custody_not_entered", "Original 1 is entered first");
  assert.equal(delivery({ serial: 8 }), "other_receipt", "Original 2 carries the same number as Original 1");
  assert.equal(delivery({ typedCode: "ZZZZZZ" }), "code_mismatch", "an invented Original 2 is refused");
  assert.equal(delivery({ typedCode: "ZZZZZZ", deliveryEntered: true }), "code_mismatch", "a wrong code is refused BEFORE 'already entered' is said");
  assert.equal(delivery({ deliveryEntered: true }), "delivery_entered", "Original 2 is entered once");
  assert.equal(delivery({ order: order({ status: "cancelled" }) }), "order_not_approved");
  assert.equal(delivery({ withoutReceiptApproved: true }), "order_without_receipt");

  // The warehouse exit: an approved order, a real day, never ahead of today or behind the approval.
  assert.equal(checkWarehouseExit({ order: order(), exitDate: "2026-12-11", todayCairo: "2026-12-20" }).ok, true);
  assert.equal(checkWarehouseExit({ order: order(), exitDate: "2026-12-10", todayCairo: "2026-12-20" }).ok, true, "the approval day itself");
  assert.equal(checkWarehouseExit({ order: order(), exitDate: "2026-12-09", todayCairo: "2026-12-20" }).ok, false, "never before the approval");
  assert.equal(checkWarehouseExit({ order: order(), exitDate: "2026-12-21", todayCairo: "2026-12-20" }).ok, false, "never a day that has not come");
  assert.equal(checkWarehouseExit({ order: order(), exitDate: null, todayCairo: "2026-12-20" }).ok, false);
  assert.equal(checkWarehouseExit({ order: order({ status: "pending_approval" }), exitDate: "2026-12-11", todayCairo: "2026-12-20" }).ok, false, "only an approved order leaves");
  assert.equal(
    receiptRolloutStart([book({ issuedAt: "2026-12-03T00:00:00.000Z" }), book({ bookNo: 2, issuedAt: "2026-12-01T08:00:00.000Z" })]),
    Date.parse("2026-12-01T08:00:00.000Z"),
    "the rollout starts at the earliest hand-out",
  );

  // Where a receipt is written from: the open book, else the returned book held at approval.
  const returned = book({ status: "returned", closedAt: "2026-12-15T00:00:00.000Z" });
  assert.equal(receiptEntryBookFor(order(), [returned])?.bookNo, 1, "late entry offers the returned book");
  assert.equal(receiptEntryBookFor(order(), [book({ status: "lost", closedAt: "2026-12-15T00:00:00.000Z" })]), null, "never a lost book");
  assert.equal(
    receiptEntryBookFor(order(), [returned, book({ bookNo: 15, firstSerial: 701, lastSerial: 750, printedHolderHrId: null, issuedAt: "2026-12-16T00:00:00.000Z" })])?.bookNo,
    15,
    "the open book comes first",
  );

  // The undo (owner, 27 Nov 2026: "make an undo option").
  const usedOnA = receipt({ state: "used", requestId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(checkReceiptRelease({ receipt: usedOnA, requestId: "11111111-1111-4111-8111-111111111111", reason: "entered on the wrong order" }).ok, true);
  assert.equal(checkReceiptRelease({ receipt: usedOnA, requestId: "11111111-1111-4111-8111-111111111111", reason: " " }).ok, false, "an undo always says why");
  assert.equal(checkReceiptRelease({ receipt: usedOnA, requestId: "22222222-2222-4222-8222-222222222222", reason: "wrong order" }).ok, false, "only the receipt on THIS order");
  assert.equal(checkReceiptRelease({ receipt: receipt(), requestId: "11111111-1111-4111-8111-111111111111", reason: "wrong order" }).ok, false, "an unused receipt has nothing to undo");

  // Custody.
  assert.equal(checkBookIssue(book({ status: "in_store", holderHrId: null, issuedAt: null }), "AI-0001").ok, true);
  assert.equal(
    checkBookIssue(book({ status: "in_store", holderHrId: null, issuedAt: null }), "PD-0012").ok,
    false,
    "a book with a manager's name printed on every page is issued only to that manager",
  );
  assert.equal(checkBookIssue(book({ status: "in_store", printedHolderHrId: null, holderHrId: null, issuedAt: null }), "PD-0012").ok, true, "a spare goes to anyone");
  assert.equal(checkBookIssue(book({ status: "returned", closedAt: "x" }), "AI-0001").ok, false, "a returned book is never reissued");
  assert.equal(checkReceiptVoid(receipt({ state: "used", requestId: "x" }), "spoiled").ok, false, "a receipt that proves an order is never cancelled");
  assert.equal(checkReceiptVoid(receipt(), "").ok, false, "a cancellation says why");

  // Without a receipt: the CEO's approval alone (owner, 27 Nov 2026).
  const approvedAsk: NoReceiptRow = {
    id: "ask-1",
    requestId: "11111111-1111-4111-8111-111111111111",
    reason: "the venue refused to stamp",
    askedByHrId: "B-185",
    askedAt: "2026-12-12T09:00:00.000Z",
    status: "approved",
    decidedByHrId: "CEO-1",
    decidedAt: "2026-12-13T09:00:00.000Z",
    decisionNote: null,
  };
  const pendingAsk: NoReceiptRow = { ...approvedAsk, status: "pending", decidedByHrId: null, decidedAt: null };
  assert.equal(
    classifyOrderReceipt({ order: order(), books: [book()], progress: progress(), now: NOW, withoutReceiptApproved: true }),
    "without_receipt",
    "an order the CEO approved without a receipt is never flagged overdue",
  );
  assert.equal(
    classifyOrderReceipt({ order: order(), books: [book()], progress: progress({ custodyEntered: true, deliveryEntered: true }), now: NOW, withoutReceiptApproved: true }),
    "has_receipt",
    "a receipt still counts first",
  );
  assert.equal(reasonOf(check({ withoutReceiptApproved: true })), "order_without_receipt", "no receipt is entered on an order approved to stand without one");
  assert.equal(checkNoReceiptAsk({ standing: "overdue", live: null, reason: "the venue refused to stamp" }).ok, true);
  assert.equal(checkNoReceiptAsk({ standing: "no_book", live: null, reason: "raised with no book" }).ok, true, "a no-book order may be asked too");
  assert.equal(checkNoReceiptAsk({ standing: "overdue", live: null, reason: "  " }).ok, false, "an ask always says why");
  assert.equal(checkNoReceiptAsk({ standing: "has_receipt", live: null, reason: "x x x" }).ok, false, "an order with a receipt needs no ask");
  assert.equal(checkNoReceiptAsk({ standing: "not_required", live: null, reason: "x x x" }).ok, false, "a reversal or rejection owes nothing");
  assert.equal(checkNoReceiptAsk({ standing: "overdue", live: pendingAsk, reason: "again" }).ok, false, "one ask waits at a time");
  assert.equal(checkNoReceiptAsk({ standing: "without_receipt", live: approvedAsk, reason: "again" }).ok, false, "an approved order is not asked again");
  assert.equal(checkNoReceiptDecision({ live: pendingAsk, hasReceipt: false, decision: "approve", note: "" }).ok, true, "approving needs no note");
  assert.equal(checkNoReceiptDecision({ live: pendingAsk, hasReceipt: false, decision: "refuse", note: "" }).ok, false, "a refusal always says why");
  assert.equal(checkNoReceiptDecision({ live: pendingAsk, hasReceipt: true, decision: "approve", note: "" }).ok, false, "a receipt entered meanwhile makes the approval unnecessary");
  assert.equal(checkNoReceiptDecision({ live: pendingAsk, hasReceipt: true, decision: "refuse", note: "has a receipt now" }).ok, true, "but it can still be refused");
  assert.equal(checkNoReceiptDecision({ live: approvedAsk, hasReceipt: false, decision: "refuse", note: "changed my mind" }).ok, false, "a decided ask never changes");
  assert.equal(checkNoReceiptDecision({ live: null, hasReceipt: false, decision: "approve", note: "" }).ok, false, "nothing to decide");
  assert.equal(checkNoReceiptDecision({ live: pendingAsk, hasReceipt: false, decision: "maybe", note: "x x x" }).ok, false, "approve or refuse only");
}

// ─── Behaviour, through the shared PostgREST stand-in ────────────────────────

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";
const ORDER_C = "44444444-4444-4444-8444-444444444444";
const ORDER_D = "55555555-5555-4555-8555-555555555555";
const ORDER_USED = "33333333-3333-4333-8333-333333333333";
const PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64")}`;

const MOMEN = createAccessContext({ hrId: "AI-0001", loginId: "momen", role: "District Manager", source: "session" });
const STRANGER = createAccessContext({ hrId: "PD-0012", loginId: "eleiwa", role: "District Manager", source: "session" });
const ADMIN = createAccessContext({ hrId: "B-10", loginId: "owner", role: "Super Admin", source: "session" });
const CEO = createAccessContext({ hrId: "CEO-1", loginId: "anwar", role: "CEO", source: "session" });

function tables(): Record<string, Row[]> {
  return {
    direct_order_receipt_books: [
      { book_no: 1, first_serial: 1, last_serial: 50, printed_holder_hr_id: "AI-0001", holder_hr_id: "AI-0001", status: "issued", issued_at: "2026-12-01T08:00:00.000Z", closed_at: null },
      { book_no: 2, first_serial: 51, last_serial: 100, printed_holder_hr_id: "PD-0012", holder_hr_id: null, status: "in_store", issued_at: null, closed_at: null },
    ],
    direct_order_receipts: [
      { serial: 7, book_no: 1, check_code: "AB3K7Q", state: "unused", request_id: null, voided_reason: null },
      { serial: 8, book_no: 1, check_code: "C9D2EF", state: "unused", request_id: null, voided_reason: null },
      { serial: 9, book_no: 1, check_code: "HJ4MN5", state: "used", request_id: ORDER_USED, voided_reason: null, photo_storage_path: "receipts/x/000009.jpg", used_by_hr_id: "AI-0001", used_at: "2026-12-09T10:00:00.000Z" },
    ],
    direct_order_requests: [
      { id: ORDER_A, requester_hr_id: "AI-0001", status: "approved", decided_at: "2026-12-10T09:00:00.000Z", reversal_of_request_id: null, pharmacy_id: "ph-1", product_name: "Sato 500", sales_value: 1200 },
      { id: ORDER_B, requester_hr_id: "AI-0001", status: "approved", decided_at: "2026-12-11T09:00:00.000Z", reversal_of_request_id: null, pharmacy_id: "ph-1", product_name: "Sato 500", sales_value: 800 },
      // Raised by the National Sales Manager, who holds no book: after the rollout, and before it.
      { id: ORDER_C, requester_hr_id: "NS-0001", status: "approved", decided_at: "2026-12-12T09:00:00.000Z", reversal_of_request_id: null, pharmacy_id: "ph-2", product_name: "Sato 250", sales_value: 500 },
      { id: ORDER_D, requester_hr_id: "NS-0001", status: "approved", decided_at: "2026-11-20T09:00:00.000Z", reversal_of_request_id: null, pharmacy_id: "ph-2", product_name: "Sato 250", sales_value: 400 },
    ],
    direct_order_pharmacies: [
      { id: "ph-1", pharmacy_name: "El Shifa Pharmacy" },
      { id: "ph-2", pharmacy_name: "El Nour Pharmacy" },
    ],
    direct_order_receipt_releases: [],
    direct_order_warehouse_exits: [],
    direct_order_no_receipt_requests: [],
    direct_order_events: [],
    audit_logs: [],
    employees: [],
  };
}

/** The two database functions, as the migration writes them: one transaction each. */
function databaseFunctions(): StandIn["rpc"] {
  return {
    direct_order_close_receipt_book: (args, standIn) => {
      const books = standIn.tables.direct_order_receipt_books;
      const target = books.find((b) => b.book_no === args.p_book_no && b.status === args.p_expected_status);
      if (!target) return { closed: false };
      const now = "2026-12-20T10:00:00.000Z";
      Object.assign(target, { status: args.p_kind, closed_at: now, note: args.p_note });
      let voided = 0;
      if (args.p_kind === "lost") {
        for (const r of standIn.tables.direct_order_receipts) {
          if (r.book_no === args.p_book_no && r.state === "unused") {
            Object.assign(r, { state: "voided", voided_reason: `Book ${args.p_book_no} reported lost` });
            voided += 1;
          }
        }
      }
      return { closed: true, closed_at: now, voided };
    },
    direct_order_release_receipt: (args, standIn) => {
      const r = standIn.tables.direct_order_receipts.find((row) => row.serial === args.p_serial);
      if (!r || r.state !== "used" || r.request_id !== args.p_request_id) return { released: false };
      standIn.tables.direct_order_receipt_releases.push({ serial: r.serial, request_id: r.request_id, reason: args.p_reason, released_by_hr_id: args.p_actor_hr_id });
      const before = { ...r };
      Object.assign(r, {
        state: "unused", request_id: null, photo_storage_path: null, used_by_hr_id: null, used_at: null,
        delivery_photo_storage_path: null, delivery_photo_content_type: null, delivery_entered_by_hr_id: null, delivery_entered_at: null,
      });
      return {
        released: true, serial: before.serial, book_no: before.book_no, photo_storage_path: before.photo_storage_path,
        delivery_photo_storage_path: before.delivery_photo_storage_path ?? null, used_by_hr_id: before.used_by_hr_id, used_at: before.used_at,
      };
    },
  };
}

/** The stand-in stores no files; a receipt photo upload is answered as stored so the claim runs. */
async function withStoredUploads(body: () => Promise<void>) {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.startsWith("/storage/v1/object/")) {
      return new Response(JSON.stringify({ Key: url.pathname, Id: "stored" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return inner(input, init);
  }) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = inner;
  }
}

async function rejectsWith(promise: Promise<unknown>, pattern: RegExp, label: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.match(String((error as Error)?.message ?? error), pattern, label);
    return true;
  });
}

async function behaviourTests() {
  // 1. The requester enters his own receipt: ONE claim, filtered on state = unused and no order yet.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async (seen) => {
      await withStoredUploads(async () => {
        const result = await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "000007", code: "ab3k7q", photoDataUrl: PHOTO });
        assert.equal(result.serialLabel, "000007");
      });
      const claims = writesTo(seen, "direct_order_receipts");
      assert.equal(claims.length, 1, "exactly one write claims the receipt");
      assert.equal(claims[0].params.get("state"), "eq.unused", "the claim is a compare-and-set on an unused receipt");
      assert.equal(claims[0].params.get("request_id"), "is.null", "and on a receipt no order holds yet");
      const row = standIn.tables.direct_order_receipts.find((r) => r.serial === 7);
      assert.equal(row?.state, "used");
      assert.equal(row?.request_id, ORDER_A);

      // 2. The same paper on a second order is refused, and nothing is written to the receipts.
      await withStoredUploads(async () => {
        await rejectsWith(
          recordDirectOrderReceipt(MOMEN, { requestId: ORDER_B, serial: "7", code: "AB3K7Q", photoDataUrl: PHOTO }),
          /already used on another order/,
          "one paper never proves two orders",
        );
      });
      assert.equal(writesTo(seen, "direct_order_receipts").length, 1, "the refused second use wrote nothing");
    });
  }

  // 3. An invented page: wrong code, nothing claimed, and the attempt is written on the order.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async (seen) => {
      await rejectsWith(
        recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "8", code: "ZZZZZZ", photoDataUrl: PHOTO }),
        /code does not match/,
        "a code that is not the printed one is refused",
      );
      assert.equal(writesTo(seen, "direct_order_receipts").length, 0, "an invented page claims nothing");
      const events = standIn.tables.direct_order_events;
      assert.equal(events.length, 1, "every refusal is written on the order");
      assert.equal((events[0].metadata as { reason?: string }).reason, "code_mismatch");
    });
  }

  // 4. Someone who neither raised the order nor is Finance cannot enter its receipt.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async (seen) => {
      await rejectsWith(
        recordDirectOrderReceipt(STRANGER, { requestId: ORDER_A, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO }),
        /Only the manager who raised this order, or Finance/,
        "a stranger is refused",
      );
      assert.equal(writesTo(seen, "direct_order_receipts").length, 0);
    });
  }

  // 5. Custody: a pre-printed book only to its name; lost cancels only the unused receipts — in ONE call.
  {
    const standIn: StandIn = { tables: tables(), rpc: databaseFunctions() };
    await withPostgrestStandIn(standIn, async (seen) => {
      await rejectsWith(issueDirectOrderReceiptBook(ADMIN, { bookNo: 2, holderHrId: "AI-0001" }), /another manager's name printed/, "book 2 carries Mohamed Eleiwa's name");
      await rejectsWith(issueDirectOrderReceiptBook(MOMEN, { bookNo: 2, holderHrId: "PD-0012" }), /Only Finance/, "a District Manager cannot hand out books");
      await closeDirectOrderReceiptBook(ADMIN, { bookNo: 1, kind: "lost", note: "left in a taxi" });
      const byserial = new Map(standIn.tables.direct_order_receipts.map((r) => [r.serial, r.state]));
      assert.equal(byserial.get(7), "voided", "an unused receipt in a lost book is cancelled");
      assert.equal(byserial.get(9), "used", "a used receipt still proves its order after the book is lost");
      assert.equal(standIn.tables.direct_order_receipt_books.find((b) => b.book_no === 1)?.status, "lost");
      const calls = seen.filter((entry) => entry.rpc === "direct_order_close_receipt_book");
      assert.equal(calls.length, 1, "the book and its receipts are closed in one database call");
      assert.equal(writesTo(seen, "direct_order_receipt_books").length + writesTo(seen, "direct_order_receipts").length, 0, "never as two separate writes");
      assert.equal((calls[0].body as { p_expected_status?: string }).p_expected_status, "issued", "the close is a compare-and-set on the status read");
    });
  }

  // 6. A spare still in store can be recorded lost (the old database check refused it).
  {
    const standIn: StandIn = { tables: tables(), rpc: databaseFunctions() };
    await withPostgrestStandIn(standIn, async (seen) => {
      await closeDirectOrderReceiptBook(ADMIN, { bookNo: 2, kind: "lost", note: "stolen from the store" });
      const call = seen.find((entry) => entry.rpc === "direct_order_close_receipt_book");
      assert.equal((call?.body as { p_expected_status?: string }).p_expected_status, "in_store");
      assert.equal(standIn.tables.direct_order_receipt_books.find((b) => b.book_no === 2)?.status, "lost");
    });
  }

  // 7. A hand-out names a person still at work, never a typed id that matches nobody.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async () => {
      await rejectsWith(issueDirectOrderReceiptBook(ADMIN, { bookNo: 2, holderHrId: "PD-0012" }), /not an employee still at work/, "nobody by that id");
      standIn.tables.employees.push({ hr_id: "PD-0012", full_name: "Mohamed Eleiwa", employment_status: "resigned" });
      await rejectsWith(issueDirectOrderReceiptBook(ADMIN, { bookNo: 2, holderHrId: "PD-0012" }), /not an employee still at work/, "a leaver never receives a book");
      standIn.tables.employees[0].employment_status = "active";
      await issueDirectOrderReceiptBook(ADMIN, { bookNo: 2, holderHrId: "PD-0012" });
      assert.equal(standIn.tables.direct_order_receipt_books.find((b) => b.book_no === 2)?.status, "issued");
    });
  }

  // 8. Every refused attempt is written on the order, never with the typed code.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async () => {
      await rejectsWith(recordDirectOrderReceipt(STRANGER, { requestId: ORDER_A, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO }), /Only the manager/, "stranger");
      await rejectsWith(recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "12a", code: "C9D2EF", photoDataUrl: PHOTO }), /six digits/, "bad serial");
      await rejectsWith(recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "8", code: "C9D2", photoDataUrl: PHOTO }), /six-character code/, "bad code");
      await rejectsWith(recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "8", code: "C9D2EF", photoDataUrl: "not a photo" }), /clear photo/, "bad photo");
      const reasons = standIn.tables.direct_order_events.map((e) => (e.metadata as { reason?: string }).reason);
      assert.deepEqual(reasons, ["not_allowed", "bad_serial", "bad_code", "bad_photo"], "each refusal is on the order's history");
      assert.equal(JSON.stringify(standIn.tables.direct_order_events).includes("C9D2EF"), false, "the typed code is never written down");
    });
  }

  // 9. The database guard refuses the claim (the book was lost while the photo uploaded): said, logged, nothing saved.
  {
    const standIn: StandIn = {
      tables: tables(),
      failWrites: {
        direct_order_receipts: { status: 400, body: { code: "P0001", message: "Receipt book 1 is lost, so none of its receipts can be used." } },
      },
    };
    await withPostgrestStandIn(standIn, async () => {
      await withStoredUploads(async () => {
        await rejectsWith(
          recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO }),
          /while the photo was uploading/,
          "a book closed mid-upload is said in plain words",
        );
      });
      assert.equal(standIn.tables.direct_order_receipts.find((r) => r.serial === 8)?.state, "unused");
      assert.equal((standIn.tables.direct_order_events.at(-1)?.metadata as { reason?: string }).reason, "book_changed");
    });
  }

  // 10. The undo: Finance only, with a reason, in one database call; the paper is free for the right order.
  {
    const standIn: StandIn = { tables: tables(), rpc: databaseFunctions() };
    standIn.tables.direct_order_requests.push({ id: ORDER_USED, requester_hr_id: "AI-0001", status: "approved", decided_at: "2026-12-09T09:00:00.000Z", reversal_of_request_id: null });
    await withPostgrestStandIn(standIn, async (seen) => {
      await rejectsWith(releaseDirectOrderReceipt(MOMEN, { requestId: ORDER_USED, reason: "wrong order" }), /Only Finance/, "the manager cannot undo his own entry");
      await rejectsWith(releaseDirectOrderReceipt(ADMIN, { requestId: ORDER_USED, reason: "" }), /Write why/, "an undo always says why");
      await rejectsWith(releaseDirectOrderReceipt(ADMIN, { requestId: ORDER_A, reason: "wrong order" }), /no receipt to undo/, "an order with no receipt");
      assert.equal(seen.filter((e) => e.rpc === "direct_order_release_receipt").length, 0, "a refused undo calls nothing");
      await releaseDirectOrderReceipt(ADMIN, { requestId: ORDER_USED, reason: "entered on the wrong order" });
      const calls = seen.filter((e) => e.rpc === "direct_order_release_receipt");
      assert.equal(calls.length, 1, "one database call releases and records");
      assert.equal(writesTo(seen, "direct_order_receipts").length, 0, "never a plain update of the receipt");
      assert.equal(standIn.tables.direct_order_receipts.find((r) => r.serial === 9)?.state, "unused", "the paper is free for the right order");
      assert.equal(standIn.tables.direct_order_receipt_releases.length, 1, "the release is kept");
      const event = standIn.tables.direct_order_events.find((e) => e.event_type === "receipt_released");
      assert.ok(event, "the undo is on the order's history");
      await withStoredUploads(async () => {
        await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_B, serial: "9", code: "HJ4MN5", photoDataUrl: PHOTO });
      });
      assert.equal(standIn.tables.direct_order_receipts.find((r) => r.serial === 9)?.request_id, ORDER_B, "and it proves the right order");
    });
  }

  // 11. Finance's desk: a no-book order after the rollout is flagged; the book shows what still owes.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async () => {
      const register = await loadDirectOrderReceiptRegister(ADMIN);
      assert.deepEqual(register.noBook.map((o) => o.requestId), [ORDER_C], "flagged after the rollout, never before it");
      assert.equal(register.noBook[0].pharmacyName, "El Nour Pharmacy");
      assert.deepEqual(register.awaitingExit.map((o) => o.requestId).sort(), [ORDER_A, ORDER_B].sort(), "no exit recorded: they wait for Finance");
      assert.deepEqual(register.missing, [], "and nothing is due yet");
      assert.equal(register.books.find((b) => b.bookNo === 1)?.owing, 2, "the book row says how many orders still owe a receipt from it");
      await rejectsWith(loadDirectOrderReceiptRegister(MOMEN), /Finance's/, "the desk is Finance's");
    });
  }

  // 12b. Without a receipt: Finance asks, the CEO ALONE decides, and the approved order leaves the lists.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async () => {
      const asks = standIn.tables.direct_order_no_receipt_requests;
      await rejectsWith(askDirectOrderWithoutReceipt(MOMEN, { requestId: ORDER_A, reason: "the venue refused" }), /Only Finance/, "the manager cannot ask for himself");
      await rejectsWith(askDirectOrderWithoutReceipt(ADMIN, { requestId: ORDER_A, reason: " " }), /Write why/, "an ask always says why");
      assert.equal(asks.length, 0, "a refused ask writes nothing");
      await askDirectOrderWithoutReceipt(ADMIN, { requestId: ORDER_A, reason: "the venue refused to stamp the page" });
      assert.equal(asks.length, 1, "the ask is one row");
      assert.equal(asks[0].request_id, ORDER_A);
      assert.equal(asks[0].asked_by_hr_id, "B-10");
      // The database's own defaults, which the stand-in does not apply.
      Object.assign(asks[0], { id: "ask-1", status: "pending", asked_at: "2026-12-19T09:00:00.000Z", decided_by_hr_id: null, decided_at: null, decision_note: null });

      const waiting = await loadDirectOrderReceiptRegister(ADMIN);
      assert.deepEqual(waiting.awaitingExit.map((o) => o.requestId).sort(), [ORDER_A, ORDER_B].sort(), "a waiting ask still owes its receipt");
      assert.deepEqual(waiting.withoutReceipt.map((o) => [o.requestId, o.status]), [[ORDER_A, "pending"]], "Finance sees the ask waiting");
      await rejectsWith(askDirectOrderWithoutReceipt(ADMIN, { requestId: ORDER_A, reason: "asking twice" }), /already waiting/, "one ask waits at a time");

      // Only the CEO: the Super Admin has no override on this decision.
      await rejectsWith(decideDirectOrderWithoutReceipt(ADMIN, { requestId: ORDER_A, decision: "approve", note: "" }), /Only the CEO/, "the Super Admin cannot decide it");
      await rejectsWith(decideDirectOrderWithoutReceipt(MOMEN, { requestId: ORDER_A, decision: "approve", note: "" }), /Only the CEO/, "nor the manager");
      assert.equal(await countDirectOrderWithoutReceiptToDecide(ADMIN), 0, "the badge counts nothing for the Super Admin");
      assert.equal(await countDirectOrderWithoutReceiptToDecide(CEO), 1, "the CEO's badge counts the ask");
      const toDecide = await listDirectOrderWithoutReceiptToDecide(CEO);
      assert.deepEqual(toDecide.map((row) => [row.requestId, row.pharmacyName, row.reason]), [[ORDER_A, "El Shifa Pharmacy", "the venue refused to stamp the page"]]);
      assert.deepEqual(await listDirectOrderWithoutReceiptToDecide(ADMIN), [], "nobody else has it in Needs action");

      await rejectsWith(decideDirectOrderWithoutReceipt(CEO, { requestId: ORDER_A, decision: "refuse", note: "" }), /Write why/, "a refusal says why");
      await decideDirectOrderWithoutReceipt(CEO, { requestId: ORDER_A, decision: "approve", note: "" });
      assert.equal(asks[0].status, "approved");
      assert.equal(asks[0].decided_by_hr_id, "CEO-1", "the decision is the CEO's own");
      const eventTypes = standIn.tables.direct_order_events.map((e) => e.event_type);
      assert.deepEqual(eventTypes, ["receipt_waiver_asked", "receipt_waiver_approved"], "both are on the order's history");

      const after = await loadDirectOrderReceiptRegister(ADMIN);
      assert.deepEqual(after.awaitingExit.map((o) => o.requestId), [ORDER_B], "the approved order leaves the missing-receipt lists");
      assert.equal(after.books.find((b) => b.bookNo === 1)?.owing, 1, "and the book no longer counts it as owing");
      assert.deepEqual(after.withoutReceipt.map((o) => [o.requestId, o.status, o.waiverDecidedAt]), [[ORDER_A, "approved", asks[0].decided_at]]);
      await withStoredUploads(async () => {
        await rejectsWith(
          recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO }),
          /approved this order to stand without a receipt/,
          "no receipt is entered on it afterwards",
        );
      });
      assert.equal(standIn.tables.direct_order_receipts.find((r) => r.serial === 8)?.state, "unused", "the page stays free");

      const panel = await loadDirectOrderReceiptPanel(ADMIN, ORDER_A);
      assert.ok(panel && !("unavailable" in panel));
      assert.equal(panel.standing, "without_receipt");
      assert.equal(panel.entryBook, null, "the panel offers no entry form");
      assert.equal(panel.mayAskWithoutReceipt, false, "nor a second ask");
      assert.equal(panel.withoutReceipt?.status, "approved");
    });
  }

  // 13. Two originals (owner, 27 Nov 2026): Finance records the exit, Original 1 then Original 2, the
  //     late hold counts from the exit, and the verified print shows both.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async (seen) => {
      const exits = standIn.tables.direct_order_warehouse_exits;
      await rejectsWith(recordDirectOrderWarehouseExit(MOMEN, { requestId: ORDER_A, exitDate: "2026-12-10", now: NOW }), /Only Finance/, "the manager never records the exit");
      await rejectsWith(recordDirectOrderWarehouseExit(ADMIN, { requestId: ORDER_A, exitDate: "2026-12-09", now: NOW }), /before the order was approved/, "never before the approval");
      await rejectsWith(recordDirectOrderWarehouseExit(ADMIN, { requestId: ORDER_A, exitDate: "2026-12-21", now: NOW }), /has not come yet/, "never a day ahead");
      assert.equal(exits.length, 0, "a refused exit writes nothing");

      // Nothing is late before the exit, however long ago the approval was.
      assert.deepEqual(await listLateReceiptsForRequester("AI-0001", NOW), [], "no exit recorded: the manager is not held");

      await recordDirectOrderWarehouseExit(ADMIN, { requestId: ORDER_A, exitDate: "2026-12-10", now: NOW });
      assert.equal(exits.length, 1);
      assert.equal(exits[0].exit_date, "2026-12-10");
      assert.equal(exits[0].recorded_by_hr_id, "B-10");
      const late = await listLateReceiptsForRequester("AI-0001", NOW);
      assert.deepEqual(late.map((row) => [row.requestId, row.original, row.days]), [[ORDER_A, "custody", 7]], "Original 1 due 13 Dec, read on 20 Dec: 7 days late");

      // Original 2 cannot come first.
      await withStoredUploads(async () => {
        await rejectsWith(
          recordDirectOrderDelivery(MOMEN, { requestId: ORDER_A, serial: "7", code: "AB3K7Q", photoDataUrl: PHOTO }),
          /Enter Original 1/,
          "Original 2 waits for Original 1",
        );
        await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "7", code: "AB3K7Q", photoDataUrl: PHOTO });
      });
      const afterCustody = await listLateReceiptsForRequester("AI-0001", NOW);
      assert.deepEqual(afterCustody.map((row) => [row.original, row.days]), [["delivery", 3]], "now Original 2 — due 17 Dec — is the late one");

      const panel = await loadDirectOrderReceiptPanel(MOMEN, ORDER_A);
      assert.ok(panel && !("unavailable" in panel));
      assert.equal(panel.mayEnterDelivery, true, "the manager is offered Original 2");
      assert.equal(panel.entryBook, null, "and no second Original 1");
      assert.equal(panel.mayRecordExit, false, "the exit is Finance's");
      assert.equal(panel.mayPrint, false, "the verified print is Finance's");
      assert.deepEqual(panel.exit && [panel.exit.date, panel.exit.custodyDue, panel.exit.deliveryDue], ["2026-12-10", "2026-12-13", "2026-12-17"]);

      await withStoredUploads(async () => {
        await rejectsWith(
          recordDirectOrderDelivery(MOMEN, { requestId: ORDER_A, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO }),
          /same number as Original 1/,
          "Original 2 from another receipt is refused",
        );
        await rejectsWith(
          recordDirectOrderDelivery(MOMEN, { requestId: ORDER_A, serial: "7", code: "ZZZZZZ", photoDataUrl: PHOTO }),
          /code does not match/,
          "an invented Original 2 is refused",
        );
        await rejectsWith(
          recordDirectOrderDelivery(STRANGER, { requestId: ORDER_A, serial: "7", code: "AB3K7Q", photoDataUrl: PHOTO }),
          /Only the manager who raised this order, or Finance/,
          "a stranger is refused",
        );
        const before = writesTo(seen, "direct_order_receipts").length;
        await recordDirectOrderDelivery(MOMEN, { requestId: ORDER_A, serial: "000007", code: "ab3k7q", photoDataUrl: PHOTO });
        const writes = writesTo(seen, "direct_order_receipts").slice(before);
        assert.equal(writes.length, 1, "one write adds Original 2");
        assert.equal(writes[0].params.get("request_id"), `eq.${ORDER_A}`, "only while the receipt is still on this order");
        assert.equal(writes[0].params.get("delivery_photo_storage_path"), "is.null", "and only while Original 2 is empty");
        await rejectsWith(
          recordDirectOrderDelivery(MOMEN, { requestId: ORDER_A, serial: "7", code: "AB3K7Q", photoDataUrl: PHOTO }),
          /already entered/,
          "Original 2 is entered once",
        );
      });
      const row = standIn.tables.direct_order_receipts.find((r) => r.serial === 7);
      assert.equal(row?.delivery_entered_by_hr_id, "AI-0001");
      assert.ok(String(row?.delivery_photo_storage_path).includes("-delivery-"), "Original 2 is its own photo");
      assert.ok(String(row?.photo_storage_path).includes("-custody-"), "beside Original 1's");
      assert.deepEqual(await listLateReceiptsForRequester("AI-0001", NOW), [], "both originals in: the manager is free");

      const register = await loadDirectOrderReceiptRegister(ADMIN);
      assert.deepEqual(register.awaitingExit.map((o) => o.requestId), [ORDER_B], "ORDER_A has its receipt; ORDER_B still waits for its exit");
      assert.deepEqual(register.missing, []);
      assert.equal(register.recent.find((e) => e.serialLabel === "000007")?.deliveryEntered, true);

      const print = await loadDirectOrderReceiptPrint(ADMIN, ORDER_A);
      assert.equal(print?.serialLabel, "000007");
      assert.equal(print?.exitDate, "2026-12-10");
      assert.ok(print?.delivery, "the print carries Original 2");
      assert.equal(print?.pharmacyName, "El Shifa Pharmacy");
      await rejectsWith(loadDirectOrderReceiptPrint(MOMEN, ORDER_A), /Finance's/, "the verified print is Finance's");
      assert.equal(await loadDirectOrderReceiptPrint(ADMIN, ORDER_B), null, "no receipt, nothing to print");

      // A correction keeps the old day in the audit log.
      await recordDirectOrderWarehouseExit(ADMIN, { requestId: ORDER_B, exitDate: "2026-12-12", now: NOW });
      await recordDirectOrderWarehouseExit(ADMIN, { requestId: ORDER_B, exitDate: "2026-12-13", now: NOW });
      assert.equal(exits.filter((e) => e.request_id === ORDER_B).length, 1, "one row per order");
      assert.equal(exits.find((e) => e.request_id === ORDER_B)?.exit_date, "2026-12-13");
      const corrected = standIn.tables.direct_order_events.filter((e) => e.event_type === "warehouse_exit_recorded").at(-1);
      assert.equal((corrected?.metadata as { previousDate?: string } | undefined)?.previousDate, "2026-12-12", "the corrected day is kept on the order's history");
    });
  }

  // 12. A failed read is said, never shown as an empty desk.
  {
    const standIn: StandIn = { tables: tables(), failReads: { direct_order_pharmacies: { status: 500, body: { code: "XX000", message: "down" } } } };
    await withPostgrestStandIn(standIn, async () => {
      await assert.rejects(loadDirectOrderReceiptRegister(ADMIN), "a pharmacy-name failure is not shown as 'Pharmacy not on file'");
    });
  }
}

export async function runDirectOrderReceiptBooksTests() {
  pureTests();
  await behaviourTests();
}
