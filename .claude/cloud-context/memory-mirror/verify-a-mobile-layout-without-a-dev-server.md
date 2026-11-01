---
name: verify-a-mobile-layout-without-a-dev-server
description: "How to actually SEE a 375px layout when RAM is too low for Next dev and dev-auth can't reach the browser: serve a verbatim markup harness on a tiny static server and measure. Which instrument to use and which LIE — scrollWidth is blind to clipped content, and two boxes touching is NOT an overlap test (compare content to its own pane box, plus a true rect-intersection area). Also: min-height is a floor not a size, so shrink-0 is what stops a flex pane spilling over its sibling. Found real overflow and overlap bugs this way."
metadata: 
  node_type: memory
  type: project
  originSessionId: 391647f9-8f7a-4e5f-a51e-3371c51627f0
  modified: 2026-11-01T12:29:38.178Z
---

**The problem this solves.** Verifying a mobile layout here is blocked three ways at once: `pnpm run
dev` needs RAM this laptop often does not have ([[laptop-m17r2-ram-soldered-16gb-ceiling]]), the
Browser pane cannot send dev-auth headers so it cannot log into an admin page
([[dev-auth-is-header-only-browser-pane-cannot-use-it]]), and production/staging both redirect (307)
without a session. The tempting response is to skip looking and call a static test "verified" — which
is how a real defect shipped on 2026-08-21.

**The method that works, cheaply.**

1. Copy the component's markup **verbatim** from source into a plain `.html` file — the primitives
   (`PortalRecordCard`, `PortalRecordFields`, the `md:hidden` wrapper) are the layout, so copied
   markup + the same Tailwind classes is faithful. Pull `<script src="https://cdn.tailwindcss.com">`.
2. Use **real strings from production**, never invented ones. Query for the *longest* value:
   `select full_name, length(full_name) from employees where crm_id is not null order by 2 desc`.
   The 52-char rep name is what broke it; a made-up "Ahmed Samir" proves nothing.
3. Serve it over **HTTP** — a `file://` tab opens as a static snapshot with no JS, so Tailwind never
   applies and `resize_window` errors with *"No site is open in this tab"*. A ~15-line
   `node:http` static server (~40 MB) is enough. `preview_start` **cannot spawn** here at all — the
   `F:\` path with a space makes it reject every command; `.claude/launch.json` is attach-only and
   says so. So start the server yourself and call `preview_start` with `{url}`.
4. `resize_window` to `mobile`, then **measure, don't eyeball**:
   `document.documentElement.scrollWidth > clientWidth` is the definitive horizontal-overflow test.
   `computer{action:"screenshot"}` fails unless the pane is actually displayed on screen, so the
   numbers are usually the only evidence you can get — and they are better evidence anyway.
5. Check the desktop side too: `resize_window {preset:"desktop"}` **does not reliably resize** (it
   reported "native size" and left the viewport at 375). Pass explicit `{width:1280, height:800}`.
   To read a `md:` variant on an element inside a `md:hidden` list, remove the class in JS, measure,
   put it back.

**What it caught.** `PortalRecordCard`'s title was `whitespace-nowrap` with no clip and no ellipsis —
each right alone, together an overflow. At 375px the title needed 436px in a 267px slot and pushed
the page's `scrollWidth` to 455px, so the phone scrolled sideways: the exact defect the mobile-card
work removed. 37 of 108 CRM reps are long enough. Fixed in PR #2268 with `md:whitespace-nowrap`.

**Why it generalises.** Before blaming the shell, confirm nothing clips: `<main>` in
`app-shell.tsx` has `min-w-0` and **no** `overflow-hidden`, and neither `overflow: hidden` in
`app/globals.css` is page-level. So an overflowing child really does extend the page.

Related: [[crm-mobile-cards-are-module-wide-and-ci-enforced]] ·
[[portal-grid-items-need-min-w-0-for-nowrap-cards]] · [[blind-coordinate-clicks-fired-a-production-collection-run]]

**Always include a CONTROL case that MUST overflow (2026-08-21).** A harness that reports
"no overflow" is worthless on its own — it looks identical to a harness that is silently not
measuring (Tailwind never loaded, the font never resolved, the viewport never resized). Paste the
PRE-fix markup in as an extra case alongside the fixed one. On the 375px CRM audit the control
reproduced the old defect at **456px vs 375 (+81px)** while all three real cases sat at exactly 375
— so the zeros meant something. Same discipline as
[[prove-it-fails-verify-which-assertion-fired]], applied to a measurement instead of a test.

**THE CONTROL MUST OVERFLOW IN THE DIRECTION YOU ARE TESTING, or its silence is meaningless
(2026-09-05).** Widening an element inside a `justify-end` row does NOT push it right — it pushes it
**LEFT, off-screen**, and neither `scrollWidth` nor a `rect.right > viewport` check can see leftward
overflow in LTR. The control then reads exactly like a working page, and the natural next thought is
the wrong one: *the instrument is broken, or the shell clips everything.* Measured on the live
manager-engagement page: forcing the export button to `width:900px` gave `width = 900` with
`right = 363` — left of the viewport, detected by nothing. Anchor the probe at the LEFT instead
(`main.prepend(<div style="width:900px">)`), which must extend rightward.

**On the admin shell, the child-rect check is the ONLY instrument — `scrollWidth` is not merely
weak there, it is inert.** That same left-anchored probe reached `right: 912` on a 375px viewport
and `document.scrollWidth` **stayed 375**, because `.admin-shell { overflow-x: clip }` cuts rather
than scrolls. So the golden rule's own prescribed check (`scrollWidth > clientWidth`) returns a clean
375/375 on a page with 537px hanging off the side. The child-rect sweep went 0 → 1 → 0 across
probe-insert and probe-remove, which is what made the surrounding zeros trustworthy.

Confirm the harness is live before trusting a number: `document.fonts.status === "loaded"`,
`getComputedStyle(el).fontFamily` actually naming the app face (**DM Sans** here, via
`--font-dm-sans` in `app/globals.css`), and `typeof window.tailwind !== "undefined"`. Reading
`whiteSpace` on an `md:`-gated element doubles as proof the breakpoint is being applied —
`normal` at 375px, `nowrap` at 1280px.

**Measure the right edge, not just the page.** `getBoundingClientRect().right > 375` localises
*which* element sticks out; page `scrollWidth` only says that something does.

**Give the harness the REAL content width, or its margins are fiction.** `app-shell.tsx:104` is
`<main class="min-w-0 flex-1 px-3 py-4 sm:px-4 …">`, so a 375px phone has **351px** of content,
not 375 — and `sm:` (640px) never applies there. A first pass that wrapped each case in a bare
`w-[375px]` box reported 31px of headroom on the chains-panel name span; rebuilt on the real chain
it was **18px**. Copy the wrapper chain, and check each container for `overflow-hidden` —
`PortalSection` has it (so it clips), but the chains list
(`<div class="border border-slate-200 bg-white">`) and `doctor-coverage-board`'s local `Section`
do NOT, which is why an overflow there reaches the page.

**Find the breaking point instead of guessing the margin.** Grow the real string a character at a
time in the DOM until `documentElement.scrollWidth > clientWidth`, then restore it. That validates
the harness and quantifies the risk in one pass. Result 2026-08-21: `crm-recovered-chains-panel.tsx:25`
(`whitespace-nowrap` on `chain.hingeManagerName`) breaks the page at **55 characters** — 375 to
376px — and the longest `employees.full_name` company-wide is **52**. Three characters of margin.
Its parent is already `flex flex-wrap`, so dropping the `whitespace-nowrap` would let it wrap,
the same shape as the #2268 title fix.

**Put the SIDEBAR in the shell chain, or the worst width reads clean (2026-09-03).** `Sidebar` in
`app-shell.tsx` is `hidden ... lg:flex` at `w-[292px]`, expanded by default (`useSidebarRail`
defaults false). So content width does NOT grow monotonically with the viewport: **1024px is
NARROWER than 768px** — 667px against 719px — because that is exactly where the 292px rail appears
and `main` goes from `sm:px-4` to `lg:px-6`. A harness built without it reported the direct-order
registry board as *fine at 1280px*; with the sidebar the same board scrolled **486px** there, and
**726px at 1024px**, its true worst case. Measure 768 / 1024 / 1280 / 1920, never just two.

**Measure the WRAPPER, not the page, and add a per-cell CLIP check.** `.admin-shell :has(> table)`
(app/globals.css:1221, unlayered) gives `overflow-x: auto` to any element directly holding a table,
so the scroll is contained and `scrollWidth > clientWidth` on `main` reads clean at every width
while the board scrolls. And under `table-fixed`, a cell that cannot wrap does not widen the
table — `.admin-shell { overflow-x: clip }` CUTS it, adding nothing to any scrollWidth. Check
`td.scrollWidth > td.clientWidth` per cell, and give THAT check its own positive control (narrow
one `<col>` to 3%); a wrapper-level control cannot validate it, because both read zero.

🔴 **TWO BOXES TOUCHING IS NOT AN OVERLAP TEST — compare CONTENT against its OWN pane's box, never
box against box (2026-09-12).** On the CV preview modal at 375px I queried the two flex children and
got `documentPane.bottom === sidePanel.top === 668.25` — exactly adjacent, no gap, no intersection —
and wrote off the reported overlap as an artefact. **That was wrong.** The panes were adjacent while
the document's *inner content* stood **527.3px** inside a pane box of **487.19px**, so 40px of CV
painted straight over the "On record" panel. Adjacent boxes are what a correct layout AND a
content-spilling one both look like. The instrument is `paneContent.bottom - paneBox.bottom > 0`,
plus a true rect **intersection area** (`max(0, min(rights)-max(lefts)) * max(0, min(bottoms)-max(tops))`),
which is the only form that stays meaningful in BOTH layouts — a vertical `pane.bottom - side.top`
check is pure nonsense once `lg:flex-row` puts the panes side by side, and it happily returned
`506.09` on a layout with zero overlap. Same family as the golden rule's own warning that
`scrollWidth` is **blind to content CLIPPED rather than scrolled**: every one of these instruments
measures the container and misses what the container is hiding.

**The CSS behind it, because the obvious fix is only half of one.** A flex item's automatic minimum
size is its content size *unless* the item carries a non-`visible` `overflow`, in which case it
resolves to **0** — that is why `flex-1` + `overflow-auto` collapsed the pane to `clientHeight: 0`.
But **`min-height` is a FLOOR, not a size**: adding `min-h-[60vh]` left the pane a shrinkable flex
item, so it still shrank from its content-based basis down to the floor and spilled the remainder.
**`shrink-0` is what actually stops the shrink**, and on a stacked mobile column both panes need it.
Measured across three harness cases at 375x812 — pre-fix `0px` box / 179,808 px² overlap, floor-only
`487.19px` / 13,677 px², shipped `527.3px` / **0** — PR #3730.

**Breakpoints key on the VIEWPORT, not the container.** A harness frame hardcoded to `width: 375px`
inside a 1280px viewport still fires every `lg:` variant, so the desktop reading was fiction until
the frames became `width: 100vw; height: 100vh`. `_tailwindLoaded` alone does not catch this.

Replicate in the harness: the three `.admin-shell` rules above, `thead th { font-size: 0.78rem }`,
the `th/td` hairline border, and the `text-phx-*` ladder as Tailwind `fontSize` keys
(xs 11px, sm 12px - `src/styles/tokens.css`). Confirm `getComputedStyle(td).fontFamily` resolves to
**Aptos** and the header reads **12.48px** before trusting a number.

**Better than a harness: measure the REAL emitted page, if a dev server rendered it once (2026-09-16).**
The My List check had a dev server that got one page out before RAM fell to 548 MB and it had to be
killed. What survives the kill is enough: the saved HTML (a dev-auth-header curl) plus the compiled
stylesheet, which stays on disk at `<worktree>/.next/dev/static/css/app/layout.css`. Serve both from a
~30-line `node:http` server (map `/_next/static/*` to `.next/dev/static/*`; `path.resolve` the root, or
Windows' back-slashes fail a `startsWith` guard and every asset 404s). Strip every `src=` script and
the `__next_f` / `__next_r` inline ones, but **KEEP React's own inline `$RS` / `$RC` scripts**. Strip
those and the page stays on its loading skeleton forever. Then run `$RV($RB)` once, as described in
[[headless-browser-never-fires-raf-react-suspense-reveal]]. With `resize_window` set to an EXPLICIT size, widths read true
and screenshots worked even though `tabs_context` said the pane was hidden. This measures the real
markup, real classes and real production strings. Nothing is copied by hand. Scripts: session
af67af9f scratchpad `static-snapshot-server.cjs`.

🔴 **BEST WHEN NO DEV SERVER FITS: BUNDLE THE REAL CLIENT COMPONENT, AND IT TESTS BEHAVIOUR TOO (2026-11-01).** A Next dev
compile cost ~3 GB even for one tiny page; this cost well under 1 GB and never neared the line. Webpack from
`next/dist/compiled/webpack/webpack` (`.webpack`, no `init()`; `resolve.modules` must keep `"node_modules"` for pnpm), a small
loader over `next/dist/build/swc` (`loadBindings`, `transform`), `app/globals.css` through `.pnpm/postcss@8.5.31` and
`@tailwindcss/postcss`, and a `window.fetch` fake answering `{ <key>: …, success: true }`. Clicks drive the real state, so it
caught what a markup copy cannot and 18 fired source assertions had not: the plan board's save loop called `draftProblem`
without `customersOptional`, so a rep-alone half-day read "Saving soon…" and sent nothing, live (PR 6747). Count the POSTs. Control
the CSS with a probe `rounded-full`, or "0 round corners" may only mean no stylesheet. The pane's `visibilityState` can read
`hidden` while timers still run, and screenshots time out. Scripts: session f6823e9d scratchpad `look/`.

🔴 **AN ARABIC TOKEN IS NOT A CONTROL FOR AN UNBREAKABLE WORD — it wraps anyway, and the false clean
looks exactly like a passing screen (2026-09-28).** Probing the Phoenix CRM Today table for the one
failure `break-words` exists to stop, the obvious control was 60 repeated Arabic letters, since every
long real customer name here is Arabic. It reported **zero overflow with `overflow-wrap: normal`
forced on** — the script offers break opportunities between letters, so the "unbreakable" token broke
at every character. **Use a Latin token** (`"Mohammed".repeat(8)`, 64 chars): with `break-words`
removed it rendered **638px of ink inside a 207px cell**, 420px hanging past it and
`td.scrollWidth - clientWidth = 419`, while `document.documentElement.scrollWidth` stayed at
**exactly 1024** — the golden rule's own prescribed page check reading perfectly clean on a cell with
420px off the side, because `.admin-shell { overflow-x: clip }` cuts rather than scrolls. With the
class on, the same token measured 202px in 207px.

**And the pane clears an emulated size mid-run, silently.** Halfway through that probe the tool
reported the pane's width had changed, so the app dropped the `1024x800` emulation; the next five
readings were taken at 659px and every one of them read clean. The tell was `pageScrollWidth: 659`
against an expected 1024. **Re-assert `innerWidth` inside every batch** and set the size in the SAME
batch as the measurement — a size set in an earlier call is not a size you still have. The 2026-09-16
note above still holds: with an EXPLICIT size the numbers read true even while `visibility` is
`hidden`, which is what makes this method work with the pane collapsed — but `innerWidth: 0` and
`main.clientWidth: 24` is what a hidden pane with NO emulated size reports, and those zeros are the
lie, not the measurement.
