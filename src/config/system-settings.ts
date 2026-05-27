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
} as const;

export const systemDeployment = {
  productionBranch: "main",
  workingBranch: "codex/work-from-production",
  productionUrl: "https://phoenix-workforce.vercel.app",
  workingPreviewUrl: "https://phoenix-workforce-git-codex-c8df8e-phoenix-workspace-s-projects.vercel.app",
} as const;

export const systemEditingPolicy = {
  fastCheckScript: "npm run check:edit",
  hardeningScript: "npm run check:harden",
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
  defaultFromEmail: "phoenix@mail.satopharma.com",
  defaultReplyTo: "phoenix@satopharma.com",
  // ── EMAIL TESTING SAFETY SWITCH ──────────────────────────────────────────────
  // While `true`, EVERY outgoing email (notifications, password-setup links, HR
  // replies, internal messages, excuse decisions) is redirected ONLY to the
  // `testingRecipientFallback` addresses below — real recipients receive nothing.
  // Keep this `true` while you are still editing and testing.
  // When you are ready to send to real recipients, change `true` to `false`.
  forceTestingDelivery: true,
  testingRecipientFallback: [
    "omar.anwar@satopharma.com",
    "achieverrr303@gmail.com",
    "phoenix@satopharma.com",
  ],
} as const;

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
  notificationsSubtitle: "Latest Phoenix Workforce updates.",
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
