/**
 * The employing company's registered English name.
 *
 * Declared here rather than inside `systemLegalEntity` below because the document metadata in
 * `systemDocuments` needs it too, and a `const` is not hoisted — reading it from further down the
 * file would be a temporal-dead-zone error at module load. One name, two readers, no second copy.
 */
const COMPANY_LEGAL_NAME_EN = "Sato Pharma";

export const systemIdentity = {
  appName: "Phoenix Workforce",
  brandName: "Phoenix",
  productName: "Workforce",
  description: "A premium workforce intelligence foundation for Phoenix.",
  logoAlt: "Phoenix Workforce logo",
  hrSignatureName: "Phoenix HR Team",
} as const;

export const systemAssets = {
  iconLogo: "/brand/phoenix-bird-icon.png",
  loginEmblem: "/brand/phoenix-login-emblem.png",
  adminSidebarBadge: "/brand/phoenix-admin-intelligence-badge.png",
  // Full admin sidebar lockup (phoenix emblem + wordmark on black). Renders as the
  // expanded admin sidebar header in place of the icon + "PHOENIX / Workforce · Admin"
  // text. Native size 640×288 (~2.22:1) — optimized via `pnpm run optimize:brand-assets`.
  adminSidebarLockup: "/brand/phoenix-sidebar-lockup.png",
  // Square phoenix mark on black — used for the COLLAPSED admin sidebar rail (no
  // white background box). Native size 128×128 — optimized via `pnpm run optimize:brand-assets`.
  adminRailMark: "/brand/phoenix-rail-mark.png",
} as const;

export const systemDeployment = {
  productionBranch: "main",
  workingBranch: "codex/work-from-production",
  productionUrl: "https://phoenix-hr.satopharma.com",
} as const;

export const systemEditingPolicy = {
  // No `fastCheckScript` and no `hardeningScript`: `check:harden` was retired on 2026-08-18 and
  // `check:edit` on 2026-09-25 — this repo has outgrown a local `tsc`, which now needs 4.0-4.5 GB of
  // heap and dies at node's own default on a 16 GB machine. CI is the gate. `pnpm run ci` runs the
  // same steps by hand, but it is opt-in and deliberately not named here.
  localEditingModeEnv: "NEXT_PUBLIC_PHOENIX_EDITING_MODE",
  protectedAreas: [
    "authentication",
    "permissions",
    "RLS",
    "payroll",
    "employee lifecycle",
    "production deployment",
  ],
} as const;

export const systemEmail = {
  defaultFromEmail: "phoenix@send.satopharma.com",
  /**
   * Where replies to system mail land, and the visible To of every fan-out send (everyone real is
   * on BCC). Owner 2026-09-13: care.phx@satopharma.com. The previous inbox, phoenix@ on the apex
   * domain, sits on Resend's suppression list after a hard bounce, so every reply bounced and every
   * fan-out To was dropped as suppressed. Production sets no NOTIFICATION_REPLY_TO, so this value is
   * what ships. Never point it at an address Resend has suppressed.
   */
  defaultReplyTo: "care.phx@satopharma.com",
  /**
   * The From address of every mail the Sato Email Composer sends, whoever is sending it.
   *
   * Owner 2026-09-12: composer mail goes out as the HR Business Partner's mailbox. It was first set
   * to the apex `hrbp@satopharma.com` — Resend reported it "verified" and every send came back
   * `sent`/`delivered` — but `email_delivery_events` showed a 0% open rate across all 36 sends over
   * the following week (2026-09-12 → 2026-09-19), while every `send.satopharma.com` identity in the
   * same system, to the same Yahoo/Turbify-hosted recipients, opened normally. The apex domain is
   * where the recipients' own mailboxes live (`satopharma.com` MX → Yahoo Business Mail); mail
   * claiming that exact identity but arriving via a different relay (Resend/Amazon SES) matches the
   * shape of a spoofed sender, and Yahoo's anti-phishing filtering silently files it as spam/bulk —
   * SPF/DKIM/DMARC passing does not prevent this. Moved onto the dedicated `send.` subdomain, which
   * carries no live mailbox of its own and has the proven delivery record. The display name stays
   * "Sato Pharma" (see satoEmailFrom) and Reply-To stays the owner's, so nothing a recipient reads
   * changes except the domain after the @.
   */
  satoComposerFromEmail: "hrbp@send.satopharma.com",
  /**
   * The visible To of a multi-recipient composer fan-out (`fanoutVisibleTo` in sendSatoEmail) —
   * real recipients ride in Bcc, and this is the neutral address every one of them reads in the To
   * line instead.
   *
   * 🔴 DELIBERATELY NOT `satoComposerFromEmail`. This address is a genuine SMTP envelope recipient —
   * Resend actually attempts delivery to it, unlike a Bcc'd name a client only renders — so it must
   * be a real, accepting mailbox. `send.satopharma.com` carries none (its only MX is Amazon SES's
   * bounce-feedback address, `feedback-smtp.eu-west-1.amazonses.com`, built to reject or process
   * bounces, not hold real mail), so pointing this at it would hard-bounce ONE recipient on every
   * multi-recipient batch and erode the very subdomain's reputation the From-address fix above
   * depends on. `hrbp@satopharma.com` (the apex mailbox) has no such problem: it is a live inbox —
   * confirmed 2026-09-19 by reading it directly, where a composer send landed as a real message
   * (some copies Inbox, one Bulk/Junk, never bounced). A From/To domain mismatch on one message
   * carries no authentication penalty — DMARC keys off the From header, not the To.
   */
  satoComposerFanoutVisibleTo: "hrbp@satopharma.com",
  /**
   * Where a reply to composer mail lands — the owner's own mailbox, for every sender.
   *
   * Owner 2026-09-17: "i want reply to reach omar.anwar@satopharma.com". Reply-To, not From: the
   * mail still goes out as the HR Business Partner's mailbox above, and the fan-out's visible To
   * stays the apex hrbp@ box above (`fanoutVisibleTo` in sendSatoEmail), so nothing a recipient
   * reads changes — only where their Reply button points.
   *
   * 🔴 This address must never be one Resend has suppressed: a suppressed Reply-To is what broke
   * the 2026-09-13 send. omar.anwar@satopharma.com took a standing BCC of every system mail until
   * 2026-11-06 without bouncing, so it is a live, deliverable inbox — do not swap it for an untested one.
   */
  satoComposerReplyToEmail: "omar.anwar@satopharma.com",
  /**
   * The From address of every letter the CEO Email Composer sends.
   *
   * 🔴 ON THE `send.` SUBDOMAIN, AND IT MUST STAY THERE — for the measured reason written out above
   * `satoComposerFromEmail`. An apex `@satopharma.com` From is where the recipients' own mailboxes
   * live (MX → Yahoo Business Mail), so a message claiming that identity while arriving via Resend
   * matches the shape of a spoofed sender and is filed as bulk: 0% opens across 36 sends, with SPF,
   * DKIM and DMARC all passing. `send.satopharma.com` carries no mailbox of its own by design and
   * has the proven delivery record. The DISPLAY name is what a recipient reads in their inbox list,
   * and `ceoEmailFrom` puts the chief executive's name and office there.
   */
  ceoComposerFromEmail: "ceo@send.satopharma.com",
  /**
   * The visible To of a multi-recipient CEO fan-out — real recipients ride in Bcc, and this is the
   * address every one of them reads in the To line instead.
   *
   * 🔴 IT MUST BE A REAL, ACCEPTING MAILBOX, because Resend actually attempts delivery to it: it is
   * a genuine SMTP envelope recipient, unlike a Bcc'd name a client only renders. So it is NOT
   * `ceoComposerFromEmail` — `send.satopharma.com` has no inbox (its only MX is Amazon SES's
   * bounce-feedback address), and pointing this at it would hard-bounce one recipient on every
   * batch and erode the reputation the From-address rule above depends on.
   *
   * The chief executive's own apex mailbox is used, which also means he receives a copy of his own
   * letter. Verified live against `email_delivery_events` on 2026-10-06 before it was wired here:
   * 632 delivered, 2,119 opens, 1 failure — a healthy, unsuppressed inbox.
   */
  ceoComposerFanoutVisibleTo: "anwar.gaweesh@satopharma.com",
  /**
   * Where a reply to a CEO letter lands — his own mailbox.
   *
   * Deliberately NOT `satoComposerReplyToEmail`. A reply to a letter signed by the chief executive
   * belongs to him; routing it to the HR or admin mailbox would answer his correspondence on his
   * behalf. Same verified inbox as the visible To above.
   */
  ceoComposerReplyToEmail: "anwar.gaweesh@satopharma.com",
  /**
   * Reply-To for mail a particular SEAT sends by hand, keyed on the SENDER's role.
   *
   * Owner 2026-09-11, refined when asked: a mail carries the HR Business Partner's address when
   * SHE is sending — not whenever the HR Team happens to be addressed. The earlier shape keyed on
   * recipients, which meant a Super Admin Bcc'ing HR Team for the record would send a vendor's
   * reply to her instead of to himself, silently and with nothing on screen saying so.
   *
   * 🔴 REPLY-TO, NEVER FROM. `defaultFromEmail` above is a SUBDOMAIN, which is what Resend
   * authenticates (DKIM/SPF). Sending as an apex-domain mailbox like hrbp@satopharma.com is
   * rejected or filed as spam unless satopharma.com is itself verified for sending. Reply-To is
   * what decides where a reply lands, and it carries no deliverability risk.
   *
   * A seat absent from here falls through to NOTIFICATION_REPLY_TO, then `defaultReplyTo`.
   */
  // Empty since the owner retired the HR Business Partner seat on 2026-10-08 — its hrbp@ entry was the only one.
  seatReplyTo: {} as Readonly<Record<string, string>>,
  // Controlled internal inboxes only. NEVER add personal/external addresses here:
  // when testing-delivery is on, ALL mail is redirected to this list, so a personal
  // address would receive real employee/candidate PII.
  // Owner 2026-09-13: the suppressed phoenix@ inbox came off this list; omar.anwar@ stays alone.
  testingRecipientFallback: [
    "omar.anwar@satopharma.com",
  ],
} as const;

/**
 * True when the runtime is the production deployment. Mirrors the env-detection logic
 * used elsewhere for observability: Vercel sets VERCEL_ENV to
 * "production" | "preview" | "development"; Node sets NODE_ENV.
 */
export function isProductionRuntime(): boolean {
  const env = String(process.env.APP_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV || "").toLowerCase();
  return env === "production";
}

/**
 * Whether every outgoing email should be redirected to the testing recipients.
 *
 * Resolution order:
 *  1. An explicit PHOENIX_EMAIL_FORCE_TESTING value always wins (truthy => on, else off).
 *  2. When unset, default to OFF in production and ON everywhere else (dev/preview).
 *
 * This fail-safe default keeps preview/dev from emailing real people while ensuring
 * production does NOT silently trap real mail in the test inboxes when the flag is
 * simply forgotten.
 */
export function isForceTestingDelivery(): boolean {
  const raw = process.env.PHOENIX_EMAIL_FORCE_TESTING;
  if (raw != null && raw.trim() !== "") {
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  }
  return !isProductionRuntime();
}

export const systemDocuments = {
  // A file's Author and Company properties say who ISSUED the document, and that is the company,
  // not the software that rendered it — SATO-DIS-2026-01 v1.0. Every export in the repo reads these.
  workbookCompany: COMPANY_LEGAL_NAME_EN,
  workbookCreator: COMPANY_LEGAL_NAME_EN,
  // The useful half of this note is that WHAT YOU SEE DEPENDS ON YOUR PERMISSIONS. The app naming
  // itself alongside was the other half, and on the employee master it printed directly beside the
  // house standard id — "SATO-DIS-2026-01 v1.0 · Generated from Phoenix Workforce ...", the company's
  // standard introducing the software. The scope sentence survives intact; the introduction does not.
  workbookExportScopeNote: "Generated according to the active user access scope.",
  titles: {
    // NOT ONE OF THESE CARRIES THE APP'S NAME, and that is the whole point of the block.
    //
    // Each is either printed as the headline on the face of a document, or written into the file's
    // own `title` property — which is what Explorer, SharePoint and Excel's own properties pane
    // show. Under SATO-DIS-2026-01 v1.0 the identity a company document wears is the COMPANY's, so
    // a title that begins "Phoenix Workforce - " is the software introducing itself on paper the
    // company issues.
    //
    // `activeEmployeeMasterData` was here too and is gone: it had no reader anywhere in the
    // repository, so it was a title nothing ever printed.
    attendanceDeviceUserMapping: "Attendance Device User Mapping",
    activeEmployeeMasterDataWorkbook: "Active Employee Master Data",
    coachingReportsExport: "Coaching Reports Export",
    cvDatabaseUploadTemplate: "CV Database Upload Template",
    fingerprintAttendanceReport: "Fingerprint Attendance Report",
    probationExport: "Probation Export",
    probationPdfExport: "Probation Export",
    userBulkImportTemplate: "Bulk Import Template",
  },
} as const;

/**
 * The employing company as it must appear on legal paperwork.
 *
 * Read by the hiring pack — the employment contract and social-insurance Form 1 — which are the
 * only two places in Phoenix that speak for the company as a legal person rather than as a brand.
 * Everything here is transcribed verbatim from the signed contract template, Arabic orthography
 * included, because a contract that spells the registered address differently from the commercial
 * register is a contract with a defect in it.
 *
 * The four `registration` values are the company's own government identifiers. They are NOT in this
 * repository's history, no Phoenix table holds them, and they cannot be guessed — so an empty
 * string here deliberately prints as a visible gap on the form rather than as plausible-looking
 * wrong digits, which is the failure that matters when the reader is an insurance office clerk.
 * Fill them once and every future Form 1 carries them.
 */
/**
 * Where a candidate is invited, and where to read about the company — the words of an interview
 * invitation. Owner, 2026-09-19: the map pin, the address, the LinkedIn page and the website go in
 * every in-office invitation, and the candidate can be sent them on their own.
 */
export const systemInterviewVenue = {
  addressAr: "عقار رقم ٨ نموذج ن مربع ١٢٥٨ الدور التانى - ش عبدالحميد بدوى بجوار حزب مستقبل وطن - شيراتون",
  linkedinUrl: "https://linkedin.com/company/sato-pharma-careers",
  mapUrl: "https://maps.app.goo.gl/35pPjSAQt3HsG3eE7",
  websiteDisplay: "www.satopharma.com",
  websiteUrl: "https://www.satopharma.com",
} as const;

export const systemLegalEntity = {
  legalNameAr: "شركة ساتو فارما",
  legalNameEn: COMPANY_LEGAL_NAME_EN,
  headOfficeAr: "القاهرة – 1 ش محمد عبد المنعم، منشية السد العالي – قسم أول السلام – القاهرة",
  /** The city named in the contract's opening line ("وفي مدينة القاهرة"). */
  contractCityAr: "القاهرة",
  /** Signs as الطرف الأول. Named in the contract body, so a change here is a contract change. */
  responsibleManagerAr: "الدكتور/ أنور إبراهيم أحمد إبراهيم",
  responsibleManagerTitleAr: "المدير المسئول",
  registration: {
    /**
     * رقم المنشأة — the establishment's NOSI number. The form prints 8 boxes, filled left to right
     * (see `form1-layout.ts` / `form6-layout.ts`, `cells: 8`), so a shorter number leaves the last
     * box(es) blank — which is normal, NOSI establishment numbers are not fixed-width.
     *
     * Set 2026-09-01 to the owner's stated company number, "2807693" (7 digits → box 8 stays blank).
     * If it should carry a leading zero ("02807693"), change it here — nothing else needs touching.
     */
    insuranceEstablishmentNumber: "2807693",
    /**
     * قطاع المنشأة — the form prints TWO boxes (`form1-layout.ts`, `cells: 2`).
     *
     * Set 2026-09-03 to the owner's answer, "2". The grid fills LEFT TO RIGHT, one character per
     * box, so this prints `2` in the left box and leaves the right one blank — the same convention
     * as `insuranceEstablishmentNumber`, whose 7 digits leave box 8 blank and which the owner has
     * already checked against a printed form. If the Authority expects the pair written "02", store
     * it as "02" here; nothing else needs touching.
     *
     * This was the LAST blank registration number. With it set, Form 1 is no longer blocked
     * company-wide — see `COMPANY_REGISTRATION_GAPS` for what that changed in the tests.
     */
    insuranceSectorCode: "2",
    /**
     * رقم التسجيل الضريبي — printed as three free-text runs with the form's own "/" between them.
     *
     * Set 2026-09-03 from the owner's answer, "٣١٨-١٠٨-٤٧٧". STORED IN ASCII DIGITS ON PURPOSE:
     * `splitTaxRegistration` reads Arabic-Indic digits too now, but every other consumer of this
     * value — a CSV, a search, a comparison against the tax card — expects 0-9, and the form
     * renderer is what decides how it is drawn.
     */
    taxRegistrationNumber: "318-108-477",
    /** The default NOSI branch office ("مكتب ..........") for new files. */
    defaultInsuranceOffice: "",
  },
  /**
   * The company as the EMPLOYMENT CONTRACT's recital states it.
   *
   * A separate block from the keys above, and deliberately not a tidier merge of them, because the
   * two describe the same company to two different authorities and they do not agree by accident:
   *
   * - `responsibleManagerAr` / `responsibleManagerTitleAr` are what SOCIAL INSURANCE wants. "المدير
   *   المسئول" is that Authority's own term, printed on Form 1 and Form 6, and the name is given as
   *   those forms carry it.
   * - The contract names the same person in full and by his COMPANY office — "المدير العام والممثل
   *   القانوني للشركة" — because what a contract has to establish is that the signatory can bind the
   *   company, which is a different assertion from naming the employer's responsible manager.
   *
   * Folding the two together would have been the obvious simplification and it is the wrong one: it
   * would silently retitle the signatory on both social-insurance forms and on the job-offer letter,
   * which read the keys above (`src/lib/offers/identity.ts`). Every value here is public registry
   * data that is printed on every contract — none of it is a credential.
   */
  contractRecital: {
    legalFormAr: "شركة ذات مسئولية محدودة",
    /** السجل التجاري, and the office that holds it. */
    commercialRegisterNumber: "82894",
    commercialRegisterOfficeAr: "مكتب سجل تجاري استثمار القاهرة",
    /**
     * الرقم الموحد للسجل التجاري.
     *
     * The separators are U+2011 NON-BREAKING HYPHEN, written as escapes rather than pasted: the
     * source document uses them so the number never breaks across a line, and a pasted one is
     * indistinguishable from an ordinary hyphen in an editor while comparing unequal to it.
     */
    unifiedRegisterNumber: "10530\u201106000\u201182894",
    /** البطاقة الضريبية. Distinct from `registration.taxRegistrationNumber`, which Form 1 prints. */
    taxCardNumber: "477-108-318",
    /** المركز العام, written out in full as the contract's own recital gives it. */
    headOfficeAr:
      "وحدة رقم 1، عمارة رقم 8، شارع محمد عبد المنعم (سعيد صابر)، منشية السد العالي، قسم أول السلام، القاهرة",
    /** Where the company's registered branch sits, named in the same recital. */
    branchRegistryAr: "مصر الجديدة",
    /** Who signs as الطرف الأول on the contract, and in what company office. */
    signatoryNameAr: "الدكتور/ أنور إبراهيم أحمد إبراهيم أحمد جاويش",
    signatoryTitleAr: "المدير العام والممثل القانوني للشركة",
  },
} as const;

/**
 * Commercial terms that appear as blanks in the employment contract but are company policy rather
 * than facts about a person. A hiring profile row may override any of them for one hire; when it
 * does not, these are what print.
 */
export const systemContractDefaults = {
  /** مادة (4) — contract length, and the three-month probation inside it. */
  durationMonths: 12,
  probationMonths: 3,
  /** مادة (10) — the sustained-underachievement threshold and its window. */
  underperformanceThresholdPct: 70,
  underperformanceMonths: 3,
  /** مادة (14) — service owed after a company-funded course. */
  trainingBondMonths: 12,
  /** مادة (19) — "حُرر هذا العقد من أربع نسخ". Four copies, each signed. */
  contractCopies: 4,
  /** Form 1 back-page instruction 1 — "من أصل وصورتين". An original and two copies. */
  form1Copies: 3,
  /**
   * The worker-data form — استمارة بيانات العامل. Its own header says "تُحفظ بملف الخدمة": it is
   * filed once in the personnel file, so a single copy. Written out rather than aliased for the same
   * reason every count here is — a change to one paper's requirement must not silently move another.
   */
  workerDataFormCopies: 1,
  /**
   * Form 6 carries the identical instruction on its own back page — "من أصل وصورتين" — and the
   * owner restated it when he sent the form: three copies, printed on both sides. The two numbers
   * agree, which is exactly why this is written out rather than aliased to `form1Copies`: they
   * happen to match today, and changing one form's requirement must not silently move the other's.
   */
  form6Copies: 3,
  /**
   * The two Ministry of Labour exit templates. The resignation is a letter the employee hands over
   * — one for the labour office, one for his own file. The mutual-termination agreement's own
   * البند السابع gives each party a copy, and the office keeps a third.
   */
  resignationCopies: 2,
  mutualTerminationCopies: 3,
  /**
   * The custody receipt states its own count in its subtitle — "يُحرَّر من نسختين". One is handed
   * to the employee, one is filed. Both forms carry the identical line, and both are written out
   * here rather than shared for the same reason Form 6's count is: they agree today, and a change
   * to one device's paperwork must not silently move the other's.
   */
  custodyLaptopCopies: 2,
  custodyMobileCopies: 2,
  /**
   * The clearance pair. TWO EACH, and the reason is on the papers themselves: each says the other
   * side keeps a copy of it. The employee's clearance is handed to him and the company keeps a
   * duplicate for the personnel file; the company's clearance is filed and the employee is given a
   * copy of what he signed — his own evidence of what he was told the settlement discharged.
   *
   * Written out separately for the same reason every other count here is: they agree today, and
   * changing what one paper needs must not silently move the other's.
   */
  clearanceEmployeeCopies: 2,
  clearanceCompanyCopies: 2,
  /**
   * The renewal annex — FOUR, matching the contract it amends.
   *
   * مادة (89) of Labour Law 14/2025 requires the contract itself to be drawn in four copies, and
   * the annex becomes part of it: one for the employee, one for the service file, one deposited
   * with the labour office and one with the social insurance authority. The annex's own مادة (8)
   * says the same. Written out rather than aliased to `contractCopies` for the reason every count
   * here is written out — they agree today, and a change to what the contract needs must not
   * silently move what the annex needs.
   */
  contractRenewalCopies: 4,
  /**
   * The non-renewal notice — TWO, and the difference from the annex is the point.
   *
   * The annex is an agreement that amends a contract, so it goes everywhere the contract went. This
   * is a unilateral notice: the company hands one over and keeps one carrying the employee's
   * acknowledgment. Nothing is deposited anywhere, because nothing has been agreed — the contract
   * is being allowed to run out on the date it always named.
   */
  contractNonRenewalCopies: 2,
  /**
   * Sato's own papers. Each count is the paper's own stated requirement, written out one per
   * document rather than shared — the rule every count in this block follows, because two papers
   * that happen to need the same number today must not move together tomorrow.
   *
   * The confidentiality undertaking, both appointment-documents forms and both absence notices are
   * TWO: one side keeps a copy and the other side's copy carries the signature that proves it was
   * served or received. The service-file sheet is ONE — its own subtitle says «تُحفظ بملف خدمة
   * العامل», it is filed and never handed over, and a second copy of a sheet nobody receives is a
   * sheet somebody has to shred.
   *
   * The certificate of experience is TWO for a different reason from the rest: nobody signs it back,
   * so the second copy is not a proof of service but the company's own record of what it certified
   * about somebody — which is the copy that matters if the certificate is ever disputed or a second
   * one is asked for years later.
   */
  ndaCopies: 2,
  appointmentDocsReceiptCopies: 2,
  socialStatusSheetCopies: 1,
  absenceWarningCopies: 2,
  deemedResignationCopies: 2,
  appointmentDocsReturnCopies: 2,
  experienceCertificateCopies: 2,
  /**
   * The HR letter (salary) is TWO for the certificate's reason: nobody signs it back, and the
   * filed copy is the company's record of the salary it certified to a bank or an embassy.
   */
  salaryLetterCopies: 2,
  /**
   * The owner's letters pack of 2026-09-13. A decision served on somebody is TWO — his copy, and
   * the one carrying his signature that he was told. The salary memo goes to payroll once. A letter
   * to an insurance office is TWO: the original handed in and the copy filed. The handover record
   * says itself that it is «مكون من أصل» — one original. The exit interview is filed, never handed
   * back. Each government form is ONE: the office asks for the form, and a desk that needs more
   * prints more.
   */
  disciplinaryWarningCopies: 2,
  disciplinaryPenaltyCopies: 2,
  transferDecisionCopies: 2,
  salaryAdjustmentCopies: 1,
  socialInsuranceAuthorizationCopies: 2,
  healthInsuranceAuthorizationCopies: 2,
  insurancePrintLetterCopies: 2,
  handoverRecordCopies: 1,
  exitInterviewCopies: 1,
  maternityCompensationCopies: 1,
  insuranceForm2Copies: 1,
  carInsuranceCertificateCopies: 1,
  wageProgressSheetCopies: 1,
  officialHolidaysSheetCopies: 1,
  sickLeaveSheetCopies: 1,
  penaltiesSheetCopies: 1,
  penaltyRegulationsApprovalCopies: 1,
} as const;

export const systemAuthEmailText = {
  accountSetupSubject: `${systemIdentity.appName} account setup`,
  accountSetupSummary: `Use this one-time link to create your ${systemIdentity.appName} password. After that, sign in with your HR_ID and the password you choose.`,
  accountSetupTitle: `Create your ${systemIdentity.appName} password`,
  passwordResetSubject: `${systemIdentity.appName} password reset`,
  passwordResetSummary: `Use this one-time link to reset your ${systemIdentity.appName} password. After that, sign in with your HR_ID and the new password you choose.`,
  passwordResetTitle: `Reset your ${systemIdentity.appName} password`,
  // The username-and-temporary-password email (owner, 12 Nov 2026 — src/lib/auth/temporary-password.ts).
  credentialsSetupSubject: `Your ${systemIdentity.appName} account`,
  credentialsSetupTitle: `Your ${systemIdentity.appName} account is ready`,
  credentialsResetSubject: `Your new ${systemIdentity.appName} password`,
  credentialsResetTitle: `Your new ${systemIdentity.appName} password`,
  credentialsSummary: `Copy your username and temporary password below into the sign-in page. Once you sign in, ${systemIdentity.appName} asks you to choose your own password, and the temporary one stops working.`,
} as const;

export const systemHrReplyEmailText = {
  concisePreheader: `A concise HR reply from ${systemIdentity.appName}.`,
  firmPreheader: `An official HR response from ${systemIdentity.appName}.`,
  professionalPreheader: `A professional HR reply from ${systemIdentity.appName}.`,
  warmPreheader: `A supportive HR reply from ${systemIdentity.appName}.`,
} as const;

export const systemNotificationEmailText = {
  generalDescription: `General ${systemIdentity.appName} notifications routed to configured recipients.`,
  generalPreviewText: `General ${systemIdentity.appName} notification.`,
  generalSubject: `${systemIdentity.appName} notification`,
  generalSummary: `General ${systemIdentity.appName} notification requiring your attention.`,
  generalTitle: `${systemIdentity.appName} Notification`,
  openAppCtaLabel: `Open ${systemIdentity.appName}`,
  openInAppCtaLabel: `Open in ${systemIdentity.appName}`,
  sourceMetricValue: systemIdentity.appName,
  // Owner rule 2026-09-10: never "Dear Team" — say who is being addressed. These two are the
  // LAST resort, reached only when no recipient name resolved at all, so they address the reader
  // rather than an unnamed group. Every path that knows a name uses it before reaching here.
  teamGreeting: "Dear Colleague,",
  teamRecipientName: "Colleague",
  userGreeting: `Dear ${systemIdentity.brandName} User,`,
  userRecipientName: `${systemIdentity.brandName} User`,
} as const;

export const systemUiText = {
  globalSearchPlaceholder: "Search employees, reports, pages...",
  sidebarSearchPlaceholder: "Search modules...",
  loadingMessage: "Loading Phoenix Workforce...",
  routeErrorDescription: "Phoenix Workforce could not finish loading this workspace view. Retry the render before refreshing or changing routes.",
  notificationsSubtitle: "Only updates assigned to you.",
  internalMessageComposerDescription: "Send inside Phoenix Workforce and optionally email the recipient.",
  login: {
    tagline: "People. Performance. Intelligence.",
    statement: "Phoenix is more than a system",
    statementSuffix: "it's your partner in performance and growth.",
    motto: "Rise. Learn. Rebuild.",
    features: [
      {
        description: "Data-driven intelligence at your fingertips.",
        title: "Performance Insights",
      },
      {
        description: "Enterprise-grade security you can trust.",
        title: "Secure & Reliable",
      },
      {
        description: "Empowering teams to achieve more.",
        title: "Built for Excellence",
      },
    ],
  },
  sidebar: {
    employeePortalKicker: "Portal",
    employeePortalTitle: "Employee workspace",
    employeePortalDescription: "Personal access to performance, payroll, and support workflows.",
    employeePortalFooterTitle: "Portal workspace",
    employeePortalFooterDescription: "Your links and views adapt to the access granted to this account.",
    employeeLogoSubtitle: "Workforce Portal",
  },
} as const;
