import { NextResponse } from "next/server";

import { systemContractDefaults } from "@/config/system-settings";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { renderContractHtml } from "@/lib/hiring-pack/render-contract";
import { renderForm1Html } from "@/lib/hiring-pack/render-form1";
import {
  getHiringPack,
  hiringPackErrorMessage,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  recordHiringPackPrinted,
} from "@/lib/hiring-pack/service";
import type { HiringPackDocument } from "@/lib/hiring-pack/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The printable document itself. It returns HTML rather than a PDF because the browser is what
// shapes and orders Arabic correctly — see the note at the top of render-shared.ts — and because
// "Print → Save as PDF" from this page produces a real PDF anyway, with selectable text.
//
// COPY COUNTS ARE NOT A QUERY PARAMETER BY DEFAULT. Three Form 1s and four contracts are the
// owner's standing instruction and مادة (19) of the contract states the four in its own text, so
// the counts live in `systemContractDefaults` and a caller has to ask deliberately to differ.

const DOCUMENTS = new Set<HiringPackDocument>(["contract", "form1"]);

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: hiringPackErrorMessage(error), status: 403 };
  if (isHiringPackEmployeeMissing(error)) {
    return { message: hiringPackErrorMessage(error), status: 404 };
  }
  if (isHiringPackSchemaMissing(error)) {
    return {
      message:
        "Hiring pack schema is not ready. Run the Supabase migration for employee_hiring_profile.",
      status: 409,
    };
  }
  return { message: hiringPackErrorMessage(error), status: 500 };
}

/** A caller-supplied copy count, clamped. Anything unparseable falls back to the standing default. */
function resolveCopies(raw: string | null, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  // Twenty copies of a five-page contract is eighty sheets; past that it is a typo, not a request.
  return Math.min(parsed, 20);
}

export async function GET(request: Request, { params }: { params: Promise<{ hrId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");
    const { hrId } = await params;

    const url = new URL(request.url);
    const requested = url.searchParams.get("document") as HiringPackDocument | null;
    if (!requested || !DOCUMENTS.has(requested)) {
      return NextResponse.json(
        {
          error: "invalid_hiring_pack_document",
          message: "Pass document=contract or document=form1.",
        },
        { status: 400 },
      );
    }

    const data = await getHiringPack(hrId);
    const copies = resolveCopies(
      url.searchParams.get("copies"),
      requested === "contract"
        ? systemContractDefaults.contractCopies
        : systemContractDefaults.form1Copies,
    );

    const html =
      requested === "contract"
        ? renderContractHtml(data, copies)
        : renderForm1Html(data, copies);

    // Stamped after the document is built, and never awaited into the response path: a print that
    // works but fails to record itself is a far better outcome than a print that refuses because
    // the audit write hiccupped. `recordHiringPackPrinted` swallows its own failures for the same
    // reason.
    void recordHiringPackPrinted(hrId, requested);

    return new Response(html, {
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
