import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canUseSatoEmail } from "@/lib/sato-email/access";
import {
  polishSatoEmailDraft,
  SATO_ASSIST_MAX_INSTRUCTION_CHARS,
  SATO_POLISH_MAX_BODY_CHARS,
  SATO_POLISH_MAX_SUBJECT_CHARS,
  SatoPolishError,
  type SatoPolishResult,
} from "@/lib/sato-email/polish";
import { readSatoSourceDocument, SatoSourceDocumentError } from "@/lib/sato-email/read-source-document";
import { describeSourceRead, SATO_EMAIL_DOCUMENT_MAX_BYTES } from "@/lib/sato-email/source-document";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The same budget as the assistant's own route: reading the file is fast, and everything after it
// is the same upstream call, which at medium effort on a whole letter runs to a minute.
export const maxDuration = 150;

/**
 * Build the email out of a document the sender uploaded.
 *
 * Owner 2026-09-23: "i want to have an option to for example upload pdf and the system absorb and
 * extract the data from the pdf and make it as email", with the Semester 2 2026 incentive policy
 * attached as the example.
 *
 * The file is read and thrown away: nothing here stores it, nothing here attaches it, and nothing
 * here sends anything. Whether the document itself travels with the email is a separate decision
 * the sender makes on the attach row, which is why the assistant is told never to claim it is
 * attached.
 *
 * Gate and limiter are the composer's own — `canUseSatoEmail`, not `communication`, which also
 * opens three other screens. The limit is lower than the assistant's: each call carries a whole
 * document upstream, and a sender building one announcement presses this two or three times.
 */
export async function POST(request: NextRequest) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canUseSatoEmail(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 6,
      scope: "sato-email:document",
      windowMs: 60_000,
    });

    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) {
      return NextResponse.json({ message: "Choose a document to build the email from." }, { status: 400 });
    }

    // Before the bytes are read into memory, not only inside the reader: pulling a 400 MB upload
    // into a Buffer in order to refuse it is how one careless drag takes the server down.
    if (file.size > SATO_EMAIL_DOCUMENT_MAX_BYTES) {
      return NextResponse.json(
        { message: `A document must be ${Math.round(SATO_EMAIL_DOCUMENT_MAX_BYTES / (1024 * 1024))} MB or smaller.` },
        { status: 413 },
      );
    }

    const read = await readSatoSourceDocument({
      bytes: Buffer.from(await file.arrayBuffer()),
      contentType: file.type,
      fileName: file.name,
    });

    const bodyHtml =
      typeof form.get("bodyHtml") === "string" ? String(form.get("bodyHtml")).slice(0, SATO_POLISH_MAX_BODY_CHARS) : "";
    const subject =
      typeof form.get("subject") === "string" ? String(form.get("subject")).slice(0, SATO_POLISH_MAX_SUBJECT_CHARS) : "";

    // 🔴 THE VERBATIM ROUTE NEVER CALLS THE MODEL, AND THAT IS THE WHOLE FEATURE.
    //
    // Owner, 2026-09-23, on an HTML file this build had rewritten: "when i did with html its lost
    // its design an became awful design", then "i donot whant ai to rewrite it i want to make as as
    // it is exactly". A PDF has to be turned into an email because a PDF is not one. An HTML file
    // already is: its headings, its bold, its tables and the order it puts them in ARE the design,
    // and a model asked to write an announcement out of its words throws every one of them away.
    //
    // So the file goes straight into the editor. The one thing that touches it afterwards is
    // `prepareSatoEmailBody`, at render, which sanitises anything the sender types by hand as well.
    const result: SatoPolishResult =
      read.source.route === "verbatim"
        ? {
            bodyHtml: read.source.text,
            changes: ["Loaded the file exactly as it is. Nothing was rewritten, translated or re-ordered."],
            checks: [],
            mode: "document",
            // The uploaded email's own subject, and only if it carried one: an empty answer here
            // leaves whatever the sender already typed in the subject field standing.
            subject: read.source.subject?.trim() || subject,
          }
        : await polishSatoEmailDraft({
            bodyHtml,
            instruction:
              typeof form.get("instruction") === "string"
                ? String(form.get("instruction")).slice(0, SATO_ASSIST_MAX_INSTRUCTION_CHARS)
                : "",
            mode: "document",
            source: read.source,
            subject,
          });

    return NextResponse.json({
      result,
      // What the assistant actually had in front of it, in one line the sender reads on screen. A
      // draft built from a file he picked by mistake is invisible without the file's own name.
      source: {
        fileName: read.source.fileName,
        // The route travels with it so the screen can name what happened honestly: a file that was
        // LOADED must not be reported under "what it wrote from your document".
        route: read.source.route,
        note: describeSourceRead({
          characters: read.characters,
          fileName: read.source.fileName,
          route: read.source.route,
          truncated: read.truncated,
        }),
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { message: "Too many documents in a row — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    if (error instanceof SatoSourceDocumentError) {
      return NextResponse.json({ message: error.message }, { status: error.code === "document_too_large" ? 413 : 400 });
    }
    if (error instanceof SatoPolishError) {
      const status = error.code === "polish_not_configured" ? 503 : error.code === "polish_rate_limited" ? 429 : 502;
      return NextResponse.json({ message: error.message }, { status });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "The email could not be built from that document.") },
      { status: 500 },
    );
  }
}
