import { NextResponse } from "next/server";

import { systemContractDefaults } from "@/config/system-settings";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import { loadDocumentFieldLayout } from "@/lib/hiring-pack/field-layout-store";
import {
  renderClearanceCompanyHtml,
  renderClearanceEmployeeHtml,
} from "@/lib/hiring-pack/render-clearance";
import { documentFieldInventory } from "@/lib/hiring-pack/document-inventory";
import {
  asPrintableDocument,
  CUSTOM_DOCUMENT_DEFAULT_COPIES,
  type PrintableDocument,
} from "@/lib/hiring-pack/document-registry";
import {
  isCustomTemplateLayerMissing,
  loadCurrentCustomTemplate,
  loadCustomTemplateVersion,
  type CustomTemplate,
} from "@/lib/hiring-pack/custom-template-store";
import { renderCustomTemplateHtml } from "@/lib/hiring-pack/render-custom-template";
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
import {
  currentTemplateVersion,
  findTemplateVersion,
  templateVersionsFor,
} from "@/lib/hiring-pack/template-registry";
import { customTemplateKeyOf, HIRING_PACK_DOCUMENTS, isBuiltInDocument } from "@/lib/hiring-pack/types";
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
    render: (
      data: HiringPackData,
      copies: number,
      templateId?: string | null,
      fields?: readonly DocumentFieldRow[],
    ) => string;
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

/**
 * The uploaded template a `custom:<uuid>` document names, at the version being printed.
 *
 * A VERSION IS VALIDATED AGAINST ITS OWN TEMPLATE, exactly as the built-in check below does. A
 * caller passing one template's document with another template's version id is asking for something
 * that does not exist, and answering it with the current template would be the same defect the
 * built-in path already guards: somebody believing they printed an archived form when they printed
 * today's. Null here means "no such template", which the route answers as a 404.
 */
async function resolveCustomTemplate(
  document: string,
  requestedVersion: string | null,
): Promise<CustomTemplate | null> {
  const key = customTemplateKeyOf(document);
  if (!key) return null;

  if (requestedVersion) {
    const version = await loadCustomTemplateVersion(requestedVersion);
    return version && version.key === key ? version : null;
  }

  return loadCurrentCustomTemplate(key);
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

    // An explicit version, for reprinting an ARCHIVED template from the Archive screen.
    //
    // Validated against the registry rather than trusted, and validated against the document too: a
    // caller passing `document=form1&version=contract-v1` is asking for something that does not
    // exist, and answering it with a silently-substituted current template is how somebody ends up
    // believing they printed an archived form when they printed today's. Only the contract has more
    // than one version today; the check is written for all five because the next one will not.
    //
    // A COMPANY TEMPLATE IS CHECKED THE SAME WAY, further down rather than here: its versions are
    // rows, so `resolveCustomTemplate` asks the database and refuses a version belonging to another
    // template. The two paths reach the same verdict; only the register differs.
    const requestedVersion = url.searchParams.get("version");
    if (requestedVersion && isBuiltInDocument(requested)) {
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

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // A COMPANY TEMPLATE IS RESOLVED FROM THE DATABASE, not from a table in this file.
    //
    // Everything below this point is the same for both kinds — the field layer scopes to the
    // version, the inventory reads the rendered html, the preview returns identical bytes — so the
    // branch is only about WHERE the document and its version come from. The ten are compiled in;
    // an uploaded template is a row, and its "version" is that row's own id.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    const template = isBuiltInDocument(requested)
      ? null
      : await resolveCustomTemplate(requested, requestedVersion);
    if (!isBuiltInDocument(requested) && !template) {
      return NextResponse.json(
        {
          error: "unknown_company_template",
          message: requestedVersion
            ? "That version is not a version of this company template."
            : "That company template is no longer on record.",
        },
        { status: 404 },
      );
    }

    const defaultCopies = template
      ? CUSTOM_DOCUMENT_DEFAULT_COPIES
      : RENDERERS[requested as HiringPackDocument].copies;
    const copies = resolveCopies(url.searchParams.get("copies"), defaultCopies);

    // The operator's own field layer, read against the version being printed.
    //
    // KEYED TO THE VERSION, NOT THE DOCUMENT. A layout is a set of coordinates measured against one
    // piece of artwork, so carrying it forward onto a replaced template would put every field a few
    // millimetres off on a form nobody re-measured — which prints, and looks nearly right, and is
    // exactly the failure this is placed to avoid. Reprinting an archived version therefore gets the
    // layer that version was signed with, and today's version gets today's.
    //
    // A missing table answers with an empty layer rather than an error: until the migration is
    // approved and applied that is every environment's state, and a hiring pack that refuses to
    // print because an editor's table is absent would be a worse regression than the feature is a
    // gain.
    const versionId = template
      ? template.id
      : (requestedVersion ?? currentTemplateVersion(requested as HiringPackDocument).id);
    const fields = await loadDocumentFieldLayout(requested, versionId);
    const html = template
      ? renderCustomTemplateHtml(template, data, copies, fields)
      : RENDERERS[requested as HiringPackDocument].render(data, copies, requestedVersion, fields);

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // `inventory=1` ANSWERS "WHAT FIELDS DOES THIS TEMPLATE HAVE?" — the field table's whole data
    // source, and the reason it hangs off this route rather than a route of its own.
    //
    // Everything the question needs has already happened by this line: the permission check, the
    // employee's resolved pack, the version validation, the field layer, and the document rendered
    // exactly as it would be served. `documentFieldInventory` reads that same `html` rather than
    // rendering a second time, so the list can never describe a document different from the one on
    // screen — which is the failure a separate endpoint would eventually produce.
    //
    // RETURNED BEFORE THE PRINT STAMP, deliberately. Opening the field table is not printing, and
    // `preview=1` exists for exactly this reason; falling through would date every document as
    // printed the moment somebody looked at its field list.
    // ─────────────────────────────────────────────────────────────────────────────────────────
    if (url.searchParams.get("inventory") === "1") {
      return NextResponse.json(
        { fields: documentFieldInventory(requested, data, html) },
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
    // being fixed here is precisely somebody trusting a screen that did not match the paper.
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
