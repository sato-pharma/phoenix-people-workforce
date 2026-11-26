import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { canManageDirectOrderReceiptBooks } from "@/lib/direct-orders/finance-authority";
import {
  closeDirectOrderReceiptBook,
  issueDirectOrderReceiptBook,
  voidDirectOrderReceipt,
} from "@/lib/direct-orders/receipt-books";
import { forbiddenError, toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Finance's custody actions on the delivery-receipt books: hand a book out, take it back, record it
 * lost, or cancel a spoiled receipt. Finance or the Administrator only — the service checks it.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    // Refused before the body is read: signed out, or anyone who is not Finance or the Administrator.
    if (!canManageDirectOrderReceiptBooks(access)) throw forbiddenError("Only Finance manages the receipt books.");
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      bookNo?: unknown;
      holderHrId?: unknown;
      note?: unknown;
      serial?: unknown;
      reason?: unknown;
    };
    let result: { message: string };
    switch (body.action) {
      case "issue":
        result = await issueDirectOrderReceiptBook(access, { bookNo: body.bookNo, holderHrId: body.holderHrId });
        break;
      case "return":
        result = await closeDirectOrderReceiptBook(access, { bookNo: body.bookNo, kind: "returned", note: body.note });
        break;
      case "lost":
        result = await closeDirectOrderReceiptBook(access, { bookNo: body.bookNo, kind: "lost", note: body.note });
        break;
      case "void":
        result = await voidDirectOrderReceipt(access, { serial: body.serial, reason: body.reason });
        break;
      default:
        throw validationError("Choose what to do with the book.");
    }
    return NextResponse.json({ success: true, message: result.message });
  } catch (error) {
    const apiError = toApiError(error, "Could not update the receipt book.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
