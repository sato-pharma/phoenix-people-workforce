export const adminShellBackgroundClassName = "bg-[#F3F6FA]";

// FLAT (owner, 2026-09-05: "NO MORE PREMIUM POLISH ... flat"). Depth is carried by the
// border alone. The two-layer contact+ambient shadow that used to sit here, and every
// gradient, glow, blur and decorative ring in this file, are gone. Corners are square:
// the admin shell already zeroes border-radius through the LOCKED globals.css rule
// `.admin-shell [class*="rounded"] { border-radius: 0 !important }`, but the employee
// portal renders these same tokens WITHOUT that rule, so a `rounded-*` here produced two
// different looks from one token. Removing it is what makes the two agree.
//
// focus-visible rings are deliberately KEPT throughout — they are the keyboard focus
// indicator, not decoration, and removing them would be an accessibility regression.
export const adminPanelClassName = "border border-phx-line bg-white";

export const adminSoftPanelClassName = "border border-[#E5EAF1] bg-[#FCFDFE]";

export const adminInsetPanelClassName = "border border-phx-line bg-[#FBFCFD]";

// ── Unified dark hero ────────────────────────────────────────────────────────
// Single source of truth for the black command-center hero used by every admin
// page header (AdminPageHero), the route loading skeleton, and both command
// centers. Flat black now, not a three-stop diagonal gradient, and no drop shadow.
export const adminHeroSurfaceClassName =
  "relative overflow-hidden border border-[#1a1a1a] bg-[#000000]";

// The three decorative aria-hidden layers that used to stack behind hero content — a grid
// overlay and two blurred colour glows — are GONE, exports and all. They had exactly one
// call site (AdminHeroFrame) and nothing else in the app imported them, so leaving inert
// stubs would only have left three empty divs and three dead exports behind.
//
// The accent edge below stays, but solid: a 4px rule is structure, not polish. It was a
// transparent-to-orange-to-transparent gradient.
export const adminHeroAccentBarClassName =
  "pointer-events-none absolute inset-x-0 top-0 h-1 bg-phx-accent";

// Text + pill helpers (all readable on the near-black surface).
export const adminHeroKickerClassName =
  "inline-flex w-fit items-center gap-2 border border-orange-400/40 bg-orange-500/15 px-3.5 py-1.5 text-phx-2xs font-black uppercase tracking-[0.24em] text-orange-100";
export const adminHeroTitleClassName =
  "max-w-4xl text-[1.6rem] font-black tracking-[-0.04em] text-white sm:text-[1.9rem] lg:text-[2.1rem]";
export const adminHeroDescriptionClassName =
  "max-w-3xl text-sm leading-6 text-slate-300";

// Translucent-on-dark chips (used by AdminInsightChip tones / hero badges).
export const adminHeroChipClassName = "border border-white/15 bg-white/10 text-slate-200";
export const adminHeroChipOrangeClassName =
  "border border-orange-400/40 bg-orange-500/15 text-orange-100";

// Hero action buttons (legible on black).
export const adminHeroActionPrimaryClassName =
  "inline-flex items-center justify-center gap-2 bg-phx-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-phx-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60";
export const adminHeroActionSecondaryClassName =
  "inline-flex items-center justify-center gap-2 border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-slate-100 transition hover:border-phx-accent-line hover:bg-white/[0.16] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/50";

// Skeleton fill for the dark loading hero.
export const adminHeroSkeletonClassName = "animate-pulse bg-white/10";

// ── The slim page header ─────────────────────────────────────────────────────
// ONE SOURCE FOR ALL OF THEM. AdminPageHero (131 pages), PremiumHero (6 module
// pages), the KPI board, the resignations board and the two route skeletons all
// pull these, so the language cannot drift page to page.
//
// Both the rail and the rule were gradients. They are solid now. The rail was
// already square by design; the constraint it was built under still holds — the
// header costs ZERO vertical space over the plain title line it replaced.
export const pageHeaderRailClassName =
  "pointer-events-none absolute left-0 top-[0.3rem] bottom-[0.3rem] w-[3px] bg-phx-accent";

// The rule the header sits on. h-px, exactly the border-b it replaces.
export const pageHeaderRuleClassName = "h-px w-full bg-phx-line";

// Literal bracket font sizes on purpose, never the named text-phx-* scale:
// these run through cn() at every call site and tailwind-merge SILENTLY drops
// custom named sizes (AGENTS.md 2.1).
export const pageHeaderKickerClassName =
  "inline-flex w-fit items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.28em] text-orange-600";
export const pageHeaderTitleClassName =
  "max-w-4xl text-[1.2rem] font-black leading-[1.15] tracking-[-0.035em] text-slate-900 sm:text-[1.4rem]";
export const pageHeaderDescriptionClassName =
  "max-w-3xl text-[13px] leading-5 text-slate-500";
