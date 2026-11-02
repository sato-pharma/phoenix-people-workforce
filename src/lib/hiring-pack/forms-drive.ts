// THE HR FORMS DRIVE — every paper this module prints, filed in folders the way HR thinks of them.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY A DRIVE. The owner, 2026-09-13: "i want it to look like a drive with folders every folder
// contain documents i press on whatever document i need". The fill screen grew one card at a time
// until a paper was found by scrolling a 4,000px page. A folder is how the same papers are already
// kept in the cabinet, so the screen now opens the same way.
//
// THE FOLDERS ARE THE PACKAGES, SPLIT FINER. `documentGroup` still answers joining / leaving /
// other, and nothing here overrides it. "Other" is simply too wide to be one folder: a laptop
// receipt, a renewal annex and an absence warning have nothing in common but not being a joining or
// leaving paper. So "other" is broken into the three kinds it actually holds, from the same lists in
// types.ts the registry reads, and an uploaded company template filed under "other" gets a folder
// of its own.
//
// WHO THE EMPLOYEE LIST OFFERS — THE BUG THIS FILE FIXES. "if i choose a document related to
// resignations the drop list of employees who resigned appear bec now this is a bug". The picker
// listed all 2,000 people for every paper, so a Form 6 was one mis-click from being printed for
// somebody still at his desk. A leaving paper now lists leavers only. The two certificates of
// experience are the deliberate exception: they are issued on request to current staff too — for a
// visa or a bank — and the certificate itself says which of the two it is.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

import {
  documentGroup,
  documentLabel,
  type CustomDocumentGroups,
  type CustomDocumentNames,
  type PrintableDocument,
} from "@/lib/hiring-pack/document-registry";
import {
  ASSET_DOCUMENTS,
  EXIT_DOCUMENTS,
  HIRING_DOCUMENTS,
  HOUSE_ATTENDANCE_DOCUMENTS,
  HOUSE_DECISION_DOCUMENTS,
  HOUSE_INSURANCE_DOCUMENTS,
  HOUSE_JOINING_DOCUMENTS,
  HOUSE_LEAVING_DOCUMENTS,
  HOUSE_LETTER_DOCUMENTS,
  LABOUR_OFFICE_DOCUMENTS,
  OFFICIAL_INSURANCE_FORM_DOCUMENTS,
  OFFICIAL_PACK_FORM_DOCUMENTS,
  ONBOARDING_FORM_DOCUMENTS,
  RENEWAL_DOCUMENTS,
  isBuiltInDocument,
  isCustomDocument,
  type HiringPackCandidate,
  type HiringPackDocument,
} from "@/lib/hiring-pack/types";

export type FormsDriveFolderId =
  | "joining"
  | "attendance"
  | "decisions"
  | "devices"
  | "renewal"
  | "letters"
  | "insurance"
  | "labourOffice"
  | "leaving"
  | "company";

/** Who the employee list offers for a paper. */
export type DocumentAudience = "everyone" | "departed";

export type FormsDriveEntry = {
  document: PrintableDocument;
  label: string;
  /** Null for one of the built-in papers; the template row's id for an uploaded one. */
  versionId: string | null;
  audience: DocumentAudience;
  /** Whether the reference number is printed on the paper, or kept in the register only. */
  numberOnFace: boolean;
};

export type FormsDriveFolder = {
  id: FormsDriveFolderId;
  labelEn: string;
  labelAr: string;
  description: string;
  entries: FormsDriveEntry[];
};

/** The folders, in the order a working life passes through them. */
const FOLDER_DEFINITIONS: ReadonlyArray<{
  id: FormsDriveFolderId;
  labelEn: string;
  labelAr: string;
  description: string;
  documents: readonly HiringPackDocument[];
}> = [
  {
    id: "joining",
    labelEn: "Joining",
    labelAr: "التعيين",
    description: "Contract, Form 1 and the papers signed on the first day.",
    documents: [...HIRING_DOCUMENTS, ...ONBOARDING_FORM_DOCUMENTS, ...HOUSE_JOINING_DOCUMENTS],
  },
  {
    id: "attendance",
    labelEn: "Attendance",
    labelAr: "الانضباط",
    description: "Absence warnings and the deemed-resignation notice.",
    documents: [...HOUSE_ATTENDANCE_DOCUMENTS],
  },
  {
    id: "decisions",
    labelEn: "Decisions",
    labelAr: "قرارات",
    description: "Warnings, penalties, transfers and the salary adjustment memo.",
    documents: [...HOUSE_DECISION_DOCUMENTS],
  },
  {
    id: "devices",
    labelEn: "Devices",
    labelAr: "العهد",
    description: "Custody receipts for a laptop, a phone or a tablet.",
    documents: [...ASSET_DOCUMENTS],
  },
  {
    id: "renewal",
    labelEn: "Renewal",
    labelAr: "تجديد العقد",
    description: "The renewal annex and the non-renewal notice.",
    documents: [...RENEWAL_DOCUMENTS],
  },
  {
    id: "letters",
    labelEn: "Letters",
    labelAr: "خطابات",
    description: "HR letters an employee asks for — the salary letter for a bank or an embassy.",
    documents: [...HOUSE_LETTER_DOCUMENTS],
  },
  {
    id: "insurance",
    labelEn: "Social insurance",
    labelAr: "التأمينات الاجتماعية",
    description: "Letters to the insurance offices, and the Authority's own forms printed as issued.",
    documents: [...HOUSE_INSURANCE_DOCUMENTS, ...OFFICIAL_INSURANCE_FORM_DOCUMENTS],
  },
  {
    id: "labourOffice",
    labelEn: "Labour Office",
    labelAr: "صحائف مكتب العمل",
    description: "The Labour Office registers and the penalty-regulations approval request, as issued.",
    documents: [...LABOUR_OFFICE_DOCUMENTS],
  },
  {
    id: "leaving",
    labelEn: "Leaving",
    labelAr: "انتهاء الخدمة",
    description:
      "Resignation, Form 6, clearance, the handover record, the exit interview and the certificates of experience.",
    documents: [...EXIT_DOCUMENTS, ...HOUSE_LEAVING_DOCUMENTS],
  },
  {
    id: "company",
    labelEn: "Company templates",
    labelAr: "نماذج الشركة",
    description: "Papers uploaded through the Template Studio that belong to no package.",
    documents: [],
  },
];

/**
 * The papers issued on request to anybody, even though they sit in the Leaving folder.
 *
 * A LIST OF THE EXCEPTIONS, and a short one on purpose: every other leaving paper — a new one
 * included — lists leavers only until somebody decides otherwise. Failing towards the narrower list
 * costs a moment's confusion; failing towards the wider one prints a resignation for a current
 * employee.
 */
const LEAVING_PAPERS_FOR_EVERYONE: ReadonlySet<string> = new Set([
  "experienceCertificate",
  "experienceCertificateEn",
]);

/**
 * The papers that are the Authority's or the Ministry's own form, printed exactly as issued.
 *
 * A reference number is still issued and kept in the register for these — "every paper numbered" —
 * but NOTHING is printed on the face. Form 1 is refused at the insurance window if anything Phoenix
 * wrote appears on it (the owner's standing rule), and the same holds for Form 6 and the two Ministry
 * of Labour exit templates.
 */
const OFFICIAL_FORMS: ReadonlySet<string> = new Set([
  "form1",
  "form6",
  "resignation",
  "mutualTermination",
  // The letters pack's government forms — owner, 2026-09-13: "governmental leave as is".
  ...OFFICIAL_PACK_FORM_DOCUMENTS,
]);

/** Whether the reference number prints on the paper itself. */
export function paperReferencePrintsOnFace(document: PrintableDocument): boolean {
  return !OFFICIAL_FORMS.has(document);
}

/** Who the employee list offers for this paper. */
export function documentAudience(
  document: PrintableDocument,
  groups?: CustomDocumentGroups,
): DocumentAudience {
  if (documentGroup(document, groups) !== "leaving") return "everyone";
  return LEAVING_PAPERS_FOR_EVERYONE.has(document) ? "everyone" : "departed";
}

/**
 * The employees to offer for this paper.
 *
 * `keepHrId` is the person already chosen, kept in the list even when the paper would not offer
 * him — otherwise the box empties itself the moment the paper changes, and the screen reads as
 * though nobody had been chosen while his pack is still loaded underneath.
 */
export function candidatesForDocument(
  candidates: readonly HiringPackCandidate[],
  document: PrintableDocument,
  groups?: CustomDocumentGroups,
  keepHrId?: string | null,
): HiringPackCandidate[] {
  if (documentAudience(document, groups) === "everyone") return [...candidates];
  return candidates.filter(
    (candidate) => candidate.departed || (keepHrId ? candidate.hrId === keepHrId : false),
  );
}

/**
 * How one person reads in an employee list — the same line on the drive and on the sticky picker.
 *
 * A leaver carries the date they left, because that is what identifies them: two people can share a
 * job title, and the one whose Form 6 is due is the one who left last week.
 */
export function candidateOptionLabel(candidate: HiringPackCandidate): string {
  const parts = [candidate.hrId, candidate.fullName];
  if (candidate.nameAr) parts.push(candidate.nameAr);
  if (candidate.jobTitle) parts.push(candidate.jobTitle);
  if (candidate.departed && candidate.lastWorkingDate) parts.push(`left ${candidate.lastWorkingDate}`);
  return parts.join(" · ");
}

/** An uploaded template, as much of it as the drive reads. */
export type DriveTemplate = {
  id: string;
  document: string;
  name: string;
  group: string;
  status: string;
};

/**
 * The drive: every folder, with its papers in it.
 *
 * CURRENT TEMPLATES ONLY — an archived row is a superseded edition, readable through the Archive,
 * and listing it here would put two editions of one paper side by side with nothing saying which is
 * in force. The same rule the package tabs follow.
 *
 * `paperScope` — the papers a viewer is limited to (SEAT_PRINTABLE_DOCUMENTS, no seat today), or
 * null for every paper. With a scope the drive holds only those
 * built-in papers, no company template, and no folder left empty by the filter.
 */
export function buildFormsDrive(
  templates: readonly DriveTemplate[] = [],
  paperScope: readonly string[] | null = null,
): FormsDriveFolder[] {
  if (paperScope) {
    return buildFormsDrive([])
      .map((folder) => ({
        ...folder,
        entries: folder.entries.filter((entry) => paperScope.includes(entry.document)),
      }))
      .filter((folder) => folder.entries.length > 0);
  }
  const names: Record<string, string> = {};
  const groups: Record<string, string> = {};
  for (const template of templates) {
    names[template.document] = template.name;
    groups[template.document] = template.group;
  }
  const customNames: CustomDocumentNames = names;
  const customGroups: CustomDocumentGroups = groups;

  const folders: FormsDriveFolder[] = FOLDER_DEFINITIONS.map((definition) => ({
    id: definition.id,
    labelEn: definition.labelEn,
    labelAr: definition.labelAr,
    description: definition.description,
    entries: definition.documents.map((document) => ({
      document,
      label: documentLabel(document),
      versionId: null,
      audience: documentAudience(document),
      numberOnFace: paperReferencePrintsOnFace(document),
    })),
  }));

  for (const template of templates) {
    if (template.status !== "current") continue;
    if (!isCustomDocument(template.document) || isBuiltInDocument(template.document)) continue;
    const document = template.document as PrintableDocument;
    const group = documentGroup(document, customGroups);
    const folderId: FormsDriveFolderId =
      group === "joining" ? "joining" : group === "leaving" ? "leaving" : "company";
    const folder = folders.find((candidate) => candidate.id === folderId);
    folder?.entries.push({
      document,
      label: documentLabel(document, customNames),
      versionId: template.id,
      audience: documentAudience(document, customGroups),
      numberOnFace: paperReferencePrintsOnFace(document),
    });
  }

  return folders;
}

/** Which folder a paper is filed in, or null when the drive does not hold it. */
export function folderOfDocument(
  folders: readonly FormsDriveFolder[],
  document: PrintableDocument,
): FormsDriveFolder | null {
  return folders.find((folder) => folder.entries.some((entry) => entry.document === document)) ?? null;
}
