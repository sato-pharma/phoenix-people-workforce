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
    status: "archived",
    labelEn: "First absence warning — art. 166",
    labelAr: "إنذار أول بالتغيب عن العمل",
    effectiveFrom: "2026-09-05",
    supersededOn: "2026-09-17",
    supersededBy: "absence-warning-first-v2",
    note: "Issued after FIVE consecutive days, which is what مادة (8) of the contract provides. Two corrections to the owner's draft: it warned that a further five days would make the worker deemed resigned at TEN, where Article 166 and مادة (8) both say MORE THAN ten — so it now warns about exceeding ten rather than reaching it; and the company was a blank («بشركة ........................») on a paper this company issues about its own staff, now filled from settings. The absence dates print blank: attendance is not resolved here, and a wrong date on a notice that leads to loss of service cannot be walked back. Replaced on 2026-09-17: it recited absence from the head office, which is not where a field employee works. Kept printable: a warning served against it must reproduce as the paper that was served.",
  },
  {
    id: "absence-warning-first-v2",
    document: "absenceWarning",
    version: 2,
    status: "current",
    labelEn: "First absence warning — art. 166, stop in work",
    labelAr: "إنذار أول بالانقطاع عن العمل",
    effectiveFrom: "2026-09-17",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's correction of 2026-09-17, raised on a medical rep who stopped working and would not come to the office to write a resignation. Version 1 recited absence from the Cairo head office, which is not where a field employee works, so the warning rested on the wrong fact. It now recites a stop in carrying out the job, with nothing recorded through the approved means under مادة (8), in wording that fits office and field staff alike; the head-office address stays only in the company recital. A paragraph prints for everyone saying the relationship stands because no resignation meeting Article 167 (written, signed, approved by the labour office) has been received, and a spoken or messaged wish to leave is not one. The service note makes the registered letter Article 166 requires mandatory, with email or other means only in addition. The five-day count stays in WORK days and the consequence stays stated in full.",
  },
  {
    id: "absence-deemed-resignation-v1",
    document: "deemedResignation",
    version: 1,
    status: "archived",
    labelEn: "Deemed resignation notice — art. 166",
    labelAr: "إخطار باعتبار العامل مستقيلًا حكمًا",
    effectiveFrom: "2026-09-05",
    supersededOn: "2026-09-17",
    supersededBy: "absence-deemed-resignation-v2",
    note: "RENAMED from the owner's «إخطار بقبول إستقالة», and the rename is the substance: under Article 166 there is no resignation to accept — the worker wrote none and the employer DECLARES him deemed resigned. A real resignation is Article 167, written and signed by the worker and approved by the labour office, which is what مادة (12) of our contract describes. A paper claiming to accept a resignation nobody submitted invites the argument that no valid resignation exists. It also now acts from the ELEVENTH day rather than the tenth, for the same reason as the first warning. Replaced on 2026-09-17 together with the first warning: it recited the same head-office absence. Kept printable: a notice served against it must reproduce as the paper that was served.",
  },
  {
    id: "absence-deemed-resignation-v2",
    document: "deemedResignation",
    version: 2,
    status: "current",
    labelEn: "Deemed resignation notice — art. 166, stop in work",
    labelAr: "إخطار باعتبار العامل مستقيلًا حكمًا",
    effectiveFrom: "2026-09-17",
    supersededOn: null,
    supersededBy: null,
    note: "Replaced together with the first warning on 2026-09-17, because version 1 recited the same head-office absence and fixing only the warning would have put the defect back on the paper that ends the service. It recites the same stop in work the warning does, and states that the earlier warning went by registered letter — the condition Article 166 sets before anyone can be deemed resigned. The operative text, the more-than-ten-days threshold and the statement that this is not a disciplinary dismissal are unchanged.",
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
    id: "experience-certificate-v1",
    document: "experienceCertificate",
    version: 1,
    status: "current",
    labelEn: "Certificate of experience",
    labelAr: "شهادة خبرة",
    effectiveFrom: "2026-09-06",
    supersededOn: null,
    supersededBy: null,
    note: "The first paper in this module drawn from scratch rather than typeset from a Word file the owner supplied, and the only one written for a reader OUTSIDE the company — a future employer, an embassy, a bank. Three things it deliberately does not say, each an omission rather than an unfinished half: NO SALARY, because a certificate of experience is not a salary certificate and printing pay here would disclose it to every reader of every copy; NO REASON FOR LEAVING, which is recorded on the resignation or mutual-termination form where a reader entitled to it looks; and NO STATEMENT OF CONDUCT, because «حسن السير والسلوك» is a testimonial and this paper prints from a button for anybody in the system, including somebody dismissed for cause. It states service two ways — ended, or still serving — resolved from the employee's own departure flag rather than from whether a last-working date happens to be on file, since an absent date means nobody recorded one and not that he is still here. The subtitle carries no article number: nothing on the page rests on a specific article, and a citation invented to match the house pattern is how a wrong one reaches a document a lawyer reads. On 2026-10-28 the owner chose the certificate's own design for it and its English twin (`experience-certificate-design.ts`): the same words, now set under a two-weight title with the issuing company beside it, the holder's details as a ruled list, the period in figures, and three BLANK signing boxes — no name, signature or seal is printed, so none leaves without HR signing it by hand. It replaces the contract layout he had ticked \"keep\" on 2026-10-13.",
  },
  {
    id: "experience-certificate-en-v1",
    document: "experienceCertificateEn",
    version: 1,
    status: "current",
    labelEn: "Certificate of experience — English",
    labelAr: "شهادة خبرة — باللغة الإنجليزية",
    effectiveFrom: "2026-09-06",
    supersededOn: null,
    supersededBy: null,
    note: "The English counterpart of `experience-certificate-v1`, for a reader outside Egypt — an embassy, a Gulf employer, a bank. BOTH ARE CURRENT AT ONCE and HR prints whichever is asked for; they are two documents rather than two versions of one for the reason the custody pair are, since the archive’s rule is exactly one current version per document and filing the English one as a version of the Arabic would tell HR the Arabic had been withdrawn. It states the same three omissions and the same period, and the period is resolved in `service-period.ts` which BOTH read — the two are routinely printed minutes apart for one person, and a pair that disagrees about how long he worked here is worse than either being wrong alone. Two differences from the Arabic paper, both deliberate: it names the position and NOT the department, because the pack holds the department only in Arabic and an Arabic department name inside an English sentence read at a visa window is worse than none; and it is written as prose rather than around a bordered identity grid, because the owner asked for a PDF that stays editable when imported into Canva and every cell border in such a grid arrives there as its own vector rectangle. Its date format spells the month out — `08 / 09 / 2026` is two different days either side of the Atlantic, and this is the copy read by a stranger. Since 2026-10-28 it wears the certificate's own design with the Arabic paper (`experience-certificate-design.ts`) — a three-row reference list beside the title, the holder's name set large, the period in figures and three BLANK signing boxes, all drawn with rules and still with no table.",
  },
  {
    id: "salary-letter-en-v1",
    document: "salaryLetterEn",
    version: 1,
    status: "current",
    labelEn: "HR letter — basic salary (English)",
    labelAr: "شهادة راتب — باللغة الإنجليزية",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The salary letter an employee takes to a bank, an embassy or a landlord. It states the BASIC monthly salary and nothing else about pay — the owner, 2026-09-13: \"salary we put basic not net\". The figure is the payroll policy's own `calculateBasicSalary` off the base salary on record, imported rather than restated, so the letter cannot quote a basic salary payroll does not pay; it prints in figures and in words, and one sentence says it excludes allowances, incentives and variable pay. A missing base salary prints a rule for a pen, never EGP 0.00. A leaver's letter states the period of service and the LAST basic salary, never that he is employed. It borrows the English certificate of experience's shape — prose, one page, real text for a Canva import — and its honorific and service-period rules.",
  },
  {
    id: "salary-letter-ar-v1",
    document: "salaryLetterAr",
    version: 1,
    status: "current",
    labelEn: "HR letter — base salary (Arabic)",
    labelAr: "شهادة راتب — باللغة العربية",
    effectiveFrom: "2026-09-20",
    supersededOn: null,
    supersededBy: null,
    note: "The Arabic counterpart of `salary-letter-en-v1`, drawn through the shared `render-hr-paper.ts` pipeline the Arabic certificate of experience already uses rather than a bespoke renderer, because it is an `HrPaperTemplate` and the certificate's is too. Since 2026-09-20 (owner: «put the base, not the basic») it states the employee's BASE monthly salary — the figure on record, not the basic derived from it, and a different figure from the English letter's on purpose — in figures and in words (`spellEgyptianAmount`), worded «ويتقاضى أجرًا شهريًا مقداره»; the disclaimer sentence about allowances is gone. It ends with a copies sentence written from the number chosen at print time. A missing base salary prints a dotted rule, never a spelled zero. Not a `certificate`: it carries its own `HrPaperKind` so the certificate's print-banner warning about blank dates and its archived-version pool never reach a letter about pay. It wears the Arabic certificate's own layout — masthead, purpose band, company block, employee grid, one-column signature table, with NO seal (owner 2026-09-20 — and since 2026-09-29 no hiring paper carries one) — sized to fill one A4 page.",
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
  // ── THE LETTERS PACK, 2026-09-13 ────────────────────────────────────────────────────────────
  // Owner: "Move them onto the Sato Pharma template, but governmental leave as is." Nine company
  // papers rebuilt on the house identity with their wording kept, and eight government forms whose
  // artwork is the owner's own file, unchanged.
  {
    id: "disciplinary-warning-v1",
    document: "disciplinaryWarning",
    version: 1,
    status: "current",
    labelEn: "Disciplinary warning",
    labelAr: "إنذار",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's own إنذار, moved onto the house template with its wording kept. The act, the article of the penalty regulations and its text print as ruled blanks: Phoenix holds no disciplinary register, and a warning naming the wrong article is the one error on it that cannot be walked back. The employee signs that he was told.",
  },
  {
    id: "disciplinary-penalty-v1",
    document: "disciplinaryPenalty",
    version: 1,
    status: "current",
    labelEn: "Administrative penalty",
    labelAr: "جزاء إداري",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's own جزاء, on the house template with its wording kept. The penalty type, the number of days and the article print as ruled blanks for the same reason as the warning. Signed by the direct manager as the original was; HR's column carries the seal.",
  },
  {
    id: "transfer-decision-v1",
    document: "transferDecision",
    version: 1,
    status: "current",
    labelEn: "Transfer decision",
    labelAr: "قرار نقل",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's own قرار نقل on the house template. The current post is filled from the record; the new department, post, manager and start date are ruled, because Phoenix learns of a transfer from this paper rather than before it. The company name in the decision sentence comes from settings instead of a blank.",
  },
  {
    id: "salary-adjustment-memo-v1",
    document: "salaryAdjustment",
    version: 1,
    status: "current",
    labelEn: "Salary adjustment memo",
    labelAr: "مذكرة تعديل راتب",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's own مذكرة تعديل راتب on the house template, wording kept. It lists several people: the one whose pack is open is the first row, and the rest are written in. NO FIGURE PRINTS — neither the old salary nor the new one — because the memo instructs payroll and the amount is decided in the payroll run, not typed onto a sheet.",
  },
  {
    id: "social-insurance-authorization-v1",
    document: "socialInsuranceAuthorization",
    version: 1,
    status: "current",
    labelEn: "Authorisation letter — social insurance office",
    labelAr: "تفويض التأمين الاجتماعي",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's own تفويض on the house template, wording and the list of what the delegate may do kept exactly. The delegate's name, national ID and insurance number are filled from the record. The office's name is ruled: the company deals with more than one.",
  },
  {
    id: "health-insurance-authorization-v1",
    document: "healthInsuranceAuthorization",
    version: 1,
    status: "current",
    labelEn: "Authorisation letter — health insurance",
    labelAr: "تفويض التأمين الصحي",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's own تفويض to the Health Insurance Organisation on the house template, wording kept, with the delegate's name and national ID filled from the record.",
  },
  {
    id: "insurance-print-request-v1",
    document: "insurancePrintLetter",
    version: 1,
    status: "current",
    labelEn: "Insurance record print request",
    labelAr: "خطاب استخراج برينت تأميني",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's own خطاب برينت on the house template, wording kept. The employee's name, the company and his insurance number are filled; a missing insurance number prints a rule, never a guess.",
  },
  {
    id: "handover-record-v1",
    document: "handoverRecord",
    version: 1,
    status: "current",
    labelEn: "Internal handover record",
    labelAr: "محضر إداري داخلي — تسليم وتسلم المهام الوظيفية",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's own محضر on the house template, wording kept. The head office is printed as the owner confirmed it on 2026-09-13 — «8 ن مربع 1258 ز – شيراتون - القاهرة» — literally, not from settings, because that is the address this record was written against. The attendees, the receivers and the tasks are ruled for the meeting; the leaver's name, post and national ID are filled. One original, as the record itself says.",
  },
  {
    id: "exit-interview-v1",
    document: "exitInterview",
    version: 1,
    status: "current",
    labelEn: "Exit interview",
    labelAr: "مقابلة نهاية الخدمة",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The owner's bilingual Employee Exit Interview on the house template: every question in both languages, each English line pinned left-to-right on its own line. Seventeen rated questions with five empty boxes each, and six written ones. Nothing is pre-marked. An HR column was added beside the employee's, so the filed copy shows who took the interview.",
  },
  {
    id: "maternity-compensation-v1",
    document: "maternityCompensation",
    version: 1,
    status: "current",
    labelEn: "Maternity leave compensation request",
    labelAr: "طلب تعويض عن إجازة الوضع",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The insurance form as the owner supplied it, printed exactly as issued. No compiled placements; values are placed in the Template Studio. Replaced only when the Authority issues a new one.",
  },
  {
    id: "insurance-form2-v1",
    document: "insuranceForm2",
    version: 1,
    status: "current",
    labelEn: "Social insurance Form 2",
    labelAr: "استمارة 2 تأمينات",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The Authority's Form 2, landscape A4, printed exactly as issued. The owner's workbook repeats one sheet on every page, so one side is the form. Replaced only when the Authority issues a new one.",
  },
  {
    id: "car-insurance-certificate-v1",
    document: "carInsuranceCertificate",
    version: 1,
    status: "current",
    labelEn: "Car insurance certificate — registration request",
    labelAr: "شهادة تأمين سيارة — طلب تسجيل",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "Two pages, printed as issued. The artwork is a PHOTOGRAPH of a copy, and the print banner says so, until the owner's clean original replaces it.",
  },
  {
    id: "wage-progress-sheet-v1",
    document: "wageProgressSheet",
    version: 1,
    status: "current",
    labelEn: "Labour Office — wage progression sheet",
    labelAr: "صحيفة تدرج الأجور",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The Labour Office register as the owner supplied it, printed exactly as issued.",
  },
  {
    id: "official-holidays-sheet-v1",
    document: "officialHolidaysSheet",
    version: 1,
    status: "current",
    labelEn: "Labour Office — official holidays sheet",
    labelAr: "صحيفة الإجازات الرسمية",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The Labour Office register as the owner supplied it, printed exactly as issued.",
  },
  {
    id: "sick-leave-sheet-v1",
    document: "sickLeaveSheet",
    version: 1,
    status: "current",
    labelEn: "Labour Office — sick leave sheet",
    labelAr: "صحيفة الإجازات المرضية",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The Labour Office register as the owner supplied it, printed exactly as issued — its own citations and percentages included, which the owner decided on 2026-09-13 stay as written.",
  },
  {
    id: "penalties-sheet-v1",
    document: "penaltiesSheet",
    version: 1,
    status: "current",
    labelEn: "Labour Office — penalties sheet",
    labelAr: "صحيفة الجزاءات",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "The Labour Office register as the owner supplied it, printed exactly as issued.",
  },
  {
    id: "penalty-regulations-approval-v1",
    document: "penaltyRegulationsApproval",
    version: 1,
    status: "current",
    labelEn: "Labour Office — penalty regulations approval request",
    labelAr: "طلب اعتماد لوائح الجزاءات ونظام العمل الأساسي للمنشآت",
    effectiveFrom: "2026-09-13",
    supersededOn: null,
    supersededBy: null,
    note: "Two pages, printed as issued. The artwork is the owner's two PHOTOGRAPHS placed on A4, and the print banner says so, until clean originals replace them.",
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
