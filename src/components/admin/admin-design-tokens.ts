export const adminShellBackgroundClassName = "bg-[#F3F6FA]";

export const adminPanelClassName =
  "rounded-[18px] border border-phx-line bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)]";

export const adminSoftPanelClassName =
  "rounded-[16px] border border-[#E5EAF1] bg-[#FCFDFE] shadow-[0_6px_18px_rgba(15,23,42,0.035)]";

export const adminInsetPanelClassName =
  "rounded-[14px] border border-phx-line bg-[#FBFCFD]";

// ── Unified dark hero ────────────────────────────────────────────────────────
// Single source of truth for the black command-center hero used by every admin
// page header (AdminPageHero), the route loading skeleton, and both command
// centers. The admin shell zeroes border-radius (square corners) except
// rounded-full, so the surface reads square and pills stay round.
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
