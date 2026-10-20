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
import { stampArtworkUri } from "@/lib/hiring-pack/document-mark-artwork";
import {
  layoutUsesMark,
  parseMarkSelection,
  withMarkArtwork,
} from "@/lib/hiring-pack/document-marks";
import type { DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import { loadDocumentFieldLayout } from "@/lib/hiring-pack/field-layout-store";
import { loadHrSignatureUri } from "@/lib/hiring-pack/hr-signature";
import { isPaperOpenToRole, type PrintableDocument } from "@/lib/hiring-pack/document-registry";
import { packForPaper } from "@/lib/hiring-pack/paper-access";
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
import {
  renderContractNonRenewalHtml,
  renderContractRenewalHtml,
} from "@/lib/hiring-pack/render-renewal";
import {
  HR_PAPER_ABSENCE_WARNING_V2,
  HR_PAPER_DEEMED_RESIGNATION_V2,
  HR_PAPER_DISCIPLINARY_PENALTY_V1,
  HR_PAPER_DISCIPLINARY_WARNING_V1,
  HR_PAPER_DOCUMENTS_RECEIPT_V1,
  HR_PAPER_DOCUMENTS_RETURN_V1,
  HR_PAPER_EXIT_INTERVIEW_V1,
  HR_PAPER_EXPERIENCE_CERTIFICATE_V1,
  HR_PAPER_HANDOVER_RECORD_V1,
  HR_PAPER_HEALTH_INSURANCE_AUTHORIZATION_V1,
  HR_PAPER_INSURANCE_PRINT_LETTER_V1,
  HR_PAPER_NDA_V1,
  HR_PAPER_SALARY_ADJUSTMENT_V1,
  HR_PAPER_SALARY_LETTER_AR_V1,
  HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1,
  HR_PAPER_SOCIAL_STATUS_V1,
  HR_PAPER_TRANSFER_DECISION_V1,
} from "@/lib/hiring-pack/hr-paper-text";
import { renderOfficialPackFormHtml } from "@/lib/hiring-pack/render-official-form";
import { renderExperienceCertificateEnHtml } from "@/lib/hiring-pack/experience-certificate-en";
import { renderSalaryLetterEnHtml } from "@/lib/hiring-pack/salary-letter-en";
import { renderHrPaperHtml } from "@/lib/hiring-pack/render-hr-paper";
import type { HrPaperTemplate } from "@/lib/hiring-pack/hr-paper-template";
import { renderForm1Html } from "@/lib/hiring-pack/render-form1";
import { renderForm6Html } from "@/lib/hiring-pack/render-form6";
import { renderWorkerFormHtml } from "@/lib/hiring-pack/render-worker-form";
import {
  renderMutualTerminationHtml,
  renderResignationHtml,
} from "@/lib/hiring-pack/render-labour-exit";
import { parsePrintAddress, withPrintAddress } from "@/lib/hiring-pack/print-address";
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
/**
 * One of Sato's own papers, in the shape `RENDERERS` expects.
 *
 * The renderer takes the paper as its THIRD argument — after the data and the copy count — because
 * which paper is being printed is a property of the entry, not of the request. Binding it here
 * means every entry below is a name and a count, and there is no argument order left to get wrong.
 */
function housePaper(template: HrPaperTemplate) {
  return (
    data: HiringPackData,
    copies: number,
    templateId?: string | null,
    fields?: readonly DocumentFieldRow[],
    statedCopies?: number,
  ) => renderHrPaperHtml(data, copies, template, templateId, fields ?? [], statedCopies);
}

const RENDERERS: Record<
  HiringPackDocument,
  {
    render: (
      data: HiringPackData,
      copies: number,
      templateId?: string | null,
      fields?: readonly DocumentFieldRow[],
      // The copy count a paper that STATES it should state, when that is not the count rendered —
      // the PDF route renders one copy and stamps the rest, and must not write "one copy" on a run of
      // three. Only the house papers read it.
      statedCopies?: number,
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
  // SATO'S SIX OWN PAPERS all go through one renderer, so each entry only has to say WHICH paper.
  // `housePaper` exists so that adding a seventh is one line here plus its text, rather than an
  // eighth near-identical closure — and so the argument order can never be got wrong for one of
  // them and right for the rest.
  nda: { render: housePaper(HR_PAPER_NDA_V1), copies: systemContractDefaults.ndaCopies },
  appointmentDocsReceipt: {
    render: housePaper(HR_PAPER_DOCUMENTS_RECEIPT_V1),
    copies: systemContractDefaults.appointmentDocsReceiptCopies,
  },
  socialStatusSheet: {
    render: housePaper(HR_PAPER_SOCIAL_STATUS_V1),
    copies: systemContractDefaults.socialStatusSheetCopies,
  },
  absenceWarning: {
    render: housePaper(HR_PAPER_ABSENCE_WARNING_V2),
    copies: systemContractDefaults.absenceWarningCopies,
  },
  deemedResignation: {
    render: housePaper(HR_PAPER_DEEMED_RESIGNATION_V2),
    copies: systemContractDefaults.deemedResignationCopies,
  },
  appointmentDocsReturn: {
    render: housePaper(HR_PAPER_DOCUMENTS_RETURN_V1),
    copies: systemContractDefaults.appointmentDocsReturnCopies,
  },
  experienceCertificate: {
    render: housePaper(HR_PAPER_EXPERIENCE_CERTIFICATE_V1),
    copies: systemContractDefaults.experienceCertificateCopies,
  },
  // THE ENGLISH CERTIFICATE IS NOT A HOUSE PAPER and does not go through `housePaper`: it is an
  // English-facing document with its own renderer, the way the payslip is. See its module header.
  experienceCertificateEn: {
    render: renderExperienceCertificateEnHtml,
    copies: systemContractDefaults.experienceCertificateCopies,
  },
  // The HR letter — English, its own renderer, and it states the BASIC salary only.
  salaryLetterEn: {
    render: renderSalaryLetterEnHtml,
    copies: systemContractDefaults.salaryLetterCopies,
  },
  // Its Arabic counterpart IS an `HrPaperTemplate`, drawn through `housePaper` the way the Arabic
  // certificate of experience is — see the note on `HrPaperKind.salaryLetter`.
  salaryLetterAr: {
    render: housePaper(HR_PAPER_SALARY_LETTER_AR_V1),
    copies: systemContractDefaults.salaryLetterCopies,
  },
  // THE LETTERS PACK OF 2026-09-13. The company's own papers are house papers; the government
  // forms print their artwork as issued — see official-pack-forms.ts.
  disciplinaryWarning: {
    render: housePaper(HR_PAPER_DISCIPLINARY_WARNING_V1),
    copies: systemContractDefaults.disciplinaryWarningCopies,
  },
  disciplinaryPenalty: {
    render: housePaper(HR_PAPER_DISCIPLINARY_PENALTY_V1),
    copies: systemContractDefaults.disciplinaryPenaltyCopies,
  },
  transferDecision: {
    render: housePaper(HR_PAPER_TRANSFER_DECISION_V1),
    copies: systemContractDefaults.transferDecisionCopies,
  },
  salaryAdjustment: {
    render: housePaper(HR_PAPER_SALARY_ADJUSTMENT_V1),
    copies: systemContractDefaults.salaryAdjustmentCopies,
  },
  socialInsuranceAuthorization: {
    render: housePaper(HR_PAPER_SOCIAL_INSURANCE_AUTHORIZATION_V1),
    copies: systemContractDefaults.socialInsuranceAuthorizationCopies,
  },
  healthInsuranceAuthorization: {
    render: housePaper(HR_PAPER_HEALTH_INSURANCE_AUTHORIZATION_V1),
    copies: systemContractDefaults.healthInsuranceAuthorizationCopies,
  },
  insurancePrintLetter: {
    render: housePaper(HR_PAPER_INSURANCE_PRINT_LETTER_V1),
    copies: systemContractDefaults.insurancePrintLetterCopies,
  },
  handoverRecord: {
    render: housePaper(HR_PAPER_HANDOVER_RECORD_V1),
    copies: systemContractDefaults.handoverRecordCopies,
  },
  exitInterview: {
    render: housePaper(HR_PAPER_EXIT_INTERVIEW_V1),
    copies: systemContractDefaults.exitInterviewCopies,
  },
  maternityCompensation: {
    render: renderOfficialPackFormHtml("maternityCompensation"),
    copies: systemContractDefaults.maternityCompensationCopies,
  },
  insuranceForm2: {
    render: renderOfficialPackFormHtml("insuranceForm2"),
    copies: systemContractDefaults.insuranceForm2Copies,
  },
  carInsuranceCertificate: {
    render: renderOfficialPackFormHtml("carInsuranceCertificate"),
    copies: systemContractDefaults.carInsuranceCertificateCopies,
  },
  wageProgressSheet: {
    render: renderOfficialPackFormHtml("wageProgressSheet"),
    copies: systemContractDefaults.wageProgressSheetCopies,
  },
  officialHolidaysSheet: {
    render: renderOfficialPackFormHtml("officialHolidaysSheet"),
    copies: systemContractDefaults.officialHolidaysSheetCopies,
  },
  sickLeaveSheet: {
    render: renderOfficialPackFormHtml("sickLeaveSheet"),
    copies: systemContractDefaults.sickLeaveSheetCopies,
  },
  penaltiesSheet: {
    render: renderOfficialPackFormHtml("penaltiesSheet"),
    copies: systemContractDefaults.penaltiesSheetCopies,
  },
  penaltyRegulationsApproval: {
    render: renderOfficialPackFormHtml("penaltyRegulationsApproval"),
    copies: systemContractDefaults.penaltyRegulationsApprovalCopies,
  },
  contractRenewal: {
    render: renderContractRenewalHtml,
    copies: systemContractDefaults.contractRenewalCopies,
  },
  contractNonRenewal: {
    render: renderContractNonRenewalHtml,
    copies: systemContractDefaults.contractNonRenewalCopies,
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
  /**
   * Which company address the paper prints, chosen at the desk — `registered` or `office`
   * (`print-address.ts`). Absent is the normal case and prints the registered head office, exactly as
   * every paper did before the choice existed.
   */
  address?: string | null;
  copies?: string | null;
  /**
   * The device a CUSTODY receipt is being printed for, from the device register.
   *
   * Optional, and absent is the normal case — the receipt is very often printed before the machine
   * is in anybody's hand, and then it prints ruled blanks exactly as it always has. Every other
   * document in the pack ignores it. When it IS given, the serial and IMEI on the paper come from
   * the register row rather than from somebody copying them off the underside of a laptop.
   */
  custodyDeviceId?: string | null;
  /**
   * A pack already built — a paper TYPED IN BY HAND (see manual-pack.ts). Absent is the normal
   * case, and then the pack is read from the employee's record as it always was. The paper is drawn
   * by the same renderers either way, which is what makes the two modes one document.
   */
  data?: HiringPackData;
  document: PrintableDocument;
  hrId: string;
  /**
   * WHICH MARKS THIS RUN IS STAMPED AND SIGNED WITH — a comma list, and ABSENT MEANS NONE.
   *
   * A layout row says where the seal goes on this paper; this says whether this print carries it.
   * The default is deliberately the unstamped paper: see `parseMarkSelection` for the owner's ruling
   * and why "placed" and "printed" had to stop being the same thing.
   */
  marks?: string | null;
  /** The count the paper states about itself, when it differs from `copies` — see `RENDERERS`. */
  statedCopies?: string | null;
  version?: string | null;
}): Promise<RenderedPaper | PaperRefusal> {
  const { access, document: requested, hrId } = input;
  const requestedVersion = input.version ?? null;

  // THE SEAT'S OWN PAPER LIST — the choke point. A seat named in SEAT_PRINTABLE_DOCUMENTS prints its
  // listed built-in papers and nothing else, before the pack is even read: the print, hand-typed
  // and sign routes all render through here, so a route that forgot its own check still cannot
  // hand her another paper (owner, 2026-10-20). Every other role passes untouched.
  if (!isPaperOpenToRole(access.role, requested)) {
    return {
      code: "forbidden_paper_for_seat",
      message: "This paper is not one your role prints.",
      ok: false,
      status: 403,
    };
  }

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

  // THE SALARY-BLIND SEAT IS DRAWN FROM THE BLANKED PACK, here at the choke point (owner, 2026-10-20).
  // Every renderer puts the salary into its values map whether or not its own text prints it, and a
  // field placed in the layout editor prints whatever that map holds — so for the HR Operations
  // Specialist every paper but the renewal annex renders from `packForPaper`, which carries no
  // salary, gross or insurance wage. Print, `inventory=1`, the hand-typed paper and the signed-copy
  // filing all render through this line, and all read `data` back from what it returns.
  const data = packForPaper(
    access,
    requested,
    withPrintAddress(
      input.data ?? (await getHiringPack(hrId, input.custodyDeviceId ?? null)),
      parsePrintAddress(input.address),
    ),
  );

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
  const stored = await loadDocumentFieldLayout(requested, versionId);

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // THE ARTWORK FOR ANY STAMP OR SIGNATURE SOMEBODY PLACED, resolved HERE and nowhere else.
  //
  // It has to be here because this is the last place that is async: every renderer below is a pure
  // string function, and the signature lives in a private bucket. Resolving it onto the rows means
  // none of the twenty-odd renderers has to know a mark exists at all — they receive rows, exactly
  // as they already do.
  //
  // THE BUCKET IS READ ONLY WHEN A SIGNATURE IS ACTUALLY PLACED. Every paper this system prints
  // comes through this line and almost none of them carry one, so an unconditional download would
  // put a storage round trip in front of every document to be told, nearly always, that it was not
  // needed. The seal is a file on disk cached in-process after its first read, so it does not need
  // the same care.
  //
  // ARTWORK THAT CANNOT BE READ IS NOT AN ERROR HERE. A missing signature prints nothing and the
  // paper is signed by hand, which is what happened before this feature existed; refusing to render
  // a whole document because one image was unreadable would be the worse failure. The one case where
  // a missing image MUST stop the job — filing a copy as the document that was signed — is caught
  // downstream by `inlineLocalAssets`, which reports what it could not resolve rather than skipping.
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  //
  // AND ONLY THE MARKS THIS RUN ASKED FOR. A mark nobody ticked resolves to NO artwork, which the
  // renderer prints as nothing at all — the same path as a seal whose file could not be read, and
  // deliberately so: there is exactly one way for a mark to be absent from a page, so there is only
  // one behaviour to get right. `wantedMarks` is empty for every caller that does not pass the
  // parameter, which means every existing link prints the paper exactly as it did before marks
  // existed.
  const wantedMarks = parseMarkSelection(input.marks);
  const fields = withMarkArtwork(stored, {
    stamp: wantedMarks.has("stamp") ? stampArtworkUri() : null,
    signature:
      wantedMarks.has("signature") && layoutUsesMark(stored, "signature")
        ? await loadHrSignatureUri()
        : null,
  });

  const statedCopies = input.statedCopies ? resolveCopies(input.statedCopies, copies) : undefined;
  const html = template
    ? renderCustomTemplateHtml(template, data, copies, fields)
    : RENDERERS[requested as HiringPackDocument].render(
        data,
        copies,
        requestedVersion,
        fields,
        statedCopies,
      );

  return { copies, data, fields, html, ok: true, template, versionId };
}
