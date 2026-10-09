export const adminShellBackgroundClassName = "bg-[#F3F6FA]";

// 🔒 PREMIUM POLISH — GOLDEN RULE (owner, 2026-09-08). "Remove this rule 'NO MORE PREMIUM
// POLISH' and anything current in system or will be built consider godmode premium polish
// golden rule." So the 2026-09-05 flat pass (#3114) is REVERSED by his own later
// instruction, and depth is the default again: shadows, gradients and glows are wanted,
// here and in anything built from here on.
//
// 🔒 THE SQUARE-EDGE GOLDEN RULE (owner, 2026-09-04) IS UNTOUCHED AND STILL BINDING, and it
// is the one thing a session restoring this file will get wrong. The pre-#3114 tokens
// carried `rounded-[18px]` and `rounded-full` ALONGSIDE the shadows, so restoring them
// verbatim out of git history reintroduces round corners under cover of a rule that says
// nothing about corners. Depth came back; the radii did NOT. Inside the admin shell a
// radius is inert anyway — the LOCKED globals.css rule
// `.admin-shell [class*="rounded"] { border-radius: 0 !important }` zeroes it — but the
// employee portal renders these same tokens WITHOUT that rule, which is exactly how one
// token produced two different looks before, and why the radii were dropped in the first
// place. Both things are true at once: sharp corners, real depth.
//
// TWO-LAYER SHADOWS. A single soft blur reads as a slightly dirty edge rather than as
// depth; a hairline contact shadow UNDER a wide ambient one is how a real surface sits on
// paper — the first says the card has an edge, the second says it is above the page. Both
// are shadows, so nothing here changes any box's size, which is the constraint this whole
// pass runs under.
//
// focus-visible rings are KEPT throughout — they are the keyboard focus indicator, not
// decoration, and removing them would be an accessibility regression.
export const adminPanelClassName =
  "border border-phx-line bg-white shadow-[0_1px_2px_rgba(15,23,42,0.05),0_12px_28px_rgba(15,23,42,0.055)]";

export const adminSoftPanelClassName =
  "border border-[#E5EAF1] bg-[#FCFDFE] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_24px_rgba(15,23,42,0.045)]";

// The inset panel is RECESSED, so it deliberately carries no drop shadow — a panel that
// sits below the surface cannot also float above it. Its depth is the inner shadow.
export const adminInsetPanelClassName =
  "border border-phx-line bg-[#FBFCFD] shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)]";

// ── Depth WITHOUT a ground ───────────────────────────────────────────────────
// The tokens above carry a border and a background as well as a shadow, which is right for a
// surface being built now and wrong for one that already exists. Recruitment draws 139 surfaces
// on `border-slate-200`/`border-slate-300`, on the warm `bg-phx-paper` strips and on the WhatsApp
// preview green — and `--phx-line` is #e0dcd4 (warm) where slate-200 is #e2e8f0 (cool). Taking
// those onto adminPanelClassName would recolour a hundred borders: a redesign, under cover of a
// rule about depth. These five are the SAME shadows as the tokens above, named once, for a
// surface that keeps its own ground. tests/recruitment-premium-depth.test.ts pins each one to the
// token it was lifted from, so the two cannot drift apart.
//
// Which one a surface takes is decided by where it sits, never by how big it is:
//   • PANEL    — a page-level box: the two-layer lift, so it reads as sitting ON the page.
//   • SOFT     — a box nested inside a panel: the same shape, shallower, so it does not compete.
//   • RECESSED — a read-only well, a dialog's edge strip, a toolbar tray: an INNER shadow, because
//                a surface below the page cannot also float above it.
//   • CONTROL  — a button: a contact shadow that grows on hover. Pair it with
//                `disabled:shadow-none` wherever the control has a disabled state, or a greyed
//                button goes on floating and still reads as clickable.
//   • CHIP     — a pill or a segmented group: contact only, so a pill still reads as a pill.
export const adminPanelDepthClassName =
  "shadow-[0_1px_2px_rgba(15,23,42,0.05),0_12px_28px_rgba(15,23,42,0.055)]";
export const adminSoftDepthClassName =
  "shadow-[0_1px_2px_rgba(15,23,42,0.04),0_10px_24px_rgba(15,23,42,0.045)]";
export const adminRecessedDepthClassName = "shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)]";
export const adminControlDepthClassName =
  "shadow-[0_1px_2px_rgba(15,23,42,0.06)] hover:shadow-[0_2px_6px_rgba(15,23,42,0.10)]";
export const adminChipDepthClassName = "shadow-[0_1px_1px_rgba(15,23,42,0.05)]";

// The dark header band that sits at the top of a panel, naming what the panel is. The Approvals
// Hub wears it on thirteen panels and was the reason this became a token: thirteen copies of
// `bg-slate-900` drift the moment one of them is touched.
//
// It is the HERO's own treatment at band scale, and for the hero's own stated reason — the warm
// third stop is what stops a near-black band reading as an unstyled div — with the hairline under
// it carrying the module accent instead of the grey line that is invisible against black anyway.
// No radius, by the square-edge rule; the padding stays at the call site, because a band over a
// table and a band over prose do not want the same one.
export const adminPanelHeaderClassName =
  "border-b border-orange-500/25 bg-[linear-gradient(135deg,#0F172A_0%,#0B1220_55%,#1C0E02_100%)]";

// ── Unified dark hero ────────────────────────────────────────────────────────
// Single source of truth for the black command-center hero used by every admin
// page header (AdminPageHero), the route loading skeleton, and both command
// centers. The three-stop diagonal and its drop shadow are BACK (2026-09-08) — the warm
// third stop is what stops a black band reading as an unstyled div.
export const adminHeroSurfaceClassName =
  "relative overflow-hidden border border-[#1a1a1a] bg-[linear-gradient(135deg,#000000_0%,#070707_55%,#1C0E02_100%)] shadow-[0_28px_80px_rgba(0,0,0,0.45)]";

// The three decorative aria-hidden layers stacked behind hero content, restored 2026-09-08:
// a grid overlay and two colour glows. All three are `aria-hidden` and `pointer-events-none`,
// so they add texture while reaching no screen reader and no hit target.
//
// NOTE THE MISSING `rounded-full` ON THE TWO GLOWS. They were circles before #3114. At a
// 90–100px blur a square and a circle are indistinguishable, so squaring them costs nothing
// on screen and keeps the square-edge golden rule intact — restoring the radius would break
// that rule in the employee portal, where nothing zeroes it, for no visible gain.
export const adminHeroGridOverlayClassName =
  "pointer-events-none absolute inset-0 opacity-[0.16] [background-image:linear-gradient(rgba(255,255,255,.18)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.18)_1px,transparent_1px)] [background-size:44px_44px]";
export const adminHeroGlowOrangeClassName =
  "pointer-events-none absolute -left-24 -top-24 h-72 w-72 bg-orange-500/25 blur-[90px]";
export const adminHeroGlowAmberClassName =
  "pointer-events-none absolute -bottom-28 right-10 h-72 w-72 bg-amber-500/15 blur-[100px]";

// The accent edge: a transparent-to-orange-to-transparent gradient again, so it reads as
// light falling across the top of the hero rather than as a printed bar.
export const adminHeroAccentBarClassName =
  "pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500/0 via-orange-400/80 to-orange-500/0";

// Text + pill helpers (all readable on the near-black surface).
export const adminHeroKickerClassName =
  "inline-flex w-fit items-center gap-2 border border-orange-400/40 bg-orange-500/15 px-3.5 py-1.5 text-phx-2xs font-black uppercase tracking-[0.24em] text-orange-100 shadow-[0_0_24px_rgba(249,115,22,0.25)]";
export const adminHeroTitleClassName =
  "max-w-4xl text-[1.6rem] font-black tracking-[-0.04em] text-white sm:text-[1.9rem] lg:text-[2.1rem]";
export const adminHeroDescriptionClassName =
  "max-w-3xl text-sm leading-6 text-slate-300";

// Translucent-on-dark chips (used by AdminInsightChip tones / hero badges).
export const adminHeroChipClassName =
  "border border-white/15 bg-white/10 text-slate-200 backdrop-blur";
export const adminHeroChipOrangeClassName =
  "border border-orange-400/40 bg-orange-500/15 text-orange-100 backdrop-blur";

// Hero action buttons (legible on black).
export const adminHeroActionPrimaryClassName =
  "inline-flex items-center justify-center gap-2 bg-phx-accent px-4 py-2 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(249,115,22,0.32)] transition hover:bg-phx-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/60";
export const adminHeroActionSecondaryClassName =
  "inline-flex items-center justify-center gap-2 border border-white/20 bg-white/10 px-4 py-2 text-sm font-semibold text-slate-100 backdrop-blur transition hover:border-phx-accent-line hover:bg-white/[0.16] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-phx-accent/50";

// Skeleton fill for the dark loading hero.
export const adminHeroSkeletonClassName = "animate-pulse bg-white/10";

// ── The slim page header ─────────────────────────────────────────────────────
// ONE SOURCE FOR ALL OF THEM. AdminPageHero (131 pages), PremiumHero (6 module
// pages), the KPI board, the resignations board and the two route skeletons all
// pull these, so the language cannot drift page to page.
//
// The rail and the rule are gradients again (2026-09-08). The rail stays SQUARE by design,
// not by oversight — see the corner note at the top of this file — and the header still
// costs ZERO vertical space over the plain title line it replaced.
export const pageHeaderRailClassName =
  "pointer-events-none absolute left-0 top-[0.3rem] bottom-[0.3rem] w-[3px] bg-[linear-gradient(180deg,#F97316_0%,#FB923C_45%,rgba(251,146,60,0.12)_100%)]";

// The rule the header sits on. A flat grey line edge-to-edge is what a header looks like
// when nobody chose it; this one carries the rail's orange for the first fifth and fades
// out entirely, so the eye is pulled left to the title. h-px, exactly the border-b it
// replaces.
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
