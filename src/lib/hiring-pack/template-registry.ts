/**
 * THE ARCHIVE — every version of every paper this module prints, current and superseded.
 *
 * Built 2026-08-30 on the owner's instruction, when he replaced the employment contract: "make the
 * other contract go to archived instead of removing it from system. Make a thing called archived …
 * and any paper I replace, it goes to the archive."
 *
 * So this is deliberately wider than the contract. All five documents are registered from day one,
 * each at the version it is on today, because the mechanism has to exist BEFORE the next form is
 * replaced. A registry that only knows about the one document that has already changed is a
 * registry somebody has to remember to extend, and the whole point of the instruction is that this
 * happens every time, not when someone thinks of it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ARCHIVED IS A DESTINATION, NOT A WAITING ROOM. Nothing is ever removed from this list. A
 * superseded template stays whole and stays printable, for a reason that is easy to miss until it
 * bites: these are papers people SIGN. A contract signed in August against version 1 has to be
 * reproducible as the document that was actually signed — not as today's text with today's clauses.
 * Deleting a version does not tidy the code, it destroys the only record of what somebody agreed
 * to, and it does so silently, because the reprint still produces a plausible-looking contract.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS FILE IS AND IS NOT. It is metadata: which versions exist, which one is current, when
 * each took over and what replaced it. The documents themselves live where they always did — the
 * contract's text in `contract-text-v1.ts` / `contract-text-v2.ts`, the government forms as their
 * own artwork and placement tables. Status lives here and only here, so "which version prints
 * today" has exactly one answer and cannot drift between a template file and a renderer.
 */

import type { HiringPackDocument } from "./types";

/**
 * Whether a version is the one that prints today.
 *
 * Exactly one `current` per document, always — enforced by `currentTemplateVersion`, which throws
 * rather than guessing. Two current versions is not a state anyone can resolve from a screen: it
 * means two different papers both claim to be the contract, and picking either one silently is how
 * the wrong text reaches a signature page.
 */
export type TemplateStatus = "current" | "archived";

export type DocumentTemplateVersion = {
  /**
   * Stable identity, unique across every document.
   *
   * NEVER RENAME OR REUSE ONE. It is written onto the employee row when a document is signed, and a
   * reprint resolves the version through it — so an id that changes meaning reprints somebody's
   * contract as a document they never saw, with no error anywhere.
   */
  id: string;
  document: HiringPackDocument;
  version: number;
  status: TemplateStatus;
  /** What this version is called in the Archived list. */
  labelEn: string;
  labelAr: string;
  /** The day this version became the one Phoenix prints. */
  effectiveFrom: string;
  /** The day it stopped, on an archived version. Null while it is current. */
  supersededOn: string | null;
  /** The id of the version that replaced it. Null while it is current. */
  supersededBy: string | null;
  /** Why it changed, or what it is — shown in the Archive so the record explains itself. */
  note: string;
};

/**
 * Every version, in document order then version order.
 *
 * ADDING A REPLACEMENT is two edits and never a deletion: mark the outgoing row `archived` with its
 * `supersededOn` and `supersededBy` filled in, and append the new row as `current`. The test suite
 * checks both halves — that exactly one version of each document is current, and that no id ever
 * disappears between commits.
 */
export const DOCUMENT_TEMPLATE_VERSIONS: readonly DocumentTemplateVersion[] = [
  {
    id: "contract-v1",
    document: "contract",
    version: 1,
    status: "archived",
    labelEn: "Employment contract — 2026 edition",
    labelAr: "عقد عمل محدد المدة — إصدار 2026",
    effectiveFrom: "2026-08-22",
    supersededOn: "2026-08-30",
    supersededBy: "contract-v2",
    note: "The first contract Phoenix printed. Replaced by the owner's redrafted text on 2026-08-30. Kept printable: contracts signed against it must reproduce as the document that was signed.",
  },
  {
    id: "contract-v2",
    document: "contract",
    version: 2,
    status: "archived",
    labelEn: "Employment contract — redrafted, Labour Law 14/2025",
    labelAr: "عقد عمل محدد المدة — محرر طبقًا لقانون العمل 14 لسنة 2025",
    effectiveFrom: "2026-08-30",
    supersededOn: "2026-09-01",
    supersededBy: "contract-v3",
    note: "Supplied by the owner as a Word document on 2026-08-30. Nineteen titled articles, a banded layout, and a fuller company recital carrying the commercial register, unified register and tax card. Replaced by the owner's next redraft on 2026-09-01. Kept printable: contracts signed against it must reproduce as the document that was signed.",
  },
  {
    id: "contract-v3",
    document: "contract",
    version: 3,
    status: "archived",
    labelEn: "Employment contract — redraft of 2026-09-01, Labour Law 14/2025",
    labelAr: "عقد عمل محدد المدة — محرر طبقًا لقانون العمل 14 لسنة 2025 (تحرير 2026-09-01)",
    effectiveFrom: "2026-09-01",
    supersededOn: "2026-09-04",
    supersededBy: "contract-v4",
    note: "Supplied by the owner as a Word document on 2026-09-01. Thirteen titled articles, consolidated from version 2: term, probation and appointment prerequisites in مادة (3), and pay, the periodic raise and incentives in مادة (4). References a strict subset of version 2's blanks: it no longer states an insurance-wage figure, an underperformance threshold or a training-bond duration. TYPESETTING CORRECTED 2026-09-03 against the owner's own file, which he re-sent because the text had been reproduced faithfully and the document had not: the layout moved from version 2's banded panels to `document` — a white page, the letterhead repeated on every page, headings as blue text over a hair rule, and no highlighting on typed values. The Arabic did not change, and no contract had been signed against this version. Replaced on 2026-09-04 by the owner's revision of the signing apparatus. Kept printable: contracts signed against it must reproduce as the document that was signed — and although no row carried 'contract-v3' when it was archived, that is a fact about one day and not a licence to delete it, because a reprint resolves through this id forever.",
  },
  {
    id: "contract-v4",
    document: "contract",
    version: 4,
    status: "current",
    labelEn: "Employment contract — revision of 2026-09-04, Labour Law 14/2025",
    labelAr: "عقد عمل محدد المدة — محرر طبقًا لقانون العمل 14 لسنة 2025 (تحرير 2026-09-04)",
    effectiveFrom: "2026-09-04",
    supersededOn: null,
    supersededBy: null,
    note: "Supplied by the owner as a Word document on 2026-09-04 ('الطرف الأول.docx'). THE THIRTEEN ARTICLES ARE UNCHANGED from version 3 — byte for byte, along with the title, subtitle, preamble, employee identity grid and running footer. What this revision changes is the signing apparatus: the company recital breaks in three lines instead of two (no registry fact moved); the closing dates the contract by weekday as well as date, reintroducing the DAY_NAME blank that versions 2 and 3 dropped; the signature grid loses its الصفة column so both parties sign under the same three headings, with the signatory's capacity moved to an annotation beneath the company's row; and the employee signs a new separate line acknowledging receipt of his copy. References a strict superset of version 3's blanks — the same set plus DAY_NAME.",
  },
  {
    id: "form1-v1",
    document: "form1",
    version: 1,
    status: "current",
    labelEn: "Social insurance Form 1 — insured person's subscription request",
    labelAr: "استمارة 1 تأمينات — طلب اشتراك مؤمن عليه",
    effectiveFrom: "2026-08-22",
    supersededOn: null,
    supersededBy: null,
    note: "The Authority's own form, reproduced as artwork with values placed on it. Replaced only when the Authority itself issues a new one.",
  },
  {
    id: "worker-form-v1",
    document: "workerDataForm",
    version: 1,
    status: "current",
    labelEn: "Worker data form — service-file intake sheet",
    labelAr: "استمارة بيانات العامل",
    effectiveFrom: "2026-09-01",
    supersededOn: null,
    supersededBy: null,
    note: "Sato's own service-file intake sheet, supplied by the owner on 2026-09-01. Filled on the day of hire and kept in the personnel file — five sections of personal, contact, employment and payroll data, and a worker's declaration. Not a government form, so — like the clearance pair — it is revised here whenever the owner revises the paper, and superseded wording is archived rather than overwritten.",
  },
  {
    id: "custody-laptop-v1",
    document: "custodyLaptop",
    version: 1,
    status: "current",
    labelEn: "Custody receipt — laptop",
    labelAr: "إقرار استلام عهدة — نموذج رقم 1 (حاسب محمول)",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "Sato's own instrument, supplied by the owner on 2026-08-30. Fifteen undertakings in four groups, three signatures and a return protocol. The device details print blank: Phoenix holds no asset register, and a serial number is read off the machine, not recalled.",
  },
  {
    id: "custody-mobile-v1",
    document: "custodyMobile",
    version: 1,
    status: "current",
    labelEn: "Custody receipt — phone or tablet",
    labelAr: "إقرار استلام عهدة — نموذج رقم 2 (هاتف / جهاز لوحي)",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The same instrument as the laptop receipt, with the phone's own item list and an IMEI and SIM block in place of the Windows fields. Both forms are current at once — which one prints depends on the device, not on the year.",
  },
  {
    id: "nda-v1",
    document: "nda",
    version: 1,
    status: "current",
    labelEn: "Confidentiality and IP undertaking",
    labelAr: "إقرار وتعهد بعدم إفشاء المعلومات والأسرار التجارية",
    effectiveFrom: "2026-09-05",
    supersededOn: null,
    supersededBy: null,
    note: "Supplied by the owner on 2026-09-05 and typeset into the house identity the same day. His legal substance throughout. It now names the article it supplements — مادة (7) of the contract, «الواجبات والسرية والملكية الفكرية وعدم المنافسة» — which his draft left implicit by calling itself «جزءاً مكملاً ومتممًا لعقد العمل» without saying to what, and it lists the CRM, pricing and customer data مادة (7) already covers so the two papers describe one obligation rather than two.",
  },
  {
    id: "appointment-docs-receipt-v1",
    document: "appointmentDocsReceipt",
    version: 1,
    status: "current",
    labelEn: "Appointment documents receipt",
    labelAr: "إيصال استلام مسوغات التعيين",
    effectiveFrom: "2026-09-05",
    supersededOn: null,
    supersededBy: null,
    note: "The hiring half of a matched pair with `appointment-docs-return-v1`. Twelve items, unchanged and in the owner's order, RENUMBERED 1..12 — his ran 1..10, 12, 13 with no eleven, and a serial that skips a number on a form somebody signs invites the question of what used to be on that line. Every verdict box prints blank: there is no register of which certificates were handed over, and a ticked box on a signed form asserts a document was seen.",
  },
  {
    id: "social-status-sheet-v1",
    document: "socialStatusSheet",
    version: 1,
    status: "current",
    labelEn: "Social status sheet — service file",
    labelAr: "صحيفة الحالة الاجتماعية",
    effectiveFrom: "2026-09-05",
    supersededOn: null,
    supersededBy: null,
    note: "The service-file sheet Article 92 requires the EMPLOYER to keep. Treated as a house document and not as a government form, deliberately: unlike Form 1 and Form 6 the insurance office issues no artwork for it, so restyling cannot get it refused at a window. Every field the owner's version carries is here in his order; religion, military status and marital status rule because this system holds none of the three, and a sheet the employee signs as true must not carry a value nobody asked him. Tightened to fit ONE sheet — at the shared metrics its signature block spilled onto an otherwise blank second page.",
  },
  {
    id: "absence-warning-first-v1",
    document: "absenceWarning",
    version: 1,
    status: "current",
    labelEn: "First absence warning — art. 166",
    labelAr: "إنذار أول بالتغيب عن العمل",
    effectiveFrom: "2026-09-05",
    supersededOn: null,
    supersededBy: null,
    note: "Issued after FIVE consecutive days, which is what مادة (8) of the contract provides. Two corrections to the owner's draft: it warned that a further five days would make the worker deemed resigned at TEN, where Article 166 and مادة (8) both say MORE THAN ten — so it now warns about exceeding ten rather than reaching it; and the company was a blank («بشركة ........................») on a paper this company issues about its own staff, now filled from settings. The absence dates print blank: attendance is not resolved here, and a wrong date on a notice that leads to loss of service cannot be walked back.",
  },
  {
    id: "absence-deemed-resignation-v1",
    document: "deemedResignation",
    version: 1,
    status: "current",
    labelEn: "Deemed resignation notice — art. 166",
    labelAr: "إخطار باعتبار العامل مستقيلًا حكمًا",
    effectiveFrom: "2026-09-05",
    supersededOn: null,
    supersededBy: null,
    note: "RENAMED from the owner's «إخطار بقبول إستقالة», and the rename is the substance: under Article 166 there is no resignation to accept — the worker wrote none and the employer DECLARES him deemed resigned. A real resignation is Article 167, written and signed by the worker and approved by the labour office, which is what مادة (12) of our contract describes. A paper claiming to accept a resignation nobody submitted invites the argument that no valid resignation exists. It also now acts from the ELEVENTH day rather than the tenth, for the same reason as the first warning.",
  },
  {
    id: "appointment-docs-return-v1",
    document: "appointmentDocsReturn",
    version: 1,
    status: "current",
    labelEn: "Appointment documents returned",
    labelAr: "إقرار استلام مسوغات التعيين — عند انتهاء الخدمة",
    effectiveFrom: "2026-09-05",
    supersededOn: null,
    supersededBy: null,
    note: "The exit half of the pair. It now names the LAST WORKING DAY, which the owner's draft did not: a waiver with no date attached says nothing about when the certificates came back, and fixing that moment is the document's whole value. A sentence was added making clear the waiver covers the PAPERS only and is not a release of any statutory or financial entitlement — his wording was broad enough to be read as one.",
  },
  {
    id: "contract-renewal-v1",
    document: "contractRenewal",
    version: 1,
    status: "current",
    labelEn: "Contract renewal annex — Labour Law 14/2025",
    labelAr: "ملحق تجديد سنوي لعقد عمل محدد المدة — قانون العمل 14 لسنة 2025",
    effectiveFrom: "2026-09-05",
    supersededOn: null,
    supersededBy: null,
    note: "Supplied by the owner as a PDF on 2026-08-19 and typeset into the house identity on 2026-09-05 after he asked whether it was compatible with Labour Law 14/2025 and with our own contract. The legal substance was and is reproduced as he drafted it. The CROSS-REFERENCES were not: his draft cites مادة (1) and مادة (18) بند (4) of the contract, which are correct against contract-v2 — the nineteen-article version current when he wrote it — and wrong against contract-v4, which has thirteen articles and no مادة (18) at all. They were re-resolved by subject to مادة (1) and مادة (13) بند (5), and a test pins every such reference against the current contract so the next redraft turns them red rather than leaving them quietly pointing at the wrong clauses. Three statutory anchors were added: مادة (88) behind 'sign it before the old term expires', مادة (90) behind 'no new probation', and مادة (12)'s 3% periodic increment. The company recital and the signatory now match the contract's own word for word — his draft named a shorter address and dropped the last two words of the signatory's name.",
  },
  {
    id: "contract-non-renewal-v1",
    document: "contractNonRenewal",
    version: 1,
    status: "current",
    labelEn: "Non-renewal notice — Labour Law 14/2025",
    labelAr: "إخطار بعدم تجديد عقد عمل محدد المدة — قانون العمل 14 لسنة 2025",
    effectiveFrom: "2026-09-05",
    supersededOn: null,
    supersededBy: null,
    note: "Page 2 of the same PDF the owner supplied on 2026-08-19, and the alternative to the annex rather than a companion to it: one or the other is issued per expiring term, never both. Its cross-references were the worse half of the version mismatch — it cited مادة (4), (9), (13), (15) and (16), of which مادة (15) DOES exist in contract-v4 as «الاستقالة والإنهاء» rather than the custody article the notice means, so the error would have printed as a plausible reference to the wrong clause. Re-resolved by subject to مادة (3) for the term, مادة (10) and مادة (12) for custody and handover, and مادة (8) with مادة (13) بند (1) for service by registered letter. The sentence saying this is not a dismissal is the load-bearing one on the page and is his own wording, kept.",
  },
  {
    id: "form6-v1",
    document: "form6",
    version: 1,
    status: "current",
    labelEn: "Social insurance Form 6 — notice of end of subscription",
    labelAr: "استمارة 6 تأمينات — إخطار بإنتهاء اشتراك مؤمن عليه",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The Authority's own form, reproduced as artwork with values placed on it. Replaced only when the Authority itself issues a new one.",
  },
  {
    id: "resignation-v1",
    document: "resignation",
    version: 1,
    status: "current",
    labelEn: "Ministry of Labour — resignation request",
    labelAr: "نموذج وزارة العمل — طلب استقالة",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The Ministry's own template under مادة 167 and decree 187/2025. Replaced only when the Ministry itself issues a new one.",
  },
  {
    id: "mutualTermination-v1",
    document: "mutualTermination",
    version: 1,
    status: "current",
    labelEn: "Ministry of Labour — mutual termination agreement",
    labelAr: "نموذج وزارة العمل — اتفاق إنهاء عقد عمل بالتراضي",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The Ministry's own template. The alternative to a resignation, never printed alongside one. Replaced only when the Ministry itself issues a new one.",
  },
  {
    id: "clearance-employee-v1",
    document: "clearanceEmployee",
    version: 1,
    status: "current",
    labelEn: "Clearance — the company certifies the employee is clear",
    labelAr: "إخلاء طرف موظف",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "Sato's own instrument, not a government form — so unlike Form 6 or the labour templates it is revised here whenever the owner revises the paper, and the superseded wording is archived rather than overwritten. Seven departments sign it, HR signs it, the company stamps it, and the employee keeps the original.",
  },
  {
    id: "clearance-company-v1",
    document: "clearanceCompany",
    version: 1,
    status: "current",
    labelEn: "Clearance — the employee releases the company",
    labelAr: "إخلاء طرف شركة",
    effectiveFrom: "2026-08-30",
    supersededOn: null,
    supersededBy: null,
    note: "The other half of the clearance pair, and a release of claims: the employee signs that the settlement figure written on it discharges everything owed for the whole period of employment. A COMPLEMENT of the employee clearance and never an alternative — both are signed, days apart. The company files it.",
  },
];

/** Every version of one document, newest first. */
export function templateVersionsFor(document: HiringPackDocument): DocumentTemplateVersion[] {
  return DOCUMENT_TEMPLATE_VERSIONS.filter((entry) => entry.document === document).sort(
    (a, b) => b.version - a.version,
  );
}

/**
 * The version of a document that prints today.
 *
 * Throws when there is not exactly one, rather than returning the first match. A registry with two
 * current contracts is a mistake nobody can see from a screen — both look right — so it has to stop
 * at the point it is discovered, not at the point somebody signs the wrong one.
 */
export function currentTemplateVersion(document: HiringPackDocument): DocumentTemplateVersion {
  const current = DOCUMENT_TEMPLATE_VERSIONS.filter(
    (entry) => entry.document === document && entry.status === "current",
  );
  if (current.length !== 1) {
    throw new Error(
      `Expected exactly one current template for ${document}, found ${current.length}. ` +
        "Replacing a document means archiving the outgoing version, never leaving two current.",
    );
  }
  return current[0];
}

/** Everything that has been superseded, newest supersession first. This is the Archive list. */
export function archivedTemplateVersions(): DocumentTemplateVersion[] {
  return DOCUMENT_TEMPLATE_VERSIONS.filter((entry) => entry.status === "archived").sort((a, b) =>
    (b.supersededOn ?? "").localeCompare(a.supersededOn ?? ""),
  );
}

/** One version by id, or null. Null means "an id nobody recognises", never "deleted". */
export function findTemplateVersion(id: string): DocumentTemplateVersion | null {
  return DOCUMENT_TEMPLATE_VERSIONS.find((entry) => entry.id === id) ?? null;
}

/**
 * Which version to print for a document, given what a signed record says.
 *
 * `signedVersionId` is what was stored when the paper was signed. A reprint of a signed document
 * reproduces THAT version; everything else gets the current one. An unrecognised id falls back to
 * current rather than throwing, because a stored id from a future branch must not make an
 * employee's file unprintable — but the caller is told, so the screen can say which it used.
 */
export function resolveTemplateVersion(
  document: HiringPackDocument,
  signedVersionId: string | null | undefined,
): { version: DocumentTemplateVersion; reproducedFromSignature: boolean } {
  if (signedVersionId) {
    const stored = findTemplateVersion(signedVersionId);
    if (stored && stored.document === document) {
      return { version: stored, reproducedFromSignature: true };
    }
  }
  return { version: currentTemplateVersion(document), reproducedFromSignature: false };
}
