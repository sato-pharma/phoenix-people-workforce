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
  testingRecipientFallback: ["omar.anwar@satopharma.com", "phoenix@satopharma.com"],
} as const;

export const systemUiText = {
  globalSearchPlaceholder: "Search employees, reports, pages...",
  sidebarSearchPlaceholder: "Search modules...",
  loadingMessage: "Loading Phoenix Workforce...",
  routeErrorDescription: "Phoenix Workforce could not finish loading this workspace view. Retry the render before refreshing or changing routes.",
  notificationsSubtitle: "Latest Phoenix Workforce updates.",
  internalMessageComposerDescription: "Send inside Phoenix Workforce and optionally email the recipient.",
  login: {
    passwordLinkHelpMessage: "Need a password link? Ask your Phoenix admin to generate one from Users & Access.",
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
