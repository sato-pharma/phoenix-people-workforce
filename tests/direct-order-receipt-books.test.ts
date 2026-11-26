import assert from "node:assert/strict";

import { createAccessContext } from "../src/lib/auth/permissions.ts";
import {
  closeDirectOrderReceiptBook,
  issueDirectOrderReceiptBook,
  recordDirectOrderReceipt,
} from "../src/lib/direct-orders/receipt-books.ts";
import {
  bookHeldAtApproval,
  checkBookIssue,
  checkReceiptForOrder,
  checkReceiptVoid,
  classifyOrderReceipt,
  normalizeReceiptCode,
  parseReceiptSerial,
  type OrderForReceipt,
  type ReceiptBookRow,
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
  assert.equal(reasonOf(check({ book: book({ status: "returned", closedAt: "2026-12-15T00:00:00Z" }) })), "book_returned");
  assert.equal(reasonOf(check({ book: book({ status: "lost", closedAt: "2026-12-15T00:00:00Z" }) })), "book_lost");
  assert.equal(reasonOf(check({ receipt: null, book: null })), "no_such_receipt");
  assert.equal(reasonOf(check({ order: order({ status: "pending_approval" }) })), "order_not_approved");
  assert.equal(reasonOf(check({ order: order({ reversalOfRequestId: "r" }) })), "order_not_approved", "a reversal never takes a receipt");
  assert.equal(reasonOf(check({ orderReceiptSerial: 3 })), "order_has_receipt", "an order takes one receipt");

  // The 14-day flag, and its cutover: each book's own issue date.
  const books = [book()];
  const at = (days: number) => new Date(Date.parse("2026-12-10T09:00:00.000Z") + days * DAY);
  assert.equal(classifyOrderReceipt({ order: order(), books, hasReceipt: false, now: at(13) }), "waiting", "day 13 still inside the window");
  assert.equal(classifyOrderReceipt({ order: order(), books, hasReceipt: false, now: at(14) }), "overdue", "flagged from day 14 (owner: 14 days)");
  assert.equal(classifyOrderReceipt({ order: order(), books, hasReceipt: true, now: at(30) }), "has_receipt");
  assert.equal(
    classifyOrderReceipt({ order: order({ decidedAt: "2026-11-20T09:00:00.000Z" }), books, hasReceipt: false, now: NOW }),
    "not_required",
    "an order approved before the manager received his book never owes a receipt",
  );
  assert.equal(
    bookHeldAtApproval(order(), [book({ status: "returned", closedAt: "2026-12-05T00:00:00.000Z" })]),
    null,
    "a book returned before the approval does not count",
  );
  assert.equal(classifyOrderReceipt({ order: order({ status: "rejected" }), books, hasReceipt: false, now: NOW }), "not_required");

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
}

// ─── Behaviour, through the shared PostgREST stand-in ────────────────────────

const ORDER_A = "11111111-1111-4111-8111-111111111111";
const ORDER_B = "22222222-2222-4222-8222-222222222222";
const PHOTO = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64")}`;

const MOMEN = createAccessContext({ hrId: "AI-0001", loginId: "momen", role: "District Manager", source: "session" });
const STRANGER = createAccessContext({ hrId: "PD-0012", loginId: "eleiwa", role: "District Manager", source: "session" });
const ADMIN = createAccessContext({ hrId: "B-10", loginId: "owner", role: "Super Admin", source: "session" });

function tables(): Record<string, Row[]> {
  return {
    direct_order_receipt_books: [
      { book_no: 1, first_serial: 1, last_serial: 50, printed_holder_hr_id: "AI-0001", holder_hr_id: "AI-0001", status: "issued", issued_at: "2026-12-01T08:00:00.000Z", closed_at: null },
      { book_no: 2, first_serial: 51, last_serial: 100, printed_holder_hr_id: "PD-0012", holder_hr_id: null, status: "in_store", issued_at: null, closed_at: null },
    ],
    direct_order_receipts: [
      { serial: 7, book_no: 1, check_code: "AB3K7Q", state: "unused", request_id: null, voided_reason: null },
      { serial: 8, book_no: 1, check_code: "C9D2EF", state: "unused", request_id: null, voided_reason: null },
      { serial: 9, book_no: 1, check_code: "HJ4MN5", state: "used", request_id: "33333333-3333-4333-8333-333333333333", voided_reason: null },
    ],
    direct_order_requests: [
      { id: ORDER_A, requester_hr_id: "AI-0001", status: "approved", decided_at: "2026-12-10T09:00:00.000Z", reversal_of_request_id: null },
      { id: ORDER_B, requester_hr_id: "AI-0001", status: "approved", decided_at: "2026-12-11T09:00:00.000Z", reversal_of_request_id: null },
    ],
    direct_order_events: [],
    audit_logs: [],
    employees: [],
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

  // 5. Custody: a pre-printed book only to its name; lost cancels only the unused receipts.
  {
    const standIn: StandIn = { tables: tables() };
    await withPostgrestStandIn(standIn, async () => {
      await rejectsWith(issueDirectOrderReceiptBook(ADMIN, { bookNo: 2, holderHrId: "AI-0001" }), /another manager's name printed/, "book 2 carries Mohamed Eleiwa's name");
      await rejectsWith(issueDirectOrderReceiptBook(MOMEN, { bookNo: 2, holderHrId: "PD-0012" }), /Only Finance/, "a District Manager cannot hand out books");
      await closeDirectOrderReceiptBook(ADMIN, { bookNo: 1, kind: "lost", note: "left in a taxi" });
      const byserial = new Map(standIn.tables.direct_order_receipts.map((r) => [r.serial, r.state]));
      assert.equal(byserial.get(7), "voided", "an unused receipt in a lost book is cancelled");
      assert.equal(byserial.get(9), "used", "a used receipt still proves its order after the book is lost");
      assert.equal(standIn.tables.direct_order_receipt_books.find((b) => b.book_no === 1)?.status, "lost");
    });
  }
}

export async function runDirectOrderReceiptBooksTests() {
  pureTests();
  await behaviourTests();
}
