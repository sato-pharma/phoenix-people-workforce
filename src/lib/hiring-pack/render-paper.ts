// One hiring paper, resolved and rendered. The single place that turns "which document, for whom"
// into the exact HTML that gets printed.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS LEFT THE ROUTE. It used to live inside `GET /api/hiring-pack/[hrId]/print`, which was
// correct while printing was the only thing that wanted a rendered paper. Filing a confirmed
// signature wants the same paper — necessarily THE SAME, since the whole promise of the filed copy
// is that it is the document that was put in front of the employee. Two renderers would satisfy
// that promise only for as long as nobody edited one of them.
//
// So the resolution and the rendering live here, and the two callers keep what is genuinely theirs:
// the print route keeps its HTTP shaping, its `preview=1` rule and its `*_printed_at` stamp; the
// filing path keeps the PDF and the storage write. Neither can render a different document from the
// other, because neither renders at all.
//
// PERMISSIONS ARE NOT ASSERTED HERE, deliberately. `assertPermission(ctx, resource, action)` belongs
// in the route handler before any mutation — the house rule — and both callers do it. What IS here
// is the template's own role list, because that is a property of the template rather than of the
// request, and a caller that forgot it would silently print a paper its owner restricted.

import { systemContractDefaults } from "@/config/system-settings";
import type { AccessContext } from "@/lib/auth/permissions";
import {
  canRolePrintCustomTemplate,
  loadCurrentCustomTemplate,
  loadCustomTemplateVersion,
  type CustomTemplate,
} from "@/lib/hiring-pack/custom-template-store";
import type { DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import { loadDocumentFieldLayout } from "@/lib/hiring-pack/field-layout-store";
import type { PrintableDocument } from "@/lib/hiring-pack/document-registry";
import {
  renderClearanceCompanyHtml,
  renderClearanceEmployeeHtml,
} from "@/lib/hiring-pack/render-clearance";
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
import { getHiringPack } from "@/lib/hiring-pack/service";
import {
  currentTemplateVersion,
  findTemplateVersion,
  templateVersionsFor,
} from "@/lib/hiring-pack/template-registry";
import { customTemplateKeyOf, isBuiltInDocument } from "@/lib/hiring-pack/types";
import type { HiringPackData, HiringPackDocument } from "@/lib/hiring-pack/types";

/**
 * What each document prints, and how many of it.
 *
 * Keyed by the document union so an eleventh document cannot be added without deciding both — the
 * same reason the service keys its column bindings this way. The counts are each the form's own
 * stated requirement, not a preference: the contract's article 19 says four, Form 1 and Form 6 both
 * ask for an original and two copies on their back pages, clause seven of the mutual-termination
 * agreement gives each party a copy, the custody receipt's own subtitle says it is drawn in two
 * copies, and each half of the clearance pair says on its own face that the other side keeps one.
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
  form1: { render: renderForm1Html, copies: systemContractDefaults.form1Copies },
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

/** A reason the paper cannot be produced, carrying the status the print route already answered. */
export type PaperRefusal = {
  code: string;
  message: string;
  ok: false;
  status: number;
};

/** The paper, and everything either caller needs about it. */
export type RenderedPaper = {
  copies: number;
  data: HiringPackData;
  fields: readonly DocumentFieldRow[];
  html: string;
  ok: true;
  /** The uploaded template this came from, or null for one of the ten built-in papers. */
  template: CustomTemplate | null;
  /** The version the field layer was read against — a registry id, or the template row's id. */
  versionId: string;
};

/**
 * The uploaded template a `custom:<uuid>` document names, at the version being printed.
 *
 * A VERSION IS VALIDATED AGAINST ITS OWN TEMPLATE, exactly as the built-in check below does. A
 * caller passing one template's document with another template's version id is asking for something
 * that does not exist, and answering it with the current template would be the same defect the
 * built-in path already guards: somebody believing they printed an archived form when they printed
 * today's. Null here means "no such template".
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

/** A caller-supplied copy count, clamped. Anything unparseable falls back to the standing default. */
export function resolveCopies(raw: string | null, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  // Twenty copies of a five-page contract is eighty sheets; past that it is a typo, not a request.
  return Math.min(parsed, 20);
}

/**
 * Resolve and render one paper for one employee.
 *
 * Every refusal is RETURNED rather than thrown, carrying the status the print route has always
 * answered, so moving this out of the route could not change a single response code. Genuine
 * failures — a missing employee, an absent schema — still throw, because both callers already map
 * those through the same `apiError` shape.
 */
export async function renderHiringPaper(input: {
  access: AccessContext;
  copies?: string | null;
  document: PrintableDocument;
  hrId: string;
  version?: string | null;
}): Promise<RenderedPaper | PaperRefusal> {
  const { access, document: requested, hrId } = input;
  const requestedVersion = input.version ?? null;

  // An explicit version, for reprinting an ARCHIVED template from the Archive screen.
  //
  // Validated against the registry rather than trusted, and validated against the document too: a
  // caller passing `document=form1&version=contract-v1` is asking for something that does not
  // exist, and answering it with a silently-substituted current template is how somebody ends up
  // believing they printed an archived form when they printed today's.
  if (requestedVersion && isBuiltInDocument(requested)) {
    const entry = findTemplateVersion(requestedVersion);
    if (!entry || entry.document !== requested) {
      return {
        code: "unknown_hiring_pack_template_version",
        message: `"${requestedVersion}" is not a registered version of ${requested}. Versions for it: ${templateVersionsFor(
          requested,
        )
          .map((version) => version.id)
          .join(", ")}.`,
        ok: false,
        status: 400,
      };
    }
  }

  const data = await getHiringPack(hrId);

  // A COMPANY TEMPLATE IS RESOLVED FROM THE DATABASE, not from a table in this file. Everything
  // after this point is the same for both kinds; the branch is only about WHERE the document and
  // its version come from. The ten are compiled in; an uploaded template is a row, and its
  // "version" is that row's own id.
  const template = isBuiltInDocument(requested)
    ? null
    : await resolveCustomTemplate(requested, requestedVersion);
  if (!isBuiltInDocument(requested) && !template) {
    return {
      code: "unknown_company_template",
      message: requestedVersion
        ? "That version is not a version of this company template."
        : "That company template is no longer on record.",
      ok: false,
      status: 404,
    };
  }

  // THE TEMPLATE'S OWN ROLE LIST, ON TOP OF THE MODULE PERMISSION — the second half of the gate.
  // An uploaded template is not necessarily an HR form: a warning letter or a salary certificate
  // should not print for everyone who can print a contract.
  //
  // 403 rather than 404: the caller may legitimately see this template listed, so pretending it
  // does not exist would send somebody chasing a missing paper instead of asking for the role.
  if (template && !canRolePrintCustomTemplate(access.role, template.printableByRoles)) {
    return {
      code: "forbidden_company_template",
      message: `"${template.name}" is limited to ${(template.printableByRoles ?? []).join(", ")}.`,
      ok: false,
      status: 403,
    };
  }

  // THE TEMPLATE'S OWN NUMBER, not a constant. A built-in paper has its count compiled in beside
  // its renderer because the count is a property of that form; an uploaded template carries the
  // same fact on its row, set by whoever uploaded it.
  const defaultCopies = template
    ? template.defaultCopies
    : RENDERERS[requested as HiringPackDocument].copies;
  const copies = resolveCopies(input.copies ?? null, defaultCopies);

  // The operator's own field layer, read against the version being printed.
  //
  // KEYED TO THE VERSION, NOT THE DOCUMENT. A layout is a set of coordinates measured against one
  // piece of artwork, so carrying it forward onto a replaced template would put every field a few
  // millimetres off on a form nobody re-measured. Reprinting an archived version therefore gets the
  // layer that version was signed with, and today's version gets today's.
  const versionId = template
    ? template.id
    : (requestedVersion ?? currentTemplateVersion(requested as HiringPackDocument).id);
  const fields = await loadDocumentFieldLayout(requested, versionId);
  const html = template
    ? renderCustomTemplateHtml(template, data, copies, fields)
    : RENDERERS[requested as HiringPackDocument].render(data, copies, requestedVersion, fields);

  return { copies, data, fields, html, ok: true, template, versionId };
}
