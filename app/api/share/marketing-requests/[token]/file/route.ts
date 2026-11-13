import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertMarketingShareToken } from "@/lib/marketing-requests/report-share-links";
import { assertShareLinkRate, shareLinkRateRefusal } from "@/lib/share-links/token-hash";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const EVIDENCE_BUCKET = "marketing-evidence";
const FINANCE_BUCKET = "marketing-finance-evidence";

type FileKind = "evidence" | "invoice" | "proof";

function plain(message: string, status: number) {
  return new NextResponse(message, {
    headers: { "Cache-Control": "no-store, max-age=0", "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex, nofollow, noarchive" },
    status,
  });
}

/**
 * Streams one evidence photo, money-transfer proof or invoice for a shared Marketing Request
 * report, so the cells in the owner's live sheet are clickable rather than filenames he cannot open.
 *
 * WHY THE CALLER NEVER NAMES A STORAGE PATH.
 * The only inputs are a token, a `kind` from a closed set, and a request CODE. The storage path is
 * resolved here from the request row. Accepting a path — even a signed one — would turn this into
 * a read primitive over two private buckets, where one traversal bug exposes every employee photo
 * and leave attachment in the project. A request code can address exactly the files belonging to
 * that request and nothing else.
 *
 * Files are a SEPARATE grant from the CSV (`allow_files`): the table leaks numbers, a file leaks a
 * photograph of a named doctor's clinic with a GPS stamp on it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Limited per address and per link before the token is looked up, far above real use
  // (`@/lib/share-links/token-hash`). A refusal serves nothing and says nothing about the token.
  try {
    await assertShareLinkRate(request, token, { addressLimit: 1200, linkLimit: 1200, scope: "marketing_share_file" });
  } catch (limitError) {
    return shareLinkRateRefusal(limitError, "text");
  }
  try {
    const url = new URL(request.url);
    const kindParam = String(url.searchParams.get("kind") ?? "");
    const requestCode = String(url.searchParams.get("request") ?? "").trim();

    if (kindParam !== "evidence" && kindParam !== "invoice" && kindParam !== "proof") {
      return plain("Unknown file kind.", 400);
    }
    const kind = kindParam as FileKind;
    if (!requestCode) return plain("Missing request.", 400);

    const link = await assertMarketingShareToken({ requireFiles: true, surface: "feed", token });
    const supabase = getSupabaseAdmin();

    const { data: requestRow } = await supabase
      .from("marketing_requests")
      .select("id, request_code, customer_id, requester_hr_id, origin")
      .eq("request_code", requestCode)
      .maybeSingle();
    if (!requestRow) return plain("Not found.", 404);

    // The link's frozen scope applies to files exactly as it applies to rows. An 'own' link must
    // not become a company-wide key just because the caller guessed another request's code.
    const scope = String(link.scope ?? "own");
    if (scope !== "all") {
      const owner = String((requestRow as { requester_hr_id: string | null }).requester_hr_id ?? "").toUpperCase();
      if (owner !== String(link.scope_hr_id ?? "").toUpperCase()) return plain("Not found.", 404);
    }

    let bucket = FINANCE_BUCKET;
    let path: string | null = null;
    let fallbackName: string | null = null;

    if (kind === "evidence") {
      bucket = EVIDENCE_BUCKET;
      const customerId = (requestRow as { customer_id: string | null }).customer_id;
      if (!customerId) return plain("Not found.", 404);
      // Prefer the indexed file row — it is the only record that carries actual stored bytes.
      const { data: fileRow } = await supabase
        .from("marketing_evidence_files")
        .select("storage_bucket, storage_path, content_type, original_file_name")
        .eq("entity_id", customerId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (fileRow) {
        bucket = String((fileRow as { storage_bucket: string | null }).storage_bucket ?? EVIDENCE_BUCKET);
        path = String((fileRow as { storage_path: string }).storage_path);
      } else {
        const { data: customer } = await supabase
          .from("marketing_customers")
          .select("evidence_photo_name")
          .eq("id", customerId)
          .maybeSingle();
        fallbackName = customer ? String((customer as { evidence_photo_name: string | null }).evidence_photo_name ?? "") : null;
      }
    } else {
      const { data: finance } = await supabase
        .from("marketing_request_finance_requirements")
        .select("invoice_storage_path, money_transfer_proof_storage_path")
        .eq("request_id", String((requestRow as { id: string }).id))
        .maybeSingle();
      if (finance) {
        const row = finance as { invoice_storage_path: string | null; money_transfer_proof_storage_path: string | null };
        path = kind === "invoice" ? row.invoice_storage_path : row.money_transfer_proof_storage_path;
      }
    }

    if (!path) {
      // A capture that predates byte storage is a real, explainable state, not a system fault.
      // Saying so beats a bare 404, which reads as "Phoenix lost the photo".
      if (fallbackName) {
        return plain(
          `This photo was captured on ${fallbackName.slice(0, 40)} before Phoenix began storing the image itself, `
          + "so only its filename was ever recorded. Photos captured from 4 August 2026 onward open here normally.",
          410,
        );
      }
      return plain("No file of that kind is attached to this request.", 404);
    }

    const { data: blob, error } = await supabase.storage.from(bucket).download(path);
    if (error || !blob) return plain("The file could not be read from storage.", 404);

    // Count the file open separately from the CSV pulls. "Nobody ever opened a photo" and "someone
    // opened 200" are different facts, and only the second one is worth investigating.
    await supabase
      .from("marketing_request_report_share_links")
      .update({ file_access_count: Number(link.file_access_count ?? 0) + 1 })
      .eq("id", String(link.id))
      .then(undefined, () => undefined);

    return new NextResponse(await blob.arrayBuffer(), {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        // inline, not attachment: the owner asked that clicking OPENS the photo, not downloads it.
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
