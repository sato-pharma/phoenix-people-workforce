import { assertPermission } from "@/lib/auth/permissions";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { ChromiumUnavailableError } from "@/lib/pdf/chromium";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { awardChequeDocumentHtml, renderAwardChequeBatchPdf } from "@/lib/spotlight/award-cheque";
import { ChequeRequestError, parseChequeRequest } from "@/lib/spotlight/cheque-request";
import { loadChequeSignatureUri } from "@/lib/spotlight/cheque-signature";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The award cheque generator - a preview (`format: "html"`) or the PDF (`format: "pdf"`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHO MAY CALL IT. The Super Admin and the CEO only: `spotlight:export`, and the page's seat fence
 * for the Talent Acquisition seat, which holds that permission for her Spotlight sheet. THE GATE IS
 * HERE AND NOT ONLY IN THE SIDEBAR: hiding the link is UX, this route is the security boundary.
 *
 * WHAT IT DOES NOT DO. It records nothing and moves no money - the cheque is a presentation sheet
 * built from whatever the caller typed, and the amount on it is not read from, or written to, payroll.
 * The CEO's signature is read here, on the server, from its private bucket: it is never sent to or
 * from the browser inside a cheque request, so a request cannot smuggle a different one in.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "spotlight", "export");
    assertPageOpenForRole(access.role, "/spotlight/cheques");

    const parsed = parseChequeRequest(await request.json().catch(() => null));
    // A preview is called on every pause in typing, so only the PDF - the render that costs a browser
    // launch and can be repeated by a script - is rate limited.
    if (parsed.format === "pdf") {
      await assertExportRateLimit({
        actor: access.loginId ?? access.hrId,
        request,
        scope: "export:spotlight:cheques",
      });
    }

    const signature = parsed.rows.some((row) => row.signed) ? await loadChequeSignatureUri() : null;
    const rows = parsed.rows.map(({ signed, ...row }) => ({ ...row, ceoSignatureUri: signed ? signature : null }));

    if (parsed.format === "html") {
      return Response.json({ html: awardChequeDocumentHtml(rows[0]) }, { headers: { "Cache-Control": "no-store" } });
    }

    const pdf = await renderAwardChequeBatchPdf(rows);
    return new Response(new Uint8Array(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${
          rows.length === 1 ? "sato-award-cheque.pdf" : `sato-award-cheques-${rows.length}.pdf`
        }"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return Response.json(
        { error: "The cheque generator is available to the system administrator and the CEO only." },
        { status: 403 },
      );
    }
    if (isApiRateLimitError(error)) {
      return Response.json({ error: error.message }, { status: 429 });
    }
    if (error instanceof ChequeRequestError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChromiumUnavailableError) {
      return Response.json(
        { error: "This server cannot render PDFs right now. The preview on screen is unaffected." },
        { status: 503 },
      );
    }
    return Response.json({ error: clientSafeErrorMessage(error, "The cheque could not be built.") }, { status: 500 });
  }
}
