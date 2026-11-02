import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertMayPrintPaper, assertMayUseHrForms } from "@/lib/hiring-pack/paper-access";
import { documentFieldInventory } from "@/lib/hiring-pack/document-inventory";
import { pageSizeFor } from "@/lib/hiring-pack/field-warnings";
import {
  asPrintableDocument,
  documentLabel,
  type PrintableDocument,
} from "@/lib/hiring-pack/document-registry";
import { stampPaperReference } from "@/lib/hiring-pack/paper-reference";
import { issuePaperNumber } from "@/lib/hiring-pack/paper-register-store";
import { isCustomTemplateLayerMissing } from "@/lib/hiring-pack/custom-template-store";
import { documentCarriesHousePageNumbers } from "@/lib/hiring-pack/house-identity";
import {
  ChromiumUnavailableError,
  PaperArtworkMissingError,
  renderHiringPaperPdf,
} from "@/lib/hiring-pack/paper-pdf";
import { renderHiringPaper } from "@/lib/hiring-pack/render-paper";
import {
  hiringPackErrorMessage,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  recordHiringPackPrinted,
} from "@/lib/hiring-pack/service";
import { HIRING_PACK_DOCUMENTS, isBuiltInDocument } from "@/lib/hiring-pack/types";
import type { HiringPackDocument } from "@/lib/hiring-pack/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The printable document itself. It returns HTML rather than a PDF because the browser is what
// shapes and orders Arabic correctly — see the note at the top of render-shared.ts — and because
// "Print → Save as PDF" from this page produces a real PDF anyway, with selectable text.
//
// THE DOCUMENT IS NOT BUILT HERE ANY MORE. Resolving which paper, at which version, with which
// field layer, and rendering it, all moved to `@/lib/hiring-pack/render-paper` when filing a
// confirmed signature needed the same paper — necessarily the SAME one, since the promise of a
// filed copy is that it is the document the employee was given. What stays here is what is
// genuinely the route's: the permission assert, the `preview=1` rule, the `inventory=1` answer, the
// `*_printed_at` stamp, and the HTTP shaping of every refusal.
//
// COPY COUNTS ARE NOT A QUERY PARAMETER BY DEFAULT. Three Form 1s and four contracts are the
// owner's standing instruction and article 19 of the contract states the four in its own text, so
// the counts live in `systemContractDefaults` and a caller has to ask deliberately to differ.

/**
 * A filename HR can file by hand: `contract-A-12.pdf`.
 *
 * Deliberately not the Arabic document title. Windows rejects a colon, which every company template
 * carries in its `custom:<uuid>` key, and a browser that cannot parse the header falls back to the
 * last path segment — which here would be the word "print" for every paper ever downloaded.
 */
function pdfFileName(document: PrintableDocument, hrId: string): string {
  const safe = String(document).replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${safe}-${hrId.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`;
}

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: hiringPackErrorMessage(error), status: 403 };
  if (isCustomTemplateLayerMissing(error)) {
    return { message: "Company templates are not set up yet.", status: 409 };
  }
  if (isHiringPackEmployeeMissing(error)) {
    return { message: hiringPackErrorMessage(error), status: 404 };
  }
  if (isHiringPackSchemaMissing(error)) {
    return {
      message:
        "HR forms schema is not ready. Run the Supabase migrations for employee_hiring_profile and employee_offboarding_profile.",
      status: 409,
    };
  }
  return { message: hiringPackErrorMessage(error), status: 500 };
}

export async function GET(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    // employee_documents for everyone it always was; a seat in SEAT_PRINTABLE_DOCUMENTS on its own
    // papers' grants instead — see paper-access.
    await assertMayUseHrForms(access, "read");
    const { hrId } = await params;

    const url = new URL(request.url);
    // NARROWED, NEVER CAST. `document=` arrives as a query string, and the two shapes it may take
    // are one of the ten or `custom:<uuid>` with a real uuid inside it — `asPrintableDocument`
    // is the one function that decides, and it validates the uuid rather than splitting on a colon.
    const raw = url.searchParams.get("document");
    const requested: PrintableDocument | null = raw ? asPrintableDocument(raw) : null;
    if (!requested) {
      return NextResponse.json(
        {
          error: "invalid_hiring_pack_document",
          message:
            `Pass document= one of ${HIRING_PACK_DOCUMENTS.join(", ")}, ` +
            "or a company template as custom:<uuid>.",
        },
        { status: 400 },
      );
    }
    // This one paper, for a seat limited to a list. renderHiringPaper refuses the same papers again
    // as the choke point; this is the answer said where the route can shape it.
    await assertMayPrintPaper(access, requested, "read");

    // WHICH COMPANY ADDRESS THE PAPER PRINTS, chosen at the desk before printing (`address=registered`
    // or `office`). Absent — every link that predates the prompt — is the registered head office.
    const address = url.searchParams.get("address");

    // EVERYTHING THAT DECIDES WHICH PAPER THIS IS, written ONCE and spread into BOTH renders below.
    // The `format=pdf` branch renders its own single copy, and when it listed these by hand it
    // dropped `deviceId` - so the same URL with `&format=pdf` printed a custody receipt with its
    // technical block and item values as ruled blanks (OF-0006, 26 Oct 2026) while the page filled
    // them. A parameter added here now reaches the page AND the file; the only things a render adds
    // on its own are the copy count and `statedCopies`, which differ by design.
    const paperInput = {
      access,
      address,
      // Which DEVICE a custody receipt is for. Only the two custody forms read it; every other
      // document ignores it, and absent is the normal case - see renderHiringPaper. Not validated
      // here on purpose: `getCustodyDeviceFacts` answers null for an id that names nothing, and a
      // custody receipt must always print. Refusing to render a signed instrument because a lookup
      // missed would be a worse failure than the ruled blanks it falls back to.
      custodyDeviceId: url.searchParams.get("deviceId"),
      document: requested,
      hrId,
      // WHICH MARKS THIS PRINT CARRIES, and absent means NONE - see `parseMarkSelection`.
      // The desk ticks them in the print dialog beside the copy count and the address; the
      // layout editor asks for them explicitly too, so it can show what is being dragged.
      // Passed through unvalidated on purpose: an unknown name is dropped rather than
      // refusing to print a paper somebody needs today over a word they never typed.
      marks: url.searchParams.get("marks"),
      // No `version` parameter is the normal case, and it does NOT mean "print the current text":
      // the renderer resolves the version this employee signed. The parameter is only for
      // deliberately asking for a superseded template from the Archive.
      version: url.searchParams.get("version"),
    };

    const paper = await renderHiringPaper({
      ...paperInput,
      copies: url.searchParams.get("copies"),
    });

    // Every refusal already carries the status this route has always answered, so the shaping here
    // is a transcription rather than a decision.
    if (!paper.ok) {
      return NextResponse.json(
        { error: paper.code, message: paper.message },
        { status: paper.status },
      );
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // `inventory=1` ANSWERS "WHAT FIELDS DOES THIS TEMPLATE HAVE?" — the field table's whole data
    // source, and the reason it hangs off this route rather than a route of its own.
    //
    // Everything the question needs has already happened by this line: the permission check, the
    // employee's resolved pack, the version validation, the field layer, and the document rendered
    // exactly as it would be served. `documentFieldInventory` reads that same html rather than
    // rendering a second time, so the list can never describe a document different from the one on
    // screen — which is the failure a separate endpoint would eventually produce.
    //
    // RETURNED BEFORE THE PRINT STAMP, deliberately. Opening the field table is not printing, and
    // `preview=1` exists for exactly this reason; falling through would date every document as
    // printed the moment somebody looked at its field list.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    if (url.searchParams.get("inventory") === "1") {
      // THE PAGE SIZE TRAVELS WITH THE FIELD LIST, because the editor cannot work it out alone.
      //
      // The field table warns about a box that has been dragged off the edge of the paper, and that
      // needs the paper's printed size. For the ten it is compiled in and the browser has it. For an
      // uploaded template it is a measurement off the artwork somebody supplied, held on the
      // template row and known ONLY here. Left out, the editor's honest answer would be null — and
      // null means "typeset, nothing to fall off", which would switch the off-page warning off on
      // exactly the papers whose every box was placed by hand against a scan.
      return NextResponse.json(
        {
          fields: documentFieldInventory(requested, paper.data, paper.html),
          page: paper.template
            ? { height: paper.template.pageHeightPt, width: paper.template.pageWidthPt }
            : pageSizeFor(requested as HiringPackDocument),
        },
        { headers: { "Cache-Control": "no-store, max-age=0" } },
      );
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // `preview=1` RETURNS THE SAME DOCUMENT AND RECORDS NOTHING.
    //
    // The fill screen shows the real page in a panel so an operator can read it and correct values
    // on it before committing to paper, and it reloads that panel after every single edit. Stamping
    // `*_printed_at` on each of those loads would report a document as printed the moment somebody
    // glanced at it, and would keep re-dating it while they were still typing — so "Printed on …"
    // would stop meaning anything, on the one screen whose whole job is to say what state each
    // paper is in.
    //
    // The BYTES ARE IDENTICAL either way, deliberately: a preview that renders through a different
    // path is not a preview, it is a second document that happens to look similar, and the defect
    // being fixed here is precisely somebody trusting a screen that did not match the paper. The
    // filing path depends on the same property from the other direction.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    const isPreview = url.searchParams.get("preview") === "1";
    // AND ONLY FOR THE TEN. `recordHiringPackPrinted` writes a `*_printed_at` column named in
    // `DOCUMENT_BINDINGS`, and a company template has no such column — nor should it get one per
    // template. That is the same position the two custody receipts are already in: they print, the
    // signed paper is filed, and nothing is stamped. See the note on that table.
    if (!isPreview && isBuiltInDocument(requested)) {
      // Stamped after the document is built, and never awaited into the response path: a print that
      // works but fails to record itself is a far better outcome than a print that refuses because
      // the audit write hiccupped. `recordHiringPackPrinted` swallows its own failures for the same
      // reason.
      void recordHiringPackPrinted(hrId, requested);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // EVERY PRINT TAKES A NUMBER — "make sure every paper and document is auto numbered".
    //
    // Awaited, unlike the stamp above, because the number has to be ON the page being served. It
    // cannot fail the print: `issuePaperNumber` answers null when the register is not set up or the
    // write failed, and the paper then prints exactly as it did before numbering existed. The
    // Authority's own forms are numbered in the register and left untouched on the page — see
    // `paperReferencePrintsOnFace`.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    const reference = isPreview
      ? null
      : await issuePaperNumber({
          copies: paper.copies,
          document: requested,
          documentLabel: paper.template ? paper.template.name : documentLabel(requested),
          hrId,
          issuedByHrId: access.hrId ?? null,
          mode: "employee",
          subjectName: paper.data.employee.nameAr ?? paper.data.employee.fullName,
        });

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // `format=pdf` SERVES THE SAME DOCUMENT AS A FILE, and exists for one reason: page numbers.
    //
    // The contract and the two clearances flow, so how many sheets they occupy is decided by the
    // print engine and is not knowable from the DOM — a browser-printed copy therefore cannot carry
    // "صفحة N من M" and this route does not pretend otherwise. Rendering here makes Chromium the
    // print engine, so the count is its own answer and the footer is exact.
    //
    // IT HANGS OFF THIS ROUTE RATHER THAN A ROUTE OF ITS OWN so it cannot drift: the permission
    // assert, the document validation, the version the employee actually signed, the field layer
    // and the print stamp have all already happened above. A parallel endpoint would eventually
    // resolve a different version from the one on screen, and nothing would say so.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    if (url.searchParams.get("format") === "pdf") {
      try {
        // ONE COPY IS RENDERED, and the rest are stamped from it. Chrome's `totalPages` counts the
        // whole PDF, so four copies of a three-page contract in one document footed every page
        // "صفحة N من 12" — a count of something nobody is holding. Each copy is signed on its own,
        // so it is numbered against itself. The copies are byte-identical by construction, so this
        // is the same output for one Chromium run instead of four.
        const one = await renderHiringPaper({
          ...paperInput,
          copies: "1",
          // The letter that says how many copies it was drawn up in must say the count being
          // printed, not the one copy drawn here.
          statedCopies: url.searchParams.get("copies"),
        });
        if (!one.ok) {
          return NextResponse.json({ error: one.code, message: one.message }, { status: one.status });
        }
        const pdf = await renderHiringPaperPdf(stampPaperReference(one.html, reference, requested), {
          copies: paper.copies,
          pageNumbers: documentCarriesHousePageNumbers(requested),
        });
        return new Response(Buffer.from(pdf), {
          headers: {
            "Content-Type": "application/pdf",
            // ASCII AND PREDICTABLE. The document label is Arabic and a company template's id is
            // `custom:<uuid>`, whose colon is not legal in a Windows filename — so the name is
            // built from the document key and the HR id, both of which are already safe, rather
            // than from anything a user typed. HR files these by hand; a stable name sorts.
            "Content-Disposition": `attachment; filename="${pdfFileName(requested, hrId)}"`,
            "Cache-Control": "no-store, max-age=0",
          },
        });
      } catch (error) {
        // Said in full rather than collapsed to "could not download": one is an environment that
        // cannot render at all, the other names a file that could not be read. The HTML is still
        // available from this same URL without `format=pdf`, so the paper is never unreachable.
        if (error instanceof PaperArtworkMissingError) {
          return NextResponse.json(
            { error: "hiring_pack_artwork_missing", message: error.message },
            { status: 409 },
          );
        }
        if (error instanceof ChromiumUnavailableError) {
          return NextResponse.json(
            {
              error: "hiring_pack_pdf_unavailable",
              message:
                "This environment cannot render a PDF. Open the document and use the browser's own "
                + "Print dialog instead — the page itself is unaffected.",
            },
            { status: 503 },
          );
        }
        throw error;
      }
    }

    return new Response(stampPaperReference(paper.html, reference, requested), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Never cached: the document carries live salary and identity data, and a stale copy
        // printed from a proxy would be signed as though it were current.
        "Cache-Control": "no-store, max-age=0",
      },
    });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_print_failed", message }, { status });
  }
}
