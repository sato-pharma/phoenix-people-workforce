import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { canManageDirectOrderReceiptBooks } from "@/lib/direct-orders/finance-authority";
import { DIRECT_ORDER_INVOICE_BUCKET, parseDirectOrderInvoiceDataUrl } from "@/lib/direct-orders/invoice-evidence";
import {
  checkBookClose,
  checkBookIssue,
  checkReceiptForOrder,
  checkReceiptVoid,
  classifyOrderReceipt,
  daysSinceApproval,
  formatReceiptRange,
  formatReceiptSerial,
  normalizeReceiptCode,
  openBookFor,
  parseReceiptSerial,
  RECEIPT_OVERDUE_DAYS,
  type OrderForReceipt,
  type ReceiptBookRow,
  type ReceiptBookStatus,
  type ReceiptRow,
  type ReceiptStanding,
  type ReceiptState,
} from "@/lib/direct-orders/receipt-rules";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// The delivery-receipt books — reads and writes. Every decision is in receipt-rules.ts.
//
// 🔴 A receipt's check code NEVER leaves the server. No read here returns it, and the only place it
// is compared is checkReceiptForOrder. The codes are not in Git either: the rows are seeded from the
// printer's register by scripts/seed-direct-order-receipt-books.mjs.
// ─────────────────────────────────────────────────────────────────────────────

const BOOKS = "direct_order_receipt_books";
const RECEIPTS = "direct_order_receipts";
const BOOK_COLUMNS = "book_no,first_serial,last_serial,printed_holder_hr_id,holder_hr_id,status,issued_at,closed_at";
const PHOTO_TTL_SECONDS = 60 * 60;

type BookDbRow = {
  book_no: number;
  first_serial: number;
  last_serial: number;
  printed_holder_hr_id: string | null;
  holder_hr_id: string | null;
  status: ReceiptBookStatus;
  issued_at: string | null;
  closed_at: string | null;
};

function toBook(row: BookDbRow): ReceiptBookRow {
  return {
    bookNo: Number(row.book_no),
    firstSerial: Number(row.first_serial),
    lastSerial: Number(row.last_serial),
    printedHolderHrId: row.printed_holder_hr_id,
    holderHrId: row.holder_hr_id,
    status: row.status,
    issuedAt: row.issued_at,
    closedAt: row.closed_at,
  };
}

async function loadBooks(): Promise<ReceiptBookRow[]> {
  const { data, error } = await getSupabaseAdmin().from(BOOKS).select(BOOK_COLUMNS).order("book_no");
  if (error) throw error;
  return ((data ?? []) as BookDbRow[]).map(toBook);
}

async function loadBook(bookNo: number): Promise<ReceiptBookRow | null> {
  const { data, error } = await getSupabaseAdmin().from(BOOKS).select(BOOK_COLUMNS).eq("book_no", bookNo).maybeSingle();
  if (error) throw error;
  return data ? toBook(data as BookDbRow) : null;
}

async function loadReceipt(serial: number): Promise<ReceiptRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(RECEIPTS)
    .select("serial,book_no,check_code,state,request_id,voided_reason")
    .eq("serial", serial)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { serial: number; book_no: number; check_code: string; state: ReceiptState; request_id: string | null; voided_reason: string | null };
  return {
    serial: Number(row.serial),
    bookNo: Number(row.book_no),
    checkCode: row.check_code,
    state: row.state,
    requestId: row.request_id,
    voidedReason: row.voided_reason,
  };
}

async function loadOrder(requestId: string): Promise<OrderForReceipt | null> {
  if (!isUuid(requestId)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("direct_order_requests")
    .select("id,requester_hr_id,status,decided_at,reversal_of_request_id")
    .eq("id", requestId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { id: string; requester_hr_id: string; status: string; decided_at: string | null; reversal_of_request_id: string | null };
  return {
    id: row.id,
    requesterHrId: row.requester_hr_id,
    status: row.status,
    decidedAt: row.decided_at,
    reversalOfRequestId: row.reversal_of_request_id,
  };
}

type UsedReceiptDbRow = {
  serial: number;
  book_no: number;
  request_id: string;
  photo_storage_path: string | null;
  photo_content_type: string | null;
  used_by_hr_id: string | null;
  used_at: string | null;
};

async function loadReceiptForOrder(requestId: string): Promise<UsedReceiptDbRow | null> {
  const { data, error } = await getSupabaseAdmin()
    .from(RECEIPTS)
    .select("serial,book_no,request_id,photo_storage_path,photo_content_type,used_by_hr_id,used_at")
    .eq("request_id", requestId)
    .maybeSingle();
  if (error) throw error;
  return (data as UsedReceiptDbRow | null) ?? null;
}

async function insertOrderEvent(requestId: string, actorHrId: string | null, eventType: string, message: string, metadata: Record<string, unknown>) {
  const { error } = await getSupabaseAdmin()
    .from("direct_order_events")
    .insert({ request_id: requestId, actor_hr_id: hrIdForStorage(actorHrId), event_type: eventType, message, metadata });
  if (error) logError("Direct-order receipt event could not be written", { labels: { event: "direct_order_receipt_event_failed", eventType }, error });
}

function isRequester(access: AccessContext, order: OrderForReceipt): boolean {
  const viewer = canonicalHrIdKey(access.hrId);
  return viewer !== null && viewer === canonicalHrIdKey(order.requesterHrId);
}

// ─── The order's own panel ───────────────────────────────────────────────────

export type DirectOrderReceiptPanel = {
  standing: ReceiptStanding;
  daysSinceApproval: number | null;
  overdueDays: number;
  receipt: {
    serialLabel: string;
    bookNo: number;
    usedAt: string | null;
    usedByName: string | null;
    photoUrl: string | null;
    photoIsPdf: boolean;
  } | null;
  /** The book the requester writes from today, when the viewer may enter the receipt. */
  entryBook: { bookNo: number; rangeLabel: string } | null;
  /** Said when the order owes a receipt but the requester holds no open book to write it from. */
  noOpenBook: boolean;
};

/**
 * The receipt panel on an order. The caller has already proved the viewer may see the order (the
 * detail loader's scope); this decides only who may ENTER the receipt — the requester, or Finance.
 * Null when the books are not readable (said by the caller as nothing, never a false "no receipt").
 */
export async function loadDirectOrderReceiptPanel(access: AccessContext, requestId: string): Promise<DirectOrderReceiptPanel | null> {
  try {
    const order = await loadOrder(requestId);
    if (!order) return null;
    const [books, used] = await Promise.all([loadBooks(), loadReceiptForOrder(order.id)]);
    if (books.length === 0) return null;
    const now = new Date();
    const standing = classifyOrderReceipt({ order, books, hasReceipt: used !== null, now });

    let receipt: DirectOrderReceiptPanel["receipt"] = null;
    if (used) {
      const [names, signed] = await Promise.all([
        namesByHrId([used.used_by_hr_id]),
        used.photo_storage_path
          ? getSupabaseAdmin().storage.from(DIRECT_ORDER_INVOICE_BUCKET).createSignedUrl(used.photo_storage_path, PHOTO_TTL_SECONDS)
          : Promise.resolve(null),
      ]);
      receipt = {
        serialLabel: formatReceiptSerial(Number(used.serial)),
        bookNo: Number(used.book_no),
        usedAt: used.used_at,
        usedByName: names.get(used.used_by_hr_id),
        photoUrl: signed?.data?.signedUrl ?? null,
        photoIsPdf: used.photo_content_type === "application/pdf",
      };
    }

    const mayEnter = !used && order.status === "approved" && !order.reversalOfRequestId && (isRequester(access, order) || canManageDirectOrderReceiptBooks(access));
    const book = mayEnter ? openBookFor(order.requesterHrId, books) : null;
    return {
      standing,
      daysSinceApproval: daysSinceApproval(order.decidedAt, now),
      overdueDays: RECEIPT_OVERDUE_DAYS,
      receipt,
      entryBook: book ? { bookNo: book.bookNo, rangeLabel: formatReceiptRange(book.firstSerial, book.lastSerial) } : null,
      noOpenBook: mayEnter && !book && standing !== "not_required",
    };
  } catch (error) {
    logError("Direct-order receipt panel could not be read", { labels: { event: "direct_order_receipt_panel_failed", requestId }, error });
    return null;
  }
}

// ─── Entering a receipt ──────────────────────────────────────────────────────

/**
 * The manager enters the receipt that proves this order: serial, code and a photo of the signed,
 * stamped page. Stored only when every rule passes, then claimed with a compare-and-set (`state` is
 * still unused, `request_id` still empty) so two presses — or two managers with a photocopy — can
 * never both win. The order's unique `request_id` stops one order taking two receipts.
 */
export async function recordDirectOrderReceipt(
  access: AccessContext,
  input: { requestId: string; serial: unknown; code: unknown; photoDataUrl: unknown },
): Promise<{ message: string; serialLabel: string }> {
  // Signed out or a role with no direct orders is refused before the order is looked up, so the
  // answer never says whether an order id exists.
  await assertPermission(access, "direct_orders", "read");
  const order = await loadOrder(input.requestId);
  if (!order) throw notFoundError("This direct order was not found.");
  if (!isRequester(access, order) && !canManageDirectOrderReceiptBooks(access)) {
    throw forbiddenError("Only the manager who raised this order, or Finance, enters its receipt.");
  }
  const serial = parseReceiptSerial(input.serial);
  if (serial === null) throw validationError("Type the receipt number printed at the top of the page — six digits.");
  const code = normalizeReceiptCode(input.code);
  if (!code) throw validationError("Type the six-character code printed beside the receipt number.");

  const receipt = await loadReceipt(serial);
  const [book, existing] = await Promise.all([receipt ? loadBook(receipt.bookNo) : Promise.resolve(null), loadReceiptForOrder(order.id)]);
  const decision = checkReceiptForOrder({
    order,
    serial,
    typedCode: code,
    receipt,
    book,
    orderReceiptSerial: existing ? Number(existing.serial) : null,
  });
  if (!decision.ok) {
    // Every refusal is written on the order: a run of wrong codes is the trace of someone trying pages.
    await insertOrderEvent(order.id, access.hrId, "receipt_refused", decision.message, { serial, reason: decision.reason });
    throw decision.reason === "receipt_used" || decision.reason === "order_has_receipt"
      ? conflictError(decision.message)
      : validationError(decision.message);
  }

  let photo;
  try {
    photo = parseDirectOrderInvoiceDataUrl(input.photoDataUrl);
  } catch {
    throw validationError("Attach a clear photo of the signed and stamped receipt page.");
  }

  const supabase = getSupabaseAdmin();
  const now = new Date();
  const path = `receipts/${order.id}/${formatReceiptSerial(serial)}-${now.getTime()}.${photo.extension}`;
  const { error: uploadError } = await supabase.storage
    .from(DIRECT_ORDER_INVOICE_BUCKET)
    .upload(path, photo.bytes, { contentType: photo.contentType, upsert: false });
  if (uploadError) throw uploadError;

  const { data: claimed, error: claimError } = await supabase
    .from(RECEIPTS)
    .update({
      state: "used",
      request_id: order.id,
      photo_storage_path: path,
      photo_content_type: photo.contentType,
      used_by_hr_id: hrIdForStorage(access.hrId),
      used_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("serial", serial)
    .eq("state", "unused")
    .is("request_id", null)
    .select("serial");
  if (claimError || !claimed || claimed.length === 0) {
    await supabase.storage.from(DIRECT_ORDER_INVOICE_BUCKET).remove([path]).catch(() => undefined);
    const code23505 = (claimError as { code?: string } | null)?.code === "23505";
    if (claimError && !code23505) throw claimError;
    throw conflictError(
      code23505
        ? "This order already has a receipt. An order takes one receipt."
        : `Receipt ${formatReceiptSerial(serial)} was just used on another order. A receipt proves one order only.`,
    );
  }

  const serialLabel = formatReceiptSerial(serial);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: order.id,
    newValues: { receiptSerial: serialLabel, receiptBook: receipt?.bookNo ?? null, photoPath: path },
    summary: `Delivery receipt ${serialLabel} entered for the direct order.`,
  });
  await insertOrderEvent(order.id, access.hrId, "receipt_recorded", `Delivery receipt ${serialLabel} entered.`, { serial, bookNo: receipt?.bookNo ?? null });
  return { message: `Receipt ${serialLabel} is saved with the order. It can never be used on another order.`, serialLabel };
}

// ─── Finance: the register ───────────────────────────────────────────────────

export type ReceiptRegisterBook = {
  bookNo: number;
  rangeLabel: string;
  status: ReceiptBookStatus;
  holderHrId: string | null;
  holderName: string | null;
  printedHolderName: string | null;
  printedHolderHrId: string | null;
  issuedAt: string | null;
  closedAt: string | null;
  used: number;
  voided: number;
  unused: number;
};

export type ReceiptRegisterOrder = {
  requestId: string;
  requesterName: string;
  pharmacyName: string;
  productName: string;
  salesValue: number;
  decidedAt: string | null;
  days: number;
  standing: "waiting" | "overdue";
};

export type ReceiptRegisterEntry = {
  serialLabel: string;
  bookNo: number;
  requestId: string | null;
  state: ReceiptState;
  byName: string | null;
  at: string | null;
  pharmacyName: string | null;
  voidedReason: string | null;
};

export type DirectOrderReceiptRegister = {
  books: ReceiptRegisterBook[];
  missing: ReceiptRegisterOrder[];
  recent: ReceiptRegisterEntry[];
  overdueDays: number;
  /** Everyone a spare book may be handed to: District Managers on a line with direct orders, still employed. */
  holderOptions: { hrId: string; name: string }[];
};

/** Finance's desk. Refuses anyone who is not Finance or the Administrator. */
export async function loadDirectOrderReceiptRegister(access: AccessContext): Promise<DirectOrderReceiptRegister> {
  if (!canManageDirectOrderReceiptBooks(access)) throw forbiddenError("The receipt register is Finance's.");
  const supabase = getSupabaseAdmin();
  const books = await loadBooks();

  const [{ data: receiptRows, error: receiptError }, ordersResult, holdersResult] = await Promise.all([
    supabase.from(RECEIPTS).select("serial,book_no,state,request_id,used_by_hr_id,used_at,voided_by_hr_id,voided_at,voided_reason").neq("state", "unused").order("serial"),
    loadApprovedOrdersOfHolders(books),
    supabase
      .from("employees")
      .select("hr_id,full_name,job_title,employment_status")
      .eq("job_title", "District Sales Manager")
      .in("employment_status", ["active", "on_leave"]),
  ]);
  if (receiptError) throw receiptError;
  const touched = (receiptRows ?? []) as {
    serial: number; book_no: number; state: ReceiptState; request_id: string | null; used_by_hr_id: string | null;
    used_at: string | null; voided_by_hr_id: string | null; voided_at: string | null; voided_reason: string | null;
  }[];

  const counts = new Map<number, { used: number; voided: number }>();
  for (const row of touched) {
    const entry = counts.get(Number(row.book_no)) ?? { used: 0, voided: 0 };
    if (row.state === "used") entry.used += 1;
    else if (row.state === "voided") entry.voided += 1;
    counts.set(Number(row.book_no), entry);
  }
  const receiptByOrder = new Set(touched.filter((row) => row.request_id).map((row) => row.request_id as string));

  const now = new Date();
  const orders = ordersResult;
  const missingOrders = orders
    .map((row) => ({ row, standing: classifyOrderReceipt({ order: row.order, books, hasReceipt: receiptByOrder.has(row.order.id), now }) }))
    .filter((entry): entry is { row: typeof entry.row; standing: "waiting" | "overdue" } => entry.standing === "waiting" || entry.standing === "overdue");

  const pharmacyIds = [...new Set([...missingOrders.map((entry) => entry.row.pharmacyId), ...orders.filter((o) => receiptByOrder.has(o.order.id)).map((o) => o.pharmacyId)])];
  const pharmacyNames = new Map<string, string>();
  for (let start = 0; start < pharmacyIds.length; start += 100) {
    const { data } = await supabase.from("direct_order_pharmacies").select("id,pharmacy_name").in("id", pharmacyIds.slice(start, start + 100));
    for (const row of (data ?? []) as { id: string; pharmacy_name: string | null }[]) pharmacyNames.set(row.id, String(row.pharmacy_name ?? "").trim());
  }
  const pharmacyByOrder = new Map(orders.map((o) => [o.order.id, pharmacyNames.get(o.pharmacyId) ?? null]));

  const names = await namesByHrId([
    ...books.flatMap((book) => [book.holderHrId, book.printedHolderHrId]),
    ...orders.map((o) => o.order.requesterHrId),
    ...touched.flatMap((row) => [row.used_by_hr_id, row.voided_by_hr_id]),
  ]);

  const holderOptions = (((holdersResult.data ?? []) as { hr_id: string; full_name: string | null }[]))
    .map((row) => ({ hrId: hrIdForStorage(row.hr_id) ?? row.hr_id, name: names.get(row.hr_id) ?? String(row.full_name ?? row.hr_id) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    overdueDays: RECEIPT_OVERDUE_DAYS,
    holderOptions,
    books: books.map((book) => {
      const count = counts.get(book.bookNo) ?? { used: 0, voided: 0 };
      const size = book.lastSerial - book.firstSerial + 1;
      return {
        bookNo: book.bookNo,
        rangeLabel: formatReceiptRange(book.firstSerial, book.lastSerial),
        status: book.status,
        holderHrId: book.holderHrId,
        holderName: book.holderHrId ? names.get(book.holderHrId) ?? book.holderHrId : null,
        printedHolderHrId: book.printedHolderHrId,
        printedHolderName: book.printedHolderHrId ? names.get(book.printedHolderHrId) ?? book.printedHolderHrId : null,
        issuedAt: book.issuedAt,
        closedAt: book.closedAt,
        used: count.used,
        voided: count.voided,
        unused: size - count.used - count.voided,
      };
    }),
    missing: missingOrders
      .map(({ row, standing }) => ({
        requestId: row.order.id,
        requesterName: names.get(row.order.requesterHrId) ?? row.order.requesterHrId,
        pharmacyName: pharmacyNames.get(row.pharmacyId) || "Pharmacy not on file",
        productName: row.productName,
        salesValue: row.salesValue,
        decidedAt: row.order.decidedAt,
        days: daysSinceApproval(row.order.decidedAt, now) ?? 0,
        standing,
      }))
      .sort((a, b) => b.days - a.days),
    recent: touched
      .map((row) => ({
        serialLabel: formatReceiptSerial(Number(row.serial)),
        bookNo: Number(row.book_no),
        requestId: row.request_id,
        state: row.state,
        byName: names.get(row.state === "used" ? row.used_by_hr_id : row.voided_by_hr_id),
        at: row.state === "used" ? row.used_at : row.voided_at,
        pharmacyName: row.request_id ? pharmacyByOrder.get(row.request_id) ?? null : null,
        voidedReason: row.voided_reason,
      }))
      .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")))
      .slice(0, 60),
  };
}

type HolderOrder = { order: OrderForReceipt; pharmacyId: string; productName: string; salesValue: number };

/** Approved orders of everyone who ever held a book, decided on or after the earliest issue date. */
async function loadApprovedOrdersOfHolders(books: readonly ReceiptBookRow[]): Promise<HolderOrder[]> {
  const issued = books.filter((book) => book.issuedAt && book.holderHrId);
  if (issued.length === 0) return [];
  const since = issued.map((book) => book.issuedAt as string).sort()[0];
  const holderKeys = new Set(issued.map((book) => canonicalHrIdKey(book.holderHrId)));
  const rows: HolderOrder[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await getSupabaseAdmin()
      .from("direct_order_requests")
      .select("id,requester_hr_id,status,decided_at,reversal_of_request_id,pharmacy_id,product_name,sales_value")
      .eq("status", "approved")
      .is("reversal_of_request_id", null)
      .gte("decided_at", since)
      .order("decided_at")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as {
      id: string; requester_hr_id: string; status: string; decided_at: string | null; reversal_of_request_id: string | null;
      pharmacy_id: string; product_name: string | null; sales_value: number | null;
    }[];
    for (const row of page) {
      if (!holderKeys.has(canonicalHrIdKey(row.requester_hr_id))) continue;
      rows.push({
        order: { id: row.id, requesterHrId: row.requester_hr_id, status: row.status, decidedAt: row.decided_at, reversalOfRequestId: row.reversal_of_request_id },
        pharmacyId: row.pharmacy_id,
        productName: String(row.product_name ?? ""),
        salesValue: Number(row.sales_value ?? 0),
      });
    }
    if (page.length < pageSize) break;
  }
  return rows;
}

// ─── Finance: book custody and spoiled pages ─────────────────────────────────

function parseBookNo(raw: unknown): number {
  const bookNo = Number(raw);
  if (!Number.isInteger(bookNo) || bookNo < 1 || bookNo > 999) throw validationError("Choose a receipt book.");
  return bookNo;
}

/** Finance hands a book to its manager. The issue date is the cutover: orders approved before it owe no receipt. */
export async function issueDirectOrderReceiptBook(access: AccessContext, input: { bookNo: unknown; holderHrId: unknown }): Promise<{ message: string }> {
  if (!canManageDirectOrderReceiptBooks(access)) throw forbiddenError("Only Finance hands out receipt books.");
  const bookNo = parseBookNo(input.bookNo);
  const book = await loadBook(bookNo);
  const holder = String(input.holderHrId ?? book?.printedHolderHrId ?? "").trim();
  const decision = checkBookIssue(book, holder);
  if (!decision.ok) throw validationError(decision.message);
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(BOOKS)
    .update({ status: "issued", holder_hr_id: hrIdForStorage(holder), issued_at: now, issued_by_hr_id: hrIdForStorage(access.hrId), updated_at: now })
    .eq("book_no", bookNo)
    .eq("status", "in_store")
    .select("book_no");
  if (error) throw error;
  if (!data || data.length === 0) throw conflictError(`Book ${bookNo} was just handed out by someone else.`);
  const names = await namesByHrId([holder]);
  const holderName = names.get(holder) ?? holder;
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_receipt_book",
    entityId: String(bookNo),
    oldValues: { status: "in_store" },
    newValues: { status: "issued", holderHrId: hrIdForStorage(holder), issuedAt: now },
    summary: `Receipt book ${bookNo} handed to ${holderName}.`,
  });
  return { message: `Book ${bookNo} is recorded as handed to ${holderName} today. Every order approved from now on needs a receipt from it.` };
}

/** Finance takes a book back, or records it lost. Lost cancels every receipt in it still unused. */
export async function closeDirectOrderReceiptBook(
  access: AccessContext,
  input: { bookNo: unknown; kind: unknown; note: unknown },
): Promise<{ message: string }> {
  if (!canManageDirectOrderReceiptBooks(access)) throw forbiddenError("Only Finance takes back or records a receipt book lost.");
  const bookNo = parseBookNo(input.bookNo);
  const kind = input.kind === "lost" ? "lost" : input.kind === "returned" ? "returned" : null;
  if (!kind) throw validationError("Choose returned or lost.");
  const note = String(input.note ?? "").trim().slice(0, 500) || null;
  if (kind === "lost" && !note) throw validationError("Write what happened to the book.");
  const book = await loadBook(bookNo);
  const decision = checkBookClose(book, kind);
  if (!decision.ok) throw validationError(decision.message);
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from(BOOKS)
    .update({ status: kind, closed_at: now, closed_by_hr_id: hrIdForStorage(access.hrId), note, updated_at: now })
    .eq("book_no", bookNo)
    .eq("status", book?.status ?? "issued")
    .select("book_no");
  if (error) throw error;
  if (!data || data.length === 0) throw conflictError(`Book ${bookNo} was just changed by someone else. Reload the page.`);
  let voided = 0;
  if (kind === "lost") {
    const { data: voidedRows, error: voidError } = await supabase
      .from(RECEIPTS)
      .update({ state: "voided", voided_reason: `Book ${bookNo} reported lost`, voided_by_hr_id: hrIdForStorage(access.hrId), voided_at: now, updated_at: now })
      .eq("book_no", bookNo)
      .eq("state", "unused")
      .select("serial");
    if (voidError) throw voidError;
    voided = voidedRows?.length ?? 0;
  }
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_receipt_book",
    entityId: String(bookNo),
    oldValues: { status: book?.status ?? null },
    newValues: { status: kind, closedAt: now, note, receiptsCancelled: voided },
    summary: kind === "lost" ? `Receipt book ${bookNo} recorded lost; ${voided} unused receipts cancelled.` : `Receipt book ${bookNo} returned to Finance.`,
  });
  return {
    message:
      kind === "lost"
        ? `Book ${bookNo} is recorded lost. Its ${voided} unused receipts are cancelled, so a page from it will be refused.`
        : `Book ${bookNo} is recorded as returned. Its unused receipts can no longer be used.`,
  };
}

/** Finance cancels a spoiled page found in a book. A used receipt is never cancelled. */
export async function voidDirectOrderReceipt(access: AccessContext, input: { serial: unknown; reason: unknown }): Promise<{ message: string }> {
  if (!canManageDirectOrderReceiptBooks(access)) throw forbiddenError("Only Finance cancels a receipt.");
  const serial = parseReceiptSerial(input.serial);
  if (serial === null) throw validationError("Type the six-digit receipt number.");
  const reason = String(input.reason ?? "").trim().slice(0, 300);
  const receipt = await loadReceipt(serial);
  const decision = checkReceiptVoid(receipt, reason);
  if (!decision.ok) throw validationError(decision.message);
  const now = new Date().toISOString();
  const { data, error } = await getSupabaseAdmin()
    .from(RECEIPTS)
    .update({ state: "voided", voided_reason: reason, voided_by_hr_id: hrIdForStorage(access.hrId), voided_at: now, updated_at: now })
    .eq("serial", serial)
    .eq("state", "unused")
    .select("serial");
  if (error) throw error;
  if (!data || data.length === 0) throw conflictError(`Receipt ${formatReceiptSerial(serial)} was just used or cancelled. Reload the page.`);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_receipt_book",
    entityId: formatReceiptSerial(serial),
    oldValues: { state: "unused" },
    newValues: { state: "voided", reason },
    summary: `Receipt ${formatReceiptSerial(serial)} cancelled: ${reason}`,
  });
  return { message: `Receipt ${formatReceiptSerial(serial)} is cancelled. It will be refused on any order.` };
}
