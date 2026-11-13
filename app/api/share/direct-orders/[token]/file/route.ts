import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertDirectOrderShareToken } from "@/lib/direct-orders/report-share-links";
import { DIRECT_ORDER_EVIDENCE_BUCKET } from "@/lib/direct-orders/pharmacy-validation";
import { assertShareLinkRate, shareLinkRateRefusal } from "@/lib/share-links/token-hash";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function plain(message: string, status: number) {
  return new NextResponse(message, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
    status,
  });
}

/**
 * Streams the storefront photo behind one direct order, so the evidence cell in the owner's live
 * sheet is clickable rather than a filename nobody can open.
 *
 * WHY THE CALLER NEVER NAMES A STORAGE PATH.
 * The only inputs are a token, a `kind` from a closed set, and a request ID. The storage path is
 * resolved here from the pharmacy validation attached to that request. Accepting a path — even a
 * signed one — would turn this into a read primitive over a private bucket, where one traversal bug
 * exposes every employee photo and leave attachment in the project.
 *
 * Files are a SEPARATE grant from the CSV (`allow_files`): the table leaks numbers, a file leaks a
 * GPS-stamped photograph of a real shop front.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Limited per address and per link before the token is looked up, far above real use
  // (`@/lib/share-links/token-hash`). A refusal serves nothing and says nothing about the token.
  try {
    await assertShareLinkRate(request, token, { addressLimit: 1200, linkLimit: 1200, scope: "direct_order_share_file" });
  } catch (limitError) {
    return shareLinkRateRefusal(limitError, "text");
  }
  try {
    const url = new URL(request.url);
    if (String(url.searchParams.get("kind") ?? "") !== "evidence") {
      return plain("Unknown file kind.", 400);
    }
    const requestId = String(url.searchParams.get("request") ?? "").trim();
    if (!requestId) return plain("Missing request.", 400);

    const link = await assertDirectOrderShareToken({ requireFiles: true, surface: "feed", token });
    const supabase = getSupabaseAdmin();

    const { data: order } = await supabase
      .from("direct_order_requests")
      .select("id, requester_hr_id")
      .eq("id", requestId)
      .maybeSingle();
    if (!order) return plain("Not found.", 404);

    // The link's frozen scope applies to files exactly as it applies to rows. A narrow link must
    // not become a company-wide key just because the caller guessed another order's id.
    if (String(link.scope ?? "own") !== "all") {
      const owner = String((order as { requester_hr_id: string | null }).requester_hr_id ?? "").toUpperCase();
      if (owner !== String(link.scope_hr_id ?? "").toUpperCase()) return plain("Not found.", 404);
    }

    // Newest validation wins: a pharmacy can be re-validated, and the current photo is the one that
    // proves what the reader is looking at now.
    const { data: validation } = await supabase
      .from("direct_order_pharmacy_validations")
      .select("storage_bucket, storage_path")
      .eq("request_id", requestId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const path = validation ? (validation as { storage_path: string | null }).storage_path : null;
    if (!path) {
      // Explainable states beat a bare 404, which reads as "Phoenix lost the photo".
      return plain(
        "No storefront photo is attached to this order. A photo exists only where a pharmacy had to "
        + "be validated by capture; an order placed against an already-known pharmacy has none.",
        404,
      );
    }

    const bucket = String((validation as { storage_bucket: string | null }).storage_bucket ?? DIRECT_ORDER_EVIDENCE_BUCKET);
    const { data: blob, error } = await supabase.storage.from(bucket).download(path);
    if (error || !blob) return plain("The file could not be read from storage.", 404);

    // Counted separately from CSV pulls: "nobody ever opened a photo" and "someone opened 200" are
    // different facts, and only the second is worth investigating.
    await supabase
      .from("direct_order_report_share_links")
      .update({ file_access_count: Number(link.file_access_count ?? 0) + 1 })
      .eq("id", String(link.id))
      .then(undefined, () => undefined);

    return new NextResponse(await blob.arrayBuffer(), {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        // inline, not attachment: clicking should OPEN the photo, not download it.
        "Content-Disposition": "inline",
        "Content-Type": blob.type || "application/octet-stream",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
      status: 200,
    });
  } catch (error) {
    const apiError = toApiError(error, "This link is not available.");
    return plain(apiError.message, isForbiddenError(error) ? 403 : apiError.status);
  }
}
