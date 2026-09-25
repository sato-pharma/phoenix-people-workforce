---
name: phoenix-pptx-design-reference
description: "THE reference design system for all Phoenix decks/handbooks/PPTX — derived from phoenix-workforce-phase-one-launch.pptx and vetted against live app tokens. Use this whenever asked to make any Phoenix presentation/document."
metadata:
  node_type: memory
  type: reference
  originSessionId: 76fc0d1e-2403-48fe-9b8c-a1fb8991cc9a
  modified: 2026-07-30T05:45:02.225Z
---

# Phoenix Presentation Design System + Premium Enhancement Playbook

> Single source of truth for every Phoenix deck, handbook, and executive presentation. Canonical reference artifact = `C:\Users\satoh\OneDrive\Desktop\phoenix-workforce-phase-one-launch.pptx` (4 slides, 16:9). **Match it.** Palette/motifs/type below are verified against both that deck's XML and the live admin app tokens (`src/components/admin/admin-design-tokens.ts`). Where deck and app agree, that agreement IS the brand. When in doubt: **discipline over decoration** — governance-first restraint is the identity. Analyzed 2026-06-05 (rendered every slide via PowerPoint COM; vetted by an 11-agent brand-fidelity pass).

---

## 1. Format & Canvas
- **16:9, exactly 13.33in × 7.5in** (1280×720 design units).
- **Two surface modes only:** dark (black/navy — hero, headers, command cards, summary banners) or light (white / `#F8FAFC` — content & coverage). No third background.
- **Top hairline:** thin orange rule pinned to the very top edge of every slide (the one element shared by all slides).
- **Footer:** every slide (see §5).
- **Corners:** square / near-square (mirror the app shell which zeroes border-radius except `rounded-full` pills). Rounding only on intentional pills/chips.
- **No bleed clutter:** nothing decorative bleeds off-canvas except the sanctioned hero emblem. No watermarks, clip-art, or stock photography.

## 2. Color System
### 2.1 Verified palette (do NOT introduce colors outside this list)
| Role | Hex | Usage |
| --- | --- | --- |
| Black | `#000000` | Dark surfaces, numbered chips, footer base |
| Slate-900 (navy) | `#0F172A` | Dark command cards, summary banners, dark titles on light slides |
| Hero gradient stops | `#000000` → `#070707` → `#1C0E02` | Dark-surface gradient (135°), verbatim from `adminHeroSurfaceClassName` |
| Light ground | `#F8FAFC` | Default light slide background |
| Light ground (cool) | `#E5EAF1` | Secondary light ground **and the canonical hairline-divider color** |
| Card white | `#FFFFFF` | Cards, numbered rows, neutral pills |
| **Primary accent — Orange** | `#F97316` | Fills, top rule, solid highlight chips, emblem, pill borders |
| Dark orange | `#C2410C` | **Orange-as-text on light grounds**, highlighted-pill text |
| Orange wash | `#FFF7ED` | Highlighted pill / chip background |
| Orange tint | `#FED7AA` | Secondary orange accents, soft chip edges |
| Orange light | `#F8B56B` | Command-card sub-labels (sentence-case) |
| Amber (glow only) | `#F59E0B` | Bottom-right radial glow on dark surfaces (~15% opacity) |
| Muted slate | `#64748B` | Subtitle on light; ALL-CAPS stat labels |
| Muted slate (mid) | `#94A3B8` | Secondary muted text |
| Muted slate (light) | `#CBD5E1` | Subtitle on dark; neutral pill borders |

### 2.2 The 60/30/10(+sliver) ratio — governance rule
Audit every slide. The deck already obeys this (~32 orange fills vs ~324 black ≈ 10%).
- **~60% neutral ground** — white/`#F8FAFC` on light; black→navy gradient on dark.
- **~30% structural ink** — navy/black for titles, chips, header bars, body.
- **~10% orange** — `#F97316`: top rule, the single highlight, kicker dash, pill/chip orange, page number.
- **Tiny reserved sliver** — phoenix-fire gradient (red→orange→gold) lives ONLY in the emblem + the dark-surface radial glow. Never spread it.
- **Hard rule:** orange ≤ ~10% per slide. Orange-heavy = broken highlight-one somewhere.

### 2.3 Orange fill-vs-text contrast (AA discipline)
- `#F97316` (bright) = fills, top rule, chips, pill borders, emblem (shapes / display-size marks).
- `#C2410C` (dark) = the ONLY approved orange for small text on light grounds (footnotes, footer/page-number, highlighted-pill text). Small bright orange text fails AA.
- Display-size orange text exempt (emblem's "X", kicker dash stay `#F97316`).

## 3. Typography
**Aptos throughout.** Bold headings, regular body. No second typeface.
### 3.1 Governed type scale (~1.25 ratio) — LOCKED (stop hand-sizing titles)
| Tier | Size | Weight | Notes |
| --- | --- | --- | --- |
| **Title** | **28–30pt (lock at larger end)** | Bold/Black | Sentence-case. **Identical on every slide, dark or light** (no optical shrink on dark). |
| **Subtitle** | ~16–18pt | Regular | `#64748B` light / `#CBD5E1` dark; ~1.4 leading, ≤60–70 char measure |
| **Body / card** | one shared ~10.5–11pt | Regular | ~1.4 leading; don't drift across 9/9.75/10.5/11.25 |
| **Kicker** | 7.5pt | Black/Bold | ALL-CAPS orange `#F97316` (already uniform — don't "fix") |
| **Micro** (footer, page #, pill) | one shared 9–10pt | Semibold | unify size + tracking deck-wide |

### 3.2 Kicker rules (signature — protect it)
- One kicker per slide, above the title, anchored to top/left guide. Short orange dash + ALL-CAPS orange label, 7.5pt `#F97316`.
- **ALL-CAPS reserved for the kicker tier ONLY** — never uppercase command-card/step sub-labels (that clones the kicker signature).
- Deck uses **no letter-tracking** today; light tracking may be tested but is NOT a locked existing rule.
### 3.3 Sub-labels
Command-card/step sub-labels (Visibility / Priorities / Readiness) = sentence-case, lighter orange `#F8B56B` ~8.25pt. Cohesion via size/leading, never caps.

## 4. Logo & Emblem
- **Lockup:** circular fiery phoenix (red→orange→gold) + `PHOENIX` (white, final **X** orange) over `WORKFORCE` (orange, tracked). **Always on black** — never on light/colored panels.
- **Standalone bird** = hero accent (title, dividers); sits clean/sharp on flat/gradient black (the fire supplies its own warmth). Do NOT add a manufactured radial halo behind the emblem (AI-hero cliché).
- App raster assets (source of truth): `public/brand/phoenix-bird-icon.png`, `phoenix-sidebar-lockup.png`, `phoenix-login-emblem.png`, `phoenix-rail-mark.png`.
- Never recolor/desaturate the emblem. No ghosted/watermarked emblem behind body content.

## 5. Signature Motifs (reuse verbatim; don't invent new ones)
1. **Top orange hairline** — very top edge, every slide. *Premium:* render as the app accent bar `from-orange-500/0 via-orange-400/80 to-orange-500/0`, top edge only, identical on every slide. **Never** under a title or inside a card.
2. **Orange kicker** — dash + ALL-CAPS label above each title (§3.2).
3. **Title + subtitle pair** — large sentence-case bold (navy on light / white on dark) + slate subtitle.
4. **Numbered item chip** — small **black square**, white bold number, beside a bold label, white row, `#E5EAF1` hairline divider. (Must hold 2 digits on one line — §7.)
5. **Highlight-one ("dominance over equality")** — in any set, EXACTLY one item orange (solid `#F97316` chip OR `#FFF7ED` bg + `#C2410C` text + orange border); rest neutral.
6. **Dark command card** — black/`#0F172A`: white title, sentence-case orange `#F8B56B` sub-labels, white body rows.
7. **Dark navy summary banner** — full-width `#0F172A`, white centered text, closes a message.
8. **Two-state tag pills** — neutral = white + slate + `#CBD5E1` border; highlighted = `#FFF7ED` + `#C2410C` + `#F97316` border. Standardize across all slides.
9. **Footer (every slide)** — `Phoenix Workforce | <deck name>` (tiny muted, left) + 2-digit orange page number (right).

## 6. Slide Archetypes (built only from §5 motifs)
- **A. Dark title** — dark gradient; lockup top-left; kicker → huge title → subtitle (left); right standalone bird emblem + caption; bottom domain-chip row (highlight-one); top hairline + footer.
- **B. Light command-card content (2-col split, ~5/1/6)** — left dark command card (3 labeled rows w/ proof-nouns); right white card w/ 2-col numbered grid; top hairline + footer.
- **C. Numbered coverage grid** — row of team/section column cards; each = black header bar (white centered name; *premium:* white count badge "HR · 12") + white numbered list w/ `#E5EAF1` hairlines; **content-weighted columns** (heaviest team double-width/2-col internal list; widen narrow columns to stop label wrap); equal header-bar height + shared baseline; closed by full-width dark-navy banner.
- **D. Step-flow closing** — dark header band (logo+kicker+title); row of 4 step cards linked by thin orange connector dashes, highlight-one applied; dark-navy banner + tag pills. No spanning orange labels across connectors.
- **E. Dark summary banner** — full-width `#0F172A`, white centered single line; the narrative full-stop.
- **F. Section divider (NEW, sanctioned)** — dark full-bleed `#0F172A`; small bird top-left; large orange section number ("01 / 04") + ALL-CAPS orange kicker + one white statement; same hairline + footer. Insert before dense grids for an executive beat.
- **G. Big-stat callout (NEW, sanctioned)** — light; 3-up/4-up large navy `#0F172A` numerals + tiny ALL-CAPS slate `#64748B` labels, `#E5EAF1` hairlines; highlight-one figure orange-washed; square cells. **Numbers must be derived from real deck content, never invented.**

## 7. Layout & Spacing
- **Master 12-column grid**, fixed outer margin ~0.55in, consistent gutter. Top-hairline inset, kicker, title, subtitle, first card ALL snap to one left guide (kill the per-slide origin drift).
- Document column spans per archetype (B = 5/1/6; D = four 3-col cards) for reproducibility.
- **Tokenized numbered chip** = component w/ fixed values: fixed min-width black rectangle holding 1–2 digits on one line (horizontal padding only, stays near-square), tabular/lining figures, no-wrap, fixed row height, `#E5EAF1` divider. Identical on every numbered slide.
- **Size panels to content, not the slide** — wrap content w/ even top/bottom padding; vertically center short blocks; promote floating pills into the nearest header row.
- **Vertical spacing scale: 8 / 16 / 24 / 40** — title stacks, card padding, inter-card gutters; same internal insets everywhere (the whitespace `tokens.css`).

## 8. Voice & Tone
- Corporate, governance-first, executive, confident, concise. Every line reads like a controlled operating standard, not marketing.
- Sentence-case titles; assertive but plain; nouns/outcomes over adjectives.
- **Evidence over assertion** — attach a proof-noun to claims ("Priorities · CEO worklist").
- Quantify scope where an exec anchors on a number. No hype words, no emoji, no exclamation. English only.

## 9. Premium Enhancement Playbook (prioritized; nothing adds a new color/font/shape — only depth + discipline)
**P0 — correctness/governance:** (1) De-dup Slide 2: replace duplicate "Users & Access" (item 8) with a distinct real Phase-One function (e.g. Role Permissions / Overrides — confirm it's genuinely distinct), then apply highlight-one. (2) Add proof-nouns to Slide-2 command card (Visibility·live dashboard / Priorities·CEO worklist / Readiness·governance log). (3) Fix Slide-1 focal conflict: unify all 6 domain chips neutral, make exactly one solid `#F97316`; drop the lone dark "Admin" chip.
**P1 — component hardening:** (4) Tokenize+harden numbered chip (fixed min-width, no-wrap, tabular figures so 10/11/12 fit on one line). (5) Rebalance Slide-3 coverage grid (content-weighted columns, equal header height, shared baseline, 2-col list for heaviest team, widened Marketing column single-line labels; optional white count badge per header). (6) Sharpen tag pills (stronger `#CBD5E1` neutral border; standardize).
**P2 — cohesion w/ live product (highest visual value):** (7) Port the app's exact dark-hero texture onto every dark surface: gradient `linear-gradient(135deg,#000000 0%,#070707 55%,#1C0E02 100%)` + 44×44px white grid @ ~16% opacity + ONE soft orange `#F97316`@~25% top-left + ONE amber `#F59E0B`@~15% bottom-right glow (subtle, executive — not gamer-RGB; 135° diagonal; never on light slides; keep glows low so card text stays legible). (8) Upgrade top hairline to accent-bar gradient `from-orange-500/0 via-orange-400/80 to-orange-500/0`, top edge only. (9) Single highlight-chip glow `shadow:0 0 24px rgba(249,115,22,0.25)` on the ONE orange chip on dark command cards only.
**P3 — pacing/quantification (native parts only):** (10) Insert a Section Divider (Archetype F) before the coverage grid. (11) Add a Big-Stat Callout (Archetype G) in the deck's number idiom; derive counts from real content (e.g. HR 12 + Finance 2 + Sales 4 + Performance 2 + Marketing 3 = 23 modules across 5 teams = 1 workspace); one orange-wash figure; no live-dot.
**P4 — invisible governance:** (12) Adopt the governed type scale (§3). (13) Adopt the 12-col grid + 8/16/24/40 spacing (§7).

### ❌ Explicitly REJECTED (look premium, break the brand) — do NOT do
- Colored hairline rules inside cards / `#FFF7ED` wash behind card headers (orange rules = top edge only).
- A gradient top hairline that differs by slide type (the flat/identical top rule is a load-bearing constant).
- A radial glow halo directly behind the emblem, or the grid overlay on the title slide as emblem decor (keep emblem clean on black).
- **A ghosted/desaturated phoenix watermark behind body content** (generic template cliché — the bird is a sharp hero accent, never a background wash).
- **A lucide/icon set per module/step** (canonical deck has ZERO icons; meaning = numbered chips + typography; icons add a net-new vocabulary + multiply orange surfaces).
- Spanning orange process-flow labels across Slide-4 connectors, or a second mid-slide kicker (second orange focal point / breaks one-kicker-per-slide).
- Off-palette slate `#475569` for subtitles (use `#64748B` light / `#CBD5E1` dark).
- ALL-CAPS on command-card/step sub-labels (caps reserved for kicker tier only).
- Accent lines UNDER titles, decorative full-width bars beyond top rule + dark banner, cream/beige backgrounds, clip-art.

## 9b. Build facts confirmed 2026-07-30 (employee-launch deck)
- **Aptos is NOT installed on this machine** (only Segoe UI etc. — checked via `InstalledFontCollection`).
  PPTX has no fallback chain, so specifying Aptos silently substitutes. Built with **Segoe UI**
  instead: universal on Windows, and it means the COM-rendered QA PNGs match what the room sees.
  Re-check before assuming Aptos; if Office is upgraded it may appear.
- **Defect (b) root cause + fix:** the numbered chip wraps "01" vertically because PowerPoint applies
  a default ~0.1in text inset, leaving ~0.08in usable inside a 0.28in box. Fix is `margin: 0` on the
  chip's text (plus `wrap: false`, box 0.30in). Encoded as a `chipBox()` helper.
- **The shipped `phoenix-sidebar-lockup.png` has an OPAQUE black plate** (palette PNG, no tRNS), so it
  reads as a floating black rectangle on the gradient hero. Compose the lockup instead from
  `phoenix-bird-icon.png` (which does have tRNS) + text: "PHOENI" white + "X" orange, over
  "WORKFORCE" orange with ~3.4pt tracking. `phoenix-login-emblem.png` also has alpha.
- **`sato-pharma-logo.png` is off-palette blue** and is a partial "PHARMA" crop — do not put it in a
  Phoenix deck.
- Dark hero: pptxgenjs cannot do gradient fills, so generate the surface as a PNG with Node `zlib`
  (manual PNG encoder) and use it as a full-bleed background image. Grid overlay above ~+10/255 on
  near-black reads as graph paper; +8 is right.
- Working build lives in the session scratchpad as `make-hero.js` + `build-deck.js`.

## 10. Known defects in the current deck (fix next time — don't invent others)
| # | Slide | Defect | Fix |
| --- | --- | --- | --- |
| a | 2 | "Users & Access" listed twice (items 4 & 8) | P0 #1: replace item 8 w/ a distinct real function; add highlight-one |
| b | 3 | Two-digit number chips (10/11/12) wrap vertically in the narrow square | P1 #4: fixed min-width + no-wrap + tabular figures |
| c | 3 | Marketing column labels wrap awkwardly (too-narrow column) | P1 #5: content-weighted columns, widen Marketing, single-line labels |

## 11. Build & QA notes
- **Build:** generate decks with **pptxgenjs** (Node) encoding the system as reusable helpers — `chip()`, `kickerBlock()`, `commandCard()`, `coverageColumn()`, `summaryBanner()`, `darkHeroSurface()` — hardcoding the verified hex + the §9 gradient/grid/glow recipe. OR edit the template `.pptx` directly (skill `anthropic-skills:pptx`; unzip = ZIP, `python` stdlib `zipfile` works without skill deps — `defusedxml`/`python-pptx` NOT installed). Ensure **Aptos** is installed/embedded (don't fall back to Calibri/Arial).
- **Render/QA on THIS Windows machine:** LibreOffice (`soffice`) and `pdftoppm` are NOT installed. Use **PowerPoint COM**:
  ```powershell
  $ppt = New-Object -ComObject PowerPoint.Application
  $pres = $ppt.Presentations.Open("F:\path\deck.pptx", $true, $false, $false)
  $pres.Export("F:\path\qa-out", "PNG", 1920, 1080)
  $pres.Close(); $ppt.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
  ```
  Then **Read** each exported PNG to verify against this spec.
- **QA checklist (after every build):** (1) top hairline at very top edge, never under title/inside card. (2) exactly one ALL-CAPS orange kicker above title. (3) footer `Phoenix Workforce | <deck>` + 2-digit orange page #. (4) 60/30/10 audit (orange ≤10%; fire-gradient only on emblem + dark glow). (5) highlight-one in every set (no two rival "special" treatments). (6) numbered chips hold 2 digits on one line, uniform, `#E5EAF1` dividers. (7) no off-palette colors (no `#475569`, no cream/beige; bg white or `#F8FAFC`). (8) no banned decoration (no under-title rules, no extra colored bars, no icons/watermark/clip-art). (9) dark surfaces use 135° gradient + 16% grid + subtle orange/amber glows (not flat black), text legible. (10) one title size everywhere; left-guide alignment; uniform insets + 8/16/24/40 spacing. (11) square geometry (rounding only on pills/chips). (12) defects a/b/c resolved.
