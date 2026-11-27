import { assertPermission, type AccessContext } from "@/lib/auth/permissions";
import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { canDecideDirectOrderWithoutReceipt, canManageDirectOrderReceiptBooks } from "@/lib/direct-orders/finance-authority";
import { DIRECT_ORDER_INVOICE_BUCKET, parseDirectOrderInvoiceDataUrl } from "@/lib/direct-orders/invoice-evidence";
import {
  bookHeldAtApproval,
  checkBookClose,
  checkBookIssue,
  checkNoReceiptAsk,
  checkNoReceiptDecision,
  checkReceiptForOrder,
  checkReceiptRelease,
  checkReceiptVoid,
  classifyOrderReceipt,
  daysSinceApproval,
  formatReceiptRange,
  formatReceiptSerial,
  normalizeReceiptCode,
  parseReceiptSerial,
  RECEIPT_OVERDUE_DAYS,
  receiptEntryBookFor,
  receiptRolloutStart,
  type NoReceiptRow,
  type NoReceiptStatus,
  type OrderForReceipt,
  type ReceiptAttemptRefusal,
  type ReceiptBookRow,
  type ReceiptBookStatus,
  type ReceiptRow,
  type ReceiptStanding,
  type ReceiptState,
} from "@/lib/direct-orders/receipt-rules";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { canonicalHrIdKey, hrIdForStorage, hrIdLookupKeys } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// ─────────────────────────────────────────────────────────────────────────────
// The delivery-receipt books — reads and writes. Every decision is in receipt-rules.ts.
//
// 🔴 A receipt's check code NEVER leaves the server. No read here returns it, and the only place it
// is compared is checkReceiptForOrder. The codes are not in Git either: the rows were seeded once
// from the printer's register.json, which is kept off GitHub with the printed books.
//
// The database guards the paper as well (migration 20261127121951): a used receipt goes back to
// unused only through direct_order_release_receipt, a cancelled one stays cancelled, a receipt is
// claimed only while its book is with a manager or returned, and no receipt or book is ever deleted.
// ─────────────────────────────────────────────────────────────────────────────

const BOOKS = "direct_order_receipt_books";
const RECEIPTS = "direct_order_receipts";
const BOOK_COLUMNS = "book_no,first_serial,last_serial,printed_holder_hr_id,holder_hr_id,status,issued_at,closed_at";
const PHOTO_TTL_SECONDS = 60 * 60;
/** The database guard's refusal (raise ... using errcode 'P0001'). */
const GUARD_REFUSED = "P0001";

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

// ─── An order without a receipt: Finance asks, the CEO decides ───────────────

const NO_RECEIPT = "direct_order_no_receipt_requests";
const NO_RECEIPT_COLUMNS = "id,request_id,reason,asked_by_hr_id,asked_at,status,decided_by_hr_id,decided_at,decision_note";

type NoReceiptDbRow = {
  id: string;
  request_id: string;
  reason: string;
  asked_by_hr_id: string;
  asked_at: string;
  status: NoReceiptStatus;
  decided_by_hr_id: string | null;
  decided_at: string | null;
  decision_note: string | null;
};

function toNoReceipt(row: NoReceiptDbRow): NoReceiptRow {
  return {
    id: row.id,
    requestId: row.request_id,
    reason: row.reason,
    askedByHrId: row.asked_by_hr_id,
    askedAt: row.asked_at,
    status: row.status,
    decidedByHrId: row.decided_by_hr_id,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
  };
}

/** Every ask on one order, newest first. */
async function loadNoReceiptAsks(requestId: string): Promise<NoReceiptRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from(NO_RECEIPT)
    .select(NO_RECEIPT_COLUMNS)
    .eq("request_id", requestId)
    .order("asked_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as NoReceiptDbRow[]).map(toNoReceipt);
}

/** The ask still waiting or approved — at most one, by the database's own unique index. */
function liveAsk(asks: readonly NoReceiptRow[]): NoReceiptRow | null {
  return asks.find((ask) => ask.status !== "refused") ?? null;
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
  /** The book the receipt is written from, when the viewer may enter it: the open book, or a returned one (late entry). */
  entryBook: { bookNo: number; rangeLabel: string; returned: boolean } | null;
  /** Said when the order owes a receipt but the requester holds no open book to write it from. */
  noOpenBook: boolean;
  /** Finance may take the receipt off this order, with a written reason (owner, 27 Nov 2026: "make an undo option"). */
  mayRelease: boolean;
  /** The newest ask to let this order stand without a receipt: waiting, approved, or the last refusal. */
  withoutReceipt: {
    status: NoReceiptStatus;
    reason: string;
    askedByName: string | null;
    askedAt: string;
    decidedByName: string | null;
    decidedAt: string | null;
    note: string | null;
  } | null;
  /** Finance may ask the CEO to let this order stand without a receipt. */
  mayAskWithoutReceipt: boolean;
  /** The CEO may decide the ask waiting on this order (owner, 27 Nov 2026: the CEO's authority alone). */
  mayDecideWithoutReceipt: boolean;
};

/** The receipt could not be read: said on the order as such, never as "no receipt". */
export type DirectOrderReceiptPanelUnavailable = { unavailable: true };

/**
 * The receipt panel on an order. The caller has already proved the viewer may see the order (the
 * detail loader's scope); this decides only who may ENTER the receipt — the requester, or Finance.
 * Null when the order is not found or no book exists yet; `{ unavailable: true }` when the books could
 * not be read, so the order says so instead of hiding the receipt.
 */
export async function loadDirectOrderReceiptPanel(
  access: AccessContext,
  requestId: string,
): Promise<DirectOrderReceiptPanel | DirectOrderReceiptPanelUnavailable | null> {
  try {
    const order = await loadOrder(requestId);
    if (!order) return null;
    const [books, used, asks] = await Promise.all([loadBooks(), loadReceiptForOrder(order.id), loadNoReceiptAsks(order.id)]);
    if (books.length === 0) return null;
    const now = new Date();
    const live = liveAsk(asks);
    const standing = classifyOrderReceipt({ order, books, hasReceipt: used !== null, now, withoutReceiptApproved: live?.status === "approved" });
    const shownAsk = live ?? asks[0] ?? null;
    const names = await namesByHrId([used?.used_by_hr_id ?? null, shownAsk?.askedByHrId ?? null, shownAsk?.decidedByHrId ?? null]);

    let receipt: DirectOrderReceiptPanel["receipt"] = null;
    if (used) {
      const signed = used.photo_storage_path
        ? await getSupabaseAdmin().storage.from(DIRECT_ORDER_INVOICE_BUCKET).createSignedUrl(used.photo_storage_path, PHOTO_TTL_SECONDS)
        : null;
      receipt = {
        serialLabel: formatReceiptSerial(Number(used.serial)),
        bookNo: Number(used.book_no),
        usedAt: used.used_at,
        usedByName: names.get(used.used_by_hr_id),
        photoUrl: signed?.data?.signedUrl ?? null,
        photoIsPdf: used.photo_content_type === "application/pdf",
      };
    }

    const mayEnter =
      !used &&
      standing !== "without_receipt" &&
      order.status === "approved" &&
      !order.reversalOfRequestId &&
      (isRequester(access, order) || canManageDirectOrderReceiptBooks(access));
    const book = mayEnter ? receiptEntryBookFor(order, books) : null;
    return {
      standing,
      daysSinceApproval: daysSinceApproval(order.decidedAt, now),
      overdueDays: RECEIPT_OVERDUE_DAYS,
      receipt,
      entryBook: book
        ? { bookNo: book.bookNo, rangeLabel: formatReceiptRange(book.firstSerial, book.lastSerial), returned: book.status === "returned" }
        : null,
      noOpenBook: mayEnter && !book && standing !== "not_required",
      mayRelease: used !== null && canManageDirectOrderReceiptBooks(access),
      withoutReceipt: shownAsk
        ? {
            status: shownAsk.status,
            reason: shownAsk.reason,
            askedByName: names.get(shownAsk.askedByHrId),
            askedAt: shownAsk.askedAt,
            decidedByName: shownAsk.decidedByHrId ? names.get(shownAsk.decidedByHrId) : null,
            decidedAt: shownAsk.decidedAt,
            note: shownAsk.decisionNote,
          }
        : null,
      mayAskWithoutReceipt: canManageDirectOrderReceiptBooks(access) && checkNoReceiptAsk({ standing, live, reason: "asking" }).ok,
      mayDecideWithoutReceipt: canDecideDirectOrderWithoutReceipt(access) && live?.status === "pending",
    };
  } catch (error) {
    logError("Direct-order receipt panel could not be read", { labels: { event: "direct_order_receipt_panel_failed", requestId }, error });
    return { unavailable: true };
  }
}

// ─── Entering a receipt ──────────────────────────────────────────────────────

/** Written on the order for every refused attempt: a run of them is the trace of someone trying pages. Never the typed code. */
async function recordRefusal(order: OrderForReceipt, access: AccessContext, reason: ReceiptAttemptRefusal, message: string, serial: number | null) {
  await insertOrderEvent(order.id, access.hrId, "receipt_refused", message, { serial, reason });
}

/**
 * The manager enters the receipt that proves this order: serial, code and a photo of the signed,
 * stamped page. Stored only when every rule passes, then claimed with a compare-and-set (`state` is
 * still unused, `request_id` still empty) so two presses — or two managers with a photocopy — can
 * never both win. The order's unique `request_id` stops one order taking two receipts, and the
 * database guard re-reads the book inside the claim, so a book recorded lost while the photo
 * uploads can no longer be claimed from.
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
    const message = "Only the manager who raised this order, or Finance, enters its receipt.";
    await recordRefusal(order, access, "not_allowed", message, parseReceiptSerial(input.serial));
    throw forbiddenError(message);
  }
  const serial = parseReceiptSerial(input.serial);
  if (serial === null) {
    const message = "Type the receipt number printed at the top of the page — six digits.";
    await recordRefusal(order, access, "bad_serial", message, null);
    throw validationError(message);
  }
  const code = normalizeReceiptCode(input.code);
  if (!code) {
    const message = "Type the six-character code printed beside the receipt number.";
    await recordRefusal(order, access, "bad_code", message, serial);
    throw validationError(message);
  }

  const receipt = await loadReceipt(serial);
  const [book, existing, asks] = await Promise.all([
    receipt ? loadBook(receipt.bookNo) : Promise.resolve(null),
    loadReceiptForOrder(order.id),
    loadNoReceiptAsks(order.id),
  ]);
  const decision = checkReceiptForOrder({
    order,
    serial,
    typedCode: code,
    receipt,
    book,
    orderReceiptSerial: existing ? Number(existing.serial) : null,
    withoutReceiptApproved: liveAsk(asks)?.status === "approved",
  });
  if (!decision.ok) {
    await recordRefusal(order, access, decision.reason, decision.message, serial);
    throw decision.reason === "receipt_used" || decision.reason === "order_has_receipt"
      ? conflictError(decision.message)
      : validationError(decision.message);
  }

  let photo;
  try {
    photo = parseDirectOrderInvoiceDataUrl(input.photoDataUrl);
  } catch {
    const message = "Attach a clear photo of the signed and stamped receipt page.";
    await recordRefusal(order, access, "bad_photo", message, serial);
    throw validationError(message);
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
    const errorCode = (claimError as { code?: string } | null)?.code;
    if (claimError && errorCode !== "23505" && errorCode !== GUARD_REFUSED) throw claimError;
    const reason: ReceiptAttemptRefusal = errorCode === "23505" ? "order_has_receipt" : errorCode === GUARD_REFUSED ? "book_changed" : "claim_lost";
    const message =
      reason === "order_has_receipt"
        ? "This order already has a receipt. An order takes one receipt."
        : reason === "book_changed"
          ? `Book ${receipt?.bookNo ?? ""} was returned or recorded lost while the photo was uploading, so receipt ${formatReceiptSerial(serial)} was not saved. Reload the order.`
          : `Receipt ${formatReceiptSerial(serial)} was just used on another order. A receipt proves one order only.`;
    await recordRefusal(order, access, reason, message, serial);
    throw conflictError(message);
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

/**
 * Finance takes a receipt off the order it was entered on by mistake (owner, 27 Nov 2026: "make an
 * undo option"). Finance or the Administrator only, always with a written reason. The receipt goes
 * back to unused so it can be entered on the right order; the release, its reason and the photo it
 * carried are kept for ever in direct_order_receipt_releases, the audit log and the order's history.
 */
export async function releaseDirectOrderReceipt(access: AccessContext, input: { requestId: string; reason: unknown }): Promise<{ message: string }> {
  if (!canManageDirectOrderReceiptBooks(access)) throw forbiddenError("Only Finance can take a receipt off an order.");
  const order = await loadOrder(input.requestId);
  if (!order) throw notFoundError("This direct order was not found.");
  const reason = String(input.reason ?? "").trim().slice(0, 300);
  const used = await loadReceiptForOrder(order.id);
  const receipt = used ? await loadReceipt(Number(used.serial)) : null;
  const decision = checkReceiptRelease({ receipt, requestId: order.id, reason });
  if (!decision.ok) throw validationError(decision.message);
  const serial = Number(receipt?.serial);
  const serialLabel = formatReceiptSerial(serial);
  const actor = hrIdForStorage(access.hrId) ?? access.loginId ?? "system";
  const { data, error } = await getSupabaseAdmin().rpc("direct_order_release_receipt", {
    p_serial: serial,
    p_request_id: order.id,
    p_actor_hr_id: actor,
    p_reason: reason,
  });
  if (error) throw error;
  const result = (data ?? {}) as { released?: boolean; photo_storage_path?: string | null; used_by_hr_id?: string | null; used_at?: string | null };
  if (!result.released) throw conflictError(`Receipt ${serialLabel} on this order was just changed by someone else. Reload the page.`);
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: order.id,
    oldValues: { receiptSerial: serialLabel, photoPath: result.photo_storage_path ?? null, enteredBy: result.used_by_hr_id ?? null, enteredAt: result.used_at ?? null },
    newValues: { receiptSerial: null, reason },
    summary: `Delivery receipt ${serialLabel} taken off the direct order: ${reason}`,
  });
  await insertOrderEvent(order.id, access.hrId, "receipt_released", `Delivery receipt ${serialLabel} taken off this order: ${reason}`, { serial, reason });
  return { message: `Receipt ${serialLabel} is taken off this order and can now be entered on the right one. The reason is kept on the order's history.` };
}

/**
 * Finance asks the CEO to let an approved order stand without a delivery receipt (owner, 27 Nov 2026:
 * the CEO's authority alone, carried out through Finance). Finance or the Administrator only, always
 * with a written reason; nothing changes on the order until the CEO approves it.
 */
export async function askDirectOrderWithoutReceipt(access: AccessContext, input: { requestId: string; reason: unknown }): Promise<{ message: string }> {
  await assertPermission(access, "direct_orders", "read");
  if (!canManageDirectOrderReceiptBooks(access)) throw forbiddenError("Only Finance asks the CEO to let an order stand without a receipt.");
  const order = await loadOrder(input.requestId);
  if (!order) throw notFoundError("This direct order was not found.");
  const reason = String(input.reason ?? "").trim().slice(0, 500);
  const [books, used, asks] = await Promise.all([loadBooks(), loadReceiptForOrder(order.id), loadNoReceiptAsks(order.id)]);
  const live = liveAsk(asks);
  const standing = classifyOrderReceipt({ order, books, hasReceipt: used !== null, now: new Date(), withoutReceiptApproved: live?.status === "approved" });
  const decision = checkNoReceiptAsk({ standing, live, reason });
  if (!decision.ok) throw live ? conflictError(decision.message) : validationError(decision.message);
  const actor = hrIdForStorage(access.hrId) ?? access.loginId ?? "system";
  const { error } = await getSupabaseAdmin().from(NO_RECEIPT).insert({ request_id: order.id, reason, asked_by_hr_id: actor });
  if (error) {
    if ((error as { code?: string }).code === "23505") throw conflictError("A request for this order is already waiting for the CEO's decision.");
    throw error;
  }
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: order.id,
    newValues: { withoutReceipt: "asked", reason },
    summary: `Finance asked the CEO to let the direct order stand without a delivery receipt: ${reason}`,
  });
  await insertOrderEvent(order.id, access.hrId, "receipt_waiver_asked", `Asked the CEO to let this order stand without a delivery receipt: ${reason}`, { reason });
  return { message: "Sent to the CEO. The order stands without a receipt only once the CEO approves it." };
}

/**
 * The CEO approves or refuses an order standing without a delivery receipt. The CEO alone — no Super
 * Admin override. A refusal always says why. The decision is final on that ask: the database refuses
 * any later change, and a refused order may only be asked again, as a new request.
 */
export async function decideDirectOrderWithoutReceipt(
  access: AccessContext,
  input: { requestId: string; decision: unknown; note: unknown },
): Promise<{ message: string }> {
  await assertPermission(access, "direct_orders", "read");
  if (!canDecideDirectOrderWithoutReceipt(access)) throw forbiddenError("Only the CEO decides whether an order may stand without a receipt.");
  const order = await loadOrder(input.requestId);
  if (!order) throw notFoundError("This direct order was not found.");
  const note = String(input.note ?? "").trim().slice(0, 500);
  const [used, asks] = await Promise.all([loadReceiptForOrder(order.id), loadNoReceiptAsks(order.id)]);
  const live = liveAsk(asks);
  const checked = checkNoReceiptDecision({ live, hasReceipt: used !== null, decision: input.decision, note });
  if (!checked.ok || !live) throw validationError(checked.ok ? "There is no request on this order waiting for a decision." : checked.message);
  const actor = hrIdForStorage(access.hrId) ?? access.loginId ?? "system";
  const { data, error } = await getSupabaseAdmin()
    .from(NO_RECEIPT)
    .update({ status: checked.decision, decided_by_hr_id: actor, decided_at: new Date().toISOString(), decision_note: note || null })
    .eq("id", live.id)
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw conflictError("This request was just decided. Reload the page.");
  const approved = checked.decision === "approved";
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_request",
    entityId: order.id,
    oldValues: { withoutReceipt: "pending", reason: live.reason },
    newValues: { withoutReceipt: checked.decision, note: note || null },
    summary: approved
      ? "The CEO approved the direct order to stand without a delivery receipt."
      : `The CEO refused to let the direct order stand without a delivery receipt: ${note}`,
  });
  await insertOrderEvent(
    order.id,
    access.hrId,
    approved ? "receipt_waiver_approved" : "receipt_waiver_refused",
    approved ? "The CEO approved this order to stand without a delivery receipt." : `The CEO refused to let this order stand without a delivery receipt: ${note}`,
    { note: note || null },
  );
  return {
    message: approved
      ? "Approved. This order stands without a delivery receipt and leaves Finance's overdue list."
      : "Refused. The order still owes its delivery receipt.",
  };
}

/** How many asks wait on the CEO — the badge term. 0 to anyone else, and no rows are read. */
export async function countDirectOrderWithoutReceiptToDecide(access: AccessContext): Promise<number> {
  if (!canDecideDirectOrderWithoutReceipt(access)) return 0;
  const { count, error } = await getSupabaseAdmin().from(NO_RECEIPT).select("id", { count: "exact", head: true }).eq("status", "pending");
  if (error) throw error;
  return count ?? 0;
}

export type DirectOrderWithoutReceiptToDecide = {
  requestId: string;
  requesterName: string;
  pharmacyName: string;
  productName: string;
  salesValue: number;
  reason: string;
  askedAt: string;
  askedByName: string | null;
};

/** The asks waiting on the CEO, oldest first — his Needs Action list. Empty to anyone else. */
export async function listDirectOrderWithoutReceiptToDecide(access: AccessContext): Promise<DirectOrderWithoutReceiptToDecide[]> {
  if (!canDecideDirectOrderWithoutReceipt(access)) return [];
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from(NO_RECEIPT).select(NO_RECEIPT_COLUMNS).eq("status", "pending").order("asked_at");
  if (error) throw error;
  const asks = ((data ?? []) as NoReceiptDbRow[]).map(toNoReceipt);
  if (asks.length === 0) return [];
  const { data: orderRows, error: orderError } = await supabase
    .from("direct_order_requests")
    .select("id,requester_hr_id,pharmacy_id,product_name,sales_value")
    .in("id", asks.map((ask) => ask.requestId));
  if (orderError) throw orderError;
  const orders = new Map(
    ((orderRows ?? []) as { id: string; requester_hr_id: string; pharmacy_id: string; product_name: string | null; sales_value: number | null }[]).map((row) => [row.id, row]),
  );
  const pharmacyIds = [...new Set([...orders.values()].map((row) => row.pharmacy_id).filter(Boolean))];
  const pharmacyNames = new Map<string, string>();
  if (pharmacyIds.length > 0) {
    const { data: pharmacies, error: pharmacyError } = await supabase.from("direct_order_pharmacies").select("id,pharmacy_name").in("id", pharmacyIds);
    if (pharmacyError) throw pharmacyError;
    for (const row of (pharmacies ?? []) as { id: string; pharmacy_name: string | null }[]) pharmacyNames.set(row.id, String(row.pharmacy_name ?? "").trim());
  }
  const names = await namesByHrId([...asks.map((ask) => ask.askedByHrId), ...[...orders.values()].map((row) => row.requester_hr_id)]);
  return asks.flatMap((ask) => {
    const row = orders.get(ask.requestId);
    if (!row) return [];
    return [
      {
        requestId: ask.requestId,
        requesterName: names.get(row.requester_hr_id) ?? row.requester_hr_id,
        pharmacyName: pharmacyNames.get(row.pharmacy_id) || "Pharmacy not on file",
        productName: String(row.product_name ?? ""),
        salesValue: Number(row.sales_value ?? 0),
        reason: ask.reason,
        askedAt: ask.askedAt,
        askedByName: names.get(ask.askedByHrId),
      },
    ];
  });
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
  /** Approved orders raised while this book was held that still have no receipt from it. */
  owing: number;
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
  /** Approved since the first book went out, raised by someone who held no book that day (owner, 27 Nov 2026: "Flag them"). */
  noBook: Omit<ReceiptRegisterOrder, "standing">[];
  recent: ReceiptRegisterEntry[];
  /** Orders asked to stand without a receipt: waiting on the CEO, or approved by him (owner, 27 Nov 2026). */
  withoutReceipt: (Omit<ReceiptRegisterOrder, "standing" | "days"> & {
    status: "pending" | "approved";
    reason: string;
    askedAt: string;
    /** When the CEO approved it — the order's own `decidedAt` is when the order was approved. */
    waiverDecidedAt: string | null;
    decidedByName: string | null;
  })[];
  overdueDays: number;
  /** Everyone a spare book may be handed to: District Managers on a line with direct orders, still employed. */
  holderOptions: { hrId: string; name: string }[];
};

/** Finance's desk. Refuses anyone who is not Finance or the Administrator. */
export async function loadDirectOrderReceiptRegister(access: AccessContext): Promise<DirectOrderReceiptRegister> {
  if (!canManageDirectOrderReceiptBooks(access)) throw forbiddenError("The receipt register is Finance's.");
  const supabase = getSupabaseAdmin();
  const books = await loadBooks();

  const [{ data: receiptRows, error: receiptError }, ordersResult, holdersResult, { data: askRows, error: askError }] = await Promise.all([
    supabase.from(RECEIPTS).select("serial,book_no,state,request_id,used_by_hr_id,used_at,voided_by_hr_id,voided_at,voided_reason").neq("state", "unused").order("serial"),
    loadApprovedOrdersSinceRollout(books),
    supabase
      .from("employees")
      .select("hr_id,full_name,job_title,employment_status")
      .eq("job_title", "District Sales Manager")
      .in("employment_status", ["active", "on_leave"]),
    supabase.from(NO_RECEIPT).select(NO_RECEIPT_COLUMNS).in("status", ["pending", "approved"]),
  ]);
  // Every read the desk shows is checked: a failed read is said as "could not be read", never as an
  // empty spare list or "Pharmacy not on file".
  if (receiptError) throw receiptError;
  if (holdersResult.error) throw holdersResult.error;
  if (askError) throw askError;
  const liveAsks = new Map(((askRows ?? []) as NoReceiptDbRow[]).map((row) => [row.request_id, toNoReceipt(row)]));
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
  const classified = orders.map((row) => ({
    row,
    standing: classifyOrderReceipt({
      order: row.order,
      books,
      hasReceipt: receiptByOrder.has(row.order.id),
      now,
      withoutReceiptApproved: liveAsks.get(row.order.id)?.status === "approved",
    }),
  }));
  const withoutReceiptOrders = orders.filter((row) => liveAsks.has(row.order.id) && !receiptByOrder.has(row.order.id));
  const missingOrders = classified.filter(
    (entry): entry is { row: typeof entry.row; standing: "waiting" | "overdue" } => entry.standing === "waiting" || entry.standing === "overdue",
  );
  const noBookOrders = classified.filter((entry) => entry.standing === "no_book");
  const owingByBook = new Map<number, number>();
  for (const entry of missingOrders) {
    const held = bookHeldAtApproval(entry.row.order, books);
    if (held) owingByBook.set(held.bookNo, (owingByBook.get(held.bookNo) ?? 0) + 1);
  }

  const pharmacyIds = [
    ...new Set([
      ...missingOrders.map((entry) => entry.row.pharmacyId),
      ...noBookOrders.map((entry) => entry.row.pharmacyId),
      ...withoutReceiptOrders.map((row) => row.pharmacyId),
      ...orders.filter((o) => receiptByOrder.has(o.order.id)).map((o) => o.pharmacyId),
    ]),
  ];
  const pharmacyNames = new Map<string, string>();
  for (let start = 0; start < pharmacyIds.length; start += 100) {
    const { data, error } = await supabase.from("direct_order_pharmacies").select("id,pharmacy_name").in("id", pharmacyIds.slice(start, start + 100));
    if (error) throw error;
    for (const row of (data ?? []) as { id: string; pharmacy_name: string | null }[]) pharmacyNames.set(row.id, String(row.pharmacy_name ?? "").trim());
  }
  const pharmacyByOrder = new Map(orders.map((o) => [o.order.id, pharmacyNames.get(o.pharmacyId) ?? null]));

  const names = await namesByHrId([
    ...books.flatMap((book) => [book.holderHrId, book.printedHolderHrId]),
    ...orders.map((o) => o.order.requesterHrId),
    ...touched.flatMap((row) => [row.used_by_hr_id, row.voided_by_hr_id]),
    ...[...liveAsks.values()].map((ask) => ask.decidedByHrId),
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
        owing: owingByBook.get(book.bookNo) ?? 0,
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
    noBook: noBookOrders
      .map(({ row }) => ({
        requestId: row.order.id,
        requesterName: names.get(row.order.requesterHrId) ?? row.order.requesterHrId,
        pharmacyName: pharmacyNames.get(row.pharmacyId) || "Pharmacy not on file",
        productName: row.productName,
        salesValue: row.salesValue,
        decidedAt: row.order.decidedAt,
        days: daysSinceApproval(row.order.decidedAt, now) ?? 0,
      }))
      .sort((a, b) => b.days - a.days),
    withoutReceipt: withoutReceiptOrders
      .map((row) => {
        const ask = liveAsks.get(row.order.id) as NoReceiptRow;
        return {
          requestId: row.order.id,
          requesterName: names.get(row.order.requesterHrId) ?? row.order.requesterHrId,
          pharmacyName: pharmacyNames.get(row.pharmacyId) || "Pharmacy not on file",
          productName: row.productName,
          salesValue: row.salesValue,
          decidedAt: row.order.decidedAt,
          status: ask.status === "approved" ? ("approved" as const) : ("pending" as const),
          reason: ask.reason,
          askedAt: ask.askedAt,
          waiverDecidedAt: ask.decidedAt,
          decidedByName: ask.decidedByHrId ? names.get(ask.decidedByHrId) : null,
        };
      })
      .sort((a, b) => (a.status === b.status ? b.askedAt.localeCompare(a.askedAt) : a.status === "pending" ? -1 : 1)),
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

/**
 * Every approved original order decided since the first book went out — whoever raised it. A holder's
 * order may owe a receipt; anyone else's is flagged as raised without a book (owner, 27 Nov 2026:
 * "Flag them"). Nothing before the rollout is read, so the orders from before the books never show.
 */
async function loadApprovedOrdersSinceRollout(books: readonly ReceiptBookRow[]): Promise<HolderOrder[]> {
  const rollout = receiptRolloutStart(books);
  if (rollout === null) return [];
  const since = new Date(rollout).toISOString();
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
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as {
      id: string; requester_hr_id: string; status: string; decided_at: string | null; reversal_of_request_id: string | null;
      pharmacy_id: string; product_name: string | null; sales_value: number | null;
    }[];
    for (const row of page) {
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

export type LateReceiptOrder = { requestId: string; pharmacyName: string; days: number };

/**
 * One manager's approved orders whose delivery receipt is past its 7 days (owner, 27 Nov 2026: «حد
 * اقصى اسبوع ولا ينفذ له اوردارات اخرى فى حاله عدم رفعه»; he chose "The manager who raised it"). While
 * any is listed that manager raises no new order. An order raised with no book (`no_book`) is Finance's
 * flag, not this block, and one the CEO approved to stand without a receipt is never late. Nor is
 * one approved from a book Finance has since recorded lost: its receipt can no longer be entered, so it
 * stays on Finance's desk and never holds the manager for good.
 */
export async function listLateReceiptsForRequester(requesterHrId: string, now: Date = new Date()): Promise<LateReceiptOrder[]> {
  const books = await loadBooks();
  if (books.length === 0) return [];
  const key = canonicalHrIdKey(requesterHrId);
  if (!key) return [];
  const mine = (await loadApprovedOrdersSinceRollout(books)).filter(
    (row) => canonicalHrIdKey(row.order.requesterHrId) === key && bookHeldAtApproval(row.order, books)?.status !== "lost",
  );
  if (mine.length === 0) return [];
  const ids = mine.map((row) => row.order.id);
  const supabase = getSupabaseAdmin();
  // Batches of 100 ids: about four hundred in one .in() overflow the request URL and read back EMPTY
  // with no error, which would make every order look receipt-less and refuse the manager falsely.
  const withReceipt = new Set<string | null>();
  const waived = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const [{ data: receiptRows, error: receiptError }, { data: askRows, error: askError }] = await Promise.all([
      supabase.from(RECEIPTS).select("request_id").in("request_id", batch),
      supabase.from(NO_RECEIPT).select("request_id").in("request_id", batch).eq("status", "approved"),
    ]);
    if (receiptError) throw receiptError;
    if (askError) throw askError;
    for (const row of (receiptRows ?? []) as { request_id: string | null }[]) withReceipt.add(row.request_id);
    for (const row of (askRows ?? []) as { request_id: string }[]) waived.add(row.request_id);
  }
  const late = mine.filter(
    (row) =>
      classifyOrderReceipt({ order: row.order, books, hasReceipt: withReceipt.has(row.order.id), now, withoutReceiptApproved: waived.has(row.order.id) }) ===
      "overdue",
  );
  if (late.length === 0) return [];
  const { data: pharmacies, error: pharmacyError } = await supabase
    .from("direct_order_pharmacies")
    .select("id,pharmacy_name")
    .in("id", [...new Set(late.map((row) => row.pharmacyId))]);
  if (pharmacyError) throw pharmacyError;
  const names = new Map(((pharmacies ?? []) as { id: string; pharmacy_name: string | null }[]).map((row) => [row.id, String(row.pharmacy_name ?? "").trim()]));
  return late.map((row) => ({
    requestId: row.order.id,
    pharmacyName: names.get(row.pharmacyId) || "a pharmacy not on file",
    days: daysSinceApproval(row.order.decidedAt, now) ?? 0,
  }));
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
  // The hand-out names a real person still at work — never a typed id that matches nobody.
  const { data: employeeRows, error: employeeError } = await getSupabaseAdmin()
    .from("employees")
    .select("hr_id,employment_status")
    .in("hr_id", hrIdLookupKeys(holder));
  if (employeeError) throw employeeError;
  const atWork = ((employeeRows ?? []) as { hr_id: string; employment_status: string | null }[]).some(
    (row) => canonicalHrIdKey(row.hr_id) === canonicalHrIdKey(holder) && (row.employment_status === "active" || row.employment_status === "on_leave"),
  );
  if (!atWork) throw validationError(`${holder} is not an employee still at work, so book ${bookNo} cannot be handed to them.`);
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

/**
 * Finance takes a book back, or records it lost. Lost cancels every receipt in it still unused, in
 * the same transaction as the book (direct_order_close_receipt_book), so a failure can never leave a
 * lost book with live receipts. A returned book still proves the orders approved while it was held
 * (late entry), so the answer says how many still owe a receipt from it.
 */
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
  if (!decision.ok || !book) throw validationError(decision.ok ? "There is no such receipt book." : decision.message);
  const { data, error } = await getSupabaseAdmin().rpc("direct_order_close_receipt_book", {
    p_book_no: bookNo,
    p_kind: kind,
    p_expected_status: book.status,
    p_actor_hr_id: hrIdForStorage(access.hrId),
    p_note: note,
  });
  if (error) throw error;
  const result = (data ?? {}) as { closed?: boolean; closed_at?: string; voided?: number };
  if (!result.closed) throw conflictError(`Book ${bookNo} was just changed by someone else. Reload the page.`);
  const voided = Number(result.voided ?? 0);
  const closedAt = result.closed_at ?? new Date().toISOString();
  await writeRequiredAuditLog({
    actorLoginId: access.loginId ?? access.hrId,
    entityType: "direct_order_receipt_book",
    entityId: String(bookNo),
    oldValues: { status: book.status },
    newValues: { status: kind, closedAt, note, receiptsCancelled: voided },
    summary: kind === "lost" ? `Receipt book ${bookNo} recorded lost; ${voided} unused receipts cancelled.` : `Receipt book ${bookNo} returned to Finance.`,
  });
  if (kind === "lost") {
    return { message: `Book ${bookNo} is recorded lost. Its ${voided} unused receipts are cancelled, so a page from it will be refused.` };
  }
  const owing = await countOrdersOwingFromBook(book, closedAt);
  const owingLine =
    owing === null
      ? " The orders still owing a receipt from it could not be counted just now; they are listed on this desk."
      : owing === 0
        ? " No order approved while it was held is still waiting for a receipt."
        : ` ${owing} order${owing === 1 ? "" : "s"} approved while it was held still ${owing === 1 ? "owes" : "owe"} a receipt; their pages from this book can still be entered.`;
  return { message: `Book ${bookNo} is recorded as returned. Its unused receipts can no longer be used for new orders.${owingLine}` };
}

/** Approved orders raised while this book was held that have no receipt yet. Null when it cannot be read. */
async function countOrdersOwingFromBook(book: ReceiptBookRow, closedAt: string): Promise<number | null> {
  if (!book.holderHrId || !book.issuedAt) return 0;
  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("direct_order_requests")
      .select("id,requester_hr_id")
      .eq("status", "approved")
      .is("reversal_of_request_id", null)
      .in("requester_hr_id", hrIdLookupKeys(book.holderHrId))
      .gte("decided_at", book.issuedAt)
      .lt("decided_at", closedAt);
    if (error) throw error;
    const ids = ((data ?? []) as { id: string }[]).map((row) => row.id);
    let withReceipt = 0;
    for (let start = 0; start < ids.length; start += 100) {
      const { data: used, error: usedError } = await supabase.from(RECEIPTS).select("request_id").in("request_id", ids.slice(start, start + 100));
      if (usedError) throw usedError;
      withReceipt += (used ?? []).length;
    }
    return ids.length - withReceipt;
  } catch (error) {
    logError("Orders owing a receipt from a returned book could not be counted", { labels: { event: "direct_order_receipt_owing_failed", bookNo: book.bookNo }, error });
    return null;
  }
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
