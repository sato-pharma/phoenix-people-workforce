import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  __resetReceiptWorkMemoForTests,
  askDirectOrderWithoutReceipt,
  closeDirectOrderReceiptBook,
  countDirectOrderReceiptWork,
  countDirectOrderWithoutReceiptToDecide,
  decideDirectOrderHandEntry,
  decideDirectOrderWithoutReceipt,
  issueDirectOrderReceiptBook,
  listDirectOrderWithoutReceiptToDecide,
  listLateReceiptsForRequester,
  loadDirectOrderReceiptPanel,
  loadDirectOrderReceiptPrint,
  loadDirectOrderReceiptRegister,
  loadDirectOrderReceiptScan,
  recordDirectOrderDelivery,
  recordDirectOrderReceipt,
  recordDirectOrderWarehouseExit,
  receiptReminderWords,
  releaseDirectOrderReceipt,
  sendDirectOrderReceiptReminders,
  type DirectOrderReceiptPanel,
} from "../src/lib/direct-orders/receipt-books.ts";
import { buildDirectOrderNeedsAction, receiptWorkCount } from "../src/lib/direct-orders/needs-action.ts";
import type { CreateSystemNotificationInput } from "../src/lib/notifications/system.ts";
import { canReviewDirectOrderHandEntry } from "../src/lib/direct-orders/finance-authority.ts";
import { __setReceiptQrReaderForTests, readReceiptQrTexts } from "../src/lib/direct-orders/receipt-photo-qr.ts";
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
  classifyReceiptPhotoQr,
  decideReceiptScan,
  isPhoenixCameraFrame,
  normalizeReceiptCode,
  parseDateKey,
  parseReceiptQrText,
  parseReceiptScanToken,
  parseReceiptSerial,
  receiptDueDates,
  receiptScanPath,
  receiptEntryBookFor,
  receiptLateness,
  receiptReminderFor,
  receiptRolloutStart,
  RECEIPT_CLOSED_BY_RELEASE_NOTE,
  RECEIPT_O2_CLOSED_WITH_O1_NOTE,
  RECEIPT_QR_LOCK_START,
  RECEIPT_QR_LOCK_WINDOW_MS,
  rejectionToShowManager,
  stepReceiptQrLock,
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

  // The QR on every sheet is a Phoenix link (owner, 28 Nov 2026), and the code is checked before the state.
  assert.equal(receiptScanPath(401, "TMDD9C"), "/r/000401-TMDD9C", "the link the generator prints in the QR");
  assert.deepEqual(parseReceiptScanToken("000401-tmdd9c"), { serial: 401, code: "TMDD9C" });
  assert.deepEqual(parseReceiptScanToken("000401%2DTMDD9C"), { serial: 401, code: "TMDD9C" }, "an encoded dash still reads");
  assert.equal(parseReceiptScanToken("401-TMDD9C"), null, "the serial is printed with six digits");
  assert.equal(parseReceiptScanToken("000401-TMDD9O"), null, "O is not in the printer's alphabet");
  assert.equal(parseReceiptScanToken("%E0%A4%A"), null, "a broken escape is not a receipt");
  {
    const row: ReceiptRow = { serial: 9, bookNo: 1, checkCode: "HJ4MN5", state: "used", requestId: "order-9", voidedReason: null };
    assert.deepEqual(decideReceiptScan({ serial: 9, code: "HJ4MN5" }, row), { kind: "used", serial: 9, bookNo: 1, requestId: "order-9" });
    assert.deepEqual(decideReceiptScan({ serial: 9, code: "HJ4MN6" }, row), { kind: "not_genuine" }, "a wrong code says nothing about the real page's state");
    assert.deepEqual(decideReceiptScan({ serial: 9, code: "HJ4MN5" }, null), { kind: "not_genuine" }, "no such serial");
    assert.deepEqual(decideReceiptScan(null, row), { kind: "not_genuine" });
    assert.equal(decideReceiptScan({ serial: 9, code: "HJ4MN5" }, { ...row, state: "unused", requestId: null }).kind, "unused");
    assert.deepEqual(decideReceiptScan({ serial: 9, code: "HJ4MN5" }, { ...row, state: "voided", requestId: null, voidedReason: "torn" }), { kind: "voided", serial: 9, bookNo: 1, reason: "torn" });
  }

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

/**
 * The QR in the photo decides (owner, 28 Nov 2026: Phoenix recognises the receipt "اوتوماتيك بغض النظر عن اللي
 * هم كاتبينه بايديهم"), and who reviews an original typed by hand ("المالية، وإنت لو المالية دخلته").
 */
function photoQrPureTests() {
  assert.deepEqual(parseReceiptQrText("https://phoenix-hr.satopharma.com/r/000401-TMDD9C"), { serial: 401, code: "TMDD9C" }, "the Phoenix link the sheet prints");
  assert.deepEqual(
    parseReceiptQrText(" https://phoenix-hr.satopharma.com/r/000401-tmdd9c/?from=scan "),
    { serial: 401, code: "TMDD9C" },
    "a trailing slash, a query and spaces still read",
  );
  assert.deepEqual(parseReceiptQrText("000401-TMDD9C"), { serial: 401, code: "TMDD9C" }, "the bare token");
  assert.equal(parseReceiptQrText("https://example.com/menu"), null, "a QR that is not a receipt");
  assert.equal(parseReceiptQrText("https://phoenix-hr.satopharma.com/r/401-TMDD9C"), null, "the serial is printed with six digits");
  assert.equal(parseReceiptQrText(null), null);

  const typed = { serial: 401, code: "TMDD9C" };
  assert.deepEqual(classifyReceiptPhotoQr(["https://phoenix-hr.satopharma.com/r/000401-TMDD9C"], typed), { kind: "matched" }, "the QR names the typed receipt: in at once");
  assert.deepEqual(classifyReceiptPhotoQr([], typed), { kind: "unread" }, "no QR read: a hand entry");
  assert.deepEqual(classifyReceiptPhotoQr(["https://example.com/menu"], typed), { kind: "unread" }, "a QR that is not a receipt is no read");
  assert.deepEqual(
    classifyReceiptPhotoQr(["https://phoenix-hr.satopharma.com/r/000402-MVY378"], typed),
    { kind: "other_receipt", serial: 402 },
    "another receipt is refused",
  );
  assert.deepEqual(
    classifyReceiptPhotoQr(["https://phoenix-hr.satopharma.com/r/000401-MVY378"], typed),
    { kind: "other_receipt", serial: 401 },
    "the right number with a wrong code is refused too",
  );
  assert.deepEqual(
    classifyReceiptPhotoQr(["https://phoenix-hr.satopharma.com/r/000401-TMDD9C", "https://phoenix-hr.satopharma.com/r/000402-MVY378"], typed),
    { kind: "other_receipt", serial: 402 },
    "two receipts in one photo: every receipt QR in it must be the typed one",
  );

  // THE LIVE CAMERA'S LOCK: the same receipt read twice, close together, turns the frame green. A frame that reads
  // nothing in between does not undo it — a hand-held phone at the edge of focus reads, misses and reads again.
  const A = { serial: 401, code: "TMDD9C" };
  const B = { serial: 402, code: "MVY378" };
  const once = stepReceiptQrLock(RECEIPT_QR_LOCK_START, A, 1000, null);
  assert.equal(once.kind, "reading", "one read never locks");
  const missed = stepReceiptQrLock(once.lock, null, 1250, null);
  assert.equal(missed.kind, "nothing");
  const again = stepReceiptQrLock(missed.lock, A, 1500, null);
  assert.deepEqual([again.kind, again.kind === "locked" ? again.read : null], ["locked", A], "read, miss, read: it locks");
  assert.equal(stepReceiptQrLock(once.lock, A, 1000 + RECEIPT_QR_LOCK_WINDOW_MS + 1, null).kind, "reading", "two reads too far apart start again");
  assert.equal(stepReceiptQrLock(once.lock, B, 1200, null).kind, "reading", "two different receipts never lock");
  assert.equal(stepReceiptQrLock(once.lock, { serial: 401, code: "MVY378" }, 1200, null).kind, "reading", "the same number with another code never locks");
  const wrongPage = stepReceiptQrLock(stepReceiptQrLock(RECEIPT_QR_LOCK_START, A, 1000, 401).lock, B, 1200, 401);
  assert.deepEqual([wrongPage.kind, wrongPage.kind === "wrong_receipt" ? wrongPage.serial : null], ["wrong_receipt", 402], "Original 2 of another receipt says so");
  const restarted = stepReceiptQrLock(wrongPage.lock, A, 1400, 401);
  assert.equal(restarted.kind, "reading", "and the count starts again");
  assert.equal(stepReceiptQrLock(restarted.lock, A, 1600, 401).kind, "locked", "the right page then locks");

  const manager = { scope: "self" as const, role: "District Manager" as const, hrId: "AI-0001" };
  const finance = { scope: "self" as const, role: "Finance Manager" as const, hrId: "B-185" };
  const admin = { scope: "system" as const, role: "Super Admin" as const, hrId: "B-10" };
  const byManager = { enteredByHrId: "AI-0001", enteredByFinance: false };
  const byFinance = { enteredByHrId: "B-185", enteredByFinance: true };
  const byAdmin = { enteredByHrId: "B-10", enteredByFinance: false };
  assert.equal(canReviewDirectOrderHandEntry(finance, byManager), true, "Finance reviews a manager's hand entry");
  assert.equal(canReviewDirectOrderHandEntry(admin, byManager), true, "and the Super Admin may");
  assert.equal(canReviewDirectOrderHandEntry(manager, byManager), false, "never the person who typed it");
  assert.equal(canReviewDirectOrderHandEntry(admin, byFinance), true, "Finance's own entry: the Super Admin");
  assert.equal(canReviewDirectOrderHandEntry(finance, byFinance), false, "never Finance itself");
  assert.equal(canReviewDirectOrderHandEntry({ ...finance, hrId: "b-185" }, byFinance), false, "an HR ID typed in lower case is the same person");
  assert.equal(canReviewDirectOrderHandEntry(admin, byAdmin), false, "the Super Admin never reviews his own");
  assert.equal(canReviewDirectOrderHandEntry(finance, byAdmin), true, "Finance reviews the Super Admin's");
  assert.equal(canReviewDirectOrderHandEntry({ ...manager, hrId: "PD-0012" }, byManager), false, "another manager never reviews");
}

/** The real reader, on a real QR: no stand-in. jsqr is a dependency, so CI must have it. */
/** THE REJECTION THE MANAGER IS SHOWN, with the reviewer's own reason (owner, 28 Nov 2026). */
function rejectionShownPureTests() {
  const rejected = (original: "custody" | "delivery", note: string, at: string, by = "B-185", author = "AI-0001") => ({
    serial: 8, original, status: "rejected" as const, entered_by_hr_id: author, reviewed_by_hr_id: by, reviewed_at: at, review_note: note,
  });
  const T1 = "2026-12-20T10:00:00.000Z";
  const T2 = "2026-12-20T11:00:00.000Z";
  const missing = null;
  const o1 = rejected("custody", "الكود المكتوب مش هو اللي في الصورة", T1);
  const o2Closed = rejected("delivery", RECEIPT_O2_CLOSED_WITH_O1_NOTE, T1);
  assert.equal(rejectionToShowManager([o2Closed, o1], missing), o1, "Original 1 rejected: its reason is shown, never Original 2's closing note");
  assert.equal(rejectionToShowManager([rejected("delivery", "another note", T1), o1], missing), o1, "the same instant: Original 1's decision comes first");
  assert.equal(rejectionToShowManager([o2Closed], missing), null, "a closing note alone is never a reason");
  const o2 = rejected("delivery", "The stamp on the page is not the customer's", T1);
  assert.equal(rejectionToShowManager([o2], { serial: 8, custody: "r/o1.jpg", delivery: null }), o2, "Original 2 rejected alone: its own reason");
  assert.equal(rejectionToShowManager([o2], { serial: 8, custody: "r/o1.jpg", delivery: "r/o2-again.jpg" }), null, "entered again: nothing is shown");
  assert.equal(rejectionToShowManager([o2Closed, o1], { serial: 8, custody: "r/o1-again.jpg", delivery: null }), null, "Original 1 entered again: the closing note never takes its place");
  assert.equal(rejectionToShowManager([rejected("custody", "Not saved: the original was not written to the receipt.", T1, "AI-0001")], missing), null, "an entry its own author closed is no rejection");
  const first = rejected("delivery", "first reason", T1);
  const second = rejected("custody", "second reason", T2);
  assert.equal(rejectionToShowManager([first, second], missing), second, "the newest decision, whatever was entered last");
  assert.equal(rejectionToShowManager([{ ...o1, status: "pending" as const }, { ...o1, status: "approved" as const }], missing), null, "only a rejection");
  // The code review of 28 Nov 2026: never a rejection of a receipt that is not the one on the order now.
  const o2Late = rejected("delivery", "The stamp on the page is not the customer's", T2);
  assert.equal(rejectionToShowManager([o2Late], { serial: 9, custody: "r/o1-9.jpg", delivery: null }), null, "another receipt on the order: receipt 8's Original 2 rejection is never shown");
  assert.equal(rejectionToShowManager([o2Late], missing), null, "no receipt on the order: no Original 2 rejection is shown");
  assert.equal(rejectionToShowManager([o1], { serial: 9, custody: "r/o1-9.jpg", delivery: null }), null, "another receipt entered in its place: Original 1's rejection goes");
  assert.equal(rejectionToShowManager([rejected("custody", RECEIPT_CLOSED_BY_RELEASE_NOTE, T2), o1], missing), o1, "a review closed by a release is never the reason");
  // The database writes the closing notes itself: they must be this exact text, or the filter above would miss them.
  const migration = readFileSync(new URL("../supabase/migrations/20261128152929_direct_order_receipt_hand_entry_review_fixes.sql", import.meta.url), "utf8");
  assert.ok(migration.includes(`review_note = '${RECEIPT_O2_CLOSED_WITH_O1_NOTE}'`), "the migration's closing note is RECEIPT_O2_CLOSED_WITH_O1_NOTE, word for word");
  assert.ok(migration.includes(`review_note = '${RECEIPT_CLOSED_BY_RELEASE_NOTE}'`), "a release closes a waiting review with RECEIPT_CLOSED_BY_RELEASE_NOTE, word for word");
  const decideSql = migration.slice(migration.indexOf("create or replace function public.direct_order_decide_hand_entry"));
  const receiptLock = decideSql.indexOf("from public.direct_order_receipts r where r.serial = v_serial for update");
  const entryLock = decideSql.indexOf("from public.direct_order_receipt_hand_entries e where e.id = p_entry_id for update");
  assert.ok(receiptLock > 0 && entryLock > receiptLock, "the receipt is locked before the hand entry, as everywhere else");
  assert.ok(decideSql.includes("and v_receipt.photo_storage_path = v_entry.photo_storage_path then"), "Original 1 is released only when its photo is the one on the order");
  // The notice the manager reads: the reason on its own line, never folded into a sentence, its direction from its words.
  const panel = readFileSync(new URL("../src/components/direct-orders/direct-order-receipt-panel.tsx", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.ok(
    panel.includes('<p className="whitespace-pre-wrap break-words text-phx-sm text-slate-900" dir="auto"> {rejected.note ?? "No reason was written."} </p>'),
    "the rejected-original notice shows the reviewer's reason on a line of its own",
  );
  assert.ok(panel.includes("{panel.lastRejectedHandEntry ? <RejectedHandEntryNotice rejected={panel.lastRejectedHandEntry} /> : null}"), "and the order panel draws it");
  assert.ok(panel.includes("waits for {reviewerLabel} to check the photo"), "the typed-entry form names who checks it");
}

/**
 * THE MANAGER'S REMINDERS AND FINANCE'S COUNT (owner, 28 Nov 2026: "الاتنين" — Finance sees a count on the Direct
 * Orders row, the manager is told inside Phoenix the day before an original is due and once it is late; never email).
 */
function reminderPureTests() {
  // Left Thursday 10 Dec: Original 1 due Sunday 13, Original 2 due Thursday 17 (the Friday skipped).
  const nothing: ReceiptProgress = { custodyEntered: false, deliveryEntered: false, exitDate: "2026-12-10" };
  assert.equal(receiptReminderFor({ ...nothing, exitDate: null }, "2026-12-12"), null, "before the exit nothing is due");
  assert.equal(receiptReminderFor(nothing, "2026-12-11"), null, "two days ahead: no notice yet");
  assert.deepEqual(receiptReminderFor(nothing, "2026-12-12"), { kind: "due", original: "custody", dueDate: "2026-12-13", daysToDue: 1 }, "the day before");
  assert.deepEqual(receiptReminderFor(nothing, "2026-12-13"), { kind: "due", original: "custody", dueDate: "2026-12-13", daysToDue: 0 }, "the day itself, if the day before was missed");
  assert.deepEqual(receiptReminderFor(nothing, "2026-12-14"), { kind: "late", original: "custody", dueDate: "2026-12-13", daysToDue: -1 }, "the day after: late");
  const custodyIn: ReceiptProgress = { ...nothing, custodyEntered: true };
  assert.equal(receiptReminderFor(custodyIn, "2026-12-14"), null, "Original 1 in: Original 2 is three days off");
  assert.deepEqual(receiptReminderFor(custodyIn, "2026-12-16"), { kind: "due", original: "delivery", dueDate: "2026-12-17", daysToDue: 1 }, "Original 2, the day before");
  assert.equal(receiptReminderFor({ ...custodyIn, deliveryEntered: true }, "2026-12-20"), null, "both in: nothing owed");
  assert.equal(
    receiptReminderFor(nothing, "2026-12-20")?.original,
    "custody",
    "Original 1 first: Original 2 is never spoken of while Original 1 is missing",
  );

  const late = receiptReminderWords({ kind: "late", original: "custody", dueDate: "2026-12-13", daysToDue: -1 }, "El Shifa Pharmacy");
  assert.equal(late.title, "Delivery receipt late");
  assert.match(late.message, /^Original 1, the custody page you signed, of your direct order for El Shifa Pharmacy was due on Sunday 13 December and is late./);
  assert.match(late.message, /You cannot raise a new direct order until it is entered./, "the late notice says what it holds");
  const tomorrow = receiptReminderWords({ kind: "due", original: "delivery", dueDate: "2026-12-17", daysToDue: 1 }, "");
  assert.equal(tomorrow.title, "Delivery receipt due tomorrow");
  assert.match(tomorrow.message, /^Original 2, the page the customer signed and stamped, of your direct order for a pharmacy not on file is due tomorrow, Thursday 17 December./);
  assert.equal(receiptReminderWords({ kind: "due", original: "custody", dueDate: "2026-12-13", daysToDue: 0 }, "X").title, "Delivery receipt due today");

  // The inbox group and the badge add the same number.
  const work = { handEntriesToReview: 1, lateOriginals: 2, awaitingExit: 0 };
  const groups = buildDirectOrderNeedsAction({
    awaitingMyApproval: [], myOrders: [], awaitingFinanceMonth: [], pendingCustomerValidations: 0, receiptWork: work, basePath: "/admin/direct-orders",
  });
  assert.deepEqual(groups.map((g) => [g.kind, g.count, g.seeAllHref]), [["receipt_books", 3, "/admin/direct-orders/receipts"]]);
  assert.equal(groups[0].headline, "3 delivery receipts need you: 1 typed by hand to review, 2 with an original late");
  assert.equal(receiptWorkCount(work), groups[0].count, "the badge term equals the inbox group");
  assert.deepEqual(
    buildDirectOrderNeedsAction({
      awaitingMyApproval: [], myOrders: [], awaitingFinanceMonth: [], pendingCustomerValidations: 0,
      receiptWork: { handEntriesToReview: 0, lateOriginals: 0, awaitingExit: 0 }, basePath: "/admin/direct-orders",
    }),
    [],
    "nothing waiting: no group, never a zero",
  );

  // Wired where the badge and the sweep read them.
  const badge = readFileSync(new URL("../app/api/direct-orders/needs-action-count/route.ts", import.meta.url), "utf8");
  assert.match(badge, /countDirectOrderReceiptWork\(access\)/, "the Direct Orders badge counts Finance's receipt work");
  assert.match(badge, /\+ receiptWorkCount\(receiptWork\)/, "and adds it to the one number");
  const workspace = readFileSync(new URL("../src/lib/direct-orders/workspace-data.ts", import.meta.url), "utf8");
  assert.match(workspace, /countDirectOrderReceiptWork\(access\)/, "the Needs Action inbox reads the same count");
  const sweep = readFileSync(new URL("../app/api/cron/direct-orders-expire-held/route.ts", import.meta.url), "utf8");
  assert.match(sweep, /await sendDirectOrderReceiptReminders\(\)/, "the daily sweep sends the reminders");
}

async function photoQrReaderTests() {
  try {
    await import("jsqr");
  } catch {
    if (process.env.CI) assert.fail("jsqr is a dependency of the receipt QR reader and must be installed in CI");
    console.log("  (receipt QR reader: jsqr is not installed here, so the real-QR read is skipped outside CI)");
    return;
  }
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QRCodeSVG } = await import("qrcode.react");
  const sharp = (await import("sharp")).default;
  let svg = renderToStaticMarkup(React.createElement(QRCodeSVG, { value: "https://phoenix-hr.satopharma.com/r/000401-TMDD9C", size: 400, marginSize: 4 }));
  if (!svg.includes("xmlns=")) svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  // A sheet: the QR in the corner of a wide white page, the way a phone sees it.
  const qr = await sharp(Buffer.from(svg)).resize(500).png().toBuffer();
  const page = await sharp({ create: { width: 2400, height: 3200, channels: 3, background: "#ffffff" } })
    .composite([{ input: qr, left: 1700, top: 200 }])
    .jpeg({ quality: 80 })
    .toBuffer();
  __setReceiptQrReaderForTests(null);
  const texts = await readReceiptQrTexts(new Uint8Array(page), "image/jpeg");
  assert.deepEqual(classifyReceiptPhotoQr(texts, { serial: 401, code: "TMDD9C" }), { kind: "matched" }, "the real reader finds the QR on the page");
  // A phone's photo: the sheet a third of a 3,024 x 4,032 picture, tilted, soft and compressed, so the 24 mm QR is
  // about 150 px. Read at 1,200 px wide it is too small; the reader must go on to the wider reads and find it.
  const smallQr = await sharp(qr).resize(150).rotate(7, { background: "#ffffff" }).toBuffer();
  const sheet = await sharp({ create: { width: 1000, height: 1400, channels: 3, background: "#ffffff" } })
    .composite([{ input: smallQr, left: 780, top: 60 }])
    .png()
    .toBuffer();
  const phonePhoto = await sharp({ create: { width: 3024, height: 4032, channels: 3, background: "#6b6156" } })
    .composite([{ input: sheet, left: 1000, top: 1300 }])
    .blur(0.8)
    .jpeg({ quality: 65 })
    .toBuffer();
  assert.deepEqual(
    classifyReceiptPhotoQr(await readReceiptQrTexts(new Uint8Array(phonePhoto), "image/jpeg"), { serial: 401, code: "TMDD9C" }),
    { kind: "matched" },
    "a phone's photo with a small, tilted, soft QR is still read",
  );
  assert.deepEqual(await readReceiptQrTexts(new Uint8Array(page), "application/pdf"), [], "a PDF is never read: it waits for review");
  assert.deepEqual(await readReceiptQrTexts(new Uint8Array([1, 2, 3]), "image/jpeg"), [], "a broken picture never throws: it waits for review");
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
const FINANCE = createAccessContext({ hrId: "B-185", loginId: "finance", role: "Finance Manager", source: "session" });

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
    direct_order_receipt_hand_entries: [],
    direct_order_warehouse_exits: [],
    direct_order_no_receipt_requests: [],
    direct_order_events: [],
    audit_logs: [],
    employees: [],
  };
}

/** The database functions, as the migrations write them: one transaction each. */
function databaseFunctions(): StandIn["rpc"] {
  let decisions = 0;
  const fns: NonNullable<StandIn["rpc"]> = {
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
      // 20261128152929: a review still waiting on the receipt is closed with it.
      decisions += 1;
      const closedAt = new Date(NOW.getTime() + decisions * 60_000).toISOString();
      for (const e of standIn.tables.direct_order_receipt_hand_entries) {
        if (e.serial === args.p_serial && e.request_id === args.p_request_id && e.status === "pending") {
          Object.assign(e, { status: "rejected", reviewed_by_hr_id: args.p_actor_hr_id, reviewed_at: closedAt, review_note: RECEIPT_CLOSED_BY_RELEASE_NOTE });
        }
      }
      return {
        released: true, serial: before.serial, book_no: before.book_no, photo_storage_path: before.photo_storage_path,
        delivery_photo_storage_path: before.delivery_photo_storage_path ?? null, used_by_hr_id: before.used_by_hr_id, used_at: before.used_at,
      };
    },
    // 20261128152929: the decision is written first; rejecting Original 1 releases the receipt only when its photo is
    // still the Original 1 on the order; rejecting Original 2 clears only Original 2.
    direct_order_decide_hand_entry: (args, standIn) => {
      const entry = standIn.tables.direct_order_receipt_hand_entries.find((e) => e.id === args.p_entry_id);
      if (!entry || entry.status !== "pending") return { decided: false };
      decisions += 1;
      const at = new Date(NOW.getTime() + decisions * 60_000).toISOString();
      Object.assign(entry, { status: args.p_decision, reviewed_by_hr_id: args.p_actor_hr_id, reviewed_at: at, review_note: args.p_note ?? null });
      let released = false;
      if (args.p_decision === "rejected") {
        const r = standIn.tables.direct_order_receipts.find((row) => row.serial === entry.serial);
        if (entry.original === "custody") {
          if (r && r.state === "used" && r.request_id === entry.request_id && r.photo_storage_path === entry.photo_storage_path) {
            // Original 2 goes with the receipt: a hand entry waiting on it is closed in the same instant.
            for (const other of standIn.tables.direct_order_receipt_hand_entries) {
              if (other.serial === entry.serial && other.request_id === entry.request_id && other.status === "pending" && other.id !== entry.id) {
                Object.assign(other, { status: "rejected", reviewed_by_hr_id: args.p_actor_hr_id, reviewed_at: at, review_note: RECEIPT_O2_CLOSED_WITH_O1_NOTE });
              }
            }
            const answer = fns.direct_order_release_receipt(
              { p_serial: entry.serial, p_request_id: entry.request_id, p_actor_hr_id: args.p_actor_hr_id, p_reason: `Hand-entered Original 1 rejected: ${String(args.p_note)}` },
              standIn,
            ) as { released?: boolean };
            released = Boolean(answer.released);
          }
        } else if (r && r.request_id === entry.request_id && r.delivery_photo_storage_path === entry.photo_storage_path) {
          Object.assign(r, { delivery_photo_storage_path: null, delivery_photo_content_type: null, delivery_entered_by_hr_id: null, delivery_entered_at: null });
        }
      }
      return { decided: true, serial: entry.serial, request_id: entry.request_id, original: entry.original, decision: args.p_decision, released };
    },
  };
  return fns;
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

  // 11b. A scanned QR: signed in only; the holder's name to Finance and the Administrator only.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async () => {
      const GUEST = createAccessContext({ hrId: "", loginId: "", role: "Employee", source: "session" });
      await assert.rejects(loadDirectOrderReceiptScan(GUEST, "000007-AB3K7Q"), "no sign-in, no answer");
      const unused = await loadDirectOrderReceiptScan(STRANGER, "000007-ab3k7q");
      assert.equal(unused.outcome.kind, "unused");
      assert.equal(unused.serialLabel, "000007");
      assert.equal(unused.holderName, null, "a manager is not told whose book it is");
      const used = await loadDirectOrderReceiptScan(MOMEN, "000009-HJ4MN5");
      assert.deepEqual(used.outcome, { kind: "used", serial: 9, bookNo: 1, requestId: ORDER_USED });
      const forged = await loadDirectOrderReceiptScan(ADMIN, "000009-HJ4MN6");
      assert.deepEqual(forged, { outcome: { kind: "not_genuine" }, serialLabel: null, holderName: null });
      standIn.tables.employees.push({ hr_id: "AI-0001", full_name: "Momen Test", employment_status: "active" });
      const forFinance = await loadDirectOrderReceiptScan(ADMIN, "000007-AB3K7Q");
      assert.equal(forFinance.holderName, "Momen Test", "the Administrator sees who holds the book");
    });
  }

  // 12. A failed read is said, never shown as an empty desk.
  {
    const standIn: StandIn = { tables: tables(), failReads: { direct_order_pharmacies: { status: 500, body: { code: "XX000", message: "down" } } } };
    await withPostgrestStandIn(standIn, async () => {
      await assert.rejects(loadDirectOrderReceiptRegister(ADMIN), "a pharmacy-name failure is not shown as 'Pharmacy not on file'");
    });
  }

  // 14. Finance's count and the manager's reminders (owner, 28 Nov 2026).
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async (seen) => {
      const reads = seen.length;
      assert.deepEqual(await countDirectOrderReceiptWork(MOMEN, NOW), { handEntriesToReview: 0, lateOriginals: 0, awaitingExit: 0 });
      assert.equal(seen.length, reads, "a manager's badge reads nothing");

      __resetReceiptWorkMemoForTests();
      const register = await loadDirectOrderReceiptRegister(ADMIN);
      const before = await countDirectOrderReceiptWork(FINANCE, NOW);
      assert.equal(before.awaitingExit, register.awaitingExit.length, "the count is the desk's own list");
      assert.deepEqual(before, { handEntriesToReview: 0, lateOriginals: 0, awaitingExit: 2 }, "both of the manager's orders wait for the exit");

      const notices: CreateSystemNotificationInput[] = [];
      const send = async (notice: CreateSystemNotificationInput) => { notices.push(notice); };
      assert.deepEqual(await sendDirectOrderReceiptReminders(NOW, { send }), { due: 0, late: 0 }, "no exit: nothing to remind");

      await recordDirectOrderWarehouseExit(ADMIN, { requestId: ORDER_A, exitDate: "2026-12-10", now: NOW });
      __resetReceiptWorkMemoForTests();
      assert.deepEqual(await countDirectOrderReceiptWork(FINANCE, NOW), { handEntriesToReview: 0, lateOriginals: 1, awaitingExit: 1 }, "Original 1 due 13 Dec, read on 20 Dec: late");

      assert.deepEqual(await sendDirectOrderReceiptReminders(NOW, { send }), { due: 0, late: 1 });
      assert.equal(notices.length, 1);
      const [notice] = notices;
      assert.equal(notice.recipientHrId, "AI-0001", "the manager who raised it, alone");
      assert.deepEqual(notice.channels, ["in_app"], "inside Phoenix only — never an email");
      assert.equal(notice.title, "Delivery receipt late");
      assert.match(notice.message, /El Shifa Pharmacy was due on Sunday 13 December/);
      assert.equal(notice.actionUrl, `/admin/direct-orders/${ORDER_A}`);
      assert.equal(notice.metadata?.idempotencyKey, `direct_orders:${ORDER_A}:receipt_late_reminder:custody:AI-0001`, "one key per order, original and kind: sent once");
      await sendDirectOrderReceiptReminders(NOW, { send });
      assert.equal(notices[1].metadata?.idempotencyKey, notice.metadata?.idempotencyKey, "a second run carries the same key, so the notice layer drops it");

      notices.length = 0;
      assert.deepEqual(await sendDirectOrderReceiptReminders(new Date("2026-12-12T08:00:00.000Z"), { send }), { due: 1, late: 0 });
      assert.equal(notices[0].title, "Delivery receipt due tomorrow");
      assert.match(notices[0].message, /is due tomorrow, Sunday 13 December/);
      assert.equal(notices[0].metadata?.idempotencyKey, `direct_orders:${ORDER_A}:receipt_due_reminder:custody:AI-0001`);

      // A failing notice never stops the sweep.
      assert.deepEqual(await sendDirectOrderReceiptReminders(NOW, { send: async () => { throw new Error("down"); } }), { due: 0, late: 0 });

      // Hand-typed originals: each reviewer counts only what they may review, never their own.
      standIn.tables.direct_order_receipt_hand_entries.push(
        { id: "11111111-aaaa-4aaa-8aaa-111111111111", serial: 7, request_id: ORDER_A, original: "custody", entered_by_hr_id: "AI-0001", entered_by_finance: false, status: "pending" },
        { id: "22222222-aaaa-4aaa-8aaa-222222222222", serial: 8, request_id: ORDER_B, original: "custody", entered_by_hr_id: "B-185", entered_by_finance: true, status: "pending" },
        { id: "33333333-aaaa-4aaa-8aaa-333333333333", serial: 9, request_id: ORDER_USED, original: "delivery", entered_by_hr_id: "AI-0001", entered_by_finance: false, status: "approved" },
      );
      __resetReceiptWorkMemoForTests();
      assert.equal((await countDirectOrderReceiptWork(FINANCE, NOW)).handEntriesToReview, 1, "Finance reviews the manager's, not its own");
      assert.equal((await countDirectOrderReceiptWork(ADMIN, NOW)).handEntriesToReview, 2, "the Administrator reviews both");
    });
  }
}

/**
 * CAMERA ONLY HOLDS ON THE SERVER (code review of PR 858, 28 Nov 2026). Hiding Choose file is only the screen: a
 * manager's PDF is refused, and a manager's picture Phoenix's camera did not draw — a phone or gallery photo carries
 * EXIF — never counts on its QR alone; it waits for review. Finance may attach what it holds.
 */
async function managerCameraOnlyTests() {
  const jpeg = (...rest: number[]) => ({ bytes: new Uint8Array([0xff, 0xd8, ...rest]), contentType: "image/jpeg" });
  const exif = [0xff, 0xe1, 0x00, 0x0a, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x01, 0x02, 0xff, 0xda, 9, 9];
  assert.equal(isPhoenixCameraFrame(jpeg(0xff, 0xe0, 0x00, 0x04, 1, 2, 0xff, 0xda, 9)), true, "a canvas frame: no EXIF");
  assert.equal(isPhoenixCameraFrame(jpeg(...exif)), false, "a phone or gallery photo carries EXIF");
  assert.equal(isPhoenixCameraFrame(jpeg(0xff, 0xe1, 0x00, 0x08, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0xff, 0xda)), true, "an XMP block is not EXIF");
  assert.equal(isPhoenixCameraFrame({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), contentType: "image/png" }), false, "a PNG is no camera frame");
  assert.equal(isPhoenixCameraFrame({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), contentType: "application/pdf" }), false, "a PDF is no camera frame");

  const LINK = "https://phoenix-hr.satopharma.com/r/";
  const PDF = `data:application/pdf;base64,${Buffer.from("%PDF-1.4 page").toString("base64")}`;
  const GALLERY = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, ...exif]).toString("base64")}`;
  const standIn: StandIn = { tables: tables(), rpc: databaseFunctions() };
  await withPostgrestStandIn(standIn, async () => {
    const hand = standIn.tables.direct_order_receipt_hand_entries;
    const receipts = standIn.tables.direct_order_receipts;
    __setReceiptQrReaderForTests(async () => [`${LINK}000007-AB3K7Q`]);
    await withStoredUploads(async () => {
      await rejectsWith(
        recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "7", code: "AB3K7Q", photoDataUrl: PDF }),
        /camera in Phoenix/,
        "a manager's PDF is refused on the server",
      );
    });
    assert.equal(receipts.find((r) => r.serial === 7)?.state, "unused", "nothing claimed from a manager's PDF");
    await withStoredUploads(async () => {
      const result = await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "7", code: "AB3K7Q", photoDataUrl: GALLERY });
      assert.equal(result.pendingReview, true, "a manager's gallery photo never counts on its QR alone: it waits for review");
    });
    assert.deepEqual(hand.map((e) => [e.serial, e.status]), [[7, "pending"]], "a review is opened for it");
    __setReceiptQrReaderForTests(async () => [`${LINK}000008-C9D2EF`]);
    await withStoredUploads(async () => {
      const result = await recordDirectOrderReceipt(FINANCE, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: GALLERY });
      assert.equal(result.pendingReview, false, "Finance may attach a file it holds: its read QR counts at once");
    });
  });
  __setReceiptQrReaderForTests(async () => []);
}

/**
 * THE QR IN THE PHOTO (owner, 28 Nov 2026: "لايف مش ابلود"; "المدير يدخله مانوال بس يروح للريفيو، ما
 * يدخلش اوتوماتيك"). A photo whose QR names the typed receipt is in at once; one naming another receipt is
 * refused; one whose QR is not read is saved but waits for review — Finance for a manager's, the Super
 * Admin for Finance's, never the person who typed it — and a rejection takes it back out.
 */
async function photoQrBehaviourTests() {
  const LINK = "https://phoenix-hr.satopharma.com/r/";
  const OWN_ENTRY = "66666666-6666-4666-8666-666666666666";
  const standIn: StandIn = { tables: tables(), rpc: databaseFunctions() };
  await withPostgrestStandIn(standIn, async (seen) => {
    const hand = standIn.tables.direct_order_receipt_hand_entries;
    const receipts = standIn.tables.direct_order_receipts;

    // Matched: in at once, no review opened.
    __setReceiptQrReaderForTests(async () => [`${LINK}000007-AB3K7Q`]);
    await withStoredUploads(async () => {
      const result = await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_A, serial: "7", code: "AB3K7Q", photoDataUrl: PHOTO });
      assert.equal(result.pendingReview, false, "a read QR counts at once");
    });
    assert.equal(hand.length, 0, "a read QR opens no review");
    const panelA = (await loadDirectOrderReceiptPanel(MOMEN, ORDER_A)) as DirectOrderReceiptPanel;
    assert.equal(panelA.receipt?.custody.review, null, "the order says its QR was read");
    assert.equal(panelA.mayChooseFile, false, "a manager has no file picker: the camera only");
    assert.equal(((await loadDirectOrderReceiptPanel(FINANCE, ORDER_A)) as DirectOrderReceiptPanel).mayChooseFile, true, "Finance keeps Choose file");

    // Another receipt in the photo: refused, nothing claimed, written on the order — never its code.
    __setReceiptQrReaderForTests(async () => [`${LINK}000009-HJ4MN5`]);
    await withStoredUploads(async () => {
      await rejectsWith(
        recordDirectOrderReceipt(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO }),
        /QR in the photo is receipt 000009, not 000008/,
        "the photo of another receipt never proves this one",
      );
    });
    assert.equal(receipts.find((r) => r.serial === 8)?.state, "unused", "nothing claimed");
    assert.equal(hand.length, 0, "and no review opened");
    const refusal = standIn.tables.direct_order_events.at(-1);
    assert.equal((refusal?.metadata as { reason?: string }).reason, "qr_other_receipt");
    assert.equal(JSON.stringify(standIn.tables.direct_order_events).includes("HJ4MN5"), false, "the other receipt's code is never written down");

    // Unread: saved, and waits for Finance.
    __setReceiptQrReaderForTests(async () => []);
    await withStoredUploads(async () => {
      const result = await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO });
      assert.equal(result.pendingReview, true, "no QR read: it waits for review");
      assert.match(result.message, /Finance checks the photo/);
    });
    assert.equal(receipts.find((r) => r.serial === 8)?.request_id, ORDER_B, "the receipt is held for the order meanwhile — never used twice");
    assert.equal(hand.length, 1);
    assert.deepEqual(
      [hand[0].serial, hand[0].request_id, hand[0].original, hand[0].status, hand[0].entered_by_hr_id, hand[0].entered_by_finance],
      [8, ORDER_B, "custody", "pending", "AI-0001", false],
    );
    assert.equal(hand[0].photo_storage_path, receipts.find((r) => r.serial === 8)?.photo_storage_path, "the review is of the photo on the receipt");
    const entryId = String(hand[0].id);

    const own = ((await loadDirectOrderReceiptPanel(MOMEN, ORDER_B)) as DirectOrderReceiptPanel).receipt?.custody.review;
    assert.deepEqual([own?.status, own?.reviewerLabel, own?.mayDecide], ["pending", "Finance", false], "the manager sees it waiting, and cannot review it");
    const forFinance = ((await loadDirectOrderReceiptPanel(FINANCE, ORDER_B)) as DirectOrderReceiptPanel).receipt?.custody.review;
    assert.equal(forFinance?.mayDecide, true, "Finance may review it");
    const register = await loadDirectOrderReceiptRegister(FINANCE);
    assert.deepEqual(
      register.handEntries.map((e) => [e.entryId, e.serialLabel, e.original, e.pharmacyName, e.mayDecide]),
      [[entryId, "000008", "custody", "El Shifa Pharmacy", true]],
      "Finance's desk lists it",
    );

    // Review: never by its author, and a rejection needs a reason.
    await rejectsWith(decideDirectOrderHandEntry(MOMEN, { requestId: ORDER_B, entryId, decision: "approve", note: "" }), /typed this receipt yourself/, "never self");
    await rejectsWith(decideDirectOrderHandEntry(STRANGER, { requestId: ORDER_B, entryId, decision: "approve", note: "" }), /Only Finance reviews/, "never another manager");
    await rejectsWith(decideDirectOrderHandEntry(FINANCE, { requestId: ORDER_A, entryId, decision: "approve", note: "" }), /not found/, "an entry is decided on its own order");
    await rejectsWith(decideDirectOrderHandEntry(FINANCE, { requestId: ORDER_B, entryId, decision: "reject", note: " " }), /Write why/, "a rejection needs a reason");
    assert.equal(seen.filter((e) => e.rpc === "direct_order_decide_hand_entry").length, 0, "a refused review calls nothing");

    // Rejecting Original 1 takes the receipt off the order, in one database call.
    const rejected = await decideDirectOrderHandEntry(FINANCE, { requestId: ORDER_B, entryId, decision: "reject", note: "The photo is of receipt 000018" });
    assert.match(rejected.message, /rejected and the receipt is off the order/);
    const calls = seen.filter((e) => e.rpc === "direct_order_decide_hand_entry");
    assert.equal(calls.length, 1);
    assert.equal((calls[0].body as { p_decision?: string }).p_decision, "rejected");
    assert.equal(receipts.find((r) => r.serial === 8)?.state, "unused", "the paper is free to be entered again");
    assert.equal(standIn.tables.direct_order_receipt_releases.length, 1, "the release is kept, photo and all");
    assert.equal(hand[0].status, "rejected");
    assert.ok(standIn.tables.audit_logs.length > 0, "an audit line is written");
    assert.ok(standIn.tables.direct_order_events.some((e) => e.event_type === "receipt_hand_entry_rejected"));
    const after = (await loadDirectOrderReceiptPanel(MOMEN, ORDER_B)) as DirectOrderReceiptPanel;
    assert.equal(after.receipt, null, "the order is without its receipt again");
    assert.deepEqual([after.lastRejectedHandEntry?.original, after.lastRejectedHandEntry?.note], ["custody", "The photo is of receipt 000018"], "and says why");
    await rejectsWith(decideDirectOrderHandEntry(FINANCE, { requestId: ORDER_B, entryId, decision: "approve", note: "" }), /already reviewed/, "a review is made once");

    // Both originals typed by hand, then Original 1 rejected: the manager reads Finance's reason, word for word —
    // never the note Phoenix writes on the Original 2 that left with it.
    standIn.tables.employees.push({ hr_id: "B-185", full_name: "Test Finance Reviewer", nickname: null, status: "Active" });
    await withStoredUploads(async () => {
      await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO });
      await recordDirectOrderDelivery(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO });
    });
    const o1Entry = hand.find((e) => e.original === "custody" && e.status === "pending");
    const o2Entry = hand.find((e) => e.original === "delivery" && e.status === "pending");
    assert.ok(o1Entry && o2Entry, "both originals wait for review");
    o2Entry.entered_at = "2026-12-20T09:30:00.000Z";
    o1Entry.entered_at = "2026-12-20T09:00:00.000Z";
    const reason = "الكود المكتوب مش هو اللي على الصفحة — اكتبه تاني من الصفحة نفسها.";
    await decideDirectOrderHandEntry(FINANCE, { requestId: ORDER_B, entryId: String(o1Entry.id), decision: "reject", note: `  ${reason}  ` });
    assert.deepEqual([o2Entry.status, o2Entry.review_note], ["rejected", RECEIPT_O2_CLOSED_WITH_O1_NOTE], "Original 2 closed with Original 1, as the database does");
    const told = ((await loadDirectOrderReceiptPanel(MOMEN, ORDER_B)) as DirectOrderReceiptPanel).lastRejectedHandEntry;
    assert.deepEqual(
      told,
      { original: "custody", serialLabel: "000008", note: reason, reviewedByName: "Test Finance Reviewer", reviewedAt: o1Entry.reviewed_at },
      "the manager is told: Original 1 of receipt 000008, by whom, when, and the reason exactly as Finance wrote it",
    );

    // Original 1 entered again, its QR read: the old rejection goes, and Original 2 typed by hand is then rejected alone.
    __setReceiptQrReaderForTests(async () => [`${LINK}000008-C9D2EF`]);
    await withStoredUploads(async () => {
      await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO });
    });
    assert.equal(((await loadDirectOrderReceiptPanel(MOMEN, ORDER_B)) as DirectOrderReceiptPanel).lastRejectedHandEntry, null, "entered again: no rejection is shown");
    __setReceiptQrReaderForTests(async () => []);
    await withStoredUploads(async () => {
      await recordDirectOrderDelivery(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO });
    });
    const o2Again = hand.find((e) => e.original === "delivery" && e.status === "pending");
    assert.ok(o2Again, "Original 2 waits for review");
    const o2Reason = "The stamp is not the pharmacy's: ask the customer to stamp Original 2 and photograph it again.";
    await decideDirectOrderHandEntry(FINANCE, { requestId: ORDER_B, entryId: String(o2Again.id), decision: "reject", note: o2Reason });
    const toldO2 = (await loadDirectOrderReceiptPanel(MOMEN, ORDER_B)) as DirectOrderReceiptPanel;
    assert.deepEqual(
      [toldO2.lastRejectedHandEntry?.original, toldO2.lastRejectedHandEntry?.serialLabel, toldO2.lastRejectedHandEntry?.note],
      ["delivery", "000008", o2Reason],
      "Original 2 rejected alone: the manager reads its own reason",
    );
    assert.ok(toldO2.receipt?.custody, "and Original 1 stays on the order");
    __setReceiptQrReaderForTests(async () => [`${LINK}000008-C9D2EF`]);
    await withStoredUploads(async () => {
      await recordDirectOrderDelivery(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO });
    });
    assert.equal(((await loadDirectOrderReceiptPanel(MOMEN, ORDER_B)) as DirectOrderReceiptPanel).lastRejectedHandEntry, null, "Original 2 entered again: the notice goes");
    __setReceiptQrReaderForTests(async () => []);

    // The typed-entry form names who checks it: Finance for a manager, the Administrator for Finance.
    assert.equal(((await loadDirectOrderReceiptPanel(MOMEN, ORDER_B)) as DirectOrderReceiptPanel).handEntryReviewerLabel, "Finance");
    assert.equal(((await loadDirectOrderReceiptPanel(FINANCE, ORDER_B)) as DirectOrderReceiptPanel).handEntryReviewerLabel, "the Administrator");

    // Finance takes receipt 8 off: the Original 2 rejected before is never said on an order with no receipt.
    await releaseDirectOrderReceipt(FINANCE, { requestId: ORDER_B, reason: "Entered on the wrong order" });
    assert.equal(((await loadDirectOrderReceiptPanel(MOMEN, ORDER_B)) as DirectOrderReceiptPanel).lastRejectedHandEntry, null, "no receipt on the order: no Original 2 rejection is shown");

    // The claim fails and closing its review fails once: it is tried again, so nothing is left waiting.
    let closeAttempts = 0;
    standIn.failWrites = {
      direct_order_receipts: (call) => (call.method === "PATCH" ? { status: 400, body: { code: "P0001", message: "Receipt book 1 is lost" } } : null),
      direct_order_receipt_hand_entries: (call) => (call.method === "PATCH" && closeAttempts++ === 0 ? { status: 503, body: { code: "PGRST000", message: "connection lost" } } : null),
    };
    await withStoredUploads(async () => {
      await rejectsWith(recordDirectOrderReceipt(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO }), /./, "the claim is refused");
    });
    standIn.failWrites = undefined;
    const unsaved = hand.at(-1);
    assert.deepEqual(
      [unsaved?.status, unsaved?.review_note, closeAttempts],
      ["rejected", "Not saved: the original was not written to the receipt.", 2],
      "a failed close is tried again: an original never saved leaves no review waiting",
    );

    // A review still waiting is closed when Finance takes its receipt off, and leaves Finance's desk.
    await withStoredUploads(async () => {
      await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO });
    });
    const waiting = hand.find((e) => e.original === "custody" && e.status === "pending");
    assert.ok(waiting, "typed by hand: it waits");
    await releaseDirectOrderReceipt(FINANCE, { requestId: ORDER_B, reason: "Entered on the wrong order" });
    assert.deepEqual([waiting.status, waiting.review_note], ["rejected", RECEIPT_CLOSED_BY_RELEASE_NOTE], "the release closes the review with it");
    assert.equal((await loadDirectOrderReceiptRegister(FINANCE)).handEntries.some((e) => e.entryId === waiting.id), false, "and it leaves Finance's desk");

    // A review left over from before — its photo no longer the Original 1 on the order — never takes the newer one off.
    __setReceiptQrReaderForTests(async () => [`${LINK}000008-C9D2EF`]);
    await withStoredUploads(async () => {
      await recordDirectOrderReceipt(MOMEN, { requestId: ORDER_B, serial: "8", code: "C9D2EF", photoDataUrl: PHOTO });
    });
    __setReceiptQrReaderForTests(async () => []);
    const leftover = (id: string, original: "custody" | "delivery") => ({
      id, serial: 8, request_id: ORDER_B, original, photo_storage_path: `direct-order-receipts/old-${original}.jpg`, entered_by_hr_id: "AI-0001",
      entered_by_finance: false, entered_at: "2026-12-20T08:00:00.000Z", status: "pending", reviewed_by_hr_id: null, reviewed_at: null, review_note: null,
    });
    hand.push(leftover("77777777-7777-4777-8777-777777777777", "custody"));
    const staleTold = await decideDirectOrderHandEntry(FINANCE, { requestId: ORDER_B, entryId: "77777777-7777-4777-8777-777777777777", decision: "reject", note: "An older photo of this page." });
    assert.match(staleTold.message, /nothing was taken off/);
    assert.deepEqual([receipts.find((r) => r.serial === 8)?.state, receipts.find((r) => r.serial === 8)?.request_id], ["used", ORDER_B], "the QR-read Original 1 stays on the order");
    const staleEvent = String(standIn.tables.direct_order_events.at(-1)?.message ?? "");
    assert.match(staleEvent, /rejected: An older photo of this page\. Nothing was taken off/, "the order says what happened");
    assert.equal(staleEvent.includes(".."), false, "the reason's own full stop is never doubled");
    // A reason is kept to the 500 characters the box allows, whoever sends it.
    hand.push(leftover("88888888-8888-4888-8888-888888888888", "delivery"));
    await decideDirectOrderHandEntry(FINANCE, { requestId: ORDER_B, entryId: "88888888-8888-4888-8888-888888888888", decision: "reject", note: "x".repeat(600) });
    assert.equal(String(hand.find((e) => e.id === "88888888-8888-4888-8888-888888888888")?.review_note).length, 500, "a reason is cut at 500 characters");

    // Finance's own hand entry goes to the Super Admin alone, and an approval keeps the original.
    hand.push({
      id: OWN_ENTRY,
      serial: 7,
      request_id: ORDER_A,
      original: "custody",
      photo_storage_path: receipts.find((r) => r.serial === 7)?.photo_storage_path,
      entered_by_hr_id: "B-185",
      entered_by_finance: true,
      entered_at: "2026-12-20T09:00:00.000Z",
      status: "pending",
      reviewed_by_hr_id: null,
      reviewed_at: null,
      review_note: null,
    });
    await rejectsWith(decideDirectOrderHandEntry(FINANCE, { requestId: ORDER_A, entryId: OWN_ENTRY, decision: "approve", note: "" }), /typed this receipt yourself/, "Finance never reviews its own");
    await rejectsWith(decideDirectOrderHandEntry(STRANGER, { requestId: ORDER_A, entryId: OWN_ENTRY, decision: "approve", note: "" }), /Only the Administrator reviews/, "the Administrator alone");
    const approved = await decideDirectOrderHandEntry(ADMIN, { requestId: ORDER_A, entryId: OWN_ENTRY, decision: "approve", note: "" });
    assert.match(approved.message, /is approved/);
    assert.equal(receipts.find((r) => r.serial === 7)?.request_id, ORDER_A, "an approved original stays on the order");
  });
  __setReceiptQrReaderForTests(async () => []);
}

export async function runDirectOrderReceiptBooksTests() {
  pureTests();
  reminderPureTests();
  photoQrPureTests();
  rejectionShownPureTests();
  // The suite's stand-in photos are not real pictures: no QR is read unless a test says otherwise.
  __setReceiptQrReaderForTests(async () => []);
  try {
    await behaviourTests();
    await photoQrBehaviourTests();
    await managerCameraOnlyTests();
    await photoQrReaderTests();
  } finally {
    __setReceiptQrReaderForTests(null);
  }
}
