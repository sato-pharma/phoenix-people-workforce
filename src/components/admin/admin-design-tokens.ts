export const adminShellBackgroundClassName = "bg-[#F3F6FA]";

// TWO-LAYER SHADOWS (2026-09-03). A single soft 22px blur at 4% is what a card
// looks like when the shadow was picked to be inoffensive: it reads as a slightly
// dirty edge rather than as depth. A hairline contact shadow UNDER a wide ambient
// one is how a real surface sits on paper - the first says the card has an edge,
// the second says it is above the page. Both are shadows, so nothing here changes
// any box's size, which is the constraint the whole premium pass runs under.
export const adminPanelClassName =
  "rounded-[18px] border border-phx-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05),0_12px_28px_rgba(15,23,42,0.055)]";

export const adminSoftPanelClassName =
  "rounded-[16px] border border-[#E5EAF1] bg-[#FCFDFE] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_24px_rgba(15,23,42,0.045)]";

export const adminInsetPanelClassName =
  "rounded-[14px] border border-phx-line bg-[#FBFCFD]";

// ── Unified dark hero ────────────────────────────────────────────────────────
// Single source of truth for the black command-center hero used by every admin
// page header (AdminPageHero), the route loading skeleton, and both command
// centers. The admin shell zeroes border-radius on EVERY element — the LOCKED rule in
// app/globals.css is `.admin-shell [class*="rounded"] { border-radius: 0 !important }`,
// and `rounded-full` matches that selector like any other. Pills, chips, badges and
// dots are square here too; this comment asserted the opposite until 2026-08-29.
// So the `rounded-*` values on the tokens above are inert inside the admin shell, and
// take effect only where the employee portal renders the same token — it reaches this
// module through src/components/ui/loading-state.tsx.
export const adminHeroSurfaceClassName =
  "relative overflow-hidden border border-[#1a1a1a] bg-[linear-gradient(135deg,#000000_0%,#070707_55%,#1C0E02_100%)] shadow-[0_28px_80px_rgba(0,0,0,0.45)]";

// The four decorative aria-hidden layers stacked behind hero content.
export const adminHeroGridOverlayClassName =
  "pointer-events-none absolute inset-0 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,.18)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.18)_1px,transparent_1px)] [background-size:44px_44px]";
export const adminHeroGlowOrangeClassName =
  "pointer-events-none absolute -left-24 -top-24 h-72 w-72 rounded-full bg-orange-500/25 blur-[90px]";
export const adminHeroGlowAmberClassName =
  "pointer-events-none absolute -bottom-28 right-10 h-72 w-72 rounded-full bg-amber-500/15 blur-[100px]";
export const adminHeroAccentBarClassName =
  "pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500/0 via-orange-400/80 to-orange-500/0";

// Text + pill helpers (all readable on the near-black surface).
export const adminHeroKickerClassName =
  "inline-flex w-fit items-center gap-2 rounded-full border border-orange-400/40 bg-orange-500/15 px-3.5 py-1.5 text-phx-2xs font-black uppercase tracking-[0.24em] text-orange-100 shadow-[0_0_24px_rgba(249,115,22,0.25)]";
export const adminHeroTitleClassName =
  "max-w-4xl text-[1.6rem] font-black tracking-[-0.04em] text-white sm:text-[1.9rem] lg:text-[2.1rem]";
export const adminHeroDescriptionClassName =
  "max-w-3xl text-sm leading-6 text-slate-300";

// Translucent-on-dark chips (used by AdminInsightChip tones / hero badges).
export const adminHeroChipClassName =
  "rounded-full border border-white/15 bg-white/10 text-slate-200 backdrop-blur";
export const adminHeroChipOrangeClassName =
  "rounded-full border border-orange-400/40 bg-orange-500/15 text-orange-100 backdrop-blur";

// Hero action buttons (legible on black).
export const adminHeroActionPrimaryClassName =
  "inline-flex items-center justify-center gap-2 rounded-full bg-phx-accent px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(249,115,22,0.32)] transition hover:bg-phx-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60";
export const adminHeroActionSecondaryClassName =
  "inline-flex items-center justify-center gap-2 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-slate-100 backdrop-blur transition hover:border-phx-accent-line hover:bg-white/[0.16] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/50";

// Skeleton fill for the dark loading hero.
export const adminHeroSkeletonClassName = "animate-pulse bg-white/10";

// ── The slim page header ─────────────────────────────────────────────────────
// What replaced the black band on 2026-09-03. The owner's brief was the whole
// constraint: premium, but "WITHOUT THIS THICK BANNER BLOCK". So every gram of
// polish here has to cost ZERO vertical space - the header is exactly as tall as
// the plain title line it replaces (an accent rail that lives inside the text
// block's own padding, and a rule that takes the same 1px the old border-b did).
//
// ONE SOURCE FOR ALL OF THEM. AdminPageHero (131 pages), PremiumHero (6 module
// pages), the KPI board, the resignations board and the two route skeletons all
// pull these, so the language cannot drift page to page - which is what made the
// flattened version look unfinished in the first place: every header was correct
// and none of them was designed.
//
// The rail is SQUARE by design, not by oversight: the admin shell's LOCKED
// globals.css rule zeroes border-radius on anything matching [class*="rounded"],
// so a rounded-full here would be inert inside the shell and rounded in the
// portal - two looks from one token. A 3px square rail reads the same in both.
export const pageHeaderRailClassName =
  "pointer-events-none absolute left-0 top-[0.3rem] bottom-[0.3rem] w-[3px] bg-[linear-gradient(180deg,#F97316_0%,#FB923C_45%,rgba(251,146,60,0.12)_100%)]";

// The rule the header sits on. A flat grey line edge-to-edge is what a header
// looks like when nobody chose it; this one carries the rail's orange for the
// first fifth and fades out entirely, so the eye is pulled left to the title.
// h-px, exactly the border-b it replaces.
export const pageHeaderRuleClassName =
  "h-px w-full bg-[linear-gradient(90deg,rgba(249,115,22,0.6)_0%,rgba(251,146,60,0.38)_9%,rgba(148,163,184,0.34)_34%,rgba(148,163,184,0.12)_68%,rgba(148,163,184,0)_100%)]";

// Literal bracket font sizes on purpose, never the named text-phx-* scale:
// these run through cn() at every call site and tailwind-merge SILENTLY drops
// custom named sizes (AGENTS.md 2.1).
export const pageHeaderKickerClassName =
  "inline-flex w-fit items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.28em] text-orange-600";
export const pageHeaderTitleClassName =
  "max-w-4xl text-[1.2rem] font-black leading-[1.15] tracking-[-0.035em] text-slate-900 sm:text-[1.4rem]";
export const pageHeaderDescriptionClassName =
  "max-w-3xl text-[13px] leading-5 text-slate-500";
