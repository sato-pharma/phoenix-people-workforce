import { canonicalHrIdKey } from "@/lib/hr-id";

// ─────────────────────────────────────────────────────────────────────────────
// The delivery-receipt books — the rules (owner, 26 Nov 2026: "Build the check").
//
// Every District Manager holds a numbered receipt book as custody. Each page carries a six-digit
// serial and a six-character random code printed beside it, on all three sheets of the receipt (see
// TWO ORIGINALS AND A COPY below); the manager enters the serial, the code and a photo of each original.
//
// What the check stops:
//   - an invented page: its code will not match the serial (31^6 ≈ 887 million combinations);
//   - one paper proving two orders: a receipt moves unused -> used ONCE, and an order takes ONE;
//   - a page from a book that was never handed out, was returned or was reported lost;
//   - a page from another manager's book.
// What it cannot stop, and says so: a colluding venue, and a real page whose handwritten quantities
// do not match the order — Finance compares the photo with the order lines.
//
// Finance issues, returns and reports a book lost (owner: "Finance"). An approved order with an
// original past its due date is flagged on Finance's desk, and its manager raises no new order until
// it is entered (owner, 27 Nov 2026; the due dates are below). An order raised by
// someone who held no book is flagged too, from the day the first book was handed out (owner, 27 Nov
// 2026: "Flag them"). A page from a returned book is still accepted for an order approved while its
// manager held it (owner, 27 Nov 2026: "Allow late entry"), and Finance can undo a receipt entered on
// the wrong order, with a written reason (owner, 27 Nov 2026: "make an undo option"). Nothing here
// gates the sales month or the collection — that is a money rule the owner decides on its own screen.
//
// An order that will never have a receipt stands without one ONLY with the CEO's approval (owner,
// 27 Nov 2026: "صلاحيه عمل اى اوردر بدون ايصال هى صلاحيه انور فقط لاغير موافقه منه والتنفيذ من خلال
// استاذ احمد"; he chose "Anwar approves in Phoenix"). Finance asks on the order with a written reason;
// the CEO approves or refuses it. An approved one leaves Finance's overdue and no-book lists.
//
// TWO ORIGINALS AND A COPY (owner, 27 Nov 2026, "Go, build it"). Every receipt is three sheets under one
// serial and code: Original 1, the manager's signed custody of the goods (it stays in the book); Original 2,
// the delivery page the customer signs and stamps (it stays with the manager); and the carbon copy of
// Original 2, torn off for the customer. Both originals are photographed onto the order. Finance records
// the day the goods left the warehouse, and both deadlines count from the NEXT day: Original 1 within 3
// calendar days, Original 2 within 6 working days with Friday off. Before Finance records the exit, nothing
// is late. Original 1 is entered first and claims the receipt; Original 2 is added to that same receipt.
//
// Pure: every function takes plain rows and returns a decision, so the tests need no database.
// ─────────────────────────────────────────────────────────────────────────────

/** The printer's alphabet — no 0/O, 1/I/L, so a handwritten or misread code cannot be ambiguous. */
export const RECEIPT_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const RECEIPT_CODE_LENGTH = 6;
/**
 * Original 1 — the manager's custody page — is due within 3 CALENDAR days, counted from the day after
 * the goods left the warehouse (owner, 27 Nov 2026: left on day 1, counted from day 2).
 */
export const CUSTODY_DUE_DAYS = 3;
/** Original 2 — the customer's delivery page — within 6 WORKING days from the same day, Friday off. */
export const DELIVERY_DUE_WORKING_DAYS = 6;
/** The weekly day off the working-day count skips (Date.getUTCDay: 5 = Friday). */
const WEEKLY_DAY_OFF = 5;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-11-27" — the Cairo calendar day of an instant. */
export function cairoDateKeyOf(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function dateKeyToUtc(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcToDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A real calendar day written YYYY-MM-DD, or null. */
export function parseDateKey(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  if (!DATE_KEY.test(text)) return null;
  return utcToDateKey(dateKeyToUtc(text)) === text ? text : null;
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetweenDateKeys(from: string, to: string): number {
  return Math.round((dateKeyToUtc(to) - dateKeyToUtc(from)) / DAY_MS);
}

/**
 * The last day each original may be entered, from the warehouse exit day. Left Thursday: Original 1 by
 * Sunday (Fri, Sat, Sun), Original 2 by the next Thursday (Sat to Thu, the Friday skipped).
 */
export function receiptDueDates(exitDate: string): { custodyDue: string; deliveryDue: string } {
  const start = dateKeyToUtc(exitDate);
  const custodyDue = utcToDateKey(start + CUSTODY_DUE_DAYS * DAY_MS);
  let day = start;
  let counted = 0;
  while (counted < DELIVERY_DUE_WORKING_DAYS) {
    day += DAY_MS;
    if (new Date(day).getUTCDay() !== WEEKLY_DAY_OFF) counted += 1;
  }
  return { custodyDue, deliveryDue: utcToDateKey(day) };
}

/** What has been entered on an order so far, and the exit day Finance recorded. */
export type ReceiptProgress = {
  /** Original 1, the custody page — entered first; it claims the receipt. */
  custodyEntered: boolean;
  /** Original 2, the customer's delivery page. */
  deliveryEntered: boolean;
  /** The Cairo day the goods left the warehouse, or null while Finance has not recorded it. */
  exitDate: string | null;
};

export type ReceiptLateness = {
  /** The original whose due date passed first — the custody page is always due first. */
  original: "custody" | "delivery";
  dueDate: string;
  daysLate: number;
};

/**
 * Is an original past its due date today? Null while nothing is late — including before Finance records
 * the warehouse exit, since both deadlines count from it. The custody page is checked first: it is due first.
 */
export function receiptLateness(progress: ReceiptProgress, todayCairo: string): ReceiptLateness | null {
  if (!progress.exitDate) return null;
  const due = receiptDueDates(progress.exitDate);
  if (!progress.custodyEntered && todayCairo > due.custodyDue) {
    return { original: "custody", dueDate: due.custodyDue, daysLate: daysBetweenDateKeys(due.custodyDue, todayCairo) };
  }
  if (!progress.deliveryEntered && todayCairo > due.deliveryDue) {
    return { original: "delivery", dueDate: due.deliveryDue, daysLate: daysBetweenDateKeys(due.deliveryDue, todayCairo) };
  }
  return null;
}

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
  | "receipt_voided"
  | "order_without_receipt"
  | "custody_not_entered"
  | "delivery_entered"
  | "other_receipt";

/** Why an attempt was refused before or after the rules ran — each one is written on the order too. */
export type ReceiptAttemptRefusal =
  | ReceiptRefusalReason
  | "not_allowed"
  | "bad_serial"
  | "bad_code"
  | "bad_photo"
  | "claim_lost"
  | "book_changed"
  | "delivery_lost"
  | "qr_other_receipt";

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
 * prove), then the paper's book (custody: handed out, still in the requester's hands or returned
 * after he held it for this order), then the code (is the page real), then its state (was it used).
 * A wrong code is refused before "already used" is said, so guessing a code learns nothing.
 */
export function checkReceiptForOrder(input: {
  order: OrderForReceipt;
  serial: number;
  typedCode: string;
  receipt: ReceiptRow | null;
  book: ReceiptBookRow | null;
  orderReceiptSerial: number | null;
  /** The CEO approved this order to stand without a receipt. */
  withoutReceiptApproved?: boolean;
}): ReceiptDecision {
  const { order, serial, typedCode, receipt, book } = input;
  const label = formatReceiptSerial(serial);
  if (order.status !== "approved" || order.reversalOfRequestId) {
    return refuse("order_not_approved", "A receipt is entered once the order is approved.");
  }
  if (input.withoutReceiptApproved) {
    return refuse("order_without_receipt", "The CEO approved this order to stand without a receipt, so no receipt is entered on it.");
  }
  if (input.orderReceiptSerial !== null) {
    return refuse(
      "order_has_receipt",
      `Original 1 of receipt ${formatReceiptSerial(input.orderReceiptSerial)} is already entered on this order. An order takes one receipt; enter its Original 2 below.`,
    );
  }
  if (!receipt || !book) {
    return refuse("no_such_receipt", `There is no receipt ${label} in any Sato Pharma receipt book. Check the number printed at the top of the page.`);
  }
  if (book.status === "in_store") {
    return refuse("book_not_issued", `Receipt ${label} is in book ${book.bookNo}, which Finance has not handed out yet.`);
  }
  if (book.status === "lost") {
    return refuse("book_lost", `Receipt ${label} is in book ${book.bookNo}, which was reported lost. None of its receipts can be used.`);
  }
  if (!sameHrId(book.holderHrId, order.requesterHrId)) {
    return refuse("other_holders_book", `Receipt ${label} is in another manager's book. Use a receipt from the book handed to the person who raised this order.`);
  }
  // Late entry (owner, 27 Nov 2026: "Allow late entry"): a returned book still proves an order
  // approved while its manager held it — never one approved after it came back.
  if (book.status === "returned" && !bookHeldAt(book, order)) {
    return refuse(
      "book_returned",
      `Receipt ${label} is in book ${book.bookNo}, which was returned to Finance. A page from a returned book proves only an order approved while the manager held it.`,
    );
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

/**
 * May Original 2 — the customer's delivery page — be added to this order? Only once Original 1 claimed a
 * receipt for it, only once, and only from that same receipt: the typed number and code must be the ones
 * printed on it (all three sheets carry them). A wrong code is refused before "already entered" is said.
 */
export function checkDeliveryForOrder(input: {
  order: OrderForReceipt;
  serial: number;
  typedCode: string;
  /** The receipt Original 1 claimed for this order, or null when Original 1 is not entered yet. */
  orderReceipt: ReceiptRow | null;
  deliveryEntered: boolean;
  withoutReceiptApproved?: boolean;
}): ReceiptDecision {
  const label = formatReceiptSerial(input.serial);
  if (input.order.status !== "approved" || input.order.reversalOfRequestId) {
    return refuse("order_not_approved", "A receipt is entered once the order is approved.");
  }
  if (input.withoutReceiptApproved) {
    return refuse("order_without_receipt", "The CEO approved this order to stand without a receipt, so no receipt is entered on it.");
  }
  if (!input.orderReceipt) {
    return refuse(
      "custody_not_entered",
      "Enter Original 1 — the custody page you signed when the goods left the warehouse — first. Original 2 is added to the same receipt.",
    );
  }
  const own = formatReceiptSerial(input.orderReceipt.serial);
  if (input.orderReceipt.serial !== input.serial) {
    return refuse("other_receipt", `This order's receipt is ${own}. Original 2 carries the same number as Original 1.`);
  }
  if (input.orderReceipt.checkCode !== input.typedCode) {
    return refuse("code_mismatch", `The code does not match receipt ${label}. Type the six characters printed beside the number.`);
  }
  if (input.deliveryEntered) {
    return refuse("delivery_entered", `Original 2 of receipt ${own} is already entered on this order.`);
  }
  return { ok: true };
}

/**
 * May Finance record the day this order left the warehouse? Only an approved original order, a real
 * day, never in the future and never before the day the order was approved.
 */
export function checkWarehouseExit(input: { order: OrderForReceipt; exitDate: string | null; todayCairo: string }): ReceiptDecisionPlain {
  if (input.order.status !== "approved" || input.order.reversalOfRequestId) {
    return { ok: false, message: "Only an approved order leaves the warehouse." };
  }
  if (!input.exitDate) return { ok: false, message: "Choose the day the goods left the warehouse." };
  if (input.exitDate > input.todayCairo) return { ok: false, message: "The warehouse exit cannot be a day that has not come yet." };
  const approvedDay = input.order.decidedAt ? cairoDateKeyOf(new Date(input.order.decidedAt)) : null;
  if (approvedDay && input.exitDate < approvedDay) {
    return { ok: false, message: "The goods cannot leave the warehouse before the order was approved." };
  }
  return { ok: true };
}

function refuse(reason: ReceiptRefusalReason, message: string): ReceiptDecision {
  return { ok: false, reason, message };
}

/** Did this book sit with the order's requester on the day the order was approved? */
function bookHeldAt(book: ReceiptBookRow, order: OrderForReceipt): boolean {
  if (!order.decidedAt || book.status === "in_store" || !book.issuedAt) return false;
  const decided = Date.parse(order.decidedAt);
  if (!Number.isFinite(decided)) return false;
  if (!sameHrId(book.holderHrId, order.requesterHrId)) return false;
  if (Date.parse(book.issuedAt) > decided) return false;
  if (book.closedAt && Date.parse(book.closedAt) <= decided) return false;
  return true;
}

/**
 * Was the order's requester holding a book when it was approved? Only then is a receipt owed from a
 * book: an order approved before the books were handed out is never flagged (the cutover is each
 * book's own issue date). A book returned or lost before the approval does not count.
 */
export function bookHeldAtApproval(order: OrderForReceipt, books: readonly ReceiptBookRow[]): ReceiptBookRow | null {
  return books.find((book) => bookHeldAt(book, order)) ?? null;
}

/**
 * The day the receipt check began: the first time Finance handed any book out. From then on an
 * approved order raised by someone holding no book is flagged, not silently excused (owner, 27 Nov
 * 2026: "Flag them"). Null while every book is still in store — nothing is flagged before the rollout.
 */
export function receiptRolloutStart(books: readonly ReceiptBookRow[]): number | null {
  let first: number | null = null;
  for (const book of books) {
    if (!book.issuedAt) continue;
    const at = Date.parse(book.issuedAt);
    if (Number.isFinite(at) && (first === null || at < first)) first = at;
  }
  return first;
}

/**
 * `no_book`: approved after the rollout, but its requester held no book that day, so no signed page
 * stands behind it. Flagged on Finance's desk at once (owner, 27 Nov 2026: "Flag them").
 */
export type ReceiptStanding = "has_receipt" | "not_required" | "awaiting_exit" | "waiting" | "overdue" | "no_book" | "without_receipt";

/** Whole days since approval, Cairo-agnostic (a duration, not a date). */
export function daysSinceApproval(decidedAt: string | null, now: Date): number | null {
  if (!decidedAt) return null;
  const decided = Date.parse(decidedAt);
  if (!Number.isFinite(decided)) return null;
  return Math.max(0, Math.floor((now.getTime() - decided) / DAY_MS));
}

/**
 * Where an order stands on its receipt. `has_receipt` once BOTH originals are entered. `awaiting_exit`
 * while Finance has not recorded the warehouse exit (nothing counts yet), then `waiting` until an
 * original passes its due date and `overdue` after. `no_book` when its requester held no book on the day
 * it was approved, after the rollout began. `without_receipt` when the CEO approved it to stand without
 * one — never flagged after that. Only an approved original order owes one — a reversal, a rejection or
 * a cancellation never does.
 */
export function classifyOrderReceipt(input: {
  order: OrderForReceipt;
  books: readonly ReceiptBookRow[];
  progress: ReceiptProgress;
  now: Date;
  /** The CEO approved this order to stand without a receipt. */
  withoutReceiptApproved?: boolean;
}): ReceiptStanding {
  const { progress } = input;
  if (progress.custodyEntered && progress.deliveryEntered) return "has_receipt";
  if (input.order.status !== "approved" || input.order.reversalOfRequestId) return "not_required";
  if (input.withoutReceiptApproved) return "without_receipt";
  // Original 1 entered proves a book stood behind the order, whenever it was handed over.
  if (!progress.custodyEntered && !bookHeldAtApproval(input.order, input.books)) {
    const rollout = receiptRolloutStart(input.books);
    const decided = input.order.decidedAt ? Date.parse(input.order.decidedAt) : Number.NaN;
    if (rollout === null || !Number.isFinite(decided) || decided < rollout) return "not_required";
    return "no_book";
  }
  if (!progress.exitDate) return "awaiting_exit";
  return receiptLateness(progress, cairoDateKeyOf(input.now)) ? "overdue" : "waiting";
}

/** The book a manager may write a receipt from today: the one issued to him and still open. */
export function openBookFor(holderHrId: string, books: readonly ReceiptBookRow[]): ReceiptBookRow | null {
  return books.find((book) => book.status === "issued" && sameHrId(book.holderHrId, holderHrId)) ?? null;
}

/**
 * The book a receipt for this order is written from: the requester's open book, or — late entry — the
 * book he held when the order was approved and has since returned to Finance. Never a lost book.
 */
export function receiptEntryBookFor(order: OrderForReceipt, books: readonly ReceiptBookRow[]): ReceiptBookRow | null {
  const open = openBookFor(order.requesterHrId, books);
  if (open) return open;
  const held = bookHeldAtApproval(order, books);
  return held && held.status === "returned" ? held : null;
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

/**
 * Finance undoes a receipt entered on the wrong order (owner, 27 Nov 2026: "make an undo option").
 * Only a used receipt on THIS order, and always with a written reason — the release is kept for ever.
 */
export function checkReceiptRelease(input: { receipt: ReceiptRow | null; requestId: string; reason: string }): ReceiptDecisionPlain {
  const { receipt } = input;
  if (!receipt || receipt.state !== "used" || receipt.requestId !== input.requestId) {
    return { ok: false, message: "This order has no receipt to undo." };
  }
  if (input.reason.trim().length < 3) {
    return { ok: false, message: "Write why the receipt is taken off this order, for example 'entered on the wrong order'." };
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

// ─── An order without a receipt: the CEO's authority alone ───────────────────

export type NoReceiptStatus = "pending" | "approved" | "refused";

export type NoReceiptRow = {
  id: string;
  requestId: string;
  reason: string;
  askedByHrId: string;
  askedAt: string;
  status: NoReceiptStatus;
  decidedByHrId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
};

/** The standings that owe a receipt — only these may be asked to stand without one. */
const OWES_RECEIPT: ReadonlySet<ReceiptStanding> = new Set<ReceiptStanding>(["awaiting_exit", "waiting", "overdue", "no_book"]);

/**
 * May Finance ask the CEO to let this order stand without a receipt? Only an approved order that owes
 * one, has none, and has no ask already waiting or approved — always with a written reason.
 */
export function checkNoReceiptAsk(input: { standing: ReceiptStanding; live: NoReceiptRow | null; reason: string }): ReceiptDecisionPlain {
  if (input.standing === "has_receipt") return { ok: false, message: "This order already has a receipt." };
  if (input.live?.status === "approved" || input.standing === "without_receipt") {
    return { ok: false, message: "The CEO already approved this order to stand without a receipt." };
  }
  if (input.live?.status === "pending") return { ok: false, message: "A request for this order is already waiting for the CEO's decision." };
  if (!OWES_RECEIPT.has(input.standing)) return { ok: false, message: "Only an approved order that owes a delivery receipt can be asked to stand without one." };
  if (input.reason.trim().length < 3) return { ok: false, message: "Write why this order has no delivery receipt." };
  return { ok: true };
}

/**
 * May the CEO decide this ask? Only a waiting one. Approving needs the order still to owe a receipt (a
 * receipt entered meanwhile makes the ask unnecessary — refuse it instead); refusing always says why.
 */
export function checkNoReceiptDecision(input: {
  live: NoReceiptRow | null;
  hasReceipt: boolean;
  decision: unknown;
  note: string;
}): { ok: true; decision: "approved" | "refused" } | { ok: false; message: string } {
  if (!input.live || input.live.status !== "pending") return { ok: false, message: "There is no request on this order waiting for a decision." };
  if (input.decision !== "approve" && input.decision !== "refuse") return { ok: false, message: "Choose approve or refuse." };
  if (input.decision === "approve" && input.hasReceipt) {
    return { ok: false, message: "A delivery receipt was entered on this order after the request was sent, so it no longer needs to stand without one. Refuse the request." };
  }
  if (input.decision === "refuse" && input.note.trim().length < 3) return { ok: false, message: "Write why the request is refused." };
  return { ok: true, decision: input.decision === "approve" ? "approved" : "refused" };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE QR ON EVERY PAGE (owner, 28 Nov 2026: "كيو ار كود يقرا فينيكس ده اساسي"; "هيطلب منه لوجن …
// اللي هيحط لوجن هيدخله على تفاصيل الاوردر، اللي مش هيحط لوجن مش هيدخله").
//
// Each sheet's QR is a Phoenix link, `/r/<serial>-<code>`. Scanning it asks for a sign-in; once signed
// in, a used receipt opens its order (whose own page decides who may see it) and any other receipt says
// what it is. The code in the link is the one printed beside the serial on the same sheet, so the link
// gives away nothing the paper does not already show. As in checkReceiptForOrder, the code is checked
// BEFORE the receipt's state is said, so a made-up link learns nothing about a real serial.
// ─────────────────────────────────────────────────────────────────────────────

/** The path the QR on a receipt sheet opens. */
export function receiptScanPath(serial: number, code: string): string {
  return `/r/${formatReceiptSerial(serial)}-${code}`;
}

/** `000401-TMDD9C` as it arrives in the link. Null when it is not a serial and a code of the printer's alphabet. */
export function parseReceiptScanToken(raw: unknown): { serial: number; code: string } | null {
  let text = String(raw ?? "").trim();
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  const match = /^(\d{6})-([0-9A-Za-z]{6})$/.exec(text);
  if (!match) return null;
  const serial = parseReceiptSerial(match[1]);
  const code = normalizeReceiptCode(match[2]);
  return serial !== null && code !== null ? { serial, code } : null;
}

export type ReceiptScanOutcome =
  | { kind: "not_genuine" }
  | { kind: "used"; serial: number; bookNo: number; requestId: string | null }
  | { kind: "unused"; serial: number; bookNo: number }
  | { kind: "voided"; serial: number; bookNo: number; reason: string | null };

/** What a scanned link proves. The code first, then the state. */
export function decideReceiptScan(token: { serial: number; code: string } | null, receipt: ReceiptRow | null): ReceiptScanOutcome {
  if (!token || !receipt || receipt.serial !== token.serial || receipt.checkCode !== token.code) return { kind: "not_genuine" };
  if (receipt.state === "used") return { kind: "used", serial: receipt.serial, bookNo: receipt.bookNo, requestId: receipt.requestId };
  if (receipt.state === "voided") return { kind: "voided", serial: receipt.serial, bookNo: receipt.bookNo, reason: receipt.voidedReason };
  return { kind: "unused", serial: receipt.serial, bookNo: receipt.bookNo };
}

// ─── The QR read from the photo (owner, 28 Nov 2026) ─────────────────────────
//
// "فينيكس يطلب منهم ان هم يصوروها بطريقه معينه … يتعرف على … رقم الاذن ورمز التحقق والكيو ار كود
// … اوتوماتيك بغض النظر عن اللي هم كاتبينه بايديهم". The photo of an original is read on the SERVER
// (the camera's green light is only a help): a QR that names the typed receipt lets it in at once; a QR
// that names ANOTHER receipt is refused; no QR read means the number was typed by hand, and the original
// waits for review — "المدير يدخله مانوال بس يروح للريفيو، ما يدخلش اوتوماتيك".

/** The receipt a QR's text names: the Phoenix link `…/r/000401-TMDD9C`, or the bare token. */
export function parseReceiptQrText(text: unknown): { serial: number; code: string } | null {
  const raw = String(text ?? "").trim();
  const link = /\/r\/([^/?#\s]+)\/?(?:[?#].*)?$/.exec(raw);
  return parseReceiptScanToken(link ? link[1] : raw);
}

/**
 * A picture Phoenix's own camera drew: a JPEG with no EXIF block. A canvas frame never carries one; a phone photo,
 * a saved gallery picture or a scan usually does. The server cannot see the screen, so for a manager (camera only,
 * owner, 28 Nov 2026) only such a frame counts on its QR at once — anything else waits for review. A forged upload
 * with its EXIF stripped still passes this; it is the check the bytes allow, not proof the page was in front of the
 * lens.
 */
export function isPhoenixCameraFrame(photo: { bytes: Uint8Array; contentType: string }): boolean {
  const b = photo.bytes;
  if (photo.contentType !== "image/jpeg" || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return false;
  let at = 2;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1];
    if (marker === 0xda || marker === 0xd9) return true; // the picture starts: no EXIF came before it
    const length = (b[at + 2] << 8) | b[at + 3];
    if (length < 2) return false;
    if (marker === 0xe1 && String.fromCharCode(...b.subarray(at + 4, at + 10)) === "Exif\0\0") return false;
    at += 2 + length;
  }
  return true;
}

export type ReceiptPhotoQr =
  /** The QR names the typed receipt: the original goes in at once. */
  | { kind: "matched" }
  /** The QR names a different receipt: refused. Never says the other receipt's code. */
  | { kind: "other_receipt"; serial: number }
  /** No receipt QR could be read: the original goes in as a hand entry and waits for review. */
  | { kind: "unread" };

/** What the QRs read from the photo say about the receipt typed. Every receipt QR in it must be the typed one. */
export function classifyReceiptPhotoQr(qrTexts: readonly string[], typed: { serial: number; code: string }): ReceiptPhotoQr {
  const tokens = qrTexts.map(parseReceiptQrText).filter((t): t is { serial: number; code: string } => t !== null);
  if (tokens.length === 0) return { kind: "unread" };
  const other = tokens.find((t) => t.serial !== typed.serial || t.code !== typed.code);
  return other ? { kind: "other_receipt", serial: other.serial } : { kind: "matched" };
}

/**
 * THE LIVE CAMERA'S LOCK (owner, 28 Nov 2026: the frame "تنور بالاخضر" once the receipt is recognised). The same
 * receipt read on RECEIPT_QR_READS_TO_LOCK frames, each within RECEIPT_QR_LOCK_WINDOW_MS of the one before, locks —
 * one stray read never does. A frame that reads nothing does not undo the reads before it: a hand-held phone at the
 * edge of focus reads, misses and reads again, and that must still lock. Original 2 must carry `expectedSerial`;
 * another receipt is "wrong_receipt" and starts the count again.
 */
export const RECEIPT_QR_READS_TO_LOCK = 2;
export const RECEIPT_QR_LOCK_WINDOW_MS = 2000;

export type ReceiptQrLock = { key: string; at: number; streak: number };
export const RECEIPT_QR_LOCK_START: ReceiptQrLock = { key: "", at: 0, streak: 0 };

export type ReceiptQrFrame =
  | { kind: "nothing"; lock: ReceiptQrLock }
  | { kind: "wrong_receipt"; serial: number; lock: ReceiptQrLock }
  | { kind: "reading"; lock: ReceiptQrLock }
  | { kind: "locked"; read: { serial: number; code: string }; lock: ReceiptQrLock };

/** One camera frame's read, carried into the lock. `read` is what parseReceiptQrText made of the frame's QR, if any. */
export function stepReceiptQrLock(
  lock: ReceiptQrLock,
  read: { serial: number; code: string } | null,
  now: number,
  expectedSerial: number | null,
): ReceiptQrFrame {
  if (!read) return { kind: "nothing", lock };
  if (expectedSerial !== null && read.serial !== expectedSerial) return { kind: "wrong_receipt", serial: read.serial, lock: RECEIPT_QR_LOCK_START };
  const key = `${read.serial}-${read.code}`;
  const streak = key === lock.key && now - lock.at <= RECEIPT_QR_LOCK_WINDOW_MS ? lock.streak + 1 : 1;
  const next = { key, at: now, streak };
  return streak >= RECEIPT_QR_READS_TO_LOCK ? { kind: "locked", read, lock: next } : { kind: "reading", lock: next };
}

export type HandEntryStatus = "pending" | "approved" | "rejected";

/**
 * What Phoenix writes on a waiting Original 2 when Original 1 is rejected: the whole receipt left the order, so the
 * Original 2 review is closed in the same instant (20261128134224, `direct_order_decide_hand_entry`). It is a closing
 * note, never the reviewer's reason — the migration must carry this exact text (pinned by the receipt test).
 */
export const RECEIPT_O2_CLOSED_WITH_O1_NOTE = "Original 1 was rejected, so the receipt was taken off the order.";

/**
 * What Phoenix writes on a hand entry still waiting when Finance takes its receipt off the order: closed, never
 * reviewed (20261128152929, `direct_order_release_receipt`), so it is never shown as a reason. The migration must
 * carry this exact text (pinned by the receipt test).
 */
export const RECEIPT_CLOSED_BY_RELEASE_NOTE = "Not reviewed: the receipt was taken off the order.";

const RECEIPT_HAND_ENTRY_CLOSING_NOTES = new Set([RECEIPT_O2_CLOSED_WITH_O1_NOTE, RECEIPT_CLOSED_BY_RELEASE_NOTE]);

export type RejectedHandEntryCandidate = {
  serial: number;
  original: "custody" | "delivery";
  status: HandEntryStatus;
  entered_by_hr_id: string;
  reviewed_by_hr_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
};

/**
 * THE REJECTION THE MANAGER IS SHOWN (owner, 28 Nov 2026: "it must show the manager the reason of the rejection,
 * the accurate reason"). The newest rejection a REVIEWER made, carrying the reason the reviewer wrote word for word,
 * while that original is still missing from the order:
 * - the closing note on an Original 2 that left with a rejected Original 1 is never it — the Original 1 decision is,
 *   and when both carry the same instant Original 1 comes first;
 * - a hand entry closed because Finance took its receipt off the order was never reviewed, so it is no rejection;
 * - a hand entry its own author closed (the original was never saved) is no rejection;
 * - Original 1 rejected: the receipt left the order, so it is said until a receipt is on the order again;
 * - Original 2 rejected: only for the receipt still on the order, its Original 1 there and its Original 2 missing —
 *   never for a receipt taken off since, or another receipt entered in its place.
 */
export function rejectionToShowManager<T extends RejectedHandEntryCandidate>(
  entries: readonly T[],
  onOrder: { serial: number; custody: string | null | undefined; delivery: string | null | undefined } | null,
): T | null {
  const decided = entries
    .filter(
      (e) =>
        e.status === "rejected" &&
        Boolean(e.reviewed_by_hr_id) &&
        e.reviewed_by_hr_id !== e.entered_by_hr_id &&
        !RECEIPT_HAND_ENTRY_CLOSING_NOTES.has((e.review_note ?? "").trim()),
    )
    .sort((a, b) => {
      const at = Date.parse(b.reviewed_at ?? "") - Date.parse(a.reviewed_at ?? "");
      if (Number.isFinite(at) && at !== 0) return at;
      return (a.original === "custody" ? 0 : 1) - (b.original === "custody" ? 0 : 1);
    });
  const newest = decided[0];
  if (!newest) return null;
  if (newest.original === "custody") return onOrder ? null : newest;
  return onOrder && Number(newest.serial) === onOrder.serial && onOrder.custody && !onOrder.delivery ? newest : null;
}
