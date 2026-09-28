---
name: phoenix-pptx-design-reference
description: "THE reference design system for every Phoenix deck / handbook / PPTX — the black-and-orange Phoenix Workforce brand (distinct from the Sato house document identity), derived from phoenix-workforce-phase-one-launch.pptx and vetted against the live app tokens. Use whenever asked to make any Phoenix presentation: holds the LOCKED palette, type scale, signature motifs, slide archetypes, the explicitly-rejected 'looks premium but breaks the brand' list, and the pptxgenjs + PowerPoint-COM build/QA recipe."
metadata:
  node_type: memory
  type: reference
  originSessionId: 76fc0d1e-2403-48fe-9b8c-a1fb8991cc9a
  modified: 2026-09-26T05:41:42.223Z
---

Single source of truth for every Phoenix deck, handbook and executive presentation — the **Phoenix Workforce**
black-and-orange brand (NOT the Sato house document identity, which governs company documents). Canonical
reference: `C:\Users\satoh\OneDrive\Desktop\phoenix-workforce-phase-one-launch.pptx` (4 slides, 16:9) —
**match it.** Palette/motifs/type are verified against both that deck's XML and the live admin tokens
(`src/components/admin/admin-design-tokens.ts`); where deck and app agree, that agreement IS the brand. The
identity is **discipline over decoration** — governance-first restraint.

## 1. Canvas
- **16:9, exactly 13.33in × 7.5in** (1280×720). **Two surface modes only:** dark (black/navy — hero, headers,
  command cards, summary banners) or light (white / `#F8FAFC` — content). No third background.
- **Top orange hairline** pinned to the very top edge of EVERY slide (the one element all slides share).
  **Footer on every slide** (§5.9). **Square / near-square corners** (mirror the app; rounding only on
  intentional pills/chips). Nothing decorative bleeds off-canvas except the sanctioned hero emblem — no
  watermarks, clip-art or stock photography.

## 2. Color — do NOT introduce colors outside this list

| Role | Hex | Usage |
| --- | --- | --- |
| Black | `#000000` | Dark surfaces, numbered chips, footer base |
| Slate-900 navy | `#0F172A` | Dark command cards, summary banners, dark titles on light |
| Hero gradient | `#000000` → `#070707` → `#1C0E02` | Dark-surface gradient, 135° (verbatim `adminHeroSurfaceClassName`) |
| Light ground | `#F8FAFC` | Default light background |
| Light ground cool | `#E5EAF1` | Secondary light ground **and the canonical hairline-divider color** |
| Card white | `#FFFFFF` | Cards, numbered rows, neutral pills |
| **Primary — Orange** | `#F97316` | Fills, top rule, highlight chips, emblem, pill borders, page number |
| Dark orange | `#C2410C` | **The ONLY orange for small text on light grounds**, highlighted-pill text |
| Orange wash | `#FFF7ED` | Highlighted pill/chip background |
| Orange tint | `#FED7AA` | Secondary orange accents, soft chip edges |
| Orange light | `#F8B56B` | Command-card sub-labels (sentence-case) |
| Amber (glow only) | `#F59E0B` | Bottom-right radial glow on dark surfaces (~15% opacity) |
| Muted slate | `#64748B` | Subtitle on light; ALL-CAPS stat labels |
| Muted slate mid | `#94A3B8` | Secondary muted text |
| Muted slate light | `#CBD5E1` | Subtitle on dark; neutral pill borders |

**60/30/10 governance rule:** ~60% neutral ground, ~30% structural navy/black ink, **≤~10% orange** per slide
(top rule + kicker dash + the ONE highlight + pill orange + page number). Orange-heavy = a broken highlight-one
somewhere. The phoenix-fire gradient (red→orange→gold) lives ONLY in the emblem + the dark-surface radial
glow — never spread it. **AA contrast:** `#F97316` for fills/shapes/display-size marks only; small orange text
on light must be `#C2410C` (bright small orange fails AA); the emblem "X" and kicker dash stay `#F97316`.

## 3. Typography — Aptos throughout (one typeface), locked scale
| Tier | Size | Weight | Notes |
| --- | --- | --- | --- |
| Title | 28–30pt (lock larger) | Bold/Black | Sentence-case, IDENTICAL on every slide (no optical shrink on dark) |
| Subtitle | ~16–18pt | Regular | `#64748B` light / `#CBD5E1` dark, ~1.4 leading, ≤60–70 char measure |
| Body/card | one shared ~10.5–11pt | Regular | ~1.4 leading; don't drift across 9/9.75/10.5/11.25 |
| Kicker | 7.5pt | Black | ALL-CAPS orange `#F97316` |
| Micro (footer/page#/pill) | one shared 9–10pt | Semibold | unify size + tracking deck-wide |

- **Kicker is the signature:** one per slide, above the title, orange dash + ALL-CAPS orange label. 🔴 **ALL-CAPS
  is reserved for the kicker tier ONLY** — never uppercase command-card/step sub-labels (that clones the
  signature). The deck uses no letter-tracking today.
- **Sub-labels** (Visibility / Priorities / Readiness) = sentence-case, lighter orange `#F8B56B` ~8.25pt.

## 4. Logo & emblem
- **Lockup:** circular fiery phoenix + `PHOENIX` (white, final **X** orange) over `WORKFORCE` (orange,
  tracked). **Always on black** — never on light/colored panels. The **standalone bird** is a hero accent
  (sharp on flat/gradient black — the fire supplies its own warmth; add NO manufactured radial halo behind
  it). Never recolor/desaturate the emblem, never ghost/watermark it behind body content.
- App raster assets (source of truth): `public/brand/{phoenix-bird-icon,phoenix-sidebar-lockup,phoenix-login-emblem,phoenix-rail-mark}.png`.

## 5. Signature motifs (reuse verbatim, invent none)
1. **Top orange hairline** — top edge only, every slide, identical (app accent bar
   `from-orange-500/0 via-orange-400/80 to-orange-500/0`). NEVER under a title or inside a card.
2. **Orange kicker** (§3). 3. **Title + subtitle pair** (navy on light / white on dark + slate subtitle).
4. **Numbered item chip** — small black square, white bold number, bold label, white row, `#E5EAF1` divider
   (must hold 2 digits on one line). 5. **Highlight-one ("dominance over equality")** — in any set, EXACTLY
   one item orange (solid `#F97316` chip OR `#FFF7ED` bg + `#C2410C` text + orange border); rest neutral.
6. **Dark command card** (black/`#0F172A`: white title, orange `#F8B56B` sub-labels, white rows).
7. **Dark navy summary banner** (full-width `#0F172A`, white centered, closes a message). 8. **Two-state tag
   pills** (neutral = white/slate/`#CBD5E1`; highlighted = `#FFF7ED`/`#C2410C`/`#F97316` border). 9. **Footer**
   = `Phoenix Workforce | <deck name>` (tiny muted, left) + 2-digit orange page number (right).

## 6. Slide archetypes (built only from §5 motifs)
- **A. Dark title** — dark gradient, lockup top-left, kicker→huge title→subtitle (left), standalone bird +
  caption (right), bottom domain-chip row (highlight-one). **B. Light command-card content** (2-col ~5/1/6:
  left dark command card, right white 2-col numbered grid). **C. Numbered coverage grid** — team column cards,
  each a black header bar (white centered name; optional white count badge "HR · 12") + white numbered list
  w/ `#E5EAF1` hairlines; **content-weighted columns** (heaviest team double-width/2-col; widen narrow columns
  to stop label wrap); equal header height + shared baseline; closed by a full-width dark-navy banner.
  **D. Step-flow closing** — dark header band, row of 4 step cards linked by thin orange connector dashes
  (highlight-one; no spanning orange labels across connectors), dark-navy banner + tag pills. **E. Dark
  summary banner** (full-width `#0F172A`, one white centered line). **F. Section divider** — dark full-bleed
  `#0F172A`, small bird top-left, large orange section number ("01 / 04") + ALL-CAPS orange kicker + one white
  statement. **G. Big-stat callout** — light, 3/4-up large navy numerals + tiny ALL-CAPS slate labels,
  `#E5EAF1` hairlines, highlight-one figure orange-washed, square cells. **Numbers in F/G must be derived from
  real content, never invented.**

## 7. Layout
- **Master 12-column grid**, fixed outer margin ~0.55in, consistent gutter. Top-hairline inset, kicker, title,
  subtitle and first card ALL snap to ONE left guide (kill per-slide origin drift). Document column spans per
  archetype (B = 5/1/6; D = four 3-col cards).
- **Numbered chip is a fixed-value component:** fixed min-width black rectangle, 1–2 digits on one line
  (horizontal padding only, near-square), tabular/lining figures, `wrap: false`, fixed row height, `#E5EAF1`
  divider — identical on every numbered slide.
- **Size panels to content, not the slide** (even top/bottom padding; vertically center short blocks).
  **Vertical spacing scale: 8 / 16 / 24 / 40.**

## 8. Voice
Corporate, governance-first, executive, concise — every line reads like a controlled operating standard, not
marketing. Sentence-case titles; **evidence over assertion** (attach a proof-noun: "Priorities · CEO
worklist"); quantify scope where an exec anchors on a number. No hype, no emoji, no exclamation. English only.

## 9. The reusable premium recipes (depth + discipline, never a new color/font/shape)
- **Dark-hero texture** on every dark surface: `linear-gradient(135deg,#000000 0%,#070707 55%,#1C0E02 100%)`
  + a 44×44px white grid @ ~16% opacity + ONE soft orange `#F97316` @ ~25% top-left + ONE amber `#F59E0B` @
  ~15% bottom-right glow (subtle/executive, never gamer-RGB, never on light slides, keep glows low so card
  text stays legible). **Top hairline** = the accent-bar gradient, top edge only. **One highlight-chip glow**
  `shadow: 0 0 24px rgba(249,115,22,0.25)` on the single orange chip, dark command cards only.

## ❌ Explicitly REJECTED — look premium, break the brand
- Colored hairline rules inside cards / orange wash behind card headers (orange rules = top edge ONLY); a top
  hairline that differs by slide type (the flat identical rule is load-bearing).
- A radial glow halo behind the emblem; the grid overlay on the title slide as emblem decor.
- **A ghosted/desaturated phoenix watermark behind body content** (the bird is a sharp hero accent, never a
  background wash).
- **A lucide/icon set per module/step** — the canonical deck has ZERO icons; meaning = numbered chips +
  typography (icons add a net-new vocabulary and multiply orange surfaces).
- Spanning orange process-flow labels across connectors, or a second mid-slide kicker (breaks
  one-kicker-per-slide). Off-palette slate `#475569` for subtitles. ALL-CAPS on sub-labels. Accent lines under
  titles, decorative bars beyond the top rule + dark banner, cream/beige backgrounds, clip-art.

## 10. Build & QA facts
- **Build with pptxgenjs** (Node), encoding the system as reusable helpers (`chip()`/`chipBox()`,
  `kickerBlock()`, `commandCard()`, `coverageColumn()`, `summaryBanner()`, `darkHeroSurface()`) hardcoding the
  verified hex + the §9 recipe; OR edit the template `.pptx` directly (it is a ZIP — `python` stdlib
  `zipfile` works; `python-pptx`/`defusedxml` are NOT installed).
- 🔴 **Aptos is NOT installed on this machine** — a PPTX has no fallback chain, so specifying Aptos silently
  substitutes. Build with **Segoe UI** (universal on Windows, and the COM-rendered QA PNGs then match what the
  room sees). Re-check if Office is upgraded.
- **The numbered chip wraps "01" vertically** because PowerPoint applies a default ~0.1in text inset — fix
  with `margin: 0` on the chip text + `wrap: false`, box 0.30in.
- **`phoenix-sidebar-lockup.png` has an OPAQUE black plate** (no tRNS) — it reads as a floating black rectangle
  on the gradient hero. Compose the lockup from `phoenix-bird-icon.png` (has tRNS) + text instead
  ("PHOENI" white + "X" orange, over "WORKFORCE" orange ~3.4pt tracking). `phoenix-login-emblem.png` also has
  alpha. **`sato-pharma-logo.png` is off-palette blue and a partial crop — never put it in a Phoenix deck.**
- pptxgenjs cannot do gradient fills → generate the dark hero as a full-bleed PNG (Node `zlib` manual encoder);
  a grid overlay above ~+10/255 on near-black reads as graph paper, +8 is right.
- **Render/QA:** LibreOffice/`pdftoppm` are NOT installed — use PowerPoint COM
  (`New-Object -ComObject PowerPoint.Application` → `$pres.Export("<dir>","PNG",1920,1080)` → `Close`/`Quit` →
  `ReleaseComObject`), then Read each PNG against this spec.
- **QA checklist:** top hairline at the very top edge only · exactly one ALL-CAPS orange kicker above the title
  · footer + 2-digit orange page number · 60/30/10 audit (orange ≤10%, fire-gradient only on emblem + dark
  glow) · highlight-one in every set · numbered chips hold 2 digits on one line with `#E5EAF1` dividers · no
  off-palette colors (no `#475569`, no cream/beige) · no banned decoration (no under-title rules, no icons,
  no watermark, no clip-art) · dark surfaces use the 135° gradient + 16% grid + subtle glows (not flat black),
  text legible · one title size everywhere, left-guide alignment, 8/16/24/40 spacing · square geometry.
