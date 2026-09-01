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
  fastCheckScript: "pnpm run check:edit",
  // No `hardeningScript` counterpart: `check:harden` was retired on 2026-08-18 and CI is the gate.
  // `pnpm run ci` runs the same steps by hand, but it is opt-in and deliberately not named here.
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
  defaultReplyTo: "phoenix@satopharma.com",
  // Controlled internal inboxes only. NEVER add personal/external addresses here:
  // when testing-delivery is on, ALL mail is redirected to this list, so a personal
  // address would receive real employee/candidate PII.
  testingRecipientFallback: [
    "omar.anwar@satopharma.com",
    "phoenix@satopharma.com",
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
  workbookCompany: systemIdentity.appName,
  workbookCreator: systemIdentity.appName,
  workbookExportScopeNote: `Generated from ${systemIdentity.appName} according to the active user access scope.`,
  titles: {
    attendanceDeviceUserMapping: `${systemIdentity.appName} - Attendance Device User Mapping`,
    activeEmployeeMasterData: `${systemIdentity.appName} - Active Employee Master Data`,
    activeEmployeeMasterDataWorkbook: `${systemIdentity.appName} Active Employee Master Data`,
    coachingReportsExport: `${systemIdentity.appName} | Coaching Reports Export`,
    cvDatabaseUploadTemplate: `${systemIdentity.brandName} CV Database Upload Template`,
    fingerprintAttendanceReport: `${systemIdentity.appName} - Fingerprint Attendance Report`,
    probationExport: `${systemIdentity.appName} | Probation Export`,
    probationPdfExport: `${systemIdentity.appName} - Probation Export`,
    userBulkImportTemplate: `${systemIdentity.appName} Bulk Import Template`,
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
export const systemLegalEntity = {
  legalNameAr: "شركة ساتو فارما",
  legalNameEn: "Sato Pharma",
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
    /** قطاع المنشأة — two digits. */
    insuranceSectorCode: "",
    /** رقم التسجيل الضريبي — printed as three groups (nnn/nnnnn/nnn). */
    taxRegistrationNumber: "",
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
} as const;

export const systemAuthEmailText = {
  accountSetupSubject: `${systemIdentity.appName} account setup`,
  accountSetupSummary: `Use this one-time link to create your ${systemIdentity.appName} password. After that, sign in with your HR_ID and the password you choose.`,
  accountSetupTitle: `Create your ${systemIdentity.appName} password`,
  passwordResetSubject: `${systemIdentity.appName} password reset`,
  passwordResetSummary: `Use this one-time link to reset your ${systemIdentity.appName} password. After that, sign in with your HR_ID and the new password you choose.`,
  passwordResetTitle: `Reset your ${systemIdentity.appName} password`,
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
  teamGreeting: `Dear ${systemIdentity.brandName} Team,`,
  teamRecipientName: `${systemIdentity.brandName} Team`,
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
