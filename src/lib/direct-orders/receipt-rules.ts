import { canonicalHrIdKey } from "@/lib/hr-id";

// ─────────────────────────────────────────────────────────────────────────────
// The delivery-receipt books — the rules (owner, 26 Nov 2026: "Build the check").
//
// Every District Manager holds a numbered receipt book as custody. Each page carries a six-digit
// serial and a six-character random code printed beside it. At delivery the venue signs and stamps
// the page; the manager enters the serial, the code and a photo of the signed page on the order.
//
// What the check stops:
//   - an invented page: its code will not match the serial (31^6 ≈ 887 million combinations);
//   - one paper proving two orders: a receipt moves unused -> used ONCE, and an order takes ONE;
//   - a page from a book that was never handed out, was returned or was reported lost;
//   - a page from another manager's book.
// What it cannot stop, and says so: a colluding venue, and a real page whose handwritten quantities
// do not match the order — Finance compares the photo with the order lines.
//
// Finance issues, returns and reports a book lost (owner: "Finance"). An approved order with no
// receipt 14 days after approval is flagged on Finance's desk (owner: "14 days"). Nothing here gates
// the sales month or the collection — that is a money rule the owner decides on its own screen.
//
// Pure: every function takes plain rows and returns a decision, so the tests need no database.
// ─────────────────────────────────────────────────────────────────────────────

/** The printer's alphabet — no 0/O, 1/I/L, so a handwritten or misread code cannot be ambiguous. */
export const RECEIPT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const RECEIPT_CODE_LENGTH = 6;
/** Owner, 26 Nov 2026: an approved order is flagged when no receipt is entered 14 days after approval. */
export const RECEIPT_OVERDUE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReceiptBookStatus = "in_store" | "issued" | "returned" | "lost";
export type ReceiptState = "unused" | "used" | "voided";

export type ReceiptBookRow = {
  bookNo: number;
  firstSerial: number;
  lastSerial: number;
  printedHolderHrId: string | null;
  holderHrId: string | null;
  status: ReceiptBookStatus;
  issuedAt: string | null;
  closedAt: string | null;
};

export type ReceiptRow = {
  serial: number;
  bookNo: number;
  checkCode: string;
  state: ReceiptState;
  requestId: string | null;
  voidedReason: string | null;
};

export type OrderForReceipt = {
  id: string;
  requesterHrId: string;
  status: string;
  decidedAt: string | null;
  reversalOfRequestId: string | null;
};

export type ReceiptDecision = { ok: true } | { ok: false; reason: ReceiptRefusalReason; message: string };

export type ReceiptRefusalReason =
  | "order_not_approved"
  | "order_has_receipt"
  | "no_such_receipt"
  | "book_not_issued"
  | "book_returned"
  | "book_lost"
  | "other_holders_book"
  | "code_mismatch"
  | "receipt_used"
  | "receipt_voided";

/** "000123" — the serial exactly as it is printed. */
export function formatReceiptSerial(serial: number): string {
  return String(serial).padStart(6, "0");
}

/** "000101–000150". */
export function formatReceiptRange(first: number, last: number): string {
  return `${formatReceiptSerial(first)}–${formatReceiptSerial(last)}`;
}

/**
 * The serial as typed — leading zeros, spaces and Arabic-Indic digits allowed. Null when it is not a
 * number from 1 to 999999.
 */
export function parseReceiptSerial(raw: unknown): number | null {
  const text = String(raw ?? "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s-]/g, "");
  if (!/^\d{1,6}$/.test(text)) return null;
  const serial = Number(text);
  return serial >= 1 && serial <= 999_999 ? serial : null;
}

/**
 * The code as typed, upper-cased with spaces removed. Null when it is not six characters of the
 * printer's alphabet — said to the manager as "check the code", never compared.
 */
export function normalizeReceiptCode(raw: unknown): string | null {
  const text = String(raw ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "");
  if (text.length !== RECEIPT_CODE_LENGTH) return null;
  for (const ch of text) if (!RECEIPT_CODE_ALPHABET.includes(ch)) return null;
  return text;
}

function sameHrId(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = canonicalHrIdKey(a);
  return left !== null && left === canonicalHrIdKey(b);
}

/**
 * May this receipt prove this order? Checked in this order on purpose: the order first (nothing to
 * prove), then the paper's book (custody), then the code (is the page real), then its state (was it
 * used). A wrong code is refused before "already used" is said, so guessing a code learns nothing.
 */
export function checkReceiptForOrder(input: {
  order: OrderForReceipt;
  serial: number;
  typedCode: string;
  receipt: ReceiptRow | null;
  book: ReceiptBookRow | null;
  orderReceiptSerial: number | null;
}): ReceiptDecision {
  const { order, serial, typedCode, receipt, book } = input;
  const label = formatReceiptSerial(serial);
  if (order.status !== "approved" || order.reversalOfRequestId) {
    return refuse("order_not_approved", "A receipt is entered once the order is approved.");
  }
  if (input.orderReceiptSerial !== null) {
    return refuse("order_has_receipt", `This order already has receipt ${formatReceiptSerial(input.orderReceiptSerial)}. An order takes one receipt.`);
  }
  if (!receipt || !book) {
    return refuse("no_such_receipt", `There is no receipt ${label} in any Sato Pharma receipt book. Check the number printed at the top of the page.`);
  }
  if (book.status === "in_store") {
    return refuse("book_not_issued", `Receipt ${label} is in book ${book.bookNo}, which Finance has not handed out yet.`);
  }
  if (book.status === "returned") {
    return refuse("book_returned", `Receipt ${label} is in book ${book.bookNo}, which was returned to Finance.`);
  }
  if (book.status === "lost") {
    return refuse("book_lost", `Receipt ${label} is in book ${book.bookNo}, which was reported lost. None of its receipts can be used.`);
  }
  if (!sameHrId(book.holderHrId, order.requesterHrId)) {
    return refuse("other_holders_book", `Receipt ${label} is in another manager's book. Use a receipt from the book handed to the person who raised this order.`);
  }
  if (receipt.checkCode !== typedCode) {
    return refuse("code_mismatch", `The code does not match receipt ${label}. Type the six characters printed beside the number.`);
  }
  if (receipt.state === "used") {
    return refuse("receipt_used", `Receipt ${label} was already used on another order. A receipt proves one order only.`);
  }
  if (receipt.state === "voided") {
    return refuse("receipt_voided", `Receipt ${label} was cancelled${receipt.voidedReason ? `: ${receipt.voidedReason}` : ""}.`);
  }
  return { ok: true };
}

function refuse(reason: ReceiptRefusalReason, message: string): ReceiptDecision {
  return { ok: false, reason, message };
}

/**
 * Was the order's requester holding a book when it was approved? Only then is a receipt owed: an
 * order approved before the books were handed out is never flagged (the cutover is each book's own
 * issue date). A book returned or lost before the approval does not count.
 */
export function bookHeldAtApproval(order: OrderForReceipt, books: readonly ReceiptBookRow[]): ReceiptBookRow | null {
  if (!order.decidedAt) return null;
  const decided = Date.parse(order.decidedAt);
  if (!Number.isFinite(decided)) return null;
  for (const book of books) {
    if (book.status === "in_store" || !book.issuedAt) continue;
    if (!sameHrId(book.holderHrId, order.requesterHrId)) continue;
    if (Date.parse(book.issuedAt) > decided) continue;
    if (book.closedAt && Date.parse(book.closedAt) <= decided) continue;
    return book;
  }
  return null;
}

export type ReceiptStanding = "has_receipt" | "not_required" | "waiting" | "overdue";

/** Whole days since approval, Cairo-agnostic (a duration, not a date). */
export function daysSinceApproval(decidedAt: string | null, now: Date): number | null {
  if (!decidedAt) return null;
  const decided = Date.parse(decidedAt);
  if (!Number.isFinite(decided)) return null;
  return Math.max(0, Math.floor((now.getTime() - decided) / DAY_MS));
}

/**
 * Where an order stands on its receipt. `waiting` inside the 14 days, `overdue` from day 14 on.
 * Only an approved original order owes one — a reversal, a rejection or a cancellation never does.
 */
export function classifyOrderReceipt(input: {
  order: OrderForReceipt;
  books: readonly ReceiptBookRow[];
  hasReceipt: boolean;
  now: Date;
}): ReceiptStanding {
  if (input.hasReceipt) return "has_receipt";
  if (input.order.status !== "approved" || input.order.reversalOfRequestId) return "not_required";
  if (!bookHeldAtApproval(input.order, input.books)) return "not_required";
  const days = daysSinceApproval(input.order.decidedAt, input.now) ?? 0;
  return days >= RECEIPT_OVERDUE_DAYS ? "overdue" : "waiting";
}

/** The book a manager may write a receipt from today: the one issued to him and still open. */
export function openBookFor(holderHrId: string, books: readonly ReceiptBookRow[]): ReceiptBookRow | null {
  return books.find((book) => book.status === "issued" && sameHrId(book.holderHrId, holderHrId)) ?? null;
}

/** Finance hands a book out. Only a book still in store, and a pre-printed book only to its printed name. */
export function checkBookIssue(book: ReceiptBookRow | null, holderHrId: string): ReceiptDecisionPlain {
  if (!book) return { ok: false, message: "There is no such receipt book." };
  if (!canonicalHrIdKey(holderHrId)) return { ok: false, message: "Choose the manager who receives the book." };
  if (book.status !== "in_store") {
    return { ok: false, message: `Book ${book.bookNo} was already handed out. A book is issued once; a returned or lost book is never reissued.` };
  }
  if (book.printedHolderHrId && !sameHrId(book.printedHolderHrId, holderHrId)) {
    return { ok: false, message: `Book ${book.bookNo} has another manager's name printed on every page. Issue it to that manager, or use a spare book.` };
  }
  return { ok: true };
}

export type ReceiptDecisionPlain = { ok: true } | { ok: false; message: string };

/** Finance takes a book back, or records it lost. Lost cancels every receipt in it still unused. */
export function checkBookClose(book: ReceiptBookRow | null, kind: "returned" | "lost"): ReceiptDecisionPlain {
  if (!book) return { ok: false, message: "There is no such receipt book." };
  if (kind === "returned" && book.status !== "issued") {
    return { ok: false, message: `Book ${book.bookNo} is not with a manager, so it cannot be returned.` };
  }
  if (kind === "lost" && book.status !== "issued" && book.status !== "in_store") {
    return { ok: false, message: `Book ${book.bookNo} is already ${book.status === "lost" ? "recorded lost" : "returned"}.` };
  }
  return { ok: true };
}

/** A spoiled page is cancelled with its reason. A used receipt is never cancelled — it proves an order. */
export function checkReceiptVoid(receipt: ReceiptRow | null, reason: string): ReceiptDecisionPlain {
  if (!receipt) return { ok: false, message: "There is no such receipt." };
  if (receipt.state === "used") return { ok: false, message: `Receipt ${formatReceiptSerial(receipt.serial)} proves an order and cannot be cancelled.` };
  if (receipt.state === "voided") return { ok: false, message: `Receipt ${formatReceiptSerial(receipt.serial)} is already cancelled.` };
  if (reason.trim().length < 3) return { ok: false, message: "Write why the receipt is cancelled, for example 'spoiled, kept in the book'." };
  return { ok: true };
}
