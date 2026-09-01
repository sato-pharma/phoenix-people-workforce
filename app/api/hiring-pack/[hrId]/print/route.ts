import { NextResponse } from "next/server";

import { systemContractDefaults } from "@/config/system-settings";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  renderClearanceCompanyHtml,
  renderClearanceEmployeeHtml,
} from "@/lib/hiring-pack/render-clearance";
import { renderContractHtml } from "@/lib/hiring-pack/render-contract";
import {
  renderCustodyLaptopHtml,
  renderCustodyMobileHtml,
} from "@/lib/hiring-pack/render-custody";
import { renderForm1Html } from "@/lib/hiring-pack/render-form1";
import { renderForm6Html } from "@/lib/hiring-pack/render-form6";
import { renderWorkerFormHtml } from "@/lib/hiring-pack/render-worker-form";
import {
  renderMutualTerminationHtml,
  renderResignationHtml,
} from "@/lib/hiring-pack/render-labour-exit";
import {
  getHiringPack,
  hiringPackErrorMessage,
  isHiringPackEmployeeMissing,
  isHiringPackSchemaMissing,
  recordHiringPackPrinted,
} from "@/lib/hiring-pack/service";
import { findTemplateVersion, templateVersionsFor } from "@/lib/hiring-pack/template-registry";
import { HIRING_PACK_DOCUMENTS } from "@/lib/hiring-pack/types";
import type { HiringPackData, HiringPackDocument } from "@/lib/hiring-pack/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The printable document itself. It returns HTML rather than a PDF because the browser is what
// shapes and orders Arabic correctly — see the note at the top of render-shared.ts — and because
// "Print → Save as PDF" from this page produces a real PDF anyway, with selectable text.
//
// COPY COUNTS ARE NOT A QUERY PARAMETER BY DEFAULT. Three Form 1s and four contracts are the
// owner's standing instruction and مادة (19) of the contract states the four in its own text, so
// the counts live in `systemContractDefaults` and a caller has to ask deliberately to differ.

const DOCUMENTS = new Set<HiringPackDocument>(HIRING_PACK_DOCUMENTS);

/**
 * What each document prints, and how many of it.
 *
 * Keyed by the document union so a sixth document cannot be added without deciding both — the same
 * reason the service keys its column bindings this way. The counts are each the form's own stated
 * requirement, not a preference: مادة (19) of the contract says four, Form 1 and Form 6 both say
 * "من أصل وصورتين" on their back pages, البند السابع of the mutual-termination agreement gives
 * each party a copy, the custody receipt's own subtitle says "يُحرَّر من نسختين", and each half of the
 * clearance pair says on its own face that the other side keeps a copy of it.
 */
const RENDERERS: Record<
  HiringPackDocument,
  {
    render: (data: HiringPackData, copies: number, templateId?: string | null) => string;
    copies: number;
  }
> = {
  contract: { render: renderContractHtml, copies: systemContractDefaults.contractCopies },
  form1: { render: renderForm1Html, copies: systemContractDefaults.form1Copies },
  workerDataForm: {
    render: renderWorkerFormHtml,
    copies: systemContractDefaults.workerDataFormCopies,
  },
  custodyLaptop: {
    render: renderCustodyLaptopHtml,
    copies: systemContractDefaults.custodyLaptopCopies,
  },
  custodyMobile: {
    render: renderCustodyMobileHtml,
    copies: systemContractDefaults.custodyMobileCopies,
  },
  form6: { render: renderForm6Html, copies: systemContractDefaults.form6Copies },
  resignation: { render: renderResignationHtml, copies: systemContractDefaults.resignationCopies },
  mutualTermination: {
    render: renderMutualTerminationHtml,
    copies: systemContractDefaults.mutualTerminationCopies,
  },
  clearanceEmployee: {
    render: renderClearanceEmployeeHtml,
    copies: systemContractDefaults.clearanceEmployeeCopies,
  },
  clearanceCompany: {
    render: renderClearanceCompanyHtml,
    copies: systemContractDefaults.clearanceCompanyCopies,
  },
};

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: hiringPackErrorMessage(error), status: 403 };
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
          message: `Pass document= one of ${HIRING_PACK_DOCUMENTS.join(", ")}.`,
        },
        { status: 400 },
      );
    }

    // An explicit version, for reprinting an ARCHIVED template from the Archive screen.
    //
    // Validated against the registry rather than trusted, and validated against the document too: a
    // caller passing `document=form1&version=contract-v1` is asking for something that does not
    // exist, and answering it with a silently-substituted current template is how somebody ends up
    // believing they printed an archived form when they printed today's. Only the contract has more
    // than one version today; the check is written for all five because the next one will not.
    const requestedVersion = url.searchParams.get("version");
    if (requestedVersion) {
      const entry = findTemplateVersion(requestedVersion);
      if (!entry || entry.document !== requested) {
        return NextResponse.json(
          {
            error: "unknown_hiring_pack_template_version",
            message: `"${requestedVersion}" is not a registered version of ${requested}. Versions for it: ${templateVersionsFor(
              requested,
            )
              .map((version) => version.id)
              .join(", ")}.`,
          },
          { status: 400 },
        );
      }
    }

    const data = await getHiringPack(hrId);
    const renderer = RENDERERS[requested];
    const copies = resolveCopies(url.searchParams.get("copies"), renderer.copies);
    const html = renderer.render(data, copies, requestedVersion);

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
    // being fixed here is precisely somebody trusting a screen that did not match the paper.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    const isPreview = url.searchParams.get("preview") === "1";
    if (!isPreview) {
      // Stamped after the document is built, and never awaited into the response path: a print that
      // works but fails to record itself is a far better outcome than a print that refuses because
      // the audit write hiccupped. `recordHiringPackPrinted` swallows its own failures for the same
      // reason.
      void recordHiringPackPrinted(hrId, requested);
    }

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
