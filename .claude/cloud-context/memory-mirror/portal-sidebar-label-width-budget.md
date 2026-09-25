---
name: portal-sidebar-label-width-budget
description: "Sidebar label widths are MEASURED per shell in headless Chromium and enforced by a test — the admin rail and the employee portal have DIFFERENT budgets and different type, and one number can never serve both."
metadata:
  node_type: memory
  type: project
  originSessionId: c094902f-a921-4063-8b86-173c40fde1f7
  modified: 2026-08-23T21:00:33.000Z
---

**Do not estimate a sidebar label's width — measure it, and measure it in the right shell.**
`tests/sidebar-label-width.test.ts` runs in the suite and fails two ways: a label with **no measured
entry for its shell**, and a measured label **over its shell's budget**. It covers both shells across
every role in `permissionMatrix`, charging each label the worst context it reaches.

**There are TWO rails and they share nothing.** `labelBudgetPx` in
[src/config/sidebar-metrics.ts](src/config/sidebar-metrics.ts) **requires** a `shell` argument — that
is deliberate, see Why below.

| shell | aside | plain | hub (↗) | badge |
| --- | --- | --- | --- | --- |
| admin | `w-[292px]` | **157px** | **137px** | **125px** (hub+badge drops the ↗ → also 125) |
| portal | `w-[324px]` | **159px** | n/a | **121px** |

Portal rows carry badges (the same `NavBadge`, imported from `sidebar.tsx`, costing 38px there vs 32
in admin because it sits in the row's `gap-3` not a `gap-1.5` wrapper) but have **no hub arrow and no
pin star**, so `hub` costs a portal label nothing.

**Type differs too: admin is 13px/600/-0.01em, portal is 12px/700.** A label in both shells is
genuinely two widths. The snapshot `tests/fixtures/sidebar-label-widths.json` is therefore
**`{admin: {...}, portal: {...}}`** — 52 + 70 entries, not one flat map. Regenerate with
**`pnpm run ui:measure-sidebar-labels`**; it is byte-deterministic, and it PRUNES labels no role
yields any more, so its diff can touch rows you never edited. **Only typography changes require a
re-measure** — moving a rail's width does not.

**Neither nav width is a magic constant any more; both DERIVE from their aside.** The portal chain is
`aside → card w-full less 1px borders → icon rail w-[58px] → label column flex-1 less px-4 → nav
flex-1 less the 10px scrollbar-gutter track`. It reproduces the browser exactly at the pre-widening
312px rail (220 offset / 210 client, both measured), and `PORTAL_GEOMETRY_CHECKPOINT` pins that
reading so an edit to the chain constants cannot drift away from it — proven live: breaking
`PORTAL_ICON_RAIL` *and* updating the budget pins to match still fails, `212 !== 210`.

⚠️ **The portal label span has no `truncate`, no `min-w-0` and no `whitespace-nowrap`, so an
over-long label WRAPS TO TWO LINES** — measured in a browser 2026-08-24: `white-space: normal`, row
height 38px → 56px. It does NOT ellipsise and it does NOT push the badge out (an earlier line here
claimed the latter — wrong). Wrapping is itself an owner-rule violation, so the risk stands; only the
mechanism differs, and you will not find it by hunting for horizontal overflow. Tightest today:
portal `Doctor Coverage Settings` 146.67px with **12.33px** headroom — which sounds roomier than it
is: that is **one lowercase `n` (7.16px)** or three `i`. It had **0px** before the rail went to 324
(one added character wrapped it). Admin `People Management` 6px, `Territory Management` 7px.

`src/components/layout/app-shell-loading.tsx` is **mode-aware** — 292 admin, 324 portal. If you move
either rail, move the skeleton too or the shell jumps when the real sidebar mounts.

**Why:** the owner forbids BOTH wrapping and ellipsis truncation. Three silent failures happened
here. (1) The model read its numbers off the Tailwind classes and never charged the aside's 1px
border or the **10px `scrollbar-gutter: stable`** track — every budget was 11px too generous and the
test certified labels that were visibly clipping (#2353, rail 280 → **292**). (2) The test charged
**portal** rows the **admin** budget, so widening the admin rail silently RAISED the allowance for
labels in a component the model had never seen (#2355). (3) #2355's own fix froze one measurement
into source as `PORTAL_NAV_CLIENT_WIDTH = 210`, relocating the same brittleness (#2358, rail
312 → **324**, replaced by the derivation above). Earlier notes giving 156/136/124, 147/109, or a
~6.2px/char model are all superseded.

**How to apply:** add or rename the label, run the measure script, commit the fixture with the
change. Never hand-edit the snapshot, and never let one budget stand in for both shells — a pinned
assertion fails if the two ever converge. See
[[renaming-a-nav-label-changes-its-persisted-moduleid]] before renaming an existing label, and
[[dev-auth-is-header-only-browser-pane-cannot-use-it]] for why a model is not a higher authority than
the browser.

**Verified against a real layout engine 2026-08-24** (dev server impossible — commit charge was at
96%; used the verbatim-markup harness from
[[verify-a-mobile-layout-without-a-dev-server]]). Chromium reproduced the chain exactly: aside 324 →
nav `clientWidth` **222**, gutter **10**, and 312 → **210**, matching `PORTAL_GEOMETRY_CHECKPOINT`.
The 159 budget is confirmed to sub-pixel accuracy — `n` is 7.16px, so 146.67 + 1 fits at 153.83 and
+2 would be 161 > 159. `--font-dm-sans` is referenced in `globals.css` but **never defined anywhere**
(0 definitions, no `next/font`), so the cascade really does land on **Aptos** — `getComputedStyle`
confirmed `Aptos` at 12px/700, i.e. the model measures the face the app actually renders. The rail is
`lg:`-gated and `display:none` at a true 375px viewport, so none of this reaches mobile.
