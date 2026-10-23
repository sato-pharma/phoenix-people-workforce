import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertMayPrintPaper, assertMayUseHrForms } from "@/lib/hiring-pack/paper-access";
import { loadCompanyDetails } from "@/lib/hiring-pack/company-details-store";
import { isCustomTemplateLayerMissing } from "@/lib/hiring-pack/custom-template-store";
import { asPrintableDocument, documentGroup } from "@/lib/hiring-pack/document-registry";
import { paperReferencePrintsOnFace } from "@/lib/hiring-pack/forms-drive";
import {
  buildManualHiringPack,
  manualPaperInputs,
  sanitizeManualValues,
} from "@/lib/hiring-pack/manual-pack";
import { renderHiringPaper } from "@/lib/hiring-pack/render-paper";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A paper typed in by hand, rendered for the screen to show and print.
//
// POST, NOT GET, because the typed values include a national ID and a salary, and those do not
// belong in a URL — URLs are logged by every proxy between here and the browser. It WRITES NOTHING:
// the paper is returned as html, and its number is taken separately at the moment it is printed.
// So it is gated like printing (`employee_documents` read), and still checked same-origin because it
// is a POST.

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: "Not permitted.", status: 403 };
  if (isCustomTemplateLayerMissing(error)) {
    return { message: "Company templates are not set up yet.", status: 409 };
  }
  return { message: clientSafeErrorMessage(error, "Something went wrong."), status: 500 };
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    // Gated like printing: employee_documents as before, or a seat in SEAT_PRINTABLE_DOCUMENTS on
    // its own papers only (checked below once the document is known).
    await assertMayUseHrForms(access, "read");

    const payload = (await request.json()) as {
      address?: unknown;
      copies?: unknown;
      document?: unknown;
      group?: unknown;
      values?: unknown;
      versionId?: unknown;
    };
    const document = typeof payload.document === "string" ? asPrintableDocument(payload.document) : null;
    if (!document) {
      return NextResponse.json(
        { error: "invalid_request", message: "That is not a paper this system prints." },
        { status: 400 },
      );
    }
    await assertMayPrintPaper(access, document, "read");

    const values = sanitizeManualValues(payload.values);
    const company = await loadCompanyDetails();
    const data = buildManualHiringPack(values, company);

    const paper = await renderHiringPaper({
      access,
      address: typeof payload.address === "string" ? payload.address : null,
      copies: payload.copies === undefined ? null : String(payload.copies),
      data,
      document,
      hrId: data.employee.hrId,
      version: typeof payload.versionId === "string" ? payload.versionId : null,
    });
    if (!paper.ok) {
      return NextResponse.json({ error: paper.code, message: paper.message }, { status: paper.status });
    }

    // An uploaded template's package is on its row, which the caller holds; the built-ins answer
    // from the registry and ignore it.
    const groups = typeof payload.group === "string" ? { [document]: payload.group } : undefined;
    return NextResponse.json(
      {
        copies: paper.copies,
        html: paper.html,
        inputs: manualPaperInputs(document, paper.data, paper.html, documentGroup(document, groups) === "leaving"),
        numberOnFace: paperReferencePrintsOnFace(document),
      },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_pack_manual_paper_failed", message }, { status });
  }
}
